/**
 * TRN-4: Operator Management API
 * Trip state machine, operator CRUD, route and vehicle management
 * Invariants: Multi-tenancy (operator_id), Nigeria-First, Build Once Use Infinitely
 */
import { Hono } from 'hono';
import { requireRole, requireTierFeature, publishEvent, nanoid } from '@webwaka/core';
import type { AppContext, HonoCtx, DbOperator, DbRoute, DbVehicle, DbTrip, DbDriver } from './types';
import { genId, parsePagination, metaResponse, requireFields, applyTenantScope } from './types';
import { getOperatorConfig, validateOperatorConfig } from '../lib/operator-config.js';
import { sendSms } from '../lib/sms.js';
import { generateManifestPdf } from '../core/pdf/manifest.js';
import type { ManifestPdfInput } from '../core/pdf/manifest.js';
import { computeEffectiveFare, validateFareRule } from '../core/pricing/engine';
import type { FareRule } from '../core/pricing/engine';

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
// P08-T2: PUT /routes/:id/fare-matrix — set seat-class pricing (TENANT_ADMIN+)
// ============================================================
operatorManagementRouter.put('/routes/:id/fare-matrix', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), requireTierFeature('seat_class_pricing'), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const db = c.env.DB;
  const jwtUser = c.get('user');
  const isSuperAdmin = jwtUser?.role === 'SUPER_ADMIN';

  const { standard, window: win, vip, front, time_multipliers } = body as {
    standard: number; window: number; vip: number; front: number;
    time_multipliers?: {
      peak_hours?: number[]; peak_multiplier?: number;
      peak_days?: number[]; peak_day_multiplier?: number;
    };
  };

  // All class multipliers must be 1.0–5.0
  for (const [key, val] of Object.entries({ standard, window: win, vip, front })) {
    if (typeof val !== 'number' || val < 1.0 || val > 5.0) {
      return c.json({ success: false, error: `${key} multiplier must be a number between 1.0 and 5.0` }, 400);
    }
  }

  try {
    const route = await db.prepare(
      `SELECT id, operator_id FROM routes WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<{ id: string; operator_id: string }>();
    if (!route) return c.json({ success: false, error: 'Route not found' }, 404);
    if (!isSuperAdmin && jwtUser?.operatorId && route.operator_id !== jwtUser.operatorId) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }

    const fareMatrix = { standard, window: win, vip, front, ...(time_multipliers ? { time_multipliers } : {}) };
    await db.prepare(`UPDATE routes SET fare_matrix = ? WHERE id = ?`).bind(JSON.stringify(fareMatrix), id).run();
    return c.json({ success: true, data: { route_id: id, fare_matrix: fareMatrix } });
  } catch {
    return c.json({ success: false, error: 'Failed to update fare matrix' }, 500);
  }
});

// ============================================================
// T-TRN-03: Fare Rules CRUD — dynamic, named surge/peak rules per route
// ============================================================

// GET /routes/:id/fare-rules — list all active fare rules for a route (TENANT_ADMIN+)
operatorManagementRouter.get('/routes/:id/fare-rules', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR']), async (c) => {
  const routeId = c.req.param('id');
  const db = c.env.DB;
  const user = c.get('user');
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';

  const route = await db.prepare(
    `SELECT id, operator_id FROM routes WHERE id = ? AND deleted_at IS NULL`
  ).bind(routeId).first<{ id: string; operator_id: string }>();
  if (!route) return c.json({ success: false, error: 'Route not found' }, 404);
  if (!isSuperAdmin && user?.operatorId && route.operator_id !== user.operatorId) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  const rules = await db.prepare(
    `SELECT * FROM fare_rules WHERE route_id = ? AND deleted_at IS NULL ORDER BY priority DESC, created_at ASC`
  ).bind(routeId).all<FareRule>();
  return c.json({ success: true, data: rules.results });
});

// POST /routes/:id/fare-rules — create a new fare rule (TENANT_ADMIN+)
operatorManagementRouter.post('/routes/:id/fare-rules', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), requireTierFeature('seat_class_pricing'), async (c) => {
  const routeId = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const db = c.env.DB;
  const user = c.get('user');
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const now = Date.now();

  const err = requireFields(body, ['name', 'rule_type', 'base_multiplier']);
  if (err) return c.json({ success: false, error: err }, 400);

  const valErr = validateFareRule(body);
  if (valErr) return c.json({ success: false, error: valErr }, 400);

  const route = await db.prepare(
    `SELECT id, operator_id FROM routes WHERE id = ? AND deleted_at IS NULL`
  ).bind(routeId).first<{ id: string; operator_id: string }>();
  if (!route) return c.json({ success: false, error: 'Route not found' }, 404);
  if (!isSuperAdmin && user?.operatorId && route.operator_id !== user.operatorId) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  const {
    name, rule_type, base_multiplier, priority,
    starts_at, ends_at, days_of_week, hour_from, hour_to, class_multipliers,
  } = body as {
    name: string; rule_type: string; base_multiplier: number; priority?: number;
    starts_at?: number; ends_at?: number; days_of_week?: number[];
    hour_from?: number; hour_to?: number; class_multipliers?: Record<string, number>;
  };

  const id = genId('far');
  const operatorId = isSuperAdmin ? route.operator_id : (user?.operatorId ?? route.operator_id);

  try {
    await db.prepare(
      `INSERT INTO fare_rules (id, operator_id, route_id, name, rule_type, starts_at, ends_at,
         days_of_week, hour_from, hour_to, class_multipliers, base_multiplier, priority,
         is_active, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      id, operatorId, routeId, name, rule_type,
      starts_at ?? null, ends_at ?? null,
      days_of_week ? JSON.stringify(days_of_week) : null,
      hour_from ?? null, hour_to ?? null,
      class_multipliers ? JSON.stringify(class_multipliers) : null,
      base_multiplier, priority ?? 0,
      1, now, now, null
    ).run();

    const created = await db.prepare(`SELECT * FROM fare_rules WHERE id = ?`).bind(id).first<FareRule>();
    return c.json({ success: true, data: created }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to create fare rule' }, 500);
  }
});

// PUT /routes/:id/fare-rules/:ruleId — update a fare rule (TENANT_ADMIN+)
operatorManagementRouter.put('/routes/:id/fare-rules/:ruleId', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), requireTierFeature('seat_class_pricing'), async (c) => {
  const routeId = c.req.param('id');
  const ruleId = c.req.param('ruleId');
  const body = await c.req.json() as Record<string, unknown>;
  const db = c.env.DB;
  const user = c.get('user');
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const now = Date.now();

  const rule = await db.prepare(
    `SELECT * FROM fare_rules WHERE id = ? AND deleted_at IS NULL`
  ).bind(ruleId).first<FareRule>();
  if (!rule || rule.route_id !== routeId) return c.json({ success: false, error: 'Fare rule not found' }, 404);
  if (!isSuperAdmin && user?.operatorId && rule.operator_id !== user.operatorId) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  if (Object.keys(body).some(k => ['rule_type', 'base_multiplier'].includes(k))) {
    const valErr = validateFareRule({ ...rule, ...body });
    if (valErr) return c.json({ success: false, error: valErr }, 400);
  }

  const {
    name, rule_type, base_multiplier, priority, is_active,
    starts_at, ends_at, days_of_week, hour_from, hour_to, class_multipliers,
  } = body as {
    name?: string; rule_type?: string; base_multiplier?: number; priority?: number; is_active?: number;
    starts_at?: number | null; ends_at?: number | null; days_of_week?: number[] | null;
    hour_from?: number | null; hour_to?: number | null; class_multipliers?: Record<string, number> | null;
  };

  try {
    await db.prepare(
      `UPDATE fare_rules SET
         name = COALESCE(?, name),
         rule_type = COALESCE(?, rule_type),
         base_multiplier = COALESCE(?, base_multiplier),
         priority = COALESCE(?, priority),
         is_active = COALESCE(?, is_active),
         starts_at = ?,
         ends_at = ?,
         days_of_week = ?,
         hour_from = ?,
         hour_to = ?,
         class_multipliers = ?,
         updated_at = ?
       WHERE id = ?`
    ).bind(
      name ?? null, rule_type ?? null, base_multiplier ?? null, priority ?? null, is_active ?? null,
      starts_at !== undefined ? starts_at : rule.starts_at,
      ends_at !== undefined ? ends_at : rule.ends_at,
      days_of_week !== undefined ? (days_of_week ? JSON.stringify(days_of_week) : null) : rule.days_of_week,
      hour_from !== undefined ? hour_from : rule.hour_from,
      hour_to !== undefined ? hour_to : rule.hour_to,
      class_multipliers !== undefined ? (class_multipliers ? JSON.stringify(class_multipliers) : null) : rule.class_multipliers,
      now, ruleId
    ).run();

    const updated = await db.prepare(`SELECT * FROM fare_rules WHERE id = ?`).bind(ruleId).first<FareRule>();
    return c.json({ success: true, data: updated });
  } catch {
    return c.json({ success: false, error: 'Failed to update fare rule' }, 500);
  }
});

// DELETE /routes/:id/fare-rules/:ruleId — soft-delete a fare rule (TENANT_ADMIN+)
operatorManagementRouter.delete('/routes/:id/fare-rules/:ruleId', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const routeId = c.req.param('id');
  const ruleId = c.req.param('ruleId');
  const db = c.env.DB;
  const user = c.get('user');
  const isSuperAdmin = user?.role === 'SUPER_ADMIN';
  const now = Date.now();

  const rule = await db.prepare(
    `SELECT id, operator_id, route_id FROM fare_rules WHERE id = ? AND deleted_at IS NULL`
  ).bind(ruleId).first<{ id: string; operator_id: string; route_id: string }>();
  if (!rule || rule.route_id !== routeId) return c.json({ success: false, error: 'Fare rule not found' }, 404);
  if (!isSuperAdmin && user?.operatorId && rule.operator_id !== user.operatorId) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  try {
    await db.prepare(
      `UPDATE fare_rules SET is_active = ?, deleted_at = ?, updated_at = ? WHERE id = ?`
    ).bind(0, now, now, ruleId).run();
    return c.json({ success: true, data: { id: ruleId, deleted_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to delete fare rule' }, 500);
  }
});

// ============================================================
// T-TRN-03: Preview endpoint — compute effective fare for a route at given time
// GET /routes/:id/effective-fare?ref_time=<ms> — public preview (STAFF+)
// ============================================================
operatorManagementRouter.get('/routes/:id/effective-fare', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR', 'STAFF']), async (c) => {
  const routeId = c.req.param('id');
  const refTimeStr = c.req.query('ref_time');
  const refTimeMs = refTimeStr ? Number(refTimeStr) : Date.now();
  const db = c.env.DB;

  const route = await db.prepare(
    `SELECT id, base_fare FROM routes WHERE id = ? AND deleted_at IS NULL`
  ).bind(routeId).first<{ id: string; base_fare: number }>();
  if (!route) return c.json({ success: false, error: 'Route not found' }, 404);

  const rules = await db.prepare(
    `SELECT * FROM fare_rules WHERE route_id = ? AND deleted_at IS NULL AND is_active = 1`
  ).bind(routeId).all<FareRule>();

  const classes = ['standard', 'window', 'vip', 'front'];
  const effective: Record<string, number> = {};
  for (const cls of classes) {
    effective[cls] = computeEffectiveFare(route.base_fare, cls, rules.results, refTimeMs);
  }
  return c.json({ success: true, data: { route_id: routeId, ref_time_ms: refTimeMs, effective_fare_by_class: effective, base_fare: route.base_fare } });
});

// ============================================================
// P11-T3: Route Stops Management
// ============================================================

operatorManagementRouter.post('/routes/:id/stops', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR']), async (c) => {
  const routeId = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const db = c.env.DB;
  const user = c.get('user');
  const now = Date.now();

  const rawStops = body.stops;
  if (!Array.isArray(rawStops) || rawStops.length < 2) {
    return c.json({ success: false, error: 'At least 2 stops required' }, 400);
  }

  interface StopInput {
    stop_name: string;
    sequence: number;
    distance_from_origin_km?: number;
    fare_from_origin_kobo?: number;
  }

  const stops = rawStops as StopInput[];

  const sequences = stops.map(s => s.sequence);
  const uniqueSeqs = new Set(sequences);
  if (uniqueSeqs.size !== sequences.length) {
    return c.json({ success: false, error: 'Sequence values must be unique' }, 400);
  }
  if (Math.min(...sequences) !== 1) {
    return c.json({ success: false, error: 'First stop must have sequence = 1' }, 400);
  }
  for (const s of stops) {
    if (!s.stop_name || typeof s.stop_name !== 'string') {
      return c.json({ success: false, error: 'Each stop must have a stop_name' }, 400);
    }
  }

  try {
    const route = await db.prepare(
      `SELECT id, operator_id FROM routes WHERE id = ? AND deleted_at IS NULL`
    ).bind(routeId).first<{ id: string; operator_id: string }>();
    if (!route) return c.json({ success: false, error: 'Route not found' }, 404);
    if (user?.role !== 'SUPER_ADMIN' && user?.operatorId && route.operator_id !== user.operatorId) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }

    await db.prepare(`DELETE FROM route_stops WHERE route_id = ?`).bind(routeId).run();

    const sorted = [...stops].sort((a, b) => a.sequence - b.sequence);
    for (const stop of sorted) {
      const stopId = genId('stp');
      await db.prepare(
        `INSERT INTO route_stops (id, route_id, stop_name, sequence, distance_from_origin_km, fare_from_origin_kobo, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        stopId, routeId, stop.stop_name, stop.sequence,
        stop.distance_from_origin_km ?? null,
        stop.fare_from_origin_kobo ?? null,
        now
      ).run();
    }

    await db.prepare(
      `UPDATE routes SET route_stops_enabled = 1 WHERE id = ?`
    ).bind(routeId).run();

    const inserted = await db.prepare(
      `SELECT * FROM route_stops WHERE route_id = ? ORDER BY sequence ASC`
    ).bind(routeId).all<{
      id: string; route_id: string; stop_name: string; sequence: number;
      distance_from_origin_km: number | null; fare_from_origin_kobo: number | null;
    }>();

    return c.json({ success: true, data: inserted.results });
  } catch (e: unknown) {
    console.error('[RouteStops] Error:', e instanceof Error ? e.message : String(e));
    return c.json({ success: false, error: 'Failed to set route stops' }, 500);
  }
});

operatorManagementRouter.get('/routes/:id/stops', async (c) => {
  const routeId = c.req.param('id');
  const db = c.env.DB;

  try {
    const result = await db.prepare(
      `SELECT id, route_id, stop_name, sequence, distance_from_origin_km, fare_from_origin_kobo, created_at
       FROM route_stops WHERE route_id = ? ORDER BY sequence ASC`
    ).bind(routeId).all<{
      id: string; route_id: string; stop_name: string; sequence: number;
      distance_from_origin_km: number | null; fare_from_origin_kobo: number | null; created_at: number;
    }>();
    return c.json({ success: true, data: result.results });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch route stops' }, 500);
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
// P08-T1: PUT /vehicles/:id/template — save seat layout template (TENANT_ADMIN+)
// ============================================================
operatorManagementRouter.put('/vehicles/:id/template', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const db = c.env.DB;
  const jwtUser = c.get('user');
  const isSuperAdmin = jwtUser?.role === 'SUPER_ADMIN';

  const { rows, columns, aisle_after_column, seats } = body as {
    rows: number; columns: number; aisle_after_column?: number;
    seats: Array<{ number: string; row: number; column: number; class: string }>;
  };

  const VALID_SEAT_CLASSES = ['standard', 'window', 'vip', 'front'];

  if (!Number.isInteger(rows) || rows <= 0) {
    return c.json({ success: false, error: 'rows must be a positive integer' }, 400);
  }
  if (!Number.isInteger(columns) || columns <= 0) {
    return c.json({ success: false, error: 'columns must be a positive integer' }, 400);
  }
  if (!Array.isArray(seats) || seats.length === 0) {
    return c.json({ success: false, error: 'seats must be a non-empty array' }, 400);
  }

  const seatNumbers = seats.map(s => s.number);
  if (new Set(seatNumbers).size !== seatNumbers.length) {
    return c.json({ success: false, error: 'Duplicate seat numbers found in template' }, 400);
  }
  for (const seat of seats) {
    if (!VALID_SEAT_CLASSES.includes(seat.class)) {
      return c.json({ success: false, error: `seat class must be one of: ${VALID_SEAT_CLASSES.join(', ')}` }, 400);
    }
  }

  try {
    const vehicle = await db.prepare(
      `SELECT id, operator_id FROM vehicles WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<{ id: string; operator_id: string }>();
    if (!vehicle) return c.json({ success: false, error: 'Vehicle not found' }, 404);
    if (!isSuperAdmin && jwtUser?.operatorId && vehicle.operator_id !== jwtUser.operatorId) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }

    const template = { rows, columns, aisle_after_column: aisle_after_column ?? null, seats };
    await db.prepare(`UPDATE vehicles SET seat_template = ? WHERE id = ?`).bind(JSON.stringify(template), id).run();
    return c.json({ success: true, data: { vehicle_id: id, template } });
  } catch {
    return c.json({ success: false, error: 'Failed to save seat template' }, 500);
  }
});

