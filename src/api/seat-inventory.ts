/**
 * TRN-1: Seat Inventory API
 * Atomic seat reservation with 30-second TTL tokens
 * Invariants: Nigeria-First (kobo), Offline-First (sync), Multi-tenancy
 */
import { Hono } from 'hono';
import type { AppContext, DbTrip, DbSeat } from './types';
import { genId, parsePagination, metaResponse, requireFields, applyTenantScope } from './types';

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
    await db.prepare(
      `INSERT INTO trips (id, operator_id, route_id, vehicle_id, departure_time, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`
    ).bind(id, operator_id, route_id, vehicle_id, departure_time, now, now).run();

    const seatStmt = db.prepare(
      `INSERT INTO seats (id, trip_id, seat_number, status, version, created_at, updated_at) VALUES (?, ?, ?, 'available', 0, ?, ?)`
    );
    const seatBatch = Array.from({ length: total_seats }, (_, i) =>
      seatStmt.bind(`${id}_s${i + 1}`, id, String(i + 1).padStart(2, '0'), now, now)
    );
    await db.batch(seatBatch);

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
// POST /trips/:id/reserve — atomic seat reservation (30s TTL)
// ============================================================
seatInventoryRouter.post('/trips/:id/reserve', async (c) => {
  const tripId = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['seat_id', 'user_id']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { seat_id, user_id } = body as { seat_id: string; user_id: string };
  const db = c.env.DB;
  const now = Date.now();
  const expiresAt = now + 30_000;
  const token = genId('tok');

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
      data: { seat_id, trip_id: tripId, token, expires_at: expiresAt, ttl_seconds: 30 },
    }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to reserve seat' }, 500);
  }
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
