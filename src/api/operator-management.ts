/**
 * TRN-4: Operator Management API
 * Trip state machine, operator CRUD, route and vehicle management
 * Invariants: Multi-tenancy (operator_id), Nigeria-First, Build Once Use Infinitely
 */
import { Hono } from 'hono';
import { requireRole } from '@webwaka/core';
import type { Env } from './seat-inventory';

export const operatorManagementRouter = new Hono<{ Bindings: Env }>();

// ============================================================
// OPERATORS
// ============================================================

// GET /operators — list all operators
operatorManagementRouter.get('/operators', async (c) => {
  const { status } = c.req.query();
  const db = c.env.DB;

  let query = `SELECT * FROM operators WHERE deleted_at IS NULL`;
  const params: unknown[] = [];
  if (status) { query += ` AND status = ?`; params.push(status); }
  query += ` ORDER BY name ASC`;

  const result = await db.prepare(query).bind(...params).all();
  return c.json({ success: true, data: result.results });
});

// POST /operators — register an operator
operatorManagementRouter.post('/operators', requireRole(['SUPER_ADMIN']), async (c) => {
  const body = await c.req.json() as any;
  const { name, code, phone, email } = body;

  if (!name || !code) {
    return c.json({ success: false, error: 'name and code required' }, 400);
  }

  const db = c.env.DB;
  const id = `opr_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();

  try {
    await db.prepare(
      `INSERT INTO operators (id, name, code, phone, email, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(id, name, code, phone ?? null, email ?? null, now, now).run();
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) {
      return c.json({ success: false, error: 'Operator code already exists' }, 409);
    }
    throw e;
  }

  return c.json({ success: true, data: { id, name, code, status: 'active' } }, 201);
});

