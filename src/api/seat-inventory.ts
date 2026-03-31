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

export type { Env } from './types';

export const seatInventoryRouter = new Hono<AppContext>();

// ============================================================
// GET /trips — list trips with availability (public)
// ============================================================
seatInventoryRouter.get('/trips', async (c) => {
  const q = c.req.query();
  const { origin, destination, date } = q;
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;

  let query = `SELECT t.*, r.origin, r.destination, r.base_fare,
    COUNT(CASE WHEN s.status = 'available' THEN 1 END) as available_seats,
    COUNT(s.id) as total_seats
    FROM trips t
    JOIN routes r ON t.route_id = r.id
    LEFT JOIN seats s ON s.trip_id = t.id
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
    return c.json({ success: false, error: 'Failed to fetch trips' }, 500);
  }
});

// ============================================================
// POST /trips — create a trip
// ============================================================
seatInventoryRouter.post('/trips', async (c) => {
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
    const seatStmt = db.prepare(
      `INSERT INTO seats (id, trip_id, seat_number, status, version, created_at, updated_at) VALUES (?, ?, ?, 'available', 0, ?, ?)`
    );
    const seatInserts = Array.from({ length: total_seats }, (_, i) =>
      seatStmt.bind(`${id}_s${i + 1}`, id, String(i + 1).padStart(2, '0'), now, now)
    );

    // Single atomic batch: trip row + all seat rows together
    await db.batch([
      db.prepare(
        `INSERT INTO trips (id, operator_id, route_id, vehicle_id, departure_time, state, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`
      ).bind(id, operator_id, route_id, vehicle_id, departure_time, now, now),
      ...seatInserts,
    ]);

    return c.json({ success: true, data: { id, operator_id, route_id, total_seats, state: 'scheduled' } }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to create trip' }, 500);
  }
});

// ============================================================
// GET /trips/:id/availability — seat map
// ============================================================
seatInventoryRouter.get('/trips/:id/availability', async (c) => {
  const tripId = c.req.param('id');
  const db = c.env.DB;
  const now = Date.now();

  try {
    const trip = await db.prepare(
      `SELECT id FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(tripId).first<{ id: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    await db.prepare(
      `UPDATE seats SET status = 'available', reserved_by = NULL, reservation_token = NULL, reservation_expires_at = NULL
       WHERE trip_id = ? AND status = 'reserved' AND reservation_expires_at < ?`
    ).bind(tripId, now).run();

    const seats = await db.prepare(
      `SELECT * FROM seats WHERE trip_id = ? ORDER BY seat_number ASC`
    ).bind(tripId).all<DbSeat>();

    const counts = seats.results.reduce((acc: Record<string, number>, s) => {
      acc[s.status] = (acc[s.status] ?? 0) + 1;
      return acc;
    }, {});

    return c.json({
      success: true,
      data: {
        trip_id: tripId,
        total_seats: seats.results.length,
        available: counts['available'] ?? 0,
        reserved: counts['reserved'] ?? 0,
        confirmed: counts['confirmed'] ?? 0,
        blocked: counts['blocked'] ?? 0,
        seats: seats.results,
      },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch seat availability' }, 500);
  }
});

// ============================================================
// POST /trips/:id/reserve — atomic seat reservation (configurable TTL)
// P03-T1: TTL sourced from operator config (online vs agent)
// ============================================================
seatInventoryRouter.post('/trips/:id/reserve', async (c) => {
  const tripId = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['seat_id', 'user_id']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { seat_id, user_id } = body as { seat_id: string; user_id: string };
  const db = c.env.DB;
  const now = Date.now();

  // P03-T1: Look up trip to get operator_id for config
  const tripForConfig = await db.prepare(
    `SELECT operator_id FROM trips WHERE id = ? AND deleted_at IS NULL`
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
      `UPDATE seats SET status = 'available', reserved_by = NULL, reservation_token = NULL, reservation_expires_at = NULL
       WHERE id = ? AND status = 'reserved' AND reservation_expires_at < ?`
    ).bind(seat_id, now).run();

    const seat = await db.prepare(
      `SELECT * FROM seats WHERE id = ? AND trip_id = ?`
    ).bind(seat_id, tripId).first<DbSeat>();

    if (!seat) return c.json({ success: false, error: 'Seat not found' }, 404);
    if (seat.status !== 'available') return c.json({ success: false, error: `Seat is ${seat.status}` }, 409);

    await db.prepare(
      `UPDATE seats SET status = 'reserved', reserved_by = ?, reservation_token = ?, reservation_expires_at = ?, updated_at = ?
       WHERE id = ? AND status = 'available'`
    ).bind(user_id, token, expiresAt, now, seat_id).run();

    return c.json({
      success: true,
      data: { seat_id, trip_id: tripId, token, expires_at: expiresAt, ttl_seconds: Math.round(ttlMs / 1000) },
    }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to reserve seat' }, 500);
  }
});

// ============================================================
// POST /trips/:tripId/reserve-batch — atomic multi-seat reservation
// Idempotent via IDEMPOTENCY_KV. Uses optimistic locking (version).
// ============================================================
seatInventoryRouter.post('/trips/:tripId/reserve-batch', async (c) => {
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
    return c.json({ success: false, error: 'Maximum 10 seats per batch reservation' }, 400);
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

  const now = Date.now();

  // P03-T1: Configurable TTL sourced from operator config
  const tripForBatchConfig = await db.prepare(
    `SELECT operator_id FROM trips WHERE id = ? AND deleted_at IS NULL`
  ).bind(tripId).first<{ operator_id: string }>();
  const batchOperatorId = tripForBatchConfig?.operator_id ?? '';
  const batchOpConfig = await getOperatorConfig(c.env, batchOperatorId);
  const batchIsOnline = Boolean(c.req.header('Origin'));
  const batchTtlMs = batchIsOnline ? batchOpConfig.online_reservation_ttl_ms : batchOpConfig.reservation_ttl_ms;
  const expiresAt = now + batchTtlMs;

  // Expire stale reservations for this trip before checking availability
  await db.prepare(
    `UPDATE seats SET status = 'available', reserved_by = NULL, reservation_token = NULL, reservation_expires_at = NULL
     WHERE trip_id = ? AND status = 'reserved' AND reservation_expires_at < ?`
  ).bind(tripId, now).run();

  // 2. Read all requested seats in a single query
  const seatIdList = seat_ids as string[];
  const placeholders = seatIdList.map(() => '?').join(', ');
  const seatsResult = await db.prepare(
    `SELECT id, status, version FROM seats WHERE trip_id = ? AND id IN (${placeholders})`
  ).bind(tripId, ...seatIdList).all<{ id: string; status: string; version: number }>();

  if (seatsResult.results.length !== seatIdList.length) {
    return c.json({ success: false, error: 'One or more seats not found for this trip' }, 404);
  }

  // 3. Check all seats are available
  const unavailable = seatsResult.results.find(s => s.status !== 'available');
  if (unavailable) {
    return c.json({
      success: false,
      error: 'seat_unavailable',
      seat_id: unavailable.id,
      message: 'One or more seats are not available',
    }, 409);
  }

  // 4. Generate reservation tokens for each seat — nanoid('tok', 32) gives
  //    a cryptographically-random 32-char suffix making tokens unguessable
  const tokenMap: Record<string, string> = {};
  for (const seat of seatsResult.results) {
    tokenMap[seat.id] = nanoid('tok', 32);
  }

  // 5. Build D1 batch with optimistic locking (version check prevents double-booking)
  const updateStmts = seatsResult.results.map(seat =>
    db.prepare(
      `UPDATE seats SET status = 'reserved', reserved_by = ?, reservation_token = ?,
       reservation_expires_at = ?, version = version + 1, updated_at = ?
       WHERE id = ? AND status = 'available' AND version = ?`
    ).bind(user_id, tokenMap[seat.id]!, expiresAt, now, seat.id, seat.version)
  );

  // 6. Execute the batch atomically
  const batchResults = await db.batch(updateStmts);

  // 7. Check for concurrent conflicts (changes = 0 means another agent grabbed this seat)
  const failedSeats = seatsResult.results.filter((_, i) => {
    const res = batchResults[i] as { meta?: { changes?: number } } | undefined;
    return (res?.meta?.changes ?? 0) === 0;
  });

  if (failedSeats.length > 0) {
    // Compensating transaction: release any seats that did succeed
    const successSeats = seatsResult.results.filter((_, i) => {
      const res = batchResults[i] as { meta?: { changes?: number } } | undefined;
      return (res?.meta?.changes ?? 0) > 0;
    });
    if (successSeats.length > 0) {
      await db.batch(
        successSeats.map(seat =>
          db.prepare(
            `UPDATE seats SET status = 'available', reserved_by = NULL, reservation_token = NULL,
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

  // 8. Build the token list for the response
  const tokens = seatsResult.results.map(seat => ({
    seat_id: seat.id,
    token: tokenMap[seat.id]!,
    expires_at: expiresAt,
  }));

  // 9. Publish platform event (non-fatal — event bus failure must not block booking)
  const trip = await db.prepare(
    `SELECT operator_id FROM trips WHERE id = ? AND deleted_at IS NULL`
  ).bind(tripId).first<{ operator_id: string }>();

  if (trip) {
    publishEvent(db, {
      event_type: 'seat.batch_reserved',
      aggregate_id: tripId,
      aggregate_type: 'trip',
      payload: { trip_id: tripId, seat_ids: seatIdList, user_id, tokens },
      tenant_id: trip.operator_id,
      timestamp: now,
    }).catch(() => {});
  }

  const responseBody = {
    success: true,
    data: { tokens, expires_at: expiresAt, ttl_seconds: Math.round(batchTtlMs / 1000) },
  };

  // 10. Cache success response for 24 hours for idempotency replay
  if (kv) {
    kv.put(idempotencyKvKey, JSON.stringify(responseBody), { expirationTtl: 86_400 }).catch(() => {});
  }

  return c.json(responseBody, 200);
});

// ============================================================
// P03-T2: POST /trips/:tripId/extend-hold — extend a seat reservation TTL
// Called by Paystack popup onClose to keep the seat held while user is
// still on the payment page. Non-fatal: client ignores failure.
// ============================================================
seatInventoryRouter.post('/trips/:tripId/extend-hold', async (c) => {
  const tripId = c.req.param('tripId');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['seat_id', 'token']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { seat_id, token } = body as { seat_id: string; token: string };
  const db = c.env.DB;
  const now = Date.now();

  const seat = await db.prepare(
    `SELECT status, reservation_token, reservation_expires_at FROM seats WHERE id = ? AND trip_id = ?`
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
    `SELECT operator_id FROM trips WHERE id = ? AND deleted_at IS NULL`
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
    `UPDATE seats SET reservation_expires_at = ?, updated_at = ? WHERE id = ? AND reservation_token = ?`
  ).bind(new_expires_at, now, seat_id, token).run();

  return c.json({ success: true, data: { expires_at: new_expires_at } });
});

// ============================================================
// POST /trips/:id/confirm — confirm a reservation
// ============================================================
seatInventoryRouter.post('/trips/:id/confirm', async (c) => {
  const tripId = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['seat_id', 'token']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { seat_id, token, booking_id } = body as { seat_id: string; token: string; booking_id?: string };
  const db = c.env.DB;
  const now = Date.now();

  try {
    const seat = await db.prepare(
      `SELECT * FROM seats WHERE id = ? AND trip_id = ? AND reservation_token = ?`
    ).bind(seat_id, tripId, token).first<DbSeat>();

    if (!seat) return c.json({ success: false, error: 'Invalid token or seat not found' }, 404);
    if (seat.status !== 'reserved') return c.json({ success: false, error: 'Seat is not in reserved state' }, 409);
    if (seat.reservation_expires_at !== null && seat.reservation_expires_at < now) {
      return c.json({ success: false, error: 'Reservation token expired' }, 410);
    }

    await db.prepare(
      `UPDATE seats SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, reservation_token = NULL, updated_at = ?
       WHERE id = ?`
    ).bind(booking_id ?? seat.reserved_by, now, now, seat_id).run();

    return c.json({ success: true, data: { seat_id, trip_id: tripId, status: 'confirmed' } });
  } catch {
    return c.json({ success: false, error: 'Failed to confirm seat' }, 500);
  }
});

// ============================================================
// POST /trips/:id/release — release a reservation (token required)
// SEC-006: token is mandatory to prevent unauthorized seat release
// ============================================================
seatInventoryRouter.post('/trips/:id/release', async (c) => {
  const tripId = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['seat_id', 'token']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { seat_id, token } = body as { seat_id: string; token: string };
  const db = c.env.DB;
  const now = Date.now();

  try {
    const seat = await db.prepare(
      `SELECT id, reservation_token FROM seats WHERE trip_id = ? AND id = ?`
    ).bind(tripId, seat_id).first<{ id: string; reservation_token: string | null }>();

    if (!seat) return c.json({ success: false, error: 'Seat not found' }, 404);
    if (seat.reservation_token !== token) {
      return c.json({ success: false, error: 'Invalid reservation token' }, 403);
    }

    await db.prepare(
      `UPDATE seats SET status = 'available', reserved_by = NULL, reservation_token = NULL,
       reservation_expires_at = NULL, updated_at = ?
       WHERE id = ? AND trip_id = ? AND reservation_token = ?`
    ).bind(now, seat_id, tripId, token).run();

    return c.json({ success: true, data: { seat_id, trip_id: tripId, status: 'available' } });
  } catch {
    return c.json({ success: false, error: 'Failed to release seat' }, 500);
  }
});

// ============================================================
// PATCH /trips/:tripId/seats/:seatId — update seat status
// (Used by SyncEngine for offline seat mutations)
// ============================================================
seatInventoryRouter.patch('/trips/:tripId/seats/:seatId', async (c) => {
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
      `SELECT * FROM seats WHERE id = ? AND trip_id = ?`
    ).bind(seatId, tripId).first<DbSeat>();

    if (!seat) return c.json({ success: false, error: 'Seat not found' }, 404);

    await db.prepare(
      `UPDATE seats
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
        `INSERT OR REPLACE INTO sync_mutations (id, entity_type, entity_id, action, payload, version, status, retry_count, created_at, synced_at)
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

// Keep for backwards compat — other API files re-export from ./types
export type { DbTrip, DbSeat };
