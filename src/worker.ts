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
import { idempotencyMiddleware } from './middleware/idempotency.js';
import {
  drainEventBus,
  sweepExpiredReservations,
  sweepAbandonedBookings,
} from './lib/sweepers.js';

export interface Env {
  DB: D1Database;
  SESSIONS_KV: KVNamespace;
  TENANT_CONFIG_KV?: KVNamespace;
  SEAT_CACHE_KV?: KVNamespace;
  IDEMPOTENCY_KV?: KVNamespace;
  JWT_SECRET?: string;
  MIGRATION_SECRET?: string;
  PAYSTACK_SECRET?: string;
  FLUTTERWAVE_SECRET?: string;
  SMS_API_KEY?: string;
  VAPID_PRIVATE_KEY?: string;
}

const app = new Hono<{ Bindings: Env }>();

// ============================================================
// CORS — allowlist only (SEC-001: no wildcard in production)
// ============================================================
const ALLOWED_ORIGINS = [
  'https://webwaka-transport-ui.pages.dev',
  'https://webwaka.ng',
  'https://www.webwaka.ng',
  'http://localhost:5000',
  'http://localhost:5173',
  'http://127.0.0.1:5000',
];

app.use('*', cors({
  origin: (origin) => ALLOWED_ORIGINS.includes(origin) ? origin : undefined,
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'x-tenant-id', 'X-Idempotency-Key'],
  credentials: true,
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
// Idempotency — deduplicates offline sync retries (B-002)
// Reads X-Idempotency-Key; serves cached response on replay.
// Applies only when IDEMPOTENCY_KV is bound.
// ============================================================
app.use('/api/*', idempotencyMiddleware);

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
//   1. Event Bus outbox drain    — processes pending platform_events
//   2. Seat reservation sweeper  — releases expired reservations
//   3. Abandoned booking sweeper — cancels bookings pending > 30 min
//
// Sweepers are extracted to src/lib/sweepers.ts for testability.
// ============================================================
export async function scheduled(event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
  ctx.waitUntil(Promise.all([
    drainEventBus(env),
    sweepExpiredReservations(env),
    sweepAbandonedBookings(env),
  ]));
}

export default app;

// NOTE: drainEventBus, sweepExpiredReservations, sweepAbandonedBookings
// are imported from src/lib/sweepers.ts above.
// Legacy inline implementations removed — do not add them back.