// ============================================================
// TRIP STATE MACHINE (TRN-4)
// ============================================================

operatorManagementRouter.get('/trips', async (c) => {
  const q = c.req.query();
  const { state, driver_id, date } = q;
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;

  let query = `SELECT t.*, r.origin, r.destination, r.base_fare FROM trips t
    JOIN routes r ON t.route_id = r.id
    WHERE t.deleted_at IS NULL`;
  const params: unknown[] = [];

  const scoped = applyTenantScope(c, query, params, 't.');
  query = scoped.query;
  params.splice(0, params.length, ...scoped.params);

  const { park_id } = q;
  if (state) { query += ` AND t.state = ?`; params.push(state); }
  // T4-6: filter trips by departure park
  if (park_id) { query += ` AND t.departure_park_id = ?`; params.push(park_id); }

  // C-004: driver_id filter — 'me' resolves to the authenticated user's id
  if (driver_id) {
    const user = c.get('user');
    const resolvedDriverId = driver_id === 'me' ? user?.id ?? driver_id : driver_id;
    query += ` AND t.driver_id = ?`;
    params.push(resolvedDriverId);
  }

  // C-004: date filter — filters trips departing on the given YYYY-MM-DD
  if (date) {
    const dayStart = new Date(date).setHours(0, 0, 0, 0);
    const dayEnd = dayStart + 86400000 - 1;
    query += ` AND t.departure_time >= ? AND t.departure_time <= ?`;
    params.push(dayStart, dayEnd);
  }

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
// GET /trips/:id — single trip detail including location fields (P05-T1)
// ============================================================
operatorManagementRouter.get('/trips/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;

  try {
    const trip = await db.prepare(
      `SELECT t.*,
              r.origin, r.destination, r.base_fare,
              v.plate_number, v.total_seats AS vehicle_total_seats,
              d.name AS driver_name, d.phone AS driver_phone
       FROM trips t
       JOIN routes r ON t.route_id = r.id
       LEFT JOIN vehicles v ON t.vehicle_id = v.id AND v.deleted_at IS NULL
       LEFT JOIN drivers d ON t.driver_id = d.id AND d.deleted_at IS NULL
       WHERE t.id = ? AND t.deleted_at IS NULL`
    ).bind(id).first<DbTrip & {
      origin: string; destination: string; base_fare: number;
      plate_number: string | null; vehicle_total_seats: number | null;
      driver_name: string | null; driver_phone: string | null;
    }>();

    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);
    // Normalise: expose total_seats at top level (vehicle total seats)
    const data = { ...trip, total_seats: trip.vehicle_total_seats };
    return c.json({ success: true, data });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch trip' }, 500);
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

    // P09-T1: Block assignment if vehicle roadworthiness certificate is expired
    if (vehicle_id) {
      const expiredRW = await db.prepare(
        `SELECT id FROM vehicle_documents WHERE vehicle_id = ? AND doc_type = 'roadworthiness' AND expires_at < ?`
      ).bind(vehicle_id, now).first<{ id: string }>();
      if (expiredRW) {
        return c.json({ success: false, error: 'vehicle_compliance_expired', doc_type: 'roadworthiness' }, 422);
      }
    }

    // P09-T2: Block assignment if driver's licence is expired
    if (driver_id) {
      const expiredLic = await db.prepare(
        `SELECT id FROM driver_documents WHERE driver_id = ? AND doc_type = 'drivers_license' AND expires_at < ?`
      ).bind(driver_id, now).first<{ id: string }>();
      if (expiredLic) {
        return c.json({ success: false, error: 'driver_license_expired', doc_type: 'drivers_license' }, 422);
      }
    }

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

    // P05-T5: Inspection gate — check inspection_required_before_boarding config
    if (trip.state === 'scheduled' && to_state === 'boarding') {
      try {
        const config = await getOperatorConfig(c.env, trip.operator_id);
        if (config.inspection_required_before_boarding && !trip.inspection_completed_at) {
          return c.json({
            success: false,
            error: 'inspection_required',
            message: 'Pre-trip inspection must be completed before boarding.',
          }, 422);
        }
      } catch { /* non-fatal — if config unavailable, don't block transition */ }
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

// ============================================================
// P05-T1: POST|PATCH /trips/:id/location — GPS location update (DRIVER+)
// Body: { latitude, longitude, accuracy_meters? }
// 204 No Content on success
// PATCH is the REST-idiomatic method; POST retained for backwards compatibility
// ============================================================
operatorManagementRouter.post('/trips/:id/location', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'DRIVER']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const { latitude, longitude, accuracy_meters } = body as { latitude?: unknown; longitude?: unknown; accuracy_meters?: unknown };

  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return c.json({ success: false, error: 'latitude and longitude are required numbers' }, 400);
  }
  if (latitude < -90 || latitude > 90) {
    return c.json({ success: false, error: 'latitude must be between -90 and 90' }, 400);
  }
  if (longitude < -180 || longitude > 180) {
    return c.json({ success: false, error: 'longitude must be between -180 and 180' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const user = c.get('user');

  try {
    const trip = await db.prepare(
      `SELECT id, state, operator_id FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<{ id: string; state: string; operator_id: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    if (trip.state === 'completed' || trip.state === 'cancelled') {
      return c.json({ success: false, error: 'trip_not_active', message: `Trip is ${trip.state} — location updates not accepted` }, 422);
    }

    // Tenant scope: only the trip's operator (or SUPER_ADMIN) may update
    const operatorId = user?.operatorId;
    if (user?.role !== 'SUPER_ADMIN' && operatorId && trip.operator_id !== operatorId) {
      return c.json({ success: false, error: 'Forbidden — trip belongs to a different operator' }, 403);
    }

    await db.prepare(
      `UPDATE trips SET current_latitude = ?, current_longitude = ?, location_updated_at = ?, updated_at = ? WHERE id = ?`
    ).bind(latitude, longitude, now, now, id).run();

    try {
      await publishEvent(db, {
        event_type: 'trip.location_updated',
        aggregate_id: id,
        aggregate_type: 'trip',
        payload: {
          trip_id: id,
          lat: latitude,
          lng: longitude,
          accuracy_meters: typeof accuracy_meters === 'number' ? accuracy_meters : null,
          updated_at: now,
          updated_by: user?.id,
        },
        tenant_id: trip.operator_id,
        timestamp: now,
      });
    } catch { /* non-fatal */ }

    return new Response(null, { status: 204 });
  } catch {
    return c.json({ success: false, error: 'Failed to update trip location' }, 500);
  }
});
// PATCH alias for REST-idiomatic clients (TRN-4)
operatorManagementRouter.patch('/trips/:id/location', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'DRIVER']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const { latitude, longitude, accuracy_meters } = body as { latitude?: unknown; longitude?: unknown; accuracy_meters?: unknown };
  if (typeof latitude !== 'number' || typeof longitude !== 'number') {
    return c.json({ success: false, error: 'latitude and longitude are required numbers' }, 400);
  }
  if (latitude < -90 || latitude > 90) {
    return c.json({ success: false, error: 'latitude must be between -90 and 90' }, 400);
  }
  if (longitude < -180 || longitude > 180) {
    return c.json({ success: false, error: 'longitude must be between -180 and 180' }, 400);
  }
  const db = c.env.DB;
  const now = Date.now();
  const user = c.get('user');
  try {
    const trip = await db.prepare(
      `SELECT id, state, operator_id FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<{ id: string; state: string; operator_id: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);
    if (trip.state === 'completed' || trip.state === 'cancelled') {
      return c.json({ success: false, error: 'trip_not_active', message: `Trip is ${trip.state} — location updates not accepted` }, 422);
    }
    const operatorId = user?.operatorId;
    if (user?.role !== 'SUPER_ADMIN' && operatorId && trip.operator_id !== operatorId) {
      return c.json({ success: false, error: 'Forbidden — trip belongs to a different operator' }, 403);
    }
    await db.prepare(
      `UPDATE trips SET current_latitude = ?, current_longitude = ?, location_updated_at = ?, updated_at = ? WHERE id = ?`
    ).bind(latitude, longitude, now, now, id).run();
    try {
      await publishEvent(db, {
        event_type: 'trip.location_updated',
        aggregate_id: id,
        aggregate_type: 'trip',
        payload: { trip_id: id, lat: latitude, lng: longitude, accuracy_meters: typeof accuracy_meters === 'number' ? accuracy_meters : null, updated_at: now, updated_by: user?.id },
        tenant_id: trip.operator_id,
        timestamp: now,
      });
    } catch { /* non-fatal */ }
    return new Response(null, { status: 204 });
  } catch {
    return c.json({ success: false, error: 'Failed to update trip location' }, 500);
  }
});

// ============================================================
// P05-T2: POST /trips/:id/sos — driver triggers SOS alert
// DRIVER+ required
// ============================================================
operatorManagementRouter.post('/trips/:id/sos', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'DRIVER']), async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const now = Date.now();

  try {
    const trip = await db.prepare(
      `SELECT id, sos_active, operator_id, route_id FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<{ id: string; sos_active: number; operator_id: string; route_id: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    if (trip.sos_active === 1) {
      return c.json({ success: false, error: 'sos_already_active', message: 'SOS is already active on this trip' }, 409);
    }

    const routeRow = await db.prepare(
      `SELECT origin, destination FROM routes WHERE id = ?`
    ).bind(trip.route_id).first<{ origin: string; destination: string }>();
    const route = routeRow ? `${routeRow.origin} → ${routeRow.destination}` : trip.route_id;

    await db.prepare(
      `UPDATE trips SET sos_active = 1, sos_triggered_at = ?, sos_triggered_by = ?, updated_at = ? WHERE id = ?`
    ).bind(now, user?.id ?? 'unknown', now, id).run();

    const config = await getOperatorConfig(c.env, trip.operator_id);
    const smsTarget = config.emergency_contact_phone;

    // Non-fatal SMS to emergency contact (non-blocking: await with .catch so driver response is not held up)
    if (smsTarget) {
      const sosMessage =
        `\uD83D\uDEA8 SOS ALERT: Driver triggered emergency on Trip ${id.slice(-8)}, Route ${route}. ` +
        `Time: ${new Date(now).toLocaleString('en-NG', { hour: '2-digit', minute: '2-digit', day: 'numeric', month: 'short' })}. ` +
        `Check dispatch dashboard immediately.`;
      await sendSms(smsTarget, sosMessage, c.env).catch(() => {});
    }

    try {
      await publishEvent(db, {
        event_type: 'trip:SOS_ACTIVATED',
        aggregate_id: id,
        aggregate_type: 'trip',
        payload: {
          trip_id: id,
          route,
          operator_id: trip.operator_id,
          triggered_by: user?.id ?? 'unknown',
          triggered_at: now,
          sos_escalation_email: config.sos_escalation_email,
          emergency_contact_phone: config.emergency_contact_phone,
        },
        tenant_id: trip.operator_id,
        timestamp: now,
      });
    } catch { /* non-fatal */ }

    return c.json({ success: true, message: 'SOS activated. Emergency contacts notified.' });
  } catch {
    return c.json({ success: false, error: 'Failed to activate SOS' }, 500);
  }
});

// ============================================================
// P05-T2: POST /trips/:id/sos/clear — supervisor clears SOS
// SUPERVISOR+ required
// ============================================================
operatorManagementRouter.post('/trips/:id/sos/clear', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR']), async (c) => {
  const id = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const now = Date.now();

  try {
    const trip = await db.prepare(
      `SELECT id, sos_active, operator_id FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<{ id: string; sos_active: number; operator_id: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    if (trip.sos_active === 0) {
      return c.json({ success: false, error: 'no_active_sos', message: 'No active SOS on this trip' }, 409);
    }

    await db.prepare(
      `UPDATE trips SET sos_active = 0, sos_cleared_at = ?, sos_cleared_by = ?, updated_at = ? WHERE id = ?`
    ).bind(now, user?.id ?? 'unknown', now, id).run();

    try {
      await publishEvent(db, {
        event_type: 'trip:SOS_CLEARED',
        aggregate_id: id,
        aggregate_type: 'trip',
        payload: { trip_id: id, cleared_by: user?.id ?? 'unknown', cleared_at: now, operator_id: trip.operator_id },
        tenant_id: trip.operator_id,
        timestamp: now,
      });
    } catch { /* non-fatal */ }

    return c.json({ success: true, message: 'SOS cleared.' });
  } catch {
    return c.json({ success: false, error: 'Failed to clear SOS' }, 500);
  }
});

// ============================================================
// GET /trips/:id/manifest — passenger manifest for boarding
// ============================================================
operatorManagementRouter.get('/trips/:id/manifest', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'DRIVER']), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const user = c.get('user');

  try {
    const trip = await db.prepare(
      `SELECT id, operator_id, route_id, driver_id, state, departure_time FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<{ id: string; operator_id: string; route_id: string; driver_id: string | null; state: string; departure_time: number }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    // Tenant scope: non-SUPER_ADMIN users can only access their own operator's manifest
    if (user?.role !== 'SUPER_ADMIN' && user?.operatorId && trip.operator_id !== user.operatorId) {
      return c.json({ success: false, error: 'Forbidden — this trip belongs to a different operator' }, 403);
    }

    const [routeRow, bookingsResult, seatsResult, driverRow, agentSalesResult, operatorRow] = await Promise.all([
      db.prepare(
        `SELECT origin, destination, base_fare FROM routes WHERE id = ?`
      ).bind(trip.route_id).first<{ origin: string; destination: string; base_fare: number }>(),
      db.prepare(
        `SELECT id, customer_id, seat_ids, passenger_names, status, payment_status, payment_method,
                total_amount, boarded_at, created_at, next_of_kin_name, next_of_kin_phone
         FROM bookings WHERE trip_id = ? AND deleted_at IS NULL AND status != 'cancelled'
         ORDER BY created_at ASC`
      ).bind(id).all<{
        id: string; customer_id: string; seat_ids: string; passenger_names: string;
        status: string; payment_status: string; payment_method: string; total_amount: number;
        boarded_at: number | null; created_at: number;
        next_of_kin_name: string | null; next_of_kin_phone: string | null;
      }>(),
      db.prepare(
        `SELECT id FROM seats WHERE trip_id = ?`
      ).bind(id).all<{ id: string }>(),
      trip.driver_id
        ? db.prepare(`SELECT id, name, phone, license_number FROM drivers WHERE id = ?`)
            .bind(trip.driver_id).first<{ id: string; name: string; phone: string; license_number: string | null }>()
        : Promise.resolve(null),
      // P07-T5 + T-TRN-02: Include agent-sold tickets in manifest for FRSC compliance
      db.prepare(
        `SELECT st.id, st.agent_id, st.seat_ids, st.passenger_names, st.total_amount, st.payment_method,
                st.passenger_id_type, st.passenger_id_hash, st.next_of_kin_name, st.next_of_kin_phone,
                st.created_at, a.name AS agent_name
         FROM sales_transactions st
         JOIN agents a ON st.agent_id = a.id
         WHERE st.trip_id = ? AND st.deleted_at IS NULL AND st.payment_status = 'completed'
         ORDER BY st.created_at ASC`
      ).bind(id).all<{
        id: string; agent_id: string; agent_name: string; seat_ids: string; passenger_names: string;
        total_amount: number; payment_method: string; passenger_id_type: string | null;
        passenger_id_hash: string | null;
        next_of_kin_name: string | null; next_of_kin_phone: string | null; created_at: number;
      }>(),
      db.prepare(`SELECT name FROM operators WHERE id = ?`).bind(trip.operator_id)
        .first<{ name: string }>(),
    ]);

    // Pre-load seat number lookup for all seats on this trip
    const allSeats = await db.prepare(
      `SELECT id, seat_number FROM seats WHERE trip_id = ?`
    ).bind(id).all<{ id: string; seat_number: string }>();
    const seatNumberMap = new Map(allSeats.results.map(s => [s.id, s.seat_number]));

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

        let seatIds: string[] = [];
        let passengerNames: string[] = [];
        try { seatIds = JSON.parse(bkg.seat_ids) as string[]; } catch { seatIds = []; }
        try { passengerNames = JSON.parse(bkg.passenger_names) as string[]; } catch { passengerNames = []; }

        const seatNumbers = seatIds.map(sid => seatNumberMap.get(sid) ?? sid).join(', ');

        return {
          booking_id: bkg.id,
          customer_name,
          customer_phone,
          seat_ids: seatIds,
          seat_numbers: seatNumbers,
          passenger_names: passengerNames,
          status: bkg.status,
          payment_status: bkg.payment_status,
          payment_method: bkg.payment_method,
          total_amount: bkg.total_amount,
          boarded_at: bkg.boarded_at,
          booked_at: bkg.created_at,
          qr_payload: `${bkg.id}:${seatIds.join(',')}`,
          next_of_kin_name: bkg.next_of_kin_name,
          next_of_kin_phone: bkg.next_of_kin_phone,
        };
      })
    );

    const confirmedRevenue = bookingsResult.results
      .filter(b => b.payment_status === 'paid' || b.status === 'confirmed')
      .reduce((sum, b) => sum + b.total_amount, 0);

    // Build agent sales summary for manifest (P07-T5 + T-TRN-02 FRSC compliance)
    const agentSales = agentSalesResult.results.map(txn => {
      let seatIds: string[] = [];
      let passengerNames: string[] = [];
      try { seatIds = JSON.parse(txn.seat_ids) as string[]; } catch { seatIds = []; }
      try { passengerNames = JSON.parse(txn.passenger_names) as string[]; } catch { passengerNames = []; }
      const seatNumbers = seatIds.map(sid => seatNumberMap.get(sid) ?? sid).join(', ');
      return {
        transaction_id: txn.id,
        agent_id: txn.agent_id,
        agent_name: txn.agent_name,
        seat_ids: seatIds,
        seat_numbers: seatNumbers,
        passenger_names: passengerNames,
        passenger_id_type: txn.passenger_id_type,
        passenger_id_hash: txn.passenger_id_hash,
        next_of_kin_name: txn.next_of_kin_name,
        next_of_kin_phone: txn.next_of_kin_phone,
        payment_method: txn.payment_method,
        total_amount: txn.total_amount,
        sold_at: txn.created_at,
      };
    });
    const agentRevenue = agentSalesResult.results.reduce((sum, t) => sum + t.total_amount, 0);

    // P05-T4 + T-TRN-02: CSV content negotiation — includes BOTH online bookings and agent sales
    // FRSC compliance requires all passengers on a single sheet; agent sales must not be omitted.
    const acceptHeader = c.req.header('Accept') ?? '';
    if (acceptHeader.includes('text/csv')) {
      const tripDate = new Date(trip.departure_time).toISOString().slice(0, 10);
      const escapeCsv = (v: string) => `"${String(v).replace(/"/g, '""')}"`;

      const bookingRows = passengers.map(p => {
        const name = escapeCsv(p.passenger_names.join('; '));
        const seats = escapeCsv(p.seat_numbers);
        const boarded = p.boarded_at ? new Date(p.boarded_at).toISOString() : '';
        const method = escapeCsv(p.payment_method);
        const ref = escapeCsv(p.booking_id.slice(-8).toUpperCase());
        return `${seats},${name},${escapeCsv(boarded)},${method},${ref},Online`;
      });

      const agentRows = agentSales.map(a => {
        const name = escapeCsv(a.passenger_names.join('; '));
        const seats = escapeCsv(a.seat_numbers);
        const method = escapeCsv(a.payment_method);
        const ref = escapeCsv(a.transaction_id.slice(-8).toUpperCase());
        return `${seats},${name},"",${method},${ref},Agent`;
      });

      const csv = `Seat,Passenger Name,Boarded,Payment Method,Ref,Source\n${[...bookingRows, ...agentRows].join('\n')}`;
      return new Response(csv, {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="manifest_${id}_${tripDate}.csv"`,
        },
      });
    }

    // T-TRN-02: PDF manifest — ?format=pdf or Accept: application/pdf
    // Uses the modular core PDF utility (src/core/pdf/manifest.ts)
    // NDPR: ID hashes are truncated, next-of-kin phone numbers are masked
    const wantPdf = acceptHeader.includes('application/pdf') || c.req.query('format') === 'pdf';
    if (wantPdf) {
      const tripDate = new Date(trip.departure_time).toISOString().slice(0, 10);
      let serial = 0;

      // Combine bookings and agent sales into a single passenger list for the PDF
      const pdfPassengers: ManifestPdfInput['passengers'] = [
        ...passengers.map(p => ({
          serial: ++serial,
          seat_numbers: p.seat_numbers,
          passenger_names: p.passenger_names,
          next_of_kin_name: p.next_of_kin_name,
          next_of_kin_phone: p.next_of_kin_phone,
          id_type: null,
          id_hash: null,
          boarded_at: p.boarded_at,
          source: 'booking' as const,
        })),
        ...agentSales.map(a => ({
          serial: ++serial,
          seat_numbers: a.seat_numbers,
          passenger_names: a.passenger_names,
          next_of_kin_name: a.next_of_kin_name,
          next_of_kin_phone: a.next_of_kin_phone,
          id_type: a.passenger_id_type,
          id_hash: a.passenger_id_hash,
          boarded_at: null,
          source: 'agent' as const,
        })),
      ];

      const pdfInput: ManifestPdfInput = {
        operator_name: operatorRow?.name ?? 'Unknown Operator',
        trip: {
          id: trip.id,
          origin: routeRow?.origin ?? '',
          destination: routeRow?.destination ?? '',
          departure_time: trip.departure_time,
          state: trip.state,
          plate_number: null,
        },
        driver: driverRow
          ? { name: driverRow.name, phone: driverRow.phone, license_number: driverRow.license_number }
          : null,
        passengers: pdfPassengers,
        total_seats: seatsResult.results.length,
        generated_at: Date.now(),
      };

      const pdfBytes = await generateManifestPdf(pdfInput);
      return new Response(pdfBytes, {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="manifest_${id}_${tripDate}.pdf"`,
          'Cache-Control': 'private, no-store',
        },
      });
    }

    const totalPassengers = passengers.length + agentSales.length;
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
        agent_sales: agentSales,
        summary: {
          total_bookings: passengers.length,
          total_agent_sales: agentSales.length,
          total_passengers: totalPassengers,
          total_boarded: passengers.filter(p => p.boarded_at !== null).length,
          total_seats: seatsResult.results.length,
          load_factor: seatsResult.results.length > 0
            ? Math.round((totalPassengers / seatsResult.results.length) * 100)
            : 0,
          confirmed_revenue_kobo: confirmedRevenue,
          agent_revenue_kobo: agentRevenue,
          total_revenue_kobo: confirmedRevenue + agentRevenue,
        },
      },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch trip manifest' }, 500);
  }
});

