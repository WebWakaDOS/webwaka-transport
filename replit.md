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
npm test         # run all 219 unit tests (vitest)
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

## Frontend Layer (Phase 3 — complete)

### `src/api/client.ts` — Typed API client
`ApiClient` class wraps all API endpoints. No raw `fetch()` in components. `ApiError` class carries HTTP status + endpoint. Exported singleton `api`. Key methods: `searchTrips`, `getSeatAvailability`, `reserveSeat`, `releaseSeat`, `registerCustomer`, `createBooking`, `confirmBooking`, `cancelBooking`, `getBookings`, `recordSale`, `getOperatorDashboard`, `getOperatorRoutes`, `createRoute`, `getVehicles`, `createVehicle`, `getOperatorTrips`, `transitionTrip`, `deleteTrip`.

### `src/components/seat-map.tsx` — TRN-1 Seat Inventory UI
Visual seat grid. Calls `api.getSeatAvailability(tripId)`. Color-coded: green=available, yellow=reserved, blue=confirmed, red=blocked. Selected seats: dark blue. 4-across bus layout with aisle column. Retry on error. Multi-select up to `maxSelectable`. `readOnly` mode for display.

### `src/components/booking-flow.tsx` — TRN-3 Complete Booking Journey
Multi-step wizard integrated with `TripSearchModule` in `app.tsx`:
1. **StepSeats** — seat map, select seat(s), shows total fare
2. **StepCustomer** — full name, phone, email (optional), NDPR consent checkbox (enforced)
3. **StepConfirm** — booking summary, 3 payment method selectors (Paystack/Mobile Money/Bank Transfer), calls `POST /bookings` → `PATCH /confirm`
4. **TicketView** — confirmation receipt with booking ref, route, departure, operator, total paid

### `src/app.tsx` — Updated + Error Boundaries
- `ErrorBoundary` class component wraps each module tab
- All raw `fetch()` replaced with `api.*` calls
- All `any` type casts replaced with proper types from `client.ts`
- `MyBookingsModule` uses `Booking[]` state from `api.getBookings()`
- `AgentPOSModule` uses `api.recordSale()`
- All operator panels use `api.getOperatorDashboard()`, `api.getOperatorRoutes()`, etc.

## API Layer (Phase 2 — complete)

### `src/api/types.ts` — Shared types and helpers
`Env` (all KV + D1 bindings), `AppContext` (Hono context with `Variables: { user: WakaUser | undefined }`), `HonoCtx`. D1 row interfaces for all tables: `DbOperator`, `DbRoute`, `DbVehicle`, `DbTrip`, `DbSeat`, `DbBooking`, `DbCustomer`, `DbAgent`, `DbSalesTransaction`, `DbReceipt`. Helpers: `getOperatorScope(c)` (returns operator_id from JWT or null for SUPER_ADMIN), `applyTenantScope(c, query, params, alias?)` (appends AND filter), `parsePagination(q)` (limit 1-200, offset ≥0), `metaResponse(count, limit, offset)`, `requireFields(body, fields)`, `genId(prefix)`.

### New endpoints added in Phase 2
- `PATCH /api/seat-inventory/trips/:tripId/seats/:seatId` — offline seat mutation sync (TRN-1)
- `PATCH /api/booking/bookings/:id` — update payment_reference/method on pending booking (TRN-3)
- `PATCH /api/operator/trips/:id` — update vehicle/departure_time (TRN-4)
- `DELETE /api/operator/trips/:id` — soft-delete trip (blocked if boarding/in_transit) (TRN-4)
- `PATCH /api/operator/routes/:id` — update fare/status/origin/destination (TRN-4)
- `PATCH /api/operator/vehicles/:id` — update model/status/seats (TRN-4)

### Hardening applied to all 4 API files
- All D1 queries wrapped in try/catch with 500 fallback
- All `as any` body casts replaced with typed `Record<string, unknown>` + `requireFields()`
- Pagination (`limit`, `offset`, `meta`) on all list endpoints
- Multi-tenant enforcement via `applyTenantScope()` on tenant-scoped queries

## Offline Data Layer (Phase 1 — complete)

### `src/core/offline/db.ts` — Dexie v2 schema
Tables: `mutations`, `transactions`, `trips`, `seats`, `bookings`, `agent_sessions`, `conflict_log`, `operator_config`, `ndpr_consent`.
Key helpers: `queueMutation`, `getPendingMutations` (respects `next_retry_at` backoff), `markMutationFailed` (exp. backoff 1→2→4→8→32s), `cacheTrips`/`getCachedTrips` (5-min TTL), `cacheSeats`/`getCachedSeats` (30-sec TTL), `logConflict`, `cacheAgentSession`, `recordNdprConsent`.

### `src/core/offline/sync.ts` — SyncEngine
`SyncEngine.flush()` reads PENDING mutations → routes each to the right API endpoint → marks SYNCED on 200, re-queues with backoff on 4xx/5xx (max 5 retries), logs conflict + abandons on 409, abandons immediately on 401/403. Exported `syncEngine` singleton. `setupSyncMessageHandler()` wires the SW `TRIGGER_SYNC` message to `syncEngine.flush()`.

### `src/core/offline/hooks.ts` — React hooks
`useOnlineStatus()` — tracks browser online/offline. `useSyncQueue()` — pending count + isSyncing + auto-sync on reconnect + manual `triggerSync()`. `usePendingSync()` — backwards-compat alias.

### `public/sw.js` — Service Worker v2
Background Sync: fires `TRIGGER_SYNC` to all window clients via MessageChannel; awaits `SYNC_DONE` reply before resolving `event.waitUntil()`. Push notifications wired. Notification click navigates to payload URL.

### `scripts/provision-kv.sh` + `docs/infra-setup.md`
KV namespace provisioning script (SESSIONS_KV, TENANT_CONFIG_KV, SEAT_CACHE_KV). Full infra setup guide (D1, KV, secrets, cron, deploy flow).

## Dependencies
- `@webwaka/core` — in-repo package at `packages/core/src/index.ts`. Provides RBAC (`requireRole`), JWT (`verifyJWT`, `generateJWT`, `jwtAuthMiddleware`), tenant enforcement (`requireTenant`, `getTenantId`), event bus (`publishEvent`), formatting (`formatKobo`, `nanoid`).
- `dexie` — IndexedDB wrapper for offline-first storage
- `fake-indexeddb` — dev dependency for Dexie unit testing in Node environment
- `hono` — Web framework for Cloudflare Workers
- `react` + `react-dom` — React 19 UI framework
- `vitest` — Test runner (219 unit tests across 7 test files)

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
