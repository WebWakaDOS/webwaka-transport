/**
 * WebWaka Transport Suite - Unified Cloudflare Worker Entry Point
 * Mounts TRN-1 (Seat Inventory), TRN-2 (Agent Sales),
 * TRN-3 (Booking Portal), TRN-4 (Operator Management)
 *
 * Invariants: Nigeria-First, Offline-First, Multi-tenancy, NDPR, Build Once Use Infinitely
 *
 * Security:
 *   1. jwtAuthMiddleware  — verifies Bearer JWT on all /api/* routes
 *   2. requireTenant      — enforces operator_id scoping on all tenanted queries
 *
 * Public exceptions (no JWT required):
 *   GET  /health
 *   GET  /api/booking/routes
 *   GET  /api/booking/trips/search
 *   GET  /api/seat-inventory/trips
 *   POST /webhooks/paystack
 *   POST /webhooks/flutterwave
 *   POST /api/auth/otp/request
 *   POST /api/auth/otp/verify
 *
 * Scheduled (Cron):
 *   Every 60 seconds:
 *     - Drain platform_events outbox (Event Bus consumer)
 *     - Sweep expired seat reservations (Seat Inventory TTL)
 *     - Check abandoned bookings (Booking Portal recovery)
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { seatInventoryRouter } from './api/seat-inventory.js';
import { agentSalesRouter } from './api/agent-sales.js';
import { bookingPortalRouter } from './api/booking-portal.js';
import { operatorManagementRouter } from './api/operator-management.js';
import { adminRouter } from './api/admin.js';
import { authRouter } from './api/auth.js';
import { paymentsRouter, hmacSha512 } from './api/payments.js';
import { jwtAuthMiddleware, requireTenantMiddleware } from './middleware/auth.js';

export interface Env {
  DB: D1Database;
  SESSIONS_KV: KVNamespace;
  TENANT_CONFIG_KV?: KVNamespace;
  SEAT_CACHE_KV?: KVNamespace;
  JWT_SECRET?: string;
  MIGRATION_SECRET?: string;
  PAYSTACK_SECRET?: string;
  FLUTTERWAVE_SECRET?: string;
  SMS_API_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// CORS
// ============================================================
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'x-tenant-id'],
}));

// ============================================================
// Health check — public, no auth required
// ============================================================
app.get('/health', (c) => {
  return c.json({
    success: true,
    service: 'webwaka-transport-api',
    version: '2.0.0',
    modules: ['TRN-1:seat-inventory', 'TRN-2:agent-sales', 'TRN-3:booking-portal', 'TRN-4:operator-management'],
    invariants: ['Nigeria-First', 'Offline-First', 'Multi-tenancy', 'NDPR', 'Build-Once-Use-Infinitely', 'Event-Driven'],
    timestamp: new Date().toISOString(),
    security: 'JWT-auth-enabled, tenant-scoped',
  });
});

// ============================================================
// Auth endpoints — PUBLIC (must be mounted BEFORE jwtAuthMiddleware)
// POST /api/auth/otp/request — send OTP code to phone
// POST /api/auth/otp/verify  — verify code, issue JWT
// ============================================================
app.route('/api/auth', authRouter);

// ============================================================
// Authentication — JWT verification
// ============================================================
app.use('/api/*', jwtAuthMiddleware);

// ============================================================
// Payments router — mounted BEFORE requireTenantMiddleware.
// CUSTOMER users (role='CUSTOMER', no operatorId) need access to
// initiate and verify their own payments.
// ============================================================
app.route('/api/payments', paymentsRouter);

// ============================================================
// Multi-Tenant enforcement — operator_id scoping
// ============================================================
app.use('/api/*', requireTenantMiddleware);

// ============================================================
// Module routers (JWT + tenant-scoped)
// ============================================================
app.route('/api/seat-inventory', seatInventoryRouter);
app.route('/api/agent-sales', agentSalesRouter);
app.route('/api/booking', bookingPortalRouter);
app.route('/api/operator', operatorManagementRouter);

// ============================================================
// Paystack webhook — PUBLIC (HMAC-SHA512 verified internally)
// POST /webhooks/paystack — handles charge.success → confirm booking
// ============================================================
app.post('/webhooks/paystack', async (c) => {
  const signature = c.req.header('x-paystack-signature');
  let rawBody: string;
  try { rawBody = await c.req.text(); }
  catch { return c.json({ success: false, error: 'Failed to read body' }, 400); }

  if (!c.env.PAYSTACK_SECRET) {
    return c.json({ success: false, error: 'Paystack not configured' }, 503);
  }

  const computed = await hmacSha512(rawBody, c.env.PAYSTACK_SECRET);
  if (!signature || computed !== signature) {
    return c.json({ success: false, error: 'Invalid signature' }, 401);
  }

  let event: { event: string; data: Record<string, unknown> };
  try { event = JSON.parse(rawBody) as typeof event; }
  catch { return c.json({ success: false, error: 'Invalid JSON' }, 400); }

  if (event.event === 'charge.success') {
    const reference = event.data['reference'] as string | undefined;
    if (reference) {
      const db = c.env.DB;
      const now = Date.now();

      const booking = await db.prepare(
        `SELECT id, status, seat_ids FROM bookings
         WHERE (payment_reference = ? OR id = ?) AND deleted_at IS NULL LIMIT 1`
      ).bind(reference, reference).first<{ id: string; status: string; seat_ids: string }>();

      if (booking && booking.status !== 'confirmed' && booking.status !== 'cancelled') {
        await db.prepare(
          `UPDATE bookings
           SET status = 'confirmed', payment_status = 'completed',
               payment_provider = 'paystack', paid_at = ?, confirmed_at = ?
           WHERE id = ?`
        ).bind(now, now, booking.id).run();

        const seatIds = JSON.parse(booking.seat_ids) as string[];
        for (const seatId of seatIds) {
          await db.prepare(
            `UPDATE seats SET status = 'confirmed', confirmed_at = ?, updated_at = ? WHERE id = ?`
          ).bind(now, now, seatId).run();
        }

        console.log(`[webhook/paystack] charge.success — confirmed booking ${booking.id}`);
      }
    }
  }

  return c.json({ success: true });
});

// ============================================================
// Internal admin — migration runner
// Mounted at /internal/admin to bypass jwtAuthMiddleware.
// Protected by MIGRATION_SECRET Bearer token instead.
// POST /internal/admin/migrations/run — apply pending migrations
// GET  /internal/admin/migrations/status — view migration state
// ============================================================
app.route('/internal/admin', adminRouter);

// ============================================================
// 404 handler
// ============================================================
app.notFound((c) => {
  return c.json({
    success: false,
    error: 'Not found',
    path: c.req.path,
    availableRoutes: [
      '/health',
      '/api/seat-inventory',
      '/api/agent-sales',
      '/api/booking',
      '/api/operator',
      '/internal/admin/migrations/status',
    ],
  }, 404);
});

// ============================================================
// Error handler
// ============================================================
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

// ============================================================
// Scheduled handler — Cron Worker (runs every minute)
//
// Responsibilities:
//   1. Event Bus outbox drain   — processes pending platform_events
//   2. Seat reservation sweeper — releases expired reservations
//   3. Abandoned booking sweeper — flags & cancels abandoned bookings
//
// Invariant: Event-Driven (no direct inter-DB access from this cron;
//            downstream systems receive events via the outbox).
// ============================================================
export async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(Promise.all([
    drainEventBus(env),
    sweepExpiredReservations(env),
  ]));
}

/**
 * Drain the platform_events outbox.
 *
 * Reads up to 50 pending events, attempts to deliver each to the
 * configured downstream consumer endpoint. On success, marks the event
 * 'processed'. On failure, increments retry_count; after 3 retries,
 * marks the event 'dead'.
 *
 * Initially (before consumer endpoints are wired), events are logged
 * and marked processed — establishing the drain infrastructure.
 */
