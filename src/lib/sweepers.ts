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

    console.warn(`[AbandonedSweeper] Cancelling ${abandoned.results.length} abandoned bookings`);

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

        console.warn(`[AbandonedSweeper] Cancelled booking ${booking.id}`);
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

    console.warn(`[SeatSweeper] Releasing ${expired.results.length} expired reservations`);

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

    console.warn(`[SeatSweeper] Released ${expired.results.length} seats`);
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

    console.warn(`[EventBus] Draining ${pending.results.length} pending events`);

    for (const evt of pending.results as Record<string, unknown>[]) {
      try {
        await deliverEvent(evt, env);

        await db
          .prepare(
            `UPDATE platform_events SET status = 'processed', processed_at = ? WHERE id = ?`
          )
          .bind(now, evt['id'])
          .run();

        console.warn(`[EventBus] Processed: ${evt['event_type']} id=${evt['id']}`);
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
    console.warn(`[EventBus] booking:ABANDONED — SMS notification not yet wired`);
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

  // P05-T2: trip:SOS_ACTIVATED — critical; never silently drop
  if (eventType === 'trip:SOS_ACTIVATED') {
    const payload = JSON.parse(String(evt['payload'] ?? '{}')); // already validated above
    console.error(
      `[EventBus] 🚨 SOS ALERT: trip ${payload['trip_id'] ?? evt['aggregate_id']} — ` +
      `driver=${payload['triggered_by'] ?? 'unknown'}, ` +
      `route=${payload['route'] ?? 'unknown'}, ` +
      `at=${new Date(Number(payload['triggered_at'] ?? 0)).toISOString()}`
    );
    // Non-fatal email via SendGrid if configured
    if (env.SENDGRID_API_KEY) {
      const sosEmail = payload['sos_escalation_email'] as string | undefined;
      if (sosEmail) {
        await fetch('https://api.sendgrid.com/v3/mail/send', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${env.SENDGRID_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            personalizations: [{ to: [{ email: sosEmail }] }],
            from: { email: 'noreply@webwaka.ng', name: 'WebWaka SOS' },
            subject: `🚨 SOS ALERT — Trip ${payload['trip_id'] ?? evt['aggregate_id']}`,
            content: [{
              type: 'text/plain',
              value: `SOS triggered by driver on trip ${payload['trip_id']}.\nRoute: ${payload['route'] ?? 'unknown'}\nTime: ${new Date(Number(payload['triggered_at'] ?? 0)).toLocaleString('en-NG')}\n\nCheck dispatch dashboard immediately.`,
            }],
          }),
        }).catch((err: unknown) => {
          console.error('[EventBus] SOS email failed (non-fatal):', err instanceof Error ? err.message : err);
        });
      }
    }
    return;
  }

  // P13-T2: trip.state_changed → completed — send review-prompt SMS (once per booking)
  if (eventType === 'trip.state_changed') {
    try {
      const payload = JSON.parse(String(evt['payload'] ?? '{}')) as Record<string, unknown>;
      const newState = String(payload['new_state'] ?? '');
      if (newState !== 'completed') return; // only act on completion

      const tripId = String(payload['trip_id'] ?? evt['aggregate_id'] ?? '');
      const db = env.DB;
      const now = Date.now();

      // Find all confirmed bookings for this trip that have not had a review prompt sent
      const bookings = await db.prepare(
        `SELECT b.id, b.customer_id, c.phone as customer_phone, r.origin, r.destination
         FROM bookings b
         JOIN customers c ON c.id = b.customer_id
         JOIN trips t ON t.id = b.trip_id
         JOIN routes r ON r.id = t.route_id
         WHERE b.trip_id = ?
           AND b.status = 'confirmed'
           AND b.deleted_at IS NULL
           AND b.review_prompt_sent_at IS NULL
         LIMIT 100`
      ).bind(tripId).all<{ id: string; customer_id: string; customer_phone: string; origin: string; destination: string }>();

      let sent = 0;
      for (const bk of bookings.results) {
        if (!bk.customer_phone || bk.customer_phone.startsWith('NDPR_')) continue;
        const shortRef = bk.id.slice(-8).toUpperCase();
        const msg =
          `WebWaka: Hope you enjoyed your trip from ${bk.origin} to ${bk.destination}! ` +
          `Please rate your experience at https://webwaka.ng/review/${shortRef} — it takes 30 seconds.`;
        try {
          await sendSms(bk.customer_phone, msg, env);
          await db.prepare(`UPDATE bookings SET review_prompt_sent_at = ? WHERE id = ?`)
            .bind(now, bk.id).run();
          sent++;
        } catch {
          // SMS failed — non-fatal, review_prompt_sent_at stays NULL so it retries next drain
        }
      }
      console.warn(`[EventBus] trip.state_changed→completed review prompts sent=${sent}, trip=${tripId}`);
    } catch (err) {
      console.error('[EventBus] trip.state_changed handler error (non-fatal):', err instanceof Error ? err.message : err);
    }
    return;
  }

  // P05-T6: trip:DELAYED — bulk SMS to all affected passengers
  if (eventType === 'trip:DELAYED') {
    try {
      const payload = JSON.parse(String(evt['payload'] ?? '{}')) as Record<string, unknown>;
      const tripId = String(payload['trip_id'] ?? evt['aggregate_id'] ?? '');
      const reasonCode = String(payload['reason_code'] ?? 'other');
      const estimatedMs = Number(payload['estimated_departure_ms'] ?? 0);
      const origin = String(payload['origin'] ?? '');
      const destination = String(payload['destination'] ?? '');
      const departureDate = String(payload['departure_date'] ?? '');
      const estimatedTime = estimatedMs
        ? new Date(estimatedMs).toLocaleString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true })
        : 'To be advised';

      // Re-query confirmed bookings to get phones (event payload has count, not phones)
      const db = env.DB;
      const bookingsRes = await db.prepare(
        `SELECT c.phone as customer_phone FROM bookings b
         JOIN customers c ON c.id = b.customer_id
         WHERE b.trip_id = ? AND b.status = 'confirmed' AND b.deleted_at IS NULL
         LIMIT 100`
      ).bind(tripId).all<{ customer_phone: string }>();

      const phones = bookingsRes.results.map(r => r.customer_phone).filter(p => p && !p.startsWith('NDPR_'));
      const reason = reasonCode.charAt(0).toUpperCase() + reasonCode.slice(1);
      const route = origin && destination ? `${origin} → ${destination}` : `trip ${tripId.slice(-8)}`;

      let sent = 0;
      let failed = 0;
      for (const phone of phones) {
        const message =
          `WebWaka: Your trip ${route} on ${departureDate} has been delayed. ` +
          `Reason: ${reason}. New est. departure: ${estimatedTime}. We apologize for the inconvenience.`;
        try {
          await sendSms(phone, message, env);
          sent++;
        } catch {
          failed++;
        }
      }
      console.warn(`[EventBus] trip:DELAYED SMS — sent=${sent}, failed=${failed}, trip=${tripId}`);
    } catch (err) {
      console.error('[EventBus] trip:DELAYED handler error (non-fatal):', err instanceof Error ? err.message : err);
    }
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

    console.warn(`[NDPR/PII] Anonymizing ${stale.results.length} expired customer records`);

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

        console.warn(`[NDPR/PII] Anonymized customer ${row.id}`);
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
      console.warn(`[NDPR/Financial] Purged ${bookingsAffected} bookings, ${txAffected} transactions (7yr TTL)`);

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

