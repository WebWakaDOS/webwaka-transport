# WebWaka Transport Suite

## Overview
WebWaka Transport is the Transportation & Mobility vertical suite (Part 10.3) of the WebWaka OS v4 ecosystem. It is a comprehensive, mobile-first, offline-first platform for seat inventory management, agent sales, customer booking, and operator management — targeted at Nigerian and African markets.

## Modules
- **TRN-1**: Seat Inventory Synchronization — atomic validation and sync of seat availability
- **TRN-2**: Agent Sales Application — offline-first POS for bus park agents
- **TRN-3**: Customer Booking Portal — public-facing trip search and booking
- **TRN-4**: Operator Management — tools for transport companies to manage routes/vehicles

## P08-TRANSPORT Revenue Features (complete)
- **T1 Seat Templates**: PUT /vehicles/:id/template; trip creation uses template to generate class-aware seats; GET /trips/:id/availability returns seat_layout + seat_class per seat
- **T2 Fare Matrix**: PUT /routes/:id/fare-matrix (multipliers 1.0–5.0 per class + time_multipliers); GET /trips/search returns effective_fare_by_class; POST /bookings validates total_amount_kobo ±2% tolerance
- **T3 Cancellation + Refunds**: PATCH /bookings/:id/cancel computes refund from operator cancellation policy (full/half/no refund); initiates Paystack automated refund or flags manual_refund_required for cash; publishes booking.refunded event
- **T4 Waiting List**: POST/GET/DELETE /trips/:id/waitlist; sweepExpiredWaitlistNotifications in cron; 10-min hold window; rejects join if seats available
- **T5 Group Bookings**: POST /api/agent-sales/group-bookings (STAFF+, seat_ids [2-50], atomic batch: booking+group_bookings+sales_transaction+receipt+seats, QR code, 422 on insufficient seats); GET /group-bookings/:id; PATCH /group-bookings/:id/cancel with refund policy on booking-portal router; Agent POS Group Booking sub-tab

## P09-TRANSPORT Fleet & Compliance Features (complete)
- **T1 Vehicle Maintenance**: POST/GET /api/operator/vehicles/:id/maintenance — logs service records (vehicle_maintenance_records), immediate vehicle.maintenance_due_soon event if due ≤7 days
- **T1 Vehicle Documents**: POST/GET /api/operator/vehicles/:id/documents — roadworthiness/insurance/frsc_approval/nafdac; GET returns expiry_status (valid/expiring_soon/expired); PATCH /trips/:id blocks assignment if roadworthiness expired (422 vehicle_compliance_expired)
- **T2 Driver Documents**: POST/GET /api/operator/drivers/:id/documents — drivers_license/frsc_cert/medical_cert; PATCH /trips/:id blocks assignment if drivers_license expired (422 driver_license_expired)
- **T3 Notification Center**: GET/POST /api/operator/notifications + /read; filters 9 actionable event types, 7-day window, unread_count; notification_reads table (migration 015); frontend: 🔔 badge with count, slide-in drawer colored by severity, persistent red SOS banner, 30-second auto-refresh
- **Sweepers**: sweepVehicleMaintenanceDue (daily, ≤7d), sweepVehicleDocumentExpiry (daily, ≤30d), sweepDriverDocumentExpiry (daily, ≤30d) — all wired to midnight cron in worker.ts

## P10-TRANSPORT Dispatcher & Analytics (complete)
- **T1 Dispatcher Dashboard**: GET /api/dispatcher/dashboard; live trip map view with GPS positions, seat utilization, driver/vehicle info, SOS alerts; DispatcherDashboard component; nav button in OperatorOverview
- **T2 Platform Analytics**: GET /api/super-admin/analytics; SUPER_ADMIN-only aggregate metrics (operators, revenue, bookings, trips, vehicles, drivers, agents); PlatformAnalyticsSection component in analytics tab; ANALYTICS_ROLES restricted to ['SUPER_ADMIN']

## P11-TRANSPORT Operator API Keys, Onboarding Wizard, Multi-Stop Routes (complete)
- **T1 API Keys**: POST/GET/DELETE /api/operator/api-keys (SHA-256 hash, scope read|read_write); ApiKeysPanel frontend with list/create/revoke/copy; PATCH /operator/profile for profile updates
- **T2 Onboarding Wizard**: OnboardingWizard component (7-step bottom-sheet: Profile→Vehicles→Routes→Seat Templates→Drivers→Agents→First Trip); auto-triggered for new TENANT_ADMIN operators when routes+vehicles are empty; dismissed via localStorage key
- **T3 Multi-Stop Routes**: POST/GET /api/operator/routes/:id/stops (replace-all approach); RouteStopsPanel inline in RoutesPanel with ordered stop editing; booking-portal updated for origin_stop/destination_stop params with segment fare computation
- **Sweepers**: sweepBookingReminders — 24h + 2h pre-departure SMS reminders (reminder_24h_sent_at / reminder_2h_sent_at columns on bookings via migration 016)

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
  rbac.md               - RBAC permission matrix for all 6 roles
  ndpr-compliance.md    - NDPR data retention + sweeper documentation
src/
  components/
    conflict-log.tsx    - C-003: Sync conflict resolution UI
    analytics.tsx       - C-005: Revenue analytics SVG dashboard
    driver-view.tsx     - C-004: Driver mobile boarding manifest
  lib/
    push.ts             - C-001: VAPID Web Push delivery (RFC 8030/8292)
    ai.ts               - C-007: OpenRouter AI trip search
    sweepers.ts         - C-002: NDPR sweepExpiredPII + purgeExpiredFinancialData
  api/
    notifications.ts    - C-001: Push subscription router (/api/notifications)
  vite-env.d.ts         - VITE_VAPID_PUBLIC_KEY type declaration
