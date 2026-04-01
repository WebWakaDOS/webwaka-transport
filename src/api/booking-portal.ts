/**
 * TRN-3: Customer Booking Portal API
 * Invariants: NDPR consent, Nigeria-First (Paystack), Offline-First, Event-Driven
 * Security: JWT auth via global middleware in worker.ts; per-route RBAC via requireRole
 * Events: booking.created published to platform Event Bus (D1 outbox) on booking confirmation
 */
import { Hono } from 'hono';
import { requireRole, requireTierFeature, nanoid, generateJWT } from '@webwaka/core';
import type { AppContext, DbBooking, DbCustomer } from './types';
import { genId, parsePagination, metaResponse, requireFields } from './types';
import { publishEvent } from '../core/events/index';
import { sendSms } from '../lib/sms.js';
import { getOperatorConfig } from '../lib/operator-config.js';
import { initiatePaystackRefund } from '../lib/payments.js';

// ============================================================
// P08-T2: Fare computation helper — applies class multipliers + time multipliers
// ============================================================
interface FareMatrix {
  standard: number; window: number; vip: number; front: number;
  time_multipliers?: {
    peak_hours?: number[]; peak_multiplier?: number;
    peak_days?: number[]; peak_day_multiplier?: number;
  };
}

function computeFareByClass(
  baseFare: number,
  fareMatrix: FareMatrix | null,
  refTimeMs: number,
): Record<string, number> {
  const classMultipliers: Record<string, number> = {
    standard: fareMatrix?.standard ?? 1.0,
    window: fareMatrix?.window ?? 1.0,
    vip: fareMatrix?.vip ?? 1.0,
    front: fareMatrix?.front ?? 1.0,
  };
  let timeMult = 1.0;
  if (fareMatrix?.time_multipliers) {
    const tm = fareMatrix.time_multipliers;
    const hour = new Date(refTimeMs).getUTCHours();
    const day = new Date(refTimeMs).getUTCDay();
    if (tm.peak_hours?.includes(hour)) timeMult = Math.max(timeMult, tm.peak_multiplier ?? 1.0);
    if (tm.peak_days?.includes(day)) timeMult = Math.max(timeMult, tm.peak_day_multiplier ?? 1.0);
  }
  const result: Record<string, number> = {};
  for (const [cls, mult] of Object.entries(classMultipliers)) {
    result[cls] = Math.round(baseFare * mult * timeMult);
  }
  return result;
}

export const bookingPortalRouter = new Hono<AppContext>();

// ============================================================
// GET /routes — public: search available routes
// ============================================================
bookingPortalRouter.get('/routes', async (c) => {
  const { origin, destination } = c.req.query();
  const db = c.env.DB;

  let query = `SELECT r.*, o.name as operator_name FROM routes r
    JOIN operators o ON r.operator_id = o.id
    WHERE r.deleted_at IS NULL AND r.status = 'active'`;
  const params: unknown[] = [];
  if (origin) { query += ` AND r.origin LIKE ?`; params.push(`%${origin}%`); }
  if (destination) { query += ` AND r.destination LIKE ?`; params.push(`%${destination}%`); }
  query += ` ORDER BY r.base_fare ASC`;

  try {
    const result = await db.prepare(query).bind(...params).all();
    return c.json({ success: true, data: result.results });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch routes' }, 500);
  }
});

// ============================================================
// GET /trips/search — public: search trips by route and date
// ============================================================
bookingPortalRouter.get('/trips/search', async (c) => {
  const { origin, destination, date, origin_stop, destination_stop } = c.req.query();
  const db = c.env.DB;

  // P11-T3: If origin_stop or destination_stop provided, use route_stops JOIN
  const useStops = !!(origin_stop || destination_stop);

  let query: string;
  const params: unknown[] = [];

  if (useStops) {
    query = `SELECT t.id, t.departure_time, t.state, r.origin, r.destination, r.base_fare, r.fare_matrix,
      o.name as operator_name,
      COUNT(CASE WHEN s.status = 'available' THEN 1 END) as available_seats,
      ROUND(COALESCE(rev.avg_rating, 0), 1) as avg_rating, COALESCE(rev.review_count, 0) as review_count,
      rs_orig.id as origin_stop_id, rs_orig.stop_name as origin_stop_name,
      rs_orig.sequence as origin_stop_seq, rs_orig.fare_from_origin_kobo as origin_fare_kobo,
      rs_dest.id as destination_stop_id, rs_dest.stop_name as destination_stop_name,
      rs_dest.sequence as destination_stop_seq, rs_dest.fare_from_origin_kobo as dest_fare_kobo
      FROM trips t
      JOIN routes r ON t.route_id = r.id
      JOIN operators o ON t.operator_id = o.id
      LEFT JOIN seats s ON t.id = s.trip_id
      LEFT JOIN (
        SELECT operator_id, AVG(CAST(rating AS REAL)) as avg_rating, COUNT(id) as review_count
        FROM operator_reviews WHERE deleted_at IS NULL GROUP BY operator_id
      ) rev ON rev.operator_id = t.operator_id
      JOIN route_stops rs_orig ON rs_orig.route_id = r.id
      JOIN route_stops rs_dest ON rs_dest.route_id = r.id
      WHERE t.deleted_at IS NULL AND t.state IN ('scheduled', 'boarding')
        AND r.route_stops_enabled = 1
        AND rs_orig.sequence < rs_dest.sequence`;

    if (origin_stop) { query += ` AND rs_orig.stop_name LIKE ?`; params.push(`%${origin_stop}%`); }
    if (destination_stop) { query += ` AND rs_dest.stop_name LIKE ?`; params.push(`%${destination_stop}%`); }
    if (origin) { query += ` AND r.origin LIKE ?`; params.push(`%${origin}%`); }
    if (destination) { query += ` AND r.destination LIKE ?`; params.push(`%${destination}%`); }
    if (date) {
      const start = new Date(date).setHours(0, 0, 0, 0);
      const end = new Date(date).setHours(23, 59, 59, 999);
      query += ` AND t.departure_time BETWEEN ? AND ?`;
      params.push(start, end);
    }
    query += ` GROUP BY t.id, rs_orig.id, rs_dest.id HAVING available_seats > 0 ORDER BY t.departure_time ASC`;
  } else {
    query = `SELECT t.id, t.departure_time, t.state, r.origin, r.destination, r.base_fare, r.fare_matrix,
      o.name as operator_name,
      COUNT(CASE WHEN s.status = 'available' THEN 1 END) as available_seats,
      ROUND(COALESCE(rev.avg_rating, 0), 1) as avg_rating, COALESCE(rev.review_count, 0) as review_count
      FROM trips t
      JOIN routes r ON t.route_id = r.id
      JOIN operators o ON t.operator_id = o.id
      LEFT JOIN seats s ON t.id = s.trip_id
      LEFT JOIN (
        SELECT operator_id, AVG(CAST(rating AS REAL)) as avg_rating, COUNT(id) as review_count
        FROM operator_reviews WHERE deleted_at IS NULL GROUP BY operator_id
      ) rev ON rev.operator_id = t.operator_id
      WHERE t.deleted_at IS NULL AND t.state IN ('scheduled', 'boarding')`;

    if (origin) { query += ` AND r.origin LIKE ?`; params.push(`%${origin}%`); }
    if (destination) { query += ` AND r.destination LIKE ?`; params.push(`%${destination}%`); }
    if (date) {
      const start = new Date(date).setHours(0, 0, 0, 0);
      const end = new Date(date).setHours(23, 59, 59, 999);
      query += ` AND t.departure_time BETWEEN ? AND ?`;
      params.push(start, end);
    }
    query += ` GROUP BY t.id HAVING available_seats > 0 ORDER BY t.departure_time ASC`;
  }

  try {
    const result = await db.prepare(query).bind(...params).all<{
      id: string; departure_time: number; state: string; origin: string; destination: string;
      base_fare: number; fare_matrix: string | null; operator_name: string; available_seats: number;
      // stop columns (only present when useStops)
      origin_stop_id?: string; origin_stop_name?: string; origin_stop_seq?: number; origin_fare_kobo?: number | null;
      destination_stop_id?: string; destination_stop_name?: string; destination_stop_seq?: number; dest_fare_kobo?: number | null;
    }>();

    const enriched = result.results.map(trip => {
      const fareMatrix: FareMatrix | null = trip.fare_matrix ? JSON.parse(trip.fare_matrix) as FareMatrix : null;
      let effective_fare_by_class = computeFareByClass(trip.base_fare, fareMatrix, trip.departure_time);
      let effective_fare = Math.min(...Object.values(effective_fare_by_class));
      const avg_rating = (trip as Record<string, unknown>)['avg_rating'] as number ?? 0;
      const review_count = (trip as Record<string, unknown>)['review_count'] as number ?? 0;

      // P11-T3: Compute segment fare for stop-based search
      let segment_fare: number | undefined;
      if (useStops && trip.dest_fare_kobo != null && trip.origin_fare_kobo != null) {
        segment_fare = trip.dest_fare_kobo - trip.origin_fare_kobo;
        if (segment_fare > 0) {
          effective_fare = segment_fare;
          effective_fare_by_class = { standard: segment_fare, window: segment_fare, vip: segment_fare, front: segment_fare };
        }
      }

      return {
        ...trip,
        fare_matrix: undefined,
        effective_fare_by_class,
        effective_fare,
        avg_rating,
        review_count,
        ...(useStops ? {
          origin_stop_id: trip.origin_stop_id,
          origin_stop_name: trip.origin_stop_name,
          destination_stop_id: trip.destination_stop_id,
          destination_stop_name: trip.destination_stop_name,
          segment_fare,
        } : {}),
      };
    });

    return c.json({ success: true, data: enriched });
  } catch {
    return c.json({ success: false, error: 'Failed to search trips' }, 500);
  }
});