// PATCH /operators/:id — update operator status
operatorManagementRouter.patch('/operators/:id', requireRole(['SUPER_ADMIN']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as any;
  const { status, name, phone, email } = body;

  const db = c.env.DB;
  const now = Date.now();

  const op = await db.prepare(`SELECT * FROM operators WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
  if (!op) return c.json({ success: false, error: 'Operator not found' }, 404);

  await db.prepare(
    `UPDATE operators SET name = COALESCE(?, name), phone = COALESCE(?, phone),
     email = COALESCE(?, email), status = COALESCE(?, status), updated_at = ? WHERE id = ?`
  ).bind(name ?? null, phone ?? null, email ?? null, status ?? null, now, id).run();

  return c.json({ success: true, data: { id, status: status ?? (op as any).status } });
});

// ============================================================
// ROUTES
// ============================================================

// GET /routes — list routes
operatorManagementRouter.get('/routes', async (c) => {
  const { operator_id } = c.req.query();
  const db = c.env.DB;

  let query = `SELECT r.*, o.name as operator_name FROM routes r
    JOIN operators o ON r.operator_id = o.id
    WHERE r.deleted_at IS NULL`;
  const params: unknown[] = [];
  if (operator_id) { query += ` AND r.operator_id = ?`; params.push(operator_id); }
  query += ` ORDER BY r.origin, r.destination`;

  const result = await db.prepare(query).bind(...params).all();
  return c.json({ success: true, data: result.results });
});

// POST /routes — create a route
operatorManagementRouter.post('/routes', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const body = await c.req.json() as any;
  const { operator_id, origin, destination, distance_km, duration_minutes, base_fare } = body;

  if (!operator_id || !origin || !destination || !base_fare) {
    return c.json({ success: false, error: 'operator_id, origin, destination, base_fare required' }, 400);
  }
  if (!Number.isInteger(base_fare) || base_fare <= 0) {
    return c.json({ success: false, error: 'base_fare must be a positive integer (kobo)' }, 400);
  }

  const db = c.env.DB;
  const id = `rte_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();

  await db.prepare(
    `INSERT INTO routes (id, operator_id, origin, destination, distance_km, duration_minutes, base_fare, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
  ).bind(id, operator_id, origin, destination, distance_km ?? null, duration_minutes ?? null, base_fare, now, now).run();

  return c.json({ success: true, data: { id, operator_id, origin, destination, base_fare, status: 'active' } }, 201);
});

// ============================================================
// VEHICLES
// ============================================================

// GET /vehicles — list vehicles
operatorManagementRouter.get('/vehicles', async (c) => {
  const { operator_id, status } = c.req.query();
  const db = c.env.DB;

  let query = `SELECT * FROM vehicles WHERE deleted_at IS NULL`;
  const params: unknown[] = [];
  if (operator_id) { query += ` AND operator_id = ?`; params.push(operator_id); }
  if (status) { query += ` AND status = ?`; params.push(status); }
  query += ` ORDER BY plate_number ASC`;

  const result = await db.prepare(query).bind(...params).all();
  return c.json({ success: true, data: result.results });
});

// POST /vehicles — register a vehicle
operatorManagementRouter.post('/vehicles', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const body = await c.req.json() as any;
  const { operator_id, plate_number, vehicle_type, total_seats, model } = body;

  if (!operator_id || !plate_number || !vehicle_type || !total_seats) {
    return c.json({ success: false, error: 'operator_id, plate_number, vehicle_type, total_seats required' }, 400);
  }

  const db = c.env.DB;
  const id = `veh_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  const now = Date.now();

  try {
    await db.prepare(
      `INSERT INTO vehicles (id, operator_id, plate_number, vehicle_type, model, total_seats, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(id, operator_id, plate_number, vehicle_type, model ?? null, total_seats, now, now).run();
  } catch (e: any) {
    if (e.message?.includes('UNIQUE')) {
      return c.json({ success: false, error: 'Plate number already registered' }, 409);
    }
    throw e;
  }

  return c.json({ success: true, data: { id, operator_id, plate_number, vehicle_type, model: model ?? null, total_seats, status: 'active' } }, 201);
});

// ============================================================
// TRIP STATE MACHINE (TRN-4)
// ============================================================

// GET /trips — list trips for operator dashboard
operatorManagementRouter.get('/trips', async (c) => {
  const { operator_id, state } = c.req.query();
  const db = c.env.DB;

  let query = `SELECT t.*, r.origin, r.destination, r.base_fare FROM trips t
    JOIN routes r ON t.route_id = r.id
    WHERE t.deleted_at IS NULL`;
  const params: unknown[] = [];
  if (operator_id) { query += ` AND t.operator_id = ?`; params.push(operator_id); }
  if (state) { query += ` AND t.state = ?`; params.push(state); }
  query += ` ORDER BY t.departure_time DESC LIMIT 100`;

  const result = await db.prepare(query).bind(...params).all();
  return c.json({ success: true, data: result.results });
});

// GET /trips/:id/state — get current trip state
operatorManagementRouter.get('/trips/:id/state', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  const trip = await db.prepare(
    `SELECT t.*, r.origin, r.destination FROM trips t JOIN routes r ON t.route_id = r.id WHERE t.id = ?`
  ).bind(id).first() as any;
  if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

  const transitions = await db.prepare(
    `SELECT * FROM trip_state_transitions WHERE trip_id = ? ORDER BY transitioned_at ASC`
  ).bind(id).all();

  return c.json({ success: true, data: { ...trip, transitions: transitions.results } });
});

// POST /trips/:id/transition — advance trip state
operatorManagementRouter.post('/trips/:id/transition', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as any;
  const { to_state, reason } = body;

  const VALID_TRANSITIONS: Record<string, string[]> = {
    scheduled: ['boarding', 'cancelled'],
    boarding: ['in_transit', 'cancelled'],
    in_transit: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
  };

  const db = c.env.DB;
  const now = Date.now();

  const trip = await db.prepare(`SELECT * FROM trips WHERE id = ? AND deleted_at IS NULL`).bind(id).first() as any;
  if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

  const allowed = VALID_TRANSITIONS[trip.state] ?? [];
  if (!allowed.includes(to_state)) {
    return c.json({
      success: false,
      error: `Invalid transition: ${trip.state} → ${to_state}. Allowed: ${allowed.join(', ') || 'none'}`,
    }, 422);
  }

  // Record transition
  const transitionId = `tst_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`;
  await db.batch([
    db.prepare(`UPDATE trips SET state = ?, updated_at = ? WHERE id = ?`).bind(to_state, now, id),
    db.prepare(
      `INSERT INTO trip_state_transitions (id, trip_id, from_state, to_state, reason, transitioned_at)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(transitionId, id, trip.state, to_state, reason ?? null, now),
  ]);

  return c.json({ success: true, data: { id, from_state: trip.state, to_state, transitioned_at: now } });
});

// PATCH /trips/:id/location — update GPS location
operatorManagementRouter.patch('/trips/:id/location', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as any;
  const { latitude, longitude } = body;

  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return c.json({ success: false, error: 'latitude and longitude required as numbers' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  await db.prepare(
    `UPDATE trips SET current_latitude = ?, current_longitude = ?, updated_at = ? WHERE id = ?`
  ).bind(latitude, longitude, now, id).run();

  return c.json({ success: true, data: { id, latitude, longitude, updated_at: now } });
});

// GET /dashboard — operator dashboard
operatorManagementRouter.get('/dashboard', async (c) => {
  const { operator_id } = c.req.query();
  const db = c.env.DB;

  const params: unknown[] = [];
  let tripQuery = `SELECT state, COUNT(*) as count FROM trips WHERE deleted_at IS NULL`;
  if (operator_id) { tripQuery += ` AND operator_id = ?`; params.push(operator_id); }
  tripQuery += ` GROUP BY state`;

  const todayStart = new Date();
  todayStart.setHours(0, 0, 0, 0);
  const todayStartMs = todayStart.getTime();

  const revenueParams: unknown[] = [todayStartMs];
  let revenueQuery = `SELECT COALESCE(SUM(total_amount), 0) as total FROM sales_transactions
    WHERE payment_status = 'completed' AND created_at >= ?`;
  if (operator_id) {
    revenueQuery += ` AND agent_id IN (SELECT id FROM agents WHERE operator_id = ? AND deleted_at IS NULL)`;
    revenueParams.push(operator_id);
  }

  const [tripStats, revenueResult] = await Promise.all([
    db.prepare(tripQuery).bind(...params).all(),
    db.prepare(revenueQuery).bind(...revenueParams).first(),
  ]);

  const stats = (tripStats.results as any[]).reduce((acc: any, r: any) => {
    acc[r.state] = r.count;
    return acc;
  }, {});

  return c.json({
    success: true,
    data: {
      trips: {
        scheduled: stats.scheduled ?? 0,
        boarding: stats.boarding ?? 0,
        in_transit: stats.in_transit ?? 0,
        completed: stats.completed ?? 0,
        cancelled: stats.cancelled ?? 0,
      },
      today_revenue_kobo: (revenueResult as any)?.total ?? 0,
    },
  });
});
