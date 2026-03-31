/**
 * TRN-4: Operator Management API
 * Trip state machine, operator CRUD, route and vehicle management
 * Invariants: Multi-tenancy (operator_id), Nigeria-First, Build Once Use Infinitely
 */
import { Hono } from 'hono';
import { requireRole, publishEvent } from '@webwaka/core';
import type { AppContext, DbOperator, DbRoute, DbVehicle, DbTrip, DbDriver } from './types';
import { genId, parsePagination, metaResponse, requireFields, applyTenantScope } from './types';

export const operatorManagementRouter = new Hono<AppContext>();

// ============================================================
// OPERATORS
// ============================================================

operatorManagementRouter.get('/operators', async (c) => {
  const q = c.req.query();
  const { status } = q;
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;

  let query = `SELECT * FROM operators WHERE deleted_at IS NULL`;
  const params: unknown[] = [];
  if (status) { query += ` AND status = ?`; params.push(status); }
  query += ` ORDER BY name ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const result = await db.prepare(query).bind(...params).all<DbOperator>();
    return c.json({ success: true, data: result.results, meta: metaResponse(result.results.length, limit, offset) });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch operators' }, 500);
  }
});

operatorManagementRouter.post('/operators', requireRole(['SUPER_ADMIN']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['name', 'code']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { name, code, phone, email } = body as { name: string; code: string; phone?: string; email?: string };
  const db = c.env.DB;
  const id = genId('opr');
  const now = Date.now();

  try {
    await db.prepare(
      `INSERT INTO operators (id, name, code, phone, email, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(id, name, code, phone ?? null, email ?? null, now, now).run();

    return c.json({ success: true, data: { id, name, code, status: 'active' } }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('UNIQUE')) return c.json({ success: false, error: 'Operator code already exists' }, 409);
    return c.json({ success: false, error: 'Failed to create operator' }, 500);
  }
});

