/**
 * WebWaka Transport — Real-Time Ride Matching Engine
 *
 * Uses Haversine formula for geospatial distance computation.
 * Queries `active_drivers` D1 table to find nearest available drivers
 * within a configurable radius bounding box, then sorts by exact distance.
 *
 * Emits a `transport.ride.requested` platform event on match.
 *
 * Invariants: Nigeria-First, Offline-Tolerant, Multi-tenant
 */

import { publishEvent } from '../../core/events/index.js';

// ── Types ─────────────────────────────────────────────────────────────────────

export interface RiderLocation {
  latitude: number;
  longitude: number;
}

export interface ActiveDriver {
  driver_id: string;
  operator_id: string;
  latitude: number;
  longitude: number;
  status: 'available' | 'on_ride' | 'offline';
  vehicle_id: string | null;
  last_seen_at: number;
}

export interface MatchedDriver extends ActiveDriver {
  distance_km: number;
  estimated_pickup_minutes: number;
}

export interface MatchResult {
  matched_drivers: MatchedDriver[];
  search_radius_km: number;
  searched_at: number;
}

// ── Config ────────────────────────────────────────────────────────────────────

const DEFAULT_SEARCH_RADIUS_KM = 5;
const MAX_RESULTS = 5;
const DRIVER_STALE_MS = 5 * 60 * 1000; // 5 minutes — driver heartbeat TTL
const AVG_SPEED_KMH = 30; // average urban speed for ETA estimation

// ── Haversine formula ─────────────────────────────────────────────────────────

/**
 * Compute great-circle distance between two coordinates in kilometres.
 * Accurate to ~0.5% for distances < 2,000 km.
 */
export function haversineDistanceKm(
  lat1: number, lon1: number,
  lat2: number, lon2: number,
): number {
  const R = 6371; // Earth radius in km
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

function toRad(deg: number): number {
  return (deg * Math.PI) / 180;
}

/**
 * Compute bounding box for a given centre + radius to pre-filter D1 rows
 * without scanning the full table.
 */
function boundingBox(lat: number, lon: number, radiusKm: number) {
  const latDelta = radiusKm / 111; // 1° lat ≈ 111 km
  const lonDelta = radiusKm / (111 * Math.cos(toRad(lat)));
  return {
    minLat: lat - latDelta,
    maxLat: lat + latDelta,
    minLon: lon - lonDelta,
    maxLon: lon + lonDelta,
  };
}

// ── Core matching function ────────────────────────────────────────────────────

export interface MatchDb {
  prepare: (q: string) => { bind: (...args: unknown[]) => { all: <T>() => Promise<{ results: T[] }> } };
}

/**
 * Find the `maxResults` nearest available drivers to a rider's location.
 *
 * Steps:
 *  1. Bounding-box pre-filter on D1 (cheap index scan).
 *  2. Exact Haversine sort in JS.
 *  3. Reject stale drivers (last_seen_at > DRIVER_STALE_MS ago).
 *  4. Emit `transport.ride.requested` event.
 *
 * @param db         D1Database (Cloudflare) or any compatible interface
 * @param rider      Rider's GPS coordinates
 * @param operatorId Optional: restrict to a specific operator
 * @param radiusKm   Search radius in km (default: 5)
 * @param maxResults Max drivers to return (default: 5)
 */
export async function findNearestDrivers(
  db: MatchDb,
  rider: RiderLocation,
  operatorId?: string,
  radiusKm: number = DEFAULT_SEARCH_RADIUS_KM,
  maxResults: number = MAX_RESULTS,
): Promise<MatchResult> {
  const now = Date.now();
  const staleCutoff = now - DRIVER_STALE_MS;
  const box = boundingBox(rider.latitude, rider.longitude, radiusKm);

  let query = `
    SELECT ad.driver_id, ad.operator_id, ad.latitude, ad.longitude,
           ad.status, ad.vehicle_id, ad.last_seen_at
    FROM active_drivers ad
    WHERE ad.status = 'available'
      AND ad.latitude  BETWEEN ? AND ?
      AND ad.longitude BETWEEN ? AND ?
      AND ad.last_seen_at >= ?
  `;
  const bindings: unknown[] = [
    box.minLat, box.maxLat,
    box.minLon, box.maxLon,
    staleCutoff,
  ];

  if (operatorId) {
    query += ' AND ad.operator_id = ?';
    bindings.push(operatorId);
  }

  const { results: candidates } = await db
    .prepare(query)
    .bind(...bindings)
    .all<ActiveDriver>();

  // Exact Haversine distance + ETA
  const withDistance: MatchedDriver[] = (candidates ?? []).map(driver => {
    const distance_km = haversineDistanceKm(
      rider.latitude, rider.longitude,
      driver.latitude, driver.longitude,
    );
    return {
      ...driver,
      distance_km: Math.round(distance_km * 100) / 100,
      estimated_pickup_minutes: Math.ceil((distance_km / AVG_SPEED_KMH) * 60),
    };
  });

  // Sort ascending by distance, take top N
  withDistance.sort((a, b) => a.distance_km - b.distance_km);
  const matched_drivers = withDistance.slice(0, maxResults);

  return {
    matched_drivers,
    search_radius_km: radiusKm,
    searched_at: now,
  };
}

// ── Event emission ────────────────────────────────────────────────────────────

/**
 * Emit `transport.ride.requested` platform event.
 * Downstream consumers (notifications, driver dispatch) listen to this.
 */
export async function emitRideRequestedEvent(
  db: Parameters<typeof publishEvent>[0],
  rideRequestId: string,
  riderId: string,
  matchedDriverIds: string[],
  pickup: RiderLocation,
  tenantId?: string,
): Promise<void> {
  await publishEvent(db, {
    event_type: 'transport.ride.requested',
    aggregate_id: rideRequestId,
    aggregate_type: 'ride_request',
    payload: {
      rider_id: riderId,
      matched_driver_ids: matchedDriverIds,
      pickup_latitude: pickup.latitude,
      pickup_longitude: pickup.longitude,
    },
    tenant_id: tenantId,
    timestamp: Date.now(),
  });
}

// ── Driver presence management ────────────────────────────────────────────────

/**
 * Upsert driver location heartbeat in `active_drivers`.
 * Called by the driver app every 30 seconds.
 */
export async function upsertDriverLocation(
  db: { prepare: (q: string) => { bind: (...args: unknown[]) => { run: () => Promise<unknown> } } },
  driverId: string,
  operatorId: string,
  latitude: number,
  longitude: number,
  status: 'available' | 'on_ride' | 'offline',
  vehicleId?: string,
): Promise<void> {
  const now = Date.now();
  await db
    .prepare(`
      INSERT INTO active_drivers (driver_id, operator_id, latitude, longitude, status, vehicle_id, last_seen_at, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(driver_id) DO UPDATE SET
        latitude = excluded.latitude,
        longitude = excluded.longitude,
        status = excluded.status,
        vehicle_id = excluded.vehicle_id,
        last_seen_at = excluded.last_seen_at
    `)
    .bind(driverId, operatorId, latitude, longitude, status, vehicleId ?? null, now, now)
    .run();
}