.dev.vars.example       - All required secrets (copy → .dev.vars, never commit)
```

## Local Development
The frontend runs as a Vite dev server on port 5000. The backend (Cloudflare Worker) is not run locally — the app connects to the production API by default.

```bash
npm run dev:ui   # start Vite frontend
npm test         # run all 300 unit tests (vitest)
npx tsc --noEmit # TypeScript strict mode check (0 errors)
```

## Platform Invariants
- **Nigeria-First**: Naira/kobo integers, NDPR compliance, Nigerian timezones
- **Offline-First**: IndexedDB (Dexie) + service worker sync queue
- **Multi-Tenant**: Every DB query filtered by `operator_id` via `requireTenant()` middleware
- **Event-Driven**: All domain events published to D1 outbox (`platform_events`), drained by cron
- **Build Once Use Infinitely**: `@webwaka/core` shared across all modules
- **Cloudflare-First**: D1, KV, Workers Cron, no Vercel/AWS dependencies
- **Zero Skipping**: No `|| true` in CI, strict TypeScript (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`)

## Phase A: Critical Security + Atomicity Hardening (complete)

### A-001: Payment amount mismatch now returns 402 (BUG-P0-001)
`src/api/payments.ts` `POST /verify` — previously logged a warning and confirmed the booking anyway. Now:
- Returns HTTP 402 with `expected_kobo` / `received_kobo` fields
- Publishes a `payment:AMOUNT_MISMATCH` fraud event to the `platform_events` outbox for alerting

### A-002: Agent sale atomically updates seat status (BUG-P0-002)
`src/api/agent-sales.ts` `POST /transactions` — seats were never marked after a sale. Now:
- Pre-checks that each seat exists for the given trip and is not already `confirmed` or `blocked`
- Uses `db.batch([transactionInsert, receiptInsert, ...seatUpdates])` so the write is atomic

### A-003: Trip + seat creation is now a single atomic batch (BUG-P0-003)
`src/api/seat-inventory.ts` `POST /trips` — trip row was inserted separately before the seat batch. Now a single `db.batch([tripInsert, ...seatInserts])` call ensures no orphaned trips on partial failure.

### A-004: SyncEngine uses Web Locks API for cross-tab mutual exclusion (BUG-P0-004)
`src/core/offline/sync.ts` — the old `_isFlushing` flag was per-instance (per browser tab). Two tabs could flush simultaneously, causing duplicate mutations. Now:
- `flush()` attempts `navigator.locks.request('webwaka-sync-lock', { ifAvailable: true }, ...)` 
- If another tab holds the lock, the call exits immediately with an empty result
- Falls back to the per-instance guard in environments without Web Locks (Node, older browsers)

### A-005: OTP one-time-use enforcement (BUG-P1-002)
`src/api/auth.ts` `POST /otp/verify` — the KV delete was non-fatal (`catch { /* non-fatal */ }`), allowing a second verify call to succeed with the same OTP. Now:
- On code match, the session is overwritten in KV with `{ ...otpSession, used: true }` **before** JWT issuance
- If the KV put fails, the request returns 500 (not silently allowed through)
- Subsequent verify calls for the same `request_id` see `used === true` and return 400

### A-006: JWT_SECRET hardcoded fallback removed (BUG-P1-004)
`src/api/auth.ts` — removed `?? 'dev_secret_min_32_chars_placeholder!'`. Missing `JWT_SECRET` now returns HTTP 503 `"Authentication service misconfigured"`.

### A-007: Receipt endpoint is tenant-scoped + GET /agents requires auth (BUG-P1-005)
`src/api/agent-sales.ts`:
- `GET /agents` now requires `SUPER_ADMIN | TENANT_ADMIN | STAFF | SUPERVISOR` (was unauthenticated)
- `GET /receipts/:id` now requires the same roles and verifies the receipt's agent belongs to the caller's `operator_id` (SUPER_ADMIN bypasses)

### A-008: Booking confirmation and cancellation are atomic batches (BUG-P1-001)
`src/api/booking-portal.ts` `PATCH /bookings/:id/confirm` and `PATCH /bookings/:id/cancel`:
- Both now use `db.batch([bookingUpdate, ...seatUpdates])` — no partial state if a seat update fails
- Same fix applied to `confirmBookingById` in `src/api/payments.ts`

### A-009: CORS no longer reflects first allowed origin for unknown origins (BUG-P1-007)
`src/worker.ts` — `origin` callback now returns `undefined` for unlisted origins (previously returned `ALLOWED_ORIGINS[0]`, which means an attacker from any origin received `Access-Control-Allow-Origin: https://webwaka.ng`).

### A-010: Soft-delete + state machine guards (BUG-P2-001, BUG-P2-002)
- `src/api/seat-inventory.ts` `GET /trips/:id/availability` now checks `trips.deleted_at IS NULL`; returns 404 for soft-deleted trips
- `src/api/operator-management.ts` `PATCH /trips/:id` rejects updates when trip is `in_transit`, `completed`, or `cancelled` with HTTP 409

### A-011: Lat/lng range validation (BUG-P2-008)
`src/api/operator-management.ts` `PATCH /trips/:id/location` now validates:
- latitude ∈ [-90, 90]
- longitude ∈ [-180, 180]
Returns HTTP 400 for out-of-range values.

## P07-TRANSPORT: Float Reconciliation, Thermal Receipt, Multi-Agent Sessions, Bus Parks, Passenger ID (complete)

### Migration 013_p07_agent_ops
Adds to D1 schema:
- `sales_transactions.passenger_id_type TEXT` — NIN/BVN/passport/drivers_license (optional)
- `sales_transactions.passenger_id_hash TEXT` — SHA-256 of the raw ID, never stored plaintext
- `receipts.qr_code TEXT` — format `txnId:seatId1,seatId2,...` for boarding scan validation

### P07-T1: Float Reconciliation (`src/api/agent-sales.ts`)
Three new endpoints on `/api/agent-sales/reconciliation`:
- `POST` — agent submits end-of-day cash float. Auto-calculates `expected_kobo` (sum of cash transactions for the date), computes `discrepancy_kobo = submitted - expected`, stores as `pending`. Duplicate submissions on same date return 409.
- `GET` — supervisor queries reconciliations with agent_id/status/period_date filters.
- `PATCH /:id` — supervisor approves or rejects a pending reconciliation.

