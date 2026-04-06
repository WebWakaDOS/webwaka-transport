/**
 * T-TRN-05: Digital Parcel Waybill Recording
 * Invariants: Event-Driven, Multi-Tenant, Nigeria-First
 *
 * Transport records the physical movement of cargo parcels onto/off buses.
 * The Logistics repo is responsible for parcel tracking and delivery state.
 *
 * Architecture: Transport emits trip.cargo_loaded / trip.cargo_unloaded events.
 *   drainEventBus() forwards them to logistics.webwaka.app via deliverToConsumer().
 *   Transport does NOT build parcel tracking here — that lives in the Logistics repo.
 *
 * Routes (mounted at /api/logistics):
 *   POST   /trns_trips/:tripId/parcels                — link parcel(s) to trip (cargo load)
 *   GET    /trns_trips/:tripId/parcels                — list all parcels on a trip
 *   DELETE /trns_trips/:tripId/parcels/:trackingRef   — remove parcel from trip (manual unload)
 */
import { Hono } from 'hono';
import type { AppContext } from './types';
import { requireFields, genId } from './types';
import { requireRole, publishEvent } from '@webwaka/core';

export const logisticsRouter = new Hono<AppContext>();

// ============================================================
// Shared DB row type
// ============================================================

type DbTripParcel = {
  id: string;
  trip_id: string;
  operator_id: string;
  tracking_ref: string;
  description: string | null;
  weight_kg: number | null;
  sender_name: string | null;
  receiver_name: string | null;
  receiver_phone: string | null;
  loaded_at: number;
  loaded_by: string | null;
  unloaded_at: number | null;
  status: string;
  created_at: number;
};