// ============================================================
// C-004: PATCH /trips/:tripId/manifest/:bookingId/board
// Driver marks a passenger as boarded. Trip must be in 'boarding' state.
// ============================================================

operatorManagementRouter.patch(
  '/trips/:tripId/manifest/:bookingId/board',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'DRIVER']),
  async (c) => {
    const tripId = c.req.param('tripId');
    const bookingId = c.req.param('bookingId');
    const user = c.get('user');
    const db = c.env.DB;
    const now = Date.now();

    try {
      const trip = await db.prepare(
        `SELECT id, state FROM trips WHERE id = ? AND deleted_at IS NULL`
      ).bind(tripId).first<{ id: string; state: string }>();

      if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);
      if (trip.state !== 'boarding') {
        return c.json({ success: false, error: `Boarding not open — trip is in '${trip.state}' state` }, 409);
      }

      const booking = await db.prepare(
        `SELECT id, status FROM bookings WHERE id = ? AND trip_id = ? AND deleted_at IS NULL`
      ).bind(bookingId, tripId).first<{ id: string; status: string }>();

      if (!booking) return c.json({ success: false, error: 'Booking not found on this trip' }, 404);
      if (booking.status === 'cancelled') {
        return c.json({ success: false, error: 'Cannot board a cancelled booking' }, 409);
      }

      await db.prepare(
        `UPDATE bookings SET boarded_at = ?, boarded_by = ? WHERE id = ?`
      ).bind(now, user?.id ?? 'unknown', bookingId).run();

      const evtId = genId('evt');
      await db.prepare(
        `INSERT OR IGNORE INTO platform_events
         (id, event_type, aggregate_id, aggregate_type, payload, status, created_at)
         VALUES (?, 'passenger:BOARDED', ?, 'booking', ?, 'pending', ?)`
      ).bind(
        evtId, bookingId,
        JSON.stringify({ booking_id: bookingId, trip_id: tripId, boarded_by: user?.id, boarded_at: now }),
        now
      ).run();

      return c.json({ success: true, data: { booking_id: bookingId, boarded_at: now } });
    } catch {
      return c.json({ success: false, error: 'Failed to mark passenger boarded' }, 500);
    }
  }
);

