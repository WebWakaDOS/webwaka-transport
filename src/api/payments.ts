/**
 * TRN-3 / T-TRN-04: Paystack + Flutterwave Payment Integration
 * Invariants: Nigeria-First (Paystack Inline), Offline-First (dev-mode auto-confirm), NDPR,
 *             Event-Driven (payment.successful → trns_platform_events outbox)
 *
 * Routes (mounted at /api/payments — before requireTenantMiddleware):
 *   POST /api/payments/initiate              — create Paystack transaction; returns access_code for Inline popup
 *   POST /api/payments/verify               — verify Paystack payment + confirm booking + emit payment.successful
 *   POST /api/payments/flutterwave/initiate — create Flutterwave checkout link
 *   POST /api/payments/flutterwave/verify   — verify Flutterwave + confirm booking + emit payment.successful
 *
 * Dev mode (PAYSTACK_SECRET / FLUTTERWAVE_SECRET unset):
 *   initiate returns { dev_mode: true }; verify auto-confirms without calling gateway
 *
 * Webhooks (mounted at /webhooks — before jwtAuthMiddleware in worker.ts):
 *   POST /webhooks/paystack    — HMAC-SHA512 verified; handles charge.success → confirm + emit
 *   POST /webhooks/flutterwave — verif-hash verified; handles charge.completed → confirm + emit
 */
import { Hono } from 'hono';
import type { AppContext } from './types';
import { requireFields } from './types';
import { publishEvent } from '@webwaka/core';

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

