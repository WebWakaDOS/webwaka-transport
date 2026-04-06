/**
 * WebWaka Transport Suite — JWT Authentication + Multi-Tenant Middleware
 * Reuses @webwaka/core auth pattern (Build Once Use Infinitely).
 *
 * Public trns_routes (no JWT required):
 *   GET  /health                       — service liveness probe
 *   GET  /api/booking/trns_routes           — customer route list
 *   GET  /api/booking/trns_schedules        — customer schedule lookup
 *   GET  /api/booking/trns_trips/search     — customer trip search
 *   GET  /api/seat-inventory/trns_trips     — seat availability (public cache)
 *   POST /webhooks/paystack            — Paystack webhook (HMAC verified internally)
 *   POST /webhooks/flutterwave         — Flutterwave webhook (HMAC verified internally)
 *   POST /api/auth/otp/request         — OTP request (pre-auth)
 *   POST /api/auth/otp/verify          — OTP verify (pre-auth)
 *
 * All other /api/* trns_routes require valid Bearer JWT OR a valid operator API key.
 * API key format: Authorization: ApiKey waka_live_{rawKey}
 * On valid API key: sets TENANT_ADMIN WakaUser context scoped to operator.
 */
import { jwtAuthMiddleware as coreJwtAuthMiddleware, requireRole as coreRequireRole, requireTenant } from '@webwaka/core';
import type { WakaUser } from '@webwaka/core';

const PUBLIC_ROUTES = [
  { method: 'GET', path: '/health' },
  { method: 'GET', path: '/api/booking/trns_routes' },
  { method: 'GET', path: '/api/booking/trns_schedules' },
  { method: 'GET', path: '/api/booking/trns_trips/search' },
  { method: 'GET', path: '/api/seat-inventory/trns_trips' },
  { method: 'POST', path: '/webhooks/paystack' },
  { method: 'POST', path: '/webhooks/flutterwave' },
  { method: 'POST', path: '/api/auth/otp/request' },
  { method: 'POST', path: '/api/auth/otp/verify' },
] as const;

const _coreJwtMiddleware = coreJwtAuthMiddleware({ publicRoutes: PUBLIC_ROUTES as any });

/**
 * Combined auth middleware.
 * Order of precedence:
 *   1. Public route  → pass-through, no auth required
 *   2. ApiKey header → verify SHA-256 hash against trns_api_keys table, set TENANT_ADMIN context
 *   3. Bearer JWT    → standard JWT verification via @webwaka/core
 */
export const jwtAuthMiddleware = async function combinedAuthMiddleware(c: any, next: () => Promise<void>) {
  const method = c.req.method as string;
  const path = c.req.path as string;

  const isPublic = PUBLIC_ROUTES.some(
    (r) => r.method === method && (r.path === path || path.startsWith(r.path + '/')),
  );
  if (isPublic) {
    await next();
    return;
  }

  const authHeader = c.req.header('Authorization') as string | undefined;

  if (authHeader?.startsWith('ApiKey ')) {
    const rawKey = authHeader.slice(7).trim();

    if (!rawKey.startsWith('waka_live_')) {
      return c.json({ success: false, error: 'Invalid API key format', code: 'INVALID_TOKEN' }, 401);
    }

    const db = c.env?.DB;
    if (!db) {
      return c.json({ success: false, error: 'Server configuration error' }, 500);
    }

    try {
      const encoder = new TextEncoder();
      const hashBuffer = await crypto.subtle.digest('SHA-256', encoder.encode(rawKey));
      const keyHash = Array.from(new Uint8Array(hashBuffer))
        .map((b) => b.toString(16).padStart(2, '0')).join('');

      const apiKey = (await db.prepare(
        `SELECT id, operator_id, scope FROM trns_api_keys
         WHERE key_hash = ? AND revoked_at IS NULL AND deleted_at IS NULL`,
      ).bind(keyHash).first()) as { id: string; operator_id: string; scope: string } | null;

      if (!apiKey) {
        return c.json({ success: false, error: 'Invalid or revoked API key', code: 'INVALID_TOKEN' }, 401);
      }

      try {
        await db.prepare(`UPDATE trns_api_keys SET last_used_at = ? WHERE id = ?`)
          .bind(Date.now(), apiKey.id).run();
      } catch { /* non-fatal — best-effort last_used_at tracking */ }

      const user: WakaUser = {
        id: apiKey.operator_id,
        role: 'TENANT_ADMIN',
        operatorId: apiKey.operator_id,
      };
      c.set('user', user);
      await next();
      return;
    } catch {
      return c.json({ success: false, error: 'API key verification failed', code: 'INVALID_TOKEN' }, 401);
    }
  }

  return _coreJwtMiddleware(c, next);
};

export const requireTenantMiddleware = requireTenant();

export const requireRole = coreRequireRole;
