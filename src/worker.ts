/**
 * WebWaka Transport Suite - Unified Cloudflare Worker Entry Point
 * Mounts TRN-1 (Seat Inventory), TRN-2 (Agent Sales),
 * TRN-3 (Booking Portal), TRN-4 (Operator Management)
 *
 * Invariants: Nigeria-First, Offline-First, Multi-tenancy, NDPR, Build Once Use Infinitely
 *
 * Security: All /api/* routes require JWT Bearer token (stored in SESSIONS_KV).
 * Public exceptions: GET /health, GET /api/booking/routes,
 *                    GET /api/booking/trips/search, GET /api/seat-inventory/trips
 */
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import { seatInventoryRouter } from './api/seat-inventory.js';
import { agentSalesRouter } from './api/agent-sales.js';
import { bookingPortalRouter } from './api/booking-portal.js';
import { operatorManagementRouter } from './api/operator-management.js';
import { jwtAuthMiddleware } from './middleware/auth.js';
export interface Env {
  DB: D1Database;
  SESSIONS_KV: KVNamespace;
  TENANT_CONFIG?: KVNamespace;
}

const app = new Hono<{ Bindings: Env }>();

// CORS middleware
app.use('*', cors({
  origin: '*',
  allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
  allowHeaders: ['Content-Type', 'Authorization', 'X-Tenant-ID', 'x-tenant-id'],
}));

// Health check
app.get('/health', (c) => {
  return c.json({
    success: true,
    service: 'webwaka-transport-api',
    version: '1.1.0',
    modules: ['TRN-1:seat-inventory', 'TRN-2:agent-sales', 'TRN-3:booking-portal', 'TRN-4:operator-management'],
    invariants: ['Nigeria-First', 'Offline-First', 'Multi-tenancy', 'NDPR', 'Build-Once-Use-Infinitely'],
    timestamp: new Date().toISOString(),
    security: 'JWT-auth-enabled',
  });
});
// JWT auth middleware — protects all /api/* routes
// Public sub-routes are whitelisted inside the middleware
app.use('/api/*', jwtAuthMiddleware);
// Mount module routers
app.route('/api/seat-inventory', seatInventoryRouter);
app.route('/api/agent-sales', agentSalesRouter);
app.route('/api/booking', bookingPortalRouter);
app.route('/api/operator', operatorManagementRouter);

// 404 handler
app.notFound((c) => {
  return c.json({
    success: false,
    error: 'Not found',
    path: c.req.path,
    availableRoutes: ['/health', '/api/seat-inventory', '/api/agent-sales', '/api/booking', '/api/operator'],
  }, 404);
});

// Error handler
app.onError((err, c) => {
  console.error('Worker error:', err);
  return c.json({ success: false, error: 'Internal server error' }, 500);
});

export default app;
