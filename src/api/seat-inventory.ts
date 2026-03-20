/**
 * TRN-1: Seat Inventory API
 * Atomic seat reservation with 30-second TTL tokens
 * Invariants: Nigeria-First (kobo), Offline-First (sync), Multi-tenancy
 */
import { Hono } from 'hono';

export interface Env {
  DB: D1Database;
}

export const seatInventoryRouter = new Hono<{ Bindings: Env }>();

function nanoid(): string {
  return `seat_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

function tripId(): string {
  return `trp_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
}

// GET /trips — list trips with availability
seatInventoryRouter.get('/trips', async (c) => {
  const { origin, destination, date } = c.req.query();
  const db = c.env.DB;

  let query = `SELECT t.*, r.origin, r.destination, r.base_fare,
    COUNT(CASE WHEN s.status = 'available' THEN 1 END) as available_seats,
    COUNT(s.id) as total_seats
    FROM trips t
    JOIN routes r ON t.route_id = r.id
    LEFT JOIN seats s ON t.trip_id = s.trip_id
    WHERE t.deleted_at IS NULL AND t.state != 'cancelled'`;

  const params: unknown[] = [];
  if (origin) { query += ` AND r.origin LIKE ?`; params.push(`%${origin}%`); }
  if (destination) { query += ` AND r.destination LIKE ?`; params.push(`%${destination}%`); }
  if (date) {
    const start = new Date(date).setHours(0, 0, 0, 0);
    const end = new Date(date).setHours(23, 59, 59, 999);
    query += ` AND t.departure_time BETWEEN ? AND ?`;
    params.push(start, end);
  }
  query += ` GROUP BY t.id ORDER BY t.departure_time ASC`;

  const result = await db.prepare(query).bind(...params).all();
  return c.json({ success: true, data: result.results });
});

// POST /trips — create a trip
seatInventoryRouter.post('/trips', async (c) => {
  const body = await c.req.json() as any;
  const { operator_id, route_id, vehicle_id, departure_time, total_seats } = body;

  if (!operator_id || !route_id || !vehicle_id || !departure_time || !total_seats) {
    return c.json({ success: false, error: 'operator_id, route_id, vehicle_id, departure_time, total_seats required' }, 400);
  }

  const db = c.env.DB;
  const id = tripId();
  const now = Date.now();

  await db.prepare(
    `INSERT INTO trips (id, operator_id, route_id, vehicle_id, departure_time, state, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`
  ).bind(id, operator_id, route_id, vehicle_id, departure_time, now, now).run();

  // Create seats atomically
  const seatStmt = db.prepare(
    `INSERT INTO seats (id, trip_id, seat_number, status, created_at, updated_at) VALUES (?, ?, ?, 'available', ?, ?)`
  );
  const seatBatch = Array.from({ length: total_seats }, (_, i) =>
    seatStmt.bind(`${id}_s${i + 1}`, id, String(i + 1).padStart(2, '0'), now, now)
  );
  await db.batch(seatBatch);

  return c.json({ success: true, data: { id, operator_id, route_id, total_seats, state: 'scheduled' } }, 201);
});

// GET /trips/:id/availability — seat map
seatInventoryRouter.get('/trips/:id/availability', async (c) => {
  const tripId = c.req.param('id');
  const db = c.env.DB;
  const now = Date.now();

  // Expire stale reservations
  await db.prepare(
    `UPDATE seats SET status = 'available', reserved_by = NULL, reservation_token = NULL, reservation_expires_at = NULL
     WHERE trip_id = ? AND status = 'reserved' AND reservation_expires_at < ?`
  ).bind(tripId, now).run();

  const seats = await db.prepare(
    `SELECT * FROM seats WHERE trip_id = ? ORDER BY seat_number ASC`
  ).bind(tripId).all();

  const counts = seats.results.reduce((acc: any, s: any) => {
    acc[s.status] = (acc[s.status] || 0) + 1;
    return acc;
  }, {});

  return c.json({
    success: true,
    data: {
      trip_id: tripId,
      total_seats: seats.results.length,
      available: counts.available || 0,
      reserved: counts.reserved || 0,
      confirmed: counts.confirmed || 0,
      blocked: counts.blocked || 0,
      seats: seats.results,
    },
  });
});