**Frontend** (`src/app.tsx` `AgentPOSModule`): "End of Day" button opens a collapsible panel with a cash amount input. After submit, shows a 3-cell grid: Expected | Submitted | Discrepancy, with balanced/shortage/overage messaging.

### P07-T2: Thermal Receipt (`src/components/receipt.tsx`)
New `ReceiptModal` component renders a thermal-style receipt with:
- Route + departure time header in dark blue
- Seats, passengers, payment info, agent name, receipt ID
- 160×160 QR code canvas rendered via `qrcode` lib (async, lazy-loaded)
- Print button (`window.print()`) with `@media print` CSS hiding everything except the receipt card
- Share button using Web Share API → falls back to WhatsApp deep link

After every successful online sale, `AgentPOSModule` opens this modal automatically.

### P07-T3: Multi-Agent Device Session Management (`src/core/offline/db.ts`)
- `AgentSession` gains `name: string` field for display in switcher UI
- `OFFLINE_GRACE_MS = 8h` — sessions remain valid offline for 8 hours beyond JWT expiry
- `getAgentSession(id, { offline: true })` applies the grace period
- `listAgentSessions()` — returns all sessions within the grace window, used by the POS header to detect multiple cached agents
- **Switcher UI**: if >1 cached session exists, a "Switch Agent" button appears in the POS header and calls `logout()` to force re-authentication as a different agent

### P07-T4: Bus Park Management (`src/api/agent-sales.ts`)
Four new endpoints:
- `GET /api/agent-sales/parks` — tenant-scoped list; STAFF+
- `POST /api/agent-sales/parks` — create park with name/city/state/lat/lng; TENANT_ADMIN+
- `POST /api/agent-sales/parks/:id/agents` — assign agent to park; SUPERVISOR+
- `DELETE /api/agent-sales/parks/:id/agents/:agentId` — unassign; SUPERVISOR+

**Frontend**: park selector dropdown auto-loads parks when online; `park_id` is captured per transaction (optional).

### P07-T5: Passenger ID Capture (`src/api/agent-sales.ts` + `src/api/operator-management.ts`)
- `POST /transactions` now accepts `passenger_id_type` (NIN/BVN/passport/drivers_license) and `passenger_id_number` (raw, never stored)
- The raw number is SHA-256 hashed in the Worker via `crypto.subtle.digest` before inserting into `passenger_id_hash`
- FRSC compliance: `GET /api/operator/trips/:id/manifest` now also queries `sales_transactions` for the trip and returns an `agent_sales` array alongside `passengers` (bookings). Each agent sale includes `passenger_id_type` (not the hash). The manifest `summary` now includes `total_agent_sales`, `total_passengers`, `agent_revenue_kobo`, `total_revenue_kobo`.

## Phase 6: Operator Context Hardening + SyncEngine Auth + Agent POS Trip Selector (complete)

### `src/core/auth/context.tsx` — SyncEngine auth wiring
`AuthProvider` now wires the `syncEngine` singleton whenever auth state changes:
- **On rehydrate**: if a valid token is found in `localStorage`, calls `syncEngine.setAuthToken(token)` so that any queued offline mutations are authenticated immediately on app load.
- **On OTP verify**: after JWT is issued and stored, calls `syncEngine.setAuthToken(newToken)`.
- **On logout**: calls `syncEngine.clearAuthToken()` before clearing React state.

Before this, the `_fetchWithAuth` method existed but `_authToken` was always `undefined` — every sync mutation was sent without an `Authorization` header, causing 401 rejections on reconnect.

### `src/api/auth.ts` — OTP rate limiting
Added a sliding-window rate limiter on `POST /api/auth/otp/request`:
- Key: `rate:{phone}` in `SESSIONS_KV`; value: request count as a string; TTL: 600 seconds (10 minutes).
- If `count >= 5`, returns HTTP 429 with error `"Too many OTP requests. Please wait 10 minutes and try again."`
- If `count < 5`, increments and proceeds (sliding window — TTL resets on each request).
- Non-fatal: if the KV rate-check itself throws (e.g. quota error), the OTP request is allowed through.

### `src/app.tsx` — Operator context auto-fill (RoutesPanel, VehiclesPanel)
`RoutesPanel` and `VehiclesPanel` now call `useAuth()`:
- If the logged-in user has `user.operator_id` (i.e. TENANT_ADMIN), the form shows a read-only blue badge `"Operator: opr_xxx"` instead of an editable input field.
- For SUPER_ADMIN (no `operator_id`), the text input remains so they can target any operator.
- `operator_id` is derived as `user?.operator_id ?? form.operator_id` when calling the API — no accidental empty string sent.
- Form resets to `operator_id: user?.operator_id ?? ''` after successful create.

### `src/app.tsx` — Agent POS trip selector + seat grid (AgentPOSModule)
Replaced all three free-text inputs with a real interactive flow:
1. **Trip dropdown** (when online and trips are loaded): `getOperatorTrips()` fetches scheduled + boarding trips. Each option shows `Origin → Destination · HH:MM · N avail`. Falls back to a plain text input if offline or no trips returned.
2. **Seat grid** (auto-loads on trip select): calls `getSeatAvailability(tripId)`. Renders a 4-column button grid; available seats are tappable, occupied/blocked seats are greyed out and disabled. Multiple seats can be selected.
3. **Auto-amount**: when seats are selected, `amount` is auto-filled from `trip.base_fare × selectedSeats.length / 100` (kobo → naira). Agent can still override.
4. **`agent_id`** is now `user?.id ?? 'agent'` (from JWT), not the hardcoded `'current_agent'`.
5. **Submit guard**: button is disabled unless a trip, at least one seat, and an amount are provided.
6. **Offline path**: uses the same `saveOfflineTransaction()` flow as before, with the real agent ID and selected seat IDs.

