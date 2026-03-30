/**
 * WebWaka Transport Suite — JWT Authentication + Multi-Tenant Middleware
 * Reuses @webwaka/core auth pattern (Build Once Use Infinitely).
 *
 * Public routes (no JWT required):
 *   GET  /health                       — service liveness probe
 *   GET  /api/booking/routes           — customer route list
 *   GET  /api/booking/schedules        — customer schedule lookup
 *   GET  /api/booking/trips/search     — customer trip search
 *   GET  /api/seat-inventory/trips     — seat availability (public cache)
 *   POST /webhooks/paystack            — Paystack webhook (HMAC verified internally)
 *   POST /webhooks/flutterwave         — Flutterwave webhook (HMAC verified internally)
 *   POST /api/auth/otp/request         — OTP request (pre-auth)
 *   POST /api/auth/otp/verify          — OTP verify (pre-auth)
 *
 * All other /api/* routes require valid Bearer JWT + tenant enforcement.
 */
import { jwtAuthMiddleware as coreJwtAuthMiddleware, requireRole as coreRequireRole, requireTenant } from '@webwaka/core';

export const jwtAuthMiddleware = coreJwtAuthMiddleware({
  publicRoutes: [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/api/booking/routes' },
    { method: 'GET', path: '/api/booking/schedules' },
    { method: 'GET', path: '/api/booking/trips/search' },
    { method: 'GET', path: '/api/seat-inventory/trips' },
    { method: 'POST', path: '/webhooks/paystack' },
    { method: 'POST', path: '/webhooks/flutterwave' },
    { method: 'POST', path: '/api/auth/otp/request' },
    { method: 'POST', path: '/api/auth/otp/verify' },
  ],
});

export const requireTenantMiddleware = requireTenant();

export const requireRole = coreRequireRole;