// POST /trips/:id/reserve — atomic seat reservation (30s TTL)
seatInventoryRouter.post('/trips/:id/reserve', async (c) => {
  const tripId = c.req.param('id');
  const body = await c.req.json() as any;
  const { seat_id, user_id } = body;

  if (!seat_id || !user_id) {
    return c.json({ success: false, error: 'seat_id and user_id required' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const expiresAt = now + 30_000; // 30-second TTL — Nigeria bus park standard
  const token = `tok_${Math.random().toString(36).slice(2, 18)}`;

  // Expire stale reservations first
  await db.prepare(
    `UPDATE seats SET status = 'available', reserved_by = NULL, reservation_token = NULL, reservation_expires_at = NULL
     WHERE id = ? AND status = 'reserved' AND reservation_expires_at < ?`
  ).bind(seat_id, now).run();

  // Check availability
  const seat = await db.prepare(`SELECT * FROM seats WHERE id = ? AND trip_id = ?`).bind(seat_id, tripId).first() as any;
  if (!seat) {
    return c.json({ success: false, error: 'Seat not found' }, 404);
  }
  if (seat.status !== 'available') {
    return c.json({ success: false, error: `Seat is ${seat.status}` }, 409);
  }

  // Atomic reservation
  await db.prepare(
    `UPDATE seats SET status = 'reserved', reserved_by = ?, reservation_token = ?, reservation_expires_at = ?, updated_at = ?
     WHERE id = ? AND status = 'available'`
  ).bind(user_id, token, expiresAt, now, seat_id).run();

  return c.json({
    success: true,
    data: { seat_id, trip_id: tripId, token, expires_at: expiresAt, ttl_seconds: 30 },
  }, 201);
});

// POST /trips/:id/confirm — confirm a reservation
seatInventoryRouter.post('/trips/:id/confirm', async (c) => {
  const tripId = c.req.param('id');
  const body = await c.req.json() as any;
  const { seat_id, token, booking_id } = body;

  if (!seat_id || !token) {
    return c.json({ success: false, error: 'seat_id and token required' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  const seat = await db.prepare(
    `SELECT * FROM seats WHERE id = ? AND trip_id = ? AND reservation_token = ?`
  ).bind(seat_id, tripId, token).first() as any;

  if (!seat) {
    return c.json({ success: false, error: 'Invalid token or seat not found' }, 404);
  }
  if (seat.status !== 'reserved') {
    return c.json({ success: false, error: 'Seat is not in reserved state' }, 409);
  }
  if (seat.reservation_expires_at < now) {
    return c.json({ success: false, error: 'Reservation token expired' }, 410);
  }

  await db.prepare(
    `UPDATE seats SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, reservation_token = NULL, updated_at = ?
     WHERE id = ?`
  ).bind(booking_id ?? seat.reserved_by, now, now, seat_id).run();

  return c.json({ success: true, data: { seat_id, trip_id: tripId, status: 'confirmed' } });
});

// POST /trips/:id/release — release a reservation
seatInventoryRouter.post('/trips/:id/release', async (c) => {
  const tripId = c.req.param('id');
  const body = await c.req.json() as any;
  const { seat_id, token } = body;

  if (!seat_id) {
    return c.json({ success: false, error: 'seat_id required' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  await db.prepare(
    `UPDATE seats SET status = 'available', reserved_by = NULL, reservation_token = NULL,
     reservation_expires_at = NULL, updated_at = ?
     WHERE id = ? AND trip_id = ? AND (reservation_token = ? OR ? IS NULL)`
  ).bind(now, seat_id, tripId, token ?? null, token ?? null).run();

  return c.json({ success: true, data: { seat_id, trip_id: tripId, status: 'available' } });
});

// POST /sync — Offline-First mutation sync
seatInventoryRouter.post('/sync', async (c) => {
  const body = await c.req.json() as any;
  const { mutations } = body;

  if (!mutations || !Array.isArray(mutations)) {
    return c.json({ success: false, error: 'mutations array required' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const applied: string[] = [];
  const failed: string[] = [];

  for (const mut of mutations) {
    try {
      await db.prepare(
        `INSERT OR REPLACE INTO sync_mutations (id, entity_type, entity_id, action, payload, version, status, retry_count, created_at, synced_at)
         VALUES (?, ?, ?, ?, ?, ?, 'SYNCED', 0, ?, ?)`
      ).bind(
        `mut_${Date.now()}_${Math.random().toString(36).slice(2)}`,
        mut.entity_type, mut.entity_id, mut.action,
        JSON.stringify(mut.payload), mut.version, now, now
      ).run();
      applied.push(mut.entity_id);
    } catch {
      failed.push(mut.entity_id);
    }
  }

  return c.json({ success: true, data: { applied, failed, synced_at: now } });
});