### `src/api/api.test.ts` — OTP rate limiting tests (4 new tests, 232 total)
New `describe('OTP Rate Limiting')` block covers:
- 503 when `SESSIONS_KV` is not configured
- First 5 requests succeed and return a `dev_code`
- 6th request returns HTTP 429 with "too many" message
- Rate limit is per-phone — exhausting one phone does not affect another

## Payment Integration Layer (Phase 5 — complete)

### `migrations/005_payment_columns.sql`
Adds `payment_provider TEXT DEFAULT 'manual'` and `paid_at INTEGER` to the `bookings` table. Adds `idx_bookings_payment_ref` index for fast webhook lookups.

### `src/api/payments.ts` — Paystack payment router
Mounted at `/api/payments` BEFORE `requireTenantMiddleware` so CUSTOMER users (no operatorId) can access it.

`POST /api/payments/initiate`:
- Looks up booking; validates status (not confirmed/cancelled)
- **Dev mode** (no `PAYSTACK_SECRET`): returns `{ dev_mode: true, reference: booking_id, authorization_url: null }` for immediate local testing
- **Prod mode**: calls `POST https://api.paystack.co/transaction/initialize`; stores reference on booking; returns `authorization_url` + `access_code`

`POST /api/payments/verify`:
- Lookup by `booking_id` first, then `payment_reference`
- **Dev mode**: auto-confirms booking + seats atomically without calling Paystack
- **Prod mode**: calls `GET https://api.paystack.co/transaction/verify/:ref`; validates status=success + amount; confirms booking + seats

`POST /webhooks/paystack` (mounted directly in `worker.ts`, public route):
- HMAC-SHA512 signature verification using `x-paystack-signature` header
- Handles `charge.success`: looks up booking by `payment_reference`, confirms atomically
- 401 on bad signature; 503 when Paystack not configured

### `packages/core/src/index.ts` — CUSTOMER tenant fix
`requireTenant()` middleware now allows CUSTOMER role to pass through with `tenant_id = null` (same as SUPER_ADMIN but without the X-Tenant-ID override). CUSTOMER endpoints scope by `customer_id` at the handler level. Previously CUSTOMER users got 403 on all `/api/booking/*` routes.

### `src/api/client.ts` — Payment methods
- `initiatePayment(bookingId, email)` — calls `POST /api/payments/initiate`
- `verifyPayment({ reference?, booking_id? })` — calls `POST /api/payments/verify`

### `src/components/booking-flow.tsx` — Two-phase payment UX
`StepConfirm` now has two phases:
1. **Phase 1** (Pay button): `createBooking` → `initiatePayment` → if dev_mode/non-Paystack: auto-`verifyPayment` → ticket. If prod + Paystack: open `authorization_url` in new tab, show "awaiting" screen with reference code.
2. **Phase 2** (Awaiting screen): "I've completed payment" button → `verifyPayment({ reference })` → ticket. "Re-open Paystack" link for users who closed the tab. `user.phone` from auth context used to derive payment email (`phone@pay.webwaka.ng`).

### Test coverage
9 new tests in `describe('Paystack Payments API')` covering: missing params, unknown booking, 409 confirmed/cancelled, dev_mode initiate, dev_mode auto-confirm, already_confirmed idempotency.

## Authentication Layer (Phase 4 — complete)

### `src/api/auth.ts` — OTP auth router (backend)
Two public endpoints (exempted from `jwtAuthMiddleware`):
- `POST /api/auth/otp/request` — validates Nigerian phone, generates 6-digit OTP, stores in `SESSIONS_KV` with 5-min TTL. Returns `{ request_id, expires_in, phone_hint, dev_code? }`. When `SMS_API_KEY` is absent (dev/test), `dev_code` echoed in response for easy testing.
- `POST /api/auth/otp/verify` — verifies request_id + code, consumes OTP from KV, finds/creates user (customers or agents table), issues 24h JWT via `generateJWT`. Returns `{ token, user: { id, name, phone, role, operator_id? } }`. New phone numbers auto-registered as CUSTOMER. Existing agents automatically get STAFF role + operatorId.

Mounted in `worker.ts` at `/api/auth` **before** `jwtAuthMiddleware` so no token is required.

### `src/core/auth/store.ts` — Token persistence
Synchronous localStorage wrapper: `getStoredToken()`, `setStoredToken()`, `clearStoredToken()`, `getStoredUser()`, `setStoredUser()`. `decodeToken()` base64-decodes JWT payload (no crypto). `isTokenExpired()` checks `exp` with 60s clock-skew buffer. `isTokenValid()` = not-null + not-expired.

### `src/core/auth/context.tsx` — AuthContext + useAuth hook
`AuthProvider` rehydrates token from localStorage on mount. Exposes `user`, `token`, `isAuthenticated`, `isLoading`, `requestOtp()`, `verifyOtp()`, `logout()`, `hasRole()`. Role type: `WakaRole` (SUPER_ADMIN | TENANT_ADMIN | SUPERVISOR | STAFF | DRIVER | CUSTOMER).

### `src/components/login-screen.tsx` — Login UI
Step 1: Nigerian phone number input (`🇳🇬 +234` prefix). Step 2: 6-digit OTP grid (auto-advances on digit entry, paste support). Auto-fills `dev_code` in development. 60s resend countdown. Error display inline.

### `src/api/client.ts` — Auth header injection + 401 auto-logout
Every `request()` call now injects `Authorization: Bearer <jwt>` from `getStoredToken()`. On 401 response: calls `clearStoredToken()` + dispatches `waka:unauthorized` custom event.

