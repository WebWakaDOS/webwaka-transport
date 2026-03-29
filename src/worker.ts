/**
 * WebWaka Transport Suite - Unified Cloudflare Worker Entry Point
 * Mounts TRN-1 (Seat Inventory), TRN-2 (Agent Sales),
 * TRN-3 (Booking Portal), TRN-4 (Operator Management)
 *
 * Invariants: Nigeria-First, Offline-First, Multi-tenancy, NDPR, Build Once Use Infinitely
 *
 * Security (hardened 2026-03-29):
 *   - Environment-aware CORS (no wildcard in staging/production)
 *   - JWT_SECRET-based signed JWT verification (replaces KV session lookup)
 *   - JWT_SECRET and RATE_LIMIT_KV bindings required
 */
import { Hono } from 'hono';
import { seatInventoryRouter } from './api/seat-inventory.js';
import { agentSalesRouter } from './api/agent-sales.js';
import { bookingPortalRouter } from './api/booking-portal.js';
import { operatorManagementRouter } from './api/operator-management.js';
import { jwtAuthMiddleware } from './middleware/auth.js';

export interface Env {
  DB: D1Database;
  SESSIONS_KV: KVNamespace;
  RATE_LIMIT_KV: KVNamespace;
  TENANT_CONFIG?: KVNamespace;
  JWT_SECRET: string;
  ENVIRONMENT: string;
}

const app = new Hono<{ Bindings: Env }>();

// ============================================================================
// SECURITY: Environment-aware CORS — never wildcard in staging/production
// ============================================================================
const ALLOWED_ORIGINS: Record<string, string[]> = {
  production: [
    'https://transport.webwaka.app',
    'https://booking.webwaka.app',
    'https://admin.webwaka.app',
  ],
  staging: [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://transport-staging.webwaka.app',
  ],
};

app.use('*', async (c, next) => {
  const env = c.env.ENVIRONMENT || 'development';
  const origin = c.req.header('Origin') || '';
  const allowed = ALLOWED_ORIGINS[env];
  const isAllowed = !allowed || allowed.includes(origin);

  if (c.req.method === 'OPTIONS') {
    const headers: Record<string, string> = {
      'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Max-Age': '86400',
    };
    if (isAllowed && origin) headers['Access-Control-Allow-Origin'] = origin;
    else if (!allowed) headers['Access-Control-Allow-Origin'] = '*'; // dev only
    return new Response(null, { status: 204, headers });
  }
  await next();
  if (origin) {
    if (isAllowed) {
      c.res.headers.set('Access-Control-Allow-Origin', origin);
      c.res.headers.set('Vary', 'Origin');
    } else if (!allowed) {
      c.res.headers.set('Access-Control-Allow-Origin', '*');
    }
  }
});

// Health check (public)
app.get('/health', (c) => {
  return c.json({
    success: true,
    service: 'webwaka-transport-api',
    version: '1.2.0',
    modules: ['TRN-1:seat-inventory', 'TRN-2:agent-sales', 'TRN-3:booking-portal', 'TRN-4:operator-management'],
    invariants: ['Nigeria-First', 'Offline-First', 'Multi-tenancy', 'NDPR', 'Build-Once-Use-Infinitely'],
    security: 'signed-JWT-auth-enabled',
    timestamp: new Date().toISOString(),
  });
});

// JWT auth middleware — protects all /api/* routes
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
