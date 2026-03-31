# WebWaka Transport Suite — Master Implementation Plan

> **Document type**: Phased implementation plan with per-repo, dependency-ordered steps  
> **Date**: March 31, 2026  
> **Source research**: `webwaka-transport-research.md`  
> **Repos covered**: `@webwaka/core` · `webwaka-transport` · `webwaka-logistics`

---

## How to Read This Document

Each phase is repo-scoped. A phase cannot begin until all phases it depends on are fully merged and deployed. Phases within the same repo that list no blockers can begin immediately once their predecessor phase is deployed. Phases in different repos that reference each other are explicitly cross-linked.

**Phase ID format**: `P{number}-{REPO}` where REPO is one of `CORE`, `TRANSPORT`, `LOGISTICS`.

---

## Dependency Graph (Summary)

```
P01-CORE  ──────────────────────────────────────────────────────────────────────────┐
                                                                                    │
P02-TRANSPORT (depends on P01-CORE) ─────────────────────────────────────────────┐ │
P03-TRANSPORT (depends on P02-TRANSPORT) ──────────────────────────────────────┐  │ │
P04-TRANSPORT (depends on P01-CORE) ───────────────────────────────────────────│  │ │
P05-TRANSPORT (depends on P04-TRANSPORT) ──────────────────────────────────────│──┘ │
P06-TRANSPORT (depends on P05-TRANSPORT) ──────────────────────────────────────│    │
P07-TRANSPORT (depends on P04-TRANSPORT) ──────────────────────────────────────│    │
P08-TRANSPORT (depends on P04, P07-TRANSPORT) ─────────────────────────────────│    │
P09-TRANSPORT (depends on P05, P08-TRANSPORT) ─────────────────────────────────│    │
P10-TRANSPORT (depends on P05, P09-TRANSPORT) ─────────────────────────────────│    │
P11-TRANSPORT (depends on P10-TRANSPORT) ──────────────────────────────────────┘    │
P12-LOGISTICS (depends on P11-TRANSPORT) ──────────────────────────────────────┐    │
P13-TRANSPORT (depends on P12-LOGISTICS) ──────────────────────────────────────│    │
P14-CORE  (depends on P11-TRANSPORT) ──────────────────────────────────────────│    └
P15-TRANSPORT (depends on P14-CORE, P13-TRANSPORT) ────────────────────────────┘
```

---

## Phase P01-CORE — Platform Foundation Consolidation

**Repo**: `@webwaka/core` (`packages/core/src/index.ts` and related files)  
**Blocks**: P02-TRANSPORT, P04-TRANSPORT  
**Blocked by**: Nothing — start immediately

### P01-T1: Consolidate ID Generation

**Problem**: Two ID generators exist — `genId()` in `webwaka-transport/src/api/types.ts` and `nanoid()` in `@webwaka/core`. Any repo using both risks inconsistent ID formats.

**Files to modify**:
- `packages/core/src/index.ts` — ensure `nanoid(prefix, length)` is exported and documented
- `webwaka-transport/src/api/types.ts` — remove `genId()`, replace all call sites with `import { nanoid } from '@webwaka/core'`

**Steps**:
1. Verify `nanoid(prefix, length)` in `@webwaka/core` produces a collision-resistant ID with a readable prefix and length ≥ 16 characters using Cloudflare-compatible `crypto.getRandomValues`.
2. Add a JSDoc comment to `nanoid` clarifying its Cloudflare Worker compatibility.
3. Export a typed alias `export const genId = nanoid` from `@webwaka/core` for backward compatibility during migration.
4. In `webwaka-transport`: replace every call to `genId(prefix)` with `nanoid(prefix)`. There are approximately 12 call sites across `seat-inventory.ts`, `agent-sales.ts`, `booking-portal.ts`, `operator-management.ts`, and `sweepers.ts`.
5. Remove the `genId` function declaration from `src/api/types.ts`.
6. Run `tsc --noEmit` to verify no type errors.

**Acceptance**: `genId` no longer appears in `webwaka-transport`. All ID generation routes through `@webwaka/core`.

---

### P01-T2: Promote Shared Query Helpers to Core

**Problem**: `parsePagination()`, `metaResponse()`, and `applyTenantScope()` are defined in `webwaka-transport/src/api/types.ts` but are generic enough to be used by any repo.

**Files to modify**:
- `packages/core/src/index.ts` — add and export the three functions with full TypeScript generics
- `webwaka-transport/src/api/types.ts` — remove the local definitions, replace with re-exports from `@webwaka/core`

**Steps**:
1. Copy `parsePagination(q: Record<string, string>): { limit: number; offset: number }` into `@webwaka/core` with configurable max-limit cap (default 100).
2. Copy `metaResponse(data, total, limit, offset)` into `@webwaka/core` returning `{ data, meta: { total, limit, offset, has_more } }`.
3. Copy `applyTenantScope(c, baseQuery, params)` into `@webwaka/core` as a generic helper that appends `AND operator_id = ?` and the tenant ID to any SQL query string and params array.
4. Export all three from the core package index.
5. In `webwaka-transport/src/api/types.ts`: import all three from `@webwaka/core`, remove local function bodies, keep local type augmentations.
6. In each of the four transport API routers, verify that the import resolves through `types.ts` without changes (since `types.ts` re-exports).

**Acceptance**: Functions are importable from `@webwaka/core` in any repo. The transport repo compiles with zero new errors.

---

### P01-T3: Add NDPR Consent Utility to Core

**Problem**: NDPR consent is currently checked inconsistently — the API checks `ndpr_consent: true` in request body, the offline DB records it in the Dexie `ndpr_consent` table, but there is no shared utility that enforces and records consent uniformly.

**Files to create/modify**:
- `packages/core/src/ndpr.ts` — new file
- `packages/core/src/index.ts` — export from new file

**Steps**:
1. Create `packages/core/src/ndpr.ts` with:
   - `assertNdprConsent(body: unknown): void` — throws a structured 400 error if `body.ndpr_consent !== true`
   - `recordNdprConsent(db: D1Database, entityId: string, entityType: string, ipAddress: string, userAgent: string): Promise<void>` — inserts into `ndpr_consent_log` table (create this table in the migration if not present)
   - `NdprConsentLog` interface: `{ id, entity_id, entity_type, consented_at, ip_address, user_agent }`
2. Export from `packages/core/src/index.ts`.
3. In `webwaka-transport/src/api/booking-portal.ts`: replace the inline `if (!body.ndpr_consent)` check with `assertNdprConsent(body)`.
4. After customer creation, call `recordNdprConsent(db, customerId, 'customer', ip, userAgent)`.

**Acceptance**: NDPR consent enforcement is one import call. The `ndpr_consent_log` table is created in the migration. No inline consent checks remain in transport API handlers.

---

### P01-T4: Add API Key Authentication Support

**Problem**: There is currently no way for operators to generate API keys for third-party system integration. The JWT middleware only supports bearer tokens.

**Files to modify**:
- `packages/core/src/index.ts` — extend `jwtAuthMiddleware` to also accept `Authorization: ApiKey {key}` header
- Add `verifyApiKey(key: string, db: D1Database): Promise<WakaUser | null>` function

**Steps**:
1. In `@webwaka/core`, add `verifyApiKey(hashedKey: string, db: D1Database): Promise<WakaUser | null>` that:
   - Computes SHA-256 of the input key using `crypto.subtle.digest`
   - Queries `api_keys` table: `SELECT * FROM api_keys WHERE key_hash = ? AND revoked_at IS NULL`
   - Returns a `WakaUser` constructed from the api_key row (operator_id → tenant_id, scope → role)
2. Extend `jwtAuthMiddleware` to detect `Authorization: ApiKey {key}` header prefix and route to `verifyApiKey` instead of JWT verification.
3. Export `verifyApiKey` from the package index.
4. The `api_keys` DB table is created in P02-TRANSPORT's migration.

**Acceptance**: `jwtAuthMiddleware` accepts both JWT bearer tokens and API keys. `verifyApiKey` is importable from `@webwaka/core`.

---

## Phase P02-TRANSPORT — Critical Fixes and Sync Infrastructure

**Repo**: `webwaka-transport`  
**Blocks**: P03-TRANSPORT  
**Blocked by**: P01-CORE (must be deployed first)

### P02-T1: Wire Offline Agent Transaction Sync to SyncEngine

**Problem**: `saveOfflineTransaction()` writes to Dexie `transactions` correctly, but `SyncEngine.flush()` never reads `getPendingTransactions()`. Offline sales are silently lost.

**Files to modify**:
- `src/core/offline/sync.ts` — extend `flush()` to include the transactions table
- `src/core/offline/db.ts` — verify `getPendingTransactions()` is correctly defined

**Steps**:
1. In `src/core/offline/sync.ts`, inside the `flush()` method, after processing the mutations queue, add a second phase:
   ```
   const pendingTx = await db.getPendingTransactions();
   for (const tx of pendingTx) {
     try {
       const response = await fetch('/api/agent-sales/sync', {
         method: 'POST',
         headers: { 'Content-Type': 'application/json', 'X-Idempotency-Key': tx.idempotencyKey },
         body: JSON.stringify({ transactions: [tx] }),
       });
       if (response.ok || response.status === 409) {
         await db.markTransactionSynced(tx.id);
       } else {
         await db.incrementTransactionRetry(tx.id);
       }
     } catch { /* network error — will retry */ }
   }
   ```
2. In `src/core/offline/db.ts`, add `markTransactionSynced(id: string)` that sets `synced_at = Date.now()` on the transaction row. Add `incrementTransactionRetry(id: string)` that increments `retry_count`.
3. Add `idempotencyKey` field to the `transactions` Dexie schema if not present (schema v3 migration). The key is `tx_` + nanoid.
4. Ensure `GET /api/agent-sales/transactions?synced=false` can be used by the UI to show pending offline sales count.

**Acceptance**: An agent sale recorded offline while offline appears in the server transaction list after the next sync. A 409 (already synced) response marks the local record as synced without error.

---

### P02-T2: Multi-Seat Atomic Reservation Batch Endpoint

**Problem**: Reserving N seats for a booking requires N sequential API calls. Between calls, a race condition exists.