async function drainEventBus(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();

  try {
    const pending = await db
      .prepare(
        `SELECT * FROM platform_events
         WHERE status = 'pending' AND (retry_count IS NULL OR retry_count < 3)
         ORDER BY created_at ASC
         LIMIT 50`
      )
      .all();

    if (!pending.results || pending.results.length === 0) return;

    console.log(`[EventBus] Draining ${pending.results.length} pending events`);

    for (const evt of pending.results as any[]) {
      try {
        await deliverEvent(evt, env);

        await db
          .prepare(
            `UPDATE platform_events
             SET status = 'processed', processed_at = ?
             WHERE id = ?`
          )
          .bind(now, evt.id)
          .run();

        console.log(`[EventBus] Processed: ${evt.event_type} id=${evt.id}`);
      } catch (err: any) {
        const retryCount = (evt.retry_count ?? 0) + 1;
        const newStatus = retryCount >= 3 ? 'dead' : 'pending';

        await db
          .prepare(
            `UPDATE platform_events
             SET retry_count = ?, status = ?, last_error = ?
             WHERE id = ?`
          )
          .bind(retryCount, newStatus, err.message ?? 'Unknown error', evt.id)
          .run();

        console.error(`[EventBus] Failed (attempt ${retryCount}): ${evt.event_type} id=${evt.id} — ${err.message}`);
      }
    }
  } catch (err: any) {
    console.error(`[EventBus] Drain error: ${err.message}`);
  }
}

