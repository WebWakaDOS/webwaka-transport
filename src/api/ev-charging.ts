/**
 * WebWaka Transport — EV Charging Station Locator API
 *
 * Provides:
 *   - Geospatial search for nearby EV stations (bounding-box + Haversine)
 *   - Station availability management (real-time charger point status)
 *   - Station CRUD for trns_operators and platform admins
 *   - Connector type filtering
 *
 * Invariants: Nigeria-First, Multi-tenant optional
 */

import { Hono } from 'hono';
import type { Env } from '../worker.js';
import { nanoid } from '@webwaka/core';
import { haversineDistanceKm } from '../modules/matching/engine.js';

export const evChargingRouter = new Hono<{ Bindings: Env }>();

// ── Helper: bounding box ──────────────────────────────────────────────────────

function boundingBox(lat: number, lon: number, radiusKm: number) {
  const latDelta = radiusKm / 111;
  const lonDelta = radiusKm / (111 * Math.cos((lat * Math.PI) / 180));
  return { minLat: lat - latDelta, maxLat: lat + latDelta, minLon: lon - lonDelta, maxLon: lon + lonDelta };
}

// ============================================================
// GET /api/ev-charging/nearby?lat=...&lon=...&radius_km=...
// Find nearby EV charging stations
// ============================================================
evChargingRouter.get('/nearby', async (c) => {
  const lat = Number(c.req.query('lat'));
  const lon = Number(c.req.query('lon'));
  const radiusKm = Math.min(Number(c.req.query('radius_km') ?? 20), 100);
  const connectorType = c.req.query('connector_type');
  const availableOnly = c.req.query('available_only') === 'true';

  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return c.json({ success: false, error: 'Valid lat and lon required' }, 400);
  }

  const box = boundingBox(lat, lon, radiusKm);

  let query = `
    SELECT * FROM trns_ev_charging_stations
    WHERE status != 'offline'
      AND latitude BETWEEN ? AND ?
      AND longitude BETWEEN ? AND ?
      AND deleted_at IS NULL
  `;
  const bindings: unknown[] = [box.minLat, box.maxLat, box.minLon, box.maxLon];

  if (availableOnly) { query += ' AND available_points > 0'; }

  const { results } = await c.env.DB.prepare(query).bind(...bindings).all<{
    id: string; name: string; address: string | null; city: string;
    latitude: number; longitude: number; connector_types: string;
    total_points: number; available_points: number; max_power_kw: number | null;
    price_per_kwh_kobo: number | null; amenities: string | null;
    operating_hours: string | null; status: string;
  }>();

  let stations = (results ?? []).map(s => ({
    ...s,
    connector_types: (() => { try { return JSON.parse(s.connector_types) as string[]; } catch { return []; } })(),
    amenities: (() => { try { return s.amenities ? JSON.parse(s.amenities) as string[] : []; } catch { return []; } })(),
    distance_km: Math.round(haversineDistanceKm(lat, lon, s.latitude, s.longitude) * 100) / 100,
  }));

  // Filter by connector type if specified
  if (connectorType) {
    stations = stations.filter(s => (s.connector_types as string[]).includes(connectorType));
  }

  // Sort by distance
  stations.sort((a, b) => a.distance_km - b.distance_km);

  return c.json({ success: true, data: { stations, search_radius_km: radiusKm, total: stations.length } });
});

// ============================================================
// GET /api/ev-charging?city=...
// List all stations (filterable by city)
// ============================================================
evChargingRouter.get('/', async (c) => {
  const city = c.req.query('city');
  const operatorId = c.req.query('operator_id');
  const status = c.req.query('status');

  let query = `SELECT * FROM trns_ev_charging_stations WHERE deleted_at IS NULL`;
  const bindings: unknown[] = [];

  if (city) { query += ' AND LOWER(city) LIKE ?'; bindings.push(`%${city.toLowerCase()}%`); }
  if (operatorId) { query += ' AND operator_id = ?'; bindings.push(operatorId); }
  if (status) { query += ' AND status = ?'; bindings.push(status); }
  query += ' ORDER BY city, name LIMIT 100';

  const { results } = await c.env.DB.prepare(query).bind(...bindings).all();
  return c.json({ success: true, data: results ?? [] });
});

// ============================================================
// GET /api/ev-charging/:id
// Get a single station
// ============================================================
evChargingRouter.get('/:id', async (c) => {
  const id = c.req.param('id');
  const station = await c.env.DB.prepare(`SELECT * FROM trns_ev_charging_stations WHERE id = ? AND deleted_at IS NULL`).bind(id).first();
  if (!station) return c.json({ success: false, error: 'Station not found' }, 404);
  return c.json({ success: true, data: station });
});