// ============================================================
// POST /api/logistics/trns_trips/:tripId/parcels
// Link one or more parcel tracking references to a trip.
// Emits trip.cargo_loaded (one event containing the full parcel list).
// Roles: STAFF, TENANT_ADMIN, SUPER_ADMIN
// ============================================================
logisticsRouter.post('/trns_trips/:tripId/parcels',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tripId = c.req.param('tripId');
    let body: Record<string, unknown>;
    try { body = await c.req.json() as Record<string, unknown>; }
    catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

    const err = requireFields(body, ['tracking_ref']);
    if (err) return c.json({ success: false, error: err }, 400);

    const {
      tracking_ref,
      description,
      weight_kg,
      sender_name,
      receiver_name,
      receiver_phone,
    } = body as {
      tracking_ref: string;
      description?: string;
      weight_kg?: number;
      sender_name?: string;
      receiver_name?: string;
      receiver_phone?: string;
    };

    const trackingRef = tracking_ref.trim().toUpperCase();
    if (!trackingRef) {
      return c.json({ success: false, error: 'tracking_ref cannot be empty' }, 400);
    }

    const db = c.env.DB;
    const user = c.get('user');
    const now = Date.now();

    // Validate trip exists and is not completed/cancelled
    const trip = await db.prepare(
      `SELECT id, operator_id, state FROM trns_trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(tripId).first<{ id: string; operator_id: string; state: string }>();

    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);
    if (trip.state === 'completed' || trip.state === 'cancelled') {
      return c.json({
        success: false,
        error: `Cannot load parcels onto a ${trip.state} trip`,
      }, 409);
    }

    // Tenant scope guard
    const operatorScope = user?.role === 'SUPER_ADMIN' ? null : (user?.operatorId ?? null);
    if (operatorScope && trip.operator_id !== operatorScope) {
      return c.json({ success: false, error: 'Trip not found' }, 404);
    }

    // Check for duplicate (same trip + tracking_ref)
    const existing = await db.prepare(
      `SELECT id FROM trns_trip_parcels WHERE trip_id = ? AND tracking_ref = ?`
    ).bind(tripId, trackingRef).first<{ id: string }>();
    if (existing) {
      return c.json({
        success: false,
        error: `Parcel ${trackingRef} is already loaded on this trip`,
      }, 409);
    }

    const parcelId = genId('prc');
    await db.prepare(
      `INSERT INTO trns_trip_parcels
       (id, trip_id, operator_id, tracking_ref, description, weight_kg,
        sender_name, receiver_name, receiver_phone, loaded_at, loaded_by,
        unloaded_at, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(
      parcelId,
      tripId,
      trip.operator_id,
      trackingRef,
      description ?? null,
      weight_kg ?? null,
      sender_name ?? null,
      receiver_name ?? null,
      receiver_phone ?? null,
      now,
      user?.id ?? null,
      null,
      'on_board',
      now,
    ).run();

    // Emit trip.cargo_loaded — non-fatal
    try {
      await publishEvent(db, {
        event_type: 'trip.cargo_loaded',
        aggregate_id: tripId,
        aggregate_type: 'trip',
        payload: {
          trip_id: tripId,
          operator_id: trip.operator_id,
          parcels: [{
            trip_parcel_id: parcelId,
            tracking_ref: trackingRef,
            description: description ?? null,
            weight_kg: weight_kg ?? null,
            sender_name: sender_name ?? null,
            receiver_name: receiver_name ?? null,
            loaded_at: now,
            loaded_by: user?.id ?? null,
          }],
          total_parcels_on_trip: null,
        },
        timestamp: now,
      });
    } catch { /* non-fatal — event emission must not block the load record */ }

    return c.json({
      success: true,
      data: {
        id: parcelId,
        trip_id: tripId,
        tracking_ref: trackingRef,
        description: description ?? null,
        weight_kg: weight_kg ?? null,
        sender_name: sender_name ?? null,
        receiver_name: receiver_name ?? null,
        receiver_phone: receiver_phone ?? null,
        loaded_at: now,
        status: 'on_board',
      },
    }, 201);
  }
);

// ============================================================
// GET /api/logistics/trns_trips/:tripId/parcels
// List all parcels currently linked to a trip.
// Roles: STAFF, TENANT_ADMIN, SUPER_ADMIN
// ============================================================
logisticsRouter.get('/trns_trips/:tripId/parcels',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tripId = c.req.param('tripId');
    const db = c.env.DB;
    const user = c.get('user');

    const trip = await db.prepare(
      `SELECT id, operator_id FROM trns_trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(tripId).first<{ id: string; operator_id: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    const operatorScope = user?.role === 'SUPER_ADMIN' ? null : (user?.operatorId ?? null);
    if (operatorScope && trip.operator_id !== operatorScope) {
      return c.json({ success: false, error: 'Trip not found' }, 404);
    }

    const parcels = await db.prepare(
      `SELECT * FROM trns_trip_parcels WHERE trip_id = ? ORDER BY loaded_at ASC`
    ).bind(tripId).all<DbTripParcel>();

    return c.json({
      success: true,
      data: parcels.results,
      meta: { count: parcels.results.length },
    });
  }
);

// ============================================================
// DELETE /api/logistics/trns_trips/:tripId/parcels/:trackingRef
// Manually remove a parcel from a trip (before trip completes).
// Emits trip.cargo_unloaded for this specific parcel.
// Roles: STAFF, TENANT_ADMIN, SUPER_ADMIN
// ============================================================
logisticsRouter.delete('/trns_trips/:tripId/parcels/:trackingRef',
  requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']),
  async (c) => {
    const tripId = c.req.param('tripId');
    const trackingRef = c.req.param('trackingRef').toUpperCase();
    const db = c.env.DB;
    const user = c.get('user');
    const now = Date.now();

    const trip = await db.prepare(
      `SELECT id, operator_id, state FROM trns_trips WHERE id = ? AND deleted_at IS NULL`
    ).bind(tripId).first<{ id: string; operator_id: string; state: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    const operatorScope = user?.role === 'SUPER_ADMIN' ? null : (user?.operatorId ?? null);
    if (operatorScope && trip.operator_id !== operatorScope) {
      return c.json({ success: false, error: 'Trip not found' }, 404);
    }

    const parcel = await db.prepare(
      `SELECT id, status FROM trns_trip_parcels WHERE trip_id = ? AND tracking_ref = ?`
    ).bind(tripId, trackingRef).first<{ id: string; status: string }>();

    if (!parcel) {
      return c.json({ success: false, error: 'Parcel not found on this trip' }, 404);
    }
    if (parcel.status !== 'on_board') {
      return c.json({
        success: false,
        error: `Parcel is already ${parcel.status} — cannot remove`,
      }, 409);
    }

    await db.prepare(
      `UPDATE trns_trip_parcels SET status = ?, unloaded_at = ? WHERE id = ?`
    ).bind('removed', now, parcel.id).run();

    // Emit trip.cargo_unloaded — non-fatal
    try {
      await publishEvent(db, {
        event_type: 'trip.cargo_unloaded',
        aggregate_id: tripId,
        aggregate_type: 'trip',
        payload: {
          trip_id: tripId,
          operator_id: trip.operator_id,
          tracking_refs: [trackingRef],
          reason: 'manual_removal',
          unloaded_at: now,
          unloaded_by: user?.id ?? null,
        },
        timestamp: now,
      });
    } catch { /* non-fatal */ }

    return c.json({ success: true, data: { trip_id: tripId, tracking_ref: trackingRef, status: 'removed', unloaded_at: now } });
  }
);

// ============================================================
// Internal helper — emit trip.cargo_unloaded for ALL on-board
// parcels when a trip reaches a terminal state.
//
// reason:      'trip_completed' | 'trip_cancelled'
// finalStatus: 'delivered' (completion) | 'removed' (cancellation)
//
// Called from operator-management.ts post-transition hook for
// BOTH completed and cancelled terminal states.
// ============================================================
export async function emitCargoUnloadedOnTripEnd(
  db: D1Database,
  tripId: string,
  operatorId: string,
  now: number,
  reason: 'trip_completed' | 'trip_cancelled',
  finalStatus: 'delivered' | 'removed'
): Promise<void> {
  try {
    const onBoard = await db.prepare(
      `SELECT id, tracking_ref FROM trns_trip_parcels
       WHERE trip_id = ? AND status = 'on_board'`
    ).bind(tripId).all<{ id: string; tracking_ref: string }>();

    if (!onBoard.results || onBoard.results.length === 0) return;

    const trackingRefs = onBoard.results.map(p => p.tracking_ref);

    // Batch-update all on-board parcels to their final status
    await db.batch(
      onBoard.results.map(p =>
        db.prepare(
          `UPDATE trns_trip_parcels SET status = ?, unloaded_at = ? WHERE id = ?`
        ).bind(finalStatus, now, p.id)
      )
    );

    await publishEvent(db, {
      event_type: 'trip.cargo_unloaded',
      aggregate_id: tripId,
      aggregate_type: 'trip',
      payload: {
        trip_id: tripId,
        operator_id: operatorId,
        tracking_refs: trackingRefs,
        reason,
        unloaded_at: now,
      },
      timestamp: now,
    });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[logistics] emitCargoUnloadedOnTripEnd (${reason}) failed (non-fatal): ${msg}`);
  }
}
