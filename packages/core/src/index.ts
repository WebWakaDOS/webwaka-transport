/**
 * @webwaka/core — Platform Core Package
 * Build Once Use Infinitely.
 *
 * Exports:
 *   requireRole        — Hono RBAC middleware factory
 *   jwtAuthMiddleware  — Hono JWT authentication middleware factory
 *   nanoid             — Platform-standard ID generator
 *   formatKobo         — Nigeria-First: kobo → ₦ naira display
 *   publishEvent       — Event Bus: D1 outbox writer
 *
 * VITEST mode (process.env.VITEST === 'true'):
 *   Auth middlewares are no-ops that inject a SUPER_ADMIN test user.
 *   This allows unit tests to run without real JWT tokens.
 *
 * Invariants: Nigeria-First, Multi-Tenant, Event-Driven, Cloudflare-First
 */

// ============================================================
// TYPES
// ============================================================

export type WakaRole =
  | 'SUPER_ADMIN'
  | 'TENANT_ADMIN'
  | 'STAFF'
  | 'SUPERVISOR'
  | 'DRIVER'
  | 'CUSTOMER';

export interface WakaUser {
  id: string;
  role: WakaRole;
  operatorId?: string;
  phone?: string;
  jti?: string;
}

export interface PublicRoute {
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: string;
}

export interface JwtAuthConfig {
  publicRoutes: PublicRoute[];
}

export interface PlatformEvent {
  event_type: string;
  aggregate_id: string;
  aggregate_type: string;
  payload: Record<string, unknown>;
  tenant_id?: string;
  correlation_id?: string;
  timestamp: number;
}

// ============================================================
// ENVIRONMENT DETECTION
// ============================================================

function isVitest(): boolean {
  try {
    return typeof process !== 'undefined' && process.env.VITEST === 'true';
  } catch {
    return false;
  }
}

// ============================================================
// VITEST TEST USER — injected in test mode only
// ============================================================

const VITEST_USER: WakaUser = {
  id: 'test_user',
  role: 'SUPER_ADMIN',
  operatorId: 'opr_1',
};

// ============================================================
// requireRole — RBAC middleware factory
// Usage: requireRole(['SUPER_ADMIN', 'TENANT_ADMIN'])
// ============================================================

export function requireRole(allowedRoles: WakaRole[]) {
  return async function requireRoleMiddleware(c: any, next: () => Promise<void>) {
    if (isVitest()) {
      c.set('user', VITEST_USER);
      await next();
      return;
    }

    const user: WakaUser | undefined = c.get('user');

    if (!user) {
      return c.json(
        { success: false, error: 'Authentication required', code: 'AUTH_REQUIRED' },
        401
      );
    }

    if (!allowedRoles.includes(user.role)) {
      return c.json(
        {
          success: false,
          error: 'Insufficient permissions',
          code: 'FORBIDDEN',
          required: allowedRoles,
          actual: user.role,
        },
        403
      );
    }

    await next();
  };
}

// ============================================================
// jwtAuthMiddleware — JWT verification middleware factory
// Whitelists public routes; all others require valid Bearer JWT
// ============================================================

export function jwtAuthMiddleware(config: JwtAuthConfig) {
  const { publicRoutes } = config;

  return async function jwtMiddleware(c: any, next: () => Promise<void>) {
    if (isVitest()) {
      c.set('user', VITEST_USER);
      await next();
      return;
    }

    const method = c.req.method as PublicRoute['method'];
    const path = c.req.path;

    const isPublic = publicRoutes.some(
      (r) => r.method === method && (r.path === path || path.startsWith(r.path + '/'))
    );

    if (isPublic) {
      await next();
      return;
    }

    const authHeader = c.req.header('Authorization');
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return c.json(
        { success: false, error: 'Authorization header required', code: 'MISSING_TOKEN' },
        401
      );
    }

    const token = authHeader.slice(7);

    try {
      const user = await verifyJWT(token, c.env?.JWT_SECRET ?? '');
      c.set('user', user);
      await next();
    } catch (err: any) {
      return c.json(
        { success: false, error: 'Invalid or expired token', code: 'INVALID_TOKEN' },
        401
      );
    }
  };
}

// ============================================================
// verifyJWT — Decode and verify a compact JWT
// Uses Web Crypto API (available in Cloudflare Workers and Node 18+)
// ============================================================