// ============================================================
// POST /api/ev-charging
// Register a new EV charging station
// ============================================================
evChargingRouter.post('/', async (c) => {
  const body = await c.req.json<{
    operator_id?: string;
    name: string;
    address?: string;
    city: string;
    state?: string;
    latitude: number;
    longitude: number;
    connector_types: string[];
    total_points?: number;
    max_power_kw?: number;
    price_per_kwh_kobo?: number;
    is_public?: boolean;
    amenities?: string[];
    operating_hours?: string;
  }>();

  if (!body.name || !body.city || !body.latitude || !body.longitude || !body.connector_types?.length) {
    return c.json({ success: false, error: 'name, city, latitude, longitude, and connector_types required' }, 400);
  }

  const now = Date.now();
  const stationId = `ev_${nanoid()}`;

  await c.env.DB.prepare(`
    INSERT INTO trns_ev_charging_stations
      (id, operator_id, name, address, city, state, latitude, longitude,
       connector_types, total_points, available_points, max_power_kw, price_per_kwh_kobo,
       is_public, amenities, operating_hours, status, last_heartbeat, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?)
  `).bind(
    stationId, body.operator_id ?? null, body.name, body.address ?? null,
    body.city, body.state ?? null, body.latitude, body.longitude,
    JSON.stringify(body.connector_types),
    body.total_points ?? 1, body.total_points ?? 1,
    body.max_power_kw ?? null, body.price_per_kwh_kobo ?? null,
    body.is_public !== false ? 1 : 0,
    body.amenities ? JSON.stringify(body.amenities) : null,
    body.operating_hours ?? '24/7',
    now, now, now,
  ).run();

  return c.json({ success: true, data: { station_id: stationId, name: body.name, city: body.city } }, 201);
});

// ============================================================
// PATCH /api/ev-charging/:id/availability
// Update real-time charger point availability
// ============================================================
evChargingRouter.patch('/:id/availability', async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json<{ available_points: number; status?: string }>();
  const now = Date.now();

  await c.env.DB.prepare(`
    UPDATE trns_ev_charging_stations
    SET available_points = ?,
        status = COALESCE(?, status),
        last_heartbeat = ?,
        updated_at = ?
    WHERE id = ?
  `).bind(body.available_points, body.status ?? null, now, now, id).run();

  return c.json({ success: true, data: { id, available_points: body.available_points } });
});

// ============================================================
// DELETE /api/ev-charging/:id
// Soft-delete a station
// ============================================================
evChargingRouter.delete('/:id', async (c) => {
  const id = c.req.param('id');
  await c.env.DB.prepare(`UPDATE trns_ev_charging_stations SET deleted_at = ?, updated_at = ? WHERE id = ?`).bind(Date.now(), Date.now(), id).run();
  return c.json({ success: true });
});

// ============================================================
// POST /api/ev-charging/seed
// Seed well-known Nigerian EV stations (admin use)
// ============================================================
evChargingRouter.post('/seed', async (c) => {
  const now = Date.now();
  const stations = [
    { name: 'EKEDC Lekki EV Hub', city: 'Lagos', state: 'Lagos', lat: 6.4698, lon: 3.5852, connectors: ['Type2', 'CCS'], kw: 50, amenities: ['wifi', 'food'] },
    { name: 'Abuja Airport EV Station', city: 'Abuja', state: 'FCT', lat: 9.0068, lon: 7.2630, connectors: ['CHAdeMO', 'CCS', 'Type2'], kw: 150, amenities: ['restroom', 'wifi'] },
    { name: 'Port Harcourt Mall Charger', city: 'Port Harcourt', state: 'Rivers', lat: 4.8156, lon: 7.0498, connectors: ['Type2'], kw: 22, amenities: ['food', 'restroom'] },
    { name: 'Kano Trade Fair Complex EV', city: 'Kano', state: 'Kano', lat: 11.9964, lon: 8.5122, connectors: ['Type2', 'CCS'], kw: 50, amenities: [] },
    { name: 'Ibadan Ring Road Charger', city: 'Ibadan', state: 'Oyo', lat: 7.3775, lon: 3.9470, connectors: ['Type2'], kw: 22, amenities: ['wifi'] },
  ];

  const inserted = [];
  for (const s of stations) {
    const id = `ev_${nanoid()}`;
    try {
      await c.env.DB.prepare(`
        INSERT OR IGNORE INTO trns_ev_charging_stations (id, name, city, state, latitude, longitude, connector_types, total_points, available_points, max_power_kw, is_public, amenities, operating_hours, status, last_heartbeat, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, 2, 2, ?, 1, ?, '06:00-22:00', 'active', ?, ?, ?)
      `).bind(id, s.name, s.city, s.state, s.lat, s.lon, JSON.stringify(s.connectors), s.kw, JSON.stringify(s.amenities), now, now, now).run();
      inserted.push(s.name);
    } catch { /* ignore duplicates */ }
  }

  return c.json({ success: true, data: { seeded: inserted.length, stations: inserted } });
});