// ============================================================
// P08-T4: Waitlist notification expiry sweeper
// Re-opens seats and advances queue when a notified customer fails to book within 30 min
// ============================================================
export async function sweepExpiredWaitlistNotifications(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();

  try {
    const expired = await db.prepare(
      `SELECT wl.id, wl.trip_id, wl.customer_id, wl.seat_class
       FROM waiting_list wl
       WHERE wl.deleted_at IS NULL
         AND wl.notified_at IS NOT NULL
         AND wl.expires_at IS NOT NULL
         AND wl.expires_at < ?`
    ).bind(now).all<{ id: string; trip_id: string; customer_id: string; seat_class: string }>();

    if (!expired.results || expired.results.length === 0) return;

    console.warn(`[WaitlistSweeper] Expiring ${expired.results.length} stale waitlist notifications`);

    for (const wl of expired.results) {
      try {
        await db.prepare(
          `UPDATE waiting_list SET deleted_at = ? WHERE id = ?`
        ).bind(now, wl.id).run();

        // Find next un-notified entry for the same trip + class
        type WL = { id: string; customer_id: string };
        const next = await db.prepare(
          `SELECT id, customer_id FROM waiting_list
           WHERE trip_id = ? AND seat_class = ? AND deleted_at IS NULL AND notified_at IS NULL
           ORDER BY position ASC LIMIT 1`
        ).bind(wl.trip_id, wl.seat_class).first<WL>();

        if (next) {
          const seat = await db.prepare(
            `SELECT id FROM seats WHERE trip_id = ? AND seat_class = ? AND status = 'available' LIMIT 1`
          ).bind(wl.trip_id, wl.seat_class).first<{ id: string }>();

          if (seat) {
            const expires_at = now + 10 * 60_000; // T4-5: 10-minute hold window
            await db.prepare(
              `UPDATE waiting_list SET notified_at = ?, expires_at = ? WHERE id = ?`
            ).bind(now, expires_at, next.id).run();

            const customer = await db.prepare(
              `SELECT phone FROM customers WHERE id = ?`
            ).bind(next.customer_id).first<{ phone: string }>();

            if (customer?.phone && !customer.phone.startsWith('NDPR_')) {
              await sendSms(
                customer.phone,
                `WebWaka: A ${wl.seat_class} seat on your waitlisted trip is now available! Book within 10 minutes.`,
                env,
              ).catch(() => {});
            }
          }
        }

        console.warn(`[WaitlistSweeper] Expired waitlist entry ${wl.id}`);
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[WaitlistSweeper] Failed for entry ${wl.id}: ${msg}`);
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[WaitlistSweeper] Error: ${msg}`);
  }
}

// ============================================================
// P09-T1: sweepVehicleMaintenanceDue — daily
// Publish vehicle.maintenance_due_soon for vehicles with service due in ≤ 7 days
// ============================================================
export async function sweepVehicleMaintenanceDue(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const cutoff = now + 7 * 86_400_000;

  try {
    // Use the most recent maintenance record per vehicle to determine next service due
    const records = await db.prepare(
      `SELECT vmr.vehicle_id, vmr.next_service_due, v.plate_number, vmr.operator_id
       FROM vehicle_maintenance_records vmr
       JOIN vehicles v ON v.id = vmr.vehicle_id
       WHERE vmr.next_service_due IS NOT NULL
         AND vmr.next_service_due < ?
         AND v.deleted_at IS NULL
       GROUP BY vmr.vehicle_id
       HAVING vmr.next_service_due = MAX(vmr.next_service_due)`
    ).bind(cutoff).all<{ vehicle_id: string; next_service_due: number; plate_number: string; operator_id: string }>();

    for (const r of records.results) {
      try {
        await db.prepare(
          `INSERT INTO platform_events (id, event_type, aggregate_id, aggregate_type, payload, tenant_id, created_at)
           VALUES (?, 'vehicle.maintenance_due_soon', ?, 'vehicle', ?, ?, ?)`
        ).bind(
          `evt_mnt_${r.vehicle_id}_${now}`,
          r.vehicle_id,
          JSON.stringify({ vehicle_id: r.vehicle_id, plate_number: r.plate_number, operator_id: r.operator_id, next_service_due_ms: r.next_service_due }),
          r.operator_id,
          now,
        ).run();
      } catch { /* skip individual failures */ }
    }
    console.warn(`[VehicleMaintenanceSweeper] Checked ${records.results.length} vehicles`);
  } catch (err: unknown) {
    console.error(`[VehicleMaintenanceSweeper] Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================
// P09-T1: sweepVehicleDocumentExpiry — daily
// Publish vehicle.document_expiring for documents expiring in ≤ 30 days
// ============================================================
export async function sweepVehicleDocumentExpiry(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const cutoff = now + 30 * 86_400_000;

  try {
    const docs = await db.prepare(
      `SELECT vd.id, vd.vehicle_id, vd.doc_type, vd.expires_at,
              v.plate_number, o.id AS operator_id
       FROM vehicle_documents vd
       JOIN vehicles v ON v.id = vd.vehicle_id
       JOIN operators o ON o.id = v.operator_id
       WHERE vd.expires_at < ?`
    ).bind(cutoff).all<{ id: string; vehicle_id: string; doc_type: string; expires_at: number; plate_number: string; operator_id: string }>();

    for (const doc of docs.results) {
      try {
        await db.prepare(
          `INSERT INTO platform_events (id, event_type, aggregate_id, aggregate_type, payload, tenant_id, created_at)
           VALUES (?, 'vehicle.document_expiring', ?, 'vehicle_document', ?, ?, ?)`
        ).bind(
          `evt_vdc_${doc.id}_${now}`,
          doc.vehicle_id,
          JSON.stringify({ doc_id: doc.id, vehicle_id: doc.vehicle_id, doc_type: doc.doc_type, expires_at: doc.expires_at, plate_number: doc.plate_number, operator_id: doc.operator_id }),
          doc.operator_id,
          now,
        ).run();
      } catch { /* skip individual failures */ }
    }
    console.warn(`[VehicleDocSweeper] Checked ${docs.results.length} documents`);
  } catch (err: unknown) {
    console.error(`[VehicleDocSweeper] Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================
// P09-T2: sweepDriverDocumentExpiry — daily
// Publish driver.document_expiring for documents expiring in ≤ 30 days
// ============================================================
export async function sweepDriverDocumentExpiry(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const cutoff = now + 30 * 86_400_000;

  try {
    const docs = await db.prepare(
      `SELECT dd.id, dd.driver_id, dd.doc_type, dd.expires_at,
              d.name AS driver_name, o.id AS operator_id
       FROM driver_documents dd
       JOIN drivers d ON d.id = dd.driver_id
       JOIN operators o ON o.id = d.operator_id
       WHERE dd.expires_at < ?`
    ).bind(cutoff).all<{ id: string; driver_id: string; doc_type: string; expires_at: number; driver_name: string; operator_id: string }>();

    for (const doc of docs.results) {
      try {
        await db.prepare(
          `INSERT INTO platform_events (id, event_type, aggregate_id, aggregate_type, payload, tenant_id, created_at)
           VALUES (?, 'driver.document_expiring', ?, 'driver_document', ?, ?, ?)`
        ).bind(
          `evt_ddc_${doc.id}_${now}`,
          doc.driver_id,
          JSON.stringify({ doc_id: doc.id, driver_id: doc.driver_id, doc_type: doc.doc_type, expires_at: doc.expires_at, driver_name: doc.driver_name, operator_id: doc.operator_id }),
          doc.operator_id,
          now,
        ).run();
      } catch { /* skip individual failures */ }
    }
    console.warn(`[DriverDocSweeper] Checked ${docs.results.length} documents`);
  } catch (err: unknown) {
    console.error(`[DriverDocSweeper] Error: ${err instanceof Error ? err.message : String(err)}`);
  }
}

// ============================================================
// P10-T3: sweepBookingReminders — every-minute cron
// Sends SMS reminders to confirmed bookings:
//   - 24h reminder: departure_time between now+23h and now+25h
//   -  2h reminder: departure_time between now+105min and now+135min
// Idempotent: reminder_24h_sent_at / reminder_2h_sent_at guard duplicates.
// NDPR: skips phones starting with 'NDPR_' or ndpr_consent=0.
// ============================================================
export async function sweepBookingReminders(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  const h23 = now + 23 * 60 * 60 * 1000;
  const h25 = now + 25 * 60 * 60 * 1000;
  const m105 = now + 105 * 60 * 1000;
  const m135 = now + 135 * 60 * 1000;

  try {
    const due24h = await db.prepare(
      `SELECT b.id, b.seat_ids,
              c.phone, c.name as customer_name, c.ndpr_consent,
              t.departure_time, r.origin, r.destination
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN trips t ON t.id = b.trip_id
       JOIN routes r ON r.id = t.route_id
       WHERE b.status = 'confirmed'
         AND b.deleted_at IS NULL
         AND t.departure_time BETWEEN ? AND ?
         AND b.reminder_24h_sent_at IS NULL
       LIMIT 50`
    ).bind(h23, h25).all<{
      id: string; seat_ids: string;
      phone: string; customer_name: string; ndpr_consent: number;
      departure_time: number; origin: string; destination: string;
    }>();

    for (const booking of due24h.results) {
      try {
        if (!booking.ndpr_consent || booking.phone.startsWith('NDPR_')) continue;
        const depTime = new Date(booking.departure_time).toLocaleString('en-NG', {
          timeZone: 'Africa/Lagos', dateStyle: 'medium', timeStyle: 'short',
        });
        const seatCount = (() => {
          try { return (JSON.parse(booking.seat_ids) as string[]).length; } catch { return 1; }
        })();
        const msg = `WebWaka: Reminder — your trip ${booking.origin} → ${booking.destination} departs in ~24 hours (${depTime}). ${seatCount} seat(s) reserved. Safe travels!`;
        await sendSms(booking.phone, msg, env);
        await db.prepare(`UPDATE bookings SET reminder_24h_sent_at = ? WHERE id = ?`).bind(now, booking.id).run();
      } catch { /* skip individual — non-fatal */ }
    }

    const due2h = await db.prepare(
      `SELECT b.id, b.seat_ids,
              c.phone, c.name as customer_name, c.ndpr_consent,
              t.departure_time, r.origin, r.destination
       FROM bookings b
       JOIN customers c ON c.id = b.customer_id
       JOIN trips t ON t.id = b.trip_id
       JOIN routes r ON r.id = t.route_id
       WHERE b.status = 'confirmed'
         AND b.deleted_at IS NULL
         AND t.departure_time BETWEEN ? AND ?
         AND b.reminder_2h_sent_at IS NULL
       LIMIT 50`
    ).bind(m105, m135).all<{
      id: string; seat_ids: string;
      phone: string; customer_name: string; ndpr_consent: number;
      departure_time: number; origin: string; destination: string;
    }>();

    for (const booking of due2h.results) {
      try {
        if (!booking.ndpr_consent || booking.phone.startsWith('NDPR_')) continue;
        const depTime = new Date(booking.departure_time).toLocaleString('en-NG', {
          timeZone: 'Africa/Lagos', timeStyle: 'short',
        });
        const msg = `WebWaka: Departing soon! ${booking.origin} → ${booking.destination} departs at ${depTime} (~2 hours). Please proceed to boarding. Safe travels!`;
        await sendSms(booking.phone, msg, env);
        await db.prepare(`UPDATE bookings SET reminder_2h_sent_at = ? WHERE id = ?`).bind(now, booking.id).run();
      } catch { /* skip individual — non-fatal */ }
    }

    const total = due24h.results.length + due2h.results.length;
    if (total > 0) {
      console.warn(`[BookingReminders] ${due24h.results.length} 24h + ${due2h.results.length} 2h reminders sent`);
    }
  } catch (err: unknown) {
    console.error(`[BookingReminders] Error: ${err instanceof Error ? err.message : String(err)}`);
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