### `src/app.tsx` — Auth-aware shell
`TransportApp` wraps `AppContent` in `AuthProvider`. `AppContent` shows loading spinner → `LoginScreen` (if not authenticated) → main app (if authenticated). Role-based tab gating: CUSTOMER sees Search + Bookings; STAFF/SUPERVISOR adds Agent POS; TENANT_ADMIN/SUPER_ADMIN adds Operator Dashboard. App header shows user name/role + Sign out button. `waka:unauthorized` event triggers auto-logout.

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
- `POST /api/operator/trips` — create trip + batch-insert seats; derives `operator_id` from route; accepts `base_fare`/`total_seats` overrides (TRN-4, Phase 7)
- `PATCH /api/booking/bookings/:id/cancel` — customer self-cancel pending booking; releases seats (TRN-3, Phase 7)
- `GET /api/operator/trips/:id/manifest` — passenger manifest: trip summary, driver info, passenger list (name/phone/seats/payment), load factor, confirmed revenue (TRN-4, Phase 8)
- `GET /api/booking/bookings/:id` — single booking detail with passenger_names, seat_ids, operator_name (TRN-3, Phase 8)
- `POST /api/operator/drivers` — register a driver profile (name, phone, license_number) for an operator (TRN-4, Phase 9)
- `GET /api/operator/drivers` — list drivers with operator_id + status filters and pagination (TRN-4, Phase 9)
- `PATCH /api/operator/drivers/:id` — update driver name/phone/license_number/status (TRN-4, Phase 9)
- `PATCH /api/operator/trips/:id` — now also accepts driver_id for trip assignment (TRN-4, Phase 9)
- `PATCH /api/agent/agents/:id` — update agent name/phone/email/role/status/bus_parks; 404 for unknown, 409 on duplicate phone (TRN-2, Phase 10)
- `GET /api/operator/reports/revenue` — revenue aggregates (booking + agent sales) with top-routes breakdown; query params: from/to (ms), operator_id (TRN-4, Phase 10)
- `GET /api/operator/operators` — list all operators with pagination; optional status filter (Phase 11)
- `POST /api/operator/operators` — create operator (name, code, phone, email); 409 on duplicate code (SUPER_ADMIN only, Phase 11)
- `PATCH /api/operator/operators/:id` — update operator name/phone/email/status; 404 for unknown (SUPER_ADMIN only, Phase 11)
- `POST /api/operator/trips/:id/copy` — duplicate a trip to a new departure_time; preserves route/vehicle/driver/base_fare; fresh seats batch-inserted; 404 for unknown source, 400 if departure_time missing (TRN-4, Phase 12)

### P03-TRANSPORT (complete) — Inline Payments, SMS, QR E-Tickets, Guest Booking
- Paystack inline popup with `waka_` reference format; `POST /api/booking/payments/initiate` + `/verify`
- SMS booking confirmation via Termii; enriched publishEvent payload
- QR e-ticket page at `/b/:bookingId` with WhatsApp share + print CSS
- Guest booking flow: OTP verify-phone endpoints; migration `011_guest_bookings`
- Reservation TTL + operator config API; seat hold extension heartbeat (extend-hold endpoint)

### P05-TRANSPORT (complete) — GPS, SOS, Digital Boarding, Manifest Export, Pre-Trip Inspection, Delay Reporting
- **Migration 012_p05_trip_ops**: adds `location_updated_at`, `sos_triggered_by`, `delay_reason_code`, `delay_reported_at`, `estimated_departure_ms` to trips
- **P05-T1 GPS**: `POST /api/operator/trips/:id/location` — validates state (not completed/cancelled), tenant scope, updates `location_updated_at`, publishes `trip.location_updated`, returns 204
- **P05-T2 SOS**: `POST /api/operator/trips/:id/sos` (DRIVER+) — triggers SOS, sends SMS to emergency_contact_phone, publishes `trip:SOS_ACTIVATED`; `POST /api/operator/trips/:id/sos/clear` (SUPERVISOR+)
- **P05-T3 Digital Boarding**: `POST /api/operator/trips/:id/board` — parses QR payload `{bookingId}:{seatIds}`, validates status/not-boarded, marks boarded_at, publishes `booking.boarded`; `GET /api/operator/trips/:id/boarding-status`
- **P05-T4 Manifest Export**: Extended `GET /api/operator/trips/:id/manifest` with `boarded_at`, `seat_numbers`, `payment_method`, `qr_payload` per passenger; CSV export via `Accept: text/csv` header
- **P05-T5 Pre-Trip Inspection**: `POST /api/operator/trips/:id/inspection` (DRIVER+) — validates all 5 boolean checks, inserts into `trip_inspections`, sets `inspection_completed_at`; state transition gate checks `inspection_required_before_boarding` config; `GET /api/operator/trips/:id/inspection`
- **P05-T6 Delay Reporting**: `POST /api/operator/trips/:id/delay` (SUPERVISOR+) — reason_code enum validation, future timestamp check, publishes `trip:DELAYED`; sweepers bulk-SMS up to 100 affected passengers; `GET /api/operator/trips/:id/delay`
- **Sweepers**: `trip:SOS_ACTIVATED` handler (console.error + optional SendGrid email, never dropped); `trip:DELAYED` handler (bulk SMS to confirmed passengers, max 100, non-fatal)

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
- `vitest` — Test runner (281 unit tests across 7 test files)

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
`scheduled()` in `worker.ts` runs every minute. All sweeper logic extracted to `src/lib/sweepers.ts`:
1. `drainEventBus(env)` — processes pending `platform_events` outbox; routes events to consumers; retries up to 3×; marks dead after 3 failures.
2. `sweepExpiredReservations(env)` — releases expired seat reservations (30s TTL); publishes `seat.reservation_expired` events.
3. `sweepAbandonedBookings(env)` — cancels bookings where `status='pending'` AND `payment_status='pending'` for > 30 minutes; releases seats back to `available`; publishes `booking:ABANDONED` events.

Event consumers wired in `deliverEvent()`:
- `seat:RESERVED` / `seat.reservation_expired` → `SEAT_CACHE_KV.delete(seat_id)` (cache invalidation)
- `booking:CONFIRMED` → push notification stub (C-001 pending)
- `booking:ABANDONED` → log (SMS notification C-001 pending)
- `parcel.*` → forwarded to `https://logistics.webwaka.app/api/internal/events`
- `payment:AMOUNT_MISMATCH` → console fraud alert

