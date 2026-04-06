/**
 * WebWaka Transport — Driver App API (TRN-5-DRIVER)
 *
 * Endpoints for the Offline-First Driver PWA:
 *   - Driver earnings dashboard
 *   - Daily vehicle inspection forms
 *   - Driver selfie verification (shift start)
 *   - Navigation / trip progress updates
 *   - SOS emergency button
 *   - Driver document management
 *
 * Auth: All trns_routes require DRIVER or SUPERVISOR role JWT.
 * Offline-tolerance: Endpoints accept and queue mutations made offline.
 */

import { Hono } from 'hono';
import type { Env } from '../worker.js';
import { nanoid } from '@webwaka/core';

export const driverAppRouter = new Hono<{ Bindings: Env }>();

// ============================================================
// GET /api/driver-app/:driver_id/earnings?period=daily|weekly|monthly
// Driver earnings dashboard
// ============================================================
driverAppRouter.get('/:driver_id/earnings', async (c) => {
  const driverId = c.req.param('driver_id');
  const period = c.req.query('period') ?? 'daily';
  const db = c.env.DB;

  // Compute date range
  const now = new Date();
  let dateCondition = '';
  const bindings: unknown[] = [driverId];

  if (period === 'daily') {
    const today = now.toISOString().split('T')[0];
    dateCondition = 'AND de.date = ?';
    bindings.push(today);
  } else if (period === 'weekly') {
    const weekStart = new Date(now);
    weekStart.setUTCDate(weekStart.getUTCDate() - weekStart.getUTCDay());
    dateCondition = 'AND de.date >= ?';
    bindings.push(weekStart.toISOString().split('T')[0]);
  } else if (period === 'monthly') {
    const monthStart = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-01`;
    dateCondition = 'AND de.date >= ?';
    bindings.push(monthStart);
  }

  const { results: earningsRows } = await db
    .prepare(`
      SELECT de.*
      FROM trns_driver_earnings de
      WHERE de.driver_id = ?
        ${dateCondition}
      ORDER BY de.date DESC
      LIMIT 31
    `)
    .bind(...bindings)
    .all<{
      date: string; trips_completed: number; gross_earnings_kobo: number;
      platform_commission_kobo: number; net_earnings_kobo: number;
      tips_kobo: number; bonuses_kobo: number; km_driven: number; hours_online: number;
    }>();

  const rows = earningsRows ?? [];

  // Aggregate totals
  const totals = rows.reduce((acc, row) => ({
    trips_completed: acc.trips_completed + row.trips_completed,
    gross_earnings_kobo: acc.gross_earnings_kobo + row.gross_earnings_kobo,
    net_earnings_kobo: acc.net_earnings_kobo + row.net_earnings_kobo,
    tips_kobo: acc.tips_kobo + row.tips_kobo,
    bonuses_kobo: acc.bonuses_kobo + row.bonuses_kobo,
    km_driven: acc.km_driven + row.km_driven,
    hours_online: acc.hours_online + row.hours_online,
  }), {
    trips_completed: 0, gross_earnings_kobo: 0, net_earnings_kobo: 0,
    tips_kobo: 0, bonuses_kobo: 0, km_driven: 0, hours_online: 0,
  });

  // Recent tips
  const { results: recentTips } = await db
    .prepare(`
      SELECT dt.amount_kobo, dt.message, dt.created_at, c.name as customer_name
      FROM trns_driver_tips dt
      LEFT JOIN trns_customers c ON dt.customer_id = c.id
      WHERE dt.driver_id = ?
      ORDER BY dt.created_at DESC LIMIT 10
    `)
    .bind(driverId)
    .all();

  return c.json({
    success: true,
    data: {
      driver_id: driverId,
      period,
      totals,
      daily_breakdown: rows,
      recent_tips: recentTips ?? [],
    },
  });
});

// ============================================================
// POST /api/driver-app/:driver_id/earnings/record
// Operator records a completed trip earning (called on ride completion)
// ============================================================
driverAppRouter.post('/:driver_id/earnings/record', async (c) => {
  const driverId = c.req.param('driver_id');
  const body = await c.req.json<{
    operator_id: string;
    gross_earnings_kobo: number;
    platform_commission_kobo: number;
    tips_kobo?: number;
    bonuses_kobo?: number;
    km_driven?: number;
    hours_online?: number;
  }>();

  const db = c.env.DB;
  const now = Date.now();
  const today = new Date(now).toISOString().split('T')[0]!;
  const earningId = `earn_${nanoid()}`;

  const netEarnings = body.gross_earnings_kobo - body.platform_commission_kobo;

  // Upsert daily earnings row
  await db.prepare(`
    INSERT INTO trns_driver_earnings (id, driver_id, operator_id, date, trips_completed, gross_earnings_kobo, platform_commission_kobo, net_earnings_kobo, tips_kobo, bonuses_kobo, km_driven, hours_online, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(driver_id, date) DO UPDATE SET
      trips_completed = trips_completed + 1,
      gross_earnings_kobo = gross_earnings_kobo + excluded.gross_earnings_kobo,
      platform_commission_kobo = platform_commission_kobo + excluded.platform_commission_kobo,
      net_earnings_kobo = net_earnings_kobo + excluded.net_earnings_kobo,
      tips_kobo = tips_kobo + excluded.tips_kobo,
      bonuses_kobo = bonuses_kobo + excluded.bonuses_kobo,
      km_driven = km_driven + excluded.km_driven,
      hours_online = hours_online + excluded.hours_online,
      updated_at = excluded.updated_at
  `).bind(
    earningId, driverId, body.operator_id, today,
    body.gross_earnings_kobo, body.platform_commission_kobo, netEarnings,
    body.tips_kobo ?? 0, body.bonuses_kobo ?? 0,
    body.km_driven ?? 0, body.hours_online ?? 0,
    now, now,
  ).run();

  return c.json({ success: true, data: { date: today, net_earnings_kobo: netEarnings } }, 201);
});

// ============================================================
// POST /api/driver-app/:driver_id/inspections
// Submit daily vehicle inspection form
// ============================================================
driverAppRouter.post('/:driver_id/inspections', async (c) => {
  const driverId = c.req.param('driver_id');
  const body = await c.req.json<{
    vehicle_id: string;
    operator_id: string;
    tires_ok: boolean;
    brakes_ok: boolean;
    lights_ok: boolean;
    fuel_level: string;
    engine_ok: boolean;
    ac_ok?: boolean;
    mirrors_ok?: boolean;
    emergency_equipment_ok: boolean;
    fire_extinguisher_ok?: boolean;
    first_aid_ok?: boolean;
    mileage_km?: number;
    notes?: string;
    photos?: string[];
  }>();

  const now = Date.now();
  const today = new Date(now).toISOString().split('T')[0]!;
  const inspectionId = `insp_${nanoid()}`;

  const allCritical = body.tires_ok && body.brakes_ok && body.lights_ok && body.engine_ok;
  const status = allCritical ? 'passed' : 'failed';

  await c.env.DB.prepare(`
    INSERT INTO trns_daily_vehicle_inspections
      (id, vehicle_id, driver_id, operator_id, inspection_date, tires_ok, brakes_ok,
       lights_ok, fuel_level, engine_ok, ac_ok, mirrors_ok, emergency_equipment_ok,
       fire_extinguisher_ok, first_aid_ok, mileage_km, notes, photos, status, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(vehicle_id, inspection_date) DO UPDATE SET
      driver_id = excluded.driver_id,
      tires_ok = excluded.tires_ok, brakes_ok = excluded.brakes_ok,
      lights_ok = excluded.lights_ok, fuel_level = excluded.fuel_level,
      engine_ok = excluded.engine_ok, ac_ok = excluded.ac_ok,
      mirrors_ok = excluded.mirrors_ok, emergency_equipment_ok = excluded.emergency_equipment_ok,
      fire_extinguisher_ok = excluded.fire_extinguisher_ok, first_aid_ok = excluded.first_aid_ok,
      mileage_km = excluded.mileage_km, notes = excluded.notes,
      photos = excluded.photos, status = excluded.status
  `).bind(
    inspectionId, body.vehicle_id, driverId, body.operator_id, today,
    body.tires_ok ? 1 : 0, body.brakes_ok ? 1 : 0, body.lights_ok ? 1 : 0,
    body.fuel_level, body.engine_ok ? 1 : 0,
    (body.ac_ok ?? true) ? 1 : 0, (body.mirrors_ok ?? true) ? 1 : 0,
    body.emergency_equipment_ok ? 1 : 0,
    (body.fire_extinguisher_ok ?? true) ? 1 : 0, (body.first_aid_ok ?? true) ? 1 : 0,
    body.mileage_km ?? null, body.notes ?? null,
    body.photos ? JSON.stringify(body.photos) : null,
    status, now,
  ).run();

  return c.json({
    success: true,
    data: { inspection_id: inspectionId, status, inspection_date: today },
  }, 201);
});

// ============================================================
// GET /api/driver-app/:driver_id/inspections?date=
// Get inspection records for a driver
// ============================================================
driverAppRouter.get('/:driver_id/inspections', async (c) => {
  const driverId = c.req.param('driver_id');
  const date = c.req.query('date');
  let query = `SELECT * FROM trns_daily_vehicle_inspections WHERE driver_id = ?`;
  const bindings: unknown[] = [driverId];
  if (date) { query += ' AND inspection_date = ?'; bindings.push(date); }
  query += ' ORDER BY inspection_date DESC LIMIT 30';
  const { results } = await c.env.DB.prepare(query).bind(...bindings).all();
  return c.json({ success: true, data: results ?? [] });
});

// ============================================================
// POST /api/driver-app/:driver_id/verify
// Submit selfie for shift-start driver verification
// ============================================================
driverAppRouter.post('/:driver_id/verify', async (c) => {
  const driverId = c.req.param('driver_id');
  const body = await c.req.json<{
    operator_id: string;
    selfie_url?: string;
    verification_type?: string;
  }>();

  const now = Date.now();
  const today = new Date(now).toISOString().split('T')[0]!;
  const expiresAt = new Date(now);
  expiresAt.setUTCHours(23, 59, 59, 999);
  const verificationId = `verif_${nanoid()}`;

  await c.env.DB.prepare(`
    INSERT INTO trns_driver_verifications (id, driver_id, operator_id, verification_type, selfie_url, status, expires_at, shift_date, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
    ON CONFLICT(driver_id, shift_date) DO UPDATE SET
      selfie_url = excluded.selfie_url,
      status = 'pending',
      expires_at = excluded.expires_at
  `).bind(
    verificationId, driverId, body.operator_id,
    body.verification_type ?? 'selfie_check',
    body.selfie_url ?? null,
    expiresAt.getTime(), today, now,
  ).run();

  return c.json({
    success: true,
    data: {
      verification_id: verificationId,
      status: 'pending',
      shift_date: today,
      message: 'Selfie submitted. A supervisor will verify shortly.',
    },
  }, 201);
});

// ============================================================
// PATCH /api/driver-app/verify/:verification_id/review
// Supervisor approves or rejects driver verification
// ============================================================
driverAppRouter.patch('/verify/:verification_id/review', async (c) => {
  const verifId = c.req.param('verification_id');
  const { status, reviewed_by } = await c.req.json<{ status: 'approved' | 'rejected'; reviewed_by: string }>();
  if (status !== 'approved' && status !== 'rejected') {
    return c.json({ success: false, error: 'status must be approved or rejected' }, 400);
  }
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE trns_driver_verifications SET status = ?, reviewed_by = ?, reviewed_at = ? WHERE id = ?`).bind(status, reviewed_by, now, verifId).run();
  return c.json({ success: true, data: { verification_id: verifId, status } });
});

// ============================================================
// GET /api/driver-app/:driver_id/verify/today
// Check today's verification status
// ============================================================
driverAppRouter.get('/:driver_id/verify/today', async (c) => {
  const driverId = c.req.param('driver_id');
  const today = new Date().toISOString().split('T')[0]!;
  const record = await c.env.DB
    .prepare(`SELECT id, status, shift_date, expires_at FROM trns_driver_verifications WHERE driver_id = ? AND shift_date = ?`)
    .bind(driverId, today)
    .first();
  return c.json({ success: true, data: record ?? { status: 'not_submitted', shift_date: today } });
});

// ============================================================
// POST /api/driver-app/trns_trips/:trip_id/sos
// Driver SOS emergency button
// ============================================================
driverAppRouter.post('/trns_trips/:trip_id/sos', async (c) => {
  const tripId = c.req.param('trip_id');
  const body = await c.req.json<{
    message?: string;
    latitude?: number;
    longitude?: number;
  }>();
  const now = Date.now();

  await c.env.DB.prepare(`
    UPDATE trns_trips SET
      sos_active = 1, sos_triggered_at = ?,
      sos_message = ?, sos_location_lat = ?, sos_location_lng = ?,
      current_latitude = COALESCE(?, current_latitude),
      current_longitude = COALESCE(?, current_longitude),
      updated_at = ?
    WHERE id = ?
  `).bind(
    now,
    body.message ?? 'SOS activated by driver',
    body.latitude ?? null,
    body.longitude ?? null,
    body.latitude ?? null,
    body.longitude ?? null,
    now, tripId,
  ).run();

  // Emit SOS event
  const eventId = `evt_${now}_${Math.random().toString(36).slice(2, 7)}`;
  await c.env.DB.prepare(`
    INSERT OR IGNORE INTO trns_platform_events (id, event_type, aggregate_id, aggregate_type, payload, status, created_at)
    VALUES (?, 'transport.trip.sos_triggered', ?, 'trip', ?, 'pending', ?)
  `).bind(
    eventId, tripId,
    JSON.stringify({ trip_id: tripId, latitude: body.latitude, longitude: body.longitude, message: body.message }),
    now,
  ).run();

  return c.json({
    success: true,
    data: {
      trip_id: tripId,
      sos_active: true,
      triggered_at: now,
      message: 'SOS activated. Emergency services and operator notified.',
    },
  });
});

// ============================================================
// DELETE /api/driver-app/trns_trips/:trip_id/sos
// Clear SOS
// ============================================================
driverAppRouter.delete('/trns_trips/:trip_id/sos', async (c) => {
  const tripId = c.req.param('trip_id');
  const { cleared_by } = await c.req.json<{ cleared_by: string }>();
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE trns_trips SET sos_active = 0, sos_cleared_at = ?, sos_cleared_by = ?, updated_at = ? WHERE id = ?`).bind(now, cleared_by, now, tripId).run();
  return c.json({ success: true, data: { trip_id: tripId, sos_active: false } });
});

// ============================================================
// PATCH /api/driver-app/trns_trips/:trip_id/location
// Driver updates GPS location (navigation tracking)
// ============================================================
driverAppRouter.patch('/trns_trips/:trip_id/location', async (c) => {
  const tripId = c.req.param('trip_id');
  const { latitude, longitude, driver_id } = await c.req.json<{
    latitude: number;
    longitude: number;
    driver_id: string;
  }>();
  const now = Date.now();

  await c.env.DB.prepare(`UPDATE trns_trips SET current_latitude = ?, current_longitude = ?, updated_at = ? WHERE id = ?`).bind(latitude, longitude, now, tripId).run();

  // Also update trns_active_drivers heartbeat
  await c.env.DB.prepare(`UPDATE trns_active_drivers SET latitude = ?, longitude = ?, last_seen_at = ? WHERE driver_id = ?`).bind(latitude, longitude, now, driver_id).run();

  return c.json({ success: true, data: { trip_id: tripId, latitude, longitude } });
});