// ============================================================
// P05-T3: POST /trips/:id/board — QR-code digital boarding scan (STAFF+)
// Body: { qr_payload: "{bookingId}:{seatId1},{seatId2}" }
// ============================================================
operatorManagementRouter.post('/trips/:id/board', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'DRIVER']), async (c) => {
  const tripId = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const now = Date.now();

  let body: Record<string, unknown>;
  try { body = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const qrPayload = String(body['qr_payload'] ?? '').trim();
  if (!qrPayload) return c.json({ success: false, error: 'qr_payload is required' }, 400);

  const colonIdx = qrPayload.indexOf(':');
  if (colonIdx === -1) {
    return c.json({ success: false, error: 'invalid_qr', message: 'QR payload must be in format {bookingId}:{seatId1},{seatId2}' }, 400);
  }
  const bookingId = qrPayload.slice(0, colonIdx).trim();
  const seatsStr = qrPayload.slice(colonIdx + 1).trim();
  if (!bookingId || !seatsStr) {
    return c.json({ success: false, error: 'invalid_qr', message: 'QR payload parts are empty — expected {bookingId}:{seatIds}' }, 400);
  }

  try {
    const row = await db.prepare(
      `SELECT id, passenger_names, seat_ids, boarded_at, status, trip_id
       FROM bookings
       WHERE id = ? AND trip_id = ? AND deleted_at IS NULL`
    ).bind(bookingId, tripId).first<{
      id: string; passenger_names: string; seat_ids: string; boarded_at: number | null;
      status: string; trip_id: string;
    }>();

    if (!row) return c.json({ success: false, error: 'invalid_ticket', message: 'Ticket not found for this trip.' }, 404);
    if (row.status !== 'confirmed') {
      return c.json({ success: false, error: 'booking_not_confirmed', status: row.status, message: `Booking is ${row.status} — cannot board.` }, 422);
    }
    if (row.boarded_at !== null) {
      return c.json({ success: false, error: 'already_boarded', boarded_at: row.boarded_at, message: 'This passenger has already boarded.' }, 409);
    }

    // Resolve seat numbers from seat_ids JSON array
    let seatNumbers = seatsStr;
    try {
      const parsedSeatIds = JSON.parse(row.seat_ids) as string[];
      if (parsedSeatIds.length > 0) {
        const placeholders = parsedSeatIds.map(() => '?').join(',');
        const seatsResult = await db.prepare(
          `SELECT seat_number FROM seats WHERE id IN (${placeholders})`
        ).bind(...parsedSeatIds).all<{ seat_number: string }>();
        if (seatsResult.results.length > 0) {
          seatNumbers = seatsResult.results.map(s => s.seat_number).join(', ');
        }
      }
    } catch { /* use seatsStr from QR payload as fallback */ }

    await db.prepare(
      `UPDATE bookings SET boarded_at = ?, boarded_by = ? WHERE id = ?`
    ).bind(now, user?.id ?? 'unknown', bookingId).run();

    try {
      await publishEvent(db, {
        event_type: 'booking.boarded',
        aggregate_id: bookingId,
        aggregate_type: 'booking',
        payload: { booking_id: bookingId, trip_id: tripId, boarded_at: now, boarded_by: user?.id },
        timestamp: now,
      });
    } catch { /* non-fatal */ }

    let passengerNames: string[] = [];
    try { passengerNames = JSON.parse(row.passenger_names) as string[]; } catch { passengerNames = []; }

    return c.json({
      success: true,
      data: {
        passenger_names: passengerNames,
        seat_numbers: seatNumbers,
        boarded_at: now,
        message: 'Welcome aboard!',
      },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to process boarding scan' }, 500);
  }
});

// ============================================================
// P05-T3: GET /trips/:id/boarding-status — boarding progress (STAFF+)
// ============================================================
operatorManagementRouter.get('/trips/:id/boarding-status', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'DRIVER']), async (c) => {
  const tripId = c.req.param('id');
  const db = c.env.DB;

  try {
    const row = await db.prepare(
      `SELECT
         COUNT(*) as total_confirmed,
         SUM(CASE WHEN boarded_at IS NOT NULL THEN 1 ELSE 0 END) as total_boarded,
         MAX(boarded_at) as last_boarded_at
       FROM bookings
       WHERE trip_id = ? AND status = 'confirmed' AND deleted_at IS NULL`
    ).bind(tripId).first<{ total_confirmed: number; total_boarded: number; last_boarded_at: number | null }>();

    const total_confirmed = row?.total_confirmed ?? 0;
    const total_boarded = row?.total_boarded ?? 0;

    return c.json({
      success: true,
      data: {
        total_confirmed,
        total_boarded,
        remaining: total_confirmed - total_boarded,
        last_boarded_at: row?.last_boarded_at ?? null,
      },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch boarding status' }, 500);
  }
});

// ============================================================
// P05-T5: POST /trips/:id/inspection — pre-trip inspection checklist (DRIVER+)
// ============================================================
operatorManagementRouter.post('/trips/:id/inspection', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'DRIVER']), async (c) => {
  const tripId = c.req.param('id');
  const user = c.get('user');
  const db = c.env.DB;
  const now = Date.now();

  let body: Record<string, unknown>;
  try { body = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const boolFields = ['tires_ok', 'brakes_ok', 'lights_ok', 'fuel_ok', 'emergency_equipment_ok'] as const;
  for (const field of boolFields) {
    if (typeof body[field] !== 'boolean') {
      return c.json({ success: false, error: `${field} must be a boolean` }, 400);
    }
    if (body[field] !== true) {
      return c.json({
        success: false, error: 'inspection_failed',
        failed_item: field,
        message: `Inspection failed: ${field.replace(/_ok$/, '').replace(/_/g, ' ')} check did not pass. Fix before departure.`,
      }, 422);
    }
  }

  try {
    const trip = await db.prepare(
      `SELECT id FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(tripId).first<{ id: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    const existing = await db.prepare(
      `SELECT id FROM trip_inspections WHERE trip_id = ?`
    ).bind(tripId).first<{ id: string }>();
    if (existing) {
      return c.json({ success: false, error: 'inspection_exists', message: 'A pre-trip inspection has already been submitted for this trip.' }, 409);
    }

    const inspId = genId('ins');
    const manifest_count = typeof body['manifest_count'] === 'number' ? body['manifest_count'] : null;
    const notes = typeof body['notes'] === 'string' ? body['notes'] : null;

    await db.batch([
      db.prepare(
        `INSERT INTO trip_inspections (id, trip_id, inspected_by, tires_ok, brakes_ok, lights_ok, fuel_ok, emergency_equipment_ok, manifest_count, notes, created_at)
         VALUES (?, ?, ?, 1, 1, 1, 1, 1, ?, ?, ?)`
      ).bind(inspId, tripId, user?.id ?? 'unknown', manifest_count, notes, now),
      db.prepare(
        `UPDATE trips SET inspection_completed_at = ?, updated_at = ? WHERE id = ?`
      ).bind(now, now, tripId),
    ]);

    try {
      await publishEvent(db, {
        event_type: 'trip.inspection_completed',
        aggregate_id: tripId,
        aggregate_type: 'trip',
        payload: { trip_id: tripId, inspection_id: inspId, inspected_by: user?.id, completed_at: now },
        timestamp: now,
      });
    } catch { /* non-fatal */ }

    return c.json({
      success: true,
      data: { id: inspId, trip_id: tripId, inspected_by: user?.id, all_checks_passed: true, manifest_count, notes, created_at: now },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to submit inspection' }, 500);
  }
});

// ============================================================
// P05-T5: GET /trips/:id/inspection — get pre-trip inspection result (STAFF+)
// ============================================================
operatorManagementRouter.get('/trips/:id/inspection', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'DRIVER']), async (c) => {
  const tripId = c.req.param('id');
  const db = c.env.DB;

  try {
    const inspection = await db.prepare(
      `SELECT * FROM trip_inspections WHERE trip_id = ?`
    ).bind(tripId).first();

    return c.json({ success: true, data: inspection ?? null });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch inspection' }, 500);
  }
});

// ============================================================
// P05-T6: POST /trips/:id/delay — report trip delay with passenger SMS (SUPERVISOR+)
// ============================================================
const ALLOWED_REASON_CODES = ['traffic', 'breakdown', 'weather', 'accident', 'fuel', 'other'] as const;
type DelayReasonCode = typeof ALLOWED_REASON_CODES[number];

operatorManagementRouter.post('/trips/:id/delay', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR', 'DRIVER']), async (c) => {
  const tripId = c.req.param('id');
  const db = c.env.DB;
  const now = Date.now();

  let body: Record<string, unknown>;
  try { body = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const reason_code = String(body['reason_code'] ?? '') as DelayReasonCode;
  if (!ALLOWED_REASON_CODES.includes(reason_code)) {
    return c.json({ success: false, error: `reason_code must be one of: ${ALLOWED_REASON_CODES.join(', ')}` }, 400);
  }

  const estimated_departure_ms = Number(body['estimated_departure_ms'] ?? 0);
  if (!estimated_departure_ms || estimated_departure_ms <= now) {
    return c.json({ success: false, error: 'estimated_departure_ms must be a future unix timestamp in milliseconds' }, 400);
  }

  const reason_details = typeof body['reason_details'] === 'string' ? body['reason_details'] : null;

  try {
    const trip = await db.prepare(
      `SELECT t.id, t.operator_id, t.route_id, t.departure_time, t.state, r.origin, r.destination
       FROM trips t JOIN routes r ON r.id = t.route_id
       WHERE t.id = ? AND t.deleted_at IS NULL`
    ).bind(tripId).first<{ id: string; operator_id: string; route_id: string; departure_time: number; state: string; origin: string; destination: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    if (trip.state === 'completed' || trip.state === 'cancelled') {
      return c.json({ success: false, error: 'trip_not_active', message: `Cannot file delay on a ${trip.state} trip` }, 422);
    }

    await db.prepare(
      `UPDATE trips SET delay_reason_code = ?, delay_reported_at = ?, estimated_departure_ms = ?, updated_at = ? WHERE id = ?`
    ).bind(reason_code, now, estimated_departure_ms, now, tripId).run();

    // Count affected bookings for event payload
    const countRow = await db.prepare(
      `SELECT COUNT(*) as cnt FROM bookings WHERE trip_id = ? AND status = 'confirmed' AND deleted_at IS NULL`
    ).bind(tripId).first<{ cnt: number }>();

    const departureDate = new Date(trip.departure_time).toLocaleDateString('en-NG', {
      weekday: 'short', day: 'numeric', month: 'short',
    });

    try {
      await publishEvent(db, {
        event_type: 'trip:DELAYED',
        aggregate_id: tripId,
        aggregate_type: 'trip',
        payload: {
          trip_id: tripId,
          operator_id: trip.operator_id,
          origin: trip.origin,
          destination: trip.destination,
          departure_date: departureDate,
          reason_code,
          reason_details,
          estimated_departure_ms,
          affected_booking_count: countRow?.cnt ?? 0,
        },
        tenant_id: trip.operator_id,
        timestamp: now,
      });
    } catch { /* non-fatal */ }

    return c.json({
      success: true,
      data: { trip_id: tripId, reason_code, reason_details, delay_reported_at: now, estimated_departure_ms, affected_booking_count: countRow?.cnt ?? 0 },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to report delay' }, 500);
  }
});

// ============================================================
// P05-T6: GET /trips/:id/delay — get delay info (STAFF+)
// ============================================================
operatorManagementRouter.get('/trips/:id/delay', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'DRIVER']), async (c) => {
  const tripId = c.req.param('id');
  const db = c.env.DB;

  try {
    const row = await db.prepare(
      `SELECT delay_reason_code, delay_reported_at, estimated_departure_ms FROM trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(tripId).first<{ delay_reason_code: string | null; delay_reported_at: number | null; estimated_departure_ms: number | null }>();

    if (!row) return c.json({ success: false, error: 'Trip not found' }, 404);
    if (!row.delay_reason_code) return c.json({ success: true, data: null });

    return c.json({ success: true, data: row });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch delay info' }, 500);
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
operatorManagementRouter.get('/reports/revenue', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), requireTierFeature('analytics'), async (c) => {
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

  // Agent breakdown query — revenue per agent
  const agentBreakdownParams: unknown[] = ['completed', fromMs, toMs];
  let agentBreakdownQuery = `SELECT st.agent_id,
      a.name as agent_name,
      SUM(st.total_amount) as total_kobo,
      COUNT(st.id) as transaction_count
    FROM sales_transactions st
    LEFT JOIN agents a ON a.id = st.agent_id
    WHERE st.payment_status = ? AND st.created_at >= ? AND st.created_at <= ? AND st.deleted_at IS NULL`;
  if (operatorId) {
    agentBreakdownQuery += ` AND st.agent_id IN (SELECT id FROM agents WHERE operator_id = ? AND deleted_at IS NULL)`;
    agentBreakdownParams.push(operatorId);
  }
  agentBreakdownQuery += ` GROUP BY st.agent_id ORDER BY total_kobo DESC LIMIT 20`;

  try {
    const [bookingRows, agentRows, routeResult, agentBreakdownResult] = await Promise.all([
      db.prepare(bookingQuery).bind(...bookingBindParams).all<{ total_amount: number }>(),
      db.prepare(agentQuery).bind(...agentBindParams).all<{ total_amount: number }>(),
      db.prepare(routeQuery).bind(...routeBindParams).all<{ route_id: string; origin: string; destination: string; trip_count: number }>(),
      db.prepare(agentBreakdownQuery).bind(...agentBreakdownParams).all<{ agent_id: string; agent_name: string | null; total_kobo: number; transaction_count: number }>(),
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
        agent_breakdown: agentBreakdownResult.results,
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

// ============================================================
// C-008: PATCH /users/:id/role — Admin Promotion API
// SUPER_ADMIN only. Promotes/demotes an agent or customer's role.
// Cannot promote to SUPER_ADMIN via this endpoint.
// ============================================================

operatorManagementRouter.patch('/users/:id/role', requireRole(['SUPER_ADMIN']), async (c) => {
  const userId = c.req.param('id');
  const db = c.env.DB;
  const now = Date.now();

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const role = body['role'] as string | undefined;
  const newOperatorId = body['operator_id'] as string | undefined;

  if (!role) return c.json({ success: false, error: 'role is required' }, 400);

  // Cannot self-promote to SUPER_ADMIN via API
  const PROMOTABLE_ROLES = ['CUSTOMER', 'STAFF', 'SUPERVISOR', 'TENANT_ADMIN', 'DRIVER', 'AGENT'];
  if (!PROMOTABLE_ROLES.includes(role)) {
    return c.json({ success: false, error: `Cannot promote to '${role}' via this endpoint` }, 403);
  }

  try {
    // Try agents table first, then customers
    const agent = await db.prepare(
      `SELECT id, role FROM agents WHERE id = ? AND deleted_at IS NULL`
    ).bind(userId).first<{ id: string; role: string }>();

    if (agent) {
      await db.prepare(
        `UPDATE agents SET role = ?, operator_id = COALESCE(?, operator_id), updated_at = ? WHERE id = ?`
      ).bind(role, newOperatorId ?? null, now, userId).run();
    } else {
      const customer = await db.prepare(
        `SELECT id FROM customers WHERE id = ? AND deleted_at IS NULL`
      ).bind(userId).first<{ id: string }>();

      if (!customer) return c.json({ success: false, error: 'User not found' }, 404);

      // Promote customer to agent if needed
      if (newOperatorId && (role === 'STAFF' || role === 'SUPERVISOR' || role === 'TENANT_ADMIN')) {
        const agentId = genId('agt');
        const customerData = await db.prepare(
          `SELECT name, phone, email FROM customers WHERE id = ?`
        ).bind(userId).first<{ name: string; phone: string; email: string | null }>();

        if (customerData) {
          await db.prepare(
            `INSERT OR IGNORE INTO agents (id, operator_id, name, phone, email, role, bus_parks, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, '[]', 'active', ?, ?)`
          ).bind(agentId, newOperatorId, customerData.name, customerData.phone, customerData.email, role, now, now).run();
        }
      }
    }

    const evtId = genId('evt');
    await db.prepare(
      `INSERT OR IGNORE INTO platform_events
       (id, event_type, aggregate_id, aggregate_type, payload, status, created_at)
       VALUES (?, 'user:ROLE_CHANGED', ?, 'user', ?, 'pending', ?)`
    ).bind(
      evtId, userId,
      JSON.stringify({ user_id: userId, new_role: role, operator_id: newOperatorId, changed_at: now }),
      now
    ).run();

    return c.json({ success: true, data: { user_id: userId, role, updated_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to update user role' }, 500);
  }
});

// ============================================================
// P03-T1: GET /operator/config — read operator runtime config
// ============================================================
operatorManagementRouter.get('/config', async (c) => {
  const user = c.get('user');
  const operatorId = user?.operatorId ?? '';
  if (!operatorId) return c.json({ success: false, error: 'Operator context required' }, 400);

  const config = await getOperatorConfig(c.env, operatorId);
  return c.json({ success: true, data: config });
});

// ============================================================
// P03-T1: PUT /operator/config — write operator runtime config
// TENANT_ADMIN+ required
// ============================================================
operatorManagementRouter.put('/config', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const user = c.get('user');
  const operatorId = user?.operatorId ?? '';
  if (!operatorId) return c.json({ success: false, error: 'Operator context required' }, 400);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const validationError = validateOperatorConfig(body);
  if (validationError) return c.json({ success: false, error: validationError }, 400);

  if (!c.env.TENANT_CONFIG_KV) {
    return c.json({ success: false, error: 'Config storage not available' }, 503);
  }

  const db = c.env.DB;
  const now = Date.now();

  await c.env.TENANT_CONFIG_KV.put(operatorId, JSON.stringify(body));

  try {
    await publishEvent(db, {
      event_type: 'operator.config_updated',
      aggregate_id: operatorId,
      aggregate_type: 'operator',
      payload: { operator_id: operatorId, updated_at: now, updated_by: user?.id },
      tenant_id: operatorId,
      timestamp: now,
    });
  } catch { /* non-fatal */ }

  return c.json({ success: true, data: body });
});

// ============================================================
// P09-T1: POST /vehicles/:id/maintenance — log a maintenance record
// ============================================================
operatorManagementRouter.post('/vehicles/:id/maintenance', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const vehicleId = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const err = requireFields(body, ['service_type', 'service_date_ms']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { service_type, service_date_ms, next_service_due_ms, notes } = body as {
    service_type: string; service_date_ms: number;
    next_service_due_ms?: number; notes?: string;
  };

  // T1.1: Validate types
  if (typeof service_type !== 'string' || service_type.trim() === '') {
    return c.json({ success: false, error: 'service_type must be a non-empty string' }, 400);
  }
  if (typeof service_date_ms !== 'number' || !Number.isInteger(service_date_ms) || service_date_ms <= 0) {
    return c.json({ success: false, error: 'service_date_ms must be a positive integer (unix ms)' }, 400);
  }
  if (next_service_due_ms !== undefined && (typeof next_service_due_ms !== 'number' || !Number.isInteger(next_service_due_ms) || next_service_due_ms <= 0)) {
    return c.json({ success: false, error: 'next_service_due_ms must be a positive integer (unix ms)' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  const vehicle = await db.prepare(
    `SELECT id, operator_id, plate_number FROM vehicles WHERE id = ? AND deleted_at IS NULL`
  ).bind(vehicleId).first<{ id: string; operator_id: string; plate_number: string }>();
  if (!vehicle) return c.json({ success: false, error: 'Vehicle not found' }, 404);

  const user = c.get('user');
  // T1.10: Tenant ownership guard
  if (user?.role !== 'SUPER_ADMIN' && user?.operatorId && vehicle.operator_id !== user.operatorId) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }
  const id = genId('mnt');
  await db.prepare(
    `INSERT INTO vehicle_maintenance_records (id, vehicle_id, operator_id, service_type, service_date, next_service_due, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, vehicleId, vehicle.operator_id, service_type, service_date_ms, next_service_due_ms ?? null, notes ?? null, user?.id ?? 'system', now).run();

  // Immediately notify if next service is due within 7 days
  if (next_service_due_ms && next_service_due_ms < now + 7 * 86_400_000) {
    try {
      await publishEvent(db, {
        event_type: 'vehicle.maintenance_due_soon',
        aggregate_id: vehicleId,
        aggregate_type: 'vehicle',
        payload: { vehicle_id: vehicleId, plate_number: vehicle.plate_number, operator_id: vehicle.operator_id, next_service_due_ms },
        tenant_id: vehicle.operator_id,
        timestamp: now,
      });
    } catch { /* non-fatal */ }
  }

  return c.json({
    success: true,
    data: { id, vehicle_id: vehicleId, operator_id: vehicle.operator_id, service_type, service_date_ms, next_service_due_ms: next_service_due_ms ?? null, notes: notes ?? null, created_at: now },
  }, 201);
});

// ============================================================
// P09-T1: GET /vehicles/:id/maintenance — list maintenance records
// ============================================================
operatorManagementRouter.get('/vehicles/:id/maintenance', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const vehicleId = c.req.param('id');
  const db = c.env.DB;
  const user = c.get('user');
  try {
    // T1.10: Tenant ownership guard — verify vehicle belongs to authenticated operator
    const vehicle = await db.prepare(
      `SELECT id, operator_id FROM vehicles WHERE id = ? AND deleted_at IS NULL`
    ).bind(vehicleId).first<{ id: string; operator_id: string }>();
    if (!vehicle) return c.json({ success: false, error: 'Vehicle not found' }, 404);
    if (user?.role !== 'SUPER_ADMIN' && user?.operatorId && vehicle.operator_id !== user.operatorId) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }

    const records = await db.prepare(
      `SELECT * FROM vehicle_maintenance_records WHERE vehicle_id = ? ORDER BY service_date DESC LIMIT 20`
    ).bind(vehicleId).all();
    return c.json({ success: true, data: records.results });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch maintenance records' }, 500);
  }
});

// ============================================================
// P09-T1: POST /vehicles/:id/documents — upload a compliance document
// ============================================================
operatorManagementRouter.post('/vehicles/:id/documents', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const vehicleId = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const err = requireFields(body, ['doc_type', 'expires_at_ms']);
  if (err) return c.json({ success: false, error: err }, 400);

  const VALID_DOC_TYPES = ['roadworthiness', 'insurance', 'frsc_approval', 'nafdac'];
  const { doc_type, doc_number, issued_at_ms, expires_at_ms } = body as {
    doc_type: string; doc_number?: string; issued_at_ms?: number; expires_at_ms: number;
  };
  if (!VALID_DOC_TYPES.includes(doc_type)) {
    return c.json({ success: false, error: `doc_type must be one of: ${VALID_DOC_TYPES.join(', ')}` }, 400);
  }
  if (typeof expires_at_ms !== 'number' || !Number.isInteger(expires_at_ms) || expires_at_ms <= 0) {
    return c.json({ success: false, error: 'expires_at_ms must be a positive integer (unix ms)' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const user = c.get('user');

  const vehicle = await db.prepare(
    `SELECT id, operator_id FROM vehicles WHERE id = ? AND deleted_at IS NULL`
  ).bind(vehicleId).first<{ id: string; operator_id: string }>();
  if (!vehicle) return c.json({ success: false, error: 'Vehicle not found' }, 404);
  // T1.10: Tenant ownership guard
  if (user?.role !== 'SUPER_ADMIN' && user?.operatorId && vehicle.operator_id !== user.operatorId) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  const id = genId('vdc');
  await db.prepare(
    `INSERT INTO vehicle_documents (id, vehicle_id, operator_id, doc_type, doc_number, issued_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, vehicleId, vehicle.operator_id, doc_type, doc_number ?? null, issued_at_ms ?? null, expires_at_ms, now).run();

  return c.json({
    success: true,
    data: { id, vehicle_id: vehicleId, operator_id: vehicle.operator_id, doc_type, doc_number: doc_number ?? null, issued_at_ms: issued_at_ms ?? null, expires_at_ms, created_at: now },
  }, 201);
});

// ============================================================
// P09-T1: GET /vehicles/:id/documents — list compliance documents with expiry status
// ============================================================
operatorManagementRouter.get('/vehicles/:id/documents', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const vehicleId = c.req.param('id');
  const db = c.env.DB;
  const user = c.get('user');
  const now = Date.now();
  const soonCutoff = now + 30 * 86_400_000;
  try {
    // T1.10: Tenant ownership guard
    const vehicle = await db.prepare(
      `SELECT id, operator_id FROM vehicles WHERE id = ? AND deleted_at IS NULL`
    ).bind(vehicleId).first<{ id: string; operator_id: string }>();
    if (!vehicle) return c.json({ success: false, error: 'Vehicle not found' }, 404);
    if (user?.role !== 'SUPER_ADMIN' && user?.operatorId && vehicle.operator_id !== user.operatorId) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }

    const rows = await db.prepare(
      `SELECT * FROM vehicle_documents WHERE vehicle_id = ? ORDER BY expires_at ASC`
    ).bind(vehicleId).all<{ id: string; expires_at: number; [k: string]: unknown }>();
    const data = rows.results.map(doc => ({
      ...doc,
      expiry_status: doc.expires_at < now ? 'expired' : doc.expires_at < soonCutoff ? 'expiring_soon' : 'valid',
    }));
    return c.json({ success: true, data });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch vehicle documents' }, 500);
  }
});

// ============================================================
// P09-T2: POST /drivers/:id/documents — upload a driver compliance document
// ============================================================
operatorManagementRouter.post('/drivers/:id/documents', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const driverId = c.req.param('id');
  let body: Record<string, unknown>;
  try { body = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const err = requireFields(body, ['doc_type', 'expires_at_ms']);
  if (err) return c.json({ success: false, error: err }, 400);

  const VALID_DRIVER_DOC_TYPES = ['drivers_license', 'frsc_cert', 'medical_cert'];
  const { doc_type, doc_number, license_category, issued_at_ms, expires_at_ms } = body as {
    doc_type: string; doc_number?: string; license_category?: string;
    issued_at_ms?: number; expires_at_ms: number;
  };
  if (!VALID_DRIVER_DOC_TYPES.includes(doc_type)) {
    return c.json({ success: false, error: `doc_type must be one of: ${VALID_DRIVER_DOC_TYPES.join(', ')}` }, 400);
  }
  if (typeof expires_at_ms !== 'number' || !Number.isInteger(expires_at_ms) || expires_at_ms <= 0) {
    return c.json({ success: false, error: 'expires_at_ms must be a positive integer (unix ms)' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const user = c.get('user');

  const driver = await db.prepare(
    `SELECT id, operator_id FROM drivers WHERE id = ? AND deleted_at IS NULL`
  ).bind(driverId).first<{ id: string; operator_id: string }>();
  if (!driver) return c.json({ success: false, error: 'Driver not found' }, 404);
  // T2.5: Tenant ownership guard
  if (user?.role !== 'SUPER_ADMIN' && user?.operatorId && driver.operator_id !== user.operatorId) {
    return c.json({ success: false, error: 'Forbidden' }, 403);
  }

  const id = genId('ddc');
  await db.prepare(
    `INSERT INTO driver_documents (id, driver_id, operator_id, doc_type, doc_number, license_category, issued_at, expires_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, driverId, driver.operator_id, doc_type, doc_number ?? null, license_category ?? null, issued_at_ms ?? null, expires_at_ms, now).run();

  return c.json({
    success: true,
    data: { id, driver_id: driverId, operator_id: driver.operator_id, doc_type, doc_number: doc_number ?? null, license_category: license_category ?? null, issued_at_ms: issued_at_ms ?? null, expires_at_ms, created_at: now },
  }, 201);
});

// ============================================================
// P09-T2: GET /drivers/:id/documents — list driver compliance documents with expiry status
// ============================================================
operatorManagementRouter.get('/drivers/:id/documents', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const driverId = c.req.param('id');
  const db = c.env.DB;
  const user = c.get('user');
  const now = Date.now();
  const soonCutoff = now + 30 * 86_400_000;
  try {
    // T2.5: Tenant ownership guard
    const driver = await db.prepare(
      `SELECT id, operator_id FROM drivers WHERE id = ? AND deleted_at IS NULL`
    ).bind(driverId).first<{ id: string; operator_id: string }>();
    if (!driver) return c.json({ success: false, error: 'Driver not found' }, 404);
    if (user?.role !== 'SUPER_ADMIN' && user?.operatorId && driver.operator_id !== user.operatorId) {
      return c.json({ success: false, error: 'Forbidden' }, 403);
    }

    const rows = await db.prepare(
      `SELECT * FROM driver_documents WHERE driver_id = ? ORDER BY expires_at ASC`
    ).bind(driverId).all<{ id: string; expires_at: number; [k: string]: unknown }>();
    const data = rows.results.map(doc => ({
      ...doc,
      expiry_status: doc.expires_at < now ? 'expired' : doc.expires_at < soonCutoff ? 'expiring_soon' : 'valid',
    }));
    return c.json({ success: true, data });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch driver documents' }, 500);
  }
});

// ============================================================
// P09-T3: GET /notifications — operator notification center (last 7 days, actionable types)
// ============================================================
const NOTIFICATION_EVENT_TYPES = [
  'trip:SOS_ACTIVATED',
  'agent.reconciliation_filed',
  'vehicle.maintenance_due_soon',
  'vehicle.document_expiring',
  'driver.document_expiring',
  'booking:ABANDONED',
  'payment:AMOUNT_MISMATCH',
  'trip:DELAYED',
  'booking:REFUNDED',
];

operatorManagementRouter.get('/notifications', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const operatorId = user?.operatorId ?? '';
  if (!operatorId) return c.json({ success: false, error: 'Operator context required' }, 400);

  const now = Date.now();
  const since = now - 7 * 86_400_000;
  const typePlaceholders = NOTIFICATION_EVENT_TYPES.map(() => '?').join(',');

  try {
    const events = await db.prepare(
      `SELECT pe.id, pe.event_type, pe.aggregate_id, pe.aggregate_type, pe.payload, pe.created_at,
              nr.read_at
       FROM platform_events pe
       LEFT JOIN notification_reads nr ON nr.event_id = pe.id AND nr.user_id = ?
       WHERE pe.tenant_id = ?
         AND pe.created_at > ?
         AND pe.event_type IN (${typePlaceholders})
       ORDER BY pe.created_at DESC
       LIMIT 50`
    ).bind(user?.id ?? '', operatorId, since, ...NOTIFICATION_EVENT_TYPES).all<{
      id: string; event_type: string; aggregate_id: string; aggregate_type: string;
      payload: string; created_at: number; read_at: number | null;
    }>();

    const notifications = events.results.map(e => ({
      ...e,
      payload: (() => { try { return JSON.parse(e.payload) as unknown; } catch { return e.payload; } })(),
      is_read: e.read_at !== null,
    }));

    const unread_count = notifications.filter(n => !n.is_read).length;

    return c.json({ success: true, data: { notifications, unread_count } });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch notifications' }, 500);
  }
});

// ============================================================
// P09-T3: POST /notifications/:eventId/read — mark a notification as read
// ============================================================
operatorManagementRouter.post('/notifications/:eventId/read', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const eventId = c.req.param('eventId');
  const db = c.env.DB;
  const user = c.get('user');
  const now = Date.now();

  try {
    await db.prepare(
      `INSERT OR IGNORE INTO notification_reads (event_id, user_id, read_at) VALUES (?, ?, ?)`
    ).bind(eventId, user?.id ?? '', now).run();
    return c.json({ success: true, data: { event_id: eventId, read_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to mark notification as read' }, 500);
  }
});

// ============================================================
// P10-T2: GET /dispatch — Dispatcher Dashboard
// SUPERVISOR+ only: returns active trips with driver, vehicle,
// GPS location, seat counts, and manifest summary.
// ============================================================
operatorManagementRouter.get('/dispatch', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR']), async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const operatorId = user?.operatorId ?? null;

  try {
    let query = `
      SELECT
        t.id, t.state, t.departure_time, t.operator_id,
        r.origin, r.destination,
        v.plate_number, v.model, v.total_seats,
        d.id as driver_id, d.name as driver_name, d.phone as driver_phone,
        tl.latitude, tl.longitude, tl.recorded_at as location_recorded_at,
        COUNT(DISTINCT s.id) as total_seat_count,
        COUNT(DISTINCT CASE WHEN s.status = 'available' THEN s.id END) as available_seats,
        COUNT(DISTINCT CASE WHEN s.status = 'confirmed' THEN s.id END) as confirmed_seats,
        COUNT(DISTINCT CASE WHEN s.status = 'reserved' THEN s.id END) as reserved_seats,
        COUNT(DISTINCT CASE WHEN b.status = 'confirmed' THEN b.id END) as confirmed_bookings
      FROM trips t
      JOIN routes r ON r.id = t.route_id
      LEFT JOIN vehicles v ON v.id = t.vehicle_id AND v.deleted_at IS NULL
      LEFT JOIN drivers d ON d.id = t.driver_id AND d.deleted_at IS NULL
      LEFT JOIN trip_locations tl ON tl.trip_id = t.id
      LEFT JOIN seats s ON s.trip_id = t.id
      LEFT JOIN bookings b ON b.trip_id = t.id AND b.deleted_at IS NULL
      WHERE t.deleted_at IS NULL
        AND t.state IN ('scheduled', 'boarding', 'in_transit')`;

    const params: unknown[] = [];
    if (user?.role !== 'SUPER_ADMIN' && operatorId) {
      query += ` AND t.operator_id = ?`;
      params.push(operatorId);
    }
    query += ` GROUP BY t.id ORDER BY t.departure_time ASC LIMIT 100`;

    const result = await db.prepare(query).bind(...params).all<{
      id: string; state: string; departure_time: number; operator_id: string;
      origin: string; destination: string;
      plate_number: string | null; model: string | null; total_seats: number | null;
      driver_id: string | null; driver_name: string | null; driver_phone: string | null;
      latitude: number | null; longitude: number | null; location_recorded_at: number | null;
      total_seat_count: number; available_seats: number; confirmed_seats: number;
      reserved_seats: number; confirmed_bookings: number;
    }>();

    const trips = result.results.map(t => ({
      id: t.id,
      state: t.state,
      departure_time: t.departure_time,
      operator_id: t.operator_id,
      origin: t.origin,
      destination: t.destination,
      vehicle: t.plate_number ? {
        plate_number: t.plate_number,
        model: t.model,
        total_seats: t.total_seats,
      } : null,
      driver: t.driver_id ? {
        id: t.driver_id,
        name: t.driver_name,
        phone: t.driver_phone,
      } : null,
      location: t.latitude !== null ? {
        latitude: t.latitude,
        longitude: t.longitude,
        recorded_at: t.location_recorded_at,
      } : null,
      seats: {
        total: t.total_seat_count,
        available: t.available_seats,
        confirmed: t.confirmed_seats,
        reserved: t.reserved_seats,
      },
      confirmed_bookings: t.confirmed_bookings,
    }));

    return c.json({ success: true, data: { trips, count: trips.length, as_of: Date.now() } });
  } catch (err: unknown) {
    console.error('[Dispatch] Error:', err instanceof Error ? err.message : String(err));
    return c.json({ success: false, error: 'Failed to fetch dispatch dashboard' }, 500);
  }
});

// ============================================================
// P10-T4: GET /reports — Grouped Revenue Analytics
// Supports: groupby=route|vehicle|driver|operator(SUPER_ADMIN)
// Date range: from/to as Unix ms; defaults to current month.
// Returns per-group: total_trips, confirmed_seats, fill_rate_pct,
//   gross_revenue_kobo, refunds_kobo, net_revenue_kobo, avg_fare_kobo
// ============================================================
operatorManagementRouter.get('/reports', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'SUPERVISOR']), async (c) => {
  const db = c.env.DB;
  const user = c.get('user');
  const operatorId = user?.operatorId ?? null;
  const q = c.req.query();

  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();
  const fromMs = q['from'] ? parseInt(q['from'], 10) : monthStart;
  const toMs = q['to'] ? parseInt(q['to'], 10) : now;
  const groupby = q['groupby'] ?? 'route';

  const VALID_GROUPBY = ['route', 'vehicle', 'driver', 'operator'];
  if (!VALID_GROUPBY.includes(groupby)) {
    return c.json({ success: false, error: `groupby must be one of: ${VALID_GROUPBY.join(', ')}` }, 400);
  }
  if (groupby === 'operator' && user?.role !== 'SUPER_ADMIN') {
    return c.json({ success: false, error: 'groupby=operator requires SUPER_ADMIN role' }, 403);
  }

  try {
    let rows: Array<{
      group_id: string; group_label: string;
      total_trips: number; total_capacity: number; confirmed_seats: number;
      gross_revenue_kobo: number; refunds_kobo: number;
    }>;

    if (groupby === 'route') {
      let sql = `
        SELECT
          r.id as group_id,
          (r.origin || ' → ' || r.destination) as group_label,
          COUNT(DISTINCT t.id) as total_trips,
          COALESCE(SUM(COALESCE(v.total_seats, 0)), 0) as total_capacity,
          COUNT(DISTINCT CASE WHEN s.status = 'confirmed' THEN s.id END) as confirmed_seats,
          COALESCE(SUM(CASE WHEN b.status = 'confirmed' AND b.deleted_at IS NULL THEN b.total_amount ELSE 0 END), 0) as gross_revenue_kobo,
          COALESCE(SUM(CASE WHEN b.deleted_at IS NULL THEN COALESCE(b.refund_amount_kobo, 0) ELSE 0 END), 0) as refunds_kobo
        FROM routes r
        LEFT JOIN trips t ON t.route_id = r.id AND t.deleted_at IS NULL
          AND t.departure_time BETWEEN ? AND ?
        LEFT JOIN vehicles v ON v.id = t.vehicle_id AND v.deleted_at IS NULL
        LEFT JOIN seats s ON s.trip_id = t.id
        LEFT JOIN bookings b ON b.trip_id = t.id
        WHERE r.deleted_at IS NULL`;
      const params: unknown[] = [fromMs, toMs];
      if (user?.role !== 'SUPER_ADMIN' && operatorId) { sql += ` AND r.operator_id = ?`; params.push(operatorId); }
      sql += ` GROUP BY r.id, r.origin, r.destination ORDER BY gross_revenue_kobo DESC LIMIT 50`;
      const res = await db.prepare(sql).bind(...params).all<typeof rows[0]>();
      rows = res.results;

    } else if (groupby === 'vehicle') {
      let sql = `
        SELECT
          v.id as group_id,
          (v.plate_number || ' (' || COALESCE(v.model, 'Unknown') || ')') as group_label,
          COUNT(DISTINCT t.id) as total_trips,
          COALESCE(SUM(COALESCE(v.total_seats, 0)), 0) as total_capacity,
          COUNT(DISTINCT CASE WHEN s.status = 'confirmed' THEN s.id END) as confirmed_seats,
          COALESCE(SUM(CASE WHEN b.status = 'confirmed' AND b.deleted_at IS NULL THEN b.total_amount ELSE 0 END), 0) as gross_revenue_kobo,
          COALESCE(SUM(CASE WHEN b.deleted_at IS NULL THEN COALESCE(b.refund_amount_kobo, 0) ELSE 0 END), 0) as refunds_kobo
        FROM vehicles v
        LEFT JOIN trips t ON t.vehicle_id = v.id AND t.deleted_at IS NULL
          AND t.departure_time BETWEEN ? AND ?
        LEFT JOIN seats s ON s.trip_id = t.id
        LEFT JOIN bookings b ON b.trip_id = t.id
        WHERE v.deleted_at IS NULL`;
      const params: unknown[] = [fromMs, toMs];
      if (user?.role !== 'SUPER_ADMIN' && operatorId) { sql += ` AND v.operator_id = ?`; params.push(operatorId); }
      sql += ` GROUP BY v.id, v.plate_number, v.model ORDER BY gross_revenue_kobo DESC LIMIT 50`;
      const res = await db.prepare(sql).bind(...params).all<typeof rows[0]>();
      rows = res.results;

    } else if (groupby === 'driver') {
      let sql = `
        SELECT
          d.id as group_id,
          d.name as group_label,
          COUNT(DISTINCT t.id) as total_trips,
          COALESCE(SUM(COALESCE(v.total_seats, 0)), 0) as total_capacity,
          COUNT(DISTINCT CASE WHEN s.status = 'confirmed' THEN s.id END) as confirmed_seats,
          COALESCE(SUM(CASE WHEN b.status = 'confirmed' AND b.deleted_at IS NULL THEN b.total_amount ELSE 0 END), 0) as gross_revenue_kobo,
          COALESCE(SUM(CASE WHEN b.deleted_at IS NULL THEN COALESCE(b.refund_amount_kobo, 0) ELSE 0 END), 0) as refunds_kobo
        FROM drivers d
        LEFT JOIN trips t ON t.driver_id = d.id AND t.deleted_at IS NULL
          AND t.departure_time BETWEEN ? AND ?
        LEFT JOIN vehicles v ON v.id = t.vehicle_id AND v.deleted_at IS NULL
        LEFT JOIN seats s ON s.trip_id = t.id
        LEFT JOIN bookings b ON b.trip_id = t.id
        WHERE d.deleted_at IS NULL`;
      const params: unknown[] = [fromMs, toMs];
      if (user?.role !== 'SUPER_ADMIN' && operatorId) { sql += ` AND d.operator_id = ?`; params.push(operatorId); }
      sql += ` GROUP BY d.id, d.name ORDER BY gross_revenue_kobo DESC LIMIT 50`;
      const res = await db.prepare(sql).bind(...params).all<typeof rows[0]>();
      rows = res.results;

    } else {
      // groupby=operator (SUPER_ADMIN only — already checked above)
      const res = await db.prepare(`
        SELECT
          o.id as group_id,
          o.name as group_label,
          COUNT(DISTINCT t.id) as total_trips,
          COALESCE(SUM(COALESCE(v.total_seats, 0)), 0) as total_capacity,
          COUNT(DISTINCT CASE WHEN s.status = 'confirmed' THEN s.id END) as confirmed_seats,
          COALESCE(SUM(CASE WHEN b.status = 'confirmed' AND b.deleted_at IS NULL THEN b.total_amount ELSE 0 END), 0) as gross_revenue_kobo,
          COALESCE(SUM(CASE WHEN b.deleted_at IS NULL THEN COALESCE(b.refund_amount_kobo, 0) ELSE 0 END), 0) as refunds_kobo
        FROM operators o
        LEFT JOIN trips t ON t.operator_id = o.id AND t.deleted_at IS NULL
          AND t.departure_time BETWEEN ? AND ?
        LEFT JOIN vehicles v ON v.id = t.vehicle_id AND v.deleted_at IS NULL
        LEFT JOIN seats s ON s.trip_id = t.id
        LEFT JOIN bookings b ON b.trip_id = t.id
        WHERE o.deleted_at IS NULL AND o.status = 'active'
        GROUP BY o.id, o.name
        ORDER BY gross_revenue_kobo DESC LIMIT 50
      `).bind(fromMs, toMs).all<typeof rows[0]>();
      rows = res.results;
    }

    const data = rows.map(r => {
      const netRev = r.gross_revenue_kobo - r.refunds_kobo;
      const fillRate = r.total_capacity > 0
        ? Math.round((r.confirmed_seats / r.total_capacity) * 1000) / 10
        : 0;
      const avgFare = r.total_trips > 0
        ? Math.round(r.gross_revenue_kobo / r.total_trips)
        : 0;
      return {
        group_id: r.group_id,
        group_label: r.group_label,
        total_trips: r.total_trips,
        confirmed_seats: r.confirmed_seats,
        fill_rate_pct: fillRate,
        gross_revenue_kobo: r.gross_revenue_kobo,
        refunds_kobo: r.refunds_kobo,
        net_revenue_kobo: netRev,
        avg_fare_kobo: avgFare,
      };
    });

    return c.json({
      success: true,
      data: {
        groupby,
        from_ms: fromMs,
        to_ms: toMs,
        items: data,
        total_items: data.length,
        generated_at: Date.now(),
      },
    });
  } catch (err: unknown) {
    console.error('[Reports] Error:', err instanceof Error ? err.message : String(err));
    return c.json({ success: false, error: 'Failed to generate revenue report' }, 500);
  }
});

// ============================================================
// P11-T1: Operator API Keys Management
// ============================================================

operatorManagementRouter.post('/api-keys', requireRole(['TENANT_ADMIN']), requireTierFeature('api_keys'), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['name', 'scope']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { name, scope } = body as { name: string; scope: string };
  if (!['read', 'read_write'].includes(scope)) {
    return c.json({ success: false, error: 'scope must be "read" or "read_write"' }, 400);
  }

  const user = c.get('user');
  const tenantId = user?.operatorId;
  if (!tenantId) return c.json({ success: false, error: 'No operator context' }, 403);

  const db = c.env.DB;
  const now = Date.now();

  try {
    const rawKey = `waka_live_${nanoid('', 32)}`;
    const encoder = new TextEncoder();
    const data = encoder.encode(rawKey);
    const hashBuffer = await crypto.subtle.digest('SHA-256', data);
    const hashArray = Array.from(new Uint8Array(hashBuffer));
    const keyHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

    const id = nanoid('key', 16);
    await db.prepare(
      `INSERT INTO api_keys (id, operator_id, name, key_hash, scope, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, tenantId, name, keyHash, scope, user.id, now).run();

    return c.json({
      success: true,
      warning: 'Save this key now. It will never be shown again.',
      data: { id, name, scope, key: rawKey, created_at: now },
    }, 201);
  } catch (e: unknown) {
    console.error('[ApiKeys] Create error:', e instanceof Error ? e.message : String(e));
    return c.json({ success: false, error: 'Failed to create API key' }, 500);
  }
});

operatorManagementRouter.get('/api-keys', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;

  try {
    let query = `SELECT id, operator_id, name, scope, created_at, last_used_at, revoked_at
                 FROM api_keys WHERE deleted_at IS NULL`;
    const params: unknown[] = [];

    if (user?.role !== 'SUPER_ADMIN') {
      const tenantId = user?.operatorId;
      if (!tenantId) return c.json({ success: false, error: 'No operator context' }, 403);
      query += ` AND operator_id = ?`;
      params.push(tenantId);
    }

    query += ` ORDER BY created_at DESC`;
    const result = await db.prepare(query).bind(...params).all<{
      id: string; operator_id: string; name: string; scope: string;
      created_at: number; last_used_at: number | null; revoked_at: number | null;
    }>();

    return c.json({ success: true, data: result.results });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch API keys' }, 500);
  }
});

operatorManagementRouter.delete('/api-keys/:id', requireRole(['TENANT_ADMIN']), async (c) => {
  const keyId = c.req.param('id');
  const user = c.get('user');
  const tenantId = user?.operatorId;
  if (!tenantId) return c.json({ success: false, error: 'No operator context' }, 403);

  const db = c.env.DB;
  const now = Date.now();

  try {
    const key = await db.prepare(
      `SELECT id FROM api_keys WHERE id = ? AND operator_id = ? AND deleted_at IS NULL`
    ).bind(keyId, tenantId).first<{ id: string }>();
    if (!key) return c.json({ success: false, error: 'API key not found' }, 404);

    await db.prepare(
      `UPDATE api_keys SET revoked_at = ? WHERE id = ? AND operator_id = ?`
    ).bind(now, keyId, tenantId).run();

    return new Response(null, { status: 204 });
  } catch {
    return c.json({ success: false, error: 'Failed to revoke API key' }, 500);
  }
});

// ============================================================
// P11-T2: PATCH /operator/profile — update operator profile
// ============================================================

operatorManagementRouter.patch('/profile', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const user = c.get('user');
  const db = c.env.DB;
  const now = Date.now();

  const operatorId = user?.role === 'SUPER_ADMIN'
    ? (c.req.query('operator_id') ?? user.operatorId)
    : user?.operatorId;
  if (!operatorId) return c.json({ success: false, error: 'No operator context' }, 403);

  const body = await c.req.json() as Record<string, unknown>;
  const { name, address, contact_phone, cac_number, firs_tin } = body as {
    name?: string; address?: string; contact_phone?: string;
    cac_number?: string; firs_tin?: string;
  };

  try {
    const op = await db.prepare(
      `SELECT id FROM operators WHERE id = ? AND deleted_at IS NULL`
    ).bind(operatorId).first<{ id: string }>();
    if (!op) return c.json({ success: false, error: 'Operator not found' }, 404);

    await db.prepare(
      `UPDATE operators
       SET name = COALESCE(?, name),
           address = COALESCE(?, address),
           contact_phone = COALESCE(?, contact_phone),
           cac_number = COALESCE(?, cac_number),
           firs_tin = COALESCE(?, firs_tin),
           updated_at = ?
       WHERE id = ?`
    ).bind(
      name ?? null, address ?? null, contact_phone ?? null,
      cac_number ?? null, firs_tin ?? null, now, operatorId
    ).run();

    return c.json({ success: true, data: { id: operatorId, updated_at: now } });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes('no such column')) {
      return c.json({ success: true, data: { id: operatorId, updated_at: now } });
    }
    return c.json({ success: false, error: 'Failed to update profile' }, 500);
  }
});

// ============================================================
// P15-T5: POST /schedules — create a recurring trip schedule (auto_schedule tier)
// Body: { route_id, vehicle_id?, driver_id?, departure_time, recurrence?, recurrence_days?, horizon_days? }
// ============================================================
operatorManagementRouter.post('/schedules', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), requireTierFeature('auto_schedule'), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['route_id', 'departure_time']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { route_id, vehicle_id, driver_id, departure_time, recurrence, recurrence_days, horizon_days } = body as {
    route_id: string; vehicle_id?: string; driver_id?: string; departure_time: string;
    recurrence?: string; recurrence_days?: string; horizon_days?: number;
  };

  const db = c.env.DB;
  const jwtUser = c.get('user');
  if (!jwtUser) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const now = Date.now();

  const operatorRow = await db.prepare(
    `SELECT id FROM operators WHERE id = ? AND deleted_at IS NULL`
  ).bind(jwtUser.operatorId ?? '').first<{ id: string }>();
  if (!operatorRow) return c.json({ success: false, error: 'Operator not found' }, 404);

  const route = await db.prepare(
    `SELECT id FROM routes WHERE id = ? AND operator_id = ? AND deleted_at IS NULL`
  ).bind(route_id, operatorRow.id).first<{ id: string }>();
  if (!route) return c.json({ success: false, error: 'Route not found or not owned by operator' }, 404);

  const id = genId('sched');
  try {
    await db.prepare(
      `INSERT INTO schedules (id, operator_id, route_id, vehicle_id, driver_id, departure_time, recurrence, recurrence_days, horizon_days, active, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?)`
    ).bind(
      id, operatorRow.id, route_id,
      vehicle_id ?? null, driver_id ?? null,
      departure_time,
      recurrence ?? 'daily',
      recurrence_days ?? null,
      horizon_days ?? 30,
      now,
    ).run();

    return c.json({
      success: true,
      data: { id, operator_id: operatorRow.id, route_id, vehicle_id: vehicle_id ?? null, driver_id: driver_id ?? null, departure_time, recurrence: recurrence ?? 'daily', recurrence_days: recurrence_days ?? null, horizon_days: horizon_days ?? 30, active: true, created_at: now },
    }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to create schedule' }, 500);
  }
});

// ============================================================
// P15-T5: GET /branding — fetch own operator branding (TENANT_ADMIN+)
// Returns primary_color, secondary_color, brand_name, logo_url, tagline
// Used by frontend post-login to apply white-label CSS variables
// Mounted at /api/operator/branding
// ============================================================
operatorManagementRouter.get('/branding', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const jwtUser = c.get('user');
  if (!jwtUser) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const operatorId = jwtUser.operatorId ?? '';

  if (!c.env.TENANT_CONFIG_KV) {
    return c.json({ success: true, data: null });
  }

  try {
    const raw = await c.env.TENANT_CONFIG_KV.get(`branding:${operatorId}`);
    if (!raw) return c.json({ success: true, data: null });
    return c.json({ success: true, data: JSON.parse(raw) });
  } catch {
    return c.json({ success: true, data: null });
  }
});

// ============================================================
// P15-T5: PUT /config/branding — white-label branding config (white_label tier)
// Body: { primary_color, secondary_color, logo_url?, brand_name, tagline? }
// Stored in TENANT_CONFIG_KV under key: branding:{operatorId}
// ============================================================
operatorManagementRouter.put('/config/branding', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), requireTierFeature('white_label'), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['primary_color', 'brand_name']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { primary_color, secondary_color, logo_url, brand_name, tagline } = body as {
    primary_color: string; secondary_color?: string; logo_url?: string;
    brand_name: string; tagline?: string;
  };

  const jwtUser = c.get('user');
  if (!jwtUser) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const operatorId = jwtUser.operatorId ?? '';

  const hexColorRegex = /^#[0-9A-Fa-f]{6}$/;
  if (!hexColorRegex.test(primary_color)) {
    return c.json({ success: false, error: 'primary_color must be a valid hex color (e.g., #FF6B00)' }, 400);
  }
  if (secondary_color && !hexColorRegex.test(secondary_color)) {
    return c.json({ success: false, error: 'secondary_color must be a valid hex color (e.g., #1A1A1A)' }, 400);
  }

  const branding = { primary_color, secondary_color: secondary_color ?? null, logo_url: logo_url ?? null, brand_name, tagline: tagline ?? null, updated_at: Date.now() };

  if (!c.env.TENANT_CONFIG_KV) {
    return c.json({ success: false, error: 'Branding store unavailable' }, 503);
  }

  await c.env.TENANT_CONFIG_KV.put(`branding:${operatorId}`, JSON.stringify(branding));

  return c.json({ success: true, data: branding });
});

// ============================================================
// P15-T5: POST /config/logo — upload operator logo to R2 and store URL
// Body: multipart/form-data with file field "logo"
// Stored in ASSETS_R2; URL returned and saved in branding KV config
// ============================================================
operatorManagementRouter.post('/config/logo', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), requireTierFeature('white_label'), async (c) => {
  const jwtUser = c.get('user');
  if (!jwtUser) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const operatorId = jwtUser.operatorId ?? '';

  const formData = await c.req.formData().catch(() => null);
  if (!formData) return c.json({ success: false, error: 'Expected multipart/form-data' }, 400);

  const file = formData.get('logo');
  if (!file || !(file instanceof File)) return c.json({ success: false, error: 'logo file is required' }, 400);

  if (!c.env.ASSETS_R2) return c.json({ success: false, error: 'Asset storage unavailable' }, 503);

  // Only PNG and JPEG are allowed for logos (SVG/WebP excluded for XSS/compat safety)
  const allowedTypes = ['image/png', 'image/jpeg'];
  if (!allowedTypes.includes(file.type)) {
    return c.json({ success: false, error: `Unsupported media type: ${file.type}. Only image/png and image/jpeg are accepted.` }, 415);
  }

  // File size limit: 2MB
  const MAX_LOGO_BYTES = 2 * 1024 * 1024;
  if (file.size > MAX_LOGO_BYTES) {
    return c.json({ success: false, error: `Logo file too large (${(file.size / 1024 / 1024).toFixed(1)}MB). Maximum is 2MB.` }, 413);
  }

  if (file.size === 0) {
    return c.json({ success: false, error: 'Logo file is empty' }, 400);
  }

  const ext = file.type === 'image/png' ? 'png' : 'jpg';
  const key = `logos/${operatorId}/logo.${ext}`;
  const bytes = await file.arrayBuffer();

  await c.env.ASSETS_R2.put(key, bytes, { httpMetadata: { contentType: file.type } });

  const logoUrl = `https://assets.webwaka.ng/${key}`;

  // Update branding KV if it exists
  if (c.env.TENANT_CONFIG_KV) {
    const existing = await c.env.TENANT_CONFIG_KV.get(`branding:${operatorId}`);
    const current = existing ? JSON.parse(existing) as Record<string, unknown> : {};
    await c.env.TENANT_CONFIG_KV.put(`branding:${operatorId}`, JSON.stringify({ ...current, logo_url: logoUrl, updated_at: Date.now() }));
  }

  return c.json({ success: true, data: { logo_url: logoUrl, key } });
});

// ============================================================
// P15-T5: Bulk CSV Import (bulk_import tier)
// POST /import/routes   — multipart/form-data, field 'file', CSV: origin,destination,base_fare_naira,duration_minutes[,distance_km]
// POST /import/vehicles — multipart/form-data, field 'file', CSV: plate_number,vehicle_type[,model,total_seats]
// POST /import/drivers  — multipart/form-data, field 'file', CSV: name,phone[,license_number]
//
// Response: { created: string[], skipped: number, errors: Array<{ row, column?, reason }> }
// Max 500 data rows per import; rows 501+ are ignored with a note.
// ============================================================

/** Parse a CSV text string into array of row objects keyed by header column name. */
function parseCsvFile(text: string): { headers: string[]; rows: Record<string, string>[] } {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n').filter(l => l.trim() !== '');
  if (lines.length === 0) return { headers: [], rows: [] };

  const splitLine = (line: string): string[] => {
    const result: string[] = [];
    let cur = '';
    let inQuote = false;
    for (let i = 0; i < line.length; i++) {
      const ch = line[i];
      if (ch === '"') {
        if (inQuote && line[i + 1] === '"') { cur += '"'; i++; }
        else { inQuote = !inQuote; }
      } else if (ch === ',' && !inQuote) {
        result.push(cur.trim());
        cur = '';
      } else {
        cur += ch;
      }
    }
    result.push(cur.trim());
    return result;
  };

  const headers = splitLine(lines[0] ?? '').map(h => h.toLowerCase().replace(/\s+/g, '_'));
  const rows: Record<string, string>[] = [];
  for (let i = 1; i < lines.length; i++) {
    const cols = splitLine(lines[i] ?? '');
    const row: Record<string, string> = {};
    headers.forEach((h, idx) => { row[h] = cols[idx] ?? ''; });
    rows.push(row);
  }
  return { headers, rows };
}

/** Shared helper: read and parse a CSV file from multipart form data. */
async function readCsvFromFormData(c: HonoCtx): Promise<{ error: string; status: number } | { headers: string[]; rows: Record<string, string>[]; truncated: number }> {
  const formData = await c.req.formData().catch(() => null);
  if (!formData) return { error: 'Expected multipart/form-data with a "file" field', status: 400 };

  const file = formData.get('file');
  if (!file || !(file instanceof File)) return { error: 'file field is required', status: 400 };
  if (file.size === 0) return { error: 'Uploaded CSV file is empty', status: 400 };

  const MAX_CSV_BYTES = 5 * 1024 * 1024; // 5MB
  if (file.size > MAX_CSV_BYTES) return { error: 'CSV file too large (max 5MB)', status: 413 };

  const text = await file.text();
  const { headers, rows } = parseCsvFile(text);
  if (rows.length === 0) return { error: 'CSV file contains no data rows', status: 400 };

  const MAX_ROWS = 500;
  const truncated = Math.max(0, rows.length - MAX_ROWS);
  return { headers, rows: rows.slice(0, MAX_ROWS), truncated };
}

operatorManagementRouter.post('/import/routes', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), requireTierFeature('bulk_import'), async (c) => {
  const csvResult = await readCsvFromFormData(c);
  if ('error' in csvResult) return c.json({ success: false, error: csvResult.error }, csvResult.status as 400 | 413);

  const { headers, rows, truncated } = csvResult;

  // Validate required columns exist in header
  const REQUIRED_COLS = ['origin', 'destination', 'base_fare_naira'];
  const missingCols = REQUIRED_COLS.filter(col => !headers.includes(col));
  if (missingCols.length > 0) {
    return c.json({ success: false, error: `CSV missing required columns: ${missingCols.join(', ')}. Expected header: origin,destination,base_fare_naira,duration_minutes[,distance_km]` }, 400);
  }

  const jwtUser = c.get('user');
  if (!jwtUser) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const db = c.env.DB;

  const operatorRow = await db.prepare(
    `SELECT id FROM operators WHERE id = ? AND deleted_at IS NULL`
  ).bind(jwtUser.operatorId ?? '').first<{ id: string }>();
  if (!operatorRow) return c.json({ success: false, error: 'Operator not found' }, 404);

  const now = Date.now();
  const created: string[] = [];
  const errors: Array<{ row: number; column?: string; reason: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const origin = row['origin']?.trim();
    const destination = row['destination']?.trim();
    const base_fare_naira = parseFloat(row['base_fare_naira'] ?? '');
    const duration_minutes = parseInt(row['duration_minutes'] ?? '0', 10);
    const distance_km = parseFloat(row['distance_km'] ?? '0');

    if (!origin) { errors.push({ row: i + 2, column: 'origin', reason: 'origin is required' }); continue; }
    if (!destination) { errors.push({ row: i + 2, column: 'destination', reason: 'destination is required' }); continue; }
    if (isNaN(base_fare_naira) || base_fare_naira <= 0) { errors.push({ row: i + 2, column: 'base_fare_naira', reason: 'base_fare_naira must be a positive number' }); continue; }
    if (row['duration_minutes'] && (isNaN(duration_minutes) || duration_minutes <= 0)) { errors.push({ row: i + 2, column: 'duration_minutes', reason: 'duration_minutes must be a positive integer' }); continue; }

    const id = genId('rt');
    try {
      await db.prepare(
        `INSERT INTO routes (id, operator_id, origin, destination, distance_km, duration_minutes, base_fare, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      ).bind(id, operatorRow.id, origin, destination, isNaN(distance_km) ? 0 : distance_km, duration_minutes, Math.round(base_fare_naira * 100), now, now).run();
      created.push(id);
    } catch (e: unknown) {
      errors.push({ row: i + 2, reason: e instanceof Error ? e.message : 'Insert failed' });
    }
  }

  return c.json({ success: true, data: { created, skipped: truncated, errors, ...(truncated > 0 ? { note: `${truncated} rows beyond the 500-row limit were ignored` } : {}) } });
});

operatorManagementRouter.post('/import/vehicles', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), requireTierFeature('bulk_import'), async (c) => {
  const csvResult = await readCsvFromFormData(c);
  if ('error' in csvResult) return c.json({ success: false, error: csvResult.error }, csvResult.status as 400 | 413);

  const { headers, rows, truncated } = csvResult;

  const REQUIRED_COLS = ['plate_number', 'vehicle_type'];
  const missingCols = REQUIRED_COLS.filter(col => !headers.includes(col));
  if (missingCols.length > 0) {
    return c.json({ success: false, error: `CSV missing required columns: ${missingCols.join(', ')}. Expected header: plate_number,vehicle_type[,model,total_seats]` }, 400);
  }

  const jwtUser = c.get('user');
  if (!jwtUser) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const db = c.env.DB;

  const operatorRow = await db.prepare(
    `SELECT id FROM operators WHERE id = ? AND deleted_at IS NULL`
  ).bind(jwtUser.operatorId ?? '').first<{ id: string }>();
  if (!operatorRow) return c.json({ success: false, error: 'Operator not found' }, 404);

  const now = Date.now();
  const created: string[] = [];
  const errors: Array<{ row: number; column?: string; reason: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const plate_number = row['plate_number']?.trim().toUpperCase();
    const vehicle_type = row['vehicle_type']?.trim();
    const model = row['model']?.trim() || null;
    const total_seats = parseInt(row['total_seats'] ?? '14', 10);

    if (!plate_number) { errors.push({ row: i + 2, column: 'plate_number', reason: 'plate_number is required' }); continue; }
    if (!vehicle_type) { errors.push({ row: i + 2, column: 'vehicle_type', reason: 'vehicle_type is required' }); continue; }

    const id = genId('veh');
    try {
      await db.prepare(
        `INSERT INTO vehicles (id, operator_id, plate_number, vehicle_type, model, total_seats, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)`
      ).bind(id, operatorRow.id, plate_number, vehicle_type, model, isNaN(total_seats) ? 14 : total_seats, now, now).run();
      created.push(id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Insert failed';
      errors.push({ row: i + 2, reason: msg.includes('UNIQUE') ? `Plate ${plate_number} already exists` : msg });
    }
  }

  return c.json({ success: true, data: { created, skipped: truncated, errors, ...(truncated > 0 ? { note: `${truncated} rows beyond the 500-row limit were ignored` } : {}) } });
});

operatorManagementRouter.post('/import/drivers', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), requireTierFeature('bulk_import'), async (c) => {
  const csvResult = await readCsvFromFormData(c);
  if ('error' in csvResult) return c.json({ success: false, error: csvResult.error }, csvResult.status as 400 | 413);

  const { headers, rows, truncated } = csvResult;

  const REQUIRED_COLS = ['name', 'phone'];
  const missingCols = REQUIRED_COLS.filter(col => !headers.includes(col));
  if (missingCols.length > 0) {
    return c.json({ success: false, error: `CSV missing required columns: ${missingCols.join(', ')}. Expected header: name,phone[,license_number]` }, 400);
  }

  const jwtUser = c.get('user');
  if (!jwtUser) return c.json({ success: false, error: 'Unauthorized' }, 401);
  const db = c.env.DB;

  const operatorRow = await db.prepare(
    `SELECT id FROM operators WHERE id = ? AND deleted_at IS NULL`
  ).bind(jwtUser.operatorId ?? '').first<{ id: string }>();
  if (!operatorRow) return c.json({ success: false, error: 'Operator not found' }, 404);

  const now = Date.now();
  const created: string[] = [];
  const errors: Array<{ row: number; column?: string; reason: string }> = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i]!;
    const name = row['name']?.trim();
    const phone = row['phone']?.trim();
    const license_number = row['license_number']?.trim() || null;

    if (!name) { errors.push({ row: i + 2, column: 'name', reason: 'name is required' }); continue; }
    if (!phone) { errors.push({ row: i + 2, column: 'phone', reason: 'phone is required' }); continue; }

    const id = genId('drv');
    try {
      await db.prepare(
        `INSERT INTO drivers (id, operator_id, name, phone, license_number, status, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?, NULL)`
      ).bind(id, operatorRow.id, name, phone, license_number, now, now).run();
      created.push(id);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : 'Insert failed';
      errors.push({ row: i + 2, reason: msg.includes('UNIQUE') ? `Phone ${phone} already registered` : msg });
    }
  }

  return c.json({ success: true, data: { created, skipped: truncated, errors, ...(truncated > 0 ? { note: `${truncated} rows beyond the 500-row limit were ignored` } : {}) } });
});
