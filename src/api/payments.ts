/**
 * TRN-3: Paystack Payment Integration
 * Invariants: Nigeria-First (Paystack), Offline-First (dev-mode auto-confirm), NDPR
 *
 * Routes (mounted at /api/payments — before requireTenantMiddleware):
 *   POST /api/payments/initiate — create Paystack transaction, return authorization_url
 *   POST /api/payments/verify  — verify Paystack payment + confirm booking
 *
 * Dev mode (PAYSTACK_SECRET unset):
 *   initiate returns { dev_mode: true } with no authorization_url
 *   verify auto-confirms the booking without calling Paystack
 *
 * Webhook (mounted at /webhooks/paystack in worker.ts):
 *   POST /webhooks/paystack — HMAC-SHA512 verified; handles charge.success
 */
import { Hono } from 'hono';
import type { AppContext } from './types';
import { requireFields } from './types';

export const paymentsRouter = new Hono<AppContext>();

// ============================================================
// Helpers
// ============================================================

/** HMAC-SHA512 of message using secret; returns lowercase hex. */
export async function hmacSha512(message: string, secret: string): Promise<string> {
  const enc = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-512' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(message));
  return [...new Uint8Array(sig)].map(b => b.toString(16).padStart(2, '0')).join('');
}

type DbBookingPayment = {
  id: string;
  status: string;
  total_amount: number;
  seat_ids: string;
  payment_reference: string;
  payment_provider: string | null;
};

/** Confirm a booking + seats atomically via db.batch(). Called after payment verified. */
async function confirmBookingById(
  db: D1Database,
  booking: DbBookingPayment,
  reference: string,
  provider: string,
  now: number
): Promise<void> {
  const seatIds = JSON.parse(booking.seat_ids) as string[];
  await db.batch([
    db.prepare(
      `UPDATE bookings
       SET status = ?,
           payment_status = ?,
           payment_reference = ?,
           payment_provider = ?,
           paid_at = ?,
           confirmed_at = ?
       WHERE id = ?`
    ).bind('confirmed', 'completed', reference, provider, now, now, booking.id),
    ...seatIds.map(seatId =>
      db.prepare(
        `UPDATE seats SET status = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`
      ).bind('confirmed', now, now, seatId)
    ),
  ]);
}

// ============================================================
// POST /api/payments/initiate
// Creates a Paystack transaction; returns authorization_url.
// In dev mode (no PAYSTACK_SECRET), returns { dev_mode: true }.
// ============================================================
paymentsRouter.post('/initiate', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json() as Record<string, unknown>; }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const { booking_id, email } = body as { booking_id?: string; email?: string };
  const err = requireFields({ booking_id }, ['booking_id']);
  if (err) return c.json({ success: false, error: err }, 400);

  const db = c.env.DB;

  const booking = await db.prepare(
    `SELECT id, status, total_amount, seat_ids, payment_reference, payment_provider
     FROM bookings WHERE id = ? AND deleted_at IS NULL`
  ).bind(booking_id).first<DbBookingPayment>();

  if (!booking) return c.json({ success: false, error: 'Booking not found' }, 404);
  if (booking.status === 'confirmed') return c.json({ success: false, error: 'Booking already confirmed' }, 409);
  if (booking.status === 'cancelled') return c.json({ success: false, error: 'Booking is cancelled' }, 409);

  // ── Dev mode ──────────────────────────────────────────────
  if (!c.env.PAYSTACK_SECRET) {
    return c.json({
      success: true,
      data: {
        dev_mode: true,
        reference: booking.id,
        authorization_url: null,
        access_code: null,
        message: 'Dev mode — PAYSTACK_SECRET not set. Call /verify to auto-confirm.',
      },
    });
  }

  // ── Prod mode: initialise Paystack transaction ─────────────
  const reference = `waka_${booking.id}_${Date.now()}`;
  const customerEmail = (email && email.includes('@')) ? email : `${booking.id}@pay.webwaka.ng`;

  let paystackRes: Response;
  try {
    paystackRes = await fetch('https://api.paystack.co/transaction/initialize', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.PAYSTACK_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        email: customerEmail,
        amount: booking.total_amount,
        reference,
        metadata: { booking_id: booking.id, source: 'webwaka-transport' },
        channels: ['card', 'bank', 'ussd', 'bank_transfer', 'mobile_money'],
      }),
    });
  } catch (err: unknown) {
    console.error('[payments/initiate] fetch error:', err);
    return c.json({ success: false, error: 'Payment gateway unreachable' }, 502);
  }

  if (!paystackRes.ok) {
    const detail = await paystackRes.text();
    console.error('[payments/initiate] Paystack error:', detail);
    return c.json({ success: false, error: 'Payment gateway unavailable' }, 502);
  }

  const psData = await paystackRes.json() as {
    status: boolean;
    message?: string;
    data: { authorization_url: string; access_code: string; reference: string };
  };

  if (!psData.status || !psData.data?.authorization_url) {
    return c.json({ success: false, error: psData.message ?? 'Failed to initialize payment' }, 502);
  }

  await db.prepare(
    `UPDATE bookings SET payment_reference = ?, payment_provider = 'paystack', updated_at = ? WHERE id = ?`
  ).bind(psData.data.reference, Date.now(), booking.id).run();

  return c.json({
    success: true,
    data: {
      dev_mode: false,
      reference: psData.data.reference,
      authorization_url: psData.data.authorization_url,
      access_code: psData.data.access_code,
    },
  });
});

