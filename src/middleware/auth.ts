/**
 * WebWaka Transport Suite — JWT Authentication Middleware
 * Reuses the Super Admin V2 auth pattern for consistency (Build Once Use Infinitely).
 */
import { jwtAuthMiddleware as coreJwtAuthMiddleware, requireRole as coreRequireRole } from '@webwaka/core';

export const jwtAuthMiddleware = coreJwtAuthMiddleware({
  publicRoutes: [
    { method: 'GET', path: '/health' },
    { method: 'GET', path: '/api/booking/routes' },
    { method: 'GET', path: '/api/booking/schedules' },
  ]
});

export const requireRole = coreRequireRole;