// ============================================================
// POST /customers — register or update customer (NDPR enforced)
// ============================================================
bookingPortalRouter.post('/customers', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'CUSTOMER']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['name', 'phone']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { name, phone, email, ndpr_consent } = body as {
    name: string; phone: string; email?: string; ndpr_consent?: boolean;
  };

  if (!ndpr_consent) {
    return c.json({ success: false, error: 'NDPR consent is required to create a customer account' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  try {
    const existing = await db.prepare(
      `SELECT * FROM customers WHERE phone = ? AND deleted_at IS NULL`
    ).bind(phone).first<DbCustomer>();

    if (existing) {
      await db.prepare(`UPDATE customers SET name = ?, email = ?, ndpr_consent = 1, updated_at = ? WHERE id = ?`)
        .bind(name, email ?? null, now, existing.id).run();
      return c.json({ success: true, data: { id: existing.id, name, phone, ndpr_consent: true } });
    }

    const id = genId('cust');
    await db.prepare(
      `INSERT INTO customers (id, name, phone, email, ndpr_consent, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 1, 'active', ?, ?)`
    ).bind(id, name, phone, email ?? null, now, now).run();

    return c.json({ success: true, data: { id, name, phone, ndpr_consent: true } }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to register customer' }, 500);
  }
});

// ============================================================
// POST /bookings — create a booking (seat reservation → pending)
// ============================================================
bookingPortalRouter.post('/bookings', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'CUSTOMER']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['customer_id', 'trip_id', 'seat_ids', 'passenger_names', 'payment_method']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { customer_id, trip_id, seat_ids, passenger_names, payment_method, ndpr_consent,
          origin_stop_id, destination_stop_id } = body as {
    customer_id: string; trip_id: string; seat_ids: string[]; passenger_names: string[];
    payment_method: string; ndpr_consent?: boolean;
    origin_stop_id?: string; destination_stop_id?: string;
  };

  if (!ndpr_consent) return c.json({ success: false, error: 'NDPR consent required to process booking' }, 400);
  if (!Array.isArray(seat_ids) || seat_ids.length === 0) {
    return c.json({ success: false, error: 'At least one seat_id required' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const user = c.get('user');
  const isGuest = user?.id?.startsWith('guest_') ?? false;

  try {
    // P03-T6: Guest booking — create minimal customer record for guest JWT holders
    if (isGuest) {
      const guestId = customer_id;
      const guestName = Array.isArray(passenger_names) && passenger_names.length > 0
        ? String(passenger_names[0])
        : 'Guest';
      const guestPhone = user?.phone ?? '';
      await db.prepare(
        `INSERT OR IGNORE INTO customers (id, name, phone, email, ndpr_consent, status, created_at, updated_at)
         VALUES (?, ?, ?, NULL, 1, 'active', ?, ?)`
      ).bind(guestId, guestName, guestPhone, now, now).run();
    }

    const customer = await db.prepare(
      `SELECT * FROM customers WHERE id = ? AND ndpr_consent = 1`
    ).bind(customer_id).first<DbCustomer>();
    if (!customer) return c.json({ success: false, error: 'Customer not found or NDPR consent not given' }, 404);

    const trip = await db.prepare(
      `SELECT t.id, t.state, t.operator_id, t.departure_time, r.base_fare, r.fare_matrix
       FROM trips t JOIN routes r ON t.route_id = r.id WHERE t.id = ?`
    ).bind(trip_id).first<{ id: string; state: string; operator_id: string; departure_time: number; base_fare: number; fare_matrix: string | null }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    // P08-T2: Compute expected fare using seat classes and fare matrix
    const seatRows = await db.prepare(
      `SELECT id, seat_class FROM seats WHERE id IN (${seat_ids.map(() => '?').join(',')}) AND trip_id = ?`
    ).bind(...seat_ids, trip_id).all<{ id: string; seat_class: string }>();

    if (seatRows.results.length !== seat_ids.length) {
      return c.json({ success: false, error: 'One or more seat IDs not found for this trip' }, 404);
    }

    const fareMatrix: FareMatrix | null = trip.fare_matrix ? JSON.parse(trip.fare_matrix) as FareMatrix : null;
    const fareByClass = computeFareByClass(trip.base_fare, fareMatrix, trip.departure_time);
    const expected_kobo = seatRows.results.reduce((sum, seat) => {
      return sum + (fareByClass[seat.seat_class] ?? fareByClass['standard'] ?? trip.base_fare);
    }, 0);

    // Validate submitted total if provided (±2% tolerance)
    const body_amount = (body as Record<string, unknown>).total_amount_kobo as number | undefined;
    if (body_amount !== undefined) {
      const tolerance = Math.round(expected_kobo * 0.02);
      if (Math.abs(body_amount - expected_kobo) > tolerance) {
        return c.json({
          success: false, error: 'fare_mismatch',
          expected_kobo, submitted_kobo: body_amount,
        }, 422);
      }
    }

    // P11-T3: Validate stop IDs if provided
    let validatedOriginStopId: string | null = null;
    let validatedDestStopId: string | null = null;
    if (origin_stop_id || destination_stop_id) {
      const tripRoute = await db.prepare(
        `SELECT r.id as route_id FROM trips t JOIN routes r ON t.route_id = r.id WHERE t.id = ?`
      ).bind(trip_id).first<{ route_id: string }>();

      if (origin_stop_id) {
        const origStop = await db.prepare(
          `SELECT id, sequence FROM route_stops WHERE id = ? AND route_id = ?`
        ).bind(origin_stop_id, tripRoute?.route_id ?? '').first<{ id: string; sequence: number }>();
        if (!origStop) return c.json({ success: false, error: 'origin_stop_id not found on this route' }, 400);
        validatedOriginStopId = origStop.id;

        if (destination_stop_id) {
          const destStop = await db.prepare(
            `SELECT id, sequence FROM route_stops WHERE id = ? AND route_id = ?`
          ).bind(destination_stop_id, tripRoute?.route_id ?? '').first<{ id: string; sequence: number }>();
          if (!destStop) return c.json({ success: false, error: 'destination_stop_id not found on this route' }, 400);
          if (destStop.sequence <= origStop.sequence) {
            return c.json({ success: false, error: 'destination stop must come after origin stop (reverse routing not permitted)' }, 422);
          }
          validatedDestStopId = destStop.id;
        }
      } else if (destination_stop_id) {
        const destStop = await db.prepare(
          `SELECT id FROM route_stops WHERE id = ? AND route_id = ?`
        ).bind(destination_stop_id, tripRoute?.route_id ?? '').first<{ id: string }>();
        if (!destStop) return c.json({ success: false, error: 'destination_stop_id not found on this route' }, 400);
        validatedDestStopId = destStop.id;
      }
    }

    const total_amount = body_amount ?? expected_kobo;
    // P03-T3: Paystack-compatible reference using waka_ prefix + 16-char random
    const payment_reference = `waka_${nanoid('', 16)}`;
    const id = genId('bkg');

    // P15-T3: Credit payment for corporate customers
    let initialPaymentStatus = 'pending';
    if (payment_method === 'credit') {
      const corpCustomer = await db.prepare(
        `SELECT customer_type, credit_limit_kobo FROM customers WHERE id = ? AND deleted_at IS NULL`
      ).bind(customer_id).first<{ customer_type: string; credit_limit_kobo: number }>();

      if (!corpCustomer || corpCustomer.customer_type !== 'corporate') {
        // 422 Unprocessable Entity: request is well-formed but customer is not eligible for credit
        return c.json({ success: false, error: 'Credit payment is only available for corporate accounts' }, 422);
      }

      const new_credit_balance = corpCustomer.credit_limit_kobo - total_amount;
      if (new_credit_balance < 0) {
        return c.json({
          success: false,
          error: 'insufficient_credit',
          available_kobo: corpCustomer.credit_limit_kobo,
          required_kobo: total_amount,
        }, 402);
      }

      // Atomic D1 batch: decrement credit and insert booking in a single roundtrip
      initialPaymentStatus = 'completed';
      await db.batch([
        db.prepare(
          `UPDATE customers SET credit_limit_kobo = ? WHERE id = ?`
        ).bind(new_credit_balance, customer_id),
        db.prepare(
          `INSERT INTO bookings (id, customer_id, trip_id, seat_ids, passenger_names, total_amount, status, payment_status, payment_method, payment_reference, is_guest, origin_stop_id, destination_stop_id, created_at)
           VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
        ).bind(id, customer_id, trip_id, JSON.stringify(seat_ids), JSON.stringify(passenger_names), total_amount, initialPaymentStatus, payment_method, payment_reference, isGuest ? 1 : 0, validatedOriginStopId, validatedDestStopId, now),
      ]);
    } else {
      await db.prepare(
        `INSERT INTO bookings (id, customer_id, trip_id, seat_ids, passenger_names, total_amount, status, payment_status, payment_method, payment_reference, is_guest, origin_stop_id, destination_stop_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', ?, ?, ?, ?, ?, ?, ?)`
      ).bind(id, customer_id, trip_id, JSON.stringify(seat_ids), JSON.stringify(passenger_names), total_amount, initialPaymentStatus, payment_method, payment_reference, isGuest ? 1 : 0, validatedOriginStopId, validatedDestStopId, now).run();
    }

    return c.json({
      success: true,
      data: { id, customer_id, trip_id, seat_ids, total_amount, expected_kobo, payment_method, payment_reference,
              status: 'pending', payment_status: initialPaymentStatus,
              ...(validatedOriginStopId ? { origin_stop_id: validatedOriginStopId } : {}),
              ...(validatedDestStopId ? { destination_stop_id: validatedDestStopId } : {}) },
    }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to create booking' }, 500);
  }
});

// ============================================================
// PATCH /bookings/:id — update booking (SyncEngine offline mutations)
// Supports: payment_reference, payment_method update before confirmation
// ============================================================
bookingPortalRouter.patch('/bookings/:id', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'CUSTOMER']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const db = c.env.DB;
  const now = Date.now();

  try {
    const booking = await db.prepare(
      `SELECT * FROM bookings WHERE id = ? AND deleted_at IS NULL`
    ).bind(id).first<DbBooking>();

    if (!booking) return c.json({ success: false, error: 'Booking not found' }, 404);
    if (booking.status === 'cancelled') {
      return c.json({ success: false, error: 'Cannot update a cancelled booking' }, 409);
    }

    const { payment_reference, payment_method, status } = body as {
      payment_reference?: string;
      payment_method?: string;
      status?: string;
    };

    // Only allow status → 'cancelled' via PATCH (confirmation uses /confirm)
    if (status && status !== 'cancelled') {
      return c.json({ success: false, error: 'Use /confirm endpoint to confirm a booking' }, 422);
    }

    await db.prepare(
      `UPDATE bookings
       SET payment_reference = COALESCE(?, payment_reference),
           payment_method = COALESCE(?, payment_method),
           status = COALESCE(?, status)
       WHERE id = ?`
    ).bind(payment_reference ?? null, payment_method ?? null, status ?? null, id).run();

    return c.json({ success: true, data: { id, updated_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to update booking' }, 500);
  }
});

// ============================================================
// PATCH /bookings/:id/confirm — confirm payment; publishes booking.created event
// ============================================================
bookingPortalRouter.patch('/bookings/:id/confirm', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'CUSTOMER']), async (c) => {
  const id = c.req.param('id');
  const body = await c.req.json() as Record<string, unknown>;
  const { payment_reference } = body as { payment_reference?: string };

  const db = c.env.DB;
  const now = Date.now();

  try {
    const booking = await db.prepare(
      `SELECT b.*, r.origin, r.destination, t.departure_time, c.phone as customer_phone, c.name as customer_name
       FROM bookings b
       JOIN trips t ON t.id = b.trip_id
       JOIN routes r ON r.id = t.route_id
       JOIN customers c ON c.id = b.customer_id
       WHERE b.id = ?`
    ).bind(id).first<DbBooking & {
      origin: string; destination: string; departure_time: number;
      customer_phone: string | null; customer_name: string | null;
    }>();

    if (!booking) return c.json({ success: false, error: 'Booking not found' }, 404);
    if (booking.status === 'confirmed') return c.json({ success: false, error: 'Already confirmed' }, 409);
    if (booking.status === 'cancelled') return c.json({ success: false, error: 'Booking is cancelled' }, 409);

    const seatIds = JSON.parse(booking.seat_ids) as string[];

    // Fetch seat numbers for SMS message
    const seatPlaceholders = seatIds.map(() => '?').join(', ');
    const seatsResult = await db.prepare(
      `SELECT seat_number FROM seats WHERE id IN (${seatPlaceholders})`
    ).bind(...seatIds).all<{ seat_number: string }>();
    const seatNumbers = seatsResult.results.map(s => s.seat_number).join(', ');

    await db.batch([
      db.prepare(
        `UPDATE bookings SET status = 'confirmed', payment_status = 'completed', confirmed_at = ? WHERE id = ?`
      ).bind(now, id),
      ...seatIds.map(seatId =>
        db.prepare(
          `UPDATE seats SET status = ?, confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`
        ).bind('confirmed', id, now, now, seatId)
      ),
    ]);

    // P03-T4: enriched payload for SMS confirmation via event bus
    await publishEvent(db, {
      event_type: 'booking.created',
      aggregate_id: id,
      aggregate_type: 'booking',
      payload: {
        booking_id: id,
        customer_id: booking.customer_id,
        customer_phone: booking.customer_phone ?? '',
        customer_name: booking.customer_name ?? '',
        trip_id: booking.trip_id,
        origin: booking.origin ?? '',
        destination: booking.destination ?? '',
        departure_date: booking.departure_time ?? null,
        seat_ids: seatIds,
        seat_numbers: seatNumbers,
        total_amount: booking.total_amount,
        payment_method: booking.payment_method,
        payment_reference: payment_reference ?? booking.payment_reference,
        confirmed_at: now,
      },
      ...(payment_reference ? { correlation_id: payment_reference } : {}),
      timestamp: now,
    });

    return c.json({ success: true, data: { id, status: 'confirmed', payment_status: 'completed', confirmed_at: now } });
  } catch {
    return c.json({ success: false, error: 'Failed to confirm booking' }, 500);
  }
});

// ============================================================
// PATCH /bookings/:id/cancel — cancel + P08-T3 policy-based refund
// ============================================================
bookingPortalRouter.patch('/bookings/:id/cancel', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'CUSTOMER']), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const now = Date.now();

  try {
    const booking = await db.prepare(
      `SELECT b.*, t.departure_time, t.operator_id FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       WHERE b.id = ?`
    ).bind(id).first<DbBooking & { departure_time: number; operator_id: string }>();

    if (!booking) return c.json({ success: false, error: 'Booking not found' }, 404);
    if (booking.status === 'cancelled') return c.json({ success: false, error: 'Already cancelled' }, 409);

    // P08-T3: Compute refund amount from cancellation policy
    const opConfig = await getOperatorConfig(c.env, booking.operator_id);
    const hoursUntilDeparture = (booking.departure_time - now) / 3_600_000;
    const { free_before_hours, half_refund_before_hours } = opConfig.cancellation_policy;

    let refund_amount_kobo = 0;
    if (hoursUntilDeparture > free_before_hours) {
      refund_amount_kobo = booking.total_amount; // full refund
    } else if (hoursUntilDeparture > half_refund_before_hours) {
      refund_amount_kobo = Math.floor(booking.total_amount / 2); // half refund
    }

    const seatIds = JSON.parse(booking.seat_ids) as string[];

    // Build base update — always cancel the booking
    let refund_reference: string | null = null;
    let manual_refund_required = 0;

    // Initiate automated refund for online payment methods
    if (refund_amount_kobo > 0 && booking.payment_status === 'completed') {
      const onlineMethods = ['paystack', 'flutterwave'];
      if (onlineMethods.includes(booking.payment_method) && booking.payment_reference) {
        try {
          refund_reference = await initiatePaystackRefund(booking.payment_reference, refund_amount_kobo, c.env);
        } catch (err) {
          console.warn('[cancel] Paystack refund failed:', err);
          // non-fatal — log and proceed with cancellation
        }
      } else if (booking.payment_method === 'cash') {
        manual_refund_required = 1;
      }
    }

    await db.batch([
      db.prepare(
        `UPDATE bookings
         SET status = 'cancelled', cancelled_at = ?,
             refund_amount_kobo = ?, refund_reference = ?, manual_refund_required = ?
         WHERE id = ?`
      ).bind(now, refund_amount_kobo, refund_reference, manual_refund_required, id),
      ...seatIds.map(seatId =>
        db.prepare(
          `UPDATE seats SET status = 'available', reserved_by = NULL, reservation_token = NULL, confirmed_by = NULL, updated_at = ? WHERE id = ?`
        ).bind(now, seatId)
      ),
    ]);

    // Publish refund event if applicable
    if (refund_reference) {
      await publishEvent(db, {
        event_type: 'booking.refunded',
        aggregate_id: id,
        aggregate_type: 'booking',
        payload: { booking_id: id, refund_reference, refund_amount_kobo },
        timestamp: now,
      }).catch(() => {});
    }

    // P08-T4: Notify the first waitlisted customer for this trip after seats are freed
    await notifyWaitlist(db, booking.trip_id, c.env).catch(() => {});

    return c.json({
      success: true,
      data: { id, status: 'cancelled', cancelled_at: now, refund_amount_kobo, refund_reference, manual_refund_required },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to cancel booking' }, 500);
  }
});

// ============================================================
// GET /bookings — list bookings
// ============================================================
bookingPortalRouter.get('/bookings', async (c) => {
  const q = c.req.query();
  const { customer_id, status } = q;
  const { limit, offset } = parsePagination(q);
  const db = c.env.DB;

  let query = `SELECT b.*, r.origin, r.destination, t.departure_time
    FROM bookings b
    JOIN trips t ON b.trip_id = t.id
    JOIN routes r ON t.route_id = r.id
    WHERE b.deleted_at IS NULL`;
  const params: unknown[] = [];
  if (customer_id) { query += ` AND b.customer_id = ?`; params.push(customer_id); }
  if (status) { query += ` AND b.status = ?`; params.push(status); }
  query += ` ORDER BY b.created_at DESC LIMIT ? OFFSET ?`;
  params.push(limit, offset);

  try {
    const result = await db.prepare(query).bind(...params).all<DbBooking>();
    return c.json({ success: true, data: result.results, meta: metaResponse(result.results.length, limit, offset) });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch bookings' }, 500);
  }
});

// ============================================================
// P08-T4: Waitlist — helper to notify first queued customer after seats freed
// ============================================================
type D1Database = AppContext['Bindings']['DB'];

interface WaitlistRow {
  id: string; trip_id: string; customer_id: string; seat_class: string;
  position: number; notified_at: number | null; expires_at: number | null;
}

async function notifyWaitlist(db: D1Database, trip_id: string, env: AppContext['Bindings']) {
  type WL = { id: string; customer_id: string; seat_class: string };
  const entry = await db.prepare(
    `SELECT wl.id, wl.customer_id, wl.seat_class FROM waiting_list wl
     WHERE wl.trip_id = ? AND wl.deleted_at IS NULL AND wl.notified_at IS NULL
     ORDER BY wl.position ASC LIMIT 1`
  ).bind(trip_id).first<WL>();
  if (!entry) return;

  const seat = await db.prepare(
    `SELECT id FROM seats WHERE trip_id = ? AND seat_class = ? AND status = 'available' LIMIT 1`
  ).bind(trip_id, entry.seat_class).first<{ id: string }>();
  if (!seat) return;

  const customer = await db.prepare(
    `SELECT phone FROM customers WHERE id = ?`
  ).bind(entry.customer_id).first<{ phone: string }>();

  const now = Date.now();
  const expires_at = now + 10 * 60_000; // T4-5: 10-minute hold window
  await db.prepare(
    `UPDATE waiting_list SET notified_at = ?, expires_at = ? WHERE id = ?`
  ).bind(now, expires_at, entry.id).run();

  if (customer?.phone) {
    await sendSms(
      customer.phone,
      `WebWaka: A ${entry.seat_class} seat is available on your waitlisted trip! Book within 10 minutes before it's released.`,
      env,
    ).catch(() => {});
  }
}

// ============================================================
// P08-T4: POST /trips/:id/waitlist — join a waiting list
// ============================================================
bookingPortalRouter.post('/trips/:id/waitlist', requireRole(['CUSTOMER', 'STAFF', 'TENANT_ADMIN', 'SUPER_ADMIN']), requireTierFeature('waiting_list'), async (c) => {
  const trip_id = c.req.param('id');
  const body = await c.req.json() as { customer_id?: string; seat_class?: string };
  const { customer_id, seat_class } = body;
  const db = c.env.DB;
  const now = Date.now();
  const missingField = requireFields(body as Record<string, unknown>, ['customer_id', 'seat_class']);
  if (missingField) return c.json({ success: false, error: missingField }, 400);

  const VALID_CLASSES = ['standard', 'window', 'vip', 'front'];
  if (!VALID_CLASSES.includes(seat_class!)) {
    return c.json({ success: false, error: `seat_class must be one of: ${VALID_CLASSES.join(', ')}` }, 400);
  }

  try {
    const trip = await db.prepare(`SELECT id FROM trips WHERE id = ? AND deleted_at IS NULL`).bind(trip_id).first<{ id: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    // T4-1: Reject if seats of the requested class are still available — waitlist is only for full trips
    const availableCount = await db.prepare(
      `SELECT COUNT(*) as cnt FROM seats WHERE trip_id = ? AND seat_class = ? AND status = 'available'`
    ).bind(trip_id, seat_class).first<{ cnt: number }>();
    if ((availableCount?.cnt ?? 0) > 0) {
      return c.json({
        success: false,
        error: `Seats of class '${seat_class!}' are still available. Waitlist only applies when that class is fully booked.`,
        available_count: availableCount?.cnt ?? 0,
      }, 400);
    }

    // Check if already on waitlist
    const existing = await db.prepare(
      `SELECT id FROM waiting_list WHERE trip_id = ? AND customer_id = ? AND deleted_at IS NULL`
    ).bind(trip_id, customer_id).first();
    if (existing) return c.json({ success: false, error: 'Already on waitlist for this trip' }, 409);

    // Get next position
    const posRow = await db.prepare(
      `SELECT COALESCE(MAX(position), 0) + 1 as next_pos FROM waiting_list WHERE trip_id = ? AND deleted_at IS NULL`
    ).bind(trip_id).first<{ next_pos: number }>();
    const position = posRow?.next_pos ?? 1;

    const wl_id = genId('wl');
    await db.prepare(
      `INSERT INTO waiting_list (id, trip_id, customer_id, seat_class, position, created_at) VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(wl_id, trip_id, customer_id, seat_class, position, now).run();

    return c.json({ success: true, data: { id: wl_id, trip_id, customer_id, seat_class, position } }, 201);
  } catch {
    return c.json({ success: false, error: 'Failed to join waitlist' }, 500);
  }
});

// ============================================================
// P08-T4: GET /trips/:id/waitlist — list all entries (STAFF+)
// ============================================================
bookingPortalRouter.get('/trips/:id/waitlist', requireRole(['STAFF', 'TENANT_ADMIN', 'SUPER_ADMIN']), async (c) => {
  const trip_id = c.req.param('id');
  const db = c.env.DB;
  try {
    const rows = await db.prepare(
      `SELECT wl.*, c.full_name, c.phone FROM waiting_list wl
       JOIN customers c ON wl.customer_id = c.id
       WHERE wl.trip_id = ? AND wl.deleted_at IS NULL
       ORDER BY wl.position ASC`
    ).bind(trip_id).all<WaitlistRow & { full_name: string; phone: string }>();
    return c.json({ success: true, data: rows.results });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch waitlist' }, 500);
  }
});

// ============================================================
// P08-T4: DELETE /trips/:id/waitlist/:wl_id — leave the waiting list (soft delete)
// ============================================================
bookingPortalRouter.delete('/trips/:id/waitlist/:wl_id', requireRole(['CUSTOMER', 'STAFF', 'TENANT_ADMIN', 'SUPER_ADMIN']), async (c) => {
  const { id: trip_id, wl_id } = c.req.param() as { id: string; wl_id: string };
  const db = c.env.DB;
  const now = Date.now();
  try {
    const entry = await db.prepare(
      `SELECT id FROM waiting_list WHERE id = ? AND trip_id = ? AND deleted_at IS NULL`
    ).bind(wl_id, trip_id).first();
    if (!entry) return c.json({ success: false, error: 'Waitlist entry not found' }, 404);
    await db.prepare(`UPDATE waiting_list SET deleted_at = ? WHERE id = ?`).bind(now, wl_id).run();
    return c.json({ success: true, data: { id: wl_id, removed: true } });
  } catch {
    return c.json({ success: false, error: 'Failed to remove waitlist entry' }, 500);
  }
});

// NOTE: POST /group-bookings and GET /group-bookings/:id live on the agent-sales router
// at /api/agent-sales/group-bookings — they require sales_transaction + receipt creation.

// ============================================================
// P08-T5: PATCH /group-bookings/:id/cancel — cancel group booking (STAFF+)
// ============================================================
bookingPortalRouter.patch('/group-bookings/:id/cancel', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF']), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const now = Date.now();
  try {
    const group = await db.prepare(
      `SELECT gb.booking_id, gb.trip_id, b.status, b.seat_ids, b.total_amount, b.payment_status,
              b.payment_method, b.payment_reference, t.departure_time, t.operator_id
       FROM group_bookings gb
       JOIN bookings b ON gb.booking_id = b.id
       JOIN trips t ON gb.trip_id = t.id
       WHERE gb.id = ?`
    ).bind(id).first<{
      booking_id: string; trip_id: string; status: string; seat_ids: string; total_amount: number;
      payment_status: string; payment_method: string; payment_reference: string | null;
      departure_time: number; operator_id: string;
    }>();
    if (!group) return c.json({ success: false, error: 'Group booking not found' }, 404);
    if (group.status === 'cancelled') return c.json({ success: false, error: 'Already cancelled' }, 409);

    const opConfig = await getOperatorConfig(c.env, group.operator_id);
    const hoursUntilDeparture = (group.departure_time - now) / 3_600_000;
    const { free_before_hours, half_refund_before_hours } = opConfig.cancellation_policy;
    let refund_amount_kobo = 0;
    if (hoursUntilDeparture > free_before_hours) {
      refund_amount_kobo = group.total_amount;
    } else if (hoursUntilDeparture > half_refund_before_hours) {
      refund_amount_kobo = Math.floor(group.total_amount / 2);
    }

    let refund_reference: string | null = null;
    let manual_refund_required = 0;
    if (refund_amount_kobo > 0 && group.payment_status === 'completed') {
      if (['paystack', 'flutterwave'].includes(group.payment_method) && group.payment_reference) {
        try { refund_reference = await initiatePaystackRefund(group.payment_reference, refund_amount_kobo, c.env); } catch { /* non-fatal */ }
      } else if (group.payment_method === 'cash') { manual_refund_required = 1; }
    }

    const seatIds = JSON.parse(group.seat_ids) as string[];
    await db.batch([
      db.prepare(
        `UPDATE bookings SET status = 'cancelled', cancelled_at = ?, refund_amount_kobo = ?, refund_reference = ?, manual_refund_required = ? WHERE id = ?`
      ).bind(now, refund_amount_kobo, refund_reference, manual_refund_required, group.booking_id),
      ...seatIds.map(seatId =>
        db.prepare(`UPDATE seats SET status = 'available', confirmed_by = NULL, updated_at = ? WHERE id = ?`).bind(now, seatId)
      ),
    ]);

    await notifyWaitlist(db, group.trip_id, c.env).catch(() => {});

    return c.json({ success: true, data: { group_id: id, booking_id: group.booking_id, status: 'cancelled', refund_amount_kobo, refund_reference, manual_refund_required } });
  } catch {
    return c.json({ success: false, error: 'Failed to cancel group booking' }, 500);
  }
});

// ============================================================
// C-007: POST /trips/ai-search — AI Natural Language Trip Search
// Accepts a freeform query like "Lagos to Abuja tomorrow morning cheap"
// Extracts structured search params via OpenRouter, then runs standard search.
// Falls back to empty results (not 500) if AI is unavailable.
// Rate limit: 5 requests/minute/IP via SESSIONS_KV
// ============================================================

bookingPortalRouter.post('/trips/ai-search', requireTierFeature('ai_search'), async (c) => {
  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const query = body['query'] as string | undefined;
  if (!query || typeof query !== 'string' || query.trim().length === 0) {
    return c.json({ success: false, error: 'query is required' }, 400);
  }

  // Rate limiting via SESSIONS_KV (5 AI calls / minute / IP)
  const clientIp = c.req.header('CF-Connecting-IP') ?? 'unknown';
  if (c.env.SESSIONS_KV) {
    const rateLimitKey = `ai_rl:${clientIp}`;
    try {
      const current = await c.env.SESSIONS_KV.get(rateLimitKey);
      const count = current ? parseInt(current, 10) : 0;
      if (count >= 5) {
        return c.json({ success: false, error: 'Rate limit exceeded. Try again in a minute.' }, 429);
      }
      await c.env.SESSIONS_KV.put(rateLimitKey, String(count + 1), { expirationTtl: 60 });
    } catch { /* non-fatal — continue even if rate limit check fails */ }
  }

  const db = c.env.DB;

  // Extract structured params from natural language query
  let origin: string | undefined;
  let destination: string | undefined;
  let date: string | undefined;

  if (c.env.OPENROUTER_API_KEY) {
    try {
      const { extractTripSearchParams } = await import('../lib/ai.js');
      const params = await extractTripSearchParams(query, c.env);
      origin = params?.origin ?? undefined;
      destination = params?.destination ?? undefined;
      date = params?.date ?? undefined;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error('[ai-search] AI extraction failed, running standard search:', msg);
    }
  }

  // Fall back to treating the whole query as origin/destination search
  if (!origin && !destination) {
    const words = query.trim().split(/\s+/);
    origin = words[0];
    destination = words[words.length - 1];
  }

  // Run standard trip search with extracted params
  let searchQuery = `SELECT t.id, t.departure_time, t.state, r.origin, r.destination, r.base_fare,
    o.name as operator_name,
    COUNT(CASE WHEN s.status = 'available' THEN 1 END) as available_seats
    FROM trips t
    JOIN routes r ON t.route_id = r.id
    JOIN operators o ON t.operator_id = o.id
    LEFT JOIN seats s ON s.trip_id = t.id
    WHERE t.deleted_at IS NULL AND t.state IN ('scheduled', 'boarding')
      AND r.deleted_at IS NULL`;
  const params: unknown[] = [];

  if (origin) { searchQuery += ` AND r.origin LIKE ?`; params.push(`%${origin}%`); }
  if (destination) { searchQuery += ` AND r.destination LIKE ?`; params.push(`%${destination}%`); }
  if (date) {
    const dayStart = new Date(date).setHours(0, 0, 0, 0);
    const dayEnd = dayStart + 86400000 - 1;
    searchQuery += ` AND t.departure_time >= ? AND t.departure_time <= ?`;
    params.push(dayStart, dayEnd);
  }

  searchQuery += ` GROUP BY t.id ORDER BY t.departure_time ASC LIMIT 20`;

  try {
    const result = await db.prepare(searchQuery).bind(...params).all();
    return c.json({
      success: true,
      data: result.results,
      ai_params: { origin, destination, date, query },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to execute AI search' }, 500);
  }
});

// ============================================================
// GET /bookings/:id — booking detail
// ============================================================
bookingPortalRouter.get('/bookings/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  try {
    const booking = await db.prepare(
      `SELECT b.*, r.origin, r.destination,
              t.departure_time, t.current_latitude, t.current_longitude, t.location_updated_at,
              o.name as operator_name
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       JOIN operators o ON t.operator_id = o.id
       WHERE b.id = ?`
    ).bind(id).first();
    if (!booking) return c.json({ success: false, error: 'Booking not found' }, 404);
    return c.json({ success: true, data: booking });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch booking' }, 500);
  }
});

// ============================================================
// P03-T6: Guest Booking — public phone verification endpoints
// These routes are mounted BEFORE jwtAuthMiddleware in worker.ts
// ============================================================

export const publicBookingRouter = new Hono<AppContext>();

const NIGERIAN_PHONE_RE = /^(\+234|0)\d{10}$/;

// POST /api/booking/verify-phone — request OTP for guest booking
publicBookingRouter.post('/verify-phone', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const phone = String(body['phone'] ?? '').trim();
  if (!NIGERIAN_PHONE_RE.test(phone)) {
    return c.json({ success: false, error: 'Invalid Nigerian phone number format. Use +234XXXXXXXXXX or 0XXXXXXXXXX' }, 400);
  }

  if (!c.env.SESSIONS_KV) {
    return c.json({ success: false, error: 'OTP service unavailable' }, 503);
  }

  const otp = String(Math.floor(100_000 + Math.random() * 900_000));
  const kvKey = `guest_otp_${phone}`;
  const expiresAt = Date.now() + 10 * 60 * 1000; // 10 minutes

  try {
    await c.env.SESSIONS_KV.put(kvKey, JSON.stringify({ otp, expires_at: expiresAt }), { expirationTtl: 600 });
  } catch {
    return c.json({ success: false, error: 'Failed to store OTP' }, 500);
  }

  // Non-fatal SMS: never block the guest booking flow
  await sendSms(phone, `Your WebWaka guest booking OTP is: ${otp}. Valid for 10 minutes.`, c.env).catch(() => {});

  const hasSms = Boolean(c.env.SMS_API_KEY || c.env.TERMII_API_KEY);
  return c.json({
    success: true,
    data: {
      message: 'OTP sent',
      ...(hasSms ? {} : { dev_otp: otp }),
    },
  });
});

// POST /api/booking/verify-phone/confirm — verify OTP and issue guest JWT
publicBookingRouter.post('/verify-phone/confirm', async (c) => {
  let body: Record<string, unknown>;
  try { body = await c.req.json<Record<string, unknown>>(); }
  catch { return c.json({ success: false, error: 'Invalid JSON body' }, 400); }

  const phone = String(body['phone'] ?? '').trim();
  const otp = String(body['otp'] ?? '').trim();
  if (!phone || !otp) return c.json({ success: false, error: 'phone and otp are required' }, 400);

  if (!c.env.SESSIONS_KV) {
    return c.json({ success: false, error: 'OTP service unavailable' }, 503);
  }

  const kvKey = `guest_otp_${phone}`;
  let session: { otp: string; expires_at: number } | null = null;
  try {
    const raw = await c.env.SESSIONS_KV.get(kvKey);
    if (raw) session = JSON.parse(raw) as { otp: string; expires_at: number };
  } catch {
    return c.json({ success: false, error: 'Session lookup failed' }, 500);
  }

  if (!session || Date.now() > session.expires_at) {
    return c.json({ success: false, error: 'OTP expired or not found. Request a new one.' }, 401);
  }

  if (otp !== session.otp) {
    return c.json({ success: false, error: 'Incorrect OTP. Check your SMS and try again.' }, 401);
  }

  // Consume the OTP — delete from KV to prevent reuse
  await c.env.SESSIONS_KV.delete(kvKey).catch(() => {});

  if (!c.env.JWT_SECRET) {
    return c.json({ success: false, error: 'Authentication service misconfigured' }, 503);
  }

  const guestId = nanoid('guest_', 16);
  const token = await generateJWT(
    { id: guestId, role: 'CUSTOMER', phone },
    c.env.JWT_SECRET,
    15 * 60, // 15 minutes TTL
  );

  return c.json({
    success: true,
    data: {
      token,
      user: { id: guestId, phone, role: 'CUSTOMER', is_guest: true },
    },
  });
});

// ============================================================
// P15-T3: Corporate Travel Portal
// POST /corporate-accounts — create a corporate account (TENANT_ADMIN+)
// GET  /corporate-accounts — list all corporate accounts (TENANT_ADMIN+)
// GET  /corporate-accounts/:id/statement — credit statement (TENANT_ADMIN+)
// ============================================================

bookingPortalRouter.post('/corporate-accounts', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['company_name', 'contact_name', 'contact_phone', 'credit_limit_naira']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { company_name, contact_name, contact_phone, contact_email, credit_limit_naira } = body as {
    company_name: string; contact_name: string; contact_phone: string;
    contact_email?: string; credit_limit_naira: number;
  };

  if (typeof credit_limit_naira !== 'number' || credit_limit_naira < 0) {
    return c.json({ success: false, error: 'credit_limit_naira must be a non-negative number' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const id = genId('cust');
  const credit_limit_kobo = Math.round(credit_limit_naira * 100);

  try {
    await db.prepare(
      `INSERT INTO customers (id, name, phone, email, company_name, contact_email, customer_type, credit_limit_kobo, ndpr_consent, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'corporate', ?, 1, 'active', ?, ?)`
    ).bind(id, contact_name, contact_phone, contact_email ?? null, company_name, contact_email ?? null, credit_limit_kobo, now, now).run();

    return c.json({
      success: true,
      data: { id, company_name, contact_name, contact_phone, contact_email: contact_email ?? null, customer_type: 'corporate', credit_limit_kobo, status: 'active' },
    }, 201);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : '';
    if (msg.includes('UNIQUE')) return c.json({ success: false, error: 'A corporate account with this phone already exists' }, 409);
    return c.json({ success: false, error: 'Failed to create corporate account' }, 500);
  }
});

bookingPortalRouter.get('/corporate-accounts', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const db = c.env.DB;
  const { limit, offset } = parsePagination(c.req.query());

  try {
    const result = await db.prepare(
      `SELECT id, name, phone, email, company_name, credit_limit_kobo, status, created_at
       FROM customers WHERE customer_type = 'corporate' AND deleted_at IS NULL
       ORDER BY company_name ASC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all<{ id: string; name: string; phone: string; email: string | null; company_name: string | null; credit_limit_kobo: number; status: string; created_at: number }>();

    return c.json({ success: true, data: result.results, meta: metaResponse(result.results.length, limit, offset) });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch corporate accounts' }, 500);
  }
});

bookingPortalRouter.get('/corporate-accounts/:id/statement', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN']), async (c) => {
  const customerId = c.req.param('id');
  const db = c.env.DB;
  const now = Date.now();
  const monthStart = new Date(new Date().getFullYear(), new Date().getMonth(), 1).getTime();

  try {
    const customer = await db.prepare(
      `SELECT id, name, company_name, credit_limit_kobo FROM customers
       WHERE id = ? AND customer_type = 'corporate' AND deleted_at IS NULL`
    ).bind(customerId).first<{ id: string; name: string; company_name: string | null; credit_limit_kobo: number }>();

    if (!customer) return c.json({ success: false, error: 'Corporate account not found' }, 404);

    // All bookings for this customer with trip summary
    const bookingsRes = await db.prepare(
      `SELECT b.id as booking_id, b.total_amount, b.created_at, b.seat_ids,
              r.origin, r.destination, t.departure_time, b.payment_method
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN routes r ON t.route_id = r.id
       WHERE b.customer_id = ? AND b.deleted_at IS NULL
       ORDER BY b.created_at DESC LIMIT 100`
    ).bind(customerId).all<{
      booking_id: string; total_amount: number; created_at: number; seat_ids: string;
      origin: string; destination: string; departure_time: number; payment_method: string;
    }>();

    // Monthly spend
    const monthlyRes = await db.prepare(
      `SELECT COALESCE(SUM(total_amount), 0) as total_spent_this_month
       FROM bookings WHERE customer_id = ? AND created_at >= ? AND created_at <= ? AND deleted_at IS NULL`
    ).bind(customerId, monthStart, now).first<{ total_spent_this_month: number }>();

    return c.json({
      success: true,
      data: {
        customer_id: customerId,
        company_name: customer.company_name,
        remaining_credit_kobo: customer.credit_limit_kobo,
        total_spent_kobo_this_month: monthlyRes?.total_spent_this_month ?? 0,
        bookings: bookingsRes.results.map(b => ({
          booking_id: b.booking_id,
          origin: b.origin,
          destination: b.destination,
          departure_time: b.departure_time,
          amount_kobo: b.total_amount,
          date: b.created_at,
          payment_method: b.payment_method,
        })),
      },
    });
  } catch {
    return c.json({ success: false, error: 'Failed to fetch corporate statement' }, 500);
  }
});

// ============================================================
// P13-T2: POST /reviews — submit an operator review (CUSTOMER)
// Body: { booking_id, rating (1-5), review_text? }
// Auth: CUSTOMER phone must match booking's customer phone
// Constraint: trip must be completed; one review per booking
// ============================================================
bookingPortalRouter.post('/reviews', requireRole(['CUSTOMER', 'STAFF', 'TENANT_ADMIN', 'SUPER_ADMIN']), requireTierFeature('operator_reviews'), async (c) => {
  const body = await c.req.json() as Record<string, unknown>;
  const err = requireFields(body, ['booking_id', 'rating']);
  if (err) return c.json({ success: false, error: err }, 400);

  const { booking_id, rating, review_text } = body as { booking_id: string; rating: number; review_text?: string };

  const ratingNum = Number(rating);
  if (!Number.isInteger(ratingNum) || ratingNum < 1 || ratingNum > 5) {
    return c.json({ success: false, error: 'Rating must be an integer between 1 and 5' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const user = c.get('user');

  try {
    const booking = await db.prepare(
      `SELECT b.id, b.status, b.customer_id, t.state as trip_state, t.operator_id,
              c.phone as customer_phone
       FROM bookings b
       JOIN trips t ON b.trip_id = t.id
       JOIN customers c ON c.id = b.customer_id
       WHERE b.id = ? AND b.deleted_at IS NULL`
    ).bind(booking_id).first<{
      id: string; status: string; customer_id: string; trip_state: string;
      operator_id: string; customer_phone: string;
    }>();

    if (!booking) return c.json({ success: false, error: 'Booking not found' }, 404);

    // For CUSTOMER role, verify the booking belongs to the authenticated user via phone
    if (user?.role === 'CUSTOMER') {
      const userPhone = (user as unknown as Record<string, unknown>)['phone'] as string | undefined;
      if (!userPhone || booking.customer_phone !== userPhone) {
        return c.json({ success: false, error: 'You are not authorized to review this booking' }, 403);
      }
    }

    if (!['confirmed', 'completed'].includes(booking.status)) {
      return c.json({ success: false, error: 'Only confirmed or completed bookings can be reviewed' }, 422);
    }

    if (booking.trip_state !== 'completed') {
      return c.json({ success: false, error: 'Trip must be completed before you can leave a review' }, 422);
    }

    // One review per booking
    const existing = await db.prepare(
      `SELECT id FROM operator_reviews WHERE booking_id = ? AND deleted_at IS NULL`
    ).bind(booking_id).first<{ id: string }>();

    if (existing) {
      return c.json({ success: false, error: 'You have already reviewed this booking' }, 409);
    }

    const reviewId = genId('rev_');
    await db.prepare(
      `INSERT INTO operator_reviews (id, operator_id, booking_id, customer_id, rating, review_text, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(reviewId, booking.operator_id, booking_id, booking.customer_id, ratingNum, review_text ?? null, now).run();

    return c.json({
      success: true,
      data: {
        id: reviewId,
        operator_id: booking.operator_id,
        booking_id,
        rating: ratingNum,
        review_text: review_text ?? null,
        created_at: now,
      },
    }, 201);
  } catch (err) {
    console.error('[reviews/post] error:', err instanceof Error ? err.message : err);
    return c.json({ success: false, error: 'Failed to submit review' }, 500);
  }
});

// ============================================================
// P13-T2: GET /operators/:id/reviews — list reviews for an operator (public)
// Returns paginated reviews with avg_rating summary
// ============================================================
bookingPortalRouter.get('/operators/:id/reviews', async (c) => {
  const operatorId = c.req.param('id');
  const db = c.env.DB;
  const { limit: lim, offset: off } = parsePagination(c.req.query());

  try {
    const [reviewsRes, summaryRes] = await Promise.all([
      db.prepare(
        `SELECT r.id, r.rating, r.review_text, r.created_at
         FROM operator_reviews r
         WHERE r.operator_id = ? AND r.deleted_at IS NULL
         ORDER BY r.created_at DESC
         LIMIT ? OFFSET ?`
      ).bind(operatorId, lim, off).all<{
        id: string; rating: number; review_text: string | null; created_at: number;
      }>(),
      db.prepare(
        `SELECT COUNT(id) as total_reviews, ROUND(AVG(CAST(rating AS REAL)), 1) as avg_rating
         FROM operator_reviews
         WHERE operator_id = ? AND deleted_at IS NULL`
      ).bind(operatorId).first<{ total_reviews: number; avg_rating: number | null }>(),
    ]);

    return c.json({
      success: true,
      data: reviewsRes.results,
      meta: {
        ...metaResponse(summaryRes?.total_reviews ?? 0, lim, off),
        avg_rating: summaryRes?.avg_rating ?? null,
        total_reviews: summaryRes?.total_reviews ?? 0,
      },
    });
  } catch (err) {
    console.error('[reviews/get] error:', err instanceof Error ? err.message : err);
    return c.json({ success: false, error: 'Failed to fetch reviews' }, 500);
  }
});