**Files to modify**:
- `src/api/seat-inventory.ts` — add new route
- `migrations/` — no schema change needed

**Steps**:
1. Add `POST /api/seat-inventory/trips/:tripId/reserve-batch` to the seat inventory router.
2. Request body: `{ seat_ids: string[], user_id: string, idempotency_key: string }`.
3. Implementation logic:
   a. Begin by reading all requested seats in one query: `SELECT id, status, version FROM seats WHERE id IN (?,?,?) AND trip_id = ?`
   b. If any seat is not `'available'`, return 409 with `{ error: 'seat_unavailable', seat_id: '{id}' }`
   c. Generate one reservation token per seat using `nanoid('tok', 32)`
   d. Compute `reservation_expires_at` from operator config TTL (default 30,000ms)
   e. Build a D1 `batch()` of UPDATE statements — one per seat — all with `WHERE status = 'available' AND version = {version}` (optimistic lock)
   f. Execute the batch. Check `meta.changes` on each result. If any UPDATE changed 0 rows, the seat was taken between read and write — roll back all by running another batch to release any that succeeded, and return 409.
   g. Insert one `platform_events` row: `seat.batch_reserved` with `payload: { trip_id, seat_ids, user_id, tokens }`
   h. Return `{ tokens: [{seat_id, token, expires_at}] }`
4. Wire idempotency check (read `IDEMPOTENCY_KV` before processing).

**Acceptance**: Calling `reserve-batch` with 3 seats either succeeds with 3 tokens or fails entirely with no seats held. Concurrent identical requests are idempotent.

---

### P02-T3: Schema Migration for New Tables

**Problem**: Several phases require new DB tables. Introduce them in a single coordinated migration.

**Files to create**:
- `migrations/002_phase2_tables.sql`

**Steps**:
Create `migrations/002_phase2_tables.sql` containing:

```sql
-- api_keys (P01-T4)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'read',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_operator ON api_keys(operator_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- ndpr_consent_log (P01-T3)
CREATE TABLE IF NOT EXISTS ndpr_consent_log (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  consented_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ndpr_entity ON ndpr_consent_log(entity_id, entity_type);

-- bus_parks / terminals (A-07, O-01)
CREATE TABLE IF NOT EXISTS bus_parks (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_bus_parks (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  park_id TEXT NOT NULL REFERENCES bus_parks(id),
  PRIMARY KEY (agent_id, park_id)
);

-- float_reconciliation (A-03)
CREATE TABLE IF NOT EXISTS float_reconciliation (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  operator_id TEXT NOT NULL,
  period_date TEXT NOT NULL,
  expected_kobo INTEGER NOT NULL,
  submitted_kobo INTEGER NOT NULL,
  discrepancy_kobo INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_agent_date ON float_reconciliation(agent_id, period_date);

-- trip_inspections (D-05)
CREATE TABLE IF NOT EXISTS trip_inspections (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  inspected_by TEXT NOT NULL,
  tires_ok INTEGER NOT NULL DEFAULT 0,
  brakes_ok INTEGER NOT NULL DEFAULT 0,
  lights_ok INTEGER NOT NULL DEFAULT 0,
  fuel_ok INTEGER NOT NULL DEFAULT 0,
  emergency_equipment_ok INTEGER NOT NULL DEFAULT 0,
  manifest_count INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inspection_trip ON trip_inspections(trip_id);

-- seat_history (S-19)
CREATE TABLE IF NOT EXISTS seat_history (
  id TEXT PRIMARY KEY,
  seat_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seat_history_seat ON seat_history(seat_id);

-- vehicle_maintenance_records (O-02)
CREATE TABLE IF NOT EXISTS vehicle_maintenance_records (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  operator_id TEXT NOT NULL,
  service_type TEXT NOT NULL,
  service_date INTEGER NOT NULL,
  next_service_due INTEGER,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintenance_vehicle ON vehicle_maintenance_records(vehicle_id);

-- vehicle_documents (O-02)
CREATE TABLE IF NOT EXISTS vehicle_documents (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  operator_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_number TEXT,
  issued_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vehicle_docs ON vehicle_documents(vehicle_id, doc_type);

-- driver_documents (O-04)
CREATE TABLE IF NOT EXISTS driver_documents (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  operator_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_number TEXT,
  license_category TEXT,
  issued_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_driver_docs ON driver_documents(driver_id, doc_type);

-- waiting_list (S-18)
CREATE TABLE IF NOT EXISTS waiting_list (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  seat_class TEXT NOT NULL DEFAULT 'standard',
  position INTEGER NOT NULL,
  notified_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_waiting_list_trip ON waiting_list(trip_id, position);

-- operator_reviews (B-10)
CREATE TABLE IF NOT EXISTS operator_reviews (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  review_text TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_booking ON operator_reviews(booking_id);

-- schedules (D-16)
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  route_id TEXT NOT NULL REFERENCES routes(id),
  vehicle_id TEXT,
  driver_id TEXT,
  departure_time TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'daily',
  recurrence_days TEXT,
  horizon_days INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- agent_broadcasts (A-13)
CREATE TABLE IF NOT EXISTS agent_broadcasts (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  sent_by TEXT NOT NULL,
  message TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

-- dispute_tickets (A-20)
CREATE TABLE IF NOT EXISTS dispute_tickets (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_agent ON dispute_tickets(agent_id);

-- route_stops (O-06)
CREATE TABLE IF NOT EXISTS route_stops (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  stop_name TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  distance_from_origin_km REAL,
  fare_from_origin_kobo INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_route_stops ON route_stops(route_id, sequence);

-- Add missing columns to existing tables
ALTER TABLE trips ADD COLUMN IF NOT EXISTS inspection_completed_at INTEGER;
ALTER TABLE trips ADD COLUMN IF NOT EXISTS park_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS origin_stop_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS destination_stop_id TEXT;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS insurance_selected INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN IF NOT EXISTS insurance_premium_kobo INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN IF NOT EXISTS commission_rate REAL DEFAULT 0.05;
ALTER TABLE vehicles ADD COLUMN IF NOT EXISTS seat_template TEXT;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS route_stops_enabled INTEGER DEFAULT 0;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS cancellation_policy TEXT;
ALTER TABLE routes ADD COLUMN IF NOT EXISTS fare_matrix TEXT;
```

**Steps**:
1. Create the file above.
2. Register it in `src/api/admin.ts` migration runner as `002`.
3. Run via `POST /internal/admin/migrations/run` in dev to verify no SQL errors.

**Acceptance**: All tables created without error. `wrangler d1 execute --local` succeeds on the migration file.

---

## Phase P03-TRANSPORT — Payment and Confirmation Flow

**Repo**: `webwaka-transport`  
**Blocks**: P05-TRANSPORT  
**Blocked by**: P02-TRANSPORT

### P03-T1: Configurable Reservation TTL via Operator Config

**Files to modify**:
- `src/api/seat-inventory.ts` — read TTL from `TENANT_CONFIG_KV` instead of hardcoded value
- `src/api/operator-management.ts` — add config read/write endpoints

**Steps**:
1. Add helper `getOperatorConfig(env, operatorId)` that reads `TENANT_CONFIG_KV.get(operatorId)` and parses JSON. Returns defaults if key is absent.
2. Default config shape:
   ```json
   {
     "reservation_ttl_ms": 30000,
     "online_reservation_ttl_ms": 180000,
     "abandonment_window_ms": 1800000,
     "surge_multiplier_cap": 2.0,
     "cancellation_policy": { "free_before_hours": 24, "half_refund_before_hours": 12 }
   }
   ```
3. In `POST /api/seat-inventory/trips/:id/reserve`, read `online_reservation_ttl_ms` for web-origin requests (detected by `Origin` header), `reservation_ttl_ms` for POS requests.
4. In `POST /api/seat-inventory/trips/:id/reserve-batch` (P02-T2), apply the same TTL logic.
5. Add `GET /api/operator/config` — returns the parsed config for the authenticated operator.
6. Add `PUT /api/operator/config` (TENANT_ADMIN+) — validates the JSON shape and writes to `TENANT_CONFIG_KV`.

**Acceptance**: An operator who sets `online_reservation_ttl_ms: 180000` via PUT config has their web bookings held for 3 minutes instead of 30 seconds.

---

### P03-T2: Seat Hold Extension Heartbeat Endpoint

**Files to modify**:
- `src/api/seat-inventory.ts` — add new route

**Steps**:
1. Add `POST /api/seat-inventory/trips/:tripId/extend-hold` route.
2. Request body: `{ seat_id: string, token: string }`.
3. Logic:
   a. Query seat: `SELECT status, reservation_token, reservation_expires_at, reserved_by FROM seats WHERE id = ? AND trip_id = ?`
   b. If `status !== 'reserved'` or `reservation_token !== body.token`, return 409.
   c. If `reservation_expires_at < Date.now()`, return 410 Gone (already expired).
   d. Extend by `reservation_ttl_ms` from operator config. Cap total hold at `max_hold_ms` (default 10 minutes).
   e. UPDATE the `reservation_expires_at` column.
   f. Return `{ expires_at: newTimestamp }`.
4. The client calls this every 60 seconds while the user is on the payment page.

**Acceptance**: Hold expiry is extended. A hold cannot be extended beyond 10 minutes total from original creation. An expired hold cannot be extended.

---

### P03-T3: Paystack Inline Popup SDK Integration

**Files to modify**:
- `src/app.tsx` or relevant booking flow component — add Paystack Inline SDK
- `src/api/booking-portal.ts` — ensure `payment_reference` is returned on booking create

**Steps**:
1. In the booking confirmation component, load the Paystack Inline JS SDK via `<script src="https://js.paystack.co/v1/inline.js">` (add to `index.html` or dynamically load).
2. When user taps "Pay Now", call `window.PaystackPop.setup({ key: PAYSTACK_PUBLIC_KEY, email, amount, reference, onSuccess, onClose })` and `.openIframe()`.
3. `onSuccess(transaction)`: call `PATCH /api/booking/bookings/:id/confirm` with `{ payment_reference: transaction.reference }`.
4. `onClose()`: call `POST /api/seat-inventory/trips/:id/extend-hold` if within hold window, otherwise show "Hold expired — please rebook" message.
5. In `POST /api/booking/bookings`, ensure `payment_reference` (a Paystack reference string generated by the server) is in the response.
6. The Paystack public key must be stored as an environment variable `PAYSTACK_PUBLIC_KEY` (not a secret — it is public).