/** Confirm a booking + trns_seats atomically via db.batch(). Called after payment verified.
 *  Emits payment.successful to the platform event bus (non-fatal on failure). */
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
      `UPDATE trns_bookings
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
        `UPDATE trns_seats SET status = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`
      ).bind('confirmed', now, now, seatId)
    ),
  ]);

  try {
    await publishEvent(db, {
      event_type: 'payment.successful',
      aggregate_id: booking.id,
      aggregate_type: 'booking',
      payload: {
        booking_id: booking.id,
        reference,
        provider,
        amount_kobo: booking.total_amount,
      },
      timestamp: now,
    });
  } catch {
    /* non-fatal — event emission must never interrupt payment confirmation */
  }
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
     FROM trns_bookings WHERE id = ? AND deleted_at IS NULL`
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
    `UPDATE trns_bookings SET payment_reference = ?, payment_provider = 'paystack', updated_at = ? WHERE id = ?`
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
       FROM trns_bookings WHERE id = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(booking_id).first<DbBookingPayment>();
  }
  if (!booking && reference) {
    booking = await db.prepare(
      `SELECT id, status, total_amount, seat_ids, payment_reference, payment_provider
       FROM trns_bookings WHERE payment_reference = ? AND deleted_at IS NULL LIMIT 1`
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
        `INSERT OR IGNORE INTO trns_platform_events
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

// ============================================================
// POST /api/payments/flutterwave/initiate
// Creates a Flutterwave Standard checkout link.
// In dev mode (no FLUTTERWAVE_SECRET), returns { dev_mode: true }.
// Note: Flutterwave amounts are in Naira (not kobo); convert on initiate/verify.
// ============================================================
paymentsRouter.post('/flutterwave/initiate', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json() as Record<string, unknown>; }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const { booking_id, email } = body as { booking_id?: string; email?: string };
  const err = requireFields({ booking_id }, ['booking_id']);
  if (err) return c.json({ success: false, error: err }, 400);

  const db = c.env.DB;
  const booking = await db.prepare(
    `SELECT id, status, total_amount, seat_ids, payment_reference, payment_provider
     FROM trns_bookings WHERE id = ? AND deleted_at IS NULL`
  ).bind(booking_id).first<DbBookingPayment>();

  if (!booking) return c.json({ success: false, error: 'Booking not found' }, 404);
  if (booking.status === 'confirmed') return c.json({ success: false, error: 'Booking already confirmed' }, 409);
  if (booking.status === 'cancelled') return c.json({ success: false, error: 'Booking is cancelled' }, 409);

  // ── Dev mode ──────────────────────────────────────────────
  if (!c.env.FLUTTERWAVE_SECRET) {
    return c.json({
      success: true,
      data: {
        dev_mode: true,
        tx_ref: booking.id,
        payment_link: null,
        message: 'Dev mode — FLUTTERWAVE_SECRET not set. Call /flutterwave/verify to auto-confirm.',
      },
    });
  }

  // ── Prod mode: initialise Flutterwave transaction ──────────
  const tx_ref = `waka_fw_${booking.id}_${Date.now()}`;
  const customerEmail = (email && email.includes('@')) ? email : `${booking.id}@pay.webwaka.ng`;
  const amountNaira = Math.ceil(booking.total_amount / 100); // FW uses Naira, not kobo

  let fwRes: Response;
  try {
    fwRes = await fetch('https://api.flutterwave.com/v3/payments', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${c.env.FLUTTERWAVE_SECRET}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        tx_ref,
        amount: amountNaira,
        currency: 'NGN',
        redirect_url: 'https://webwaka.ng/payment/callback',
        customer: { email: customerEmail },
        customizations: { title: 'WebWaka Transport', logo: 'https://webwaka.ng/icon.svg' },
        meta: { booking_id: booking.id, source: 'webwaka-transport' },
      }),
    });
  } catch (err: unknown) {
    console.error('[payments/flutterwave/initiate] fetch error:', err);
    return c.json({ success: false, error: 'Payment gateway unreachable' }, 502);
  }

  if (!fwRes.ok) {
    const detail = await fwRes.text();
    console.error('[payments/flutterwave/initiate] Flutterwave error:', detail);
    return c.json({ success: false, error: 'Payment gateway unavailable' }, 502);
  }

  const fwData = await fwRes.json() as {
    status: string;
    message?: string;
    data: { link: string };
  };

  if (fwData.status !== 'success' || !fwData.data?.link) {
    return c.json({ success: false, error: fwData.message ?? 'Failed to initialize payment' }, 502);
  }

  await db.prepare(
    `UPDATE trns_bookings SET payment_reference = ?, payment_provider = 'flutterwave', updated_at = ? WHERE id = ?`
  ).bind(tx_ref, Date.now(), booking.id).run();

  return c.json({
    success: true,
    data: { dev_mode: false, tx_ref, payment_link: fwData.data.link },
  });
});

// ============================================================
// POST /api/payments/flutterwave/verify
// Verifies a Flutterwave payment and confirms the booking.
// In dev mode (no FLUTTERWAVE_SECRET), auto-confirms.
// ============================================================
paymentsRouter.post('/flutterwave/verify', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json() as Record<string, unknown>; }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const { tx_ref, booking_id } = body as { tx_ref?: string; booking_id?: string };
  if (!tx_ref && !booking_id) {
    return c.json({ success: false, error: 'tx_ref or booking_id is required' }, 400);
  }

  const db = c.env.DB;
  let booking: DbBookingPayment | null = null;

  if (booking_id) {
    booking = await db.prepare(
      `SELECT id, status, total_amount, seat_ids, payment_reference, payment_provider
       FROM trns_bookings WHERE id = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(booking_id).first<DbBookingPayment>();
  }
  if (!booking && tx_ref) {
    booking = await db.prepare(
      `SELECT id, status, total_amount, seat_ids, payment_reference, payment_provider
       FROM trns_bookings WHERE payment_reference = ? AND deleted_at IS NULL LIMIT 1`
    ).bind(tx_ref).first<DbBookingPayment>();
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
  const ref = tx_ref ?? booking.payment_reference ?? booking.id;

  // ── Dev mode ──────────────────────────────────────────────
  if (!c.env.FLUTTERWAVE_SECRET) {
    await confirmBookingById(db, booking, ref, 'flutterwave_dev', now);
    return c.json({
      success: true,
      data: { status: 'dev_confirmed', booking_id: booking.id, booking_status: 'confirmed' },
    });
  }

  // ── Prod mode: verify with Flutterwave ────────────────────
  let fwRes: Response;
  try {
    fwRes = await fetch(
      `https://api.flutterwave.com/v3/transactions?tx_ref=${encodeURIComponent(ref)}`,
      { headers: { Authorization: `Bearer ${c.env.FLUTTERWAVE_SECRET}` } }
    );
  } catch (err: unknown) {
    console.error('[payments/flutterwave/verify] fetch error:', err);
    return c.json({ success: false, error: 'Payment gateway unreachable' }, 502);
  }

  if (!fwRes.ok) {
    return c.json({ success: false, error: 'Payment verification failed' }, 502);
  }

  const fwData = await fwRes.json() as {
    status: string;
    data: Array<{ status: string; amount: number; currency: string; tx_ref: string }>;
  };

  if (fwData.status !== 'success' || !fwData.data?.length) {
    return c.json({ success: false, error: 'Payment not found in gateway' }, 404);
  }

  const tx = fwData.data[0];
  if (!tx) {
    return c.json({ success: false, error: 'Payment not found in gateway' }, 404);
  }
  if (tx.status !== 'successful') {
    return c.json({
      success: false,
      error: 'Payment not yet complete',
      data: { flutterwave_status: tx.status },
    }, 402);
  }

  // FW returns Naira; convert to kobo for fraud check
  const receivedKobo = Math.round(tx.amount * 100);
  if (receivedKobo !== booking.total_amount) {
    console.error(
      `[payments/flutterwave/verify] FRAUD: Amount mismatch for booking ${booking.id}: ` +
      `expected ${booking.total_amount} kobo, got ${receivedKobo} kobo`
    );
    try {
      const evtId = `evt_fw_fraud_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.prepare(
        `INSERT OR IGNORE INTO trns_platform_events
         (id, event_type, aggregate_id, aggregate_type, payload, status, created_at)
         VALUES (?, 'payment:AMOUNT_MISMATCH', ?, 'booking', ?, 'pending', ?)`
      ).bind(
        evtId, booking.id,
        JSON.stringify({
          booking_id: booking.id,
          expected_kobo: booking.total_amount,
          received_kobo: receivedKobo,
          tx_ref: ref,
          provider: 'flutterwave',
        }),
        now
      ).run();
    } catch { /* non-fatal */ }
    return c.json({
      success: false,
      error: 'Payment amount does not match booking total',
      data: { expected_kobo: booking.total_amount, received_kobo: receivedKobo },
    }, 402);
  }

  await confirmBookingById(db, booking, ref, 'flutterwave', now);

  return c.json({
    success: true,
    data: { status: 'confirmed', booking_id: booking.id, booking_status: 'confirmed' },
  });
});

// ============================================================
// Webhooks Router (T-TRN-04)
// Mounted at /webhooks in worker.ts — PUBLIC (no JWT).
// Both handlers are HMAC/secret verified internally.
//
// POST /webhooks/paystack    — charge.success → confirm + emit payment.successful
// POST /webhooks/flutterwave — charge.completed → confirm + emit payment.successful
// ============================================================

export const webhooksRouter = new Hono<AppContext>();

// ── Paystack webhook ─────────────────────────────────────────
webhooksRouter.post('/paystack', async (c) => {
  const signature = c.req.header('x-paystack-signature');
  let rawBody: string;
  try { rawBody = await c.req.text(); }
  catch { return c.json({ success: false, error: 'Failed to read body' }, 400); }

  if (!c.env.PAYSTACK_SECRET) {
    return c.json({ success: false, error: 'Paystack not configured' }, 503);
  }

  const computed = await hmacSha512(rawBody, c.env.PAYSTACK_SECRET);
  if (!signature || computed !== signature) {
    return c.json({ success: false, error: 'Invalid signature' }, 401);
  }

  let event: { event: string; data: Record<string, unknown> };
  try { event = JSON.parse(rawBody) as typeof event; }
  catch { return c.json({ success: false, error: 'Invalid JSON' }, 400); }

  if (event.event === 'charge.success') {
    const reference = event.data['reference'] as string | undefined;
    if (reference) {
      const db = c.env.DB;
      const now = Date.now();

      const booking = await db.prepare(
        `SELECT id, status, total_amount, seat_ids, payment_reference, payment_provider
         FROM trns_bookings
         WHERE (payment_reference = ? OR id = ?) AND deleted_at IS NULL LIMIT 1`
      ).bind(reference, reference).first<DbBookingPayment>();

      if (booking && booking.status !== 'confirmed' && booking.status !== 'cancelled') {
        await confirmBookingById(db, booking, reference, 'paystack', now);
        console.warn(`[webhook/paystack] charge.success — confirmed booking ${booking.id}`);
      }
    }
  }

  return c.json({ success: true });
});

// ── Flutterwave webhook ──────────────────────────────────────
webhooksRouter.post('/flutterwave', async (c) => {
  const verifHash = c.req.header('verif-hash');
  let rawBody: string;
  try { rawBody = await c.req.text(); }
  catch { return c.json({ success: false, error: 'Failed to read body' }, 400); }

  if (!c.env.FLUTTERWAVE_SECRET) {
    return c.json({ success: false, error: 'Flutterwave not configured' }, 503);
  }

  if (!verifHash || verifHash !== c.env.FLUTTERWAVE_SECRET) {
    return c.json({ success: false, error: 'Invalid signature' }, 401);
  }

  let event: { event: string; data: Record<string, unknown> };
  try { event = JSON.parse(rawBody) as typeof event; }
  catch { return c.json({ success: false, error: 'Invalid JSON' }, 400); }

  if (event.event === 'charge.completed') {
    const data = event.data;
    const tx_ref = data['tx_ref'] as string | undefined;
    const status = data['status'] as string | undefined;

    if (tx_ref && status === 'successful') {
      const db = c.env.DB;
      const now = Date.now();

      const booking = await db.prepare(
        `SELECT id, status, total_amount, seat_ids, payment_reference, payment_provider
         FROM trns_bookings
         WHERE (payment_reference = ? OR id = ?) AND deleted_at IS NULL LIMIT 1`
      ).bind(tx_ref, tx_ref).first<DbBookingPayment>();

      if (booking && booking.status !== 'confirmed' && booking.status !== 'cancelled') {
        await confirmBookingById(db, booking, tx_ref, 'flutterwave', now);
        console.warn(`[webhook/flutterwave] charge.completed — confirmed booking ${booking.id}`);
      }
    }
  }

  return c.json({ success: true });
});