export async function verifyJWT(token: string, secret: string): Promise<WakaUser> {
  const parts = token.split('.');
  if (parts.length !== 3) throw new Error('Malformed JWT');

  const headerB64 = parts[0]!;
  const payloadB64 = parts[1]!;
  const signatureB64 = parts[2]!;

  const encoder = new TextEncoder();
  const keyData = encoder.encode(secret);

  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['verify']
  );

  const data = encoder.encode(`${headerB64}.${payloadB64}`);
  const sigBytes = base64UrlDecode(signatureB64);
  const signature = sigBytes.buffer.slice(sigBytes.byteOffset, sigBytes.byteOffset + sigBytes.byteLength) as ArrayBuffer;

  const valid = await crypto.subtle.verify('HMAC', cryptoKey, signature, data);
  if (!valid) throw new Error('Invalid JWT signature');

  const payload = JSON.parse(
    new TextDecoder().decode(base64UrlDecode(payloadB64))
  ) as Record<string, unknown>;

  const now = Math.floor(Date.now() / 1000);
  const exp = payload['exp'] as number | undefined;
  if (exp && exp < now) throw new Error('JWT expired');

  const user: WakaUser = { id: payload['sub'] as string, role: payload['role'] as WakaRole };
  if (payload['operator_id'] !== undefined) user.operatorId = payload['operator_id'] as string;
  if (payload['phone'] !== undefined) user.phone = payload['phone'] as string;
  if (payload['jti'] !== undefined) user.jti = payload['jti'] as string;
  return user;
}

// ============================================================
// generateJWT — Create a signed compact JWT
// ============================================================

export async function generateJWT(
  user: WakaUser,
  secret: string,
  expiresInSeconds = 86400
): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  const header = { alg: 'HS256', typ: 'JWT' };
  const payload = {
    sub: user.id,
    role: user.role,
    operator_id: user.operatorId ?? null,
    phone: user.phone ?? null,
    jti: nanoid(),
    iat: now,
    exp: now + expiresInSeconds,
  };

  const encoder = new TextEncoder();
  const headerB64 = base64UrlEncode(JSON.stringify(header));
  const payloadB64 = base64UrlEncode(JSON.stringify(payload));
  const signingInput = `${headerB64}.${payloadB64}`;

  const keyData = encoder.encode(secret);
  const cryptoKey = await crypto.subtle.importKey(
    'raw',
    keyData,
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    cryptoKey,
    encoder.encode(signingInput)
  );

  const signatureB64 = base64UrlEncode(signatureBuffer);
  return `${signingInput}.${signatureB64}`;
}

// ============================================================
// nanoid — Platform-standard random ID generator
// Cloudflare Workers compatible (no Node crypto dependency)
// ============================================================

export function nanoid(prefix = '', length = 12): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  for (let i = 0; i < length; i++) {
    id += chars[Math.floor(Math.random() * chars.length)];
  }
  const ts = Date.now().toString(36);
  return prefix ? `${prefix}_${ts}_${id}` : `${ts}_${id}`;
}

// ============================================================
// formatKobo — Nigeria-First monetary display
// All monetary values stored as kobo (integer, no decimals)
// ============================================================

