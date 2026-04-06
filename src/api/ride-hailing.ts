/**
 * WebWaka Transport — Ride Hailing API Router (TRN-5)
 *
 * Covers:
 *   - Real-time ride matching (Haversine, trns_active_drivers)
 *   - Dynamic surge pricing (AI-enhanced)
 *   - Carpooling / ride-sharing
 *   - Scheduled rides
 *   - Multi-stop rides
 *   - Wait-time billing
 *   - Toll fee calculation
 *   - Promo code application
 *   - Driver tipping
 *   - Intercity trns_bookings with luggage allowances
 *
 * Auth: All trns_routes require JWT (except GET /ride-hailing/surge for public fare display)
 */

import { Hono } from 'hono';
import type { Env } from '../worker.js';
import { findNearestDrivers, emitRideRequestedEvent, upsertDriverLocation } from '../modules/matching/engine.js';
import { calculateSurge, applySurge } from '../modules/pricing/surge.js';
import { nanoid } from '@webwaka/core';
import { notifyRideCompleted } from '../core/central-mgmt.js';

export const rideHailingRouter = new Hono<{ Bindings: Env }>();

// ============================================================
// Helper: validate coordinates
// ============================================================
function validateCoords(lat: unknown, lon: unknown): { latitude: number; longitude: number } | null {
  const latitude = Number(lat);
  const longitude = Number(lon);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) return null;
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) return null;
  return { latitude, longitude };
}