**Acceptance**: Clicking "Pay Now" opens the Paystack modal without leaving the page. On success, the booking is confirmed. On close, the seat hold is extended or the user is gracefully redirected.

---

### P03-T4: SMS Booking Confirmation Wire-Up

**Problem**: `booking.created` event handler in `drainEventBus()` logs "push notification not yet wired". The SMS lib `src/lib/sms.ts` exists but is not called.

**Files to modify**:
- `src/lib/sweepers.ts` — `drainEventBus()` `booking.created` handler
- `src/lib/sms.ts` — verify `sendSms(to, message, env)` is fully implemented

**Steps**:
1. In `drainEventBus()`, in the `booking.created / booking:CONFIRMED` handler, call:
   ```typescript
   const payload = JSON.parse(String(evt.payload));
   const message = buildBookingConfirmationSms(payload);
   await sendSms(payload.customer_phone, message, env);
   ```
2. Write `buildBookingConfirmationSms(payload)` function that constructs the message:
   ```
   WebWaka: Booking confirmed! {origin} → {destination}, {departure_date}, Seat {seat_numbers}.
   Ref: {booking_id_short}. View ticket: https://webwaka.ng/b/{booking_id}
   ```
3. In `src/lib/sms.ts`, ensure `sendSms(to, message, env)` is a complete working Termii or Yournotify API call, not a stub.
4. The `customer_phone` must be included in the `booking.created` event payload. Update `publishEvent` call in `booking-portal.ts` to include `customer_phone`.
5. If `TERMII_API_KEY` is not set, log a warning and skip (non-fatal, as per existing AI failure policy).

**Acceptance**: A confirmed booking triggers an SMS within one cron cycle (max 60 seconds). SMS failure does not prevent the booking from being confirmed.

---

### P03-T5: E-Ticket Page with QR Boarding Pass

**Files to create**:
- `src/pages/ticket.tsx` — public e-ticket page component
- Add route in `src/worker.ts` or `src/app.tsx`: `GET /b/:bookingId`

**Steps**:
1. Create `GET /b/:bookingId` public API route in `src/worker.ts` that returns booking details (trip, seats, passenger names, operator name, departure time) without requiring auth. The booking must be `confirmed` status. Return 404 for anything else.
2. Create `src/pages/ticket.tsx` React component:
   - Displays: operator logo/name, route (origin → destination), departure date and time, seat number(s), passenger name(s), booking reference, receipt ID.
   - Generates a QR code containing the string `{bookingId}:{seatIds_comma_separated}` using a browser-compatible QR library (e.g. `qrcode.js` loaded via CDN).
   - Styled with `@media print` CSS for clean thermal/A4 printing.
   - Shows a "Share via WhatsApp" button using `wa.me/?text=` deep link with trip summary.
3. The page must render meaningfully even without internet (cache it in the Service Worker).
4. Add the route to the React Router config in `src/app.tsx`.

**Acceptance**: `/b/{bookingId}` renders a complete e-ticket with a scannable QR code. The QR decodes to `{bookingId}:{seatIds}`. The page prints cleanly on A4 and 80mm thermal.

---

### P03-T6: Guest Booking (Phone Number Only)

**Files to modify**:
- `src/api/booking-portal.ts` — modify `POST /api/booking/bookings`
- `src/api/auth.ts` — OTP verification for guest flow

