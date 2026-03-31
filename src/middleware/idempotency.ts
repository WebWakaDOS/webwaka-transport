/**
 * Idempotency Middleware — prevents duplicate mutations from offline sync retries.
 *
 * Flow:
 *   1. Client attaches X-Idempotency-Key: <mutation_uuid> on every mutating request.
 *   2. Middleware checks IDEMPOTENCY_KV for an existing cached response.
 *   3. If found → return the cached response immediately (no handler invoked).
 *   4. If not found → call handler; on 2xx, cache { status, body } for 24h.
 *
 * Cache TTL: 24 hours (86400 seconds) — covers all realistic retry windows.
 * Key format: `idempotency:<key>` — namespaced to avoid collisions.
 *
 * Non-fatal: if IDEMPOTENCY_KV is not bound, requests pass through normally.
 * This allows gradual rollout — key is optional in Env.
 *
 * Invariants: Build Once Use Infinitely, Offline-First, Nigeria-First
 */
import type { MiddlewareHandler } from 'hono';
import type { Env } from '../api/types';

const IDEMPOTENCY_HEADER = 'X-Idempotency-Key';
const KV_PREFIX = 'idempotency:';
const TTL_SECONDS = 86_400; // 24 hours

interface CachedResponse {
  status: number;
  body: unknown;
  cached_at: number;
}

export const idempotencyMiddleware: MiddlewareHandler<{ Bindings: Env }> = async (c, next) => {
  const kv = c.env.IDEMPOTENCY_KV;
  if (!kv) {
    // Binding not provisioned — pass through without caching
    return next();
  }

  const idempotencyKey = c.req.header(IDEMPOTENCY_HEADER);
  if (!idempotencyKey) {
    // No key provided — not an idempotent call; pass through
    return next();
  }

  const kvKey = `${KV_PREFIX}${idempotencyKey}`;

  // Check cache
  let cached: CachedResponse | null = null;
  try {
    const raw = await kv.get(kvKey);
    if (raw) {
      cached = JSON.parse(raw) as CachedResponse;
    }
  } catch (err) {
    console.warn('[idempotency] KV read error — proceeding without cache:', err);
  }

  if (cached) {
    // Return cached response — idempotent replay
    return c.json(cached.body, cached.status as 200);
  }

  // Call the actual handler
  await next();

  // Cache the response if it was successful (2xx)
  const status = c.res.status;
  if (status >= 200 && status < 300) {
    try {
      const bodyText = await c.res.clone().text();
      const body = JSON.parse(bodyText);
      const entry: CachedResponse = { status, body, cached_at: Date.now() };
      await kv.put(kvKey, JSON.stringify(entry), { expirationTtl: TTL_SECONDS });
    } catch (err) {
      console.warn('[idempotency] KV write error — response not cached:', err);
    }
  }
};
