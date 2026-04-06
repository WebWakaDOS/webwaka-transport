/**
 * TRN-1: Seat Inventory API
 * Atomic seat reservation with 30-second TTL tokens
 * Invariants: Nigeria-First (kobo), Offline-First (sync), Multi-tenancy
 */
import { Hono } from 'hono';
import { publishEvent, nanoid } from '@webwaka/core';
import type { AppContext, DbTrip, DbSeat } from './types';
import { genId, parsePagination, metaResponse, requireFields, applyTenantScope } from './types';
import { getOperatorConfig } from '../lib/operator-config.js';
import { computeEffectiveFare } from '../core/pricing/engine';
import type { FareRule } from '../core/pricing/engine';

export type { Env } from './types';

export const seatInventoryRouter = new Hono<AppContext>();

// ============================================================
// GET /trns_trips — list trns_trips with availability (public)
// ============================================================
seatInventoryRouter.get('/trns_trips', async (c) => {
  const q = c.req.query();
  const { origin, destination, date } = q;
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;

  let query = `SELECT t.*, r.origin, r.destination, r.base_fare,
    COUNT(CASE WHEN s.status = 'available' THEN 1 END) as available_seats,
    COUNT(s.id) as total_seats
    FROM trns_trips t
    JOIN trns_routes r ON t.route_id = r.id
    LEFT JOIN trns_seats s ON s.trip_id = t.id
    WHERE t.deleted_at IS NULL AND t.state != 'cancelled'`;

  const params: unknown[] = [];
  const scoped = applyTenantScope(c, query, params, 't.');
  query = scoped.query;
  params.splice(0, params.length, ...scoped.params);

  if (origin) { query += ` AND r.origin LIKE ?`; params.push(`%${origin}%`); }
  if (destination) { query += ` AND r.destination LIKE ?`; params.push(`%${destination}%`); }
  if (date) {
    const start = new Date(date).setHours(0, 0, 0, 0);
    const end = new Date(date).setHours(23, 59, 59, 999);
    query += ` AND t.departure_time BETWEEN ? AND ?`;
    params.push(start, end);
  }
  query += ` GROUP BY t.id ORDER BY t.departure_time ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const result = await db.prepare(query).bind(...params).all();
    return c.json({ success: true, data: result.results, meta: metaResponse(result.results.length, limit, offset) });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch trns_trips' }, 500);
  }
});

// ============================================================
// POST /trns_trips — create a trip
// ============================================================
seatInventoryRouter.post('/trns_trips', async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['operator_id', 'route_id', 'vehicle_id', 'departure_time', 'total_seats']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { operator_id, route_id, vehicle_id, departure_time, total_seats } = body as {
    operator_id: string; route_id: string; vehicle_id: string; departure_time: number; total_seats: number;
  };

  if (!Number.isInteger(total_seats) || total_seats <= 0) {
    return c.json({ success: false, error: 'total_seats must be a positive integer' }, 400);
  }

  const db = c.env.DB;
  const id = genId('trp');
  const now = Date.now();

  try {
    // P08-T1: Fetch vehicle's seat_template to use for seat generation
    const vehicle = await db.prepare(
      `SELECT total_seats, seat_template FROM trns_vehicles WHERE id = ? AND deleted_at IS NULL`
    ).bind(vehicle_id).first<{ total_seats: number; seat_template: string | null }>();

    let seatInserts: ReturnType<typeof db.prepare>[];
    let actualSeatCount = total_seats;

    if (vehicle?.seat_template) {
      // Template-based: generate trns_seats from the vehicle's layout definition
      // T1-6: Malformed JSON must not crash — fall back to sequential trns_seats
      try {
        type TemplateSeat = { number: string; row: number; column: number; class: string };
        const template = JSON.parse(vehicle.seat_template) as { trns_seats: TemplateSeat[] };
        if (!Array.isArray(template.trns_seats) || template.trns_seats.length === 0) {
          throw new Error('seat_template.trns_seats is missing or empty');
        }
        // T1-7: Template seat count takes precedence over vehicle capacity field
        actualSeatCount = template.trns_seats.length;
        seatInserts = template.trns_seats.map(s =>
          db.prepare(
            `INSERT INTO trns_seats (id, trip_id, seat_number, seat_class, status, version, created_at, updated_at)
             VALUES (?, ?, ?, ?, 'available', 0, ?, ?)`
          ).bind(`${id}_s${s.number}`, id, s.number, s.class, now, now)
        );
      } catch (parseErr: unknown) {
        console.error('[seat-inventory] seat_template parse error for vehicle', vehicle_id, parseErr instanceof Error ? parseErr.message : parseErr, '— falling back to sequential trns_seats');
        // Fallback: sequential integer trns_seats, all standard class
        seatInserts = Array.from({ length: total_seats }, (_, i) =>
          db.prepare(
            `INSERT INTO trns_seats (id, trip_id, seat_number, seat_class, status, version, created_at, updated_at)
             VALUES (?, ?, ?, 'standard', 'available', 0, ?, ?)`
          ).bind(`${id}_s${i + 1}`, id, String(i + 1).padStart(2, '0'), now, now)
        );
      }
    } else {
      // Fallback: sequential integer trns_seats, all standard class
      const seatStmt = db.prepare(
        `INSERT INTO trns_seats (id, trip_id, seat_number, seat_class, status, version, created_at, updated_at)
         VALUES (?, ?, ?, 'standard', 'available', 0, ?, ?)`
      );
      seatInserts = Array.from({ length: total_seats }, (_, i) =>
        seatStmt.bind(`${id}_s${i + 1}`, id, String(i + 1).padStart(2, '0'), now, now)
      );
    }

    // Single atomic batch: trip row + all seat rows together
    await db.batch([
      db.prepare(
        `INSERT INTO trns_trips (id, operator_id, route_id, vehicle_id, departure_time, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`
      ).bind(id, operator_id, route_id, vehicle_id, departure_time, now, now),
      ...seatInserts,
    ]);

    return c.json({ success: true, data: { id, operator_id, route_id, total_seats: actualSeatCount, state: 'scheduled' } }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to create trip' }, 500);
  }
});

// ============================================================
// GET /trns_trips/:id/availability — seat map
// ============================================================
seatInventoryRouter.get('/trns_trips/:id/availability', async (c) => {
  const tripId = c.req.param('id');
  const db = c.env.DB;
  const now = Date.now();

  try {
    // P08-T1: Also fetch vehicle's seat_template for layout rendering
    const trip = await db.prepare(
      `SELECT t.id, v.seat_template FROM trns_trips t
       LEFT JOIN trns_vehicles v ON t.vehicle_id = v.id AND v.deleted_at IS NULL
       WHERE t.id = ? AND t.deleted_at IS NULL`
    ).bind(tripId).first<{ id: string; seat_template: string | null }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    await db.prepare(
      `UPDATE trns_seats SET status = 'available', reserved_by = NULL, reservation_token = NULL, reservation_expires_at = NULL
       WHERE trip_id = ? AND status = 'reserved' AND reservation_expires_at < ?`
    ).bind(tripId, now).run();

    const trns_seats = await db.prepare(
      `SELECT * FROM trns_seats WHERE trip_id = ? ORDER BY seat_number ASC`
    ).bind(tripId).all<DbSeat>();

    const counts = trns_seats.results.reduce((acc: Record<string, number>, s) => {
      acc[s.status] = (acc[s.status] ?? 0) + 1;
      return acc;
    }, {});

    // Parse seat_layout JSON (may be null for legacy trns_trips)
    const seat_layout = trip.seat_template ? JSON.parse(trip.seat_template) : null;

    return c.json({
      success: true,
      data: {
        trip_id: tripId,
        total_seats: trns_seats.results.length,
        available: counts['available'] ?? 0,
        reserved: counts['reserved'] ?? 0,
        confirmed: counts['confirmed'] ?? 0,
        blocked: counts['blocked'] ?? 0,
        seat_layout,
        trns_seats: trns_seats.results, // each seat includes seat_class
      },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch seat availability' }, 500);
  }
});

// ============================================================
// POST /trns_trips/:id/reserve — atomic seat reservation (configurable TTL)
// P03-T1: TTL sourced from operator config (online vs agent)
// ============================================================
seatInventoryRouter.post('/trns_trips/:id/reserve', async (c) => {
  const tripId = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['seat_id', 'user_id']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { seat_id, user_id } = body as { seat_id: string; user_id: string };
  const db = c.env.DB;
  const now = Date.now();

  // P03-T1: Look up trip to get operator_id for config
  const tripForConfig = await db.prepare(
    `SELECT operator_id FROM trns_trips WHERE id = ? AND deleted_at IS NULL`
  ).bind(tripId).first<{ operator_id: string }>();
  const operatorId = tripForConfig?.operator_id ?? '';
  const opConfig = await getOperatorConfig(c.env, operatorId);

  // Use online TTL if request comes from a web browser (Origin header present)
  const isOnline = Boolean(c.req.header('Origin'));
  const ttlMs = isOnline ? opConfig.online_reservation_ttl_ms : opConfig.reservation_ttl_ms;
  const expiresAt = now + ttlMs;
  const token = nanoid('tok', 32);

  try {
    await db.prepare(
      `UPDATE trns_seats SET status = 'available', reserved_by = NULL, reservation_token = NULL, reservation_expires_at = NULL
       WHERE id = ? AND status = 'reserved' AND reservation_expires_at < ?`
    ).bind(seat_id, now).run();

    const seat = await db.prepare(
      `SELECT * FROM trns_seats WHERE id = ? AND trip_id = ?`
    ).bind(seat_id, tripId).first<DbSeat>();

    if (!seat) return c.json({ success: false, error: 'Seat not found' }, 404);
    if (seat.status !== 'available') return c.json({ success: false, error: `Seat is ${seat.status}` }, 409);

    await db.prepare(
      `UPDATE trns_seats SET status = 'reserved', reserved_by = ?, reservation_token = ?, reservation_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'available'`
    ).bind(user_id, token, expiresAt, now, seat_id).run();

    broadcastSeatChange(c.env, tripId, { id: seat_id, status: 'reserved', seat_number: seat.seat_number ?? undefined });

    return c.json({
      success: true,
      data: { seat_id, trip_id: tripId, token, expires_at: expiresAt, ttl_seconds: Math.round(ttlMs / 1000) },
    }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to reserve seat' }, 500);
  }
});

// ============================================================
// POST /trns_trips/:tripId/reserve-batch — atomic multi-seat reservation
// T-TRN-01: Routed through TripSeatDO for true serialization.
// Idempotent via IDEMPOTENCY_KV. DO eliminates double-booking races
// across multiple Worker instances that D1 optimistic locking alone
// cannot prevent (concurrent reads see same version before any write).
// ============================================================
seatInventoryRouter.post('/trns_trips/:tripId/reserve-batch', async (c) => {
  const tripId = c.req.param('tripId');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['seat_ids', 'user_id', 'idempotency_key']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { seat_ids, user_id, idempotency_key } = body as {
    seat_ids: unknown; user_id: string; idempotency_key: string;
  };

  if (!Array.isArray(seat_ids) || seat_ids.length === 0) {
    return c.json({ success: false, error: 'seat_ids must be a non-empty array' }, 400);
  }
  if (seat_ids.length > 10) {
    return c.json({ success: false, error: 'Maximum 10 trns_seats per batch reservation' }, 400);
  }

  const db = c.env.DB;
  const kv = c.env.IDEMPOTENCY_KV;
  const idempotencyKvKey = `reserve-batch:${idempotency_key}`;

  // 1. Idempotency check — return cached response if this request was already processed
  if (kv) {
    const cached = await kv.get(idempotencyKvKey);
    if (cached) {
      return c.json(JSON.parse(cached));
    }
  }

  // 2. P03-T1: Configurable TTL sourced from operator config
  // T-TRN-03: Also load route_id + base_fare + departure_time for fare locking
  const tripForBatchConfig = await db.prepare(
    `SELECT t.operator_id, t.departure_time, r.id as route_id, r.base_fare
     FROM trns_trips t JOIN trns_routes r ON t.route_id = r.id
     WHERE t.id = ? AND t.deleted_at IS NULL`
  ).bind(tripId).first<{ operator_id: string; departure_time: number; route_id: string; base_fare: number }>();
  if (!tripForBatchConfig) {
    return c.json({ success: false, error: 'Trip not found' }, 404);
  }
  const batchOperatorId = tripForBatchConfig.operator_id;
  const batchOpConfig = await getOperatorConfig(c.env, batchOperatorId);
  const batchIsOnline = Boolean(c.req.header('Origin'));
  const batchTtlMs = batchIsOnline ? batchOpConfig.online_reservation_ttl_ms : batchOpConfig.reservation_ttl_ms;

  // 3. Verify all requested trns_seats exist for this trip
  //    T-TRN-03: Also fetch seat_class so we can lock the effective fare per seat
  const seatIdList = seat_ids as string[];
  const placeholders = seatIdList.map(() => '?').join(', ');
  const seatsResult = await db.prepare(
    `SELECT id, seat_class FROM trns_seats WHERE trip_id = ? AND id IN (${placeholders})`
  ).bind(tripId, ...seatIdList).all<{ id: string; seat_class: string }>();

  if (seatsResult.results.length !== seatIdList.length) {
    return c.json({ success: false, error: 'One or more trns_seats not found for this trip' }, 404);
  }

  // 4. Generate reservation tokens — nanoid('tok', 32) gives
  //    a cryptographically-random 32-char suffix making tokens unguessable
  const tokenMap: Record<string, string> = {};
  for (const seatId of seatIdList) {
    tokenMap[seatId] = nanoid('tok', 32);
  }

  // 5. T-TRN-01: Route through Durable Object for true serialization.
  //    The DO is keyed per-trip so all concurrent booking attempts for the
  //    same trip are funnelled through a single JS event loop instance.
  //    Fall back to a direct D1 path when the DO binding is not present
  //    (local dev without wrangler, or tests that omit TRIP_SEAT_DO).
  let responseBody: {
    success: boolean;
    data: { tokens: { seat_id: string; token: string; expires_at: number }[]; expires_at: number; ttl_seconds: number };
  };

  if (c.env.TRIP_SEAT_DO) {
    const doId = c.env.TRIP_SEAT_DO.idFromName(tripId);
    const stub = c.env.TRIP_SEAT_DO.get(doId);

    let doRes: Response;
    try {
      doRes = await stub.fetch(new Request('https://do/reserve-trns_seats', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ seat_ids: seatIdList, user_id, ttl_ms: batchTtlMs, trip_id: tripId, tokens: tokenMap }),
      }));
    } catch {
      return c.json({ success: false, error: 'Reservation service temporarily unavailable' }, 503);
    }

    if (!doRes.ok) {
      const doBody = await doRes.json() as Record<string, unknown>;
      return c.json(doBody, doRes.status as 400 | 404 | 409 | 500 | 503);
    }

    const doData = await doRes.json() as {
      success: boolean;
      data: { tokens: { seat_id: string; token: string; expires_at: number }[]; expires_at: number };
    };

    responseBody = {
      success: true,
      data: {
        tokens: doData.data.tokens,
        expires_at: doData.data.expires_at,
        ttl_seconds: Math.round(batchTtlMs / 1000),
      },
    };
  } else {
    // ── Fallback path: direct D1 optimistic locking (no DO binding) ──────
    const now = Date.now();
    const expiresAt = now + batchTtlMs;

    // Expire stale reservations before checking availability
    await db.prepare(
      `UPDATE trns_seats SET status = 'available', reserved_by = NULL, reservation_token = NULL, reservation_expires_at = NULL
       WHERE trip_id = ? AND status = 'reserved' AND reservation_expires_at < ?`
    ).bind(tripId, now).run();

    const seatsWithVersion = await db.prepare(
      `SELECT id, status, version FROM trns_seats WHERE trip_id = ? AND id IN (${placeholders})`
    ).bind(tripId, ...seatIdList).all<{ id: string; status: string; version: number }>();

    const unavailable = seatsWithVersion.results.find(s => s.status !== 'available');
    if (unavailable) {
      return c.json({
        success: false,
        error: 'seat_unavailable',
        seat_id: unavailable.id,
        message: 'One or more trns_seats are not available',
      }, 409);
    }

    const updateStmts = seatsWithVersion.results.map(seat =>
      db.prepare(
        `UPDATE trns_seats SET status = 'reserved', reserved_by = ?, reservation_token = ?,
         reservation_expires_at = ?, version = version + 1, updated_at = ?
         WHERE id = ? AND status = 'available' AND version = ?`
      ).bind(user_id, tokenMap[seat.id]!, expiresAt, now, seat.id, seat.version)
    );

    const batchResults = await db.batch(updateStmts);
    const failedSeats = seatsWithVersion.results.filter((_, i) => {
      const res = batchResults[i] as { meta?: { changes?: number } } | undefined;
      return (res?.meta?.changes ?? 0) === 0;
    });

    if (failedSeats.length > 0) {
      const successSeats = seatsWithVersion.results.filter((_, i) => {
        const res = batchResults[i] as { meta?: { changes?: number } } | undefined;
        return (res?.meta?.changes ?? 0) > 0;
      });
      if (successSeats.length > 0) {
        await db.batch(
          successSeats.map(seat =>
            db.prepare(
              `UPDATE trns_seats SET status = 'available', reserved_by = NULL, reservation_token = NULL,
               reservation_expires_at = NULL, updated_at = ?
               WHERE id = ? AND reservation_token = ?`
            ).bind(now, seat.id, tokenMap[seat.id]!)
          )
        ).catch(() => {});
      }
      return c.json({
        success: false,
        error: 'concurrent_conflict',
        message: 'Seat taken by another agent — please retry',
      }, 409);
    }

    const tokens = seatIdList.map(seatId => ({
      seat_id: seatId,
      token: tokenMap[seatId]!,
      expires_at: expiresAt,
    }));

    responseBody = {
      success: true,
      data: { tokens, expires_at: expiresAt, ttl_seconds: Math.round(batchTtlMs / 1000) },
    };
  }

  // T-TRN-03: Lock effective fare on each reserved seat (non-fatal)
  // Prevents bait-and-switch: price is snapshotted at reservation time.
  // If a surge rule expires before payment, the passenger still pays the reserved price.
  //
  // Guard: only lock when active fare rules exist.  If no rules are configured for
  // this route the lock would stamp base_fare on every class — overriding legacy
  // fare_matrix class multipliers and causing fare_mismatch at checkout.
  // When locked_fare_kobo stays NULL the booking portal falls through to the
  // trns_fare_rules engine → legacy fare_matrix chain correctly.
  ;(async () => {
    try {
      const fareRules = await db.prepare(
        `SELECT * FROM trns_fare_rules WHERE route_id = ? AND operator_id = ? AND is_active = 1 AND deleted_at IS NULL`
      ).bind(tripForBatchConfig.route_id, tripForBatchConfig.operator_id).all<FareRule>();

      // No active rules — leave locked_fare_kobo NULL so booking portal falls
      // through to legacy fare_matrix for class-specific pricing.
      if (fareRules.results.length === 0) return;

      const seatClassMap = new Map(seatsResult.results.map(s => [s.id, s.seat_class]));
      const lockStmts = seatIdList.map(seatId => {
        const seatClass = seatClassMap.get(seatId) ?? 'standard';
        const lockedFare = computeEffectiveFare(
          tripForBatchConfig.base_fare, seatClass, fareRules.results, tripForBatchConfig.departure_time
        );
        return db.prepare(
          `UPDATE trns_seats SET locked_fare_kobo = ? WHERE id = ?`
        ).bind(lockedFare, seatId);
      });
      await db.batch(lockStmts);
    } catch {
      // Non-fatal: fare lock failure must not block the reservation
    }
  })();

  // 6. Broadcast seat changes to connected WebSocket clients (non-fatal)
  for (const seatId of seatIdList) {
    broadcastSeatChange(c.env, tripId, { id: seatId, status: 'reserved' });
  }

  // 7. Publish platform event (non-fatal — event bus failure must not block booking)
  publishEvent(db, {
    event_type: 'seat.batch_reserved',
    aggregate_id: tripId,
    aggregate_type: 'trip',
    payload: { trip_id: tripId, seat_ids: seatIdList, user_id, tokens: responseBody.data.tokens },
    tenant_id: batchOperatorId,
    timestamp: Date.now(),
  }).catch(() => {});

  // 8. Cache success response for 24 hours for idempotency replay
  if (kv) {
    kv.put(idempotencyKvKey, JSON.stringify(responseBody), { expirationTtl: 86_400 }).catch(() => {});
  }

  return c.json(responseBody, 200);
});

// ============================================================
// P03-T2: POST /trns_trips/:tripId/extend-hold — extend a seat reservation TTL
// Called by Paystack popup onClose to keep the seat held while user is
// still on the payment page. Non-fatal: client ignores failure.
// ============================================================
seatInventoryRouter.post('/trns_trips/:tripId/extend-hold', async (c) => {
  const tripId = c.req.param('tripId');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['seat_id', 'token']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { seat_id, token } = body as { seat_id: string; token: string };
  const db = c.env.DB;
  const now = Date.now();

  const seat = await db.prepare(
    `SELECT status, reservation_token, reservation_expires_at FROM trns_seats WHERE id = ? AND trip_id = ?`
  ).bind(seat_id, tripId).first<{ status: string; reservation_token: string | null; reservation_expires_at: number | null }>();

  if (!seat) return c.json({ success: false, error: 'Seat not found for this trip' }, 404);

  // Check token FIRST so we can distinguish expired vs invalid
  if (seat.reservation_token !== token) {
    return c.json({ success: false, error: 'invalid_hold', message: 'Hold token does not match. Not your reservation.' }, 409);
  }

  // Token matches but seat was swept (status no longer reserved) — 410 Gone
  if (seat.status !== 'reserved') {
    return c.json({ success: false, error: 'hold_expired', message: 'Reservation has expired and seat was released. Please rebook.' }, 410);
  }

  // Seat is still reserved but TTL has lapsed — 410 Gone
  if (seat.reservation_expires_at !== null && seat.reservation_expires_at < now) {
    return c.json({ success: false, error: 'hold_expired', message: 'Reservation has expired. Please rebook.' }, 410);
  }

  // Get operator config for TTL extension increment
  const tripForExtend = await db.prepare(
    `SELECT operator_id FROM trns_trips WHERE id = ? AND deleted_at IS NULL`
  ).bind(tripId).first<{ operator_id: string }>();
  const extendOpConfig = await getOperatorConfig(c.env, tripForExtend?.operator_id ?? '');
  const extendTtlMs = extendOpConfig.online_reservation_ttl_ms;

  const MAX_HOLD_MS = 10 * 60 * 1000; // 10 minutes absolute maximum

  // Approximate original_reserved_at (when the hold started)
  const originalReservedAt = (seat.reservation_expires_at ?? now) - extendTtlMs;
  const new_expires_at = Math.min(
    now + extendTtlMs,
    originalReservedAt + MAX_HOLD_MS,
  );

  if (new_expires_at <= now) {
    return c.json({ success: false, error: 'max_hold_reached', message: 'Maximum hold time reached.' }, 410);
  }

  await db.prepare(
    `UPDATE trns_seats SET reservation_expires_at = ?, updated_at = ? WHERE id = ? AND reservation_token = ?`
  ).bind(new_expires_at, now, seat_id, token).run();

  return c.json({ success: true, data: { expires_at: new_expires_at } });
});

// ============================================================
// POST /trns_trips/:id/confirm — confirm a reservation
// ============================================================
seatInventoryRouter.post('/trns_trips/:id/confirm', async (c) => {
  const tripId = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['seat_id', 'token']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { seat_id, token, booking_id } = body as { seat_id: string; token: string; booking_id?: string };
  const db = c.env.DB;
  const now = Date.now();

  try {
    const seat = await db.prepare(
      `SELECT * FROM trns_seats WHERE id = ? AND trip_id = ? AND reservation_token = ?`
    ).bind(seat_id, tripId, token).first<DbSeat>();

    if (!seat) return c.json({ success: false, error: 'Invalid token or seat not found' }, 404);
    if (seat.status !== 'reserved') return c.json({ success: false, error: 'Seat is not in reserved state' }, 409);
    if (seat.reservation_expires_at !== null && seat.reservation_expires_at < now) {
      return c.json({ success: false, error: 'Reservation token expired' }, 410);
    }

    await db.prepare(
      `UPDATE trns_seats SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, reservation_token = NULL, updated_at = ?
       WHERE id = ?`
    ).bind(booking_id ?? seat.reserved_by, now, now, seat_id).run();

    broadcastSeatChange(c.env, tripId, { id: seat_id, status: 'confirmed', seat_number: seat.seat_number ?? undefined });

    return c.json({ success: true, data: { seat_id, trip_id: tripId, status: 'confirmed' } });
  } catch {
    return c.json({ success: false, error: 'Failed to confirm seat' }, 500);
  }
});

// ============================================================
// POST /trns_trips/:id/release — release a reservation (token required)
// SEC-006: token is mandatory to prevent unauthorized seat release
// ============================================================
seatInventoryRouter.post('/trns_trips/:id/release', async (c) => {
  const tripId = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['seat_id', 'token']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { seat_id, token } = body as { seat_id: string; token: string };
  const db = c.env.DB;
  const now = Date.now();

  try {
    const seat = await db.prepare(
      `SELECT id, reservation_token FROM trns_seats WHERE trip_id = ? AND id = ?`
    ).bind(tripId, seat_id).first<{ id: string; reservation_token: string | null }>();

    if (!seat) return c.json({ success: false, error: 'Seat not found' }, 404);
    if (seat.reservation_token !== token) {
      return c.json({ success: false, error: 'Invalid reservation token' }, 403);
    }

    await db.prepare(
      `UPDATE trns_seats SET status = 'available', reserved_by = NULL, reservation_token = NULL,
       reservation_expires_at = NULL, updated_at = ?
       WHERE id = ? AND trip_id = ? AND reservation_token = ?`
    ).bind(now, seat_id, tripId, token).run();

    // T-TRN-01: Notify DO so its in-memory held-seat map stays consistent (non-fatal)
    notifyDOReleaseSeats(c.env, tripId, [seat_id], { [seat_id]: token });

    broadcastSeatChange(c.env, tripId, { id: seat_id, status: 'available' });

    return c.json({ success: true, data: { seat_id, trip_id: tripId, status: 'available' } });
  } catch {
    return c.json({ success: false, error: 'Failed to release seat' }, 500);
  }
});

// ============================================================
// PATCH /trns_trips/:tripId/trns_seats/:seatId — update seat status
// (Used by SyncEngine for offline seat mutations)
// ============================================================
seatInventoryRouter.patch('/trns_trips/:tripId/trns_seats/:seatId', async (c) => {
  const tripId = c.req.param('tripId');
  const seatId = c.req.param('seatId');
  const body = await c.req.json() as Record<string, unknown>;

  const { status, reserved_by, confirmed_by } = body as {
    status?: string;
    reserved_by?: string;
    confirmed_by?: string;
  };

  const ALLOWED_STATUSES = ['available', 'reserved', 'confirmed', 'blocked'];
  if (status && !ALLOWED_STATUSES.includes(status)) {
    return c.json({ success: false, error: `Invalid status. Allowed: ${ALLOWED_STATUSES.join(', ')}` }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  try {
    const seat = await db.prepare(
      `SELECT * FROM trns_seats WHERE id = ? AND trip_id = ?`
    ).bind(seatId, tripId).first<DbSeat>();

    if (!seat) return c.json({ success: false, error: 'Seat not found' }, 404);

    await db.prepare(
      `UPDATE trns_seats
       SET status = COALESCE(?, status),
           reserved_by = COALESCE(?, reserved_by),
           confirmed_by = COALESCE(?, confirmed_by),
           version = version + 1,
           updated_at = ?
       WHERE id = ? AND trip_id = ?`
    ).bind(status ?? null, reserved_by ?? null, confirmed_by ?? null, now, seatId, tripId).run();

    return c.json({ success: true, data: { id: seatId, trip_id: tripId, status: status ?? seat.status, updated_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to update seat' }, 500);
  }
});

// ============================================================
// POST /sync — Offline-First mutation sync
// ============================================================
seatInventoryRouter.post('/sync', async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const { mutations } = body as { mutations?: unknown[] };

  if (!Array.isArray(mutations)) {
    return c.json({ success: false, error: 'mutations array required' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const applied: string[] = [];
  const failed: string[] = [];

  for (const mut of mutations as Array<Record<string, unknown>>) {
    try {
      const mutId = genId('mut');
      await db.prepare(
        `INSERT OR REPLACE INTO trns_sync_mutations (id, entity_type, entity_id, action, payload, version, status, retry_count, created_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, 'SYNCED', 0, ?, ?)`
      ).bind(
        mutId,
        mut['entity_type'], mut['entity_id'], mut['action'],
        JSON.stringify(mut['payload']), mut['version'], now, now
      ).run();
      applied.push(String(mut['entity_id']));
    } catch {
      failed.push(String(mut['entity_id'] ?? 'unknown'));
    }
  }

  return c.json({ success: true, data: { applied, failed, synced_at: now } });
});

// ============================================================
// P15-T2: Durable Object broadcast helper — non-fatal seat update push
// ============================================================
function broadcastSeatChange(
  env: { TRIP_SEAT_DO?: DurableObjectNamespace },
  tripId: string,
  seat: { id: string; status: string; seat_number?: string },
): void {
  if (!env.TRIP_SEAT_DO) return;
  try {
    const doId = env.TRIP_SEAT_DO.idFromName(tripId);
    const stub = env.TRIP_SEAT_DO.get(doId);
    stub.fetch(new Request('https://do/broadcast', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type: 'seat_changed', seat }),
    })).catch(() => {});
  } catch { /* non-fatal */ }
}

// ============================================================
// T-TRN-01: Notify DO to remove trns_seats from its in-memory held-seat map.
// Called by the HTTP /release endpoint so the DO stays in sync when
// trns_seats are released outside the reserve-batch path. Non-fatal.
// ============================================================
function notifyDOReleaseSeats(
  env: { TRIP_SEAT_DO?: DurableObjectNamespace },
  tripId: string,
  seatIds: string[],
  tokens: Record<string, string>,
): void {
  if (!env.TRIP_SEAT_DO || seatIds.length === 0) return;
  try {
    const doId = env.TRIP_SEAT_DO.idFromName(tripId);
    const stub = env.TRIP_SEAT_DO.get(doId);
    stub.fetch(new Request('https://do/release-trns_seats', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ seat_ids: seatIds, tokens, trip_id: tripId }),
    })).catch(() => {});
  } catch { /* non-fatal */ }
}

// ============================================================
// P15-T2: GET /trns_trips/:id/ws — WebSocket upgrade to Durable Object
// Proxies the connection to the TripSeatDO for this trip.
// Falls back gracefully when TRIP_SEAT_DO binding not present.
// ============================================================
seatInventoryRouter.get('/trns_trips/:id/ws', async (c) => {
  const tripId = c.req.param('id');
  const env = c.env;

  if (!env.TRIP_SEAT_DO) {
    return c.json({ success: false, error: 'Real-time seat updates not configured' }, 503);
  }

  const doId = env.TRIP_SEAT_DO.idFromName(tripId);
  const stub = env.TRIP_SEAT_DO.get(doId);
  return stub.fetch(new Request('https://do/ws', { headers: c.req.raw.headers }));
});

// ============================================================
// P10-T1: GET /trns_trips/:id/live — SSE seat availability feed
// Public: covered by /api/seat-inventory/trns_trips publicRoute prefix
// Pushes seat count updates every ~30 s; closes after 5 minutes.
// ============================================================

const SSE_MAX_LIFETIME_MS = 5 * 60 * 1000;
const SSE_PING_INTERVAL_MS = 30 * 1000;

seatInventoryRouter.get('/trns_trips/:id/live', async (c) => {
  const tripId = c.req.param('id');
  const db = c.env.DB;
  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const enqueue = (text: string) => {
        try { controller.enqueue(encoder.encode(text)); } catch { /* stream closed */ }
      };

      const trip = await db.prepare(
        `SELECT id FROM trns_trips WHERE id = ? AND deleted_at IS NULL`
      ).bind(tripId).first<{ id: string }>();

      if (!trip) {
        enqueue('event: error\ndata: {"error":"trip_not_found"}\n\n');
        try { controller.close(); } catch { /* already closed */ }
        return;
      }

      const startTime = Date.now();
      let lastSentState = '';

      while (true) {
        if (Date.now() - startTime >= SSE_MAX_LIFETIME_MS) {
          enqueue('event: close\ndata: {"reason":"max_lifetime_reached"}\n\n');
          try { controller.close(); } catch { /* already closed */ }
          return;
        }

        try {
          const result = await db.prepare(
            `SELECT status, COUNT(*) as count FROM trns_seats WHERE trip_id = ? GROUP BY status`
          ).bind(tripId).all<{ status: string; count: number }>();

          const counts: Record<string, number> = {};
          for (const row of result.results) counts[row.status] = row.count;

          const state = JSON.stringify(counts);
          if (state !== lastSentState) {
            lastSentState = state;
            enqueue(`data: ${JSON.stringify({ trip_id: tripId, trns_seats: counts, ts: Date.now() })}\n\n`);
          } else {
            enqueue(`: ping\n\n`);
          }
        } catch {
          try { controller.close(); } catch { /* already closed */ }
          return;
        }

        await new Promise<void>(res => setTimeout(res, SSE_PING_INTERVAL_MS));
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
});

// Keep for backwards compat — other API files re-export from ./types
export type { DbTrip, DbSeat };