## Phase B — Infrastructure & Security Hardening (complete)

### B-001: SMS OTP Integration
`src/lib/sms.ts` — `SmsProvider` interface + factory `buildSmsProvider(env)`. Key format: `termii:<api_key>` (Termii Nigeria primary), `at:<username>:<api_key>` (Africa's Talking fallback), unset → dev mode (logs OTP, echoes `dev_code`). Wired into `src/api/auth.ts` `POST /api/auth/otp/request` — SMS send is non-fatal (OTP stored in KV regardless).

### B-002: Idempotency Key System
`src/middleware/idempotency.ts` — Hono middleware mounted on all `/api/*` routes. Reads `X-Idempotency-Key` header. Checks `IDEMPOTENCY_KV` — returns cached response on replay; caches 2xx responses for 24h. Non-fatal when `IDEMPOTENCY_KV` not bound (gradual rollout). `src/core/offline/sync.ts` `_fetchWithAuth()` now attaches `X-Idempotency-Key: <mutation.id>` header on all sync requests. `IDEMPOTENCY_KV` added to `Env` interface in `src/api/types.ts` and `src/worker.ts`.

### B-003: Migration 006 — 10 Performance Indexes
Added to `MIGRATIONS` array in `src/api/admin.ts`: `idx_routes_operator_id`, `idx_vehicles_operator_id`, `idx_seats_operator_trip`, `idx_bookings_payment_ref`, `idx_bookings_customer_id`, `idx_bookings_trip_id`, `idx_transactions_agent_id`, `idx_transactions_trip_id`, `idx_platform_events_status`, `idx_trips_operator_departure`.

### B-004: KV Namespace Provisioning + CI Guard
`wrangler.toml` — `IDEMPOTENCY_KV` namespace added to both staging and production environments with `placeholder-idempotency-*` IDs. `scripts/provision-kv.sh` updated to also provision `IDEMPOTENCY_KV`. `.github/workflows/ci.yml` — removed `|| true` from TypeScript checks; added warning step for placeholder KV IDs; added production-blocking check that fails deploy if `placeholder` strings found in `[env.production]` config; added staging migration post-deploy step.

### B-005: Abandoned Booking Sweeper + Event Bus Consumers
`src/lib/sweepers.ts` — extracted `drainEventBus`, `sweepExpiredReservations` from `worker.ts`; added `sweepAbandonedBookings`. All three wired into `scheduled()` cron via `Promise.all`. CORS `allowHeaders` updated to include `X-Idempotency-Key`.

## Security Hardening (Production Audit — complete)
- **SEC-001 (CORS)**: `worker.ts` CORS changed from wildcard `*` to domain allowlist: `webwaka-transport-ui.pages.dev`, `webwaka.ng`, `www.webwaka.ng`, `localhost:5000/5173`, `127.0.0.1:5000`.
- **SEC-006 (Seat Release)**: `seat-inventory.ts` release endpoint now requires `token` field. Returns 400 if missing, 403 if token doesn't match `reservation_token`. 3 regression tests added.
- **SQL Injection**: `operator-management.ts` revenue endpoint previously used string interpolation for `agentFilter`/`tripFilter`. Converted to parameterized D1 queries with bound params.
- **Schema hardening**: `customers.operator_id NOT NULL` removed (customers are cross-tenant); `bookings` gets `payment_provider`/`paid_at`; `sales_transactions` gets `deleted_at`; `drivers` table added. All handled by migration 005.
- **`@webwaka/core` resolution**: `packages/core/package.json` exports fixed (`.js` → `.ts`); `vitest.config.ts` has `resolve.alias` pointing to TypeScript source. Was the root cause of all test failures.

## Phase E — Multi-Currency Support (complete)

### E-001: Multi-currency Core (`src/core/i18n/index.ts`)
- Added `CurrencyCode` type: `'NGN' | 'GHS' | 'KES' | 'UGX' | 'RWF'`
- Added `CurrencyConfig` interface with `code`, `symbol`, `subunitFactor`, `locale`, `flag`, `name`, `fractionDigits`
- `CURRENCY_CONFIG` table: NGN `₦` (factor 100, 2dp) · GHS `₵` (factor 100, 2dp) · KES `KSh` (factor 100, 2dp) · UGX `USh` (factor 1, 0dp) · RWF `RWF` (factor 1, 0dp)
- `formatAmount(subunits, currency?)` — formats stored sub-unit integer for display; defaults to `getCurrency()` when no currency passed
- `getCurrency() / setCurrency()` — module-level state + `trn_currency` localStorage key; same pattern as language
- `getSupportedCurrencies()` — returns all 5 `CurrencyConfig` objects (flag, symbol, name, etc.)
- `formatKoboToNaira` kept as backward-compat alias that always calls `formatAmount(kobo, 'NGN')`

### E-002: Currency Selector UI (`src/app.tsx`)
- Imported `formatAmount, setCurrency, getCurrency, getSupportedCurrencies, CurrencyCode` from i18n
- Added `currency` state (`useState<CurrencyCode>(getCurrency())`) to `AppContent`
- Added `handleCurrencyChange` handler (calls `setCurrency` + updates React state → full re-render)
- `StatusBar` now accepts `currency` + `onCurrencyChange` props; renders a compact flag+code `<select>` (e.g. `🇳🇬 NGN`) alongside the existing language picker
- All 13 in-file `formatKoboToNaira` calls replaced with `formatAmount`

### E-003: Currency-aware Components
- `src/components/analytics.tsx` — all revenue cards and agent breakdown table use `formatAmount`
- `src/components/booking-flow.tsx` — fare display, total, confirm screen, pay button, ticket amount use `formatAmount`
- `src/components/driver-view.tsx` — import updated to `formatAmount`
- Zero prop changes needed: `formatAmount()` reads current currency from module state at render time

### E-004: i18n Multi-currency Tests (24 new tests, now 333 total)
- 4 tests per currency (NGN, GHS, KES, UGX, RWF) covering symbol, conversion, fraction digits
- `formatAmount` defaulting to current currency, explicit override
- `getCurrency / setCurrency` — default NGN, persistence across calls
- `getSupportedCurrencies` — length 5, all codes present, config shape valid, NGN/GHS/KES=2dp, UGX/RWF=0dp

### E-005: Component Test Mock Updates
- `analytics.test.tsx` and `driver-view.test.tsx` mocks now export both `formatKoboToNaira` and `formatAmount`

## Phase D — Flutterwave + React Component Tests (complete)

### D-001: Flutterwave Payment Integration
`src/api/payments.ts` — Added `POST /api/payments/flutterwave/initiate` and `POST /api/payments/flutterwave/verify` routes. Flutterwave amounts are in Naira (not kobo); conversion handled on both initiate (`Math.ceil(kobo/100)`) and verify (`Math.round(naira*100)`). Dev mode: no `FLUTTERWAVE_SECRET` → auto-confirms without API call (same pattern as Paystack). Fraud detection emits `payment:AMOUNT_MISMATCH` platform event on amount mismatch.

`src/worker.ts` — Added `POST /webhooks/flutterwave` handler. Verifies via `verif-hash` header (Flutterwave's pre-shared string verification). Handles `charge.completed` event → confirms booking + seats atomically.

`src/api/client.ts` — Added `initiateFlutterwave(bookingId, email)` and `verifyFlutterwave(opts)` typed methods.

`src/components/booking-flow.tsx` — Added Flutterwave to `PAYMENT_METHODS`. `AwaitingPayment` type now includes `provider` and `checkoutUrl`. `handlePay` routes to Flutterwave or Paystack based on selection. `handleVerify` uses the correct verify API per provider. Awaiting payment UI shows provider-appropriate icon, color, and label.

### D-002: React Component Tests
- `vitest.config.browser.ts` — new Vitest config using `happy-dom` environment, `@vitejs/plugin-react` for JSX transform. Run via `npm run test:components`.
- `src/test-setup.ts` — imports `@testing-library/jest-dom` matchers.
- 4 component test files with 18 tests total:
  - `src/components/login-screen.test.tsx` — phone validation, requestOtp call, OTP step transition (5 tests)
  - `src/components/conflict-log.test.tsx` — conflict rendering, empty state, Accept Server action (4 tests)
  - `src/components/analytics.test.tsx` — loading state, stat cards, agent breakdown, error state (5 tests)
  - `src/components/driver-view.test.tsx` — trips list, empty state, manifest loading, board action (4 tests)

### D-003: Playwright E2E Config
`playwright.config.ts` — Updated `baseURL` default to `http://localhost:5000` (Vite dev server). Added `desktop-chrome` project alongside `mobile-chrome`. Use `PLAYWRIGHT_BASE_URL` env var to override for CI/production.

## Test Commands
- `npm test` — 309 API/domain/backend tests (Vitest + node env)
- `npm run test:components` — 18 React component tests (Vitest + happy-dom)
- `npm run test:e2e` — Playwright E2E (requires running dev server)
- `npm run test:coverage` — coverage report

## CI/CD
`.github/workflows/ci.yml` — test (`npm test -- --run`) → typecheck → deploy-staging (on `staging` branch) → deploy-production + post-deploy migration (on `main` branch). GitHub Actions secrets required: `CLOUDFLARE_API_TOKEN`, `MIGRATION_SECRET`, `WORKER_URL`.

## Deployment
- Build: `npm run build:ui` → `dist/`
- Workers deploy: `wrangler deploy --env production`

## Phase P03-TRANSPORT: Real-Time UX & Guest Access (complete)

### P03-T1: Configurable Reservation TTL + Operator Config API
- `src/lib/operator-config.ts` — `getOperatorConfig(env, operatorId)` reads from `OPERATOR_CONFIG_KV`; falls back to `DEFAULT_CONFIG` (`reservation_ttl_ms: 30_000`, `online_reservation_ttl_ms: 180_000`).
- `src/api/seat-inventory.ts` — `POST /reserve` and `POST /reserve-batch` now call `getOperatorConfig()` to get TTL values based on request origin (agent vs. online customer).
- `src/api/operator-management.ts` — `GET /operator/config` and `PUT /operator/config` endpoints for operators to read/write their config.

### P03-T2: Seat Hold Extension Heartbeat
- `src/api/seat-inventory.ts` — `POST /trips/:tripId/extend-hold` extends seat reservation TTL up to a 10-minute absolute max cap. Validates hold token from seat metadata.

### P03-T3: Paystack Inline Popup
- `index.html` — Paystack inline JS loaded via `<script src="https://js.paystack.co/v1/inline.js">`.
- `.env.example` — `VITE_PAYSTACK_PUBLIC_KEY` documented.
- `src/components/booking-flow.tsx` — `handlePay()` now checks for `window.PaystackPop` and opens the inline popup iframe with auto-verify `callback`. Falls back to new-tab redirect if popup unavailable. Payment reference format changed to `waka_${nanoid('', 16)}` via booking-portal.ts.

### P03-T4: SMS Booking Confirmation
- `src/lib/sms.ts` — `sendSms(to, message, env)` convenience wrapper; tries `TERMII_API_KEY` then `SMS_API_KEY`; non-fatal.
- `src/lib/sweepers.ts` — sweeper now fires SMS on `booking.created` events using customer phone, origin, destination, departure date, seat numbers from enriched event payload.
- `src/api/booking-portal.ts` — `PATCH /bookings/:id/confirm` now JOINs trips/routes/customers tables and includes `customer_phone`, `origin`, `destination`, `departure_time`, `seat_numbers` in `publishEvent` payload.

### P03-T5: QR E-Ticket Page
- `src/components/ticket.tsx` — `TicketPage` component: fetches `GET /b/:bookingId/data`, renders passenger/trip info + QRCode canvas via `qrcode` npm package.
- `src/worker.ts` — `GET /b/:bookingId/data` endpoint (public, before jwtAuthMiddleware): returns confirmed booking JSON joined with trip/route/operator.
- `src/app.tsx` — `TransportApp` checks `window.location.pathname` for `/b/:bookingId` pattern and renders `TicketPage` directly.

### P03-T6: Guest Booking Flow
- `src/api/booking-portal.ts` — `publicBookingRouter` exported with two public endpoints:
  - `POST /api/booking/verify-phone` — generates 6-digit OTP, stores in `SESSIONS_KV` (10-min TTL), sends via `sendSms()`. Returns `dev_otp` in response when no SMS key is configured.
  - `POST /api/booking/verify-phone/confirm` — validates OTP, deletes from KV on success, issues short-lived (15-min) guest JWT via `generateJWT()`. User ID is `guest_XXXXXXXXXXXXXXXX`.
- `src/api/booking-portal.ts` `POST /bookings` — detects `user.id.startsWith('guest_')`, auto-creates minimal customer record via `INSERT OR IGNORE`, sets `is_guest = 1`.
- `src/api/admin.ts` — migration `011_guest_bookings` adds `is_guest INTEGER DEFAULT 0` column to bookings table.
- `src/worker.ts` — `publicBookingRouter` mounted at `/api/booking` BEFORE `jwtAuthMiddleware`; `TERMII_API_KEY` added to `Env` interface.
- `src/api/types.ts` — `TERMII_API_KEY` added to shared `Env` interface.

### P03 Key Invariants
- All SMS calls are non-fatal (`catch(() => {})`) — never block booking flow
- Guest JWT TTL is 15 minutes (short-lived, single-use session)
- OTP is consumed (KV deleted) on first valid use — no replay
- `is_guest` flag stored on bookings for audit; Nigerian phone format validated (`+234` or `0` prefix + 10 digits)
- Paystack payment reference format: `waka_${16-char-random}` (Paystack-compatible)

---

## P15-TRANSPORT: Subscription Tier Gating, Real-Time Seats, Corporate Portal, White-Label, Bulk Import

### P15-T1: Subscription Tier Gating Middleware
- `packages/core/src/index.ts` — `requireTierFeature(feature)` middleware; tier map: basic/pro/enterprise; 9 gated features (`operator_reviews→basic`, `ai_search/waiting_list/analytics/api_keys/seat_class_pricing→pro`, `auto_schedule/white_label/bulk_import→enterprise`); returns 402 with `TIER_INSUFFICIENT` on mismatch; SUPER_ADMIN bypasses; CUSTOMER passes for `operator_reviews`.
- `migrations/009_subscription_tier_and_corporate.sql` — adds `subscription_tier` to operators; `customer_type`, `credit_limit_kobo`, `company_name`, `contact_email` to customers.

### P15-T2: Durable Objects Real-Time Seat Fan-Out
- `src/durables/trip-seat-do.ts` — `TripSeatDO` class; WebSocket set per trip; `/ws` endpoint upgrades connection; `/broadcast` POST fans message to all connected clients; `{ type: 'seat_changed', seat }` payload.
- `wrangler.toml` — `TRIP_SEAT_DO` durable object binding + `ASSETS_R2` R2 bucket.
- `src/api/seat-inventory.ts` — `broadcastSeatChange()` helper; `GET /trips/:id/ws` WebSocket proxy; DO broadcasts on reserve, reserve-batch, confirm, release.

### P15-T3: Booking Portal Updates
- `src/api/booking-portal.ts` — `requireTierFeature` on `POST /trips/ai-search` (ai_search), `POST /trips/:id/waitlist` (waiting_list), `POST /reviews` (operator_reviews).
- Credit payment (`payment_method=credit`) for corporate customers: checks `customer_type='corporate'`, deducts from `credit_limit_kobo`, sets `payment_status='completed'` immediately; returns 402 if insufficient credit.
- `POST /corporate-accounts` — create corporate account (TENANT_ADMIN+); accepts `company_name, contact_name, contact_phone, credit_limit_naira`.
- `GET /corporate-accounts` — list corporate accounts (TENANT_ADMIN+).
- `GET /corporate-accounts/:id/statement` — monthly credit statement with booking list.

### P15-T4: Operator Management Updates
- `src/api/operator-management.ts` — `requireTierFeature` on `PUT /routes/:id/fare-matrix` (seat_class_pricing), `GET /reports/revenue` (analytics), `POST /api-keys` (api_keys).
- `POST /schedules` — create recurring trip schedule (auto_schedule tier); fields: `route_id, departure_time, recurrence, recurrence_days, horizon_days`.
- `GET /branding` — fetch operator branding from TENANT_CONFIG_KV (mounted at `/api/operator/branding`).
- `PUT /config/branding` — store branding config in TENANT_CONFIG_KV (white_label tier); validates hex colors.
- `POST /config/logo` — upload logo to ASSETS_R2 (white_label tier); supports PNG/JPEG/SVG/WebP; returns public URL.
- `POST /import/routes` — bulk route import up to 500 rows (bulk_import tier); per-row status.
- `POST /import/vehicles` — bulk vehicle import up to 500 rows (bulk_import tier).
- `POST /import/drivers` — bulk driver import up to 500 rows (bulk_import tier).

### P15-T5: Frontend Updates
- `src/app.tsx` — `useLiveSeatUpdates(tripId, onSeatChange)` hook: WebSocket to `/api/trips/:id/ws`, auto-reconnects every 3s on disconnect, cleans up on unmount.
- `AgentPOSModule` — wired with `useLiveSeatUpdates`; live seat status merged into `seatAvailability` state; unavailable seats auto-deselected.
- `AppContent` — white-label branding detection on login: fetches `/api/operator/branding`, applies `--waka-primary`/`--waka-secondary` CSS variables, updates `document.title` and favicon.