// ============================================================
// POST /api/payments/verify
// Verifies a Paystack payment and confirms the booking.
// In dev mode (no PAYSTACK_SECRET), auto-confirms without calling Paystack.
// ============================================================
paymentsRouter.post('/verify', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json() as Record<string, unknown>; }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const { reference, booking_id } = body as { reference?: string; booking_id?: string };

  if (!reference && !booking_id) {
    return c.json({ success: false, error: 'reference or booking_id is required' }, 400);
  }

  const db = c.env.DB;

  // Look up by booking_id first; fall back to payment_reference lookup
  let booking: DbBookingPayment | null = null;
  if (booking_id) {
    booking = await db.prepare(
      `SELECT id, status, total_amount, seat_ids, payment_reference, payment_provider
       FROM bookings WHERE id = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(booking_id).first<DbBookingPayment>();
  }
  if (!booking && reference) {
    booking = await db.prepare(
      `SELECT id, status, total_amount, seat_ids, payment_reference, payment_provider
       FROM bookings WHERE payment_reference = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(reference).first<DbBookingPayment>();
  }

  if (!booking) return c.json({ success: false, error: 'Booking not found' }, 404);
  if (booking.status === 'cancelled') {
    return c.json({ success: false, error: 'Booking is cancelled' }, 409);
  }
  if (booking.status === 'confirmed') {
    return c.json({
      success: true,
      data: { status: 'already_confirmed', booking_id: booking.id, booking_status: 'confirmed' },
    });
  }

  const now = Date.now();
  const ref = reference ?? booking.payment_reference ?? booking.id;

  // ── Dev mode ──────────────────────────────────────────────
  if (!c.env.PAYSTACK_SECRET) {
    await confirmBookingById(db, booking, ref, 'dev', now);
    return c.json({
      success: true,
      data: { status: 'dev_confirmed', booking_id: booking.id, booking_status: 'confirmed' },
    });
  }

  // ── Prod mode: verify with Paystack ───────────────────────
  let verifyRes: Response;
  try {
    verifyRes = await fetch(
      `https://api.paystack.co/transaction/verify/${encodeURIComponent(ref)}`,
      { headers: { Authorization: `Bearer ${c.env.PAYSTACK_SECRET}` } }
    );
  } catch (err: unknown) {
    console.error('[payments/verify] fetch error:', err);
    return c.json({ success: false, error: 'Payment gateway unreachable' }, 502);
  }

  if (!verifyRes.ok) {
    return c.json({ success: false, error: 'Payment verification failed' }, 502);
  }

  const verifyData = await verifyRes.json() as {
    status: boolean;
    data: { status: string; amount: number; reference: string };
  };

  if (!verifyData.status || verifyData.data.status !== 'success') {
    return c.json({
      success: false,
      error: 'Payment not yet complete',
      data: { paystack_status: verifyData.data?.status ?? 'unknown' },
    }, 402);
  }

  if (verifyData.data.amount !== booking.total_amount) {
    console.error(
      `[payments/verify] FRAUD: Amount mismatch for booking ${booking.id}: ` +
      `expected ${booking.total_amount} kobo, got ${verifyData.data.amount} kobo`
    );
    try {
      const evtId = `evt_fraud_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.prepare(
        `INSERT OR IGNORE INTO platform_events
         (id, event_type, aggregate_id, aggregate_type, payload, status, created_at)
         VALUES (?, 'payment:AMOUNT_MISMATCH', ?, 'booking', ?, 'pending', ?)`
      ).bind(
        evtId, booking.id,
        JSON.stringify({
          booking_id: booking.id,
          expected_kobo: booking.total_amount,
          received_kobo: verifyData.data.amount,
          reference: verifyData.data.reference,
        }),
        now
      ).run();
    } catch { /* non-fatal — fraud event failure must not swallow the 402 */ }
    return c.json({
      success: false,
      error: 'Payment amount does not match booking total',
      data: {
        expected_kobo: booking.total_amount,
        received_kobo: verifyData.data.amount,
      },
    }, 402);
  }

  await confirmBookingById(db, booking, verifyData.data.reference, 'paystack', now);

  return c.json({
    success: true,
    data: { status: 'confirmed', booking_id: booking.id, booking_status: 'confirmed' },
  });
});
