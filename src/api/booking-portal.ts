/**
 * TRN-3: Customer Booking Portal API
 * Invariants: NDPR consent, Nigeria-First (Paystack), Offline-First, Event-Driven
 * Security: JWT auth via global middleware in worker.ts; per-route RBAC via requireRole
 * Events: booking.created published to platform Event Bus (D1 outbox) on booking confirmation
 */
import { Hono } from 'hono';
import { requireRole } from '@webwaka/core';
import type { AppContext, DbBooking, DbCustomer } from './types';
import { genId, parsePagination, metaResponse, requireFields } from './types';
import { publishEvent } from '../core/events/index';

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
  const { origin, destination, date } = c.req.query();
  const db = c.env.DB;

  let query = `SELECT t.id, t.departure_time, t.state, r.origin, r.destination, r.base_fare,
    o.name as operator_name,
    COUNT(CASE WHEN s.status = 'available' THEN 1 END) as available_seats
    FROM trips t
    JOIN routes r ON t.route_id = r.id
    JOIN operators o ON t.operator_id = o.id
    LEFT JOIN seats s ON t.id = s.trip_id
    WHERE t.deleted_at IS NULL AND t.state IN ('scheduled', 'boarding')`;
  const params: unknown[] = [];
  if (origin) { query += ` AND r.origin LIKE ?`; params.push(`%${origin}%`); }
  if (destination) { query += ` AND r.destination LIKE ?`; params.push(`%${destination}%`); }
  if (date) {
    const start = new Date(date).setHours(0, 0, 0, 0);
    const end = new Date(date).setHours(23, 59, 59, 999);
    query += ` AND t.departure_time BETWEEN ? AND ?`;
    params.push(start, end);
  }
  query += ` GROUP BY t.id HAVING available_seats > 0 ORDER BY t.departure_time ASC`;

  try {
    const result = await db.prepare(query).bind(...params).all();
    return c.json({ success: true, data: result.results });
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

  const { customer_id, trip_id, seat_ids, passenger_names, payment_method, ndpr_consent } = body as {
    customer_id: string; trip_id: string; seat_ids: string[]; passenger_names: string[];
    payment_method: string; ndpr_consent?: boolean;
  };

  if (!ndpr_consent) return c.json({ success: false, error: 'NDPR consent required to process booking' }, 400);
  if (!Array.isArray(seat_ids) || seat_ids.length === 0) {
    return c.json({ success: false, error: 'At least one seat_id required' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  try {
    const customer = await db.prepare(
      `SELECT * FROM customers WHERE id = ? AND ndpr_consent = 1`
    ).bind(customer_id).first<DbCustomer>();
    if (!customer) return c.json({ success: false, error: 'Customer not found or NDPR consent not given' }, 404);

    const trip = await db.prepare(
      `SELECT t.*, r.base_fare FROM trips t JOIN routes r ON t.route_id = r.id WHERE t.id = ?`
    ).bind(trip_id).first<{ id: string; base_fare: number; state: string }>();
    if (!trip) return c.json({ success: false, error: 'Trip not found' }, 404);

    const total_amount = trip.base_fare * seat_ids.length;
    const payment_reference = genId('pay');
    const id = genId('bkg');

    await db.prepare(
      `INSERT INTO bookings (id, customer_id, trip_id, seat_ids, passenger_names, total_amount, status, payment_status, payment_method, payment_reference, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pending', 'pending', ?, ?, ?)`
    ).bind(id, customer_id, trip_id, JSON.stringify(seat_ids), JSON.stringify(passenger_names), total_amount, payment_method, payment_reference, now).run();

    return c.json({
      success: true,
      data: { id, customer_id, trip_id, seat_ids, total_amount, payment_method, payment_reference, status: 'pending' },
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
      `SELECT * FROM bookings WHERE id = ?`
    ).bind(id).first<DbBooking>();

    if (!booking) return c.json({ success: false, error: 'Booking not found' }, 404);
    if (booking.status === 'confirmed') return c.json({ success: false, error: 'Already confirmed' }, 409);
    if (booking.status === 'cancelled') return c.json({ success: false, error: 'Booking is cancelled' }, 409);

    await db.prepare(
      `UPDATE bookings SET status = 'confirmed', payment_status = 'completed', confirmed_at = ? WHERE id = ?`
    ).bind(now, id).run();

    const seatIds = JSON.parse(booking.seat_ids) as string[];
    for (const seatId of seatIds) {
      await db.prepare(
        `UPDATE seats SET status = 'confirmed', confirmed_by = ?, confirmed_at = ?, updated_at = ? WHERE id = ?`
      ).bind(id, now, now, seatId).run();
    }

    await publishEvent(db, {
      event_type: 'booking.created',
      aggregate_id: id,
      aggregate_type: 'booking',
      payload: {
        booking_id: id,
        customer_id: booking.customer_id,
        trip_id: booking.trip_id,
        seat_ids: seatIds,
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
// PATCH /bookings/:id/cancel — cancel a booking
// ============================================================
bookingPortalRouter.patch('/bookings/:id/cancel', requireRole(['SUPER_ADMIN', 'TENANT_ADMIN', 'STAFF', 'CUSTOMER']), async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  const now = Date.now();

  try {
    const booking = await db.prepare(
      `SELECT * FROM bookings WHERE id = ?`
    ).bind(id).first<DbBooking>();

    if (!booking) return c.json({ success: false, error: 'Booking not found' }, 404);
    if (booking.status === 'cancelled') return c.json({ success: false, error: 'Already cancelled' }, 409);

    await db.prepare(
      `UPDATE bookings SET status = 'cancelled', cancelled_at = ? WHERE id = ?`
    ).bind(now, id).run();

    const seatIds = JSON.parse(booking.seat_ids) as string[];
    for (const seatId of seatIds) {
      await db.prepare(
        `UPDATE seats SET status = 'available', reserved_by = NULL, reservation_token = NULL, confirmed_by = NULL, updated_at = ? WHERE id = ?`
      ).bind(now, seatId).run();
    }

    return c.json({ success: true, data: { id, status: 'cancelled', cancelled_at: now } });
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
// GET /bookings/:id — booking detail
// ============================================================
bookingPortalRouter.get('/bookings/:id', async (c) => {
  const id = c.req.param('id');
  const db = c.env.DB;
  try {
    const booking = await db.prepare(
      `SELECT b.*, r.origin, r.destination, t.departure_time, o.name as operator_name
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
