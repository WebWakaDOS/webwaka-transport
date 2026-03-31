/**
 * WebWaka Scheduled Sweepers
 * Functions run by the Cloudflare Worker Cron trigger (every minute).
 *
 * Responsibilities:
 *   drainEventBus()           — flush platform_events outbox to downstream consumers
 *   sweepExpiredReservations() — release timed-out seat holds
 *   sweepAbandonedBookings()  — cancel bookings pending payment > 30 min (configurable)
 *
 * All sweepers are idempotent and safe to re-run on overlap.
 * Event-Driven invariant: side-effects are published as platform_events so
 * downstream services can react without polling.
 */
import type { Env } from '../worker';
import { sendSms } from './sms.js';

// ============================================================
// B-005: Abandoned booking sweeper
// Cancels bookings where payment has not been received within
// ABANDONMENT_WINDOW_MS (default: 30 minutes).
// Seats are released and a booking:ABANDONED event is published.
// ============================================================

const ABANDONMENT_WINDOW_MS = 30 * 60 * 1000; // 30 minutes

export async function sweepAbandonedBookings(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const cutoff = now - ABANDONMENT_WINDOW_MS;

  try {
    const abandoned = await db
      .prepare(
        `SELECT id, customer_id, trip_id, seat_ids
         FROM bookings
         WHERE status = 'pending'
           AND payment_status = 'pending'
           AND created_at < ?
           AND deleted_at IS NULL`
      )
      .bind(cutoff)
      .all<{ id: string; customer_id: string; trip_id: string; seat_ids: string }>();

    if (!abandoned.results || abandoned.results.length === 0) return;

    console.log(`[AbandonedSweeper] Cancelling ${abandoned.results.length} abandoned bookings`);

    for (const booking of abandoned.results) {
      try {
        const seatIds = JSON.parse(booking.seat_ids) as string[];

        await db.batch([
          db.prepare(
            `UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`
          ).bind(now, booking.id),
          ...seatIds.map(seatId =>
            db.prepare(
              `UPDATE seats SET status = ?, reserved_by = NULL, reservation_token = NULL,
               reservation_expires_at = NULL, updated_at = ? WHERE id = ?`
            ).bind('available', now, seatId)
          ),
        ]);

        const evtId = `evt_ab_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await db.prepare(
          `INSERT OR IGNORE INTO platform_events
           (id, event_type, aggregate_id, aggregate_type, payload, status, created_at)
           VALUES (?, 'booking:ABANDONED', ?, 'booking', ?, 'pending', ?)`
        ).bind(
          evtId,
          booking.id,
          JSON.stringify({
            booking_id: booking.id,
            customer_id: booking.customer_id,
            trip_id: booking.trip_id,
            seat_ids: seatIds,
            abandoned_at: now,
          }),
          now
        ).run();

        console.log(`[AbandonedSweeper] Cancelled booking ${booking.id}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[AbandonedSweeper] Failed to cancel booking ${booking.id}: ${msg}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[AbandonedSweeper] Query error: ${msg}`);
  }
}

// ============================================================
// Seat reservation sweeper — releases TTL-expired seat holds
// (moved from worker.ts for separation of concerns)
// ============================================================

export async function sweepExpiredReservations(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();

  try {
    const expired = await db
      .prepare(
        `SELECT id, trip_id, operator_id
         FROM seats
         WHERE status = 'reserved'
           AND reservation_expires_at IS NOT NULL
           AND reservation_expires_at < ?`
      )
      .bind(now)
      .all<{ id: string; trip_id: string; operator_id: string | null }>();

    if (!expired.results || expired.results.length === 0) return;

    console.log(`[SeatSweeper] Releasing ${expired.results.length} expired reservations`);

    await db
      .prepare(
        `UPDATE seats
         SET status = 'available',
             reserved_by = NULL,
             reservation_token = NULL,
             reservation_expires_at = NULL,
             version = version + 1,
             updated_at = ?
         WHERE status = 'reserved'
           AND reservation_expires_at IS NOT NULL
           AND reservation_expires_at < ?`
      )
      .bind(now, now)
      .run();

    for (const seat of expired.results) {
      const evtId = `evt_sw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db
        .prepare(
          `INSERT OR IGNORE INTO platform_events
           (id, event_type, aggregate_id, aggregate_type, payload, tenant_id, status, created_at)
           VALUES (?, 'seat.reservation_expired', ?, 'seat', ?, ?, 'pending', ?)`
        )
        .bind(
          evtId,
          seat.id,
          JSON.stringify({ seat_id: seat.id, trip_id: seat.trip_id }),
          seat.operator_id ?? null,
          now
        )
        .run();
    }

    console.log(`[SeatSweeper] Released ${expired.results.length} seats`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[SeatSweeper] Error: ${msg}`);
  }
}

// ============================================================
// Event Bus drain — flushes platform_events outbox
// (moved from worker.ts for separation of concerns)
// ============================================================

export async function drainEventBus(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();

  try {
    const pending = await db
      .prepare(
        `SELECT * FROM platform_events
         WHERE status = 'pending' AND (retry_count IS NULL OR retry_count < 3)
         ORDER BY created_at ASC
         LIMIT 50`
      )
      .all();

    if (!pending.results || pending.results.length === 0) return;

    console.log(`[EventBus] Draining ${pending.results.length} pending events`);

    for (const evt of pending.results as Record<string, unknown>[]) {
      try {
        await deliverEvent(evt, env);

        await db
          .prepare(
            `UPDATE platform_events SET status = 'processed', processed_at = ? WHERE id = ?`
          )
          .bind(now, evt['id'])
          .run();

        console.log(`[EventBus] Processed: ${evt['event_type']} id=${evt['id']}`);
      } catch (err: unknown) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        const retryCount = ((evt['retry_count'] as number) ?? 0) + 1;
        const newStatus = retryCount >= 3 ? 'dead' : 'pending';

        await db
          .prepare(
            `UPDATE platform_events SET retry_count = ?, status = ?, last_error = ? WHERE id = ?`
          )
          .bind(retryCount, newStatus, errMsg, evt['id'])
          .run();

        console.error(`[EventBus] Failed (attempt ${retryCount}): ${evt['event_type']} id=${evt['id']} — ${errMsg}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[EventBus] Drain error: ${msg}`);
  }
}

// ============================================================
// Event routing — wire downstream consumers here as they are added
// ============================================================

async function deliverEvent(evt: Record<string, unknown>, env: Env): Promise<void> {
  const eventType = evt['event_type'] as string;

  // seat:RESERVED → invalidate seat cache
  if (eventType === 'seat:RESERVED' || eventType === 'seat.reservation_expired') {
    if (env.SEAT_CACHE_KV && evt['aggregate_id']) {
      try {
        await env.SEAT_CACHE_KV.delete(String(evt['aggregate_id']));
      } catch { /* non-fatal */ }
    }
    return;
  }

  // booking:CONFIRMED / booking.created → SMS confirmation to customer
  if (eventType === 'booking.created' || eventType === 'booking:CONFIRMED') {
    try {
      const payload = JSON.parse(String(evt['payload'] ?? '{}')) as Record<string, unknown>;
      const phone = String(payload['customer_phone'] ?? '');
      const origin = String(payload['origin'] ?? '');
      const destination = String(payload['destination'] ?? '');
      const departureDate = payload['departure_date']
        ? new Date(Number(payload['departure_date'])).toLocaleDateString('en-NG', {
            weekday: 'short', day: 'numeric', month: 'short',
          })
        : '';
      const seats = String(payload['seat_numbers'] ?? '');
      const bookingId = String(payload['booking_id'] ?? evt['aggregate_id'] ?? '');
      const shortId = bookingId.slice(-8).toUpperCase();
      const message =
        `WebWaka: Booking confirmed! ${origin} → ${destination}, ${departureDate}, ` +
        `Seat(s): ${seats}. Ref: ${shortId}. View: https://webwaka.ng/b/${bookingId}`;
      // NDPR guard: skip SMS if phone is anonymized or empty
      if (phone && !phone.startsWith('NDPR_')) await sendSms(phone, message, env);
    } catch (err) {
      console.error('[EventBus] SMS send error:', err instanceof Error ? err.message : err);
    }
    return;
  }

  // booking:ABANDONED → log (future: SMS to customer)
  if (eventType === 'booking:ABANDONED') {
    console.log(`[EventBus] booking:ABANDONED — SMS notification not yet wired`);
    return;
  }

  // parcel.* → logistics service
  if (eventType.startsWith('parcel.')) {
    await deliverToConsumer('https://logistics.webwaka.app/api/internal/events', evt);
    return;
  }

  // payment:AMOUNT_MISMATCH → fraud alert log
  if (eventType === 'payment:AMOUNT_MISMATCH') {
    console.error(`[EventBus] FRAUD ALERT: payment:AMOUNT_MISMATCH — booking ${evt['aggregate_id']}`);
    return;
  }

  // Default: no-op delivery (consumer not yet wired)
  console.log(`[EventBus] No-op delivery for: ${eventType} — consumer not yet wired`);
}

// ============================================================
// C-002: NDPR Data Retention Sweepers
// sweepExpiredPII     — anonymize customers inactive for 2+ years
// purgeExpiredFinancialData — soft-delete records older than 7 years
// Both run in the daily cron (cron: 0 0 * * *)
// ============================================================

const TWO_YEARS_MS = 2 * 365 * 24 * 60 * 60 * 1000;
const SEVEN_YEARS_MS = 7 * 365 * 24 * 60 * 60 * 1000;

/**
 * Anonymize PII for customers with no activity for 2+ years and
 * no active or future bookings (NDPR Article 2.1 — retention minimisation).
 */
export async function sweepExpiredPII(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const cutoff = now - TWO_YEARS_MS;

  try {
    // Find customers inactive for 2+ years with no confirmed/future bookings
    const stale = await db.prepare(
      `SELECT c.id FROM customers c
       WHERE c.deleted_at IS NULL
         AND (c.last_active_at IS NULL AND c.created_at < ?)
            OR (c.last_active_at IS NOT NULL AND c.last_active_at < ?)
         AND NOT EXISTS (
           SELECT 1 FROM bookings b
           WHERE b.customer_id = c.id
             AND b.deleted_at IS NULL
             AND b.status IN ('pending', 'confirmed')
             AND b.created_at > ?
         )
       LIMIT 100`
    ).bind(cutoff, cutoff, now - (30 * 24 * 60 * 60 * 1000)).all<{ id: string }>();

    if (!stale.results || stale.results.length === 0) return;

    console.log(`[NDPR/PII] Anonymizing ${stale.results.length} expired customer records`);

    for (const row of stale.results) {
      try {
        await db.prepare(
          `UPDATE customers
           SET name = 'ANONYMIZED', phone = ?, email = NULL, updated_at = ?
           WHERE id = ? AND deleted_at IS NULL`
        ).bind(`NDPR_REDACTED_${row.id}`, now, row.id).run();

        const evtId = `evt_ndpr_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
        await db.prepare(
          `INSERT OR IGNORE INTO platform_events
           (id, event_type, aggregate_id, aggregate_type, payload, status, created_at)
           VALUES (?, 'customer:PII_ANONYMIZED', ?, 'customer', ?, 'pending', ?)`
        ).bind(
          evtId, row.id,
          JSON.stringify({ customer_id: row.id, anonymized_at: now, reason: 'NDPR_2yr_inactivity' }),
          now
        ).run();

        console.log(`[NDPR/PII] Anonymized customer ${row.id}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[NDPR/PII] Failed to anonymize ${row.id}: ${msg}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[NDPR/PII] Sweep error: ${msg}`);
  }
}

/**
 * Soft-delete financial records (bookings + sales_transactions) older than 7 years.
 * NDPR Article 2.3 — financial records retained 7 years per FIRS requirements.
 * Uses soft-delete only — sets deleted_at for compliance audit trail.
 */
export async function purgeExpiredFinancialData(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const cutoff = now - SEVEN_YEARS_MS;

  try {
    const [bookingResult, txResult] = await Promise.all([
      db.prepare(
        `UPDATE bookings SET deleted_at = ? WHERE created_at < ? AND deleted_at IS NULL`
      ).bind(now, cutoff).run(),
      db.prepare(
        `UPDATE sales_transactions SET deleted_at = ? WHERE created_at < ? AND deleted_at IS NULL`
      ).bind(now, cutoff).run(),
    ]);

    const bookingsAffected = (bookingResult.meta as { changes?: number })?.changes ?? 0;
    const txAffected = (txResult.meta as { changes?: number })?.changes ?? 0;

    if (bookingsAffected > 0 || txAffected > 0) {
      console.log(`[NDPR/Financial] Purged ${bookingsAffected} bookings, ${txAffected} transactions (7yr TTL)`);

      const evtId = `evt_fin_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db.prepare(
        `INSERT OR IGNORE INTO platform_events
         (id, event_type, aggregate_id, aggregate_type, payload, status, created_at)
         VALUES (?, 'compliance:FINANCIAL_PURGE', 'batch', 'compliance', ?, 'pending', ?)`
      ).bind(
        evtId,
        JSON.stringify({ bookings_purged: bookingsAffected, transactions_purged: txAffected, cutoff_ms: cutoff }),
        now
      ).run();
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[NDPR/Financial] Purge error: ${msg}`);
  }
}

async function deliverToConsumer(endpointUrl: string, evt: Record<string, unknown>): Promise<void> {
  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webwaka-Event-Type': String(evt['event_type'] ?? ''),
      'X-Webwaka-Aggregate-ID': String(evt['aggregate_id'] ?? ''),
    },
    body: JSON.stringify(evt),
  });

  if (!response.ok) {
    throw new Error(`Consumer returned ${response.status} for event ${evt['id']}`);
  }
}