**Steps**:
1. Add a guest booking path to `POST /api/booking/bookings`:
   - If request includes `guest: true` in body, create a minimal customer record (phone, passenger_name from the booking's `passenger_names[0]`) with `ndpr_consent: true` required.
   - The guest customer `id` is stored as `cust_guest_{nanoid}`.
   - No email required. No full account registration.
2. Add `POST /api/booking/verify-phone` that initiates an OTP to the provided phone number. Booking only proceeds after OTP verification.
3. Guest bookings store `is_guest: true` flag on the booking record. Guest customers are subject to NDPR sweeper (2-year inactivity anonymization applies equally).
4. On the frontend, show a simplified flow: Enter phone → OTP verification → Select seats → Pay → Receive SMS ticket.

**Acceptance**: A user with only a phone number can complete a booking. No email or password required. The booking appears in `GET /api/booking/bookings?customer_id=...`.

---

## Phase P04-TRANSPORT — Operator Config Service (Parallel with P03)

**Repo**: `webwaka-transport`  
**Blocks**: P05-TRANSPORT, P07-TRANSPORT, P08-TRANSPORT  
**Blocked by**: P01-CORE  
**Can run in parallel with P03-TRANSPORT**

### P04-T1: Operator Config Service (Full Implementation)

This expands the lightweight config helper introduced in P03-T1 into the full config service with Dexie caching.

**Files to modify**:
- `src/api/operator-management.ts` — add full config CRUD
- `src/core/offline/db.ts` — `operator_config` table is already defined; add full read/write helpers

**Steps**:
1. Define the canonical `OperatorConfig` TypeScript interface in `src/api/types.ts` (or move to `@webwaka/core` if used across repos):
   ```typescript
   interface OperatorConfig {
     reservation_ttl_ms: number;
     online_reservation_ttl_ms: number;
     abandonment_window_ms: number;
     surge_multiplier_cap: number;
     boarding_window_minutes: number;
     parcel_acceptance_enabled: boolean;
     cancellation_policy: {
       free_before_hours: number;
       half_refund_before_hours: number;
     };
     emergency_contact_phone: string;
     sos_escalation_email: string;
     inspection_required_before_boarding: boolean;
   }
   ```
2. `GET /api/operator/config` — reads from `TENANT_CONFIG_KV` (parse JSON), applies defaults for missing fields. Returns full config.
3. `PUT /api/operator/config` (TENANT_ADMIN+) — validates input against config schema, writes to `TENANT_CONFIG_KV`, publishes `operator.config_updated` platform event.
4. In `src/core/offline/db.ts`, add `getOperatorConfig()` that reads from Dexie `operator_config` table (TTL 1 hour). Add `saveOperatorConfig(config)` that writes to Dexie. The PWA fetches config on login and stores it locally.
5. The `getOperatorConfig(env, operatorId)` helper (used server-side across all API routers) reads from `TENANT_CONFIG_KV`, not D1.

**Acceptance**: Operators can view and edit their configuration via the UI. Config changes take effect on the next API call (KV reads on every request). Offline agents use the locally cached config.

---

### P04-T2: Automated Schedule Engine

**Files to modify/create**:
- `src/api/operator-management.ts` — add schedule CRUD
- `src/lib/sweepers.ts` — add `generateScheduledTrips()` cron function
- `src/worker.ts` — wire the new sweeper to the minute cron

**Steps**:
1. Add `POST /api/operator/schedules` (TENANT_ADMIN+): accepts `{ route_id, vehicle_id, driver_id, departure_time: "HH:MM", recurrence: "daily"|"weekdays"|"weekends"|"custom", recurrence_days: [0,1,2,3,4,5,6], horizon_days: 30 }`.
2. Add `GET /api/operator/schedules` — lists schedules for authenticated operator.
3. Add `PATCH /api/operator/schedules/:id` — update or deactivate a schedule.
4. Add `DELETE /api/operator/schedules/:id` — soft delete.
5. Add `generateScheduledTrips(env)` to `sweepers.ts`:
   - Runs daily (add to the daily cron, not minute cron).
   - Fetches all active schedules.
   - For each schedule, determines which departure dates within the next `horizon_days` do not already have a matching trip (same route, vehicle, departure time, same date).
   - Creates missing trips with seats (reuse the trip+seat batch creation logic from `seat-inventory.ts`).
   - Publishes `schedule.trips_generated` platform event with count.
6. Run `generateScheduledTrips` also when a new schedule is created (to populate the immediate future).

**Acceptance**: An operator who creates a daily schedule sees 30 days of trips pre-generated. Trips are not duplicated if the sweeper runs multiple times.

---

## Phase P05-TRANSPORT — Trip Operations Core

**Repo**: `webwaka-transport`  
**Blocks**: P06-TRANSPORT, P09-TRANSPORT  
**Blocked by**: P04-TRANSPORT, P02-TRANSPORT

### P05-T1: GPS Location Update Endpoint

**Files to modify**:
- `src/api/operator-management.ts` — add location update route

**Steps**:
1. Add `POST /api/operator/trips/:id/location` (DRIVER role+):
   - Request body: `{ latitude: number, longitude: number, accuracy_meters?: number }`
   - Validates latitude ∈ [-90, 90], longitude ∈ [-180, 180]
   - `UPDATE trips SET current_latitude = ?, current_longitude = ?, location_updated_at = ? WHERE id = ? AND deleted_at IS NULL`
   - Publishes `trip.location_updated` event with `{ trip_id, lat, lng, updated_at }`
   - Returns 204 No Content on success
2. Expose `current_latitude`, `current_longitude`, `location_updated_at` on the `GET /api/operator/trips/:id` and `GET /api/booking/bookings/:id` responses.
3. Add `location_updated_at` column to `trips` table via migration (add to migration 002 or create 003).

**Acceptance**: A PATCH from the driver view updates the trip location. The booking portal shows the updated location on the trip status screen within 30 seconds.

---

### P05-T2: SOS Trigger and Clear Endpoints

**Files to modify**:
- `src/api/operator-management.ts` — add two SOS routes

**Steps**:
1. Add `POST /api/operator/trips/:id/sos` (DRIVER role+):
   - Validates trip exists and `sos_active = 0`
   - `UPDATE trips SET sos_active = 1, sos_triggered_at = ?, sos_triggered_by = ? WHERE id = ?`
   - Publishes `trip:SOS_ACTIVATED` platform event with full trip context
   - Reads `sos_escalation_email` and `emergency_contact_phone` from operator config
   - Calls `sendSms(emergency_contact_phone, "🚨 SOS: Driver {name} on trip {id} ({route}). Triggered at {time}", env)`
   - Returns 200 with confirmation
2. Add `POST /api/operator/trips/:id/sos/clear` (SUPERVISOR role+):
   - `UPDATE trips SET sos_active = 0, sos_cleared_at = ?, sos_cleared_by = ? WHERE id = ? AND sos_active = 1`
   - Publishes `trip:SOS_CLEARED` event
   - Returns 200
3. In `drainEventBus()`, add handler for `trip:SOS_ACTIVATED` that also sends an email if `SENDGRID_API_KEY` or similar is configured (non-fatal if not).

**Acceptance**: A driver SOS triggers an immediate SMS to the operator emergency contact. The event appears in the operator notification center. A supervisor can clear the SOS.

---

### P05-T3: Digital Boarding Scan Endpoint

**Files to modify**:
- `src/api/operator-management.ts` — add boarding route

**Steps**:
1. Add `POST /api/operator/trips/:id/board` (STAFF role+):
   - Request body: `{ qr_payload: string }` where `qr_payload = "{bookingId}:{seatIds_comma}"`
   - Parse `qr_payload` to extract `bookingId` and `seatIds`
   - Query: `SELECT b.*, s.seat_number FROM bookings b JOIN seats s ON s.id IN ({seatIds}) WHERE b.id = ? AND b.trip_id = ? AND b.status = 'confirmed' AND b.deleted_at IS NULL`
   - If not found: return 404 `{ error: 'invalid_ticket' }`
   - If already boarded (`boarded_at IS NOT NULL`): return 409 `{ error: 'already_boarded', boarded_at }`
   - `UPDATE bookings SET boarded_at = ?, boarded_by = ? WHERE id = ?`
   - Return `{ passenger_names, seat_numbers, trip_info }` for the agent/driver display
2. Add `GET /api/operator/trips/:id/boarding-status` — returns count of confirmed vs. boarded passengers for real-time manifest tracking.

**Acceptance**: Scanning a valid QR returns passenger details and marks the booking as boarded. Scanning the same QR again returns 409. Scanning an invalid QR returns 404. Count of boarded passengers updates in real time.

---

### P05-T4: Trip Manifest Export (PDF and CSV)

**Files to modify**:
- `src/api/operator-management.ts` — extend manifest endpoint
- Frontend manifest component

**Steps**:
1. Extend `GET /api/operator/trips/:id/manifest` response to include:
   - All confirmed bookings with `passenger_names`, `seat_numbers`, `boarded_at`, `payment_method`, `passenger_id_type`, `passenger_id_number` (if captured)
   - Trip summary: origin, destination, departure_time, vehicle plate, driver name, total confirmed, total boarded
2. Add `Accept: text/csv` content negotiation — when `Accept: text/csv` header is sent, return the manifest as a CSV file with `Content-Disposition: attachment; filename=manifest_{tripId}_{date}.csv`.
3. In the frontend manifest component, add:
   - "Export CSV" button: fetches with `Accept: text/csv` header and triggers browser download
   - "Print Manifest" button: triggers `window.print()` with a styled `@media print` layout
   - Each row displays a QR code (encoded with `bookingId:seatId`) for per-row roadside verification
   - Add a "Boarding Status" column showing ✓ or ○

**Acceptance**: Manifest CSV download works. Print layout is clean on A4. QR codes in each row link to the e-ticket URL.

---

### P05-T5: Pre-Trip Inspection Checklist

**Files to modify**:
- `src/api/operator-management.ts` — add inspection endpoint
- Modify trip state machine to gate boarding on inspection

**Steps**:
1. Add `POST /api/operator/trips/:id/inspection` (DRIVER role+):
   - Request body: `{ tires_ok, brakes_ok, lights_ok, fuel_ok, emergency_equipment_ok, manifest_count, notes }`
   - All boolean fields must be `true` for inspection to be marked complete
   - Insert into `trip_inspections` table
   - `UPDATE trips SET inspection_completed_at = ? WHERE id = ?`
   - Return inspection record
2. Add `GET /api/operator/trips/:id/inspection` — returns the inspection record or null if not done.
3. In the trip state transition endpoint (`PATCH /api/operator/trips/:id/state`), when transitioning to `boarding`, check if operator config has `inspection_required_before_boarding: true`. If yes and `inspection_completed_at IS NULL`, return 422 with `{ error: 'inspection_required' }`.

**Acceptance**: A trip cannot transition to `boarding` if the operator has enabled `inspection_required_before_boarding` and no inspection record exists. Inspection records are immutable once created.

---

### P05-T6: Delay Reporting with Passenger Notification

**Files to modify**:
- `src/api/operator-management.ts` — add delay report route
- `src/lib/sweepers.ts` — add delay notification event handler

**Steps**:
1. Add `POST /api/operator/trips/:id/delay` (SUPERVISOR role+):
   - Request body: `{ reason_code: string, reason_details: string, estimated_departure_ms: number }`
   - Valid reason codes: `traffic | breakdown | weather | accident | fuel | other`
   - Add columns to trips: `delay_reason_code TEXT, delay_reported_at INTEGER, estimated_departure_ms INTEGER` (migration)
   - `UPDATE trips SET delay_reason_code = ?, delay_reported_at = ?, estimated_departure_ms = ? WHERE id = ?`
   - Publish `trip:DELAYED` event with `{ trip_id, reason_code, estimated_departure, affected_booking_ids }`
2. In `drainEventBus()`, add `trip:DELAYED` handler:
   - Fetch all confirmed bookings for the trip with customer phone numbers
   - Send SMS to each: `"WebWaka: Your trip {route} has been delayed. Reason: {reason}. New est. departure: {time}. We apologize."`
   - Non-fatal — log failures without rethrowing.
3. Add `GET /api/operator/trips/:id/delay` — returns current delay status.

**Acceptance**: Filing a delay triggers SMS to all confirmed passengers within one cron cycle. Passengers with no phone receive no SMS (logged as skip).

---

## Phase P06-TRANSPORT — Driver Mobile Experience

**Repo**: `webwaka-transport`  
**Blocks**: P09-TRANSPORT  
**Blocked by**: P05-TRANSPORT

### P06-T1: Driver View Complete Implementation

**Files to modify**:
- `src/components/driver-view.tsx` — extend existing component
- `src/app.tsx` — ensure DRIVER role routes to DriverView

**Steps**:
1. The existing `DriverView` component shows basic trip info. Extend it with the following tabs/sections:
   a. **My Trips**: `GET /api/operator/trips?driver_id=me` — lists assigned trips. Tapping a trip opens trip detail.
   b. **Trip Detail**: departure time, route, vehicle plate, seat count, inspection status. Includes "Start Inspection" button (P05-T5).
   c. **Manifest**: inline manifest view with boarding scan button (P05-T3). Camera scan opens the QR reader using `getUserMedia`.
   d. **Location**: toggle to start/stop sharing GPS location every 30 seconds (calls P05-T1 endpoint). Shows current coordinates.
   e. **SOS**: prominent red SOS button. One-tap trigger (P05-T2). Shows "SOS ACTIVE" banner when active. Confirmation dialog before trigger.
   f. **Delay Report**: form to file a delay (P05-T6).
2. The QR scanner uses a browser-compatible library. No native app required.
3. All driver view sections work offline — manifest is cached in Dexie, inspection form queues via SyncEngine.
4. The DRIVER role must be correctly set in RBAC for all P05 endpoints.

**Acceptance**: A driver can complete a full trip workflow from the driver view: load trip → inspect → board passengers via QR scan → report delays → share location → trigger SOS if needed. All these actions work on a mid-range Android phone.

---

## Phase P07-TRANSPORT — Agent Operations

**Repo**: `webwaka-transport`  
**Blocks**: P08-TRANSPORT  
**Blocked by**: P04-TRANSPORT

### P07-T1: Agent Daily Float Reconciliation

**Files to modify**:
- `src/api/agent-sales.ts` — add reconciliation endpoints
- Frontend agent POS — add end-of-day reconciliation screen

**Steps**:
1. Add `POST /api/agent-sales/reconciliation` (AGENT role+):
   - Request body: `{ date: 'YYYY-MM-DD', cash_submitted_kobo: number }`
   - Query sum of confirmed cash transactions for that agent on that date:
     `SELECT COALESCE(SUM(total_amount), 0) as expected FROM sales_transactions WHERE agent_id = ? AND DATE(datetime(created_at/1000, 'unixepoch')) = ? AND payment_method = 'cash' AND deleted_at IS NULL`
   - Compute discrepancy, insert into `float_reconciliation`
   - Publish `agent.reconciliation_filed` event
   - Return the reconciliation record with discrepancy highlighted
2. Add `GET /api/agent-sales/reconciliation` — list reconciliations for the authenticated agent (AGENT) or all agents in operator (SUPERVISOR+).
3. Add `PATCH /api/agent-sales/reconciliation/:id` (SUPERVISOR+) — set `status = 'approved'|'disputed'`, add notes.
4. Frontend: add "End of Day" button in agent POS. Shows sum of today's sales, prompts for physical cash count, submits reconciliation.

**Acceptance**: An agent can file a reconciliation. The system auto-computes the expected total. Discrepancies > ₦500 are flagged in the supervisor dashboard.

---

### P07-T2: Thermal Receipt Printing

**Files to modify**:
- `src/components/` — add `Receipt` component
- Agent POS sale completion screen

**Steps**:
1. Create `src/components/receipt.tsx`:
   - Props: `{ receipt: DbReceipt, trip: DbTrip, route: DbRoute, operator: DbOperator, seats: string[], passengerNames: string[], paymentMethod: string }`
   - Renders: operator name + logo placeholder, route (origin → destination), departure time, seat numbers, passenger names, amount (₦ formatted), payment method, receipt ID, booking ID, QR code (using QR library), verification URL, "WEBWAKA TRANSPORT" footer
   - Has `@media print` CSS: 58mm width layout, no margins, no backgrounds, 10pt font
2. After a successful agent sale, show the receipt component in a modal.
3. Add a "Print Receipt" button that calls `window.print()`.
4. Add a "Share via WhatsApp" button: `wa.me/?text={encoded_receipt_summary}`.
5. Add the QR code library as a dependency (use `qrcode-svg` or browser-compatible library). Install via npm.
6. The `qr_code` column in `receipts` table: populate it with the QR data string (`bookingId:seatIds`) when the receipt is created via `POST /api/agent-sales/transactions`.

**Acceptance**: After a sale, the agent can print a thermal receipt that fits 58mm or 80mm paper. The QR code is scannable and links to the e-ticket URL.

---

### P07-T3: Multi-Agent Device Session Management

**Files to modify**:
- `src/components/` — add agent selector screen
- `src/core/offline/db.ts` — extend `agent_sessions` management

**Steps**:
1. Add an agent session switcher in the POS header: "Logged in as: {agent name}" → tap to switch.
2. On "Switch Agent":
   a. Call `syncEngine.flush()` to push all pending offline data for current agent.
   b. Clear current auth token from memory.
   c. Show the agent login form (phone/OTP flow).
3. `agent_sessions` Dexie table already exists. On login, store `{ agentId, agentName, jwtToken, expiresAt, offlineGracePeriodMs: 8*3600*1000 }`.
4. `getAgentSession()` in `db.ts`: if the session has expired but is within the offline grace period AND the device is offline, return the session with a `grace_mode: true` flag. If online, force re-authentication.
5. Show a "Session in offline grace mode" banner when operating in grace mode.

**Acceptance**: Agent A can hand a device to Agent B, who logs in without losing Agent A's pending transactions (they were flushed first). Grace mode keeps agents operational for 8 hours without network for re-authentication.

---

### P07-T4: Bus Park / Terminal Management

**Files to modify**:
- `src/api/agent-sales.ts` — add park CRUD
- `src/api/operator-management.ts` — add terminal assignment to trip queries

**Steps**:
1. Add `POST /api/agent-sales/parks` (TENANT_ADMIN+): creates a `bus_parks` record.
2. Add `GET /api/agent-sales/parks` — lists parks for the operator.
3. Add `POST /api/agent-sales/parks/:id/agents` (SUPERVISOR+) — assigns agents to a park (inserts into `agent_bus_parks`).
4. Add `park_id` as an optional query param on `GET /api/agent-sales/transactions` and `GET /api/operator/trips` so park-level filtering works.
5. On agent login, if the agent has exactly one park assignment, auto-set the active park in their session. If multiple, prompt to select.
6. Add `park_id` column to `trips` table (already in migration 002): set this when a trip originates from a park.

**Acceptance**: An operator with parks in Lagos, Abuja, and Port Harcourt can assign agents to parks. Agents only see trips from their park by default.

---

### P07-T5: Passenger ID Capture at POS

**Files to modify**:
- `src/api/agent-sales.ts` — add ID fields
- Frontend sale form

**Steps**:
1. Add optional fields to `POST /api/agent-sales/transactions` body: `passenger_id_type: 'NIN'|'BVN'|'passport'|'drivers_license'`, `passenger_id_number: string`.
2. Before storing, hash `passenger_id_number` using `crypto.subtle.digest('SHA-256', ...)` — store the hex hash, not the raw number. This is NDPR-compliant.
3. Store `passenger_id_type` (un-hashed) and `passenger_id_hash` (hashed) on the transaction record.
4. Include `passenger_id_type` (not the hash) in the manifest export.
5. In the agent POS sale form, add an optional "Passenger ID" section with type dropdown and number field. Mark as optional clearly.

**Acceptance**: ID fields are optional. When provided, the ID number is never stored in plaintext — only the SHA-256 hash. The manifest shows the ID type but not the hash.

---

## Phase P08-TRANSPORT — Revenue Features

**Repo**: `webwaka-transport`  
**Blocks**: P09-TRANSPORT  
**Blocked by**: P04-TRANSPORT, P07-TRANSPORT

### P08-T1: Vehicle Seat Configuration Templates

**Files to modify**:
- `src/api/operator-management.ts` — add template field to vehicle CRUD
- `src/api/seat-inventory.ts` — apply template on trip creation

**Steps**:
1. `seat_template` is already added to `vehicles` in migration 002 as a JSON column.
2. Define the template schema:
   ```json
   {
     "rows": 14,
     "columns": 4,
     "aisle_after_column": 2,
     "seats": [
       { "number": "1A", "row": 1, "column": 1, "class": "vip" },
       { "number": "1B", "row": 1, "column": 2, "class": "standard" }
     ]
   }
   ```
3. Add `PUT /api/operator/vehicles/:id/template` (TENANT_ADMIN+) — saves the template JSON. Validate: all seat numbers unique, class values in allowed set.
4. In `POST /api/seat-inventory/trips` (trip creation), if the assigned vehicle has a `seat_template`, generate seats from the template instead of sequential integers. Each seat gets its `seat_class` from the template.
5. Return `seat_layout` in `GET /api/seat-inventory/trips/:id/availability` — the raw template object for the frontend to render a visual seat map.

**Acceptance**: A bus with a 54-seat VIP/standard template creates 54 seats with correct classes and layout when a trip is created. The availability API returns the layout for visual rendering.

---

### P08-T2: Seat Class Pricing

**Files to modify**:
- `src/api/operator-management.ts` — fare matrix on routes
- `src/api/booking-portal.ts` — apply class pricing in trip search and booking

**Steps**:
1. `fare_matrix` column is already added to `routes` in migration 002 as a JSON column.
2. Define fare matrix schema:
   ```json
   {
     "standard": 1.0,
     "window": 1.1,
     "vip": 1.5,
     "front": 1.2,
     "time_multipliers": {
       "peak_hours": [6, 7, 8, 17, 18, 19],
       "peak_multiplier": 1.2,
       "peak_days": [5, 6],
       "peak_day_multiplier": 1.3
     }
   }
   ```
3. In `GET /api/booking/trips/search`, compute `effective_fare` for each trip by applying the matrix: `base_fare × class_multiplier × time_multiplier`.
4. Return `seat_class_prices: { standard: N, window: N, vip: N }` in the search result for each trip.
5. In `POST /api/booking/bookings`, validate that `total_amount_kobo` matches the sum of `effective_fare` for the selected seats and their classes. Allow ±1% tolerance for rounding. Return 422 if outside tolerance.
6. Add `PUT /api/operator/routes/:id/fare-matrix` (TENANT_ADMIN+) — saves the fare matrix JSON.

**Acceptance**: A VIP seat on a route with a 1.5× multiplier costs 50% more than a standard seat. The booking portal shows the class-specific price before the customer selects their seat.

---

### P08-T3: Cancellation Policy with Automated Refund

**Files to modify**:
- `src/api/booking-portal.ts` — `PATCH /api/booking/bookings/:id/cancel` endpoint
- `src/lib/payments.ts` — add Paystack Refund API call

**Steps**:
1. `cancellation_policy` is in operator config (P04-T1): `{ free_before_hours: 24, half_refund_before_hours: 12 }`.
2. On `PATCH /api/booking/bookings/:id/cancel`:
   a. Check time until departure: `departure_time - Date.now()`.
   b. Compute refund amount:
      - > `free_before_hours × 3600000`: full refund
      - > `half_refund_before_hours × 3600000`: 50% refund
      - ≤ `half_refund_before_hours × 3600000`: no refund
   c. Release seats (already done).
   d. If `refund_amount_kobo > 0` and `payment_status = 'completed'` and `payment_method IN ('paystack', 'flutterwave')`:
      - Call Paystack Refunds API: `POST https://api.paystack.co/refund` with `{ transaction: payment_reference, amount: refund_amount_kobo }`.
      - Store `refund_reference` and `refund_amount_kobo` on the booking record.
      - Publish `booking:REFUNDED` event.
   e. If payment was cash or bank transfer: record refund as `manual_refund_required: true` on the booking for operator manual processing.
3. Add `refund_reference TEXT, refund_amount_kobo INTEGER, manual_refund_required INTEGER` columns to `bookings` (migration 003).

**Acceptance**: Cancelling 25 hours before departure triggers a full Paystack refund. Cancelling 8 hours before triggers a 50% refund. The booking record shows the refund reference. Manual cash refunds are flagged for operator follow-up.

---

### P08-T4: Waiting List with Auto-Assignment

**Files to modify**:
- `src/api/booking-portal.ts` — add waiting list join endpoint
- `src/lib/sweepers.ts` — waiting list notification in seat release handlers

**Steps**:
1. Add `POST /api/booking/trips/:id/waitlist` (authenticated customer):
   - Request: `{ seat_class: string }`
   - Check trip is fully booked (no `available` seats of requested class)
   - Insert into `waiting_list` with `position = (SELECT COALESCE(MAX(position), 0) + 1 FROM waiting_list WHERE trip_id = ?)`
   - Return waiting list position and estimated wait based on typical cancellation rate (static message is fine)
2. In `sweepExpiredReservations()` and the cancel endpoint, after releasing a seat: query the waiting list for the trip, notify the first customer in queue:
   - SMS: "A seat is now available on your waitlisted trip {route} on {date}. You have 10 minutes to book: {url}"
   - Set `notified_at = Date.now()` and `expires_at = Date.now() + 10 * 60 * 1000` on the waiting list entry
   - The notified customer gets priority on the next reservation (the URL pre-selects their seat class)
3. Add `GET /api/booking/waitlist` — customer's active waiting list entries.
4. Add `DELETE /api/booking/trips/:id/waitlist` — customer removes themselves from the list.

**Acceptance**: When a seat opens on a fully booked trip, the first waiting customer receives an SMS within one cron cycle and has a 10-minute priority window to complete booking.

---

### P08-T5: Group Booking Workflow for Agents

**Files to modify**:
- `src/api/agent-sales.ts` — add group booking endpoint
- Frontend agent POS — group booking mode

**Steps**:
1. Add `POST /api/agent-sales/group-bookings`:
   - Request: `{ trip_id, seat_count, group_name, leader_name, leader_phone, seat_class: 'standard'|'vip', payment_method }`
   - Atomically reserve `seat_count` available seats of the requested class using the same batch logic as S-01 (P02-T2)
   - Create one `bookings` record with `passenger_names = Array(seat_count).fill(group_name)` and a `group_booking_id` reference
   - Create individual `sales_transactions` per seat
   - Return group booking summary with all seat numbers and one combined receipt
2. Add `GET /api/agent-sales/group-bookings/:id` — group booking detail.
3. Frontend: add "Group Booking" button to POS. Opens a simplified form: trip, passenger count, group name, leader contact, class, payment method.
4. After group booking, show a combined receipt that can be printed (all passengers listed) or shared via WhatsApp.

**Acceptance**: An agent can book 20 seats for a church group in one action. All 20 seats are atomically reserved. One combined receipt is generated. The manifest shows all 20 passengers under the group name.

---

## Phase P09-TRANSPORT — Fleet and Compliance

**Repo**: `webwaka-transport`  
**Blocks**: P10-TRANSPORT  
**Blocked by**: P05-TRANSPORT, P08-TRANSPORT

### P09-T1: Vehicle Maintenance Tracking

**Files to modify**:
- `src/api/operator-management.ts` — add maintenance endpoints

**Steps**:
1. Add `POST /api/operator/vehicles/:id/maintenance` (TENANT_ADMIN+):
   - Body: `{ service_type, service_date_ms, next_service_due_ms, notes }`
   - Insert into `vehicle_maintenance_records`
   - If `next_service_due_ms < Date.now() + 7*86400*1000`, immediately publish `vehicle.maintenance_due_soon` event
2. Add `GET /api/operator/vehicles/:id/maintenance` — maintenance history list.
3. Add cron sweeper `sweepVehicleMaintenanceDue(env)` in `sweepers.ts`:
   - Daily: query vehicles where `next_service_due` is within 7 days and not already notified today
   - Publish `vehicle.maintenance_due_soon` event for each
   - `drainEventBus()` handler: SMS to TENANT_ADMIN emergency contact
4. Add `POST /api/operator/vehicles/:id/documents` and `GET /api/operator/vehicles/:id/documents` — manage vehicle compliance documents (roadworthiness, insurance, FRSC).
5. `sweepVehicleDocumentExpiry(env)` — daily: check docs expiring within 30 days, publish `vehicle.document_expiring` event.
6. In trip assignment (driver assignment endpoint), check if vehicle has any expired documents. If yes, return 422 with `{ error: 'vehicle_compliance_expired', doc_type }`.

**Acceptance**: An operator is notified 7 days before a vehicle needs service and 30 days before a compliance document expires. A bus with an expired roadworthiness certificate cannot be assigned to a trip.

---

### P09-T2: Driver Document Management

**Files to modify**:
- `src/api/operator-management.ts` — add driver document endpoints

**Steps**:
1. Add `POST /api/operator/drivers/:id/documents` (TENANT_ADMIN+):
   - Body: `{ doc_type: 'drivers_license'|'frsc_cert'|'medical_cert', doc_number, license_category, issued_at_ms, expires_at_ms }`
   - Insert into `driver_documents`
2. Add `GET /api/operator/drivers/:id/documents` — document list with expiry status.
3. `sweepDriverDocumentExpiry(env)` — daily: flag expired/expiring-soon driver documents, publish `driver.document_expiring` event.
4. In the driver assignment endpoint (`PATCH /api/operator/trips/:id`), check that the driver has a valid, non-expired `drivers_license` before allowing assignment. Return 422 if expired.
5. Surface document expiry warnings in the operator notification center.

**Acceptance**: A driver with an expired license cannot be assigned to a trip. The operator is notified 30 days before expiry.

---

### P09-T3: Operator Notification Center

**Files to modify**:
- `src/api/operator-management.ts` — add notifications endpoint
- Frontend operator dashboard — add notification panel

**Steps**:
1. Add `GET /api/operator/notifications` (TENANT_ADMIN+):
   - Query `platform_events` filtered by `tenant_id = operator.id` and `created_at > Date.now() - 7*86400*1000`
   - Filter to actionable event types: `trip:SOS_ACTIVATED`, `agent.reconciliation_filed`, `vehicle.maintenance_due_soon`, `vehicle.document_expiring`, `driver.document_expiring`, `booking:ABANDONED`, `payment:AMOUNT_MISMATCH`, `trip:DELAYED`
   - Return events with `read_at` status per user
2. Add `POST /api/operator/notifications/:eventId/read` — marks an event as read for the current user.
3. Add a notification badge to the operator dashboard header showing unread count.
4. Add a notification panel (slide-in or dropdown) listing recent notifications with action links.
5. SOS notifications are shown as a persistent red banner that cannot be dismissed until the SOS is cleared.

**Acceptance**: Operators see a live notification badge for actionable events. SOS notifications are prominent and persistent. Notification count updates on each API poll (30-second interval).

---

## Phase P10-TRANSPORT — Real-Time Infrastructure and Analytics

**Repo**: `webwaka-transport`  
**Blocks**: P11-TRANSPORT  
**Blocked by**: P05-TRANSPORT, P09-TRANSPORT

### P10-T1: SSE Seat Availability Feed

**Files to modify**:
- `src/api/seat-inventory.ts` — add SSE endpoint
- `src/lib/sweepers.ts` — fan-out mechanism

**Steps**:
1. Add `GET /api/seat-inventory/trips/:id/live` SSE endpoint:
   - Set headers: `Content-Type: text/event-stream`, `Cache-Control: no-cache`, `Connection: keep-alive`
   - Return a `ReadableStream` using Cloudflare Workers streaming
   - Poll the `SEAT_CACHE_KV` entry for the trip every 5 seconds
   - When a change is detected (by comparing a hash of the seat states), push an SSE event: `data: {changed_seats: [{id, status, seat_number}]}\n\n`
   - Keep connection alive with a comment ping every 30 seconds: `: ping\n\n`
   - Enforce a 5-minute maximum connection lifetime (Cloudflare Worker streaming limit)
2. The KV cache is updated by existing seat mutation endpoints (already wired in `drainEventBus()`).
3. In the booking portal's seat selection component, open an EventSource to the SSE URL. On `message` event, update local seat state in React without a full re-render. Show "Just taken" animation when a seat transitions to reserved/confirmed.

**Acceptance**: Two browsers have the seat map open. Browser A reserves a seat. Within 10 seconds, Browser B sees that seat marked as reserved without refreshing.

---

### P10-T2: Dispatcher Dashboard

**Files to modify**:
- `src/api/operator-management.ts` — add dispatcher query endpoint
- Frontend — new dispatcher dashboard view

**Steps**:
1. Add `GET /api/operator/dispatch` (SUPERVISOR role+):
   - Returns all active trips (`state IN ('scheduled', 'boarding', 'in_transit')`) for the operator
   - Each trip includes: state, route, departure_time, vehicle plate, driver name, confirmed_count, boarded_count, sos_active, current_lat/lng, delay_reported_at, estimated_departure_ms
   - Sorted by departure_time ascending
2. Frontend dispatcher dashboard:
   - Card grid or table view of active trips
   - Color coding: green=on_time, yellow=delayed, red=sos_active
   - Each card shows: route, departure time, boarding progress (e.g. "18/45 boarded"), SOS indicator
   - "View Manifest" and "File Delay" quick actions
   - Auto-refreshes every 30 seconds (simple polling — no SSE needed for dispatcher)
   - Filter by park if O-01 is implemented

**Acceptance**: A dispatcher sees all active trips at a glance. Trips with SOS active are prominently highlighted in red. Delay status is visible per trip.

---

### P10-T3: Booking Reminder Cron Sweeper

**Files to modify**:
- `src/lib/sweepers.ts` — add `sweepBookingReminders(env)` function
- `src/worker.ts` — wire to minute cron
- `migrations/` — add reminder tracking columns

**Steps**:
1. Add `reminder_24h_sent_at INTEGER, reminder_2h_sent_at INTEGER` to `bookings` table (migration 003).
2. Add `sweepBookingReminders(env)` to `sweepers.ts`:
   - Query confirmed bookings where `departure_time BETWEEN now+23h AND now+25h AND reminder_24h_sent_at IS NULL`:
     - Send SMS: "WebWaka reminder: Your trip {route} departs tomorrow at {time}. Seat: {seats}. See ticket: {url}"
     - `UPDATE bookings SET reminder_24h_sent_at = ? WHERE id = ?`
   - Query confirmed bookings where `departure_time BETWEEN now+1.75h AND now+2.25h AND reminder_2h_sent_at IS NULL`:
     - Send SMS: "WebWaka: Your bus departs in ~2 hours! {route} from {park_name}. Board by {boarding_cutoff}."
     - `UPDATE bookings SET reminder_2h_sent_at = ? WHERE id = ?`
3. Wire `sweepBookingReminders` into the minute cron in `worker.ts`.
4. Both reminder sends are non-fatal. Log failures, do not retry beyond 3 attempts.

**Acceptance**: Every confirmed booking receives an SMS reminder ~24 hours before departure and another ~2 hours before departure. No booking receives the same reminder twice.

---

### P10-T4: Revenue Per Route Analytics

**Files to modify**:
- `src/api/operator-management.ts` — extend reports endpoint

**Steps**:
1. Extend `GET /api/operator/reports` with a `?groupby=route` query param.
2. When `groupby=route`, return:
   ```json
   [{
     "route_id": "...",
     "route_name": "Lagos → Abuja",
     "total_trips": 45,
     "total_seats": 2025,
     "confirmed_seats": 1847,
     "fill_rate_pct": 91.2,
     "gross_revenue_kobo": 4250000000,
     "refunds_kobo": 125000000,
     "net_revenue_kobo": 4125000000,
     "avg_fare_kobo": 2302000
   }]
   ```
3. Add date range filters: `?from=2026-01-01&to=2026-03-31`.
4. Add `groupby=vehicle` and `groupby=driver` as additional options.
5. SUPER_ADMIN gets `groupby=operator` which aggregates across all operators.

**Acceptance**: The operator can see revenue per route for any date range. The SUPER_ADMIN can see revenue aggregated across all operators.

---

### P10-T5: SUPER_ADMIN Cross-Tenant Analytics Dashboard

**Files to modify**:
- `src/api/admin.ts` — add analytics endpoint
- Frontend — SUPER_ADMIN analytics view

**Steps**:
1. Add `GET /api/internal/admin/analytics` (SUPER_ADMIN only):
   - Total operators (active/suspended)
   - Total trips by state (today, this week, this month)
   - Total bookings by status (today, this week, this month)
   - Total gross revenue (this month, all time) in kobo
   - Top 10 routes by booking count
   - Top 10 operators by revenue
   - Platform event bus health (pending count, dead count)
2. Build a SUPER_ADMIN analytics section in the operator dashboard (only visible to SUPER_ADMIN role).

**Acceptance**: SUPER_ADMIN can see platform-wide metrics. The dashboard loads in under 2 seconds (queries are aggregate-optimized).

---

## Phase P11-TRANSPORT — Operator Management and Platform Features

**Repo**: `webwaka-transport`  
**Blocks**: P12-LOGISTICS, P14-CORE  
**Blocked by**: P10-TRANSPORT

### P11-T1: Operator API Keys

**Files to modify**:
- `src/api/operator-management.ts` — add API key CRUD

**Steps**:
1. Add `POST /api/operator/api-keys` (TENANT_ADMIN only):
   - Body: `{ name: string, scope: 'read'|'read_write' }`
   - Generate a random API key: `waka_live_{nanoid('', 32)}`
   - Hash it: `SHA-256(key)` → store as `key_hash`
   - Insert into `api_keys` table
   - Return the raw key ONCE (never stored; warn user to copy it)
2. Add `GET /api/operator/api-keys` — lists key metadata (name, scope, created_at, last_used_at) without the key value.
3. Add `DELETE /api/operator/api-keys/:id` — sets `revoked_at = Date.now()`.
4. The `verifyApiKey` function added to `@webwaka/core` in P01-T4 is now fully functional with the `api_keys` table.
5. On each valid API key auth, update `last_used_at` (async, non-blocking).

**Acceptance**: An operator generates an API key. Using `Authorization: ApiKey waka_live_{key}` in any API request authenticates as that operator. Revoking a key immediately invalidates it.

---

### P11-T2: Operator Onboarding Wizard

**Files to modify**:
- Frontend — new multi-step onboarding wizard component

**Steps**:
1. Detect new operator accounts with no routes, vehicles, or trips on first login.
2. Show a wizard with steps:
   - Step 1 (Operator Profile): company name, address, CAC registration number, contact phone, FIRS TIN, logo upload URL
   - Step 2 (Add Vehicles): vehicle form (make, model, year, plate, capacity). Allow "Add Another". Each saved via `POST /api/operator/vehicles`.
   - Step 3 (Add Routes): route form (origin, destination, base fare, duration). Allow multiple. Each via `POST /api/operator/routes`.
   - Step 4 (Seat Templates): optionally configure seat layout for each vehicle (link to template form from P08-T1).
   - Step 5 (Add Drivers): driver form (name, phone, license number). Allow multiple. Each via `POST /api/operator/drivers`.
   - Step 6 (Add Agents): agent form (name, phone, bus park). Allow multiple. Each via `POST /api/agent-sales/agents`.
   - Step 7 (Create First Trip): simplified trip creation using the routes and vehicles just added. Calls `POST /api/seat-inventory/trips`.
3. Progress is saved per step in `localStorage`. Incomplete wizards resume from last step.
4. On completion, show a success screen with a link to the dispatcher dashboard.

**Acceptance**: A new operator can go from account creation to first published trip in under 30 minutes using the wizard.

---

### P11-T3: Route Stop Management (Multi-Stop Routes)

**Files to modify**:
- `src/api/operator-management.ts` — add route stops CRUD
- `src/api/booking-portal.ts` — expose stops in trip search

**Steps**:
1. Add `POST /api/operator/routes/:id/stops` (TENANT_ADMIN+) — creates route stops. Body: `{ stops: [{stop_name, sequence, distance_from_origin_km, fare_from_origin_kobo}] }`. Inserts all stops atomically (D1 batch).
2. Add `GET /api/operator/routes/:id/stops` — returns ordered stop list.
3. In trip search (`GET /api/booking/trips/search`), add `origin_stop`, `destination_stop` query params. If provided, filter trips by those stops being on the route.
4. In `POST /api/booking/bookings`, allow `origin_stop_id` and `destination_stop_id` fields. Compute fare as `route_stop.fare_from_origin_kobo[destination] - route_stop.fare_from_origin_kobo[origin]`.

**Acceptance**: An operator can define stops on a Lagos→Abuja route (Lagos, Ibadan, Ogbomosho, Ilorin, Abuja). Passengers can book Lagos→Ilorin at the partial fare and board at Lagos, alighting at Ilorin.

---

## Phase P12-LOGISTICS — Transport-Logistics Integration

**Repo**: `webwaka-logistics`  
**Blocks**: P13-TRANSPORT  
**Blocked by**: P11-TRANSPORT (must be fully deployed first)

### P12-T1: Subscribe to Transport Parcel Events

**Files to create/modify**:
- `src/api/transport-integration.ts` — new file in logistics repo
- `wrangler.toml` in logistics repo — add event consumer binding

**Steps**:
1. In the logistics repo, create a webhook endpoint `POST /internal/transport-events`:
   - Accepts inbound events forwarded by the transport repo's `deliverToConsumer` call in `drainEventBus()`
   - Validates `X-Webwaka-Event-Type` header and a shared HMAC secret
   - Handles `parcel.waybill_created` event: creates a parcel record in the logistics DB from the waybill payload
   - Handles `trip.state_changed` event for `in_transit`/`completed`: updates parcel status on the linked trip's waybills to `in_transit` / `delivered`
2. Register this endpoint URL in the transport repo's `deliverEvent()` function under `parcel.*` event routing (replace the hardcoded `https://logistics.webwaka.app/api/internal/events` with the real URL from an env var).
3. The event authentication shared secret is stored as a Worker secret in both repos: `INTER_SERVICE_SECRET`.

**Acceptance**: When the transport repo publishes a `parcel.waybill_created` event, the logistics repo creates a parcel record automatically. When the trip transitions to `completed`, the parcel is marked delivered.

---

### P12-T2: Publish Parcel Seat Requirement Events from Logistics Repo

**Files to modify**:
- Logistics repo parcel creation flow
- `src/lib/sweepers.ts` in transport repo — add `parcel.seats_required` event handler

**Steps**:
1. In the logistics repo, when a parcel is confirmed for shipment on a specific trip ID, publish `parcel.seats_required` event to the transport endpoint:
   - Payload: `{ trip_id, seats_needed: number, parcel_id, weight_kg, declared_value_kobo }`
   - Call `POST /api/internal/transport-events` in the transport repo with this event
2. In the transport repo, add `parcel.seats_required` handler in `drainEventBus()`:
   - Call the seat block endpoint (S-08 / P-MISC) to block `seats_needed` seats as `blocked` with `reason: 'parcel_cargo'`
   - Publish `parcel.seats_confirmed` or `parcel.seats_unavailable` back to the logistics service

**Acceptance**: When logistics confirms a parcel on a trip, cargo seats are automatically blocked on that trip. The seat map shows these as unavailable to passengers.

---

## Phase P13-TRANSPORT — Channel Expansion

**Repo**: `webwaka-transport`  
**Blocks**: P15-TRANSPORT  
**Blocked by**: P12-LOGISTICS

### P13-T1: WhatsApp Receipt Sharing (Frontend-Only)

**Files to modify**:
- Receipt component (from P07-T2)
- E-ticket component (from P03-T5)

**Steps**:
1. Add a "Share via WhatsApp" button to both the receipt component and the e-ticket page.
2. The button constructs a WhatsApp deep link:
   ```
   wa.me/?text=WebWaka+Booking+Confirmed!%0A
   Route:+{origin}+→+{destination}%0A
   Date:+{departure_date}%0A
   Seat:+{seat_numbers}%0A
   Passenger:+{passenger_name}%0A
   Ref:+{short_booking_id}%0A
   View+ticket:+https://webwaka.ng/b/{booking_id}
   ```
3. On mobile, this opens WhatsApp directly. On desktop, it opens the WhatsApp web interface.
4. No WhatsApp Business API account needed — this is a standard `wa.me` link.

**Acceptance**: Tapping "Share via WhatsApp" on the receipt or e-ticket opens WhatsApp with the message pre-filled. No backend changes required.

---

### P13-T2: Operator Reviews and Ratings

**Files to modify**:
- `src/api/booking-portal.ts` — add review endpoints
- `src/lib/sweepers.ts` — add post-trip review prompt

**Steps**:
1. Add `POST /api/booking/reviews` (authenticated CUSTOMER role):
   - Body: `{ booking_id, rating (1-5), review_text }`
   - Validate: booking must be for the authenticated customer, trip must be `completed`, no existing review for this booking
   - Insert into `operator_reviews`
2. Add `GET /api/booking/operators/:id/reviews` (public) — returns average rating and paginated reviews.
3. Add average rating to trip search results: `SELECT AVG(r.rating) as avg_rating FROM operator_reviews r WHERE r.operator_id = ?`.
4. In `drainEventBus()`, add `trip.state_changed` → `completed` handler:
   - Fetch all confirmed bookings for the trip.
   - For each, send SMS: "WebWaka: How was your journey? Rate your trip on {url}. Takes 10 seconds." (only once per booking, non-fatal).
5. `review_prompt_sent_at` column on bookings (migration 003).

**Acceptance**: After a trip completes, passengers receive an SMS review prompt. Submitted ratings are averaged and shown on trip search results.

---

### P13-T3: Full i18n Completion (Yoruba, Igbo, Hausa)

**Files to modify**:
- `src/core/i18n/index.ts` — fill in missing translation strings

**Steps**:
1. Audit all translation keys in `src/core/i18n/index.ts`. Identify any key where Yoruba, Igbo, or Hausa translation is missing, empty, or is a copy of the English string.
2. Write complete translations for all user-facing strings in the booking flow:
   - Route search form labels and placeholders
   - Seat selection instructions and status labels
   - Payment flow instructions
   - Booking confirmation messages
   - Error messages (seat unavailable, payment failed, session expired)
   - Receipt labels
   - E-ticket labels
3. Auto-detect language from `navigator.language`. Map `yo` → Yoruba, `ig` → Igbo, `ha` → Hausa.
4. Add a manual language selector dropdown in the booking portal header.

**Acceptance**: Setting the browser language to Yoruba renders the entire booking flow in Yoruba. All user-facing strings (not internal system messages) are translated.

---

## Phase P14-CORE — Platform Maturity Features

**Repo**: `@webwaka/core`  
**Blocks**: P15-TRANSPORT  
**Blocked by**: P11-TRANSPORT (API key infrastructure must be deployed first)  
**Can run in parallel with P13-TRANSPORT**

### P14-T1: Subscription Tier Feature Gating

**Files to modify**:
- `packages/core/src/index.ts` — add `requireTierFeature` middleware

**Steps**:
1. Define subscription tiers and feature entitlements in core:
   ```typescript
   const TIER_FEATURES: Record<string, string[]> = {
     basic:        ['seat_inventory', 'agent_sales', 'basic_booking', 'manual_schedule'],
     professional: ['ai_search', 'dynamic_pricing', 'waiting_list', 'api_keys', 'analytics', 'auto_schedule', 'sms_notifications'],
     enterprise:   ['white_label', 'multi_park', 'interline', 'corporate_portal', 'custom_domain'],
   };
   ```
2. Add `requireTierFeature(feature: string)` Hono middleware that:
   - Reads `operator.subscription_tier` from the tenant context
   - Checks if the feature is in the tier's feature list
   - Returns 402 Payment Required if not: `{ error: 'feature_not_available', upgrade_url: 'https://webwaka.ng/pricing' }`
3. Export `requireTierFeature` from the core package.
4. In `webwaka-transport`, wrap feature-gated endpoints with `requireTierFeature('ai_search')` etc.
5. Add `subscription_tier TEXT NOT NULL DEFAULT 'basic'` to the `operators` table (migration 003 in transport).

**Acceptance**: An operator on the `basic` tier who calls `POST /api/booking/trips/ai-search` receives a 402 response. Upgrading the tier in the operator record immediately grants access.

---

## Phase P15-TRANSPORT — Scale, Monetization, and Final Features

**Repo**: `webwaka-transport`  
**Blocked by**: P14-CORE, P13-TRANSPORT

### P15-T1: Durable Objects Real-Time Seat Updates (Upgrade from SSE)

**Files to modify**:
- `src/worker.ts` — add Durable Object binding and WebSocket upgrade handler
- New file: `src/durables/trip-seat-do.ts`
- `wrangler.toml` — add Durable Object class binding

**Steps**:
1. Create `src/durables/trip-seat-do.ts`:
   - Implements `DurableObject` class `TripSeatDO`
   - `fetch(request)`: accepts WebSocket upgrade → stores connection → returns 101
   - `onMessage(conn, message)`: handles `{type: 'seat_changed', seat}` messages → broadcasts to all connections
   - `alarm()`: clean up stale connections every 5 minutes
2. Register `TripSeatDO` in `wrangler.toml` under `[durable_objects]`.
3. In seat mutation endpoints (reserve, confirm, release, reserve-batch), after the D1 write, get or create the DO stub for `trip_id` and send a `seat_changed` broadcast message.
4. Add `GET /api/seat-inventory/trips/:id/ws` endpoint that upgrades to WebSocket using the DO stub.
5. In the booking portal frontend, replace the SSE `EventSource` with a `WebSocket` connection to the `/ws` endpoint. Fall back to SSE polling if WebSocket fails.
6. Decommission the SSE endpoint from P10-T1 (or keep as fallback for older browsers).

**Acceptance**: Two browser tabs on the seat selection screen for the same trip share live seat state via WebSocket with < 500ms propagation delay. No polling required.

---

### P15-T2: Corporate Travel Portal

**Files to modify**:
- `src/api/booking-portal.ts` — add corporate customer type
- Frontend — corporate portal view

**Steps**:
1. Add `customer_type TEXT NOT NULL DEFAULT 'individual'` and `credit_limit_kobo INTEGER DEFAULT 0` to `customers` table (migration 003).
2. Add `POST /api/booking/corporate-accounts` (TENANT_ADMIN+) — creates a corporate customer with a credit limit.
3. Corporate customers can create bookings with `payment_method: 'credit'` — the total is deducted from the credit balance.
4. Add `GET /api/booking/corporate-accounts/:id/statement` — lists all bookings charged against the corporate account, with invoice-ready formatting.
5. Add "Generate Invoice" action that produces a printable invoice (browser print) with all trips in a selected date range, total amount, VAT, and payment instructions.
6. Corporate portal view in the frontend: shows upcoming trips, booking history, credit balance, and invoice generator.

**Acceptance**: A corporate account with ₦5,000,000 credit can book seats that are charged to the credit balance. The accounting department can generate a monthly invoice for FIRS submission.

---

### P15-T3: White-Label Operator Portal

**Files to modify**:
- `src/app.tsx` — apply branding CSS variables on load
- `src/api/operator-management.ts` — add branding config endpoints
- `wrangler.toml` — add R2 bucket binding for logo storage

**Steps**:
1. Add `branding` JSON field to operator config (P04-T1): `{ logo_url, primary_color, secondary_color, display_name }`.
2. Add `PUT /api/operator/config/branding` (TENANT_ADMIN+) — saves branding config.
3. Add `POST /api/operator/config/logo` — accepts a multipart upload and stores the logo in Cloudflare R2, returns the public URL.
4. On booking portal load: fetch operator config (from the subdomain or an `operator_id` query param), apply CSS variables: `--primary: {primary_color}`, `--secondary: {secondary_color}`, set `<title>` and `<link rel="icon">` from branding config.
5. If no branding is configured, use WebWaka default branding.
6. Add R2 binding to `wrangler.toml`.

**Acceptance**: An operator with custom branding on their subdomain sees their logo and brand colors throughout the booking portal. WebWaka branding is absent from their whitelabeled portal.

---

### P15-T4: Bulk Route and Vehicle Import (CSV)

**Files to modify**:
- `src/api/operator-management.ts` — add import endpoints

**Steps**:
1. Add `POST /api/operator/import/routes` (TENANT_ADMIN+):
   - Accepts `multipart/form-data` with a CSV file
   - CSV columns: `origin,destination,base_fare_naira,duration_minutes,distance_km`
   - Parse CSV line by line (simple custom parser — no library needed for this schema)
   - For each valid row: create a route record
   - Return: `{ created: N, skipped: N, errors: [{row, reason}] }`
2. Add `POST /api/operator/import/vehicles` — CSV: `plate_number,make,model,year,capacity,vehicle_type`
3. Add `POST /api/operator/import/drivers` — CSV: `name,phone,license_number,license_category`
4. Limit: 500 rows per import. Rows above 500 are ignored with a warning.
5. The import is transactional at the row level — a failed row does not block subsequent rows.

**Acceptance**: An operator with 50 routes can import them via CSV in under 60 seconds. The response clearly shows which rows succeeded and which failed, with the reason for each failure.

---

## Migration Tracking

| Migration File | Tables Created/Modified | Introduced In |
|---|---|---|
| `001_transport_schema.sql` | All original tables | Initial |
| `002_phase2_tables.sql` | 15 new tables, 12 new columns | P02-T3 |
| `003_phase3_columns.sql` | `refund_*` on bookings, `reminder_*` on bookings, `review_prompt_sent_at`, `delay_*` on trips, `location_updated_at` on trips, `subscription_tier` on operators, `inspection_required_before_boarding` context | P08-T3 and later |

---

## RBAC Reference

| Role | Capabilities |
|---|---|
| `SUPER_ADMIN` | All operations across all tenants. Cross-tenant analytics. Operator suspension. |
| `TENANT_ADMIN` | Full operator management within their tenant. Config, branding, compliance. |
| `SUPERVISOR` | Agent management, delay reports, SOS clear, reconciliation approval, dispatch dashboard. |
| `STAFF` | Boarding scan, manifest view, basic trip operations. |
| `AGENT` | POS sales, offline sync, reconciliation filing. |
| `DRIVER` | Own trip detail, GPS update, SOS trigger, inspection submission, expense recording. |
| `CUSTOMER` | Booking creation, booking view, review submission, waitlist. |

---

## Environment Variables / Secrets Reference

| Variable | Where | Purpose |
|---|---|---|
| `JWT_SECRET` | Worker secret | JWT signing key |
| `PAYSTACK_SECRET_KEY` | Worker secret | Paystack API authentication |
| `PAYSTACK_PUBLIC_KEY` | Env var (public) | Paystack inline popup |
| `FLUTTERWAVE_SECRET_KEY` | Worker secret | Flutterwave webhook verification |
| `OPENROUTER_API_KEY` | Worker secret | AI natural language search |
| `TERMII_API_KEY` | Worker secret | SMS delivery |
| `INTER_SERVICE_SECRET` | Worker secret (both repos) | Transport ↔ Logistics event auth |
| `SENDGRID_API_KEY` | Worker secret (optional) | Email notifications |
| `PAYSTACK_WEBHOOK_SECRET` | Worker secret | Paystack webhook signature verification |
| `FLUTTERWAVE_WEBHOOK_SECRET` | Worker secret | Flutterwave webhook verification |

---

## Dependency Summary Table (All Phases)

| Phase | Repo | Blocked By | Blocks |
|---|---|---|---|
| P01-CORE | `@webwaka/core` | — | P02, P04 |
| P02-TRANSPORT | `webwaka-transport` | P01-CORE | P03 |
| P03-TRANSPORT | `webwaka-transport` | P02 | P05 (partial) |
| P04-TRANSPORT | `webwaka-transport` | P01-CORE | P05, P07, P08 |
| P05-TRANSPORT | `webwaka-transport` | P02, P04 | P06, P09 |
| P06-TRANSPORT | `webwaka-transport` | P05 | P09 (partial) |
| P07-TRANSPORT | `webwaka-transport` | P04 | P08 |
| P08-TRANSPORT | `webwaka-transport` | P04, P07 | P09 |
| P09-TRANSPORT | `webwaka-transport` | P05, P08 | P10 |
| P10-TRANSPORT | `webwaka-transport` | P05, P09 | P11 |
| P11-TRANSPORT | `webwaka-transport` | P10 | P12, P14 |
| P12-LOGISTICS | `webwaka-logistics` | P11 | P13 |
| P13-TRANSPORT | `webwaka-transport` | P12 | P15 |
| P14-CORE | `@webwaka/core` | P11 | P15 |
| P15-TRANSPORT | `webwaka-transport` | P13, P14 | — |