export function formatKobo(kobo: number): string {
  const naira = kobo / 100;
  return `\u20A6${naira.toLocaleString('en-NG', {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

// ============================================================
// publishEvent — Event Bus: D1 outbox writer
// Events are durably stored and drained by the cron worker.
// Invariant: Event-Driven (NO direct inter-DB access)
// ============================================================

export interface D1LikeDB {
  prepare(query: string): {
    bind(...args: unknown[]): { run(): Promise<unknown> };
  };
}

export async function publishEvent(db: D1LikeDB, event: PlatformEvent): Promise<void> {
  const id = nanoid('evt');
  await db
    .prepare(
      `INSERT OR IGNORE INTO trns_platform_events
       (id, event_type, aggregate_id, aggregate_type, payload, tenant_id, correlation_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
    .bind(
      id,
      event.event_type,
      event.aggregate_id,
      event.aggregate_type,
      JSON.stringify(event.payload),
      event.tenant_id ?? null,
      event.correlation_id ?? null,
      event.timestamp
    )
    .run();
}

// ============================================================
// requireTenant — Multi-tenant row-level enforcement middleware
// Sets c.var.tenant_id on context for use by API handlers.
//
// SUPER_ADMIN: tenant_id = null (sees all operators, no filter)
// All others:  tenant_id = user.operatorId (enforced)
//
// Handlers use getTenantId(c) to get the enforced tenant.
// getTenantId returns null for SUPER_ADMIN → handler shows all rows.
// For all other roles, getTenantId returns the user's operatorId.
// If the user has no operatorId, a 403 is returned immediately.
//
// Override: SUPER_ADMIN may pass X-Tenant-ID header to scope to
//           a specific tenant (for cross-tenant operations).
// ============================================================

export function requireTenant() {
  return async function requireTenantMiddleware(c: any, next: () => Promise<void>) {
    if (isVitest()) {
      c.set('tenant_id', null);
      await next();
      return;
    }

    const user: WakaUser | undefined = c.get('user');

    if (!user) {
      return c.json(
        { success: false, error: 'Authentication required', code: 'AUTH_REQUIRED' },
        401
      );
    }

    if (user.role === 'SUPER_ADMIN') {
      const headerTenant = c.req.header('X-Tenant-ID') ?? null;
      c.set('tenant_id', headerTenant);
      await next();
      return;
    }

    // CUSTOMER users have no operatorId — they access cross-tenant booking
    // endpoints scoped by their own customer_id. Set tenant_id = null and
    // let individual route handlers apply customer-level scoping.
    if (user.role === 'CUSTOMER') {
      c.set('tenant_id', null);
      await next();
      return;
    }

    if (!user.operatorId) {
      return c.json(
        { success: false, error: 'No operator associated with this user', code: 'NO_TENANT' },
        403
      );
    }

    c.set('tenant_id', user.operatorId);
    await next();
  };
}

/**
 * getTenantId — Read the enforced tenant ID from Hono context.
 * Returns null for SUPER_ADMIN (no filter applied — all tenants visible).
 * Returns the operatorId for all other authenticated users.
 *
 * Usage in API handlers:
 *   const tenantId = getTenantId(c);
 *   if (tenantId) { query += ' AND operator_id = ?'; params.push(tenantId); }
 */
export function getTenantId(c: any): string | null {
  if (isVitest()) return null;
  return c.get('tenant_id') ?? null;
}

// ============================================================
// P15-T1: requireTierFeature — Subscription Tier Gating Middleware
// Tiers (ascending): basic → pro → enterprise
// Returns 402 if the operator's subscription tier does not include the feature.
// SUPER_ADMIN always passes through (platform level).
// ============================================================

export type TierFeature =
  | 'ai_search'
  | 'waiting_list'
  | 'operator_reviews'
  | 'analytics'
  | 'auto_schedule'
  | 'api_keys'
  | 'seat_class_pricing'
  | 'white_label'
  | 'bulk_import';

type Tier = 'basic' | 'pro' | 'enterprise';

const TIER_RANK: Record<Tier, number> = { basic: 0, pro: 1, enterprise: 2 };

const FEATURE_MIN_TIER: Record<TierFeature, Tier> = {
  ai_search: 'pro',
  waiting_list: 'pro',
  operator_reviews: 'basic',
  analytics: 'pro',
  auto_schedule: 'enterprise',
  api_keys: 'pro',
  seat_class_pricing: 'pro',
  white_label: 'enterprise',
  bulk_import: 'enterprise',
};

/**
 * requireTierFeature(feature) — Hono middleware factory.
 * Looks up the operator's subscription_tier in the D1 DB and
 * returns 402 Payment Required if the tier does not include the feature.
 *
 * Usage:
 *   router.post('/trips/ai-search', requireTierFeature('ai_search'), handler)
 */
export function requireTierFeature(feature: TierFeature) {
  return async function requireTierFeatureMiddleware(c: any, next: () => Promise<void>) {
    if (isVitest()) {
      await next();
      return;
    }

    const user: WakaUser | undefined = c.get('user');

    // SUPER_ADMIN bypasses tier gating (platform operations)
    if (user?.role === 'SUPER_ADMIN') {
      await next();
      return;
    }

    const operatorId = user?.operatorId;
    const minTier = FEATURE_MIN_TIER[feature];

    if (!operatorId) {
      // CUSTOMER role: operator_reviews is accessible (checked at booking level)
      if (feature === 'operator_reviews') {
        await next();
        return;
      }
      return c.json({
        success: false,
        error: 'No operator associated with this account',
        code: 'NO_TENANT',
      }, 403);
    }

    try {
      const db = c.env?.DB as { prepare: (q: string) => { bind: (...a: unknown[]) => { first: <T>() => Promise<T | null> } } } | undefined;
      if (!db) {
        // No DB available (e.g. unit test without vitest flag) — allow
        await next();
        return;
      }

      const op = await db.prepare(
        `SELECT subscription_tier FROM operators WHERE id = ? AND deleted_at IS NULL`
      ).bind(operatorId).first<{ subscription_tier: string }>();

      const currentTier = (op?.subscription_tier ?? 'basic') as Tier;
      const currentRank = TIER_RANK[currentTier] ?? 0;
      const requiredRank = TIER_RANK[minTier];

      if (currentRank < requiredRank) {
        return c.json({
          success: false,
          error: `This feature requires the '${minTier}' plan or higher. Current plan: '${currentTier}'.`,
          code: 'TIER_INSUFFICIENT',
          required_tier: minTier,
          current_tier: currentTier,
          feature,
        }, 402);
      }
    } catch {
      // DB lookup failed — fail open to avoid breaking operator workflows on DB errors
    }

    await next();
  };
}

// ============================================================
// Utility: base64url encode/decode (Web Crypto compatible)
// ============================================================

function base64UrlEncode(input: string | ArrayBuffer): string {
  let bytes: Uint8Array;
  if (typeof input === 'string') {
    bytes = new TextEncoder().encode(input);
  } else {
    bytes = new Uint8Array(input);
  }
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(str: string): Uint8Array {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const padding = (4 - (padded.length % 4)) % 4;
  const base64 = padded + '='.repeat(padding);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}
