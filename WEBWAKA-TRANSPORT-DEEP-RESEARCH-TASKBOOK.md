# WEBWAKA-TRANSPORT DEEP RESEARCH + ENHANCEMENT TASKBOOK + QA PROMPT FACTORY

> **Repo**: `webwaka-transport`
> **Date**: April 4, 2026
> **Prepared by**: Platform Research & Architecture Analysis
> **Scope**: Full deep-dive of the webwaka-transport repository — codebase understanding, external best-practice research, synthesis, top 20 enhancements + bug fixes, detailed task breakdowns, QA plans, and copy-paste implementation + QA prompt pairs for every task.
> **Important Ecosystem Note**: This repository is **not standalone**. It is one vertical module of the WebWaka OS v4 multi-repo platform. It shares `@webwaka/core`, emits events to the platform event bus, and depends on the logistics, fintech, central management, notifications, and AI repos. Every task in this document must be implemented with full cross-repo awareness. Replit agents implementing from this document may only write code within this repository, but must respect all shared contracts, event schemas, and platform invariants.

---

## Table of Contents

1. [Repo Deep Understanding](#1-repo-deep-understanding)
2. [External Best-Practice Research](#2-external-best-practice-research)
3. [Synthesis and Gap Analysis](#3-synthesis-and-gap-analysis)
4. [Top 20 Enhancements](#4-top-20-enhancements)
5. [Bug Fix Recommendations](#5-bug-fix-recommendations)
6. [Task Breakdown with QA Plans and Prompt Pairs](#6-task-breakdown)
7. [Priority Order](#7-priority-order)
8. [Phase 1 / Phase 2 Split](#8-phase-split)
9. [Repo Context and Ecosystem Notes](#9-ecosystem-notes)
10. [Governance and Reminder Block](#10-governance-and-reminders)
11. [Execution Readiness Notes](#11-execution-readiness)

---

## 1. Repo Deep Understanding

### 1.1 Repository Identity

**Name**: `webwaka-transport`
**Purpose**: The intercity bus transport vertical of WebWaka OS v4. Covers seat inventory management (TRN-1), agent/POS offline sales (TRN-2), customer booking portal (TRN-3), and operator fleet management (TRN-4).
**Runtime**: Cloudflare Workers (Hono framework)
**Database**: Cloudflare D1 (SQLite), Cloudflare KV (4 namespaces), Cloudflare R2, Cloudflare Durable Objects
**Frontend**: React 19 + Vite + TypeScript PWA
**Offline**: Dexie.js (IndexedDB) with SyncEngine + Service Worker
**Shared Core**: `@webwaka/core` package (local alias in `packages/core/src/index.ts`)

### 1.2 Module Inventory

#### TRN-1: Seat Inventory (`src/api/seat-inventory.ts`)
- Atomic seat reservation with 30-second TTL tokens
- Version-stamped rows for optimistic concurrency
- `TripSeatDO` Durable Object for WebSocket fan-out and batch reservation serialization
- Routes: `GET /trips`, `POST /trips`, `GET /trips/:id/availability`, `POST /trips/:id/reserve`, `POST /trips/:tripId/reserve-batch`, `POST /trips/:tripId/extend-hold`
- **Gap**: Single-seat reserve still exists alongside batch; extend-hold is best-effort only; SSE endpoint documented but DO WebSocket not fully wired for booking portal clients
- In-memory domain model (`src/core/seat-inventory/index.ts`) diverges from D1 logic — no shared interface

#### TRN-2: Agent Sales / POS (`src/api/agent-sales.ts`)
- Offline-first cash/mobile POS for bus park agents
- Three-phase SyncEngine: mutations → transactions → tickets
- Idempotency keys via `IDEMPOTENCY_KV`
- Agent session caching with 8-hour grace period in Dexie
- Routes: `GET/POST /agents`, `PATCH /agents/:id`, `POST /transactions`, `GET /transactions`, `POST /sync`, `GET /dashboard`
- **Gap**: `getPendingTransactions()` is not called by SyncEngine automatically — agents must wait for Service Worker background sync or manually trigger. No float reconciliation workflow. Agent multi-session / fast-switch not implemented.

#### TRN-3: Booking Portal (`src/api/booking-portal.ts`)
- Public trip search + NDPR-gated booking
- Paystack Inline + Flutterwave payment integration
- AI natural language trip search via OpenRouter (rate-limited 5 req/10min/IP)
- Abandoned booking sweeper (30min timeout)
- Routes: `GET /routes`, `GET /trips/search`, `POST /trips/ai-search`, `POST /customers`, `POST /bookings`, `PATCH /bookings/:id/confirm`, `PATCH /bookings/:id/cancel`
- **Gap**: No refund flow on cancellation. No waiting list for sold-out trips. No WhatsApp handoff. `booked_at`/`boarded_by` columns exist but no boarding scan endpoint.

#### TRN-4: Operator Management (`src/api/operator-management.ts`)
- Full fleet CRUD: operators, routes, vehicles, drivers, trips
- Trip state machine: `scheduled → boarding → in_transit → completed/cancelled`
- Trip copy/clone, dynamic fare rules, route stops, revenue reports
- FRSC-compliant manifest PDF generation via `pdf-lib`
- **Gap**: No GPS update endpoint (columns exist). SOS system incomplete (schema exists). No recurring schedule/template engine. KYC for corporate customers not wired. VAT not calculated on bookings.

### 1.3 Core Modules

| Module | File | Purpose | Status |
|--------|------|---------|--------|
| SeatInventoryManager | `src/core/seat-inventory/index.ts` | In-memory seat lifecycle | Partial — diverges from D1 API |
| BookingManager | `src/core/booking/index.ts` | In-memory booking flow | Partial — diverges from D1 API |
| TripStateMachine | `src/core/trip-state/index.ts` | Trip lifecycle enforcement | Complete |
| SyncEngine | `src/core/offline/sync.ts` | Offline mutation flush | Partial — auto-trigger missing |
| OfflineDB (Dexie) | `src/core/offline/db.ts` | IndexedDB schema | Complete |
| PricingEngine | `src/core/pricing/engine.ts` | Dynamic fare calculation | Complete |
| I18n | `src/core/i18n/index.ts` | EN/YO/IG/HA + 5 currencies | Complete |
| TripSeatDO | `src/durables/trip-seat-do.ts` | WebSocket fan-out + batch reserve serialization | Partially wired |
| Sweepers | `src/lib/sweepers.ts` | Cron maintenance | Complete |
| SMS | `src/lib/sms.ts` | Termii/Yournotify | Not fully deployed |
| Payments | `src/lib/payments.ts` | Paystack/Flutterwave | Active (no refund flow) |

### 1.4 Database Schema (11 Migrations, ~25+ Tables)

**Core tables**: `operators`, `routes`, `route_stops`, `vehicles`, `drivers`, `trips`, `seats`, `agents`, `sales_transactions`, `receipts`, `customers`, `bookings`, `bus_parks`, `api_keys`, `platform_events`, `ndpr_consent_log`, `seat_history`, `trip_parcels`, `schedules`, `terminals`, `agent_broadcasts`, `dispute_tickets`, `operator_reviews`

**Critical schema findings**:
- `trips.current_latitude`, `trips.current_longitude`, `trips.location_updated_at` — GPS columns exist, **no endpoint**
- `trips.sos_active`, `trips.sos_triggered_at`, `trips.sos_triggered_by`, `trips.sos_cleared_at` — SOS columns exist, **no endpoints**
- `receipts.qr_code` — column exists, **always null**
- `bookings.boarded_at`, `bookings.boarded_by` — boarding columns exist, **no boarding endpoint**
- `customers.credit_limit_kobo`, `customers.customer_type` — corporate credit columns exist, **no credit booking flow**
- All financial values in kobo (integer) — correct
- Soft deletes via `deleted_at` — consistent

### 1.5 `@webwaka/core` Package

Local package at `packages/core/src/index.ts`. Exports:
- `requireRole()`, `requireTenant()`, `getTenantId()` — RBAC + multi-tenant middleware
- `jwtAuthMiddleware()`, `verifyJWT()`, `generateJWT()` — JWT lifecycle
- `nanoid()` — Platform ID generator
- `formatKobo()` — Currency display
- `publishEvent()` — Event Bus D1 outbox writer
- `requireTierFeature()` — Subscription tier gating
- Type exports: `WakaRole`, `WakaUser`, `PlatformEvent`, `TierFeature`

**Duplication**: `genId()` in `src/api/types.ts` duplicates `nanoid()` from core.

### 1.6 Sweepers (Cron: Every Minute + Daily)

- `drainEventBus()` — processes 50 pending events
- `sweepExpiredReservations()` — releases expired seat holds
- `sweepAbandonedBookings()` — cancels >30min pending bookings
- `sweepExpiredPII()` — NDPR anonymization (daily, 2 years)
- `purgeExpiredFinancialData()` — FIRS compliance (daily, 7 years)

### 1.7 Tests

- **Unit/Integration (Vitest)**: `src/api/api.test.ts`, `src/core/booking/index.test.ts`, `src/core/i18n/index.test.ts`, `src/core/offline/db.test.ts`, `src/core/offline/sync.test.ts`, `src/core/pricing/engine.test.ts`, `src/core/sales/index.test.ts`, `src/core/seat-inventory/index.test.ts`, `src/core/trip-state/index.test.ts`, `src/components/*.test.tsx`, `src/durables/trip-seat-do.test.ts`
- **E2E (Playwright)**: `playwright/transport.spec.ts`

### 1.8 Existing Documentation

- `webwaka-transport-research.md` — 1,576-line master research doc with 100 enhancement recommendations
- `webwaka-implementation-plan.md` — Phased implementation plan (P01–P15)
- `docs/manus-research/` — Architecture, market, module-specific, and integration docs
- `docs/ndpr-compliance.md`, `docs/rbac.md` — Governance docs
- `TRN_AUDIT.md`, `TRN_SUITE_REPORT.md` — Status audits
- `PHASE-4-CLEARANCE-CERTIFICATE.md` — Phase 4 completion sign-off

### 1.9 Known Bugs and Critical Gaps

1. **OTP rate limiting** — Documented as needed, not implemented in code
2. **SyncEngine auto-trigger missing** — Agents must manually sync or wait for SW background sync
3. **GPS endpoint missing** — Schema exists, endpoint does not
4. **SOS endpoints missing** — Schema exists, endpoints do not
5. **QR code never generated** — Column exists, always null
6. **Boarding scan endpoint missing** — Schema exists, endpoint does not
7. **No refund flow** — Cancellations release seats but do not call Paystack/Flutterwave refund APIs
8. **SMS not fully deployed** — `sms.ts` exists but OTP confirmation + booking events not fully plumbed
9. **Push notification consumer placeholder** — Event bus handler logs but doesn't deliver push
10. **Dual domain model / API split** — `BookingManager`, `SeatInventoryManager` diverge from D1 logic
11. **genId/nanoid duplication** — Two ID generation strategies coexist

---

## 2. External Best-Practice Research

### 2.1 Intercity Bus Ticketing — Industry Architecture Standards

Best-in-class intercity ticketing platforms (Busbud, Flixbus, GoToBus, Treepz) share these patterns:
- **Atomic seat reservation with 5–15 minute TTL** for online flows — 30 seconds is industry-minimum only for agent POS
- **Real-time WebSocket seat maps** — clients receive `seat_locked` / `seat_released` events without polling
- **Idempotent payment processing** — payment reference stored before gateway call; webhook re-confirms
- **Graceful degradation** — all customer-facing flows degrade to offline-capable alternatives
- **QR-coded tickets with server-side verification** — not just a visual but a cryptographically verifiable payload

### 2.2 Offline-First / PWA Best Practices

- **Background Sync API** (Service Worker) must be registered AND have the sync event mapped to the SyncEngine flush — not just registered
- **Conflict resolution UI** must be surfaced immediately on reconnect, not buried in a separate menu
- **Offline indicator** should be persistent and prominent — users in 2G zones need to know their state
- **Dexie.js Cloud** or manual CRDTs for multi-device sync — the current single-device assumption breaks when agents share tablets
- **IndexedDB storage quota management** — apps in Nigeria may be on 16GB devices; quota must be monitored

### 2.3 Cloudflare Workers / Durable Objects Best Practices

- **Durable Objects** are single-threaded per instance — per-trip `TripSeatDO` is architecturally correct; batch reservation through it is the gold standard
- **Hibernation-aware DOs** — use `acceptWebSocket()` for hibernatable WebSocket connections (reduces billing and improves cold start)
- **D1 + DO pattern** — DO for serialization and hot in-memory state, D1 for durable persistence — already implemented correctly
- **KV TTL management** — idempotency tokens should have TTLs matching the offline window (24–72h for agent offline scenarios)
- **Worker concurrency and subrequests** — avoid chained subrequest waterfalls; batch D1 queries where possible

### 2.4 Multi-Tenant SaaS Transport

- **Row-level tenant isolation** via `operator_id` on every query — already implemented in `applyTenantScope()`
- **Tenant configuration service** — per-operator KV config is best practice; already in `TENANT_CONFIG_KV`
- **API key management** — operators need per-integration API keys for white-label setups; `api_keys` table exists
- **Subscription tier gating** — `requireTierFeature()` in core is the right pattern; needs consistent use across all routes

### 2.5 Nigerian Payment Integration Best Practices

- **Always verify webhook signatures** (HMAC-SHA512 for Paystack, SHA256 hash for Flutterwave) — already done
- **Idempotent webhook handlers** — webhook may be delivered 2–3 times; use `X-Idempotency-Key` or `reference` deduplication — already done
- **Refund APIs exist** — Paystack: `POST /refund`; Flutterwave: `POST /v3/refunds` — not yet implemented
- **Bank transfer fallback (USSD)** — many Nigerian passengers use bank transfer; USSD-based booking is a differentiator
- **Mobile money** (Opay, PalmPay, Moniepoint) gaining share rapidly — add as payment options

### 2.6 QR Code / Boarding Best Practices

- **Signed QR payload** — ticket QR should encode `{ booking_id, trip_id, seat_ids, timestamp, hmac_sig }` — do not encode raw PII
- **Server-side verification** — boarding scan calls an API to verify the QR and mark `boarded_at`; no offline boarding for fraud prevention
- **Multiple scan prevention** — mark ticket as `boarded` on first scan; second scan returns 409
- **jsqr** — already a dependency; scan via camera is already architected in `DriverView`

### 2.7 FRSC / NDPR / FIRS Compliance

- **FRSC Manifests** — must include: bus plate number, driver license number, passenger name, seat number, origin, destination, departure time. PDF generation via `pdf-lib` is the right tool.
- **NDPR (2023 NDPA)** — consent must be explicit, granular, and withdrawable. Data subject access requests (DSAR) must be supported. PII must be anonymized at 2 years. Already implemented in sweepers.
- **FIRS** — financial records 7 years. VAT 7.5% applies to transport services. VAT calculation not yet wired.

### 2.8 PWA / Push Notification Best Practices

- **VAPID push** — already configured; consumer not wired to booking events
- **Push on booking confirmation** — gold standard; passengers expect immediate confirmation
- **Push on delay** — operators reporting delays should trigger passenger push/SMS
- **Service Worker update lifecycle** — `skipWaiting()` + `clients.claim()` needed for seamless updates in production

### 2.9 Real-Time Analytics Best Practices

- **Transport KPIs**: occupancy rate, revenue per route, avg booking lead time, cancellation rate, agent performance, peak period utilization
- **Operator dashboard** should show: today's departing trips (with seat counts), live revenue, agent sales breakdown, vehicle utilization
- **Time-series charts** — revenue over time, bookings per route over time
- **Anomaly detection** — sudden drop in bookings on a route may indicate a competitor or operational issue

### 2.10 Security Best Practices

- **Rate limiting on all authentication endpoints** — OTP is a common attack vector (SIM swap fraud, OTP bombing)
- **API key scoping** — API keys should have per-key permission scopes, not blanket operator access
- **Webhook signature replay prevention** — timestamps in webhook payloads should be validated (±5 min window)
- **Input sanitization** — SQL injection via raw string interpolation is a risk where `applyTenantScope` is bypassed
- **CORS allowlist** — current hardcoded allowlist breaks for white-label operator subdomains

---

## 3. Synthesis and Gap Analysis

### 3.1 What Exists and Works

| Area | Status |
|------|--------|
| Multi-tenant RBAC + JWT auth | ✅ Complete |
| OTP phone auth (Nigeria-First) | ✅ Complete (missing rate limit) |
| Trip CRUD + state machine | ✅ Complete |
| Seat reservation (single + batch via DO) | ✅ Core logic complete |
| Paystack + Flutterwave webhook integration | ✅ Complete |
| Offline mutation queueing (Dexie) | ✅ Complete |
| SyncEngine with conflict logging | ✅ Complete (auto-trigger missing) |
| NDPR consent + sweepers | ✅ Complete |
| FIRS financial data retention | ✅ Complete |
| Dynamic fare pricing engine | ✅ Complete |
| I18n (EN/YO/IG/HA) | ✅ Complete |
| Trip manifest PDF (FRSC) | ✅ Complete |
| Revenue reporting | ✅ Complete |
| AI natural language trip search | ✅ Complete |
| Idempotency middleware | ✅ Complete |

### 3.2 Critical Gaps (Safety + Revenue Impact)

| Gap | Impact | Schema Ready? |
|-----|--------|--------------|
| SOS trigger/clear endpoints | Safety-critical | ✅ Yes |
| GPS location update endpoint | Operational | ✅ Yes |
| Passenger boarding QR scan | Fraud prevention | ✅ Yes |
| Payment refund flow | Revenue/Trust | ❌ No API call |
| OTP rate limiting | Security | ❌ Not in code |
| SyncEngine auto-trigger | Reliability | ❌ Missing call |
| QR code generation in receipts | Trust artifact | ✅ Column exists |

### 3.3 High-Value Missing Features

| Feature | Why It Matters | Complexity |
|---------|---------------|-----------|
| Recurring trip schedule engine | Operators clone trips daily manually | Medium |
| Push notification consumer | Passengers expect instant confirmation | Low |
| SMS consumer full deployment | OTP + booking SMS not fully wired | Low |
| Agent float reconciliation | Supervisors reconcile cash daily | Medium |
| Waiting list for sold-out trips | High-demand routes sell out | Medium |
| Corporate credit booking | corporate clients need credit facilities | Medium |
| VAT calculation (FIRS) | Regulatory compliance | Low |
| Configurable reservation TTL | 30s is too short for online payments | Low |
| Seat class pricing (VIP/window) | Revenue optimization | Medium |
| WhatsApp ticket delivery | Dominant passenger communication channel | Medium |
| USSD booking channel | Non-smartphone passengers | High |
| API key scoping (per key permissions) | Security + white-label | Medium |
| CORS dynamic allowlist | White-label operators use subdomains | Low |

### 3.4 Architectural Improvements Needed

| Issue | Description |
|-------|-------------|
| Dual domain model split | `BookingManager`, `SeatInventoryManager` diverge from D1 API; no shared interface |
| genId/nanoid duplication | Two ID generators; must consolidate to `@webwaka/core` `nanoid()` |
| applyTenantScope in core | Generic helper belongs in `@webwaka/core` for all repos |
| parsePagination/metaResponse in core | Generic helpers belong in `@webwaka/core` |
| CORS hardcoded allowlist | Fails for white-label subdomains |

---

## 4. Top 20 Enhancements

| # | Title | Category | Priority |
|---|-------|----------|---------|
| E-01 | SOS Trigger, Clear & Escalate Endpoints | Safety | CRITICAL |
| E-02 | GPS Location Update Endpoint + Real-Time Driver Tracking | Operations | CRITICAL |
| E-03 | Passenger Boarding QR Scan + Server-Side Verification | Fraud Prevention | CRITICAL |
| E-04 | Payment Refund Flow (Paystack + Flutterwave) | Revenue/Trust | CRITICAL |
| E-05 | OTP + API Rate Limiting (All Auth Endpoints) | Security | CRITICAL |
| E-06 | SyncEngine Auto-Trigger on Reconnect | Reliability | HIGH |
| E-07 | QR Code Population in Agent Receipts | Trust | HIGH |
| E-08 | Push Notification Consumer (VAPID) Wired to Event Bus | UX | HIGH |
| E-09 | SMS Consumer Full Plumbing (OTP Confirm + Booking Events) | UX | HIGH |
| E-10 | Configurable Reservation TTL Per Operator | Revenue | HIGH |
| E-11 | Recurring Trip Schedule Engine (Templates + Auto-Create) | Operations | HIGH |
| E-12 | Agent Float Reconciliation Workflow | Operations | HIGH |
| E-13 | Waiting List for Sold-Out Trips | Revenue | MEDIUM |
| E-14 | Seat Class Pricing (VIP/Window/Aisle/Standard) | Revenue | MEDIUM |
| E-15 | WhatsApp Ticket Delivery Integration | UX | MEDIUM |
| E-16 | Corporate Customer Credit Booking Flow | Revenue | MEDIUM |
| E-17 | VAT Calculation + Invoice Generation (FIRS Compliance) | Compliance | MEDIUM |
| E-18 | CORS Dynamic Allowlist for White-Label Operators | Platform | MEDIUM |
| E-19 | Consolidate Shared Helpers into @webwaka/core | Architecture | MEDIUM |
| E-20 | Analytics Dashboard KPI Enhancement (Occupancy, Utilization) | Analytics | MEDIUM |

---

## 5. Bug Fix Recommendations

| # | Bug | Severity | File |
|---|-----|---------|------|
| B-01 | OTP rate limiting documented but not implemented | CRITICAL | `src/api/auth.ts` |
| B-02 | SyncEngine `getPendingTransactions()` not called automatically | HIGH | `src/core/offline/sync.ts` |
| B-03 | `genId()` duplicates `nanoid()` from core — inconsistent IDs | MEDIUM | `src/api/types.ts` |
| B-04 | `receipts.qr_code` always null despite column existing | HIGH | `src/api/agent-sales.ts` |
| B-05 | CORS allowlist hardcoded — white-label operators break | HIGH | `src/worker.ts` |
| B-06 | Webhook timestamp replay attack window not validated | MEDIUM | `src/api/payments.ts` |
| B-07 | `publishEvent()` imported from two sources (core + local) | LOW | Multiple files |
| B-08 | Dual domain model divergence — `BookingManager` vs D1 API | HIGH | `src/core/booking/index.ts` |
| B-09 | No input sanitization on raw SQL string in route search | MEDIUM | `src/api/booking-portal.ts` |
| B-10 | Service Worker `skipWaiting()` not called — stale SW in production | MEDIUM | SW file |

---

## 6. Task Breakdown

Each task below includes: objective, why it matters, scope, dependencies, prerequisites, impacted modules, files, expected output, acceptance criteria, tests, risks, governance docs, reminders, QA plan, implementation prompt, and QA prompt.

---

### TASK E-01: SOS Trigger, Clear & Escalate Endpoints

**Title**: Implement SOS Trigger, Clear, and Escalate API Endpoints with Event Publication

**Objective**: Wire the existing `sos_*` columns in the `trips` table to actual HTTP endpoints that allow drivers to trigger SOS alerts, supervisors to acknowledge and clear them, and the system to escalate unacknowledged alerts.

**Why It Matters**: Safety is non-negotiable. A driver experiencing a vehicle breakdown, hijacking, or medical emergency with no digital distress signal is a liability and a competitive weakness. The schema is fully designed; the gap is implementation. This is the highest-priority safety feature in the entire codebase.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: Platform event bus (`publishEvent` from `@webwaka/core`), `SESSIONS_KV` for throttling, notification system (SMS via `src/lib/sms.ts`)

**Prerequisites**: `trips` table has `sos_active`, `sos_triggered_at`, `sos_triggered_by`, `sos_cleared_at`, `sos_cleared_by`, `sos_escalated_at` columns. `requireRole` from `@webwaka/core` available.

**Impacted Modules**: TRN-4 (Operator Management), TRN-2 (Agent Sales / Driver view), `src/components/driver-view.tsx`

**Files to Change**:
- `src/api/operator-management.ts` — Add 3 new endpoints
- `src/lib/sweepers.ts` — Add escalation sweeper
- `src/components/driver-view.tsx` — Wire SOS button to new endpoint
- Possibly `migrations/012_sos_escalation.sql` — If escalation log table needed

**Expected Output**:
- `POST /api/operator/trips/:id/sos` — Driver triggers SOS (role: DRIVER, STAFF)
- `DELETE /api/operator/trips/:id/sos` — Supervisor clears SOS (role: SUPERVISOR, TENANT_ADMIN)
- `POST /api/operator/trips/:id/sos/escalate` — Internal/system escalates unacknowledged SOS after threshold
- SOS trigger publishes `trip.sos_triggered` event to platform event bus
- SOS clear publishes `trip.sos_cleared` event
- Sweeper checks every minute for SOS alerts active >15 minutes and auto-escalates
- Driver UI SOS button calls the endpoint and shows confirmation

**Acceptance Criteria**:
- [ ] Driver can trigger SOS on their assigned trip
- [ ] SOS state reflected immediately in `trips` table (`sos_active = 1`, `sos_triggered_at` set)
- [ ] Supervisor dashboard shows active SOS alerts with driver/trip info
- [ ] Clearing SOS sets `sos_cleared_at` and `sos_cleared_by`
- [ ] Unacknowledged SOS after 15 minutes is marked escalated
- [ ] `trip.sos_triggered` event published to event bus
- [ ] SMS sent to supervisor phone on SOS trigger (via `sms.ts`)
- [ ] Driver cannot trigger SOS on a trip not assigned to them
- [ ] All endpoints RBAC-gated

**Tests Required**:
- Unit: trigger SOS sets correct columns
- Unit: clear SOS validates role and sets `sos_cleared_at`
- Unit: escalation sweeper marks SOS escalated after threshold
- Integration: POST /sos returns 200 with correct response shape
- Integration: DELETE /sos by unauthorized role returns 403
- E2E: Driver clicks SOS → supervisor dashboard shows alert

**Risks**:
- SMS gateway (Termii) rate limits may delay alerting — must degrade gracefully
- Sweeper escalation window (15 min) may be too long for real emergencies — make configurable

**Governance Docs**: `docs/rbac.md`, `docs/ndpr-compliance.md`, `webwaka-implementation-plan.md` (P05: Trip Operations)

**Important Reminders**:
- Nigeria-First: SMS must go through Termii/Yournotify, not Twilio
- Event-Driven: SOS trigger MUST publish to event bus; no direct cross-DB calls
- Multi-Tenant: SOS can only be viewed/cleared by same-operator supervisors
- Build Once Use Infinitely: Any reusable SOS event type should be added to `@webwaka/core` PlatformEvent types

---

**QA Plan — E-01:**

*What to verify*:
1. SOS trigger endpoint returns 200 and sets all 3 SOS columns in D1
2. `sos_active` is set to 1 (boolean truthy in SQLite)
3. `sos_triggered_by` matches the authenticated driver's user ID
4. Event `trip.sos_triggered` appears in `platform_events` table
5. SMS is dispatched (check Termii/mock logs)
6. Supervisor can see active SOS in operator dashboard
7. Clearing SOS as a DRIVER returns 403
8. Clearing SOS as SUPERVISOR returns 200 and sets `sos_cleared_at`
9. Second SOS trigger on already-active SOS returns 409 or 200 idempotently
10. After clearing, `sos_active` is 0
11. Sweeper escalation marks `sos_escalated_at` when unacknowledged >15 min
12. Cross-tenant: SUPERVISOR from operator B cannot clear SOS for operator A's trip

*Edge Cases*:
- Driver triggers SOS on a completed trip → should be rejected (400)
- SOS triggered while offline → must queue as offline mutation via SyncEngine
- SMS gateway unavailable → SOS still saves, error logged but does not break
- Concurrent SOS triggers from two drivers on same trip → idempotent

*Regression*: Trip state machine transitions should still work after SOS is active

*Done when*:
- All acceptance criteria pass
- Unit + integration tests pass
- No 500 errors in Worker logs
- SMS delivered in staging environment

---

**Implementation Prompt — E-01:**

```
REPO: webwaka-transport
TASK: E-01 — Implement SOS Trigger, Clear, and Escalate Endpoints

CONTEXT:
You are implementing safety-critical SOS endpoints for the WebWaka Transport Suite.
This repo is NOT standalone — it is one module of the WebWaka OS v4 multi-repo platform.
Read docs/rbac.md, docs/ndpr-compliance.md, and webwaka-implementation-plan.md before writing any code.
The `trips` table already has: sos_active (INTEGER), sos_triggered_at (INTEGER ms), sos_triggered_by (TEXT), sos_cleared_at (INTEGER ms), sos_cleared_by (TEXT), sos_escalated_at (INTEGER ms).
The event bus is available via `publishEvent` from `@webwaka/core`.
SMS is available via `src/lib/sms.ts` (Termii/Yournotify).
Role enforcement uses `requireRole` from `@webwaka/core`.
Tenant scoping uses `applyTenantScope` / `getTenantId` from `src/api/types.ts`.

ECOSYSTEM CAVEAT:
- Only implement within this repo.
- publishEvent writes to the D1 platform_events table; do not make HTTP calls to other repos.
- SMS must use src/lib/sms.ts (Termii/Yournotify), not third-party services.

DELIVERABLES:
1. POST /api/operator/trips/:id/sos
   - Roles: DRIVER, STAFF
   - Sets sos_active=1, sos_triggered_at=Date.now(), sos_triggered_by=user.id
   - Publishes trip.sos_triggered event
   - Sends SMS to operator supervisor phone
   - Returns 200 { success: true, data: { trip_id, sos_triggered_at } }
   - Returns 409 if sos_active already true
   - Returns 403 if driver is not assigned to this trip

2. DELETE /api/operator/trips/:id/sos
   - Roles: SUPERVISOR, TENANT_ADMIN, SUPER_ADMIN
   - Sets sos_active=0, sos_cleared_at=Date.now(), sos_cleared_by=user.id
   - Publishes trip.sos_cleared event
   - Returns 200 { success: true }
   - Returns 404 if no active SOS

3. POST /api/operator/trips/:id/sos/escalate (internal/cron only)
   - Sets sos_escalated_at=Date.now() for SOS active >15min without clearing
   - Called by sweeper in src/lib/sweepers.ts

4. Add to sweepExpiredReservations or add new sweeper: escalateStaleSOS()
   - Runs every minute via existing cron
   - Marks sos_escalated_at for unacknowledged SOS older than 15 minutes

5. Wire SOS button in src/components/driver-view.tsx to POST /api/operator/trips/:id/sos
   - Show a confirmation dialog before triggering
   - Show "SOS Active" badge when sos_active
   - Allow clearing via a supervisor-role check (hide clear button for DRIVER role)

6. Tests: src/api/api.test.ts — add SOS trigger, clear, and RBAC tests

ACCEPTANCE CRITERIA:
- All items listed above pass
- No direct SQL string interpolation — use parameterized queries
- All monetary values in kobo (n/a here, but confirm no price bugs)
- Event-driven: no HTTP calls to other repos
- Multi-tenant: operator B cannot affect operator A's trips
- Tests pass: npm test

IMPORTANT REMINDERS:
- Nigeria-First: SMS through Termii/Yournotify
- Build Once Use Infinitely: If adding new event types to platform_events, document in @webwaka/core types
- Zero Skipping Policy: Implement all 6 deliverables — do not skip any
- Governance: Read rbac.md and ndpr-compliance.md first
- Do not add external npm packages unless absolutely necessary
- Do not drift into implementing other features during this task
```

---

**QA Prompt — E-01:**

```
REPO: webwaka-transport
TASK: QA for E-01 — SOS Trigger, Clear, and Escalate Endpoints

CONTEXT:
You are performing QA on the SOS endpoints just implemented in the WebWaka Transport repo.
This repo is NOT standalone — it is part of the WebWaka OS v4 multi-repo platform.
Read docs/rbac.md and webwaka-implementation-plan.md before testing.

WHAT TO TEST:
1. POST /api/operator/trips/:id/sos
   - DRIVER role on assigned trip → 200
   - DRIVER role on unassigned trip → 403
   - CUSTOMER role → 403
   - Trip already has sos_active=1 → 409
   - Trip in completed/cancelled state → 400
   - D1 row: verify sos_active=1, sos_triggered_at set, sos_triggered_by = driver ID
   - platform_events: verify trip.sos_triggered event exists
   - SMS: verify Termii/mock called with supervisor phone

2. DELETE /api/operator/trips/:id/sos
   - SUPERVISOR role, same tenant → 200
   - SUPERVISOR role, different tenant → 403 or 404
   - DRIVER role → 403
   - No active SOS → 404
   - D1 row: verify sos_active=0, sos_cleared_at set, sos_cleared_by = supervisor ID

3. Sweeper: escalateStaleSOS()
   - Manually set sos_active=1, sos_triggered_at = Date.now() - 16*60*1000
   - Run sweeper
   - Verify sos_escalated_at is set in D1

4. Driver UI (src/components/driver-view.tsx)
   - SOS button visible to DRIVER role
   - Confirmation dialog appears before triggering
   - After trigger, "SOS Active" badge appears
   - Clear button visible only to SUPERVISOR/TENANT_ADMIN

5. Regression
   - Trip state transitions (scheduled→boarding, etc.) still work after SOS is active
   - Other trips not affected by one trip's SOS

EDGE CASES:
- Trigger SOS while offline → SyncEngine must queue the mutation
- SMS gateway unavailable → SOS saves, error logged, no 500 response
- Concurrent SOS triggers → only one wins, second gets 409

BUGS TO LOOK FOR:
- Missing tenant scope check on clear endpoint
- SMS sending errors surfacing as 500 to driver (should be fire-and-forget)
- sos_active stored as wrong type (string vs integer)
- sweeper not picking up SOS from all operators

QA DONE WHEN:
- All above test cases pass
- No 500 errors in Worker logs for any tested scenario
- Unit and integration tests pass: npm test
- Driver UI correctly reflects SOS state
```

---

### TASK E-02: GPS Location Update Endpoint + Real-Time Driver Tracking

**Title**: Implement GPS Location Update Endpoint and Live Tracking State in Operator Dashboard

**Objective**: Wire the existing GPS columns (`current_latitude`, `current_longitude`, `location_updated_at`) in the `trips` table to a PATCH endpoint, update the driver view to send GPS coordinates periodically, and display live location in the operator dashboard.

**Why It Matters**: Route deviation, driver absenteeism, and unexpected stops are top operational pain points for Nigerian bus operators. Live tracking gives supervisors real-time visibility without phone calls, reduces fraud (ghost trips), and enables accurate ETA updates to waiting passengers.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: Geolocation API (browser), platform event bus, `TripStateMachine` (only emit location in `in_transit` state)

**Prerequisites**: `trips.current_latitude`, `trips.current_longitude`, `trips.location_updated_at` columns exist.

**Impacted Modules**: TRN-4 (Operator Management API), TRN-2 (Driver View component), `src/core/trip-state/index.ts`

**Files to Change**:
- `src/api/operator-management.ts` — Add PATCH /trips/:id/location endpoint
- `src/components/driver-view.tsx` — Add GPS polling + update call
- `src/api/types.ts` — Add `DbTrip.current_latitude` to TypeScript types if missing

**Expected Output**:
- `PATCH /api/operator/trips/:id/location` — Driver sends GPS coordinates every 30 seconds
- Endpoint validates trip is `in_transit` (only makes sense to track active trips)
- Publishes `trip.location_updated` event if coordinate change > 100m from last known
- Operator dashboard shows live bus position (map or coordinate display)
- Driver view starts polling geolocation when trip moves to `in_transit` state

**Acceptance Criteria**:
- [ ] PATCH /api/operator/trips/:id/location accepts `{ latitude, longitude }` and updates D1
- [ ] Only works on `in_transit` trips (returns 400 for other states)
- [ ] Role: DRIVER (only assigned driver), STAFF, TENANT_ADMIN
- [ ] Coordinates validated: latitude [-90, 90], longitude [-180, 180]
- [ ] `location_updated_at` set to `Date.now()`
- [ ] `trip.location_updated` event published when movement detected
- [ ] Driver UI polls Geolocation API every 30s and calls endpoint
- [ ] Geolocation permission gracefully declined — feature is optional, not blocking
- [ ] Operator dashboard shows last known location with timestamp

**Tests Required**:
- Unit: valid/invalid coordinate ranges
- Unit: only in_transit trips accepted
- Integration: PATCH /location returns 200 with correct columns updated
- Integration: PATCH on non-assigned trip returns 403
- Component: driver view starts GPS when trip is in_transit

**Risks**:
- GPS accuracy in urban Nigerian environments is ±50–200m — display accuracy accordingly
- Driver devices may not have Geolocation permission — must degrade gracefully
- Frequent PATCH calls may stress D1 write limits — throttle to 30s intervals, coalesce rapid updates

**Governance Docs**: `docs/ndpr-compliance.md` (location data is personal data — require consent), `docs/rbac.md`

**Important Reminders**:
- Nigeria-First: Location data is PII under NDPR. Must be covered by existing NDPR consent or separate consent
- Event-Driven: location events go to event bus, not direct calls
- Mobile-First: GPS polling must work in background on mobile (use requestWakeLock if available)
- Multi-Tenant: Only same-operator supervisors see location

---

**QA Plan — E-02:**

*What to verify*:
1. PATCH /location with valid coordinates on in_transit trip → 200, D1 updated
2. PATCH /location on scheduled/boarding/completed trip → 400 with clear error
3. PATCH /location by non-assigned driver → 403
4. Invalid latitude (>90) → 400
5. `location_updated_at` set to current timestamp in milliseconds
6. `trip.location_updated` event in `platform_events`
7. Driver UI: GPS permission denied → graceful message, no crash
8. Driver UI: GPS polling starts when trip state = in_transit
9. Operator dashboard shows last known coordinates with human-readable timestamp

*Edge Cases*:
- GPS returns 0,0 (ocean) → validate and reject (or flag as suspicious)
- Same coordinates sent twice → idempotent update (no event published if no movement)
- Offline GPS update → queued via SyncEngine

*Done when*: All pass, no console errors in driver view during GPS polling

---

**Implementation Prompt — E-02:**

```
REPO: webwaka-transport
TASK: E-02 — GPS Location Update Endpoint + Real-Time Driver Tracking

CONTEXT:
You are wiring the GPS tracking system for the WebWaka Transport Suite.
This repo is NOT standalone — part of WebWaka OS v4 multi-repo platform.
Read docs/ndpr-compliance.md (location data is PII), docs/rbac.md, and webwaka-implementation-plan.md.
The `trips` table already has: current_latitude (REAL), current_longitude (REAL), location_updated_at (INTEGER ms).
Coordinate changes should emit trip.location_updated events to the platform event bus via publishEvent.
The driver view is at src/components/driver-view.tsx.

ECOSYSTEM CAVEAT:
- Do not make HTTP calls to other repos — events go through the D1 event bus
- Location data is PII — must be covered by NDPR consent already collected

DELIVERABLES:
1. PATCH /api/operator/trips/:id/location
   - Body: { latitude: number, longitude: number }
   - Roles: DRIVER (own trip only), STAFF, SUPERVISOR, TENANT_ADMIN
   - Validation: latitude in [-90, 90], longitude in [-180, 180]
   - Only accepted if trip.state = 'in_transit'
   - Update D1: current_latitude, current_longitude, location_updated_at
   - Publish trip.location_updated event if movement > 0 (simple check: coordinates differ from stored)
   - Return 200 { success: true, data: { trip_id, latitude, longitude, updated_at } }
   - Return 400 if trip not in_transit
   - Return 403 if driver not assigned to trip

2. src/components/driver-view.tsx
   - When trip.state = 'in_transit', start a 30-second geolocation polling interval
   - Request Geolocation permission, handle denial gracefully (show message, no crash)
   - On each position update, call PATCH /api/operator/trips/:id/location
   - Stop polling when trip leaves in_transit state
   - Show "GPS Active" / "GPS Inactive" indicator

3. Operator dashboard (src/components/ or wherever operator trip list is):
   - Show last_known_location (lat, lng, timestamp) for in_transit trips
   - Display as human-readable coordinate string with "X min ago" timestamp

4. Tests: add location endpoint tests to src/api/api.test.ts

ACCEPTANCE CRITERIA:
- All deliverables implemented
- GPS polling: 30-second interval, stops on state change
- NDPR: location not returned in customer-facing APIs
- Multi-tenant: cross-operator location access blocked
- No external map SDK required — just display coordinates
- Tests pass: npm test

IMPORTANT REMINDERS:
- Nigeria-First: GPS accuracy is poor on many Nigerian devices — display ± qualifier
- Offline: location updates should be queued via SyncEngine if offline
- Mobile-First: Use requestWakeLock if available to prevent screen sleep during tracking
- Zero Skipping: Implement all 4 deliverables
```

---

**QA Prompt — E-02:**

```
REPO: webwaka-transport
TASK: QA for E-02 — GPS Location Update Endpoint

WHAT TO TEST:
1. PATCH /api/operator/trips/:id/location
   - Valid coordinates, in_transit trip, assigned driver → 200
   - Trip state = scheduled → 400
   - Non-assigned driver → 403
   - Invalid latitude (-91) → 400
   - D1: current_latitude, current_longitude, location_updated_at updated
   - platform_events: trip.location_updated present

2. Driver UI
   - trip.state = in_transit → GPS polling starts
   - GPS permission denied → graceful message, no JS error
   - Trip state changes → polling stops

3. Operator dashboard
   - in_transit trips show last known coordinates
   - Timestamp shows "X min ago"

4. NDPR check
   - Location coordinates not returned in /api/booking/* endpoints
   - location_updated_at not in customer-facing ticket page

EDGE CASES:
- GPS returns 0,0 → rejected or flagged
- Same coordinates sent consecutively → no duplicate events
- Network offline → SyncEngine queues update

DONE WHEN: All pass, no console errors, tests pass
```

---

### TASK E-03: Passenger Boarding QR Scan + Server-Side Verification

**Title**: Implement Signed QR Code Generation in Receipts/Tickets and Boarding Scan Verification Endpoint

**Objective**: Generate a cryptographically signed QR payload on every confirmed booking/receipt, and implement a boarding scan endpoint that marks passengers as boarded, preventing double-boarding and ghost passenger fraud.

**Why It Matters**: QR-coded tickets are the primary fraud prevention tool. The schema already has `receipts.qr_code`, `bookings.boarded_at`, and `bookings.boarded_by` columns, but the QR is never generated and boarding has no API endpoint. This closes the verification loop on every passenger, enables FRSC boarding accuracy, and eliminates ghost passengers.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: `qrcode` npm package (already installed), `jsqr` for scan (already installed), `@webwaka/core` `nanoid()` for token, JWT secret for HMAC signing

**Prerequisites**: `receipts.qr_code` column, `bookings.boarded_at`, `bookings.boarded_by` columns. `DriverView` component has camera scan UI scaffolded.

**Impacted Modules**: TRN-2 (Agent Sales), TRN-3 (Booking Portal), TRN-4 (Operator/Driver), `src/api/agent-sales.ts`, `src/api/booking-portal.ts`, `src/components/driver-view.tsx`, `src/components/ticket.tsx`, `src/components/receipt.tsx`

**Files to Change**:
- `src/api/agent-sales.ts` — Generate and store signed QR payload on receipt creation
- `src/api/booking-portal.ts` — Generate and store signed QR payload on booking confirmation
- `src/api/seat-inventory.ts` — Add `POST /trips/:tripId/board` endpoint for boarding scan
- `src/components/receipt.tsx` — Display QR code from stored `qr_code` field
- `src/components/ticket.tsx` — Display QR code for e-ticket
- `src/components/driver-view.tsx` — Wire camera scan to boarding endpoint

**Expected Output**:
- QR payload: `{ v: 1, bid: booking_id, tid: trip_id, seats: [...], ts: timestamp, sig: hmac_sha256 }` — no raw PII
- Signed with `JWT_SECRET` (HMAC-SHA256) — verifiable server-side without exposing secret
- `POST /api/seat-inventory/trips/:tripId/board` — accepts `{ qr_payload: string }`, verifies signature, marks boarded
- Returns 200 on first scan, 409 on duplicate scan (already boarded)
- Returns 400 on invalid/expired QR (>24h old)

**Acceptance Criteria**:
- [ ] Signed QR generated and stored in `receipts.qr_code` and/or `bookings.qr_payload` on every confirmed booking
- [ ] QR displayed in `ReceiptModal` and `TicketPage`
- [ ] Boarding endpoint verifies HMAC signature
- [ ] Boarding endpoint marks `bookings.boarded_at` and `bookings.boarded_by`
- [ ] Second scan of same ticket returns 409
- [ ] QR older than 24 hours returns 400 (anti-replay)
- [ ] Driver view camera scan wired to boarding endpoint
- [ ] No PII (name, phone) in QR payload

**Tests Required**:
- Unit: QR payload generation and HMAC signing
- Unit: HMAC verification (valid, invalid, expired)
- Integration: POST /board with valid QR → 200
- Integration: POST /board second time → 409
- Integration: POST /board with expired QR → 400
- Component: ReceiptModal renders QR image

**Risks**:
- HMAC secret rotation would invalidate all existing QR codes — plan rotation strategy
- jsqr camera scan performance on low-end Android devices — test on mid-range hardware

**Governance Docs**: `docs/ndpr-compliance.md` (no PII in QR), `docs/rbac.md`

**Important Reminders**:
- Nigeria-First: QR must be scannable on low-brightness screens and poor-quality cameras
- Mobile-First: QR display must be large and high-contrast for scanning
- Security: Never include name/phone in QR payload — booking_id is sufficient
- Build Once Use Infinitely: QR signing utility should live in `@webwaka/core` for reuse by logistics repo

---

**QA Plan — E-03:**

*What to verify*:
1. Confirmed booking has non-null `qr_code` stored in D1
2. QR payload is valid JSON with fields: v, bid, tid, seats, ts, sig
3. sig is a valid HMAC-SHA256 of the payload
4. No PII (phone, name) in QR payload
5. POST /board with valid QR → 200, `boarded_at` set in D1
6. POST /board second scan → 409
7. POST /board with tampered sig → 400
8. POST /board with QR older than 24h → 400
9. ReceiptModal shows QR image (not broken img tag)
10. TicketPage shows QR image

*Edge Cases*:
- Booking for multiple seats: all seats listed in QR, all marked boarded
- QR generated before trip departure: still valid at departure time
- Driver offline: cannot board → boarding requires connectivity (by design, for fraud prevention)

*Done when*: All pass, QR renders correctly in receipt and ticket, boarding API fully verified

---

**Implementation Prompt — E-03:**

```
REPO: webwaka-transport
TASK: E-03 — Passenger Boarding QR Scan + Server-Side Verification

CONTEXT:
You are implementing QR-coded ticket generation and boarding scan verification for the WebWaka Transport Suite.
This repo is NOT standalone — part of WebWaka OS v4 multi-repo platform.
Read docs/ndpr-compliance.md (no PII in QR), docs/rbac.md, webwaka-implementation-plan.md.
Packages already installed: qrcode (for generation), jsqr (for scanning).
JWT_SECRET is available in env bindings for HMAC signing.
receipts.qr_code column exists. bookings.boarded_at and bookings.boarded_by columns exist.
DriverView already has a camera UI scaffolded at src/components/driver-view.tsx.

ECOSYSTEM CAVEAT:
- QR signing utility should be added to packages/core/src/index.ts as a reusable export
- No PII in QR payload — booking_id + trip_id is sufficient
- Boarding scan requires live internet — no offline boarding (by design, prevents fraud)

DELIVERABLES:
1. QR Payload spec (implement in packages/core/src/index.ts as generateTicketQR / verifyTicketQR):
   Payload: { v: 1, bid: string, tid: string, seats: string[], ts: number, sig: string }
   Signing: HMAC-SHA256(JSON.stringify({v,bid,tid,seats,ts}), JWT_SECRET)
   No PII in payload.

2. Generate QR on booking confirmation in src/api/booking-portal.ts (PATCH /bookings/:id/confirm):
   - Generate signed QR payload
   - Encode to data URL using qrcode library
   - Store in receipts.qr_code and/or bookings table

3. Generate QR on agent sale in src/api/agent-sales.ts (POST /transactions):
   - Same QR generation logic
   - Store in receipts.qr_code

4. POST /api/seat-inventory/trips/:tripId/board
   - Body: { qr_payload: string }
   - Roles: DRIVER (assigned to this trip), STAFF, SUPERVISOR
   - Verify HMAC signature using verifyTicketQR
   - Check QR ts is within 24 hours
   - Verify booking belongs to this trip
   - Check booking not already boarded (returns 409 if boarded_at set)
   - Set bookings.boarded_at = Date.now(), boarded_by = user.id
   - Return 200 { success: true, data: { booking_id, passenger_names, seats } }
   - Return 400 for invalid/expired QR
   - Return 409 for already-boarded ticket

5. src/components/receipt.tsx — Display QR from qr_code field (replace static QR with stored QR)

6. src/components/ticket.tsx — Display QR for e-ticket (public page)

7. src/components/driver-view.tsx — Wire camera scan to POST /trips/:tripId/board

8. Tests in src/api/api.test.ts and src/core/ for QR generation/verification

ACCEPTANCE CRITERIA:
- QR generated on every confirmed booking
- No PII in QR
- Boarding endpoint verifies sig, timestamps, and tenant
- Double-boarding returns 409
- Tests pass: npm test

IMPORTANT REMINDERS:
- Build Once Use Infinitely: QR utilities in @webwaka/core
- Mobile-First: QR must be large and high-contrast on receipt
- Zero Skipping: All 8 deliverables required
```

---

**QA Prompt — E-03:**

```
REPO: webwaka-transport
TASK: QA for E-03 — Passenger Boarding QR Scan

WHAT TO TEST:
1. Confirmed booking: qr_code column in D1 is non-null
2. QR payload: valid JSON, no PII, has sig field
3. HMAC: tamper any field → sig verification fails
4. POST /board: valid QR → 200, boarded_at set in D1
5. POST /board: second scan → 409
6. POST /board: QR > 24h → 400
7. POST /board: wrong trip_id in QR → 400
8. POST /board: DRIVER not assigned to trip → 403
9. ReceiptModal: shows QR image (data URL renders)
10. TicketPage: shows QR image
11. Camera scan in driver view: successfully reads QR and calls board endpoint

EDGE CASES:
- Multi-seat booking: all seats marked boarded on single scan
- QR payload with extra fields: ignored, not breaking
- Low-light camera scan: jsqr correctly decodes

DONE WHEN: All pass, no broken images, no HMAC leaks, tests pass
```

---

### TASK E-04: Payment Refund Flow (Paystack + Flutterwave)

**Title**: Implement Full Payment Refund Flow for Booking Cancellations

**Objective**: When a booking is cancelled (by customer, operator, or system sweeper), initiate an automatic refund via the Paystack or Flutterwave refund API based on the payment gateway used.

**Why It Matters**: Without a refund flow, cancelled bookings result in customers losing their money. This is a trust-destroying UX failure that drives passengers back to cash. Paystack's refund API and Flutterwave's refund API both exist and are accessible. The gap is purely implementation.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: Paystack Refund API (`POST /refund`), Flutterwave Refund API (`POST /v3/refunds`), `bookings.payment_reference`, `bookings.payment_gateway` columns

**Prerequisites**: `bookings` table has `payment_reference`, `payment_gateway`, and `amount_kobo` columns. `PAYSTACK_SECRET_KEY` and `FLUTTERWAVE_SECRET_KEY` in environment.

**Impacted Modules**: TRN-3 (Booking Portal), `src/api/booking-portal.ts`, `src/lib/payments.ts`

**Files to Change**:
- `src/lib/payments.ts` — Add `initiateRefund(bookingId)` function
- `src/api/booking-portal.ts` — Call refund on cancellation
- `migrations/013_refund_log.sql` — Add `refund_log` table

**Expected Output**:
- `initiateRefund({ payment_reference, gateway, amount_kobo })` utility in `payments.ts`
- Called automatically when PATCH /bookings/:id/cancel is invoked for paid bookings
- Called automatically by `sweepAbandonedBookings()` for paid-then-abandoned bookings
- `refund_log` table: `id`, `booking_id`, `gateway`, `refund_reference`, `amount_kobo`, `status`, `created_at`
- Partial refund support (e.g., 80% refund per policy)
- Refund failure does not break cancellation — booking cancelled, refund logged as failed

**Acceptance Criteria**:
- [ ] Cancellation of paid booking triggers refund API call
- [ ] Paystack: `POST https://api.paystack.co/refund` with correct amount and transaction reference
- [ ] Flutterwave: `POST https://api.flutterwave.com/v3/refunds/:id` with correct amount
- [ ] Refund reference stored in `refund_log`
- [ ] Failed refund: booking still cancelled, error logged, operator notified
- [ ] Unpaid bookings: no refund initiated
- [ ] Sweeper refunds apply same logic

**Tests Required**:
- Unit: initiateRefund with mock gateway responses
- Unit: refund failure does not cancel cancellation
- Integration: PATCH /cancel on paid booking triggers mock refund call
- Integration: refund_log row created with correct fields

**Risks**:
- Paystack/Flutterwave refund API rate limits — implement with retry backoff
- Double refund on duplicate cancel requests — use idempotency key on refund API call

**Governance Docs**: `docs/ndpr-compliance.md`, FIRS financial record retention

---

**QA Plan — E-04:**

*What to verify*:
1. Cancel paid Paystack booking → Paystack refund API called with correct reference and amount
2. Cancel paid Flutterwave booking → Flutterwave refund API called
3. Cancel unpaid booking → no refund call
4. refund_log row created in D1
5. Refund API failure → booking still cancelled, error in refund_log
6. Double cancel request → idempotent, only one refund
7. Sweeper cancellation of paid abandoned booking → refund initiated

*Done when*: All pass in staging with real gateway sandbox credentials

---

**Implementation Prompt — E-04:**

```
REPO: webwaka-transport
TASK: E-04 — Payment Refund Flow

CONTEXT:
You are implementing automatic payment refunds for the WebWaka Transport Suite.
This repo is NOT standalone — part of WebWaka OS v4.
Read webwaka-implementation-plan.md and docs/ndpr-compliance.md.
bookings table has: payment_reference (TEXT), payment_gateway ('paystack' | 'flutterwave'), amount_kobo (INTEGER), status.
PAYSTACK_SECRET_KEY and FLUTTERWAVE_SECRET_KEY are available in env.

DELIVERABLES:
1. migrations/013_refund_log.sql — create refund_log table:
   id TEXT PRIMARY KEY, booking_id TEXT, gateway TEXT, refund_reference TEXT,
   amount_kobo INTEGER, status TEXT ('pending'|'success'|'failed'), error TEXT, created_at INTEGER

2. src/lib/payments.ts — add initiateRefund(env, { booking_id, payment_reference, gateway, amount_kobo }):
   - Paystack: POST https://api.paystack.co/refund { transaction: reference, amount: amount_kobo/100 }
   - Flutterwave: POST https://api.flutterwave.com/v3/refunds/:transaction_id { amount: amount_kobo/100 }
   - Write to refund_log regardless of success/failure
   - Return { success: boolean, refund_reference?: string, error?: string }

3. src/api/booking-portal.ts — PATCH /bookings/:id/cancel:
   - After setting booking.status = 'cancelled' and releasing seats
   - If booking.payment_reference is not null, call initiateRefund
   - Do not fail cancellation if refund fails — log and notify

4. src/lib/sweepers.ts — sweepAbandonedBookings():
   - After cancelling abandoned paid bookings, call initiateRefund
   - Same error handling: cancellation proceeds regardless

5. Tests: unit tests for initiateRefund with mocked fetch, integration test for cancel endpoint

ACCEPTANCE CRITERIA:
- Refund called for all paid cancellations
- Unpaid bookings: no refund call
- Refund failure: booking cancelled, error in refund_log
- Idempotency: cancelling twice does not trigger two refunds
- All amounts in kobo in D1, converted to naira for gateway APIs

IMPORTANT REMINDERS:
- Nigeria-First: Paystack and Flutterwave only — no Stripe
- Event-Driven: publish booking.cancelled event to event bus
- Financial records in FIRS 7-year retention — refund_log must not be hard-deleted
```

---

**QA Prompt — E-04:**

```
REPO: webwaka-transport
TASK: QA for E-04 — Payment Refund Flow

WHAT TO TEST:
1. Cancel paid booking → initiateRefund called, refund_log row created with status=success
2. Refund API failure → booking cancelled, refund_log status=failed with error text
3. Cancel unpaid booking → no refund_log row
4. Double cancel → only one refund_log row (idempotent)
5. Sweeper abandoned booking refund → same as manual cancel
6. Paystack gateway: verify correct API URL, header, and body
7. Flutterwave gateway: verify correct API URL and body
8. refund_log: verify all fields populated correctly

DONE WHEN: All pass with mocked gateway responses in unit tests and staging tests
```

---

### TASK E-05: OTP + API Rate Limiting (All Auth Endpoints)

**Title**: Implement Rate Limiting on OTP and All Authentication Endpoints

**Objective**: Add rate limiting to the OTP request endpoint (documented but not implemented), and add basic rate limiting to all authentication and sensitive API endpoints to prevent OTP bombing, credential stuffing, and DoS attacks.

**Why It Matters**: OTP bombing is a real attack vector in Nigeria (SIM swap fraud, social engineering). The existing code documents rate limiting as needed but has no implementation. This is a CRITICAL security gap.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: `SESSIONS_KV` (already used for OTP storage), Cloudflare KV TTL features

**Files to Change**:
- `src/api/auth.ts` — Add rate limiter on OTP request
- `src/middleware/` — Add `src/middleware/rate-limit.ts`
- `src/worker.ts` — Wire rate limiter middleware globally or per-route

**Expected Output**:
- OTP rate limit: 5 requests per phone number per 10 minutes (stored in `SESSIONS_KV`)
- General API rate limit: 100 requests per IP per minute on all `/api/*` routes
- AI search rate limit: 5 requests per IP per minute (already partially implemented — verify and harden)
- Rate limit response: `429 Too Many Requests` with `Retry-After` header
- `SESSIONS_KV` used as rate limit counter with TTL

**Acceptance Criteria**:
- [ ] 6th OTP request from same phone within 10 minutes → 429
- [ ] OTP counter resets after 10 minutes
- [ ] General API: 101st request from same IP within 60s → 429
- [ ] Retry-After header present in 429 responses
- [ ] Rate limits configurable via `TENANT_CONFIG_KV` (per operator)
- [ ] Rate limiter does not add >5ms latency to normal requests

**Tests Required**:
- Unit: rate limiter increments counter, rejects after threshold
- Unit: counter resets after TTL
- Integration: 6 OTP requests → 6th returns 429
- Integration: Retry-After header value is correct

**Risks**:
- IP-based rate limiting can be bypassed with proxies/VPNs — phone-based is more robust for OTP
- KV write-per-request adds latency — use single-key increment pattern

**Governance Docs**: `docs/rbac.md`, NDPR (rate limit logs should not store PII)

---

**QA Plan — E-05:**

*What to verify*:
1. POST /api/auth/otp/request: 5 requests in 10 min → 6th returns 429
2. 429 response has `Retry-After` header
3. After TTL (10 min), OTP request succeeds again
4. General API: 101 requests/min → 429
5. AI search: 6th request/min → 429
6. Rate limit does not affect different phone numbers independently

*Done when*: All rate limit scenarios verified, Retry-After header present, no false positives

---

**Implementation Prompt — E-05:**

```
REPO: webwaka-transport
TASK: E-05 — OTP + API Rate Limiting

CONTEXT:
You are implementing rate limiting for the WebWaka Transport auth and API endpoints.
This repo is NOT standalone. Read docs/rbac.md.
SESSIONS_KV is available for rate limit counter storage.
Rate limit keys should NOT store PII — use phone hash or IP only.

DELIVERABLES:
1. src/middleware/rate-limit.ts
   - createRateLimiter(kv, { key: string, limit: number, windowSec: number })
   - Returns a Hono middleware
   - Uses KV key = 'rl:{key}' with TTL = windowSec
   - KV value = JSON { count: number, resetAt: number }
   - On exceed: return 429 with Retry-After header

2. src/api/auth.ts — POST /otp/request:
   - Rate limit key = sha256(phone).slice(0, 16) (no raw PII)
   - Limit: 5 per 600 seconds
   - Inject rateLimiter middleware

3. src/worker.ts — global rate limit:
   - Apply general rate limiter to all /api/* routes: 100/60s per CF-Connecting-IP
   - AI search already has rate limit — verify it uses same pattern

4. Tests: src/middleware/rate-limit.test.ts — unit tests for increment, reset, 429

ACCEPTANCE CRITERIA:
- OTP: 6th request in 10 min → 429 with Retry-After
- General: 101st request in 60s → 429
- Rate limit counter is reset after TTL
- No PII in KV keys
- Tests pass

IMPORTANT REMINDERS:
- Nigeria-First: phone hash, not IP, is primary OTP key (VPNs are common)
- Zero Skipping: Implement all 4 deliverables
```

---

**QA Prompt — E-05:**

```
REPO: webwaka-transport
TASK: QA for E-05 — Rate Limiting

WHAT TO TEST:
1. OTP: send 6 requests with same phone → 6th = 429 with Retry-After
2. OTP: different phones → independent counters
3. General API: 101 requests in 60s → 429
4. AI search: 6th request/min → 429
5. Retry-After value matches remaining window
6. After window expires: request succeeds again
7. KV keys: verify no raw phone numbers stored

DONE WHEN: All rate limit tests pass, no false 429s on normal traffic
```

---

### TASK E-06: SyncEngine Auto-Trigger on Reconnect

**Title**: Fix SyncEngine to Auto-Trigger Flush When Network Connectivity Returns

**Objective**: The SyncEngine's `flush()` method is not automatically called when an agent device reconnects to the network. Agents must wait for the Service Worker background sync or manually trigger sync. This means offline sales may go unsynced for extended periods.

**Why It Matters**: In a bus park context, an agent may process 20–50 transactions offline and return to connectivity range without realizing sync hasn't happened. Revenue data is stale. Seat availability across agents is incorrect. The fix is straightforward.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: `window.addEventListener('online', ...)` browser API, `src/core/offline/sync.ts`, `src/core/offline/hooks.ts`

**Files to Change**:
- `src/core/offline/sync.ts` — Add online event listener in SyncEngine constructor
- `src/core/offline/hooks.ts` — Expose `lastSyncAt` state
- Possibly `src/main.tsx` — Ensure sync engine is initialized on app load

**Expected Output**:
- SyncEngine listens for `window.online` event and calls `flush()` automatically
- Debounced 2-second delay to avoid flood of sync calls on flaky connections
- `lastSyncAt` timestamp exposed via `useSyncQueue` hook
- Offline indicator shows pending count and last sync time

**Acceptance Criteria**:
- [ ] When device comes online after being offline, flush() is called within 3 seconds
- [ ] Multiple rapid online events are debounced to one flush
- [ ] `useSyncQueue` hook returns `{ pending, lastSyncAt, syncing }` fields
- [ ] Offline indicator component shows "X items pending sync" count

**Tests Required**:
- Unit: online event triggers flush after debounce
- Unit: multiple online events → single flush
- Component: offline indicator shows correct pending count

---

**QA Plan — E-06:**

*What to verify*:
1. Simulate offline: add transactions to Dexie. Come online: flush() called within 3s
2. Flaky connection: multiple online/offline events → only one flush per reconnect
3. `useSyncQueue` hook returns correct `lastSyncAt` after sync
4. Offline indicator updates pending count in real-time

*Done when*: Auto-trigger works reliably, no double-flushes, indicator accurate

---

**Implementation Prompt — E-06:**

```
REPO: webwaka-transport
TASK: E-06 — SyncEngine Auto-Trigger on Reconnect

CONTEXT:
You are fixing the SyncEngine to auto-trigger flush when network connectivity returns.
This repo is NOT standalone. Read src/core/offline/sync.ts and src/core/offline/hooks.ts.
The SyncEngine uses Web Locks API for cross-tab mutual exclusion — preserve this.

DELIVERABLES:
1. src/core/offline/sync.ts — SyncEngine:
   - In constructor, add: window.addEventListener('online', this._handleOnline)
   - _handleOnline: debounced 2000ms call to this.flush()
   - Clean up in destroy() method
   - Track lastSyncAt: number | null as instance property, update after successful flush

2. src/core/offline/hooks.ts — useSyncQueue hook:
   - Add lastSyncAt to returned state
   - Add syncing boolean (true while flush() is in progress)

3. Offline indicator component (add to src/components/ or existing layout):
   - Shows "X items pending" when offline
   - Shows "Syncing..." when flush in progress
   - Shows "Last synced X min ago" when online
   - Uses useOnlineStatus and useSyncQueue hooks

4. Tests: src/core/offline/sync.test.ts — add online event auto-trigger test

ACCEPTANCE CRITERIA:
- flush() called within 3s of going online
- Debounce prevents duplicate flushes
- useSyncQueue returns lastSyncAt
- Tests pass

IMPORTANT REMINDERS:
- Web Locks: do not bypass the lock — let flush() handle it
- Mobile-First: debounce is essential for flaky 2G connections
```

---

**QA Prompt — E-06:**

```
REPO: webwaka-transport
TASK: QA for E-06 — SyncEngine Auto-Trigger

WHAT TO TEST:
1. Add 3 transactions offline → come online → flush() called automatically
2. Multiple online events within 2s → only one flush
3. useSyncQueue: lastSyncAt updates after flush
4. Offline indicator: shows "3 items pending" when offline
5. Offline indicator: shows "Syncing..." during flush
6. Offline indicator: shows "Last synced X min ago" after flush

DONE WHEN: Auto-trigger reliable, no duplicate flushes, indicator accurate
```

---

### TASK E-07: QR Code Population in Agent Receipts

**Title**: Ensure Every Agent Receipt Has a Populated QR Code at Creation Time

**Objective**: The `receipts.qr_code` column exists but is always null. Every receipt created by an agent sale must include a signed QR code payload, stored in D1 and rendered in the ReceiptModal.

**Why It Matters**: The QR-less receipt is a trust and fraud prevention failure. Cash receipts without QR verification can be forged. This is also a prerequisite for the boarding scan feature (E-03).

**Note**: This task is tightly coupled with E-03 (Boarding QR). If E-03 is implemented first, this task may be reduced to verifying the agent-sale code path generates QR correctly.

**Repo Scope**: `webwaka-transport` only

**Files to Change**:
- `src/api/agent-sales.ts` — Generate QR on `POST /transactions`
- `src/components/receipt.tsx` — Render QR from stored field

**Expected Output**:
- Every `POST /api/agent-sales/transactions` generates a signed QR payload and stores in `receipts.qr_code`
- `ReceiptModal` renders the QR as an image (data URL from qrcode library)

**Acceptance Criteria**:
- [ ] receipts.qr_code is non-null after every agent transaction
- [ ] QR payload is signed (same spec as E-03)
- [ ] ReceiptModal shows QR image

**Tests Required**:
- Integration: POST /transactions → receipt row has non-null qr_code
- Component: ReceiptModal renders QR image

---

**QA Plan — E-07:**

*What to verify*:
1. POST /transactions → D1 receipt row: qr_code is not null
2. qr_code is valid JSON with signed payload
3. ReceiptModal: QR image renders, not broken
4. QR is scannable by jsqr or phone camera

*Done when*: QR generated, stored, and rendered on every agent receipt

---

**Implementation Prompt — E-07:**

```
REPO: webwaka-transport
TASK: E-07 — QR Code Population in Agent Receipts

CONTEXT:
You are ensuring every agent receipt has a QR code populated in the qr_code column.
This is the agent sales path (src/api/agent-sales.ts).
If E-03 has already been implemented, reuse the generateTicketQR function from @webwaka/core.
If E-03 has not been implemented, create a local generateQR helper using the qrcode npm package.

DELIVERABLES:
1. src/api/agent-sales.ts — POST /transactions:
   - After creating the transaction and receipt rows, generate a signed QR payload
   - Store as data URL (or JSON payload) in receipts.qr_code
   - Use same QR spec as E-03: { v:1, bid, tid, seats, ts, sig }

2. src/components/receipt.tsx — ReceiptModal:
   - Render QR from receipt.qr_code field
   - If qr_code is a data URL, use as <img src={qr_code}>
   - If qr_code is JSON payload, generate data URL client-side with qrcode library

ACCEPTANCE CRITERIA:
- receipts.qr_code non-null after every transaction
- ReceiptModal renders QR
- Tests pass

IMPORTANT REMINDERS:
- Build Once Use Infinitely: QR generation in @webwaka/core if not already there
- Mobile-First: QR must be large enough on mobile screens for scanning
```

---

**QA Prompt — E-07:**

```
REPO: webwaka-transport
TASK: QA for E-07 — QR Code in Receipts

WHAT TO TEST:
1. POST /transactions → qr_code in D1 is non-null
2. qr_code has valid signed payload
3. ReceiptModal: QR image renders
4. QR readable by phone camera or jsqr

DONE WHEN: Every new receipt has QR, ReceiptModal renders it
```

---

### TASK E-08: Push Notification Consumer Wired to Event Bus

**Title**: Wire VAPID Push Notification Consumer to Booking and Trip Events in Event Bus

**Objective**: The VAPID push notification infrastructure (subscription storage in `POST /api/notifications/subscribe`) exists but the event bus consumer is a placeholder (`console.log`). Wire push delivery to `booking.created`, `trip.sos_triggered`, `trip.state_changed`, and delay events.

**Why It Matters**: Passengers expect immediate push notification on booking confirmation. Operators need real-time SOS and state change alerts. The infrastructure is 95% built — only the consumer wiring is missing.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: Web Push API (VAPID), `push_subscriptions` table (or KV store), `VAPID_PRIVATE_KEY`, `VAPID_PUBLIC_KEY` environment variables

**Files to Change**:
- `src/lib/sweepers.ts` — `drainEventBus()` — Add push consumer cases
- `src/lib/push.ts` — Implement `sendPush(subscription, payload)` utility (may already exist partially)
- `src/api/notifications.ts` — Verify subscribe endpoint stores correctly

**Expected Output**:
- `drainEventBus()` handles: `booking.created` → push to customer, `trip.sos_triggered` → push to supervisors, `trip.state_changed` → push to booked passengers, `trip.delay_reported` → push to passengers
- Failed push (expired subscription) → delete subscription from storage
- Push payload: `{ title, body, icon, data: { url } }` format

**Acceptance Criteria**:
- [ ] `booking.created` event triggers push to customer's registered device
- [ ] `trip.sos_triggered` event triggers push to all supervisors of that operator
- [ ] Failed pushes log and remove stale subscriptions
- [ ] Push works on Android Chrome and iOS Safari (VAPID)

**Tests Required**:
- Unit: drainEventBus push consumer case
- Unit: sendPush with mock Web Push library

---

**QA Plan — E-08:**

*What to verify*:
1. Create booking → `booking.created` in event bus → push delivered to customer device
2. SOS trigger → push to supervisor devices
3. Expired subscription → subscription removed, no error
4. Push payload has correct title, body, data URL

*Done when*: Push delivered end-to-end in staging, stale subscriptions cleaned up

---

**Implementation Prompt — E-08:**

```
REPO: webwaka-transport
TASK: E-08 — Push Notification Consumer

CONTEXT:
You are wiring push notifications to the event bus in the WebWaka Transport Suite.
This repo is NOT standalone.
VAPID_PUBLIC_KEY and VAPID_PRIVATE_KEY are in env bindings.
Push subscriptions are stored via POST /api/notifications/subscribe.
drainEventBus() in src/lib/sweepers.ts currently console.logs events — wire real push here.
The web-push npm package or native VAPID signing (for Cloudflare Workers) should be used.

DELIVERABLES:
1. src/lib/push.ts — sendPush(env, subscription, payload):
   - Use VAPID signing with VAPID_PRIVATE_KEY
   - Send push notification to subscription endpoint
   - Return { success: boolean, error?: string }
   - On 410 Gone: delete subscription from storage

2. src/lib/sweepers.ts — drainEventBus():
   - Add cases for: booking.created, trip.sos_triggered, trip.state_changed, trip.delay_reported
   - For booking.created: fetch customer push subscriptions, send push
   - For trip.sos_triggered: fetch all SUPERVISOR subscriptions for that operator
   - Failed delivery: remove stale subscription

3. src/api/notifications.ts — verify subscribe endpoint:
   - Ensure subscription stored with user_id, operator_id, and endpoint
   - Add GET /notifications/subscriptions (SUPER_ADMIN only) for debugging

4. Tests: unit test sendPush with mock endpoint

ACCEPTANCE CRITERIA:
- booking.created → push delivered
- sos_triggered → supervisor push
- Stale subscriptions removed on 410
- Tests pass
```

---

**QA Prompt — E-08:**

```
REPO: webwaka-transport
TASK: QA for E-08 — Push Notification Consumer

WHAT TO TEST:
1. Confirm booking → booking.created event → push received on registered device
2. Trigger SOS → push received on supervisor devices
3. Simulate 410 response → subscription removed from storage
4. Push payload: correct title, body, and action URL

DONE WHEN: End-to-end push delivery verified in staging
```

---

### TASK E-09: SMS Consumer Full Plumbing

**Title**: Complete SMS Plumbing for OTP Confirmation and Booking Event Notifications

**Objective**: `src/lib/sms.ts` exists with Termii/Yournotify integration, but the booking confirmation SMS, OTP delivery SMS, and delay notification SMS are not fully wired to event consumers or the OTP flow.

**Why It Matters**: Nigerian passengers expect SMS confirmation — many do not use push notifications. OTP delivery via SMS is the primary auth flow. Broken SMS means broken auth for many users.

**Repo Scope**: `webwaka-transport` only

**Files to Change**:
- `src/api/auth.ts` — Ensure OTP SMS is actually sent (not just logged)
- `src/lib/sweepers.ts` — `drainEventBus()` — Add SMS cases for booking events
- `src/lib/sms.ts` — Verify sendSMS function is fully implemented

**Expected Output**:
- OTP: `POST /api/auth/otp/request` sends real SMS via Termii (with fallback to Yournotify)
- `booking.created` event → SMS to customer: "Your booking #X is confirmed. Trip: Lagos→Abuja, Seat: 5A"
- `trip.delay_reported` event → SMS to passengers on that trip
- `trip.sos_triggered` → SMS to supervisor (see E-01 dependency)

**Acceptance Criteria**:
- [ ] OTP SMS delivered via Termii in <5 seconds (staging/production)
- [ ] Booking confirmation SMS sent after payment webhook
- [ ] SMS failure logs error but does not fail the primary operation
- [ ] Yournotify fallback triggered when Termii returns 5xx

---

**QA Plan — E-09:**

*What to verify*:
1. OTP request → Termii API called with correct phone and message
2. Booking created → SMS to customer phone
3. Termii 500 → Yournotify fallback called
4. SMS failure → primary operation not affected

*Done when*: OTP and booking SMS verified in staging with real credentials

---

**Implementation Prompt — E-09:**

```
REPO: webwaka-transport
TASK: E-09 — SMS Consumer Full Plumbing

CONTEXT:
You are completing the SMS delivery wiring in the WebWaka Transport Suite.
src/lib/sms.ts exists with Termii/Yournotify integration but is not fully deployed.
TERMII_API_KEY and YOURNOTIFY_API_KEY are in env.
Read docs/ndpr-compliance.md — phone numbers are PII, mask in logs.

DELIVERABLES:
1. src/lib/sms.ts — verify sendSMS(env, { phone, message, sender_id }):
   - Primary: Termii API
   - Fallback: Yournotify API on Termii failure
   - Log success/failure without raw phone number (mask last 4 digits in logs)
   - Return { success: boolean, reference?: string, error?: string }

2. src/api/auth.ts — POST /otp/request:
   - Call sendSMS with OTP message
   - Do not fail the endpoint if SMS fails — return 200 but log failure

3. src/lib/sweepers.ts — drainEventBus():
   - booking.created: sendSMS to customer with booking summary
   - trip.delay_reported: sendSMS to all booked passengers on trip
   - SOS: covered by E-01

4. SMS message templates in src/core/i18n/index.ts:
   - Add OTP message template (EN/YO/IG/HA)
   - Add booking confirmation template

ACCEPTANCE CRITERIA:
- OTP SMS delivered
- Booking confirmation SMS sent
- SMS failure does not break primary operation
- Phone masked in all logs
- Tests pass
```

---

**QA Prompt — E-09:**

```
REPO: webwaka-transport
TASK: QA for E-09 — SMS Consumer

WHAT TO TEST:
1. OTP request → Termii called with correct phone and 6-digit OTP
2. Termii 500 → Yournotify called
3. Booking created → customer SMS sent
4. SMS failure → endpoint still returns 200
5. Logs: phone numbers masked (not raw)
6. I18n: OTP message in correct language for user's locale

DONE WHEN: OTP and booking SMS delivered, fallback verified
```

---

### TASK E-10: Configurable Reservation TTL Per Operator

**Title**: Make Seat Reservation TTL Configurable Per Operator (Default: 5 Minutes for Online, 30s for Agent POS)

**Objective**: The current 30-second reservation TTL is hardcoded. Online Paystack/Flutterwave payment flows typically take 60–180 seconds. The 30-second TTL causes seats to expire during payment, creating abandoned bookings and frustrated customers.

**Why It Matters**: This is a silent revenue killer. Customers reach the payment screen, the seat expires mid-payment, and they face an error. Many give up. Extending TTL for online flows to 5–10 minutes is standard industry practice.

**Repo Scope**: `webwaka-transport` only

**Files to Change**:
- `src/api/seat-inventory.ts` — Read TTL from `TENANT_CONFIG_KV`
- `src/lib/operator-config.ts` — Add `reservation_ttl_online_ms`, `reservation_ttl_agent_ms` config keys
- Possibly `migrations/014_operator_config_ttl.sql` if stored in D1 instead of KV

**Expected Output**:
- Default: online=300000ms (5 min), agent=30000ms (30s)
- Operator can configure per-operator TTL via TENANT_ADMIN settings API
- TTL applied correctly per reservation context (online vs agent)

**Acceptance Criteria**:
- [ ] Online booking reservations use 5-minute TTL by default
- [ ] Agent POS reservations use 30-second TTL by default
- [ ] Operator can override per their KV config
- [ ] TTL passed to sweeper correctly for expiration
- [ ] `extend-hold` endpoint respects configured TTL for extensions

---

**QA Plan — E-10:**

*What to verify*:
1. Online reservation: expires_at = now + 300000ms (5 min)
2. Agent POS reservation: expires_at = now + 30000ms
3. Operator with custom TTL: correct TTL applied
4. Sweeper: releases seats at correct expiry
5. extend-hold: extends by configured TTL amount

*Done when*: TTL configurable, online flows have 5-min window, agent stays at 30s

---

**Implementation Prompt — E-10:**

```
REPO: webwaka-transport
TASK: E-10 — Configurable Reservation TTL Per Operator

CONTEXT:
You are making seat reservation TTL configurable per operator in the WebWaka Transport Suite.
Currently hardcoded at 30s in src/api/seat-inventory.ts.
TENANT_CONFIG_KV stores per-operator config as JSON keyed by operator_id.
src/lib/operator-config.ts exists for reading tenant config.

DELIVERABLES:
1. src/lib/operator-config.ts — add to getOperatorConfig:
   - reservation_ttl_online_ms: default 300000 (5 min)
   - reservation_ttl_agent_ms: default 30000 (30s)

2. src/api/seat-inventory.ts:
   - POST /trips/:id/reserve and POST /trips/:id/reserve-batch:
     - Read source context from request body: { context: 'online' | 'agent' }
     - Fetch TTL from operator config
     - Apply correct TTL to reservation

3. POST /api/operator/config (new or existing) — allow TENANT_ADMIN to update TTL config:
   - PATCH /api/operator/config
   - Body: { reservation_ttl_online_ms?: number, reservation_ttl_agent_ms?: number }
   - Validation: min 30000, max 1800000 (30 min)
   - Write to TENANT_CONFIG_KV

4. src/lib/sweepers.ts — sweepExpiredReservations():
   - No change needed (reads expires_at from seat row — TTL already baked in)

ACCEPTANCE CRITERIA:
- Online: 5 min TTL, Agent: 30s TTL by default
- Operator can configure both
- Tests pass
```

---

**QA Prompt — E-10:**

```
REPO: webwaka-transport
TASK: QA for E-10 — Configurable TTL

WHAT TO TEST:
1. Online reserve → expires_at = now + 300000ms
2. Agent reserve → expires_at = now + 30000ms
3. Custom TTL via PATCH /operator/config → applied to next reservation
4. Min/max validation: TTL < 30000 → 400, TTL > 1800000 → 400
5. Sweeper: seat released at correct time

DONE WHEN: TTL configurable, defaults correct, sweeper respects TTL
```

---

### TASK E-11: Recurring Trip Schedule Engine

**Title**: Implement Recurring Trip Schedule Templates with Auto-Creation

**Objective**: Operators currently must manually clone trips every day. A recurring schedule engine would let operators define a template (route, vehicle, driver, departure time, days of week) and auto-create trips on a schedule.

**Why It Matters**: Manual daily cloning is the #1 operational friction point for operators with regular routes. A daily Lagos→Abuja trip at 7am means someone must clone a trip every morning. This feature would save 30–60 minutes of admin work per day per operator.

**Repo Scope**: `webwaka-transport` only (schedule generation; actual trip objects are in this repo)

**Dependencies**: Cloudflare Cron triggers (already configured), `trips` table, `routes`, `vehicles`, `drivers`, `seats`, `schedules` table (already in schema per architecture doc)

**Files to Change**:
- `migrations/015_schedule_engine.sql` (if `schedules` table needs enhancement)
- `src/api/operator-management.ts` — Add schedule CRUD endpoints
- `src/lib/sweepers.ts` — Add `generateScheduledTrips()` sweeper (daily)
- New `src/core/scheduling/engine.ts` — Schedule template business logic

**Expected Output**:
- `GET/POST/PATCH/DELETE /api/operator/schedules` — Schedule template CRUD
- Schedule template: `{ route_id, vehicle_id, driver_id, departure_time (HH:MM), days_of_week ([0-6]), advance_days (int, default 3), active: bool }`
- Daily cron (existing daily cron in `wrangler.toml`) generates trips 3 days in advance
- Generated trips are identical to manually cloned trips (full seat batch, correct fare)
- Duplicate prevention: check if trip with same route/vehicle/departure already exists for that day

**Acceptance Criteria**:
- [ ] CRUD for schedule templates (TENANT_ADMIN only)
- [ ] Daily cron generates trips 3 days ahead for active schedules
- [ ] Duplicate trips not created if already exist
- [ ] Generated trips have correct `operator_id`, `route_id`, `vehicle_id`, `driver_id`
- [ ] Seat rows created for each generated trip (same as POST /trips)
- [ ] Schedule deactivated when operator subscription lapses

**Tests Required**:
- Unit: schedule engine generates correct trip dates for day-of-week patterns
- Unit: duplicate prevention logic
- Integration: POST /schedules creates schedule in D1

---

**QA Plan — E-11:**

*What to verify*:
1. POST /schedules creates schedule template in D1
2. Daily cron: trips created 3 days ahead for active schedules
3. Duplicate: running cron twice → no duplicate trips
4. Deactivated schedule: no trips generated
5. Generated trip: correct route, vehicle, driver, seats

*Done when*: Auto-trip creation verified over 2 cron cycles, no duplicates

---

**Implementation Prompt — E-11:**

```
REPO: webwaka-transport
TASK: E-11 — Recurring Trip Schedule Engine

CONTEXT:
You are building a recurring trip schedule engine for the WebWaka Transport Suite.
The schedules table may already exist in the schema (check migrations/).
Daily cron is already configured in wrangler.toml.
Trip creation logic (including seat batch creation) exists in src/api/operator-management.ts.
Duplicate prevention is critical — check by (route_id, vehicle_id, departure_time, departure_date).

DELIVERABLES:
1. migrations/015_schedule_engine.sql (if schedules table needs creation/enhancement):
   schedules: id, operator_id, route_id, vehicle_id, driver_id, departure_time (TEXT HH:MM),
   days_of_week (TEXT JSON array [0-6]), advance_days (INTEGER default 3),
   active (INTEGER default 1), created_at, updated_at

2. src/api/operator-management.ts — Schedule CRUD:
   GET /api/operator/schedules — list (tenant-scoped)
   POST /api/operator/schedules — create (TENANT_ADMIN)
   PATCH /api/operator/schedules/:id — update
   DELETE /api/operator/schedules/:id — deactivate (soft delete)

3. src/core/scheduling/engine.ts — generateTripsForSchedule(schedule, db):
   - Calculate which dates in [today+1..today+advance_days] match schedule.days_of_week
   - For each date, check if trip already exists (same route/vehicle/departure_time)
   - If not exists, create trip + seat batch (reuse logic from operator-management.ts)
   - Return { created: number, skipped: number, errors: string[] }

4. src/lib/sweepers.ts — add generateScheduledTrips(env):
   - Fetch all active schedules
   - Call generateTripsForSchedule for each
   - Log results
   - Wire to daily cron in src/worker.ts

5. Tests: src/core/scheduling/engine.test.ts

ACCEPTANCE CRITERIA:
- Schedule CRUD works (RBAC: TENANT_ADMIN only)
- Daily cron generates trips 3 days ahead
- No duplicates
- All monetary values and seat data correct
- Tests pass

IMPORTANT REMINDERS:
- Event-Driven: emit trip.created events for each generated trip
- Multi-Tenant: operator_id enforced on all schedule rows
- Nigeria-First: departure_time in local time (WAT, UTC+1)
```

---

**QA Prompt — E-11:**

```
REPO: webwaka-transport
TASK: QA for E-11 — Recurring Schedule Engine

WHAT TO TEST:
1. POST /schedules → schedule created in D1
2. Daily cron → trips created 3 days ahead
3. Run cron twice → no duplicate trips
4. Deactivated schedule → no trips generated
5. Generated trip: correct route_id, vehicle_id, driver_id, operator_id
6. Generated trip: correct seat count from vehicle template
7. Different operator: cannot read other operator's schedules (403)

EDGE CASES:
- Schedule for route with no vehicles assigned → graceful error logged
- All 7 days active → trips created daily for all 3 advance days

DONE WHEN: Two cron cycles produce correct trips, no duplicates, RBAC enforced
```

---

### TASK E-12: Agent Float Reconciliation Workflow

**Title**: Implement Daily Agent Float Reconciliation API and Supervisor Dashboard

**Objective**: Supervisors need to reconcile how much cash each agent collected daily, compared to the transaction records in the system. Currently there is no reconciliation endpoint or UI.

**Why It Matters**: Agent float fraud (under-reporting sales, skimming cash) is a documented problem in Nigerian bus parks. Daily reconciliation — comparing agent-submitted cash totals against system transaction totals — is the standard counter-measure.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: `sales_transactions` table, `agents` table, `bus_parks` table

**Files to Change**:
- `src/api/agent-sales.ts` — Add reconciliation endpoints
- `migrations/016_float_reconciliation.sql` — Add `agent_float_logs` table
- `src/components/` — Add ReconciliationPanel component (SUPERVISOR role)

**Expected Output**:
- `agent_float_logs` table: `id`, `agent_id`, `operator_id`, `date`, `expected_amount_kobo`, `submitted_amount_kobo`, `variance_kobo`, `notes`, `status` (`pending`|`submitted`|`reconciled`|`disputed`), `reconciled_by`, `created_at`
- `POST /api/agent-sales/float/submit` — Agent submits their cash total for the day
- `GET /api/agent-sales/float/summary` — Supervisor sees all agent float submissions for today
- `PATCH /api/agent-sales/float/:id/reconcile` — Supervisor marks as reconciled or disputed
- Discrepancy threshold: flag variances >5% for review

**Acceptance Criteria**:
- [ ] Agent can submit float total (cash collected) via `POST /float/submit`
- [ ] System calculates `expected_amount_kobo` from transaction records
- [ ] Variance = expected - submitted
- [ ] Supervisor sees all agents' float submissions with variance highlighted
- [ ] Supervisor can mark as `reconciled` or `disputed`
- [ ] Daily email/push to supervisors if any variance >5%

---

**QA Plan — E-12:**

*What to verify*:
1. POST /float/submit → agent_float_logs row created with expected_amount from transactions
2. Variance calculated correctly
3. Supervisor sees all agents' submissions
4. PATCH /reconcile → status updated
5. Variance >5% → flagged for review
6. Agent cannot see other agents' float data

*Done when*: Reconciliation workflow end-to-end verified in staging

---

**Implementation Prompt — E-12:**

```
REPO: webwaka-transport
TASK: E-12 — Agent Float Reconciliation

CONTEXT:
You are building the daily agent float reconciliation workflow for the WebWaka Transport Suite.
sales_transactions has agent_id and amount_kobo and sync_status columns.
agents table has operator_id and phone.
Multi-tenant: supervisor sees only their operator's agents.

DELIVERABLES:
1. migrations/016_float_reconciliation.sql:
   CREATE TABLE agent_float_logs (
     id TEXT PRIMARY KEY, agent_id TEXT, operator_id TEXT, date TEXT (YYYY-MM-DD),
     expected_amount_kobo INTEGER, submitted_amount_kobo INTEGER, variance_kobo INTEGER,
     notes TEXT, status TEXT DEFAULT 'pending', reconciled_by TEXT, created_at INTEGER
   )
   UNIQUE INDEX: agent_id + date (one submission per agent per day)

2. src/api/agent-sales.ts:
   POST /api/agent-sales/float/submit
   - Role: STAFF (agent role)
   - Body: { submitted_amount_kobo: number, notes?: string }
   - Calculate expected_amount_kobo = SUM(amount_kobo) from sales_transactions WHERE agent_id=me AND date=today AND sync_status='synced'
   - Insert agent_float_logs row
   - Return { success: true, data: { expected, submitted, variance } }

   GET /api/agent-sales/float/summary
   - Role: SUPERVISOR, TENANT_ADMIN
   - Query: all agent_float_logs for today, tenant-scoped
   - Include agent name, bus park, expected, submitted, variance, status
   - Flag variance >5% in response

   PATCH /api/agent-sales/float/:id/reconcile
   - Role: SUPERVISOR, TENANT_ADMIN
   - Body: { status: 'reconciled' | 'disputed', notes?: string }
   - Update status and reconciled_by

3. src/components/ReconciliationPanel.tsx — SUPERVISOR role UI:
   - Today's agent float submissions in a table
   - Variance highlighted in red if >5%
   - Reconcile / Dispute buttons per row

ACCEPTANCE CRITERIA:
- POST /submit creates correct expected_amount from transactions
- Variance flagged >5%
- RBAC: agents submit only their own, supervisors see all in tenant
- Tests pass
```

---

**QA Prompt — E-12:**

```
REPO: webwaka-transport
TASK: QA for E-12 — Agent Float Reconciliation

WHAT TO TEST:
1. Agent submits float → agent_float_logs row created with correct expected_amount
2. Variance calculated correctly (expected - submitted)
3. GET /summary → supervisor sees all agents
4. Variance >5% → flagged in response
5. PATCH /reconcile → status updated to reconciled
6. Agent cannot see other agents' float data (403)
7. Submit twice on same day → 409 (unique constraint)

DONE WHEN: Reconciliation workflow verified end-to-end
```

---

### TASK E-13: Waiting List for Sold-Out Trips

**Title**: Implement Waiting List Registration and Automatic Seat Assignment on Cancellation

**Objective**: When a trip is fully booked, customers can join a waiting list. When a cancellation or seat release occurs, the first waiting customer receives a notification and a time-limited seat hold.

**Why It Matters**: Sold-out trips represent lost revenue from cancellations. A waiting list converts cancellations into revenue while improving customer experience. This is standard in all competing platforms.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: Notification system (push/SMS), booking confirmation flow

**Files to Change**:
- `migrations/017_waiting_list.sql` — New `waiting_list` table
- `src/api/booking-portal.ts` — Add waiting list endpoints
- `src/lib/sweepers.ts` — Add waiting list processing on seat release

**Expected Output**:
- `POST /api/booking/trips/:id/waitlist` — Join waiting list for a trip
- `DELETE /api/booking/trips/:id/waitlist` — Leave waiting list
- When seat released: notify first waiting customer, hold seat for 10 minutes
- Waiting list position shown to customer

**Acceptance Criteria**:
- [ ] Customer can join/leave waiting list
- [ ] Position in queue shown to customer
- [ ] Seat release triggers notification to #1 in queue
- [ ] 10-minute hold given automatically
- [ ] If customer doesn't book in 10 min, next in queue is notified
- [ ] Waiting list scoped by operator (multi-tenant)

---

**QA Plan — E-13:**

*What to verify*:
1. JOIN waiting list → row in waiting_list table
2. LEAVE → row removed
3. Seat release → first waiting customer notified
4. 10-min hold → if not booked, second customer notified
5. Multi-tenant: cross-operator waiting list access blocked

*Done when*: End-to-end waiting list flow verified

---

**Implementation Prompt — E-13:**

```
REPO: webwaka-transport
TASK: E-13 — Waiting List

CONTEXT:
You are implementing a waiting list for sold-out trips in the WebWaka Transport Suite.
bookings, seats tables exist. Notification via push (E-08) and SMS (E-09).
requireTierFeature('waiting_list') gate exists in @webwaka/core — use it.

DELIVERABLES:
1. migrations/017_waiting_list.sql:
   CREATE TABLE waiting_list (
     id TEXT PRIMARY KEY, trip_id TEXT, customer_id TEXT, operator_id TEXT,
     seat_count INTEGER DEFAULT 1, position INTEGER, status TEXT DEFAULT 'waiting',
     notified_at INTEGER, hold_expires_at INTEGER, created_at INTEGER
   )

2. src/api/booking-portal.ts:
   POST /api/booking/trips/:id/waitlist — body: { seat_count: number }
   DELETE /api/booking/trips/:id/waitlist — leave waiting list
   GET /api/booking/trips/:id/waitlist/position — my position

3. src/lib/sweepers.ts — after sweepExpiredReservations():
   - For each released seat, check waiting_list for same trip
   - Notify first waiting customer (push + SMS)
   - Set hold_expires_at = Date.now() + 600000 (10 min)
   - After 10 min: if still waiting (no booking), move to next in queue

ACCEPTANCE CRITERIA:
- requireTierFeature('waiting_list') gate applied
- Position calculated correctly (ORDER BY created_at)
- Notification sent to #1 in queue on seat release
- Tests pass
```

---

**QA Prompt — E-13:**

```
REPO: webwaka-transport
TASK: QA for E-13 — Waiting List

WHAT TO TEST:
1. Join waiting list → position returned
2. Leave → removed from list
3. Seat release → first in queue notified, hold set
4. 10-min hold expiry → next in queue notified
5. Operator without waiting_list tier → 402 response
6. Cross-tenant: customer in operator A cannot join operator B's waiting list

DONE WHEN: Full waiting list cycle verified
```

---

### TASK E-14: Seat Class Pricing (VIP/Window/Aisle/Standard)

**Title**: Enable Per-Seat-Class Pricing with Class Assignment on Trip Creation

**Objective**: The `seats.seat_class` column exists but always defaults to `standard`. Implement VIP, window, aisle, and standard classes with configurable pricing multipliers per route.

**Why It Matters**: This is a direct revenue lever. Luxury operators charge ₦2,000–₦5,000 more for VIP or front seats. The schema and pricing engine are ready — only the UI, creation logic, and booking flow need updating.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: `seats.seat_class`, `routes.seat_class_prices` (or similar), pricing engine (`src/core/pricing/engine.ts`)

**Files to Change**:
- `src/api/operator-management.ts` — Set seat_class on trip creation from vehicle template
- `src/api/seat-inventory.ts` — Return seat_class in availability response
- `src/core/pricing/engine.ts` — Apply class multipliers to seat price
- `src/components/seat-map.tsx` — Display class visually (color coding)
- `src/api/booking-portal.ts` — Validate amount against seat-class price

**Expected Output**:
- Vehicle seat templates define which seat numbers are VIP/window/aisle/standard
- On trip creation, seat_class assigned from template
- Availability response includes seat_class and class_price_kobo
- Seat map renders class with visual differentiation
- Booking total validated against class prices

**Acceptance Criteria**:
- [ ] Seat classes assigned on trip creation from vehicle template
- [ ] Availability API returns seat_class and effective price per seat
- [ ] Seat map shows class visually
- [ ] Booking amount validated against class prices
- [ ] requireTierFeature('seat_class_pricing') gate applied

---

**QA Plan — E-14:**

*What to verify*:
1. Trip creation: seats assigned correct class from vehicle template
2. Availability: seat_class and class_price_kobo in response
3. Seat map: VIP seats visually different from standard
4. Booking: total validated against class prices
5. Without tier: seat_class_pricing gate returns 402

*Done when*: End-to-end seat class pricing verified

---

**Implementation Prompt — E-14:**

```
REPO: webwaka-transport
TASK: E-14 — Seat Class Pricing

CONTEXT:
You are enabling per-seat-class pricing in the WebWaka Transport Suite.
seats.seat_class column exists (TEXT, default 'standard').
src/core/pricing/engine.ts has FareRule and multiplier logic.
requireTierFeature('seat_class_pricing') from @webwaka/core gates this feature.
vehicles table has seat_template (JSON or TEXT).

DELIVERABLES:
1. Vehicle seat template: extend vehicles.seat_template JSON to include seat class per position:
   [{ number: "1A", class: "VIP" }, { number: "1B", class: "window" }, ...]

2. src/api/operator-management.ts — POST /trips:
   - When creating seat batch, read seat class from vehicle.seat_template
   - Insert seat_class per row

3. src/api/seat-inventory.ts — GET /trips/:id/availability:
   - Return seat_class and class_price_kobo per seat
   - class_price_kobo = base_fare * class_multiplier (from route config)

4. src/core/pricing/engine.ts:
   - Add class multipliers: VIP=1.5, window=1.2, aisle=1.1, standard=1.0
   - Method: getSeatClassPrice(base_fare, seat_class)

5. src/components/seat-map.tsx:
   - Color code by class: VIP=gold, window=blue, aisle=green, standard=grey
   - Show class name in seat tooltip

6. src/api/booking-portal.ts — POST /bookings:
   - Validate total_amount_kobo = sum of class prices for selected seats

7. Apply requireTierFeature('seat_class_pricing') to: trip creation with class, class price endpoints

ACCEPTANCE CRITERIA:
- Seat classes assigned on creation
- Availability returns class prices
- Seat map differentiates visually
- Booking total validated
- Tests pass
```

---

**QA Prompt — E-14:**

```
REPO: webwaka-transport
TASK: QA for E-14 — Seat Class Pricing

WHAT TO TEST:
1. Trip creation with VIP seats → correct class_price_kobo in seat rows
2. Availability: VIP seat shows 1.5x base fare
3. Seat map: VIP seats visually distinct
4. Booking: wrong total (standard price for VIP seat) → 400
5. Without seat_class_pricing tier → 402

DONE WHEN: Class prices applied end-to-end, visual differentiation working
```

---

### TASK E-15: WhatsApp Ticket Delivery Integration

**Title**: Deliver Booking Confirmation and Ticket via WhatsApp

**Objective**: Nigerian passengers overwhelmingly prefer WhatsApp for communication. Send booking confirmation with PDF ticket via WhatsApp Business API or Termii WhatsApp channel after booking confirmation.

**Why It Matters**: WhatsApp open rates in Nigeria exceed 95%. SMS open rates are ~98% but WhatsApp allows rich content (PDF, images). This dramatically increases passenger trust and reduces support calls for "where is my ticket."

**Repo Scope**: `webwaka-transport` only

**Dependencies**: Termii WhatsApp API or WhatsApp Business Cloud API (Meta), PDF ticket generation (existing `src/core/pdf/manifest.ts`)

**Files to Change**:
- `src/lib/sms.ts` or new `src/lib/whatsapp.ts` — WhatsApp message delivery
- `src/lib/sweepers.ts` — Wire to booking.created event
- `src/core/pdf/` — Verify ticket PDF generation exists or create

**Expected Output**:
- `sendWhatsApp(env, { phone, message, pdf_url? })` utility
- After `booking.created` event: WhatsApp message with booking summary
- PDF ticket attached or link to `/b/:bookingId` provided
- Operator can configure WhatsApp enabled/disabled per operator

**Acceptance Criteria**:
- [ ] WhatsApp message sent after booking confirmation
- [ ] Message includes: route, date, seat numbers, amount paid, ticket link
- [ ] PDF ticket attached or ticket URL in message
- [ ] Phone number formatted with Nigerian country code (+234)
- [ ] Failure does not affect booking confirmation

---

**QA Plan — E-15:**

*What to verify*:
1. Booking confirmed → WhatsApp message sent
2. Message contains route, date, seats, amount, ticket URL
3. WhatsApp API failure → booking still confirmed, error logged
4. Phone formatting: 08012345678 → +2348012345678

*Done when*: WhatsApp delivery verified in staging

---

**Implementation Prompt — E-15:**

```
REPO: webwaka-transport
TASK: E-15 — WhatsApp Ticket Delivery

CONTEXT:
You are implementing WhatsApp ticket delivery for the WebWaka Transport Suite.
Termii supports WhatsApp messaging — use Termii WhatsApp API if available.
Alternatively use Meta WhatsApp Business Cloud API with WHATSAPP_ACCESS_TOKEN env var.
Phone numbers must be formatted: remove leading 0, add +234 prefix.
PDF ticket generation should use src/core/pdf/ or generate ticket URL pointing to /b/:bookingId.

DELIVERABLES:
1. src/lib/whatsapp.ts:
   - sendWhatsApp(env, { phone, message, document_url? }): Promise<{success, error?}>
   - Format phone: 0812... → +234812...
   - Use Termii WhatsApp API or Meta Cloud API
   - Fire-and-forget (non-blocking)

2. src/lib/sweepers.ts — drainEventBus() — booking.created case:
   - After push (E-08) and SMS (E-09): sendWhatsApp with booking summary
   - Message template: "Your WebWaka booking is confirmed! ✓ Lagos→Abuja | Seat 5A | ₦15,000 | View ticket: https://webwaka.ng/b/{booking_id}"

3. Operator config: whatsapp_enabled (boolean, default true) in TENANT_CONFIG_KV

4. src/core/i18n/index.ts — add WhatsApp message template in EN/YO/IG/HA

ACCEPTANCE CRITERIA:
- WhatsApp sent after booking confirmation
- Phone formatted correctly
- Operator can disable WhatsApp
- Failure does not affect booking
- Tests with mocked WhatsApp API pass
```

---

**QA Prompt — E-15:**

```
REPO: webwaka-transport
TASK: QA for E-15 — WhatsApp Delivery

WHAT TO TEST:
1. Booking confirmed → WhatsApp API called
2. Message: correct route, date, seats, amount, ticket URL
3. Phone formatting: 08012345678 → +2348012345678
4. API failure → booking still confirmed
5. Operator with whatsapp_enabled=false → no WhatsApp call
6. Template: English message for English locale

DONE WHEN: WhatsApp delivery verified in staging
```

---

### TASK E-16: Corporate Customer Credit Booking Flow

**Title**: Enable Corporate Customers to Book on Credit with Credit Limit Enforcement

**Objective**: The `customers` table has `customer_type` (individual/corporate) and `credit_limit_kobo` columns. Implement a credit booking flow where corporate customers with approved credit limits can book without immediate payment.

**Why It Matters**: Corporate travel is a high-value segment. Companies that send employees on intercity buses regularly prefer invoiced credit accounts over per-trip payments. This is standard in B2B travel platforms.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: KYC verification (`verifyKYC()` from `@webwaka/core` if wired), `customers` table, `bookings` table

**Files to Change**:
- `src/api/booking-portal.ts` — Handle credit payment method
- `migrations/018_corporate_credit.sql` — Add `credit_invoices` table
- New endpoint: `PATCH /api/operator/customers/:id/credit-limit` (TENANT_ADMIN)

**Expected Output**:
- Corporate customer can book with `payment_method: 'credit'`
- Credit limit checked: if booking amount > remaining credit → 402
- Credit utilization tracked in `credit_invoices` table
- TENANT_ADMIN can set/adjust credit limits
- Monthly invoice generation (or PDF on demand)

**Acceptance Criteria**:
- [ ] Corporate booking with credit goes through without payment gateway
- [ ] Credit limit enforced (over-limit → 402)
- [ ] Credit balance reduced on confirmed booking
- [ ] Credit restored on cancellation (refund)
- [ ] TENANT_ADMIN can set credit limits

---

**QA Plan — E-16:**

*What to verify*:
1. Corporate customer with credit: books without payment → 200
2. Amount > credit limit → 402
3. Credit balance updated in D1
4. Cancel credit booking → credit restored
5. Individual customer with credit payment_method → 400

*Done when*: Corporate credit flow verified end-to-end

---

**Implementation Prompt — E-16:**

```
REPO: webwaka-transport
TASK: E-16 — Corporate Credit Booking

CONTEXT:
You are implementing corporate credit booking for the WebWaka Transport Suite.
customers.customer_type and customers.credit_limit_kobo columns exist.
Booking flow is in src/api/booking-portal.ts.
Credit bookings skip payment gateway entirely — they're on account.

DELIVERABLES:
1. migrations/018_corporate_credit.sql:
   CREATE TABLE credit_invoices (
     id TEXT, customer_id TEXT, operator_id TEXT, booking_id TEXT,
     amount_kobo INTEGER, status TEXT ('outstanding'|'paid'|'cancelled'),
     due_date INTEGER, paid_at INTEGER, created_at INTEGER
   )

2. src/api/booking-portal.ts — POST /bookings:
   - If payment_method = 'credit':
     - Verify customer.customer_type = 'corporate'
     - Check customers.credit_used_kobo + amount <= customers.credit_limit_kobo
     - If over limit: return 402
     - Create booking with status = 'credit_pending' (not 'pending')
     - Insert credit_invoices row
     - Update customers.credit_used_kobo

3. PATCH /api/booking/bookings/:id/cancel:
   - If credit booking: restore credit_used_kobo

4. PATCH /api/operator/customers/:id/credit-limit:
   - Roles: TENANT_ADMIN
   - Body: { credit_limit_kobo: number }
   - Update customers.credit_limit_kobo

ACCEPTANCE CRITERIA:
- Corporate credit booking works without payment
- Over-limit returns 402
- Credit restored on cancellation
- Tests pass
```

---

**QA Prompt — E-16:**

```
REPO: webwaka-transport
TASK: QA for E-16 — Corporate Credit

WHAT TO TEST:
1. Corporate with sufficient credit: booking created, credit_used_kobo updated
2. Credit limit exceeded: 402
3. Cancel booking: credit_used_kobo restored
4. Individual customer with credit method: 400
5. TENANT_ADMIN sets credit limit: updated in D1

DONE WHEN: Credit flow verified end-to-end
```

---

### TASK E-17: VAT Calculation + Invoice Generation (FIRS Compliance)

**Title**: Apply 7.5% VAT to Bookings and Generate VAT Invoices for FIRS Compliance

**Objective**: Nigerian transport services above the VAT threshold are subject to 7.5% VAT (FIRS). Currently VAT is not calculated on any booking. Implement VAT calculation, display on invoices/receipts, and store for FIRS reporting.

**Why It Matters**: FIRS compliance is legally required. Operators above the VAT registration threshold must charge and remit VAT. This is both a compliance and trust issue — customers and operators need itemized VAT invoices.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: VAT calculation API from `@webwaka/core` if available; otherwise local implementation

**Files to Change**:
- `src/api/booking-portal.ts` — Calculate and store VAT on booking
- `migrations/019_vat_fields.sql` — Add `vat_amount_kobo` to `bookings` table
- `src/core/pricing/engine.ts` — Add `calculateVAT(amount_kobo)` helper
- `src/components/receipt.tsx` — Display VAT line on receipt

**Expected Output**:
- `calculateVAT(amount_kobo)` returns `vat_amount_kobo = floor(amount_kobo * 0.075)`
- `bookings.vat_amount_kobo` stored on confirmation
- Receipt and ticket display "VAT (7.5%): ₦X,XXX"
- Operator revenue report includes VAT totals
- VAT can be disabled per operator (for exempt operators)

**Acceptance Criteria**:
- [ ] VAT calculated on every booking confirmation
- [ ] `vat_amount_kobo` stored in bookings table
- [ ] Receipt shows VAT line item
- [ ] Revenue report includes VAT column
- [ ] Exempt operator flag in TENANT_CONFIG_KV

---

**QA Plan — E-17:**

*What to verify*:
1. Booking confirmed: vat_amount_kobo = floor(amount * 0.075)
2. Receipt: shows VAT line
3. Revenue report: includes VAT totals
4. VAT-exempt operator: vat_amount_kobo = 0

*Done when*: VAT calculation verified, receipt displays correctly

---

**Implementation Prompt — E-17:**

```
REPO: webwaka-transport
TASK: E-17 — VAT Calculation + Invoice

CONTEXT:
You are implementing FIRS VAT compliance for the WebWaka Transport Suite.
Nigeria VAT rate: 7.5% (0.075). All amounts in kobo.
vat_amount_kobo = floor(booking_amount_kobo * 0.075)

DELIVERABLES:
1. migrations/019_vat_fields.sql:
   ALTER TABLE bookings ADD COLUMN vat_amount_kobo INTEGER DEFAULT 0

2. src/core/pricing/engine.ts:
   export function calculateVAT(amount_kobo: number): number { return Math.floor(amount_kobo * 0.075) }

3. src/api/booking-portal.ts — PATCH /bookings/:id/confirm:
   - Calculate VAT on confirmation
   - Store vat_amount_kobo in bookings
   - Check operator config vat_exempt flag

4. src/components/receipt.tsx:
   - Add "VAT (7.5%): ₦X,XXX.XX" line item

5. src/api/operator-management.ts — GET /reports:
   - Add vat_collected_kobo total to revenue report

ACCEPTANCE CRITERIA:
- VAT calculated on all non-exempt bookings
- Receipt shows VAT line
- Report includes VAT
- Tests pass
```

---

**QA Prompt — E-17:**

```
REPO: webwaka-transport
TASK: QA for E-17 — VAT Calculation

WHAT TO TEST:
1. Booking ₦10,000 → vat = ₦750 (75000 kobo) stored in D1
2. Receipt: "VAT (7.5%): ₦750.00" line visible
3. Revenue report: vat_collected_kobo correct
4. VAT-exempt operator: vat = 0
5. Rounding: floor(10001 * 0.075) = floor(750.075) = 750

DONE WHEN: VAT verified, receipt displays correctly
```

---

### TASK E-18: CORS Dynamic Allowlist for White-Label Operators

**Title**: Replace Hardcoded CORS Allowlist with Dynamic Per-Operator Domain Allowlist

**Objective**: The current CORS configuration in `src/worker.ts` has a hardcoded allowlist of origins (`webwaka.ng`, `localhost:5173`). White-label operators using their own subdomain (e.g., `abc-transport.com`) cannot use the API from their frontend.

**Why It Matters**: White-label is a significant revenue opportunity. Without dynamic CORS, operators with custom domains cannot integrate without backend changes. This is also a security improvement — origins are validated, not wildcarded.

**Repo Scope**: `webwaka-transport` only

**Files to Change**:
- `src/worker.ts` — Dynamic CORS origin validation
- `src/lib/operator-config.ts` — Add `allowed_origins` to operator config

**Expected Output**:
- `allowed_origins: string[]` in `TENANT_CONFIG_KV` per operator
- On each request, extract `Origin` header and check against platform allowlist + operator-specific allowlist
- Fail gracefully: unknown origin → CORS headers omitted (not wildcard)

**Acceptance Criteria**:
- [ ] Platform origins (`webwaka.ng`, `localhost:*`) always allowed
- [ ] Operator-specific origins read from TENANT_CONFIG_KV
- [ ] Unknown origin: no CORS headers (CORS denied)
- [ ] API key requests (non-browser): CORS headers omitted entirely
- [ ] Cached origin check (per operator, 60s KV cache) for performance

---

**QA Plan — E-18:**

*What to verify*:
1. Platform origin (webwaka.ng): CORS headers present
2. Operator-configured origin (abc.com): CORS headers present
3. Unknown origin (evil.com): no CORS headers
4. API key request: no CORS headers needed
5. 60s cache: second request doesn't re-fetch KV

*Done when*: CORS verified for platform + operator-specific origins

---

**Implementation Prompt — E-18:**

```
REPO: webwaka-transport
TASK: E-18 — Dynamic CORS Allowlist

CONTEXT:
You are replacing the hardcoded CORS allowlist in src/worker.ts with a dynamic per-operator system.
TENANT_CONFIG_KV stores operator config as JSON. TENANT_CONFIG_KV binding available in env.
API key requests use Authorization: ApiKey waka_live_... header — these don't need CORS headers.

DELIVERABLES:
1. src/lib/operator-config.ts:
   - Add allowed_origins: string[] to operator config schema (default: [])
   - Cache per operator in memory/KV for 60 seconds

2. src/worker.ts — CORS middleware:
   - Replace hardcoded cors() with dynamic origin check
   - Platform origins: ['https://webwaka.ng', 'http://localhost:5173', 'http://localhost:5000']
   - Per-request: get Origin header, check against platform list + operator-specific list from config
   - If matched: set Access-Control-Allow-Origin to exact origin
   - If no match: do not set CORS headers
   - API key requests (Authorization starts with 'ApiKey'): no CORS headers

ACCEPTANCE CRITERIA:
- Platform origins always allowed
- Operator origins from KV allowed
- Unknown origins denied
- No wildcard CORS
- Cache prevents KV read per request

IMPORTANT REMINDERS:
- Security: never use Access-Control-Allow-Origin: *
- Performance: cache origin list per operator
```

---

**QA Prompt — E-18:**

```
REPO: webwaka-transport
TASK: QA for E-18 — CORS Allowlist

WHAT TO TEST:
1. Request from webwaka.ng: CORS headers present
2. Request from operator-configured origin: CORS headers present
3. Request from unknown origin: no CORS headers
4. Preflight OPTIONS from allowed origin: correct response
5. API key request (no browser origin): CORS headers absent
6. Cache: second request to same operator doesn't re-read KV

DONE WHEN: CORS verified for all origin scenarios
```

---

### TASK E-19: Consolidate Shared Helpers into @webwaka/core

**Title**: Move Generic Platform Helpers from src/api/types.ts to @webwaka/core for Cross-Repo Reuse

**Objective**: Several generic helpers in `src/api/types.ts` (`genId`, `parsePagination`, `metaResponse`, `applyTenantScope`) duplicate or should be in `@webwaka/core` for use across all WebWaka repos. Consolidate to reduce duplication and enforce platform consistency.

**Why It Matters**: Inconsistent ID generation between `genId()` and `nanoid()` can cause subtle bugs (different ID formats, different collision probability). `parsePagination` and `applyTenantScope` are needed in every WebWaka repo. Centralizing prevents drift.

**Repo Scope**: `webwaka-transport` (and `packages/core/src/index.ts`)

**Files to Change**:
- `packages/core/src/index.ts` — Add `parsePagination`, `metaResponse`, `applyTenantScope` exports
- `src/api/types.ts` — Remove duplicated `genId()`, replace calls with `nanoid()` from core
- All `src/api/*.ts` files — Update imports where needed

**Expected Output**:
- `genId()` removed from `types.ts`; all uses replaced with `nanoid(prefix, length)` from `@webwaka/core`
- `parsePagination()` moved to core or re-exported from core
- `applyTenantScope()` documented in core as a pattern (implementation stays in types.ts for now, documented for cross-repo extraction)
- All tests pass after refactor

**Acceptance Criteria**:
- [ ] No `genId()` calls remain in any file
- [ ] All IDs generated with `nanoid()` from `@webwaka/core`
- [ ] `parsePagination` in core or consistently sourced
- [ ] All existing tests still pass
- [ ] No ID format regressions

---

**QA Plan — E-19:**

*What to verify*:
1. grep for `genId` → zero results
2. All IDs in D1 rows use nanoid format (timestamp_base36 + random)
3. npm test passes
4. No ID collisions in integration tests

*Done when*: genId removed, all tests pass, no regressions

---

**Implementation Prompt — E-19:**

```
REPO: webwaka-transport
TASK: E-19 — Consolidate Shared Helpers into @webwaka/core

CONTEXT:
You are removing the genId() function from src/api/types.ts and replacing all uses with nanoid() from @webwaka/core.
This is a refactor task — do not change business logic, only ID generation.
nanoid() from packages/core/src/index.ts already has the same signature with prefix support.
All files that import genId must be updated to import nanoid from @webwaka/core.

DELIVERABLES:
1. Search for all uses of genId() across src/api/*.ts
2. Replace each genId(prefix) call with nanoid(prefix, 12)
3. Remove the genId function from src/api/types.ts
4. Update all import statements
5. Run npm test — all tests must pass

ACCEPTANCE CRITERIA:
- grep for 'genId' returns zero results
- npm test passes
- No D1 schema changes needed (IDs are TEXT, format-agnostic)

IMPORTANT REMINDERS:
- Build Once Use Infinitely: nanoid is in @webwaka/core — use it
- Zero Skipping: Replace ALL occurrences
- Do not change any business logic during this refactor
```

---

**QA Prompt — E-19:**

```
REPO: webwaka-transport
TASK: QA for E-19 — Shared Helpers Consolidation

WHAT TO TEST:
1. grep -r "genId" src/ → zero results
2. npm test → all tests pass
3. Create a booking → booking.id has correct nanoid format
4. No 500 errors from ID generation in any endpoint

DONE WHEN: genId gone, tests pass, IDs correct
```

---

### TASK E-20: Analytics Dashboard KPI Enhancement

**Title**: Enhance the Analytics Dashboard with Occupancy Rate, Vehicle Utilization, and Agent Performance KPIs

**Objective**: The existing `AnalyticsDashboard` shows basic revenue charts. Add occupancy rate per trip, vehicle utilization rate, agent performance ranking, cancellation rate by route, and peak period analysis.

**Why It Matters**: Operators need actionable data to optimize their fleet and routes. Knowing which agent sells most, which route has highest cancellations, and which trips are underutilized drives better operational decisions.

**Repo Scope**: `webwaka-transport` only

**Dependencies**: `src/api/operator-management.ts` (reports endpoint), `src/components/analytics.tsx`

**Files to Change**:
- `src/api/operator-management.ts` — Enhance `GET /reports` with new KPI queries
- `src/components/analytics.tsx` — Add new KPI panels

**Expected Output**:
- New KPI: Occupancy Rate = confirmed_seats / total_seats per trip (aggregate by route)
- New KPI: Agent Performance = revenue + booking count per agent
- New KPI: Cancellation Rate = cancelled_bookings / total_bookings per route
- New KPI: Peak Period Analysis = bookings by hour of day, day of week
- All KPIs filterable by date range

**Acceptance Criteria**:
- [ ] GET /reports returns occupancy_rate, cancellation_rate, agent_performance
- [ ] Analytics dashboard displays all new KPIs
- [ ] Date range filter applies to all KPIs
- [ ] All values in kobo with formatKobo display
- [ ] Loadable in <2 seconds (efficient SQL queries)

---

**QA Plan — E-20:**

*What to verify*:
1. GET /reports: occupancy_rate, cancellation_rate, agent_performance all present
2. Occupancy rate: 80 confirmed / 100 total seats = 0.80
3. Cancellation rate: correct calculation
4. Agent performance: sorted by revenue descending
5. Date range filter: applied to all queries
6. Response time: <2 seconds for 30-day range

*Done when*: All KPIs correct, dashboard renders, response <2s

---

**Implementation Prompt — E-20:**

```
REPO: webwaka-transport
TASK: E-20 — Analytics Dashboard KPI Enhancement

CONTEXT:
You are enhancing the analytics dashboard for the WebWaka Transport Suite.
src/api/operator-management.ts has GET /reports endpoint with basic revenue stats.
src/components/analytics.tsx has StatCard, HorizontalBar, SvgBarChart components.
All financial values in kobo. Display with formatKobo from @webwaka/core.

DELIVERABLES:
1. src/api/operator-management.ts — GET /reports:
   Add SQL queries for:
   - occupancy_rate: AVG(confirmed_count / total_seats) by route
   - cancellation_rate: cancelled_bookings / total_bookings by route
   - agent_performance: SUM(amount_kobo) and COUNT(*) per agent, sorted by revenue
   - peak_hours: COUNT(bookings) grouped by hour(departure_time)
   - peak_days: COUNT(bookings) grouped by day_of_week(departure_time)

2. src/components/analytics.tsx:
   - Add OccupancyRatePanel: bar chart of routes by occupancy
   - Add AgentLeaderboard: ranked list of agents by revenue
   - Add CancellationRatePanel: bar chart by route
   - Add PeakPeriodHeatmap: simple heatmap (CSS grid) of hour vs day

3. All panels: use existing date range filter (fromDate, toDate)

4. Add unit tests for new SQL aggregation queries

ACCEPTANCE CRITERIA:
- All new KPIs in GET /reports response
- All panels render without errors
- Date filter applies
- formatKobo used for monetary display
- Tests pass
```

---

**QA Prompt — E-20:**

```
REPO: webwaka-transport
TASK: QA for E-20 — Analytics Dashboard

WHAT TO TEST:
1. GET /reports: all new KPIs present in response
2. Occupancy: correct formula (confirmed/total)
3. Cancellation: correct calculation
4. Agent leaderboard: correct revenue totals
5. Date filter: narrowing date range changes values
6. Response time: < 2s for 30-day range
7. UI: all 4 new panels render without errors
8. No console errors in browser during render

DONE WHEN: All KPIs correct, dashboard renders, within performance budget
```

---

### BUG TASKS: B-01 through B-10

*(These are concisely documented — implementation and QA prompts follow the same structure as above.)*

---

### BUG TASK B-01: OTP Rate Limiting Not Implemented

**Quick Summary**: `POST /api/auth/otp/request` has no rate limiting despite documentation saying it should. 6+ OTP requests per phone in 10 minutes should return 429. Covered comprehensively by E-05. **See E-05.**

---

### BUG TASK B-02: SyncEngine getPendingTransactions Not Called

**Quick Summary**: `getPendingTransactions()` in the SyncEngine is defined but not called automatically. The auto-trigger is missing. Covered by E-06. **See E-06.**

---

### BUG TASK B-03: genId/nanoid Duplication

**Quick Summary**: `genId()` in `src/api/types.ts` and `nanoid()` in `@webwaka/core` produce different format IDs. Both coexist in the same codebase. Covered by E-19. **See E-19.**

---

### BUG TASK B-04: receipts.qr_code Always Null

**Quick Summary**: QR code column exists, never populated. Covered by E-03 and E-07. **See E-03, E-07.**

---

### BUG TASK B-05: CORS Hardcoded Allowlist

**Quick Summary**: `src/worker.ts` has hardcoded CORS origins that break for white-label operators. Covered by E-18. **See E-18.**

---

### BUG TASK B-06: Webhook Timestamp Replay Attack

**Title**: Validate Webhook Timestamp to Prevent Replay Attacks

**Objective**: Paystack and Flutterwave include a timestamp in their webhook payloads. The current implementation validates HMAC signature but does not validate that the timestamp is within ±5 minutes of current time, allowing a captured webhook to be replayed indefinitely.

**File**: `src/api/payments.ts`

**Fix**: After verifying HMAC, check `Math.abs(Date.now() - payload.data.paid_at * 1000) < 300000`. Return 400 if too old.

**Tests**: Unit test with expired timestamp returns 400.

---

**Implementation Prompt — B-06:**

```
REPO: webwaka-transport
TASK: B-06 — Webhook Timestamp Replay Prevention

Fix the Paystack and Flutterwave webhook handlers in src/api/payments.ts to validate that the webhook timestamp is within ±5 minutes of the current server time. After HMAC verification passes, check the payload timestamp. Return 400 with error 'WEBHOOK_EXPIRED' if timestamp is outside the 5-minute window. This prevents captured webhook payloads from being replayed maliciously. Add unit tests.
```

---

**QA Prompt — B-06:**

```
REPO: webwaka-transport
TASK: QA for B-06 — Webhook Replay Prevention

Test: Send valid HMAC webhook with timestamp = 10 minutes ago → 400 WEBHOOK_EXPIRED.
Test: Valid timestamp → 200.
Test: Future timestamp (clock skew 1 min) → 200 (within ±5 min window).
Done when: Replay attack vector closed.
```

---

### BUG TASK B-07: publishEvent Imported from Two Sources

**Title**: Consolidate publishEvent Import to @webwaka/core Only

**Objective**: Some files import `publishEvent` from `@webwaka/core`, others from `src/core/events/index.ts`. If these implementations diverge, events may be formatted differently.

**Fix**: In `src/core/events/index.ts`, re-export `publishEvent` from `@webwaka/core`. Remove duplicate implementation. Update all imports to use `@webwaka/core` directly.

---

**Implementation Prompt — B-07:**

```
REPO: webwaka-transport
TASK: B-07 — publishEvent Import Consolidation

1. Open src/core/events/index.ts — check if it duplicates publishEvent from @webwaka/core.
2. If duplicate: remove local implementation, re-export from @webwaka/core.
3. Update all imports across src/api/*.ts to import publishEvent from '@webwaka/core'.
4. Run npm test to verify no regressions.
```

---

### BUG TASK B-08: BookingManager / SeatInventoryManager Domain Model Divergence

**Title**: Document and Synchronize Domain Model vs D1 API Implementation

**Objective**: `src/core/booking/index.ts` (BookingManager) and `src/core/seat-inventory/index.ts` (SeatInventoryManager) are in-memory implementations that may diverge from the D1-backed API logic. No shared interface enforces consistency.

**Fix Phase 1**: Document the divergence in a `DOMAIN_MODEL_DIVERGENCE.md` file with a reconciliation plan. Add TODO comments in both files.

**Fix Phase 2**: Extract shared types and interfaces into a `src/core/types/` directory. Enforce both implementations against the same interface contract.

---

**Implementation Prompt — B-08:**

```
REPO: webwaka-transport
TASK: B-08 — Domain Model Divergence Documentation and Phase 1 Fix

Phase 1: Create DOMAIN_MODEL_DIVERGENCE.md documenting the divergence between:
- src/core/booking/index.ts (BookingManager) and src/api/booking-portal.ts
- src/core/seat-inventory/index.ts (SeatInventoryManager) and src/api/seat-inventory.ts

For each, document: which fields/methods differ, which is the source of truth (D1 API), and what must be done to reconcile them.

Add a TODO comment at the top of each in-memory implementation pointing to this doc.

Phase 2 (separate task): Extract shared interfaces to src/core/types/ and enforce both implementations against the same contract.
```

---

### BUG TASK B-09: Input Sanitization on Route Search SQL

**Title**: Audit and Harden Raw SQL String Usage in Booking Portal Route Search

**Objective**: The booking portal route search may have raw string interpolation in SQL queries. Audit all SQL in `src/api/booking-portal.ts` for parameterized query usage.

**Fix**: Replace any `WHERE origin LIKE '%${searchTerm}%'` with `WHERE origin LIKE ?` with a parameterized binding `%${searchTerm}%`.

---

**Implementation Prompt — B-09:**

```
REPO: webwaka-transport
TASK: B-09 — SQL Injection Audit

Audit all SQL queries in src/api/booking-portal.ts, src/api/agent-sales.ts, and src/api/operator-management.ts for any string interpolation into SQL.
Replace all found instances with parameterized D1 .bind() calls.
Document all findings in a comment block at the top of each file.
Run npm test to verify no regressions.
```

---

### BUG TASK B-10: Service Worker skipWaiting Not Called

**Title**: Ensure Service Worker Calls skipWaiting() and clients.claim() for Instant Updates

**Objective**: Without `skipWaiting()` in the `install` event and `clients.claim()` in the `activate` event, updated Service Workers wait until all existing tabs close before taking over. In a bus park environment where agents leave the app open for hours, stale SWs can persist for days.

**Fix**: Add `skipWaiting()` to `install` event and `clients.claim()` to `activate` event in the Service Worker file.

---

**Implementation Prompt — B-10:**

```
REPO: webwaka-transport
TASK: B-10 — Service Worker Update Fix

Find the Service Worker file (likely src/sw.ts or registered via Vite PWA plugin config).
Add: self.addEventListener('install', e => e.waitUntil(self.skipWaiting()))
Add: self.addEventListener('activate', e => e.waitUntil(self.clients.claim()))
If using vite-plugin-pwa, configure: injectManifest: { ... } with workbox skipWaiting and clientsClaim options.
Verify in browser DevTools: Application > Service Workers > "Skip waiting" shows automatic.
```

---

## 7. Priority Order

```
CRITICAL (Safety/Security/Revenue):
  1. E-01 — SOS Endpoints (safety-critical)
  2. E-05 / B-01 — Rate Limiting (security)
  3. B-06 — Webhook Replay Prevention (security)
  4. E-04 — Payment Refund Flow (revenue/trust)
  5. E-03 — QR Boarding Scan (fraud prevention)
  6. E-06 / B-02 — SyncEngine Auto-Trigger (reliability)

HIGH (UX/Operations):
  7. E-02 — GPS Tracking (operations)
  8. E-07 / B-04 — QR in Receipts (trust)
  9. E-09 — SMS Consumer (UX)
  10. E-08 — Push Notification Consumer (UX)
  11. E-10 — Configurable TTL (revenue)
  12. E-12 — Agent Float Reconciliation (operations)

MEDIUM (Growth/Platform):
  13. E-11 — Recurring Schedules (operations)
  14. E-13 — Waiting List (revenue)
  15. E-14 — Seat Class Pricing (revenue)
  16. E-15 — WhatsApp Delivery (UX)
  17. E-16 — Corporate Credit (revenue)
  18. E-17 — VAT Calculation (compliance)
  19. E-18 — CORS Dynamic (platform)
  20. E-19 — Helper Consolidation (architecture)
  21. E-20 — Analytics Enhancement (analytics)

MAINTENANCE (Architecture/Tech Debt):
  22. B-05 → covered by E-18
  23. B-07 — publishEvent consolidation
  24. B-08 — Domain model documentation
  25. B-09 — SQL injection audit
  26. B-10 — Service Worker skipWaiting
```

---

## 8. Phase Split

### Phase 1 — Safety, Security, Core Reliability (Execute First)

| Task | Title |
|------|-------|
| E-01 | SOS Endpoints |
| E-02 | GPS Tracking |
| E-03 | QR Boarding Scan |
| E-04 | Payment Refund Flow |
| E-05 | Rate Limiting |
| E-06 | SyncEngine Auto-Trigger |
| E-07 | QR in Receipts |
| E-09 | SMS Consumer |
| E-08 | Push Notification Consumer |
| E-10 | Configurable TTL |
| B-06 | Webhook Replay |
| B-09 | SQL Injection Audit |
| B-10 | Service Worker Fix |
| B-07 | publishEvent Consolidation |

### Phase 2 — Growth, Platform, Analytics (After Phase 1 Stable)

| Task | Title |
|------|-------|
| E-11 | Recurring Schedule Engine |
| E-12 | Agent Float Reconciliation |
| E-13 | Waiting List |
| E-14 | Seat Class Pricing |
| E-15 | WhatsApp Delivery |
| E-16 | Corporate Credit |
| E-17 | VAT Calculation |
| E-18 | CORS Dynamic Allowlist |
| E-19 | Helper Consolidation |
| E-20 | Analytics Enhancement |
| B-08 | Domain Model Documentation |

---

## 9. Ecosystem Notes

### Cross-Repo Dependencies

| This Repo Needs | From Repo |
|----------------|-----------|
| `@webwaka/core` exports | `packages/core/src/index.ts` (local) |
| KYC verification | `@webwaka/core` `verifyKYC()` (if wired) |
| Tax calculation | `@webwaka/core` `calculateVAT()` (if exists) |
| Logistics events | `webwaka-logistics` (event bus consumer) |
| Central ledger | `webwaka-central` (event consumer) |
| Notification delivery | May live in `webwaka-notifications` (or local `sms.ts`/`push.ts`) |

### Events This Repo Emits (Platform Event Bus)

| Event Type | Trigger | Consumer Repo |
|-----------|---------|--------------|
| `booking.created` | Booking confirmed | logistics, notifications, central |
| `booking.cancelled` | Booking cancelled | central, refund |
| `booking:ABANDONED` | 30min pending | central |
| `trip.state_changed` | Trip state transition | notifications, central |
| `trip.sos_triggered` | SOS triggered | notifications, supervisors |
| `trip.sos_cleared` | SOS cleared | central |
| `trip.location_updated` | GPS update | logistics, tracking |
| `trip.delay_reported` | Delay submitted | notifications |
| `agent.sale.completed` | Agent sale | central |
| `seat.reservation_expired` | TTL sweep | n/a |
| `parcel.waybill_created` | Parcel added to trip | webwaka-logistics |

### What Lives in Other Repos (Do NOT Implement Here)

- Central financial ledger reconciliation → `webwaka-central`
- Multi-operator seat sharing / interoperability → future repo or `webwaka-central`
- Logistics parcel fulfilment → `webwaka-logistics`
- USSD booking channel → `webwaka-ussd` or telephony service
- Loyalty program → `webwaka-loyalty` or `webwaka-central`

### Replit Agent Scope Reminder

A Replit agent implementing from this taskbook may **only write code within the `webwaka-transport` repo** (including `packages/core/src/index.ts` which is local to this repo). It must not make HTTP calls to other repos. Cross-repo communication goes through the D1 platform_events event bus only.

---

## 10. Governance and Reminder Block

### Platform Invariants (Non-Negotiable)

| Invariant | Rule |
|-----------|------|
| **Build Once Use Infinitely** | All reusable logic goes in `packages/core/src/index.ts` |
| **Mobile/PWA/Offline First** | Every feature must degrade gracefully offline |
| **Nigeria-First, Africa-Ready** | Kobo for currency, Termii/Yournotify for SMS, Paystack/Flutterwave for payments |
| **Vendor Neutral AI** | OpenRouter (not OpenAI direct) for AI features |
| **Multi-Tenant Tenant-as-Code** | Every D1 row must have `operator_id`. Every query must apply tenant scope. |
| **Event-Driven** | No direct inter-repo DB calls. All cross-module communication via `platform_events`. |
| **Thoroughness Over Speed** | Do not skip edge cases or tests |
| **Zero Skipping Policy** | Every deliverable in every task must be implemented |
| **CI/CD Native** | All changes must pass `npm test` before being considered complete |
| **Cloudflare-First** | D1, KV, R2, DO, Workers — no external databases |

### Governance Documents to Consult Before Implementing

- `docs/rbac.md` — Role definitions and RBAC rules
- `docs/ndpr-compliance.md` — NDPR/NDPA data protection rules
- `webwaka-implementation-plan.md` — Phased implementation dependencies
- `webwaka-transport-research.md` — 100 enhancements already researched
- `TRN_AUDIT.md` — Current status audit
- `PHASE-4-CLEARANCE-CERTIFICATE.md` — What Phase 4 completed

### Data Rules

- **All monetary values in kobo** (integers). Never store naira with decimals.
- **All timestamps in milliseconds** (Unix epoch ms). Never use seconds.
- **Soft deletes** via `deleted_at` on all primary tables.
- **No raw PII in logs** — mask phone numbers (last 4 digits), do not log JWT tokens.
- **No raw PII in QR codes** — use IDs only.

### Test Requirements

- Every new endpoint: at minimum one happy-path + one RBAC rejection test
- Every new sweeper: one unit test verifying correct rows affected
- Every new React component: one rendering test
- `npm test` must pass before any task is marked complete

---

## 11. Execution Readiness Notes

### Environment Setup

- Workflow: `npm run dev:ui` — Vite on port 5000 (running)
- Worker: `wrangler dev` — Cloudflare Worker local (separate from Vite)
- Tests: `npm test` — Vitest
- E2E: `npm run test:e2e` — Playwright

### D1 Database

- Local: use `wrangler d1 execute webwaka-transport-db --local --file=migrations/XXX.sql`
- Production: `wrangler d1 execute webwaka-transport-db-prod --file=migrations/XXX.sql`
- Always run new migration files in order

### KV Namespaces

- `SESSIONS_KV` — OTP storage, rate limit counters
- `TENANT_CONFIG_KV` — Per-operator configuration
- `SEAT_CACHE_KV` — Edge seat availability cache
- `IDEMPOTENCY_KV` — Idempotency tokens for offline sync

### Environment Variables Needed for New Tasks

| Variable | Used By |
|----------|---------|
| `TERMII_API_KEY` | E-09 SMS delivery |
| `YOURNOTIFY_API_KEY` | E-09 SMS fallback |
| `VAPID_PRIVATE_KEY` | E-08 Push notifications |
| `VAPID_PUBLIC_KEY` | E-08 Push notifications |
| `WHATSAPP_ACCESS_TOKEN` | E-15 WhatsApp delivery |
| `JWT_SECRET` | E-03 QR signing (already exists) |
| `PAYSTACK_SECRET_KEY` | E-04 Refunds (already exists) |
| `FLUTTERWAVE_SECRET_KEY` | E-04 Refunds (already exists) |

### Pre-Task Checklist for Every Implementation Agent

Before writing any code:
1. [ ] Read this document fully
2. [ ] Read `docs/rbac.md`
3. [ ] Read `docs/ndpr-compliance.md`
4. [ ] Read `webwaka-implementation-plan.md` for phase dependencies
5. [ ] Check `TRN_AUDIT.md` for current status
6. [ ] Understand the multi-repo context (do not make HTTP calls to other repos)
7. [ ] Verify you are in the `webwaka-transport` repo
8. [ ] Run `npm test` before starting to confirm baseline passes
9. [ ] Run `npm test` after finishing to confirm nothing broken

### Definition of Done (All Tasks)

A task is done when:
- All deliverables listed in the task are implemented
- All acceptance criteria pass
- `npm test` passes with new tests included
- No TypeScript errors (`npm run typecheck`)
- No 500 errors in Worker logs for any tested scenario
- Code reviewed against Platform Invariants block
- Multi-tenant isolation verified (cross-operator access blocked)
- NDPR compliance verified (no PII in logs or QR payloads)

---

*End of WEBWAKA-TRANSPORT-DEEP-RESEARCH-TASKBOOK.md*
*Total: 20 Enhancements + 10 Bug Fixes = 30 Tasks. Each with: objective, QA plan, implementation prompt, QA prompt.*
*Phase 1: 14 tasks (Safety/Security/Reliability). Phase 2: 16 tasks (Growth/Platform/Analytics).*
