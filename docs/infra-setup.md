# WebWaka Transport Suite — Infrastructure Setup

## Prerequisites

- Cloudflare account with Workers + D1 + KV enabled
- `wrangler` CLI installed: `npm install -g wrangler`
- Authenticated: `wrangler login`

---

## 1. D1 Database Provisioning

### Create staging database
```bash
wrangler d1 create webwaka-transport-db-staging
```
Copy the `database_id` into `wrangler.toml` under `[env.staging]`.

### Create production database
```bash
wrangler d1 create webwaka-transport-db-prod
```
Copy the `database_id` into `wrangler.toml` under `[env.production]`.

### Apply migrations
```bash
# Staging
wrangler d1 migrations apply webwaka-transport-db-staging --env staging

# Production
wrangler d1 migrations apply webwaka-transport-db-prod --env production
```
Migrations are in `migrations/` and tracked by `schema_migrations` table.

---

## 2. KV Namespace Provisioning

Run the provisioning script:
```bash
chmod +x scripts/provision-kv.sh
./scripts/provision-kv.sh staging
./scripts/provision-kv.sh production
```
Then update the `id` values in `wrangler.toml`.

### KV Namespaces (per environment)

| Binding | Purpose | TTL |
|---------|---------|-----|
| `SESSIONS_KV` | JWT session tokens (revocation list) | 24h per entry |
| `TENANT_CONFIG_KV` | Operator configuration cache | 1h TTL |
| `SEAT_CACHE_KV` | Real-time seat availability cache (per trip) | 30s TTL |

---

## 3. Secrets Configuration

Set each secret via wrangler (never store in wrangler.toml or git):

```bash
# JWT signing secret
wrangler secret put JWT_SECRET --env staging
wrangler secret put JWT_SECRET --env production

# Migration runner secret
wrangler secret put MIGRATION_SECRET --env staging
wrangler secret put MIGRATION_SECRET --env production

# Paystack (Nigeria payment)
wrangler secret put PAYSTACK_SECRET --env staging
wrangler secret put PAYSTACK_SECRET --env production

# Flutterwave (Africa-wide fallback)
wrangler secret put FLUTTERWAVE_SECRET --env staging
wrangler secret put FLUTTERWAVE_SECRET --env production

# SMS (Termii or Africa's Talking)
wrangler secret put SMS_API_KEY --env staging
wrangler secret put SMS_API_KEY --env production

# Web Push VAPID
wrangler secret put VAPID_PRIVATE_KEY --env staging
wrangler secret put VAPID_PRIVATE_KEY --env production
```

For local development, copy `.dev.vars.example` to `.dev.vars` and fill in values.

---

## 4. Cron Triggers

Cron triggers are configured in `wrangler.toml` (every minute). They activate automatically on deploy. No manual setup required.

Cron runs:
1. `drainEventBus()` — flushes `platform_events` outbox to downstream systems
2. `sweepExpiredReservations()` — releases 30-second seat reservation tokens

---

## 5. First Deploy

```bash
# Build frontend
npm run build:ui

# Deploy to staging (runs migrations automatically)
npm run deploy:staging

# Smoke test staging
curl https://webwaka-transport-api-staging.webwaka.workers.dev/health

# Promote to production
npm run deploy:production
```

---

## 6. Migration Runner (runtime)

After deployment, apply any pending migrations:
```bash
curl -X POST https://your-worker.workers.dev/internal/admin/migrations/run \
  -H "Authorization: Bearer <MIGRATION_SECRET>"
```

Check status:
```bash
curl https://your-worker.workers.dev/internal/admin/migrations/status \
  -H "Authorization: Bearer <MIGRATION_SECRET>"
```