// ============================================================
// POST /api/ride-hailing/request
// Create a new ride request + match nearest trns_drivers
// ============================================================
rideHailingRouter.post('/request', async (c) => {
  const body = await c.req.json<{
    customer_id: string;
    pickup_latitude: number;
    pickup_longitude: number;
    pickup_address?: string;
    dropoff_latitude: number;
    dropoff_longitude: number;
    dropoff_address?: string;
    operator_id?: string;
    waypoints?: Array<{ latitude: number; longitude: number; address?: string }>;
    is_scheduled?: boolean;
    scheduled_for?: number;
    is_carpooled?: boolean;
    carpool_group_id?: string;
    promo_code?: string;
  }>();

  const pickup = validateCoords(body.pickup_latitude, body.pickup_longitude);
  const dropoff = validateCoords(body.dropoff_latitude, body.dropoff_longitude);
  if (!pickup || !dropoff) {
    return c.json({ success: false, error: 'Invalid coordinates' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const rideId = `ride_${nanoid()}`;

  // Calculate surge multiplier for pickup zone
  const zoneId = `${Math.round(pickup.latitude * 10) / 10}_${Math.round(pickup.longitude * 10) / 10}`;
  const surge = await calculateSurge(db, c.env, {
    zone_id: zoneId,
    operator_id: body.operator_id,
    latitude: pickup.latitude,
    longitude: pickup.longitude,
  });

  // Validate promo code if provided
  let promoDiscountKobo = 0;
  let promoCodeRecord: { id: string; discount_type: string; discount_value: number; max_discount_kobo: number | null } | null = null;
  if (body.promo_code) {
    promoCodeRecord = await db
      .prepare(`
        SELECT id, discount_type, discount_value, max_discount_kobo
        FROM trns_promo_codes
        WHERE code = ? AND is_active = 1
          AND valid_from <= ? AND valid_until >= ?
          AND deleted_at IS NULL
          AND (max_uses IS NULL OR used_count < max_uses)
      `)
      .bind(body.promo_code, now, now)
      .first<typeof promoCodeRecord>();
  }

  // Find nearest available trns_drivers
  const matchResult = await findNearestDrivers(
    db,
    pickup,
    body.operator_id,
  );

  // Insert ride request
  await db
    .prepare(`
      INSERT INTO trns_ride_requests
        (id, customer_id, operator_id, pickup_latitude, pickup_longitude, pickup_address,
         dropoff_latitude, dropoff_longitude, dropoff_address, status, surge_multiplier,
         is_scheduled, scheduled_for, is_carpooled, carpool_group_id, promo_code,
         promo_discount_kobo, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .bind(
      rideId,
      body.customer_id,
      body.operator_id ?? null,
      pickup.latitude, pickup.longitude, body.pickup_address ?? null,
      dropoff.latitude, dropoff.longitude, body.dropoff_address ?? null,
      surge.surge_multiplier,
      body.is_scheduled ? 1 : 0,
      body.scheduled_for ?? null,
      body.is_carpooled ? 1 : 0,
      body.carpool_group_id ?? null,
      body.promo_code ?? null,
      promoDiscountKobo,
      now, now,
    )
    .run();

  // Insert waypoints if multi-stop
  if (body.waypoints && body.waypoints.length > 0) {
    for (let i = 0; i < body.waypoints.length; i++) {
      const wp = body.waypoints[i]!;
      await db
        .prepare(`INSERT INTO trns_ride_waypoints (id, ride_request_id, sequence, latitude, longitude, address, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)`)
        .bind(`wp_${nanoid()}`, rideId, i + 1, wp.latitude, wp.longitude, wp.address ?? null, now)
        .run();
    }
  }

  // Emit ride requested event
  const matchedIds = matchResult.matched_drivers.map(d => d.driver_id);
  if (matchedIds.length > 0) {
    await emitRideRequestedEvent(db, rideId, body.customer_id, matchedIds, pickup, body.operator_id);
  }

  return c.json({
    success: true,
    data: {
      ride_request_id: rideId,
      status: 'pending',
      surge_multiplier: surge.surge_multiplier,
      surge_zone: zoneId,
      matched_drivers: matchResult.matched_drivers,
      promo_applied: promoCodeRecord !== null,
    },
  }, 201);
});

// ============================================================
// GET /api/ride-hailing/surge?zone_id=...&operator_id=...
// Public: get current surge multiplier for fare display
// ============================================================
rideHailingRouter.get('/surge', async (c) => {
  const zone_id = c.req.query('zone_id') ?? 'default';
  const operator_id = c.req.query('operator_id');
  const lat = c.req.query('lat');
  const lon = c.req.query('lon');

  const surge = await calculateSurge(c.env.DB, c.env, {
    zone_id,
    operator_id,
    latitude: lat ? Number(lat) : undefined,
    longitude: lon ? Number(lon) : undefined,
  });

  return c.json({ success: true, data: surge });
});

// ============================================================
// PATCH /api/ride-hailing/:id/accept
// Driver accepts a ride request
// ============================================================
rideHailingRouter.patch('/:id/accept', async (c) => {
  const rideId = c.req.param('id');
  const { driver_id, vehicle_id } = await c.req.json<{ driver_id: string; vehicle_id?: string }>();

  const now = Date.now();
  const ride = await c.env.DB.prepare(`SELECT id, status FROM trns_ride_requests WHERE id = ?`).bind(rideId).first<{ id: string; status: string }>();
  if (!ride) return c.json({ success: false, error: 'Ride not found' }, 404);
  if (ride.status !== 'pending' && ride.status !== 'matched') {
    return c.json({ success: false, error: `Cannot accept ride in status: ${ride.status}` }, 409);
  }

  await c.env.DB.prepare(`
    UPDATE trns_ride_requests SET status = 'accepted', driver_id = ?, vehicle_id = ?, accepted_at = ?, updated_at = ? WHERE id = ?
  `).bind(driver_id, vehicle_id ?? null, now, now, rideId).run();

  // Mark driver as on_ride
  await c.env.DB.prepare(`UPDATE trns_active_drivers SET status = 'on_ride', last_seen_at = ? WHERE driver_id = ?`).bind(now, driver_id).run();

  return c.json({ success: true, data: { ride_request_id: rideId, status: 'accepted' } });
});

// ============================================================
// PATCH /api/ride-hailing/:id/start
// Driver starts the ride
// ============================================================
rideHailingRouter.patch('/:id/start', async (c) => {
  const rideId = c.req.param('id');
  const now = Date.now();
  await c.env.DB.prepare(`UPDATE trns_ride_requests SET status = 'in_progress', started_at = ?, updated_at = ? WHERE id = ? AND status = 'accepted'`).bind(now, now, rideId).run();
  return c.json({ success: true, data: { ride_request_id: rideId, status: 'in_progress' } });
});

// ============================================================
// PATCH /api/ride-hailing/:id/complete
// Complete a ride + calculate final fare
// ============================================================
rideHailingRouter.patch('/:id/complete', async (c) => {
  const rideId = c.req.param('id');
  const body = await c.req.json<{
    distance_km?: number;
    duration_minutes?: number;
    wait_time_seconds?: number;
  }>();
  const now = Date.now();

  const ride = await c.env.DB
    .prepare(`SELECT * FROM trns_ride_requests WHERE id = ?`)
    .bind(rideId)
    .first<{
      id: string; base_fare_kobo: number | null; surge_multiplier: number;
      toll_fees_kobo: number; promo_discount_kobo: number;
      driver_id: string | null; operator_id: string | null;
    }>();

  if (!ride) return c.json({ success: false, error: 'Ride not found' }, 404);

  // Calculate wait-time charge
  let waitTimeChargeKobo = 0;
  const waitSeconds = body.wait_time_seconds ?? 0;
  if (ride.operator_id) {
    const cfg = await c.env.DB
      .prepare(`SELECT free_wait_seconds, charge_per_minute_kobo FROM trns_wait_time_config WHERE operator_id = ? AND is_active = 1`)
      .bind(ride.operator_id)
      .first<{ free_wait_seconds: number; charge_per_minute_kobo: number }>();
    if (cfg && waitSeconds > cfg.free_wait_seconds) {
      const chargeableMinutes = Math.ceil((waitSeconds - cfg.free_wait_seconds) / 60);
      waitTimeChargeKobo = chargeableMinutes * cfg.charge_per_minute_kobo;
    }
  }

  const baseFare = ride.base_fare_kobo ?? 50000; // ₦500 default
  const surgedFare = applySurge(baseFare, ride.surge_multiplier);
  const finalFare = Math.max(0,
    surgedFare + ride.toll_fees_kobo + waitTimeChargeKobo - ride.promo_discount_kobo
  );

  await c.env.DB.prepare(`
    UPDATE trns_ride_requests SET
      status = 'completed', completed_at = ?, final_fare_kobo = ?,
      distance_km = ?, duration_minutes = ?,
      wait_time_seconds = ?, wait_time_charge_kobo = ?,
      updated_at = ?
    WHERE id = ?
  `).bind(now, finalFare, body.distance_km ?? null, body.duration_minutes ?? null, waitSeconds, waitTimeChargeKobo, now, rideId).run();

  // Mark driver as available again
  if (ride.driver_id) {
    await c.env.DB.prepare(`UPDATE trns_active_drivers SET status = 'available', last_seen_at = ? WHERE driver_id = ?`).bind(now, ride.driver_id).run();
  }

  // Notify central-mgmt ledger of completed ride fare (WWT-001: all financial transactions)
  notifyRideCompleted(
    c.env,
    rideId,
    ride.operator_id ?? '',
    finalFare,
  ).catch((err: unknown) => {
    console.error('[ride-hailing/complete] central-mgmt notify failed (non-fatal):', err instanceof Error ? err.message : err);
  });

  return c.json({
    success: true,
    data: {
      ride_request_id: rideId,
      status: 'completed',
      final_fare_kobo: finalFare,
      breakdown: {
        base_fare_kobo: baseFare,
        surge_multiplier: ride.surge_multiplier,
        surged_fare_kobo: surgedFare,
        toll_fees_kobo: ride.toll_fees_kobo,
        wait_time_charge_kobo: waitTimeChargeKobo,
        promo_discount_kobo: ride.promo_discount_kobo,
      },
    },
  });
});

// ============================================================
// POST /api/ride-hailing/:id/tip
// Customer tips the driver after ride completion
// ============================================================
rideHailingRouter.post('/:id/tip', async (c) => {
  const rideId = c.req.param('id');
  const body = await c.req.json<{
    amount_kobo: number;
    customer_id: string;
    payment_method?: string;
    message?: string;
  }>();

  if (!body.amount_kobo || body.amount_kobo <= 0) {
    return c.json({ success: false, error: 'Tip amount must be positive' }, 400);
  }

  const ride = await c.env.DB
    .prepare(`SELECT driver_id, status FROM trns_ride_requests WHERE id = ?`)
    .bind(rideId)
    .first<{ driver_id: string | null; status: string }>();

  if (!ride) return c.json({ success: false, error: 'Ride not found' }, 404);
  if (ride.status !== 'completed') return c.json({ success: false, error: 'Can only tip completed rides' }, 400);
  if (!ride.driver_id) return c.json({ success: false, error: 'No driver assigned to this ride' }, 400);

  const now = Date.now();
  const tipId = `tip_${nanoid()}`;

  await c.env.DB.prepare(`
    INSERT INTO trns_driver_tips (id, driver_id, customer_id, ride_request_id, amount_kobo, payment_method, message, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).bind(tipId, ride.driver_id, body.customer_id, rideId, body.amount_kobo, body.payment_method ?? 'card', body.message ?? null, now).run();

  // Update trns_ride_requests tip total
  await c.env.DB.prepare(`UPDATE trns_ride_requests SET tip_kobo = tip_kobo + ?, updated_at = ? WHERE id = ?`).bind(body.amount_kobo, now, rideId).run();

  return c.json({ success: true, data: { tip_id: tipId, amount_kobo: body.amount_kobo, driver_id: ride.driver_id } }, 201);
});

// ============================================================
// GET /api/ride-hailing/:id
// Get ride request details
// ============================================================
rideHailingRouter.get('/:id', async (c) => {
  const rideId = c.req.param('id');
  const ride = await c.env.DB.prepare(`
    SELECT rr.*, d.name as driver_name, d.phone as driver_phone, v.plate_number, v.vehicle_type
    FROM trns_ride_requests rr
    LEFT JOIN trns_drivers d ON rr.driver_id = d.id
    LEFT JOIN trns_vehicles v ON rr.vehicle_id = v.id
    WHERE rr.id = ?
  `).bind(rideId).first();
  if (!ride) return c.json({ success: false, error: 'Ride not found' }, 404);
  return c.json({ success: true, data: ride });
});

// ============================================================
// GET /api/ride-hailing?customer_id=...&status=...
// List ride requests for a customer or driver
// ============================================================
rideHailingRouter.get('/', async (c) => {
  const customerId = c.req.query('customer_id');
  const driverId = c.req.query('driver_id');
  const status = c.req.query('status');
  const limit = Math.min(Number(c.req.query('limit') ?? 20), 100);

  let query = `SELECT rr.*, d.name as driver_name FROM trns_ride_requests rr LEFT JOIN trns_drivers d ON rr.driver_id = d.id WHERE 1=1`;
  const bindings: unknown[] = [];

  if (customerId) { query += ' AND rr.customer_id = ?'; bindings.push(customerId); }
  if (driverId) { query += ' AND rr.driver_id = ?'; bindings.push(driverId); }
  if (status) { query += ' AND rr.status = ?'; bindings.push(status); }
  query += ` ORDER BY rr.created_at DESC LIMIT ${limit}`;

  const { results } = await c.env.DB.prepare(query).bind(...bindings).all();
  return c.json({ success: true, data: results ?? [] });
});

// ============================================================
// POST /api/ride-hailing/carpool
// Create or join a carpool group
// ============================================================
rideHailingRouter.post('/carpool', async (c) => {
  const body = await c.req.json<{
    action: 'create' | 'join';
    carpool_group_id?: string;
    customer_id: string;
    origin?: string;
    destination?: string;
    departure_time?: number;
    max_passengers?: number;
    base_fare_per_seat_kobo?: number;
    operator_id?: string;
  }>();

  const db = c.env.DB;
  const now = Date.now();

  if (body.action === 'create') {
    if (!body.origin || !body.destination || !body.departure_time || !body.base_fare_per_seat_kobo) {
      return c.json({ success: false, error: 'origin, destination, departure_time, and base_fare_per_seat_kobo required' }, 400);
    }
    const groupId = `cp_${nanoid()}`;
    await db.prepare(`
      INSERT INTO trns_carpool_groups (id, operator_id, origin, destination, departure_time, max_passengers, base_fare_per_seat_kobo, current_passengers, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'open', ?, ?)
    `).bind(groupId, body.operator_id ?? null, body.origin, body.destination, body.departure_time, body.max_passengers ?? 4, body.base_fare_per_seat_kobo, now, now).run();

    return c.json({ success: true, data: { carpool_group_id: groupId, status: 'open', current_passengers: 1 } }, 201);
  }

  if (body.action === 'join') {
    if (!body.carpool_group_id) return c.json({ success: false, error: 'carpool_group_id required to join' }, 400);
    const group = await db.prepare(`SELECT id, current_passengers, max_passengers, status FROM trns_carpool_groups WHERE id = ?`).bind(body.carpool_group_id).first<{ id: string; current_passengers: number; max_passengers: number; status: string }>();
    if (!group) return c.json({ success: false, error: 'Carpool group not found' }, 404);
    if (group.status !== 'open') return c.json({ success: false, error: `Carpool group is ${group.status}` }, 409);
    if (group.current_passengers >= group.max_passengers) return c.json({ success: false, error: 'Carpool group is full' }, 409);

    const newCount = group.current_passengers + 1;
    const newStatus = newCount >= group.max_passengers ? 'full' : 'open';
    await db.prepare(`UPDATE trns_carpool_groups SET current_passengers = ?, status = ?, updated_at = ? WHERE id = ?`).bind(newCount, newStatus, now, body.carpool_group_id).run();

    return c.json({ success: true, data: { carpool_group_id: body.carpool_group_id, current_passengers: newCount, status: newStatus } });
  }

  return c.json({ success: false, error: 'action must be create or join' }, 400);
});

// ============================================================
// GET /api/ride-hailing/carpool/search?origin=&destination=&date=
// Search open carpool groups
// ============================================================
rideHailingRouter.get('/carpool/search', async (c) => {
  const origin = c.req.query('origin');
  const destination = c.req.query('destination');
  const date = c.req.query('date');

  let query = `SELECT * FROM trns_carpool_groups WHERE status = 'open'`;
  const bindings: unknown[] = [];
  if (origin) { query += ' AND LOWER(origin) LIKE ?'; bindings.push(`%${origin.toLowerCase()}%`); }
  if (destination) { query += ' AND LOWER(destination) LIKE ?'; bindings.push(`%${destination.toLowerCase()}%`); }
  if (date) {
    const dayStart = new Date(date).setHours(0, 0, 0, 0);
    const dayEnd = new Date(date).setHours(23, 59, 59, 999);
    query += ' AND departure_time BETWEEN ? AND ?';
    bindings.push(dayStart, dayEnd);
  }
  query += ' ORDER BY departure_time ASC LIMIT 20';

  const { results } = await c.env.DB.prepare(query).bind(...bindings).all();
  return c.json({ success: true, data: results ?? [] });
});

// ============================================================
// POST /api/ride-hailing/driver/heartbeat
// Driver app: upsert location + status (every 30s)
// ============================================================
rideHailingRouter.post('/driver/heartbeat', async (c) => {
  const body = await c.req.json<{
    driver_id: string;
    operator_id: string;
    latitude: number;
    longitude: number;
    status: 'available' | 'on_ride' | 'offline';
    vehicle_id?: string;
  }>();

  const coords = validateCoords(body.latitude, body.longitude);
  if (!coords) return c.json({ success: false, error: 'Invalid coordinates' }, 400);

  await upsertDriverLocation(c.env.DB, body.driver_id, body.operator_id, coords.latitude, coords.longitude, body.status, body.vehicle_id);

  return c.json({ success: true, data: { driver_id: body.driver_id, status: body.status } });
});

// ============================================================
// GET /api/ride-hailing/toll-fees?route_id=...
// Get toll fees for a route
// ============================================================
rideHailingRouter.get('/toll-fees', async (c) => {
  const routeId = c.req.query('route_id');
  if (!routeId) return c.json({ success: false, error: 'route_id required' }, 400);

  const { results } = await c.env.DB
    .prepare(`SELECT * FROM trns_toll_gates WHERE route_id = ? AND is_active = 1 ORDER BY name`)
    .bind(routeId)
    .all();

  const totalKobo = (results ?? []).reduce((sum: number, r: Record<string, unknown>) => sum + (Number(r['fee_kobo']) || 0), 0);

  return c.json({ success: true, data: { trns_toll_gates: results ?? [], total_toll_fee_kobo: totalKobo } });
});