operatorManagementRouter.patch('/operators/:id', requireRole(['SUPER_ADMIN']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const { status, name, phone, email } = body as {
    status?: string; name?: string; phone?: string; email?: string;
  };

  const db = c.env.DB;
  const now = Date.now();

  try {
    const op = await db.prepare(
      `SELECT * FROM operators WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<DbOperator>();
    if (!op) return c.json({ success: false, error: 'Operator not found' }, 404);

    await db.prepare(
      `UPDATE operators SET name = COALESCE(?, name), phone = COALESCE(?, phone),
       email = COALESCE(?, email), status = COALESCE(?, status), updated_at = ? WHERE id = ?`
    ).bind(name ?? null, phone ?? null, email ?? null, status ?? null, now, id).run();

    return c.json({ success: true, data: { id, status: status ?? op.status } });
  } catch {
    return c.json({ success: false, error: 'Failed to update operator' }, 500);
  }
});

// ============================================================
// ROUTES
// ============================================================

operatorManagementRouter.get('/routes', async (c) => {
  const q = c.req.query();
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;

  let query = `SELECT r.*, o.name as operator_name FROM routes r
    JOIN operators o ON r.operator_id = o.id
    WHERE r.deleted_at IS NULL`;
  const params: unknown[] = [];

  const scoped = applyTenantScope(c, query, params, 'r.');
  query = scoped.query;
  params.splice(0, params.length, ...scoped.params);

  query += ` ORDER BY r.origin, r.destination LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const result = await db.prepare(query).bind(...params).all<DbRoute>();
    return c.json({ success: true, data: result.results, meta: metaResponse(result.results.length, limit, offset) });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch routes' }, 500);
  }
});

operatorManagementRouter.post('/routes', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['operator_id', 'origin', 'destination', 'base_fare']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { operator_id, origin, destination, distance_km, duration_minutes, base_fare } = body as {
    operator_id: string; origin: string; destination: string;
    distance_km?: number; duration_minutes?: number; base_fare: number;
  };

  if (!Number.isInteger(base_fare) || base_fare <= 0) {
    return c.json({ success: false, error: 'base_fare must be a positive integer (kobo)' }, 400);
  }

  const db = c.env.DB;
  const id = genId('rte');
  const now = Date.now();

  try {
    await db.prepare(
      `INSERT INTO routes (id, operator_id, origin, destination, distance_km, duration_minutes, base_fare, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(id, operator_id, origin, destination, distance_km ?? null, duration_minutes ?? null, base_fare, now, now).run();

    return c.json({ success: true, data: { id, operator_id, origin, destination, base_fare, status: 'active' } }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to create route' }, 500);
  }
});

operatorManagementRouter.patch('/routes/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const db = c.env.DB;
  const now = Date.now();

  try {
    const route = await db.prepare(
      `SELECT * FROM routes WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<DbRoute>();
    if (!route) return c.json({ success: false, error: 'Route not found' }, 404);

    const { origin, destination, distance_km, duration_minutes, base_fare, status } = body as {
      origin?: string; destination?: string; distance_km?: number;
      duration_minutes?: number; base_fare?: number; status?: string;
    };

    if (base_fare !== undefined && (!Number.isInteger(base_fare) || base_fare <= 0)) {
      return c.json({ success: false, error: 'base_fare must be a positive integer (kobo)' }, 400);
    }

    await db.prepare(
      `UPDATE routes
       SET origin = COALESCE(?, origin),
           destination = COALESCE(?, destination),
           distance_km = COALESCE(?, distance_km),
           duration_minutes = COALESCE(?, duration_minutes),
           base_fare = COALESCE(?, base_fare),
           status = COALESCE(?, status),
           updated_at = ?
       WHERE id = ?`
    ).bind(
      origin ?? null, destination ?? null, distance_km ?? null,
      duration_minutes ?? null, base_fare ?? null, status ?? null, now, id
    ).run();

    return c.json({ success: true, data: { id, updated_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to update route' }, 500);
  }
});

// ============================================================
// VEHICLES
// ============================================================

operatorManagementRouter.get('/vehicles', async (c) => {
  const q = c.req.query();
  const { status } = q;
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;

  let query = `SELECT * FROM vehicles WHERE deleted_at IS NULL`;
  const params: unknown[] = [];

  const scoped = applyTenantScope(c, query, params);
  query = scoped.query;
  params.splice(0, params.length, ...scoped.params);

  if (status) { query += ` AND status = ?`; params.push(status); }
  query += ` ORDER BY plate_number ASC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const result = await db.prepare(query).bind(...params).all<DbVehicle>();
    return c.json({ success: true, data: result.results, meta: metaResponse(result.results.length, limit, offset) });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch vehicles' }, 500);
  }
});

operatorManagementRouter.post('/vehicles', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['operator_id', 'plate_number', 'vehicle_type', 'total_seats']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { operator_id, plate_number, vehicle_type, total_seats, model } = body as {
    operator_id: string; plate_number: string; vehicle_type: string; total_seats: number; model?: string;
  };

  const db = c.env.DB;
  const id = genId('veh');
  const now = Date.now();

  try {
    await db.prepare(
      `INSERT INTO vehicles (id, operator_id, plate_number, vehicle_type, model, total_seats, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
    ).bind(id, operator_id, plate_number, vehicle_type, model ?? null, total_seats, now, now).run();

    return c.json({ success: true, data: { id, operator_id, plate_number, vehicle_type, model: model ?? null, total_seats, status: 'active' } }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('UNIQUE')) return c.json({ success: false, error: 'Plate number already registered' }, 409);
    return c.json({ success: false, error: 'Failed to register vehicle' }, 500);
  }
});

operatorManagementRouter.patch('/vehicles/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const db = c.env.DB;
  const now = Date.now();

  try {
    const vehicle = await db.prepare(
      `SELECT * FROM vehicles WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<DbVehicle>();
    if (!vehicle) return c.json({ success: false, error: 'Vehicle not found' }, 404);

    const { plate_number, vehicle_type, model, total_seats, status } = body as {
      plate_number?: string; vehicle_type?: string; model?: string; total_seats?: number; status?: string;
    };

    await db.prepare(
      `UPDATE vehicles
       SET plate_number = COALESCE(?, plate_number),
           vehicle_type = COALESCE(?, vehicle_type),
           model = COALESCE(?, model),
           total_seats = COALESCE(?, total_seats),
           status = COALESCE(?, status),
           updated_at = ?
       WHERE id = ?`
    ).bind(plate_number ?? null, vehicle_type ?? null, model ?? null, total_seats ?? null, status ?? null, now, id).run();

    return c.json({ success: true, data: { id, updated_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to update vehicle' }, 500);
  }
});

// ============================================================
// TRIP STATE MACHINE (TRN-4)
// ============================================================

operatorManagementRouter.get('/trips', async (c) => {
  const q = c.req.query();
  const { state } = q;
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;

  let query = `SELECT t.*, r.origin, r.destination, r.base_fare FROM trips t
    JOIN routes r ON t.route_id = r.id
    WHERE t.deleted_at IS NULL`;
  const params: unknown[] = [];

  const scoped = applyTenantScope(c, query, params, 't.');
  query = scoped.query;
  params.splice(0, params.length, ...scoped.params);

  if (state) { query += ` AND t.state = ?`; params.push(state); }
  query += ` ORDER BY t.departure_time DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const result = await db.prepare(query).bind(...params).all<DbTrip>();
    return c.json({ success: true, data: result.results, meta: metaResponse(result.results.length, limit, offset) });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch trips' }, 500);
  }
});

// ============================================================
// POST /trips — create a new scheduled trip with seats
// ============================================================
operatorManagementRouter.post('/trips', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const err = requireFields(body, ['route_id', 'vehicle_id', 'departure_time']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { route_id, vehicle_id, departure_time, base_fare: fareOverride, total_seats: seatsOverride } = body as {
    route_id: string; vehicle_id: string; departure_time: number;
    base_fare?: number; total_seats?: number;
  };

  if (!Number.isInteger(departure_time) || departure_time <= 0) {
    return c.json({ success: false, error: 'departure_time must be a positive integer (unix ms)' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  try {
    const route = await db.prepare(
      'SELECT id, operator_id, origin, destination, base_fare FROM routes WHERE id = ? AND deleted_at IS NULL'
    ).bind(route_id).first<{ id: string; operator_id: string; origin: string; destination: string; base_fare: number }>();
    if (!route) return c.json({ success: false, error: 'Route not found' }, 404);

    const vehicle = await db.prepare(
      'SELECT id, total_seats FROM vehicles WHERE id = ? AND deleted_at IS NULL'
    ).bind(vehicle_id).first<{ id: string; total_seats: number }>();
    if (!vehicle) return c.json({ success: false, error: 'Vehicle not found' }, 404);

    const operator_id = route.operator_id;
    const total_seats = typeof seatsOverride === 'number' && seatsOverride > 0 ? seatsOverride : vehicle.total_seats;

    const id = genId('trp');

    await db.prepare(
      `INSERT INTO trips (id, operator_id, route_id, vehicle_id, departure_time, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'scheduled', ?, ?)`
    ).bind(id, operator_id, route_id, vehicle_id, departure_time, now, now).run();

    const seatBatch = Array.from({ length: total_seats }, (_, i) =>
      db.prepare(
        `INSERT INTO seats (id, trip_id, seat_number, status, version, created_at, updated_at) VALUES (?, ?, ?, 'available', 0, ?, ?)`
      ).bind(`${id}_s${i + 1}`, id, String(i + 1).padStart(2, '0'), now, now)
    );
    await db.batch(seatBatch);

    return c.json({ success: true, data: {
      id, operator_id, route_id, vehicle_id, state: 'scheduled',
      departure_time, total_seats, base_fare: fareOverride ?? route.base_fare,
      origin: route.origin, destination: route.destination,
    } }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to create trip' }, 500);
  }
});

operatorManagementRouter.patch('/trips/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const db = c.env.DB;
  const now = Date.now();

  const IMMUTABLE_STATES = ['in_transit', 'completed', 'cancelled'];

  try {
    const trip = await db.prepare(
      `SELECT * FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<DbTrip>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    if (IMMUTABLE_STATES.includes(trip.state)) {
      return c.json({
        success: false,
        error: `Cannot modify a trip in '${trip.state}' state`,
      }, 409);
    }

    const { vehicle_id, departure_time, driver_id } = body as {
      vehicle_id?: string; departure_time?: number; driver_id?: string | null;
    };

    await db.prepare(
      `UPDATE trips
       SET vehicle_id = COALESCE(?, vehicle_id),
           departure_time = COALESCE(?, departure_time),
           driver_id = COALESCE(?, driver_id),
           updated_at = ?
       WHERE id = ?`
    ).bind(vehicle_id ?? null, departure_time ?? null, driver_id ?? null, now, id).run();

    return c.json({ success: true, data: { id, updated_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to update trip' }, 500);
  }
});

// ============================================================
// POST /trips/:id/copy — duplicate a trip to a new departure time
// ============================================================
operatorManagementRouter.post('/trips/:id/copy', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const sourceId = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const { departure_time } = body as { departure_time?: unknown };
  if (typeof departure_time !== 'number' || !Number.isInteger(departure_time) || departure_time <= 0) {
    return c.json({ success: false, error: 'departure_time is required (positive integer unix ms)' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  try {
    const source = await db.prepare(
      `SELECT * FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(sourceId).first<DbTrip>();
    if (!source) return c.json({ success: false, error: 'Source trip not found' }, 404);

    const seatCount = await db.prepare(
      `SELECT COUNT(*) as cnt FROM seats WHERE trip_id = ? AND deleted_at IS NULL`
    ).bind(sourceId).first<{ cnt: number }>();
    const total_seats = seatCount?.cnt ?? 0;

    const newId = genId('trp');
    await db.prepare(
      `INSERT INTO trips (id, operator_id, route_id, vehicle_id, driver_id, departure_time, state, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'scheduled', ?, ?)`
    ).bind(newId, source.operator_id, source.route_id, source.vehicle_id, source.driver_id ?? null, departure_time, now, now).run();

    if (total_seats > 0) {
      const seatBatch = Array.from({ length: total_seats }, (_, i) =>
        db.prepare(
          `INSERT INTO seats (id, trip_id, seat_number, status, version, created_at, updated_at) VALUES (?, ?, ?, 'available', 0, ?, ?)`
        ).bind(`${newId}_s${i + 1}`, newId, String(i + 1).padStart(2, '0'), now, now)
      );
      await db.batch(seatBatch);
    }

    return c.json({ success: true, data: {
      id: newId,
      operator_id: source.operator_id,
      route_id: source.route_id,
      vehicle_id: source.vehicle_id,
      departure_time,
      state: 'scheduled',
      total_seats,
      copied_from: sourceId,
    } }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to copy trip' }, 500);
  }
});

operatorManagementRouter.delete('/trips/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const now = Date.now();

  try {
    const trip = await db.prepare(
      `SELECT * FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<DbTrip>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    if (trip.state === 'boarding' || trip.state === 'in_transit') {
      return c.json({ success: false, error: `Cannot delete a trip in ${trip.state} state` }, 409);
    }

    await db.prepare(
      `UPDATE trips SET deleted_at = ?, updated_at = ? WHERE id = ?`
    ).bind(now, now, id).run();

    return c.json({ success: true, data: { id, deleted_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to delete trip' }, 500);
  }
});

operatorManagementRouter.get('/trips/:id/state', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    const trip = await db.prepare(
      `SELECT t.*, r.origin, r.destination FROM trips t JOIN routes r ON t.route_id = r.id WHERE t.id = ?`
    ).bind(id).first<DbTrip & { origin: string; destination: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    const transitions = await db.prepare(
      `SELECT * FROM trip_state_transitions WHERE trip_id = ? ORDER BY transitioned_at ASC`
    ).bind(id).all();

    return c.json({ success: true, data: { ...trip, transitions: transitions.results } });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch trip state' }, 500);
  }
});

operatorManagementRouter.post('/trips/:id/transition', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['to_state']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { to_state, reason } = body as { to_state: string; reason?: string };

  const VALID_TRANSITIONS: Record<string, string[]> = {
    scheduled: ['boarding', 'cancelled'],
    boarding: ['in_transit', 'cancelled'],
    in_transit: ['completed', 'cancelled'],
    completed: [],
    cancelled: [],
  };

  const db = c.env.DB;
  const now = Date.now();

  try {
    const trip = await db.prepare(
      `SELECT * FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<DbTrip>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    const allowed = VALID_TRANSITIONS[trip.state] ?? [];
    if (!allowed.includes(to_state)) {
      return c.json({
        success: false,
        error: `Invalid transition: ${trip.state} → ${to_state}. Allowed: ${allowed.join(', ') || 'none'}`,
      }, 422);
    }

    const transitionId = genId('tst');
    await db.batch([
      db.prepare(`UPDATE trips SET state = ?, updated_at = ? WHERE id = ?`).bind(to_state, now, id),
      db.prepare(
        `INSERT INTO trip_state_transitions (id, trip_id, from_state, to_state, reason, transitioned_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).bind(transitionId, id, trip.state, to_state, reason ?? null, now),
    ]);

    try {
      await publishEvent(db, {
        event_type: 'trip.state_changed',
        aggregate_id: id,
        aggregate_type: 'trip',
        payload: { trip_id: id, from_state: trip.state, to_state, reason: reason ?? null, operator_id: trip.operator_id },
        timestamp: now,
      });
    } catch { /* non-fatal */ }

    return c.json({ success: true, data: { id, from_state: trip.state, to_state, transitioned_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to transition trip state' }, 500);
  }
});

operatorManagementRouter.patch('/trips/:id/location', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const { latitude, longitude } = body as { latitude?: unknown; longitude?: unknown };

  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return c.json({ success: false, error: 'latitude and longitude required as numbers' }, 400);
  }
  if (latitude < -90 || latitude > 90) {
    return c.json({ success: false, error: 'latitude must be between -90 and 90' }, 400);
  }
  if (longitude < -180 || longitude > 180) {
    return c.json({ success: false, error: 'longitude must be between -180 and 180' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  try {
    await db.prepare(
      `UPDATE trips SET current_latitude = ?, current_longitude = ?, updated_at = ? WHERE id = ?`
    ).bind(latitude, longitude, now, id).run();

    return c.json({ success: true, data: { id, latitude, longitude, updated_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to update trip location' }, 500);
  }
});

// ============================================================
// GET /trips/:id/manifest — passenger manifest for boarding
// ============================================================
operatorManagementRouter.get('/trips/:id/manifest', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    const trip = await db.prepare(
      `SELECT id, operator_id, route_id, driver_id, state, departure_time FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<{ id: string; operator_id: string; route_id: string; driver_id: string | null; state: string; departure_time: number }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    const [routeRow, bookingsResult, seatsResult, driverRow] = await Promise.all([
      db.prepare(
        `SELECT origin, destination, base_fare FROM routes WHERE id = ?`
      ).bind(trip.route_id).first<{ origin: string; destination: string; base_fare: number }>(),
      db.prepare(
        `SELECT id, customer_id, seat_ids, passenger_names, status, payment_status, total_amount, created_at
         FROM bookings WHERE trip_id = ? AND deleted_at IS NULL AND status != 'cancelled'
         ORDER BY created_at ASC`
      ).bind(id).all<{ id: string; customer_id: string; seat_ids: string; passenger_names: string; status: string; payment_status: string; total_amount: number; created_at: number }>(),
      db.prepare(
        `SELECT id FROM seats WHERE trip_id = ?`
      ).bind(id).all<{ id: string }>(),
      trip.driver_id
        ? db.prepare(`SELECT id, name, phone, license_number FROM drivers WHERE id = ?`)
            .bind(trip.driver_id).first<{ id: string; name: string; phone: string; license_number: string | null }>()
        : Promise.resolve(null),
    ]);

    // Fetch customer details per booking (small list — boarding manifest scenario)
    const passengers = await Promise.all(
      bookingsResult.results.map(async (bkg) => {
        let customer_name = 'Unknown';
        let customer_phone = '';
        try {
          const customer = await db.prepare(
            `SELECT name, phone FROM customers WHERE id = ?`
          ).bind(bkg.customer_id).first<{ name: string; phone: string }>();
          if (customer) { customer_name = customer.name; customer_phone = customer.phone; }
        } catch { /* gracefully skip customer lookup failure */ }

        const seatIds = JSON.parse(bkg.seat_ids) as string[];
        const passengerNames = JSON.parse(bkg.passenger_names) as string[];

        return {
          booking_id: bkg.id,
          customer_name,
          customer_phone,
          seat_ids: seatIds,
          passenger_names: passengerNames,
          status: bkg.status,
          payment_status: bkg.payment_status,
          total_amount: bkg.total_amount,
          booked_at: bkg.created_at,
        };
      })
    );

    const confirmedRevenue = bookingsResult.results
      .filter(b => b.payment_status === 'paid' || b.status === 'confirmed')
      .reduce((sum, b) => sum + b.total_amount, 0);

    return c.json({
      success: true,
      data: {
        trip: {
          id: trip.id,
          state: trip.state,
          departure_time: trip.departure_time,
          origin: routeRow?.origin ?? '',
          destination: routeRow?.destination ?? '',
          base_fare: routeRow?.base_fare ?? 0,
          total_seats: seatsResult.results.length,
          driver: driverRow
            ? { id: driverRow.id, name: driverRow.name, phone: driverRow.phone, license_number: driverRow.license_number }
            : null,
        },
        passengers,
        summary: {
          total_bookings: passengers.length,
          total_seats: seatsResult.results.length,
          load_factor: seatsResult.results.length > 0
            ? Math.round((passengers.length / seatsResult.results.length) * 100)
            : 0,
          confirmed_revenue_kobo: confirmedRevenue,
        },
      },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch trip manifest' }, 500);
  }
});

// ============================================================
// Driver Management — TRN-4
// ============================================================

operatorManagementRouter.post('/drivers', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const body = await c.req.json<Record<string, unknown>>();
  const db = c.env.DB;
  const now = Date.now();

  const missingErr = requireFields(body, ['operator_id', 'name', 'phone']);
  if (missingErr) return c.json({ success: false, error: missingErr }, 400);

  const { operator_id, name, phone, license_number } = body as {
    operator_id: string; name: string; phone: string; license_number?: string;
  };

  const id = genId('drv');

  try {
    await db.prepare(
      `INSERT INTO drivers (id, operator_id, name, phone, license_number, status, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`
    ).bind(id, operator_id, name, phone, license_number ?? null, now, now).run();

    return c.json({ success: true, data: { id, operator_id, name, phone, license_number: license_number ?? null, status: 'active', created_at: now } }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to create driver' }, 500);
  }
});

operatorManagementRouter.get('/drivers', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const q = c.req.query();
  const db = c.env.DB;
  const { limit, offset } = parsePagination(q);

  let query = `SELECT * FROM drivers WHERE deleted_at IS NULL`;
  const params: unknown[] = [];

  const scoped = applyTenantScope(c, query, params);
  query = scoped.query;
  const scopedParams = scoped.params;

  if (q['operator_id'] && !scopedParams.includes(q['operator_id'])) {
    query += ` AND operator_id = ?`;
    scopedParams.push(q['operator_id']);
  }
  if (q['status']) { query += ` AND status = ?`; scopedParams.push(q['status']); }

  query += ` ORDER BY name ASC LIMIT ? OFFSET ?`;
  scopedParams.push(limit, offset);

  try {
    const result = await db.prepare(query).bind(...scopedParams).all<DbDriver>();
    return c.json({ success: true, data: result.results, meta: metaResponse(result.results.length, limit, offset) });
  } catch {
    return c.json({ success: false, error: 'Failed to list drivers' }, 500);
  }
});

operatorManagementRouter.patch('/drivers/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<Record<string, unknown>>();
  const db = c.env.DB;
  const now = Date.now();

  try {
    const driver = await db.prepare(
      `SELECT * FROM drivers WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<DbDriver>();
    if (!driver) return c.json({ success: false, error: 'Driver not found' }, 404);

    const { name, phone, license_number, status } = body as {
      name?: string; phone?: string; license_number?: string; status?: string;
    };

    await db.prepare(
      `UPDATE drivers
       SET name = COALESCE(?, name),
           phone = COALESCE(?, phone),
           license_number = COALESCE(?, license_number),
           status = COALESCE(?, status),
           updated_at = ?
       WHERE id = ?`
    ).bind(name ?? null, phone ?? null, license_number ?? null, status ?? null, now, id).run();

    return c.json({ success: true, data: { id, updated_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to update driver' }, 500);
  }
});

// ============================================================
// GET /reports/revenue — operator revenue analytics
// ============================================================
operatorManagementRouter.get('/reports/revenue', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const q = c.req.query();
  const db = c.env.DB;
  const now = Date.now();
  const todayStart = new Date().setHours(0, 0, 0, 0);

  const fromMs = q['from'] ? parseInt(q['from'], 10) : todayStart;
  const toMs = q['to'] ? parseInt(q['to'], 10) : now;
  const operatorId = q['operator_id'] ?? null;

  // Booking revenue query — parameterized (no string interpolation)
  const bookingBindParams: unknown[] = ['paid', fromMs, toMs];
  let bookingQuery = `SELECT total_amount FROM bookings
    WHERE payment_status = ? AND created_at >= ? AND created_at <= ? AND deleted_at IS NULL`;

  // Agent sales revenue query — parameterized operator scope (SEC-003 fix: no string interpolation)
  const agentBindParams: unknown[] = ['completed', fromMs, toMs];
  let agentQuery = `SELECT total_amount FROM sales_transactions
    WHERE payment_status = ? AND created_at >= ? AND created_at <= ? AND deleted_at IS NULL`;
  if (operatorId) {
    agentQuery += ` AND agent_id IN (SELECT id FROM agents WHERE operator_id = ? AND deleted_at IS NULL)`;
    agentBindParams.push(operatorId);
  }

  // Per-route breakdown — parameterized operator scope
  const routeBindParams: unknown[] = [fromMs, toMs];
  let routeQuery = `SELECT r.id as route_id, r.origin, r.destination,
          COUNT(t.id) as trip_count
   FROM routes r
   LEFT JOIN trips t ON t.route_id = r.id AND t.deleted_at IS NULL
     AND t.departure_time >= ? AND t.departure_time <= ?
   WHERE r.deleted_at IS NULL`;
  if (operatorId) {
    routeQuery += ` AND r.operator_id = ?`;
    routeBindParams.push(operatorId);
  }
  routeQuery += ` GROUP BY r.id, r.origin, r.destination ORDER BY trip_count DESC LIMIT 10`;

  try {
    const [bookingRows, agentRows, routeResult] = await Promise.all([
      db.prepare(bookingQuery).bind(...bookingBindParams).all<{ total_amount: number }>(),
      db.prepare(agentQuery).bind(...agentBindParams).all<{ total_amount: number }>(),
      db.prepare(routeQuery).bind(...routeBindParams).all<{ route_id: string; origin: string; destination: string; trip_count: number }>(),
    ]);

    const bookingRevenue = bookingRows.results.reduce((sum, r) => sum + r.total_amount, 0);
    const agentRevenue = agentRows.results.reduce((sum, r) => sum + r.total_amount, 0);

    return c.json({
      success: true,
      data: {
        period: { from: fromMs, to: toMs },
        total_revenue_kobo: bookingRevenue + agentRevenue,
        booking_revenue_kobo: bookingRevenue,
        agent_sales_revenue_kobo: agentRevenue,
        total_bookings: bookingRows.results.length,
        total_agent_transactions: agentRows.results.length,
        top_routes: routeResult.results,
      },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch revenue report' }, 500);
  }
});

operatorManagementRouter.get('/dashboard', async (c) => {
  const { operator_id } = c.req.query();
  const db = c.env.DB;

  const params: unknown[] = [];
  let tripQuery = `SELECT state, COUNT(*) as count FROM trips WHERE deleted_at IS NULL`;
  if (operator_id) { tripQuery += ` AND operator_id = ?`; params.push(operator_id); }
  tripQuery += ` GROUP BY state`;

  const todayStartMs = new Date().setHours(0, 0, 0, 0);
  const revenueParams: unknown[] = [todayStartMs];
  let revenueQuery = `SELECT COALESCE(SUM(total_amount), 0) as total FROM sales_transactions
    WHERE payment_status = 'completed' AND created_at >= ?`;
  if (operator_id) {
    revenueQuery += ` AND agent_id IN (SELECT id FROM agents WHERE operator_id = ? AND deleted_at IS NULL)`;
    revenueParams.push(operator_id);
  }

  try {
    const [tripStats, revenueResult] = await Promise.all([
      db.prepare(tripQuery).bind(...params).all<{ state: string; count: number }>(),
      db.prepare(revenueQuery).bind(...revenueParams).first<{ total: number }>(),
    ]);

    const stats = tripStats.results.reduce((acc: Record<string, number>, r) => {
      acc[r.state] = r.count;
      return acc;
    }, {});

    return c.json({
      success: true,
      data: {
        trips: {
          scheduled: stats['scheduled'] ?? 0,
          boarding: stats['boarding'] ?? 0,
          in_transit: stats['in_transit'] ?? 0,
          completed: stats['completed'] ?? 0,
          cancelled: stats['cancelled'] ?? 0,
        },
        today_revenue_kobo: revenueResult?.total ?? 0,
      },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch dashboard' }, 500);
  }
});
