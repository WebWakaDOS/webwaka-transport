/**
 * WebWaka Notifications API — TRN-3 Push Subscription Management
 *
 * POST /api/notifications/subscribe   — store a Web Push subscription
 * DELETE /api/notifications/subscribe — remove a Web Push subscription by endpoint
 *
 * The push_subscriptions table stores one subscription per device per customer.
 * On booking:CONFIRMED, booking:CANCELLED — push notifications are sent via
 * src/lib/push.ts from the event bus consumer.
 *
 * Invariants: Multi-tenant (operator_id scoped), NDPR-compliant (PII only in subscription_json)
 */
import { Hono } from 'hono';
import type { AppContext } from './types';
import { genId } from './types';

export const notificationsRouter = new Hono<AppContext>();

// ============================================================
// POST /api/notifications/subscribe
// Body: { endpoint: string, keys: { p256dh: string, auth: string } }
// ============================================================

notificationsRouter.post('/subscribe', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const endpoint = body['endpoint'] as string | undefined;
  const keys = body['keys'] as { p256dh?: string; auth?: string } | undefined;

  if (!endpoint || typeof endpoint !== 'string') {
    return c.json({ success: false, error: 'endpoint is required' }, 400);
  }
  if (!keys?.p256dh || !keys?.auth) {
    return c.json({ success: false, error: 'keys.p256dh and keys.auth are required' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();
  const id = genId('psub');

  const subscriptionJson = JSON.stringify({ endpoint, keys });
  const customerId = user.role === 'CUSTOMER' ? user.id : null;
  const operatorId = user.operatorId ?? null;

  try {
    // Upsert by endpoint — each device gets one subscription record
    const existing = await db.prepare(
      `SELECT id FROM push_subscriptions WHERE endpoint = ? AND deleted_at IS NULL`
    ).bind(endpoint).first<{ id: string }>();

    if (existing) {
      await db.prepare(
        `UPDATE push_subscriptions SET subscription_json = ?, updated_at = ? WHERE id = ?`
      ).bind(subscriptionJson, now, existing.id).run();

      return c.json({ success: true, data: { id: existing.id, action: 'updated' } });
    }

    await db.prepare(
      `INSERT INTO push_subscriptions (id, customer_id, operator_id, endpoint, subscription_json, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(id, customerId, operatorId, endpoint, subscriptionJson, now, now).run();

    return c.json({ success: true, data: { id, action: 'created' } }, 201);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[notifications/subscribe] DB error:', msg);
    return c.json({ success: false, error: 'Failed to store subscription' }, 500);
  }
});

// ============================================================
// DELETE /api/notifications/subscribe
// Body: { endpoint: string }
// ============================================================

notificationsRouter.delete('/subscribe', async (c) => {
  const user = c.get('user');
  if (!user) return c.json({ success: false, error: 'Unauthorized' }, 401);

  let body: Record<string, unknown>;
  try {
    body = await c.req.json<Record<string, unknown>>();
  } catch {
    return c.json({ success: false, error: 'Invalid JSON body' }, 400);
  }

  const endpoint = body['endpoint'] as string | undefined;
  if (!endpoint || typeof endpoint !== 'string') {
    return c.json({ success: false, error: 'endpoint is required' }, 400);
  }

  const db = c.env.DB;
  const now = Date.now();

  try {
    await db.prepare(
      `UPDATE push_subscriptions SET deleted_at = ? WHERE endpoint = ? AND deleted_at IS NULL`
    ).bind(now, endpoint).run();

    return c.json({ success: true });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : 'Unknown error';
    console.error('[notifications/unsubscribe] DB error:', msg);
    return c.json({ success: false, error: 'Failed to remove subscription' }, 500);
  }
});