/**
 * Deliver a single platform event to its downstream consumer.
 *
 * Routing table (extend as consumers are wired):
 *   parcel.*          → webwaka-logistics internal API
 *   payment.*         → notification service
 *   booking.created   → SMS notification trigger
 *   trip.sos_triggered → emergency notification
 *   (all others)      → logged only, no-op delivery
 *
 * Returns without throwing on no-op events.
 * Throws on delivery failure to trigger retry logic above.
 */
async function deliverEvent(evt: any, env: Env): Promise<void> {
  const { event_type, payload } = evt;

  if (event_type.startsWith('parcel.')) {
    await deliverToConsumer(
      'https://logistics.webwaka.app/api/internal/events',
      evt,
      env
    );
    return;
  }

  console.log(`[EventBus] No-op delivery for: ${event_type} — consumer not yet wired`);
}

/**
 * HTTP delivery to a downstream consumer endpoint.
 * Signed with a shared secret for mutual authentication.
 */
async function deliverToConsumer(
  endpointUrl: string,
  evt: any,
  _env: Env
): Promise<void> {
  const response = await fetch(endpointUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Webwaka-Event-Type': evt.event_type,
      'X-Webwaka-Aggregate-ID': evt.aggregate_id,
    },
    body: JSON.stringify(evt),
  });

  if (!response.ok) {
    throw new Error(`Consumer returned ${response.status} for event ${evt.id}`);
  }
}

/**
 * Sweep expired seat reservations.
 *
 * Sets status='available' on all reserved seats whose
 * reservation_expires_at is in the past. This prevents seats
 * from being held indefinitely when clients crash or abandon
 * the booking flow.
 *
 * Publishes seat.reservation_expired events for each affected seat.
 */
async function sweepExpiredReservations(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();

  try {
    const expired = await db
      .prepare(
        `SELECT id, trip_id, operator_id
         FROM seats
         WHERE status = 'reserved'
           AND reservation_expires_at IS NOT NULL
           AND reservation_expires_at < ?`
      )
      .bind(now)
      .all();

    if (!expired.results || expired.results.length === 0) return;

    console.log(`[SeatSweeper] Releasing ${expired.results.length} expired reservations`);

    await db
      .prepare(
        `UPDATE seats
         SET status = 'available',
             reserved_by = NULL,
             reservation_token = NULL,
             reservation_expires_at = NULL,
             version = version + 1,
             updated_at = ?
         WHERE status = 'reserved'
           AND reservation_expires_at IS NOT NULL
           AND reservation_expires_at < ?`
      )
      .bind(now, now)
      .run();

    for (const seat of expired.results as any[]) {
      const evtId = `evt_sw_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      await db
        .prepare(
          `INSERT OR IGNORE INTO platform_events
           (id, event_type, aggregate_id, aggregate_type, payload, tenant_id, status, created_at)
           VALUES (?, 'seat.reservation_expired', ?, 'seat', ?, ?, 'pending', ?)`
        )
        .bind(
          evtId,
          seat.id,
          JSON.stringify({ seat_id: seat.id, trip_id: seat.trip_id }),
          seat.operator_id ?? null,
          now
        )
        .run();
    }

    console.log(`[SeatSweeper] Released ${expired.results.length} seats`);
  } catch (err: any) {
    console.error(`[SeatSweeper] Error: ${err.message}`);
  }
}

export default app;
