# WebWaka Transport Suite

## Overview
WebWaka Transport is the Transportation & Mobility vertical suite (Part 10.3) of the WebWaka OS v4 ecosystem. It is a comprehensive, mobile-first, offline-first platform for seat inventory management, agent sales, customer booking, and operator management — targeted at Nigerian and African markets.

## Modules
- **TRN-1**: Seat Inventory Synchronization — atomic validation and sync of seat availability
- **TRN-2**: Agent Sales Application — offline-first POS for bus park agents
- **TRN-3**: Customer Booking Portal — public-facing trip search and booking
- **TRN-4**: Operator Management — tools for transport companies to manage routes/vehicles

## Tech Stack
- **Frontend**: React 19 + TypeScript + Vite (PWA, mobile-first, port 5000)
- **Backend**: Cloudflare Workers + Hono framework
- **Database**: Cloudflare D1 (server), Dexie.js/IndexedDB (client offline storage)
- **Core Package**: `@webwaka/core` at `packages/core/src/index.ts`
- **Package Manager**: npm

## Project Structure
```
packages/
  core/
    src/index.ts     - @webwaka/core: requireRole, jwtAuthMiddleware, requireTenant,
                       nanoid, formatKobo, publishEvent, verifyJWT, generateJWT
src/
  app.tsx            - Main React application shell
  main.tsx           - Entry point, service worker registration
  api/               - Hono API route handlers (Cloudflare Workers)
    admin.ts         - Migration runner (POST /internal/admin/migrations/run)
    seat-inventory.ts- TRN-1 API
    agent-sales.ts   - TRN-2 API
    booking-portal.ts- TRN-3 API
    operator-management.ts - TRN-4 API
  core/              - Business logic (domain) modules
    booking/         - Booking domain logic
    events/          - Platform Event Bus outbox publisher
    i18n/            - Africa-First i18n (en, yo, ig, ha)
    offline/         - Dexie.js DB schema + sync logic
    sales/           - Agent sales POS logic
    seat-inventory/  - Seat inventory domain
    trip-state/      - Trip state machine
  middleware/
    auth.ts          - JWT auth + multi-tenant middleware wiring
  worker.ts          - Cloudflare Worker entry point (scheduled cron handler)
migrations/          - SQL migrations for Cloudflare D1 (001-004)
docs/
  rbac.md            - RBAC permission matrix for all 6 roles
.dev.vars.example    - All required secrets (copy → .dev.vars, never commit)
```

## Local Development
The frontend runs as a Vite dev server on port 5000. The backend (Cloudflare Worker) is not run locally — the app connects to the production API by default.

```bash
npm run dev:ui   # start Vite frontend
npm test         # run all 140 unit tests (vitest)
npm run typecheck # TypeScript strict mode check (0 errors required)
```

## Platform Invariants
- **Nigeria-First**: Naira/kobo integers, NDPR compliance, Nigerian timezones
- **Offline-First**: IndexedDB (Dexie) + service worker sync queue
- **Multi-Tenant**: Every DB query filtered by `operator_id` via `requireTenant()` middleware
- **Event-Driven**: All domain events published to D1 outbox (`platform_events`), drained by cron
- **Build Once Use Infinitely**: `@webwaka/core` shared across all modules
- **Cloudflare-First**: D1, KV, Workers Cron, no Vercel/AWS dependencies
- **Zero Skipping**: No `|| true` in CI, strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)

## Dependencies
- `@webwaka/core` — in-repo package at `packages/core/src/index.ts`. Provides RBAC (`requireRole`), JWT (`verifyJWT`, `generateJWT`, `jwtAuthMiddleware`), tenant enforcement (`requireTenant`, `getTenantId`), event bus (`publishEvent`), formatting (`formatKobo`, `nanoid`).
- `dexie` — IndexedDB wrapper for offline-first storage
- `hono` — Web framework for Cloudflare Workers
- `react` + `react-dom` — React 19 UI framework
- `vitest` — Test runner (140 unit tests across 5 test files)

## Roles (RBAC)
Six roles defined in `WakaRole` type: `SUPER_ADMIN`, `TENANT_ADMIN`, `SUPERVISOR`, `STAFF`, `DRIVER`, `CUSTOMER`.
Full permission matrix in `docs/rbac.md`.

## Secrets
All required secrets documented in `.dev.vars.example`. Required secrets:
- `JWT_SECRET` — HS256 JWT signing key (min 32 chars)
- `MIGRATION_SECRET` — protects `POST /internal/admin/migrations/run`
- `PAYSTACK_SECRET` — Nigeria payment provider
- `FLUTTERWAVE_SECRET` — Africa-wide payment fallback
- `SMS_API_KEY` — OTP SMS via Termii/Africa's Talking
- `VAPID_PRIVATE_KEY` — Web push notifications

## Migration Runner
`POST /internal/admin/migrations/run` — applies pending D1 schema migrations.
Uses `schema_migrations` tracking table. Authentication: `Authorization: Bearer <MIGRATION_SECRET>`.
`GET /internal/admin/migrations/status` — lists applied/pending migrations.

## Scheduled Cron Handler
`scheduled()` in `worker.ts` runs every minute:
1. `drainEventBus()` — processes pending `platform_events` outbox
2. `sweepExpiredReservations()` — releases expired seat reservations (30s TTL)

## CI/CD
`.github/workflows/deploy.yml` — hard typecheck gate, all 4 migrations applied before deployment, smoke tests on staging before production promotion. No deployment without green quality gate.

## Deployment
- Build: `npm run build:ui` → `dist/`
- Workers deploy: `wrangler deploy --env production`
