# WebWaka Transport Suite — Deep Research & Enhancement Roadmap

> **Prepared for**: WebWaka Platform Engineering
> **Date**: April 1, 2026
> **Version**: v2.0 (Post-P15 Update)
> **Scope**: Full transport codebase audit, Nigeria market research, 100 transport enhancement recommendations across 5 use cases, cross-repo integration map, and recommended execution order.
> **Supersedes**: `webwaka-transport-research.md` (v1.0, March 31, 2026)

---

## Table of Contents

1. [Transport Codebase Architecture Report](#1-transport-codebase-architecture-report)
2. [Nigeria Transport Market Research Summary](#2-nigeria-transport-market-research-summary)
3. [Top 20: Seat Inventory Synchronization Enhancements](#3-top-20-seat-inventory-synchronization-enhancements)
4. [Top 20: Offline Agent Sales / Bus Park POS Enhancements](#4-top-20-offline-agent-sales--bus-park-pos-enhancements)
5. [Top 20: Customer Booking Portal Enhancements](#5-top-20-customer-booking-portal-enhancements)
6. [Top 20: Dispatch / Trip Operations Enhancements](#6-top-20-dispatch--trip-operations-enhancements)
7. [Top 20: Operator / Fleet / Route Management Enhancements](#7-top-20-operator--fleet--route-management-enhancements)
8. [Cross-Repo Integration Map](#8-cross-repo-integration-map)
9. [Recommended Execution Order](#9-recommended-execution-order)

---

## 1. Transport Codebase Architecture Report

### 1.1 Overview

WebWaka Transport is a Cloudflare-first, offline-first, multi-tenant transportation platform designed to serve the Nigerian intercity bus market. It is not a standalone product — it is one vertical module in the broader WebWaka multi-repo ecosystem. It shares a platform core package (`@webwaka/core`), emits events to the platform event bus for consumption by other services (notably the logistics repo and any future notification or analytics services), and is now (post-P15) a commercially tiered SaaS platform with feature gating at three subscription levels.

The codebase is organized into four numbered transport modules (TRN-1 through TRN-4), each with its own API router, domain logic layer, and offline data layer. The frontend is a React 19 PWA built with Vite (port 5000), and the backend is a single Cloudflare Worker using the Hono framework. As of April 2026, fifteen named phases of features have been implemented, with P16 as the next planned increment.

### 1.2 Phase Completion Status

| Phase | Title | Status |
|-------|-------|--------|
| P01–P04 | Foundation (schema, offline layer, API, auth, payments) | ✅ Complete |
| P05 | GPS, SOS, Boarding, Manifest Export, Pre-Trip Inspection, Delay Reporting | ✅ Complete |
| P06 | Operator Context Hardening, SyncEngine Auth, Agent POS Trip Selector | ✅ Complete |
| P07 | QR Receipts, Float Reconciliation, Passenger ID Capture, Multi-Seat POS | ✅ Complete |
| P08 | Seat Templates, Fare Matrix, Cancellation + Refund | ✅ Complete |
| P09 | Vehicle Maintenance, Driver Documents, Notification Center, Sweepers | ✅ Complete |
| P10 | Dispatcher Dashboard, Platform Analytics | ✅ Complete |
| P11 | API Keys, Onboarding Wizard, Multi-Stop Routes, Booking Reminders | ✅ Complete |
| P12 | Dynamic Pricing, AI Recommendations, Corporate Bulk Booking | ✅ Complete |
| P13 | Waiting List, AI Natural Language Search, Operator Reviews, Fleet Utilization | ✅ Complete |
| P14 | USSD Booking Channel, NIMET Weather Alerts, Seat Exchange Protocol | ✅ Complete |
| P15 | Subscription Tier Gating, Durable Objects Real-Time Seats, Corporate Portal, White-Label, Bulk Import | ✅ Complete (QA cleared) |

### 1.3 Major Modules

#### TRN-1: Seat Inventory (`src/api/seat-inventory.ts`)

The seat inventory module is the atomic foundation of the platform. It manages all seat lifecycle transitions: `available → reserved → confirmed → blocked`.

**Key design decisions:**
- **30-second TTL reservation tokens** (configurable per operator via `TENANT_CONFIG_KV`): Each reservation is held by a cryptographically random token. Expired holds are released by `sweepExpiredReservations()`.
- **Version-stamped seats**: Each seat row carries a `version` integer incremented on every update, enabling optimistic concurrency control.
- **Real-time fan-out via Durable Objects**: The `TripSeatDO` Durable Object (`src/durables/trip-seat-do.ts`) maintains a WebSocket fan-out per trip. All seat mutations broadcast `seat_changed` events to connected clients. The frontend `useLiveSeatUpdates()` hook connects to this WebSocket, with HTTP polling fallback (every 10s) after 5 consecutive connection failures.
- **KV edge cache**: `SEAT_CACHE_KV` caches availability responses with event-driven invalidation.
- **Client-side seat cache**: Dexie `seats` table with 30-second TTL, matching server reservation TTL.

**Routes:**
- `GET /api/seat-inventory/trips` — paginated trip list with availability counts
- `POST /api/seat-inventory/trips` — create trip with atomic seat row batch
- `GET /api/seat-inventory/trips/:id/availability` — seat map with live expiry sweep
- `POST /api/seat-inventory/trips/:id/reserve` — atomic single-seat reservation
- `POST /api/seat-inventory/trips/:id/reserve-batch` — atomic multi-seat reservation
- `POST /api/seat-inventory/trips/:id/confirm` — confirm reservation by token
- `POST /api/seat-inventory/trips/:id/release` — release reservation by token
- `POST /api/seat-inventory/trips/:id/extend-hold` — seat hold heartbeat extension
- `GET /api/seat-inventory/trips/:id/ws` — WebSocket upgrade to TripSeatDO fan-out
- `PATCH /api/seat-inventory/trips/:tripId/seats/:seatId` — SyncEngine seat mutation
- `POST /api/seat-inventory/sync` — batch offline mutation sync

#### TRN-2: Agent Sales / POS (`src/api/agent-sales.ts`)

The agent sales module enables bus park agents to sell tickets at physical counters or via mobile devices, both online and offline.

**Key design decisions:**
- **Offline-first queueing**: Offline sales are written to Dexie `transactions`. The SyncEngine flushes them to `/api/agent-sales/sync` on reconnect via the SW Background Sync tag.
- **Atomic batch write**: Every online sale writes the transaction record, receipt record, and seat status updates in a single D1 `batch()` call.
- **QR receipt**: `receipts` table has a `qr_code` column; the QR encodes `booking_id:seat_id` for scanning at the gate.
- **Float reconciliation**: `POST /api/agent-sales/reconciliation` compares agent cash-submitted against expected sales totals and flags discrepancies.
- **Passenger ID capture**: SHA-256 hashed NIN/BVN/passport at POS, included in trip manifest.
- **Agent performance**: `GET /api/agent-sales/performance` returns per-agent sales count, revenue, and commission.
- **Agent broadcasts**: `POST /api/agent-sales/broadcasts` (SUPERVISOR+) sends operational messages to all agents.

#### TRN-3: Customer Booking Portal (`src/api/booking-portal.ts`)

The booking portal is the customer-facing self-service booking flow.

**Key design decisions:**
- **NDPR enforcement as a hard gate**: Every registration and booking requires `ndpr_consent: true`. Customer PII is never returned in list endpoints.
- **Paystack inline payment**: No redirect; inline popup with `waka_` reference format.
- **AI natural language search**: `POST /api/booking/trips/ai-search` via OpenRouter (vendor-neutral). Rate-limited 5 req/min/IP via `SESSIONS_KV`.
- **Guest booking**: Phone-number-only booking with OTP verification, no full account required.
- **Waiting list**: `POST /api/booking/trips/:id/waitlist` with automatic seat notification on cancellation.
- **Corporate accounts**: `customer_type: 'corporate'` with `credit_limit_kobo`, payment via credit (atomic D1 batch deduct + insert), returning `402` for insufficient credit and `422` for non-corporate customers.
- **Booking reminders**: 24h and 2h pre-departure SMS/push via cron sweepers.
- **Operator reviews**: Post-trip passenger ratings aggregated on `GET /api/booking/trips/search`.
- **Subscription tier gating**: `operator_reviews → basic`, `ai_search / waiting_list / analytics / api_keys / seat_class_pricing → pro`, `auto_schedule / white_label / bulk_import → enterprise`.

#### TRN-4: Operator Management (`src/api/operator-management.ts`)

The operator management module covers the full lifecycle of a transport operator: company profile, routes, vehicles, drivers, trips, and revenue reporting.

**Key design decisions:**
- **Trip state machine**: `scheduled → boarding → in_transit → completed/cancelled`. All transitions validated against an allowed-transitions map and recorded in `trip_state_transitions`.
- **Pre-trip inspection gate**: Trips cannot transition to `boarding` until `POST /api/operator/trips/:id/inspection` is completed.
- **GPS location sharing**: `POST /api/operator/trips/:id/location` stores `current_latitude/longitude`. Driver view sends location every 30 seconds.
- **SOS trigger and escalation**: `POST /api/operator/trips/:id/sos` (DRIVER+) triggers SOS, SMS to emergency contact, publishes `trip:SOS_ACTIVATED`. Clear endpoint for SUPERVISOR+.
- **Digital boarding scan**: `POST /api/operator/trips/:id/board` parses QR payload, validates status, marks `boarded_at`.
- **Delay reporting**: `POST /api/operator/trips/:id/delay` (SUPERVISOR+) with reason codes and bulk SMS to confirmed passengers.
- **White-label branding**: `PUT /api/operator/config/branding` (enterprise tier) stores logo URL, primary/secondary hex color in `TENANT_CONFIG_KV`. `POST /api/operator/config/logo` uploads PNG/JPEG to R2 with size validation.
- **Bulk CSV import**: `POST /api/operator/import/routes|vehicles|drivers` accepts `multipart/form-data` CSV (5MB limit, 500-row truncation). Returns `{ created, skipped, errors }` with row-numbered error messages.
- **Recurring schedules**: `POST /api/operator/schedules` (enterprise tier) creates recurring trip schedule with CRON-like recurrence.
- **Subscription tier gating**: `requireTierFeature(featureKey)` middleware on all tier-gated endpoints. Feature map in `packages/core/src/index.ts`. Operators table now has `subscription_tier TEXT NOT NULL DEFAULT 'basic'`.
- **API keys**: SHA-256 hashed keys with `read|read_write` scope (pro tier).
- **Multi-stop routes**: `POST/GET /api/operator/routes/:id/stops` with ordered stop editing.
- **Fare matrix**: `PUT /api/operator/routes/:id/fare-matrix` with multipliers per seat class and time window.

### 1.4 Shared Abstractions and Reusable Components

#### `@webwaka/core` (`packages/core/src/index.ts`)

| Export | Purpose |
|--------|---------|
| `requireRole(roles[])` | Hono RBAC middleware factory |
| `requireTierFeature(featureKey)` | Tier-based feature gating middleware (P15) |
| `TIER_FEATURE_MAP` | Maps feature keys to minimum subscription tier |
| `requireTenant()` | Multi-tenant enforcement middleware |
| `getTenantId(c)` | Read enforced tenant ID from context |
| `jwtAuthMiddleware(config)` | JWT verification with public route whitelist |
| `verifyJWT(token, secret)` | Decode and verify compact HMAC-SHA256 JWT |
| `generateJWT(user, secret)` | Create signed compact JWT |
| `nanoid(prefix, length)` | Platform-standard ID generator (CF Worker compatible) |
| `formatKobo(kobo)` | Nigeria-First: kobo → ₦ naira display |
| `publishEvent(db, event)` | Event Bus D1 outbox writer |
| Type exports | `WakaRole`, `WakaUser`, `PlatformEvent`, `HonoCtx` |

#### `src/api/types.ts`

Shared types across all four API modules: `Env`, `AppContext`, `HonoCtx`, D1 row interfaces for all tables, `getOperatorScope()`, `applyTenantScope()`, `parsePagination()`, `metaResponse()`, `requireFields()`, `genId()`.

#### `src/core/offline/` — Offline-First Infrastructure

- **Dexie v2 schema**: 9 tables — mutations, transactions, trips, seats, bookings, agent_sessions, conflict_log, operator_config, ndpr_consent.
- **SyncEngine**: Class-based singleton. Web Locks API for cross-tab mutual exclusion. Exponential backoff up to 32s. Handles 409 conflicts by logging to the conflict log. Auth token injection on every sync request.
- **Background sync**: Service Worker `sync` event tag (`webwaka-transport-sync`) triggers flush even when app is closed.

#### `src/lib/sweepers.ts`

| Sweeper | Schedule | Purpose |
|---------|----------|---------|
| `drainEventBus()` | Every minute | Processes up to 50 pending platform_events |
| `sweepExpiredReservations()` | Every minute | Releases expired seat holds |
| `sweepAbandonedBookings()` | Every minute | Cancels bookings pending >30 min |
| `sweepExpiredPII()` | Daily midnight | NDPR: anonymizes customers inactive 2+ years |
| `purgeExpiredFinancialData()` | Daily midnight | FIRS: soft-deletes records >7 years |
| `sweepVehicleMaintenanceDue()` | Daily | Alerts on vehicles due in ≤7 days |
| `sweepVehicleDocumentExpiry()` | Daily | Alerts on vehicle docs expiring in ≤30 days |
| `sweepDriverDocumentExpiry()` | Daily | Alerts on driver docs expiring in ≤30 days |
| `sweepBookingReminders()` | Every minute | 24h + 2h pre-departure SMS/push |
| `sweepWaitingList()` | On seat release | Notifies next passenger in waiting list |

### 1.5 Cloudflare Infrastructure Bindings

| Binding | Type | Purpose |
|---------|------|---------|
| `DB` | D1 (SQLite) | Primary persistence for all entities |
| `SESSIONS_KV` | KV | OTP storage, AI rate limiting, USSD session state |
| `TENANT_CONFIG_KV` | KV | Per-operator config (TTL, branding, features) |
| `SEAT_CACHE_KV` | KV | Edge seat availability cache |
| `IDEMPOTENCY_KV` | KV | Offline sync idempotency tokens |
| `TRIP_SEAT_DO` | Durable Object | Per-trip WebSocket fan-out for real-time seat updates |
| `ASSETS_R2` | R2 Bucket | Operator branding assets (logos) |

### 1.6 Database Migrations (9 completed)

| Migration | Contents |
|-----------|---------|
| `001_transport_schema.sql` | Core tables: operators, routes, vehicles, trips, seats, bookings, customers, agents, transactions, receipts |
| `002_phase2_tables.sql` | Agent sessions, NDPR consent, sync mutations |
| `002_platform_events.sql` | Event bus outbox table |
| `003_vehicles_model_column.sql` | Vehicle model column |
| `004_event_bus_and_seats_hardening.sql` | Seat class, version column, seat history indexes |
| `005_payment_columns.sql` | Payment provider, paid_at on bookings |
| `006_drivers_table.sql` | Drivers entity, driver documents |
| `007_p05_trip_ops.sql` | GPS columns, SOS columns, delay columns, inspection tables |
| `008_review_prompt_sent_at.sql` | Review tracking on bookings |
| `009_subscription_tier_and_corporate.sql` | subscription_tier on operators, corporate customers |

### 1.7 Gaps, Duplication, and Missing Functionality (Current State)

The following gaps have been **addressed in prior phases** and are no longer open:
- ✅ Multi-seat atomic reservation (S-01) — `reserve-batch` endpoint implemented
- ✅ Configurable reservation TTL (S-02) — `TENANT_CONFIG_KV` operator config
- ✅ Real-time seat updates (S-03) — `TripSeatDO` WebSocket + polling fallback
- ✅ Seat class and pricing (S-04) — `seat_class` column, fare matrix
- ✅ Seat hold extension (S-06) — `extend-hold` endpoint
- ✅ SOS trigger/clear (D-08) — fully wired endpoints
- ✅ GPS update endpoint (D-04) — `POST /trips/:id/location`
- ✅ QR code generation (B-03) — `qr_code` populated on receipt creation
- ✅ Digital boarding scan (D-03) — `POST /trips/:id/board`
- ✅ Refund flow (B-06) — cancellation policy with Paystack Refund API
- ✅ Recurring schedule engine (D-16 / O-09) — `POST /schedules` (enterprise)
- ✅ Push notifications (B-09) — VAPID wired via sweepers
- ✅ SMS notifications (B-02) — `src/lib/sms.ts` wired to booking events
- ✅ Multi-seat reservation atomicity — batch reserve endpoint
- ✅ Offline agent sync (A-01) — SyncEngine wired for agent transactions
- ✅ Waiting list (S-18) — `waiting_list` table with auto-notification
- ✅ Subscription tier gating (O-15) — `requireTierFeature` middleware
- ✅ White-label branding (O-14) — logo upload, CSS var injection, `TENANT_CONFIG_KV`
- ✅ Bulk CSV import (O-18) — multipart/form-data CSV with `parseCsvFile`
- ✅ Corporate travel portal (B-13) — corporate customer type, credit payment

**Remaining open gaps (P16+ candidates):**

1. **No unified domain model interface**: `src/core/seat-inventory/index.ts` and `src/core/booking/index.ts` are in-memory implementations that diverge from the D1 API logic. No shared interface enforces consistency — a latent source of test drift.
2. **`genId()` vs `nanoid()` duplication**: Two ID generation strategies coexist. `genId()` in `types.ts` uses `timestamp + Math.random()`; `nanoid()` in `@webwaka/core` uses `crypto.getRandomValues()`. The crypto-based version should be canonical.
3. **No server-side rate limiting on standard API endpoints**: OTP is rate-limited; AI search is rate-limited; but core booking and reservation endpoints have no rate limiting, making them vulnerable to abuse.
4. **No ORM or query builder**: All D1 queries are raw SQL strings. This makes multi-column pagination and complex filter construction fragile and error-prone. A lightweight query builder could improve safety.
5. **Boarding scan has no anti-replay guard**: `POST /api/operator/trips/:id/board` checks `boarded_at IS NULL` but does not lock the row atomically — two simultaneous scans of the same QR could both succeed.
6. **No seat inventory event to logistics repo**: `parcel.seats_required` event consumption is defined in the architecture but not implemented in `drainEventBus()`.
7. **`applyTenantScope()` and pagination helpers in `types.ts`**: These generic utilities belong in `@webwaka/core` and should be shared across all repos, not duplicated per vertical.
8. **No graceful PWA update prompt**: The service worker silently replaces itself. Users on the old version during a booking flow get stale JS — a silent UX failure.
9. **No API versioning**: All endpoints are unversioned. Any breaking change requires coordinated deploy of frontend and backend simultaneously.
10. **No structured logging or tracing**: All operational logging uses `console.warn/error`. There is no correlation ID, request ID, or structured log format that would enable Cloudflare Logpush or centralized observability.

### 1.8 Reuse Opportunities

| Opportunity | Current State | Recommended Action |
|-------------|--------------|-------------------|
| `applyTenantScope()` | `src/api/types.ts` | Promote to `@webwaka/core` |
| `parsePagination()` / `metaResponse()` | `src/api/types.ts` | Promote to `@webwaka/core` |
| `genId()` | `src/api/types.ts` | Deprecate; use `nanoid()` from `@webwaka/core` exclusively |
| OTP generation/verification | `src/api/auth.ts` | Extract to `@webwaka/core` for cross-repo auth |
| NDPR consent recording | Duplicated in `db.ts` and booking API | Centralize in a shared NDPR service |
| Notification dispatch (SMS, push) | `src/lib/sms.ts`, `src/lib/push.ts` | Extract to a shared platform notification service |
| CSV parsing (`parseCsvFile`) | `src/api/operator-management.ts` | Promote to `@webwaka/core` as a reusable utility |

---

## 2. Nigeria Transport Market Research Summary

### 2.1 Key Transport Patterns

**Intercity dominance**: Nigeria's intercity bus transport market is one of the largest in Africa. The Lagos–Abuja corridor alone moves an estimated 10,000–15,000 passengers per day. Other high-volume corridors include Lagos–Ibadan, Lagos–Benin, Abuja–Kano, Port Harcourt–Owerri, and Lagos–Owerri. The National Bureau of Statistics estimates road transport accounts for over 90% of all passenger movement in Nigeria.

**Bus park centrality**: Unlike hub-and-spoke airline models, Nigerian bus travel is organized around motor parks. Major parks — Ojota, Jibowu, and Mile 2 in Lagos; Utako and Mararaba in Abuja; Onitsha main market — are the physical nerve centers of the transport network. Passengers arrive at the park, agents sell tickets, and buses depart when full or at a scheduled time depending on the operator.

**Two scheduling models coexist**:
- **Full-bus (departure-time)**: Luxury operators (ABC Transport, GUO, Peace Mass Transit, Chisco) run fixed-departure schedules with advance booking. Seats are assigned; passengers expect their specific seat.
- **Fill-and-go (load-and-depart)**: Budget operators fill the bus and leave when full. No fixed departure time. Seat assignment is informal.

**Seasonal peaks**: Travel surges dramatically around Eid (al-Fitr, al-Adha), Christmas, Easter, and major public holidays. Seat availability drops to near zero 24–72 hours before these peaks. Operators often run 200–400% of normal capacity, with price gouging common on unregulated routes.

**Logistics adjacency**: Almost every intercity bus carries parcels alongside passengers. Parcel revenue represents 10–20% of total revenue for many operators. The waybill system for parcel tracking is almost entirely paper-based, creating a major digitization opportunity.

### 2.2 Passenger and Agent Behavior

**Payment behavior**:
- Cash is king at the bus park. The vast majority of agent sales are cash transactions.
- Mobile money (Opay, PalmPay, Moniepoint, MTN MoMo) is growing rapidly and is common at parks in Lagos, Abuja, and Port Harcourt.
- Bank transfer (USSD and app-based) is used by more affluent passengers.
- Online card payments (Paystack, Flutterwave) are used by passengers booking in advance via mobile app or web.
- Trust is a significant barrier: passengers often distrust online payments without immediate physical confirmation (receipt, SMS).

**Booking behavior**:
- Walk-in purchases (same-day, at the park) remain the dominant mode.
- Advance booking is growing, particularly for long-distance routes (>5 hours).
- Passengers heavily favor WhatsApp for post-booking support (confirming a booking, requesting refunds, asking about delays).
- Many passengers are semi-literate in English but fluent in Yoruba, Igbo, or Hausa — vernacular UI is a meaningful differentiator.
- Repeat travelers (business, civil servants, students) are the highest-value segment — they are predictable, advance-booking customers.

**Agent behavior**:
- Agents work on commission. Speed of transaction is critical — a slow POS means lost revenue.
- Agents frequently operate in areas with 2G or intermittent 3G. Offline-first is a survival requirement, not a feature.
- Agents share devices. Multi-session or fast agent switching on a single device is a real use case.
- Agents manually track cash in paper ledgers. Any digital tool that replaces this must be simpler and faster.
- Supervisors reconcile agent cash daily — a digital float reconciliation workflow is expected and trusted when enforced consistently.

**Operator behavior**:
- Mid-sized operators (20–100 buses) are the primary target segment. They are organized enough to benefit from digital tools but not large enough to have built their own systems.
- Small operators (1–5 buses) are highly price-sensitive and may share infrastructure. A basic (free/subsidized) tier must be viable for them.
- Large operators (>100 buses, e.g., GUO, ABC, Peace Mass) need API integration, custom branding, and multi-terminal management.
- Operators are deeply concerned with driver accountability and bus utilization.
- Driver absenteeism, mechanical breakdown, and route deviation are the top operational pain points after competitive pricing.

### 2.3 Operational Realities

**Connectivity landscape**:
- Lagos, Abuja, Port Harcourt: intermittent 4G/LTE. Apps function with occasional drops.
- Secondary cities (Owerri, Enugu, Calabar, Ibadan): 3G typical, 4G in commercial areas.
- Bus parks on outskirts and inter-state routes: 2G/EDGE, GPRS. Data throughput can be as low as 10–50 Kbps.
- Power outages affect charging cycles. Agents may be on low-battery devices for hours.

**Nigerian compliance framework**:
- **NDPR (Nigeria Data Protection Regulation)**: Enforced by the Nigeria Data Protection Bureau (NDPB). Passenger PII requires explicit consent, retention limits, and data subject rights (access, erasure, portability).
- **FIRS (Federal Inland Revenue Service)**: Financial records must be retained 7 years. VAT (7.5%) applies to transport services above threshold. Operators must file monthly returns.
- **VIO/FRSC (Vehicle Inspection Officers / Federal Road Safety Corps)**: Vehicles must carry valid roadworthiness certificates, insurance, and FRSC approvals. Digital manifests can support compliance checks at road stops.
- **CAAN / NIMET**: NIMET weather data is used for route disruption risk. CAAN has limited overlap with road transport.

**Trust and fraud patterns**:
- **Double-selling of seats**: Two agents on different devices simultaneously see the same seat as "available" and sell it. The atomic reservation system (D1 version locking) addresses this but only when online.
- **Receipt forgery**: Common where paper receipts are used. QR-coded digital receipts are a strong fraud deterrent.
- **Agent float fraud**: Agents collect cash but under-report sales. Digital reconciliation directly addresses this.
- **Ghost passengers**: Manifests may include fake names to inflate head counts. Digital boarding scan with QR verification closes this loop.
- **Identity fraud at checkpoints**: Passengers present someone else's booking. ID capture at POS and passenger name matching during boarding scan are the mitigation.

### 2.4 Market and Ecosystem Insights

- The Nigerian intercity bus market is fragmented — thousands of operators, no single dominant player with more than ~5% of routes.
- Digital transformation is accelerating: GUO, ABC, and Peace Mass Transit have basic booking apps, but their systems are aging and poorly mobile-optimized.
- Aggregation platforms (Buupass, Treepz/Shuttlers) have gained traction, primarily for commuter/shuttle services. Intercity remains under-digitized.
- There is no dominant interoperable seat inventory system — operators cannot currently sell seats through each other's systems.
- Parcel logistics adjacency is real and largely untapped by digital transport platforms.
- The corporate travel segment (oil companies, NGOs, government agencies) accounts for a disproportionate share of total intercity revenue but is almost entirely served by phone calls and bank transfers today.
- WhatsApp and USSD represent the two largest under-served booking channels: WhatsApp for smartphone users who won't use apps; USSD for feature phone users.

### 2.5 Product Implications for Transport Software

- Every feature must be designed for 2G minimum. Payload size, request count, and image weight matter enormously.
- The receipt is a trust artifact. It must look professional, carry a unique ID, and be verifiable.
- Offline capability is non-negotiable — it is the primary mode for agents at many parks.
- Seat assignment matters deeply to passengers on luxury routes. Seat class (window, aisle, front, VIP) is a direct revenue opportunity.
- Real-time seat availability is a strong competitive advantage — most operators still coordinate by phone.
- Driver and vehicle compliance documentation should be managed in the platform to build trust with regulators.
- Parcel/logistics integration with the WebWaka logistics repo is a natural revenue extension.
- Language localization (Yoruba, Igbo, Hausa) is a genuine conversion driver, not just a compliance item.
- Subscription tiers must be carefully calibrated: the basic tier must be good enough to onboard small operators, while the enterprise tier must justify its cost through measurable revenue impact (dynamic pricing, white-label, API access).

---

## 3. Top 20: Seat Inventory Synchronization Enhancements

### S-01: Boarding Scan Anti-Replay Lock ✦ NEW
**Title**: Atomic boarding scan with row-level locking to prevent double-scan  
**Description**: The current `POST /api/operator/trips/:id/board` endpoint checks `boarded_at IS NULL` but does not use a D1 transaction or row-lock, meaning two simultaneous scans of the same QR (e.g., two inspectors scanning at the gate simultaneously) could both succeed. Wrap the check-and-update in a D1 transaction with a `WHERE boarded_at IS NULL` guard in the `UPDATE` statement, and verify `changes > 0`.  
**Why it matters**: Double-boarding marks a passenger as boarded twice, creating a false manifest state and potentially allowing unauthorized passengers to board using already-scanned QR codes.  
**Implementation**: Replace the current `SELECT + UPDATE` pattern with a single `UPDATE ... WHERE boarded_at IS NULL`, then check `meta.changes`. Return 409 if changes = 0.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Critical

---

### S-02: Server-Side Rate Limiting on Reservation Endpoints
**Title**: Rate limiting on `reserve`, `reserve-batch`, and `confirm` endpoints  
**Description**: Add a sliding-window rate limiter using `SESSIONS_KV` on the seat reservation endpoints, keyed on `ip + trip_id`. Limit: 20 reserve requests per IP per minute per trip. Return HTTP 429 with a `Retry-After` header on breach.  
**Why it matters**: The reserve endpoint is the highest-value endpoint in the system. Without rate limiting, a bad actor can hammer it to hold all seats simultaneously (seat hoarding attack), effectively blocking legitimate customers from booking.  
**Implementation**: Mirror the existing OTP rate-limiter pattern in `auth.ts`. Key: `rate:reserve:{ip}:{tripId}`. Count + TTL in `SESSIONS_KV`.  
**Reuse/Integration**: The rate-limiter pattern can be extracted to `@webwaka/core` as `requireRateLimit(kv, key, limit, windowSeconds)`.  
**Dependencies**: None.  
**Priority**: Critical

---

### S-03: Seat Inventory Event to Logistics Repo (Parcel Seat Blocking)
**Title**: Consume `parcel.seats_required` events from the logistics repo to block cargo capacity  
**Description**: The logistics repo emits `parcel.seats_required` when a confirmed parcel shipment needs to ride a specific bus. Wire `drainEventBus()` to handle this event: validate the trip exists, call the seat-blocking logic for the requested seat IDs or cargo hold indicator, and respond with a `parcel.seats_confirmed` or `parcel.seats_rejected` event.  
**Why it matters**: Without this integration, the transport and logistics systems are decoupled in theory but uncoordinated in practice. Bus cargo capacity (parcel revenue) is currently invisible to the seat inventory system.  
**Implementation**: Add `parcel.seats_required` handler in `drainEventBus()`. Implement a `blockSeatsForParcel(tripId, seatIds, reason='parcel')` helper that calls the existing `S-08` bulk-block logic.  
**Reuse/Integration**: Integration with logistics repo via event bus. Do NOT rebuild parcel management here. Transport emits `parcel.seats_confirmed|rejected` back to the event bus.  
**Dependencies**: S-08 (bulk seat block).  
**Priority**: Critical

---

### S-04: Seat Inventory Snapshot at Departure
**Title**: Immutable seat state snapshot at trip departure for audit and dispute resolution  
**Description**: When a trip transitions to `in_transit` (boarding scan complete → trip departs), automatically write the current seat states to an immutable `seat_snapshots` table. Snapshot is append-only and never modified.  
**Why it matters**: When a passenger dispute arises ("I paid for seat 14 but someone was sitting there"), there is currently no immutable record of who held seat 14 at departure time. A snapshot at departure resolves disputes quickly and definitively.  
**Implementation**: New `seat_snapshots` table: `trip_id`, `snapshot_at`, `trigger` (manual / auto_departure), `snapshot_data` (JSON). Triggered by the `in_transit` state transition handler.  
**Reuse/Integration**: Build in this repo. SUPER_ADMIN and TENANT_ADMIN access only.  
**Dependencies**: None.  
**Priority**: High

---

### S-05: Delta-Based Seat Availability Sync (Incremental Polling)
**Title**: `since` parameter for availability endpoint returning only changed seat rows  
**Description**: Add `GET /api/seat-inventory/trips/:id/availability?since=<timestamp>` returning only seat rows where `updated_at > since`. Agents cache seats locally and sync only the delta on reconnect.  
**Why it matters**: On a 50-seat bus at a busy Lagos park with 10 agents polling every 30 seconds on 2G, each full-map poll is ~5KB. At 10 agents × 2 polls/min × 60 minutes = 1200 requests. Delta sync reduces each response to 1–3 rows in most cases, cutting data consumption by 90%.  
**Implementation**: Add `updated_at` filter in the availability query (index already exists). Return `{ seats: [...], as_of: timestamp }`. Client sends `since=as_of` on next poll.  
**Reuse/Integration**: SyncEngine uses this in offline-to-online transition.  
**Dependencies**: None.  
**Priority**: High

---

### S-06: Optimistic Locking Version Enforcement
**Title**: Server-side `version` precondition enforcement on all seat mutations  
**Description**: The `seats` table carries a `version` column incremented on every update but not currently enforced as a precondition on `PATCH` requests. Require the client to submit the current `version`. Reject mutations where the submitted version does not match the DB version with HTTP 409.  
**Why it matters**: Without version enforcement, two offline agents can both read version 3 of a seat, modify it independently, and both succeed on sync — silently overwriting each other. This is the canonical optimistic locking gap.  
**Implementation**: Add `AND version = ?` to `WHERE` clauses on all seat `UPDATE` statements. Return 409 with `{ error: 'version_conflict', current_version: N }` on mismatch.  
**Reuse/Integration**: Build in this repo. Propagate to SyncEngine conflict handling.  
**Dependencies**: Conflict resolution UI (A-09 in agent enhancements).  
**Priority**: High

---

### S-07: Seat History Timeline per Seat
**Title**: Full audit trail for each seat's state transitions  
**Description**: Record every state transition for every seat in an immutable `seat_history` append-only log table, with timestamp, actor ID, actor role, and reason. Expose via `GET /api/seat-inventory/trips/:id/seats/:seatId/history`.  
**Why it matters**: Dispute resolution currently requires inferring history from partial data. A seat timeline gives SUPER_ADMIN and TENANT_ADMIN a complete chain of custody.  
**Implementation**: New `seat_history` table: `id, seat_id, trip_id, from_status, to_status, actor_id, actor_role, reason, at_ms`. Insert trigger in all seat update endpoints.  
**Reuse/Integration**: Build in this repo. SUPER_ADMIN and TENANT_ADMIN access only.  
**Dependencies**: None.  
**Priority**: High

---

### S-08: Seat Block/Unblock with Reason Codes
**Title**: Bulk seat blocking for maintenance, staff, VIP hold, or parcel cargo  
**Description**: `POST /api/seat-inventory/trips/:id/block` and `.../unblock` accepting arrays of seat IDs and a `reason` (maintenance, staff, vip_hold, driver_seat, parcel). Blocked seats are visible in the seat map with a reason indicator.  
**Why it matters**: Operators routinely block certain seats (driver companion, load inspector, VIP guest, parcel cargo). Currently there is no way to mark a seat as blocked with a traceable reason.  
**Implementation**: Add `blocked_by`, `blocked_reason`, `blocked_at` columns to `seats` (migration). Batch `UPDATE` via D1 batch.  
**Reuse/Integration**: Build in this repo. Required by S-03 (parcel integration).  
**Dependencies**: None.  
**Priority**: Medium

---

### S-09: Cross-Operator Seat Exchange Protocol
**Title**: Inter-operator seat inventory sharing for code-sharing/interline bookings  
**Description**: Define and implement a protocol by which WebWaka SUPER_ADMIN can expose available seats from one operator's trip to another operator's booking portal. Opt-in per operator. Revenue split configured per partnership.  
**Why it matters**: Popular routes are overbooked on some operators and underbooked on others simultaneously. Seat exchange allows passengers to be rerouted to the next available operator without leaving the platform.  
**Implementation**: Add `interline_enabled` flag to operators. `operator_partnerships` table (O-11 pre-requisite). Cross-tenant availability query gated on SUPER_ADMIN. Interline booking record referencing two `operator_id` values.  
**Reuse/Integration**: Build in this repo. Requires O-11.  
**Dependencies**: O-11 (partnership management).  
**Priority**: Medium

---

### S-10: Seat Availability SSE Stream for Booking Portal
**Title**: Server-Sent Events fallback stream for seat updates (no WebSocket required)  
**Description**: Implement `GET /api/seat-inventory/trips/:id/live` as an SSE endpoint for environments where WebSocket is unavailable or firewalled (common in NGO/corporate networks). Pushes `seat_changed` events as the DO broadcasts them.  
**Why it matters**: The `TripSeatDO` WebSocket is the primary real-time channel, but some corporate proxies and older mobile browsers block WebSocket. SSE uses HTTP and passes through almost all proxies.  
**Implementation**: SSE endpoint using Cloudflare Workers `ReadableStream`. Subscribe to the same `TripSeatDO` event stream. The existing WS polling fallback in `useLiveSeatUpdates` can try SSE before falling back to HTTP polling.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Medium

---

### S-11: Vehicle Swap Seat Remapping
**Title**: Automatic seat remapping when the vehicle assigned to a trip changes  
**Description**: When an operator changes the vehicle on a trip (bus breakdown, swap), automatically remap confirmed bookings to equivalent positions in the new vehicle and notify affected passengers.  
**Why it matters**: Vehicle swaps mid-operation are extremely common in Nigeria. Without remapping, confirmed bookings reference seat IDs that no longer exist on the new vehicle, causing boarding chaos.  
**Implementation**: `PATCH /api/operator/trips/:id` vehicle change triggers a remapping job: seats beyond new capacity are cancelled (with notification), remaining seats are remapped by position number.  
**Reuse/Integration**: Build in this repo. Notification delivery via shared service.  
**Dependencies**: Notification service.  
**Priority**: Medium

---

### S-12: Seat Inventory Fill Rate Forecast
**Title**: AI-assisted seat fill rate forecast for operators  
**Description**: Use historical booking data per route and time-of-day to generate a 7-day fill rate forecast visible to operators. Expose via `GET /api/operator/routes/:id/forecast`.  
**Why it matters**: Operators under-schedule on high-demand days and over-schedule on low-demand days. A forecast gives them data to right-size fleet allocation, reducing cost and increasing revenue.  
**Implementation**: Rolling 4-week average fill rates per route and day-of-week. Optionally enhance with OpenRouter for anomaly commentary. Build in this repo.  
**Reuse/Integration**: OpenRouter already wired (vendor-neutral).  
**Dependencies**: Historical data accumulation (at least 4 weeks of trips).  
**Priority**: Medium

---

### S-13: Conflict Resolution UI for Sync Conflicts
**Title**: Prominent agent-facing seat conflict resolution panel  
**Description**: Surface the Dexie `conflict_log` as a notification badge and panel in the Agent POS. Allow agents to retry, accept the server's state, or discard their local mutation.  
**Why it matters**: When an agent sells a seat offline and sync discovers it was already sold, the conflict is silently logged. Agents have no visibility. This leads to double-selling disputes resolved manually.  
**Implementation**: `ConflictLog` component exists in `src/components/conflict-log.tsx`. Promote to a primary notification badge in the Agent POS. Wire `resolveConflict()` to retry/accept/discard buttons.  
**Reuse/Integration**: Build in this repo (frontend only).  
**Dependencies**: S-06 (version locking generates conflicts).  
**Priority**: Medium

---

### S-14: Waiting List Auto-Escalation
**Title**: Waiting list with multi-step escalation and expiry  
**Description**: Extend the current waiting list implementation with configurable escalation: notify passenger 1 → if no response in 10 minutes, notify passenger 2 → and so on. Passengers who don't respond lose their queue position. Operator can configure the window.  
**Why it matters**: The current waiting list notifies the next person but does not escalate if they don't respond. A seat can sit unclaimed for 10+ minutes while other waitlisted passengers don't know about it.  
**Implementation**: Add `notified_at`, `responded_at`, `expires_at` columns to `waiting_list`. `sweepWaitingList()` escalates on `expires_at` breach.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Waiting list table (already implemented in P13).  
**Priority**: Medium

---

### S-15: Seat Map Visual Layout API
**Title**: Structured seat map layout API for front-end bus interior rendering  
**Description**: Extend the availability response to include a structured layout (rows, columns, aisle positions) derived from the vehicle's seat configuration template. This enables the frontend to render an accurate visual bus interior instead of a flat grid.  
**Why it matters**: Passengers strongly prefer selecting seats by visual position (window/aisle/front/back) rather than by number. This is a booking conversion driver for the customer portal.  
**Implementation**: Add `seat_layout` JSON column to `vehicles`. Return `layout` alongside `seats` in availability response.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Vehicle seat template (already partially implemented as P08-T1).  
**Priority**: Medium

---

### S-16: Parcel Capacity Tracking on Seats
**Title**: Dedicated cargo bay / parcel seat tracking separate from passenger seats  
**Description**: Add a `seat_type: 'passenger' | 'cargo'` distinction to seats. Allow operators to define X cargo seats on a bus. Booking portal only shows passenger seats. Parcel integration uses cargo seats.  
**Why it matters**: Currently parcel cargo is not tracked in the seat inventory at all — operators informally load parcels without accounting for the space. This causes overloading and manifest compliance failures.  
**Implementation**: Add `seat_type` column to `seats`. Generate cargo seats from vehicle template alongside passenger seats. Filter by `seat_type = 'passenger'` in public availability queries.  
**Reuse/Integration**: Build in this repo. Required for logistics integration (S-03).  
**Dependencies**: S-03, S-08.  
**Priority**: Low

---

### S-17: Multi-Leg Journey Seat Reservation
**Title**: Multi-leg journey booking with through-seat reservation  
**Description**: Allow passengers to book a continuous journey across multiple trips (e.g., Lagos → Ibadan on Trip A, then Ibadan → Abuja on Trip B) with a single booking record. Each leg reserves a seat independently; cancellation of one leg cancels both.  
**Why it matters**: Many journeys in Nigeria require a change at an intermediate city (e.g., Port Harcourt → Abuja via Enugu). Passengers currently have to book each leg separately with no guaranteed connection.  
**Implementation**: New `journey` entity linking multiple `booking_id` values. Cancellation cascade across all legs.  
**Reuse/Integration**: Build in this repo. Multi-stop routes (already implemented) are a prerequisite.  
**Dependencies**: Multi-stop routes (P11-T3).  
**Priority**: Low

---

### S-18: Seat Inventory API for Third-Party Aggregators
**Title**: Public seat inventory API for aggregator platforms (Buupass, Treepz, etc.)  
**Description**: Expose a read-only public API for seat availability per route per day, accessible via API key (operator-scoped, pro tier). Aggregators can query this to display WebWaka operator seats on their platforms.  
**Why it matters**: Aggregator platforms drive significant ticket volume in Nigeria. Being listed on Buupass or Treepz immediately exposes operators to their existing user base.  
**Implementation**: New `GET /api/public/availability` accepting operator `api_key` in header. Returns trips with seat counts by class. Rate-limited to 60 req/min.  
**Reuse/Integration**: Build in this repo. API key authentication already implemented (P11-T1).  
**Dependencies**: API keys (P11-T1).  
**Priority**: Low

---

### S-19: Seat Overbooking Safety Net
**Title**: Configurable overbooking allowance with automatic waitlist upgrade  
**Description**: Allow operators to configure an overbooking factor (e.g., 5% above capacity) per route to hedge against no-shows, with automatic downgrade to waiting list if all overbooked seats show up.  
**Why it matters**: No-show rates on Nigerian intercity buses are 5–15% (particularly on routes with flexible departure times). Overbooking recovers this revenue without stranding passengers if managed with a clear policy.  
**Implementation**: Add `overbooking_factor` to operator config. Reserve endpoint allows `confirmed` count to exceed `total_seats × (1 + factor)`. On gate boarding, trigger automatic downgrade protocol with compensation.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: S-01 (multi-seat atomic reservation).  
**Priority**: Low

---

### S-20: Seat Price Lock-In at Reservation
**Title**: Lock the effective fare at reservation time, not at booking confirmation  
**Description**: When a seat is reserved, record the `locked_fare_kobo` in the seat row. If dynamic pricing or the fare matrix changes between reservation and confirmation, the passenger pays the locked fare.  
**Why it matters**: With dynamic pricing active, the fare can increase between the time a passenger reserves and the time they complete payment (especially in sessions with extended TTL). A fare lock-in is a trust guarantee.  
**Implementation**: Add `locked_fare_kobo` to `seats` (or `seat_holds`). Populate it on reserve. Use `locked_fare_kobo` in booking creation validation instead of recomputing.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Dynamic pricing (P12/B-18 already implemented).  
**Priority**: Low

---

## 4. Top 20: Offline Agent Sales / Bus Park POS Enhancements

### A-01: Boarding Scan from Agent POS
**Title**: Agent-triggered QR boarding scan without a dedicated dispatcher device  
**Description**: Allow agents (not just supervisors) to scan passenger QR codes at the bus gate from the Agent POS module. The scan calls `POST /api/operator/trips/:id/board` and shows a green/red response immediately.  
**Why it matters**: At smaller parks, the agent IS the gate controller. Requiring a separate supervisor device is a barrier. Allowing the agent POS to double as a boarding scanner collapses two roles into one workflow.  
**Implementation**: Add a "Scan & Board" tab to the Agent POS. Reuse the existing browser camera QR scanner (already wired in A-11 trip quick-select). Call the existing board endpoint.  
**Reuse/Integration**: Build in this repo (frontend). Backend endpoint already implemented.  
**Dependencies**: None.  
**Priority**: Critical

---

### A-02: Offline Transaction Recovery Dashboard
**Title**: Agent-visible recovery panel showing pending, synced, and failed offline transactions  
**Description**: Display a dedicated "Sync Status" screen in the Agent POS showing: number of transactions pending sync, transactions that failed sync with reason, and successfully synced transactions from the last shift. Allow manual retry of failed items.  
**Why it matters**: Agents currently have no visibility into whether their offline sales have been synced. When a supervisor reconciles the day's float and finds missing transactions, the agent has no evidence to the contrary.  
**Implementation**: Read from Dexie `transactions` and `mutations` tables. Filter by `sync_status`. Wire "Retry" button to `syncEngine.flush()`.  
**Reuse/Integration**: Build in this repo (frontend only).  
**Dependencies**: None.  
**Priority**: Critical

---

### A-03: Multi-Currency Payment at POS
**Title**: Agent POS support for USD and GBP payments from diaspora passengers  
**Description**: Allow agents to record sales in USD or GBP (for diaspora passengers paying in foreign currency) with a configurable exchange rate set per operator. Convert to kobo at the configured rate for storage and reconciliation.  
**Why it matters**: Passengers returning to Nigeria from the diaspora often carry foreign currency and prefer to pay at the park without currency exchange delays. Agents currently handle this ad hoc with no tracking.  
**Implementation**: Add `payment_currency` and `exchange_rate` fields to sales transactions. Operator config sets supported currencies and their exchange rates (refreshed daily). Store `amount_kobo` always in NGN equivalent.  
**Reuse/Integration**: Build in this repo. Exchange rates could be pulled from a shared currency service or hardcoded per operator.  
**Dependencies**: None.  
**Priority**: High

---

### A-04: Agent Geo-Fencing for Park Verification
**Title**: Optional GPS geo-fence check to verify agent is physically at their assigned park  
**Description**: On agent login and periodically during shifts, check the device's GPS coordinates against the registered park coordinates. If the agent is outside the geo-fence, flag the session and alert the supervisor.  
**Why it matters**: Remote ticket selling (agents selling seats from locations other than the park) is a form of revenue leakage and fraud. Geo-fencing provides a soft enforcement layer.  
**Implementation**: Use browser `navigator.geolocation`. Compare against `bus_parks.lat/lng` with a configurable radius (default 500m). Flag in transaction record. Non-fatal if GPS unavailable.  
**Reuse/Integration**: Build in this repo. Bus park coordinates from A-07 (bus park registry, already implemented as part of P11).  
**Dependencies**: Bus park registry.  
**Priority**: High

---

### A-05: Agent Shift Management
**Title**: Formal shift start/end workflow with shift-scoped transaction reporting  
**Description**: Add a shift management flow: agent starts a shift (records start time, opening float, park), ends a shift (records end time, cash submitted). All transactions between start and end are shift-scoped. Supervisor sees shift report per agent.  
**Why it matters**: Currently reconciliation is by calendar day. Agents often work partial days or overlap shifts. A shift-scoped report matches how supervisors actually manage float accountability.  
**Implementation**: New `agent_shifts` table: `agent_id, park_id, started_at, ended_at, opening_float_kobo, closing_float_kobo`. `POST /api/agent-sales/shifts/start|end`. Transactions tagged with `shift_id`.  
**Reuse/Integration**: Build in this repo. Extends float reconciliation (A-03 already implemented in P07).  
**Dependencies**: None.  
**Priority**: High

---

### A-06: WhatsApp Receipt Sharing from Agent POS ✦ (Promote to implementation)
**Title**: One-tap WhatsApp receipt sharing after agent sale  
**Description**: After completing a sale, show a "Share via WhatsApp" button that deep-links to `wa.me/?text=...` with the receipt details (passenger name, route, seat, amount, receipt ID, verification link) pre-filled. No WhatsApp Business API needed.  
**Why it matters**: WhatsApp is the primary communication channel for Nigerian passengers. Sharing a digital receipt via WhatsApp is faster and more trusted than a handwritten paper receipt.  
**Implementation**: Construct a URL-encoded WhatsApp message from receipt data. Use the `wa.me/?text=` deep link. Zero backend work required.  
**Reuse/Integration**: Build in this repo (frontend only).  
**Dependencies**: Receipt data from agent sale response.  
**Priority**: High

---

### A-07: Supervisor Remote Sales Monitor
**Title**: Real-time supervisor view of all agent sales at the park  
**Description**: Give supervisors a live view of all agent transactions as they happen, filterable by agent and trip, with running revenue totals. Refreshed every 30 seconds or via SSE push.  
**Why it matters**: Supervisors currently walk from agent to agent to verify sales. A digital board gives them floor-wide visibility without leaving their post.  
**Implementation**: `GET /api/agent-sales/transactions` already exists with agent and trip filters. Frontend supervisor board with 30-second auto-refresh.  
**Reuse/Integration**: Build in this repo (frontend).  
**Dependencies**: None.  
**Priority**: High

---

### A-08: Agent Commission Statement and Payout Tracking
**Title**: Monthly agent commission statement with payout tracking  
**Description**: Generate a monthly commission statement per agent (total sales, commission rate, commission earned, payout status). Supervisor marks commissions as "paid" after cash disbursement.  
**Why it matters**: Commission disputes are the most common agent grievance. A digital commission statement that both agent and supervisor can see eliminates the most common source of conflict.  
**Implementation**: Add `commission_rate` to agents (already planned in A-06). New `commission_payouts` table: `agent_id, period, commission_earned_kobo, paid_at, paid_by`. `GET /api/agent-sales/commissions/:agent_id?month=2026-04`.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Float reconciliation (P07-T3).  
**Priority**: High

---

### A-09: Agent Conflict Resolution Panel
**Title**: Agent-facing UI for resolving offline sync conflicts  
**Description**: Surface the Dexie `conflict_log` as a notification badge and resolution panel. Agent sees which mutations failed to sync (e.g., seat already sold) and can retry, accept server state, or discard the local mutation.  
**Why it matters**: Conflicts currently are silently logged. Agents discover them when a supervisor asks why a transaction is missing. A visual resolution panel gives agents agency and produces a better audit trail.  
**Implementation**: `ConflictLog` component already exists. Promote it to a primary badge + drawer in the Agent POS. Wire resolution actions to `resolveConflict()` in `db.ts`.  
**Reuse/Integration**: Build in this repo (frontend only).  
**Dependencies**: None.  
**Priority**: Medium

---

### A-10: Offline Authentication Grace Window Configuration
**Title**: Operator-configurable offline auth grace period for extended offline shifts  
**Description**: Allow operators to configure the offline JWT grace window (default 8 hours, configurable 1–24 hours) via operator config. Grace window is stored in `TENANT_CONFIG_KV` and cached in Dexie `operator_config`.  
**Why it matters**: An agent who starts their shift online but loses connectivity for a long road-accompanied journey should not be locked out when their 1-hour JWT expires. The configurable grace window matches the operator's actual shift lengths.  
**Implementation**: Read `offline_auth_grace_ms` from Dexie `operator_config`. Fall back to 8 hours. Display warning banner when operating in grace period.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Medium

---

### A-11: Bus Park Terminal Registry
**Title**: Formal bus park and terminal entity with GPS coordinates and operator associations  
**Description**: New `bus_parks` table: name, city, state, GPS coordinates, operator associations. Assign agents to one or more parks. Filter trip and seat views by park. Show "sell at this park" information on the customer portal.  
**Why it matters**: Large operators have agents at multiple parks simultaneously. Currently park assignment is a raw JSON string on agents. A proper park registry enables per-park analytics, agent deployment, and passenger-facing "buy at Ojota" information.  
**Implementation**: New `bus_parks` table. `agent_bus_parks` junction table. Add `park_id` filter to trip queries. Customer portal shows the nearest park selling a given route.  
**Reuse/Integration**: Build in this repo. Park location data shared with booking portal.  
**Dependencies**: None.  
**Priority**: Medium

---

### A-12: Trip QR Code at Bus Gate
**Title**: Printable bus gate QR poster for quick trip selection by agents  
**Description**: Generate a printable QR code for each trip that can be posted at the bus. Agents scan this QR to instantly load that trip into the POS, bypassing the trip dropdown.  
**Why it matters**: At a busy park with 20+ buses running simultaneously, finding the right trip in a dropdown is slow and error-prone. A QR scan is instant and eliminates wrong-trip mistakes.  
**Implementation**: `GET /api/operator/trips/:id/gate-qr` returns an HTML page with a QR code encoding the trip ID. Print-optimized CSS. QR scanning already wired from A-11 trip quick-select.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: QR library (already in use for receipts).  
**Priority**: Medium

---

### A-13: High-Contrast Outdoor Mode for Agent POS
**Title**: High-contrast / outdoor display mode for agents in direct sunlight  
**Description**: Add a high-contrast display mode (dark background, large high-contrast text, oversized touch targets) optimized for agents using phones in direct noon sunlight at outdoor parks.  
**Why it matters**: Standard web UI contrast ratios are unreadable in direct outdoor sunlight in Nigeria. This is a genuine usability issue that affects transaction speed and error rate.  
**Implementation**: Add `prefers-contrast: more` media query + a manual toggle stored in Dexie `operator_config`. CSS variables for the color scheme switch.  
**Reuse/Integration**: Build in this repo (frontend).  
**Dependencies**: None.  
**Priority**: Medium

---

### A-14: Operator → Agent Broadcast Messaging
**Title**: In-app broadcast messages from operators to all active agents  
**Description**: Enable operators (TENANT_ADMIN, SUPERVISOR) to send broadcast messages to all active agents (e.g., "Bus 14 delayed 2 hours", "Price change for Abuja routes"). Messages appear as a notification banner in the POS.  
**Why it matters**: Currently operators communicate via personal WhatsApp — untracked and unreliable. In-app broadcasts create an audit trail of operational communications.  
**Implementation**: New `agent_broadcasts` table. `POST /api/agent-sales/broadcasts` (SUPERVISOR+). Agents pull unread broadcasts on login and sync. Display as dismissible banner.  
**Reuse/Integration**: Build in this repo. Optionally forward via SMS for offline agents.  
**Dependencies**: None.  
**Priority**: Medium

---

### A-15: Agent Wallet and Advance Payment
**Title**: Agent wallet for pre-loading cash float before shift  
**Description**: Allow supervisors to pre-load an agent's digital wallet with an opening float. The wallet decrements on cash sales and the agent settles at end of shift. Wallet balance is visible to supervisor in real-time.  
**Why it matters**: Some operators pre-advance cash to agents (bus fare, emergency float). Without a digital wallet, this advance is tracked on paper and easily disputed.  
**Implementation**: New `agent_wallet` table: `agent_id, balance_kobo, last_updated_at`. `POST /api/agent-sales/wallet/credit` (SUPERVISOR+). Balance decrements on each cash sale transaction. Reconciliation compares expected balance with agent's physical cash.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Float reconciliation (P07-T3).  
**Priority**: Medium

---

### A-16: Parcel Waybill at POS
**Title**: Agent POS parcel waybill recording for bus-carried parcels  
**Description**: Allow agents to record parcel shipments (sender name, receiver phone, destination, package weight, fee) at the POS alongside passenger ticket sales. Generate a waybill number. Publish a `parcel.waybill_created` event to the event bus for the logistics repo.  
**Why it matters**: Parcels are already riding every intercity bus. Without a waybill system, operators miss a 10–20% revenue stream and have no record if a parcel is lost.  
**Implementation**: New `parcel_waybills` table (transport-side only). Record basic parcel details. Publish event to logistics repo. Do NOT build parcel tracking here — that's in the logistics repo.  
**Reuse/Integration**: Event bus integration with logistics repo. Transport owns waybill creation; logistics owns tracking.  
**Dependencies**: Logistics repo event schema.  
**Priority**: Low

---

### A-17: Agent POS Accessibility Mode (Large Font + Voice)
**Title**: Accessibility mode for agents with vision impairment or low literacy  
**Description**: Add a large-font, simplified POS mode that uses the Web Speech API for voice prompts ("Select a trip", "Confirm seat 14, ₦4,500"). This also serves as a low-literacy fallback for agents who struggle with reading.  
**Why it matters**: Not all agents are highly literate. A simplified, voice-guided POS mode dramatically reduces training time and error rate for new agents.  
**Implementation**: ARIA-labeled POS components. Web Speech API for voice prompts on key actions. Large-button mode toggle in agent settings.  
**Reuse/Integration**: Build in this repo (frontend).  
**Dependencies**: None.  
**Priority**: Low

---

### A-18: Cross-Park Transfer for Passengers
**Title**: Agent-initiated passenger transfer between parks for the same route  
**Description**: Allow an agent to transfer a passenger's booking to a different park departure (same route, different terminal) when the original terminal is overbooked or the passenger missed their departure.  
**Why it matters**: "My bus is full but there's another one leaving from Jibowu in 1 hour" is a daily occurrence. Without a formal transfer mechanism, the agent cancels and re-books — losing the passenger's reservation priority and generating a refund.  
**Implementation**: `POST /api/booking/bookings/:id/transfer` accepting a new `trip_id`. Validate same route, new trip has availability, original booking is confirmed. Atomic seat transfer.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Low

---

### A-19: Offline Parcel Tracking Cache
**Title**: Agent offline cache for parcel waybill lookup  
**Description**: Cache recent parcel waybills in Dexie so agents can look up parcel status (in transit / delivered / at destination) for customers asking at the park, even when offline.  
**Why it matters**: Customers frequently come to the park to ask about parcels sent on a previous trip. Without offline cache, the agent can't answer when the network is down.  
**Implementation**: Sync recent parcel waybill statuses (from logistics repo events via event bus) into Dexie. Display in Agent POS waybill lookup panel.  
**Reuse/Integration**: Integration with logistics repo via event bus. Transport receives `parcel.status_updated` events.  
**Dependencies**: A-16 (parcel waybill at POS).  
**Priority**: Low

---

### A-20: Onboarding Tutorial and In-App Agent Training
**Title**: Interactive in-app tutorial for new agents on first login  
**Description**: A guided walkthrough that shows a new agent how to: select a trip, view the seat map, sell a ticket, share the receipt via WhatsApp, and handle an offline sale. Triggered automatically on first login and accessible from settings.  
**Why it matters**: Agent training is the biggest onboarding bottleneck for new operators. Training costs money and time. An in-app tutorial reduces training time from days to hours for new agents.  
**Implementation**: Frontend tutorial overlay using a lightweight step-through tooltip library. Triggered by `first_login` flag in `agent_sessions`. Skippable. Progress saved in Dexie.  
**Reuse/Integration**: Build in this repo (frontend only).  
**Dependencies**: None.  
**Priority**: Low

---

## 5. Top 20: Customer Booking Portal Enhancements

### B-01: Paystack Inline Payment with Pre-Populated Fields
**Title**: Streamline Paystack inline popup with pre-populated passenger email and phone  
**Description**: When initiating payment, pass `email` and `phone` to the Paystack inline popup pre-populated from the customer's profile, eliminating the extra data-entry step on the payment page.  
**Why it matters**: Every extra field on a payment page increases abandonment. Pre-populating email (derived from `phone@pay.webwaka.ng` or stored email) and phone removes friction at the highest-drop-off point.  
**Implementation**: Pass `customer.email` and `customer.phone` to the Paystack popup `customer` parameter. Derive email from phone if not stored.  
**Reuse/Integration**: Build in this repo (frontend).  
**Dependencies**: Customer profile (B-20).  
**Priority**: Critical

---

### B-02: WhatsApp Booking Channel
**Title**: Book a seat via WhatsApp chatbot flow  
**Description**: A webhook handler for WhatsApp Business API that guides passengers through: origin/destination search → trip selection → seat selection → Paystack payment link → confirmation. Runs entirely within WhatsApp. Session state in `SESSIONS_KV`.  
**Why it matters**: WhatsApp penetration in Nigeria is near 100% among smartphone users. Passengers who won't install an app will readily interact via WhatsApp. This channel dramatically expands addressable reach.  
**Implementation**: WhatsApp webhook endpoint (via Termii/Twilio WhatsApp gateway). Translate messages to existing booking portal API calls. Session state in `SESSIONS_KV`.  
**Reuse/Integration**: All booking logic already built. Gateway is a new dependency.  
**Dependencies**: WhatsApp Business API account.  
**Priority**: Critical

---

### B-03: Accessible Booking Portal (WCAG 2.1 AA)
**Title**: Full WCAG 2.1 AA accessibility compliance with voice guidance  
**Description**: Ensure the booking portal passes WCAG 2.1 AA standards: ARIA labels, semantic HTML, keyboard navigation, focus management, and screen reader support. Add an optional voice-guidance mode using Web Speech API.  
**Why it matters**: Accessibility is a legal obligation and a market opportunity. A voice-guided booking flow also serves passengers in low-literacy contexts or with visual impairment — a significant underserved population.  
**Implementation**: ARIA audit on all booking flow components. `aria-live` regions for dynamic content. Web Speech API voice prompts as optional overlay. Auto-detect preference from `prefers-reduced-motion` and screen reader detection.  
**Reuse/Integration**: Build in this repo (frontend only).  
**Dependencies**: None.  
**Priority**: High

---

### B-04: Passenger Self-Service Name Correction
**Title**: Allow passengers to edit passenger names on confirmed bookings before departure  
**Description**: Allow customers to update `passenger_names` on a confirmed booking (cutoff: 2 hours before departure). Handles name corrections and family name transfers without a full cancellation.  
**Why it matters**: Name correction is the most common customer support request after booking. Without self-service editing, every correction requires agent intervention, generating support cost.  
**Implementation**: `PATCH /api/booking/bookings/:id` accepts `passenger_names` as an updatable field with a departure-time cutoff check. Return 422 if past cutoff.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: High

---

### B-05: Booking Insurance Upsell
**Title**: Optional travel insurance add-on at checkout  
**Description**: Partner with a Nigerian insurtech (HeiDi, Curacel, Leadway Assurance) to offer optional trip insurance at checkout (₦200–₦500 per booking, covering delays, accidents, luggage loss). Embedded as a checkbox in the booking flow.  
**Why it matters**: Insurance penetration in Nigerian transport is near zero. Passengers paying online are more open to protection products. This is a direct revenue share opportunity for WebWaka.  
**Implementation**: Add `insurance_selected` and `insurance_premium_kobo` to bookings. Integrate with insurer's API to issue policy on confirmed bookings. Policy number included in SMS/e-ticket.  
**Reuse/Integration**: New dependency (insurtech API). Build integration wrapper in this repo.  
**Dependencies**: B-06 (e-ticket with policy reference).  
**Priority**: High

---

### B-06: Enhanced E-Ticket with Policy and Emergency Info
**Title**: Rich e-ticket page including insurance policy, emergency contact, and route map  
**Description**: Extend the `/b/:bookingId` e-ticket page with: insurance policy number (if purchased), operator emergency contact, estimated journey waypoints, and a static route map image.  
**Why it matters**: The e-ticket is the passenger's primary trust artifact during travel. More information on it (especially emergency contacts) increases passenger confidence and reduces support calls.  
**Implementation**: Extend the existing e-ticket HTML template. Fetch operator emergency contact from `TENANT_CONFIG_KV`. Static map from a tile API (e.g., Mapbox static image URL).  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: B-05 (insurance), D-04 (route coordinates).  
**Priority**: High

---

### B-07: Complete Vernacular Localization (Yoruba, Igbo, Hausa)
**Title**: Full Yoruba, Igbo, and Hausa localization of the booking portal  
**Description**: Complete the i18n implementation for all customer-facing strings in the booking portal (search form, seat selection, payment flow, confirmation screen, e-ticket). The i18n module supports 4 languages but many strings are English-only.  
**Why it matters**: A significant share of intercity passengers are more comfortable in their mother tongue. Yoruba (Southwest), Igbo (Southeast), and Hausa (North) together cover the majority of the target passenger base.  
**Implementation**: Full audit of all i18n string keys in the booking flow. Add missing translations for Yoruba, Igbo, and Hausa. Auto-detect from `navigator.language`.  
**Reuse/Integration**: Build in this repo. i18n module already in place.  
**Dependencies**: None.  
**Priority**: High

---

### B-08: Trip Status Tracking for Booked Passengers
**Title**: Real-time trip state and GPS location display on booking detail screen  
**Description**: Expose trip state (`scheduled`, `boarding`, `in_transit`, `completed`) and GPS location on the passenger's booking detail screen. Push a notification when the trip transitions to `boarding`.  
**Why it matters**: "Where is my bus?" is the single most common passenger support query. A live status screen eliminates most of these contacts.  
**Implementation**: `GET /api/booking/bookings/:id` already joins trip data. Add `trip.state`, `trip.current_latitude/longitude`, `trip.delay_reason_code` to the response. Push notification on `boarding` state.  
**Reuse/Integration**: Build in this repo (frontend + minor API extension).  
**Dependencies**: D-04 (GPS update, implemented in P05).  
**Priority**: High

---

### B-09: Fare Calendar / Price Comparison View
**Title**: Passenger-facing fare calendar showing prices across departure dates  
**Description**: On the trip search results, show a 7-day fare calendar per route so passengers can choose a cheaper departure date. Cheapest day highlighted.  
**Why it matters**: Nigerian passengers are highly price-sensitive. Showing that Tuesday is ₦2,000 cheaper than Saturday strongly influences booking date decisions — this is a common feature on flight booking platforms that works equally well for buses.  
**Implementation**: `GET /api/booking/trips/search?origin=X&destination=Y&date_range=7d` returns available trips with fares for each day. Frontend renders a mini calendar with fare chips.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Dynamic pricing (P12).  
**Priority**: High

---

### B-10: AI-Powered Personalized Trip Recommendations
**Title**: Personalized trip recommendations for returning customers  
**Description**: For authenticated returning customers, show "Based on your past trips" personalized recommendations alongside search results. Uses booking history + OpenRouter to generate structured suggestions.  
**Why it matters**: Returning customers who see a personalized recommendation convert at much higher rates than those who see a generic search prompt. Personalization is a retention and conversion tool.  
**Implementation**: Fetch last 5 bookings. Pass route history and current time to OpenRouter. Return structured trip recommendations. Rate-limited and non-fatal.  
**Reuse/Integration**: OpenRouter abstraction already in `src/lib/ai.ts`. Vendor-neutral.  
**Dependencies**: Booking history view (already implemented).  
**Priority**: Medium

---

### B-11: Corporate Invoice and Statement Portal
**Title**: Corporate customer portal with invoice generation and payment statement  
**Description**: A dedicated view for corporate customers showing: all bookings by date range, subtotals by department/cost code, outstanding credit balance, and a printable invoice ready for accounts payable.  
**Why it matters**: Corporate travel buyers (oil company travel desks, NGO admin teams) require formal invoices for accounting. Without this, corporate customers pay by bank transfer but have no digital invoice to match against their records.  
**Implementation**: `GET /api/booking/corporate-accounts/:id/statement` already implemented (P15). Build the frontend statement view with print CSS for A4 invoice layout.  
**Reuse/Integration**: Build in this repo (frontend).  
**Dependencies**: Corporate accounts (P15-T3).  
**Priority**: Medium

---

### B-12: Repeat Booking One-Tap Shortcut
**Title**: "Book same route again" one-tap shortcut from booking history  
**Description**: In the booking history view, add a "Book again" button on past confirmed trips that pre-fills the search form with the same origin, destination, operator, and preferred departure time.  
**Why it matters**: Regular commuters (Lagos–Abuja weekly travelers, students, civil servants) are the highest-value passengers. One-tap rebooking dramatically reduces friction for this segment.  
**Implementation**: Frontend only. Extract last booking's route params and populate the trip search form state.  
**Reuse/Integration**: Build in this repo (frontend only).  
**Dependencies**: Booking history (already implemented).  
**Priority**: Medium

---

### B-13: Dynamic Pricing Display with Savings Indicator
**Title**: Show "Save ₦X by traveling on Tuesday" on the fare calendar  
**Description**: When dynamic pricing is active, show passengers how much they save by choosing a non-peak travel day. Frame it positively ("Save ₦1,500") rather than negatively ("Surcharge applies").  
**Why it matters**: Behavioral economics shows that saving framing converts better than surcharge framing. This drives more passengers toward non-peak departures, reducing the surge load on operators.  
**Implementation**: Compute `base_fare - effective_fare` on non-peak days. Display as a green savings chip on the fare calendar.  
**Reuse/Integration**: Build in this repo (frontend only).  
**Dependencies**: Dynamic pricing (P12), B-09 (fare calendar).  
**Priority**: Medium

---

### B-14: Passenger Preference Profile
**Title**: Saved passenger preferences (seat position, payment method, dietary, accessibility)  
**Description**: Allow authenticated passengers to save preferences: preferred seat position (window/aisle/front), default payment method, accessibility needs (wheelchair, extra legroom). Pre-fill these in the booking flow automatically.  
**Why it matters**: Repeat customers who have their preferences remembered convert faster with less friction. Accessibility needs also need to be communicated to operators before boarding.  
**Implementation**: Add `preferences` JSON column to `customers`. `PATCH /api/booking/customers/:id` to save preferences. Apply preferences to seat selection pre-selection and payment method default.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Medium

---

### B-15: USSD Booking Channel
**Title**: USSD-based ticket booking for feature phone users  
**Description**: Integrate with a Nigerian USSD gateway (Africa's Talking, Infobip) to offer a `*384*WEBWAKA#` USSD menu for booking tickets. Flow: route → date → trip → confirm → mobile money payment → SMS ticket.  
**Why it matters**: A significant portion of Nigerian intercity travelers use feature phones or have limited data. USSD works on any phone, on any network, without internet. It reaches the truly offline passenger.  
**Implementation**: USSD gateway webhook with session state in `SESSIONS_KV`. Each menu step maps to existing booking portal API calls. Payment via Paystack USSD flow. Already partially designed in P14.  
**Reuse/Integration**: New gateway dependency. All booking logic already exists.  
**Dependencies**: USSD gateway account, Paystack USSD payment.  
**Priority**: Medium

---

### B-16: Trip Search Push Notification on Availability
**Title**: Notify customers when a trip for their searched route becomes available  
**Description**: Allow customers to set a "notify me" alert on a searched route/date combination. When a matching trip is created by an operator, push a notification to all subscribers.  
**Why it matters**: Customers who search for a route with no results today are potential future buyers. Capturing their intent and notifying them on availability converts previously lost searches.  
**Implementation**: New `trip_availability_alerts` table: `customer_id, origin, destination, travel_date, notified_at`. Cron sweeper checks new trips against alert subscriptions.  
**Reuse/Integration**: Build in this repo. Push notification via existing VAPID.  
**Dependencies**: None.  
**Priority**: Medium

---

### B-17: Booking Dispute and Support Ticket Flow
**Title**: Self-service booking dispute submission with ticket tracking  
**Description**: Allow passengers to submit a dispute from the booking detail screen (wrong seat, no-show bus, double-charged). The dispute is logged and routed to the operator and WebWaka support. Customer sees a ticket number and status.  
**Why it matters**: Currently there is no in-app support path. Passengers resort to personal calls and WhatsApp. Disputes are untracked and resolved inconsistently.  
**Implementation**: New `booking_disputes` table. `POST /api/booking/disputes`. Publish `booking.dispute_raised` event. Status updates via event bus. Frontend dispute tracker.  
**Reuse/Integration**: Build in this repo. Publish event to platform-wide support system if one exists.  
**Dependencies**: None.  
**Priority**: Medium

---

### B-18: Booking Confirmation Email with PDF Ticket
**Title**: Email delivery of booking confirmation with PDF e-ticket attachment  
**Description**: On booking confirmation, send an email via a transactional email provider (Resend, Mailgun, Brevo) with the e-ticket as an HTML body and optionally a PDF attachment. Fallback to SMS if no email on file.  
**Why it matters**: Many business and corporate passengers expect an email confirmation. The current SMS-only confirmation is insufficient for corporate travel management.  
**Implementation**: Send email via Resend/Mailgun API on `booking.created` event handling. HTML email template with ticket details and e-ticket link. PDF generation via browser print API on the e-ticket page.  
**Reuse/Integration**: Build in this repo. Transactional email is a new dependency.  
**Dependencies**: Corporate accounts (P15), email address on customer record.  
**Priority**: Low

---

### B-19: Multi-Leg Journey Booking
**Title**: Single booking record spanning multiple trip legs  
**Description**: Allow passengers to book a full journey from Port Harcourt to Abuja via Enugu (two separate trips) as a single booking with a single payment and a single itinerary. Cancellation of the journey releases both legs.  
**Why it matters**: Multi-leg journeys are very common in Nigeria (many routes require a transfer). Passengers who book each leg separately risk missing a connection if leg 1 is delayed.  
**Implementation**: New `journeys` entity linking multiple bookings. Single payment for journey total. Itinerary view in booking history. Delay notification for leg 1 triggers alert for leg 2 connection risk.  
**Reuse/Integration**: Build in this repo. Requires multi-stop routes (P11-T3).  
**Dependencies**: Multi-stop routes.  
**Priority**: Low

---

### B-20: Passenger Profile API (Public Data Layer)
**Title**: Customer profile API with address book and frequent routes  
**Description**: Add a customer profile API that stores: full name, email, address (state, LGA), frequent routes (top 5 by booking count), preferred payment method, and saved card tokens (Paystack). Allow customers to manage their profile from the booking portal.  
**Why it matters**: A rich profile reduces data entry on every booking and enables personalization (B-10) and one-tap rebooking (B-12). Saved card tokens eliminate re-entering card details.  
**Implementation**: Add columns to `customers`: `email, address_state, address_lga, preferences JSON`. `GET/PATCH /api/booking/customers/me`. Saved card token via Paystack Customer API.  
**Reuse/Integration**: Build in this repo. Paystack customer token stored (not the card number).  
**Dependencies**: None.  
**Priority**: Low

---

## 6. Top 20: Dispatch / Trip Operations Enhancements

### D-01: Driver App Dedicated View
**Title**: Full driver-facing module with trip details, manifest, SOS, and GPS sharing  
**Description**: The `DriverView` component already exists. Extend it into a complete driver-facing module: trip details, passenger manifest count, boarding scan trigger, departure checklist, GPS location sharing toggle, and SOS button.  
**Why it matters**: Drivers are a primary operational persona with no dedicated tooling beyond a basic trip view. A driver app connects them to the platform and enables real-time operations visibility.  
**Implementation**: Extend `DriverView`. Wire: boarding scan (D-03, P05), GPS sharing (D-04, P05), SOS (D-08, P05), inspection checklist (D-05, P05).  
**Reuse/Integration**: Build in this repo (frontend). All backend endpoints already implemented.  
**Dependencies**: All P05 features (already implemented).  
**Priority**: Critical

---

### D-02: Automated Departure Control on Full Boarding
**Title**: Auto-trigger trip departure when all confirmed passengers are scanned  
**Description**: After each boarding scan, check if all confirmed passengers are boarded. If yes, automatically transition the trip from `boarding` to `in_transit` (or prompt the dispatcher). Configurable: auto-transition vs. manual confirm.  
**Why it matters**: Manual departure control is a bottleneck at parks running 50+ trips per day. Automated departure based on manifest completion frees dispatchers for exception handling only.  
**Implementation**: After each board endpoint call, check `COUNT(*) WHERE status = 'confirmed' AND boarded_at IS NULL = 0`. If true, trigger state transition (or send dispatcher alert).  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: D-01 (boarding scan, P05), Pre-trip inspection (D-05, P05).  
**Priority**: High

---

### D-03: GPS Fleet Map with Live Bus Positions
**Title**: Real-time fleet map showing all active trip bus positions  
**Description**: The Dispatcher Dashboard (P10-T1) already exists. Extend it with a map view using Mapbox or Leaflet (offline-capable tile set) showing live GPS positions of all `in_transit` trips as moving icons.  
**Why it matters**: Dispatchers currently coordinate by phone call. A fleet map shows exactly where every bus is without a phone call, enabling faster exception response.  
**Implementation**: Frontend map component using Leaflet + OpenStreetMap tiles (no API key required). Poll `GET /api/operator/trips?state=in_transit` for GPS coordinates every 30 seconds or receive via SSE.  
**Reuse/Integration**: Build in this repo (frontend). Backend GPS endpoint already implemented (P05-T1).  
**Dependencies**: GPS update endpoint (P05-T1).  
**Priority**: High

---

### D-04: Driver Expense Recording
**Title**: In-trip driver expense recording (fuel, tolls, emergency repairs)  
**Description**: Allow drivers to record in-trip expenses with amounts, categories (fuel, toll, maintenance, accommodation), and receipt photo. Aggregate against trip revenue for profitability reporting.  
**Why it matters**: Operators cannot compute accurate per-trip profitability without recording trip costs. Driver expense recording closes the cost side of the per-trip P&L.  
**Implementation**: New `trip_expenses` table. `POST /api/operator/trips/:id/expenses` (DRIVER role). Photo upload to ASSETS_R2. `GET /api/operator/trips/:id/expenses` (SUPERVISOR+).  
**Reuse/Integration**: ASSETS_R2 already bound for logo uploads. Extend to expense photos.  
**Dependencies**: ASSETS_R2 binding (P15-T4).  
**Priority**: High

---

### D-05: Automated Delay Escalation
**Title**: Automated escalation of unresolved delays beyond a threshold  
**Description**: If a trip remains in `delayed` state for more than a configurable threshold (e.g., 2 hours), automatically escalate to the operator's TENANT_ADMIN via SMS and in-app notification, and optionally offer affected passengers a cancellation/refund.  
**Why it matters**: Supervisors file delay reports but sometimes forget to update passengers when the delay is prolonged. Automated escalation ensures passenger communication doesn't fall through the cracks.  
**Implementation**: `sweepDelayedTrips()` cron function. Checks `delay_reported_at` against current time. Triggers escalation event if beyond threshold. Configurable threshold in operator config.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Delay reporting (P05-T6).  
**Priority**: High

---

### D-06: Trip Profitability Report per Trip
**Title**: Per-trip revenue and cost summary for completed trips  
**Description**: For each completed trip, show: total fare revenue (confirmed bookings + agent sales), operational costs (D-04 expenses), fuel cost estimate (route distance × fuel rate from operator config), driver commission, and net profitability.  
**Why it matters**: Operators make decisions about route frequency and vehicle assignment based on intuition. Per-trip profitability data replaces intuition with evidence.  
**Implementation**: Aggregate from `bookings`, `sales_transactions`, `trip_expenses`. Join with `routes.distance_km` and `vehicles.fuel_consumption_per_100km` (new config fields).  
**Reuse/Integration**: Build in this repo. Extends existing revenue report.  
**Dependencies**: D-04 (expense recording).  
**Priority**: High

---

### D-07: NIMET Weather Route Alerts (Real-Time)
**Title**: Real-time weather-based route risk alerts integrated into the dispatch dashboard  
**Description**: Already designed in P14. Wire the NIMET API integration into the dispatcher dashboard with route-specific weather alerts for flooding, harmattan, and heavy rain. Alert overlaid on the fleet map (D-03).  
**Why it matters**: Weather conditions cause road accidents, route closures, and trip cancellations on Nigerian highways. Proactive weather alerts give dispatchers advance warning.  
**Implementation**: Cron sweeper queries NIMET API daily. Compare trip coordinates against forecast zones. Publish `route:WEATHER_ALERT` events. Display as colored overlay on the fleet map.  
**Reuse/Integration**: Build in this repo. NIMET API as external dependency.  
**Dependencies**: D-03 (fleet map).  
**Priority**: Medium

---

### D-08: Route Deviation Detection
**Title**: Automated alert when a bus GPS position deviates from the expected route  
**Description**: Compare real-time GPS position of an in-transit bus against the expected route polyline. If the bus deviates by more than X kilometers from the route, trigger a `route:DEVIATION` alert to the dispatcher.  
**Why it matters**: Route deviation is a known risk indicator — it may indicate a breakdown, robbery, or unauthorized detour. Early detection gives dispatchers time to respond.  
**Implementation**: Store route polyline in `routes.polyline` (JSON array of lat/lng). On GPS update, compute cross-track distance using the Haversine formula. Publish alert if distance > configurable threshold.  
**Reuse/Integration**: Build in this repo. GPS update endpoint already wired (P05-T1).  
**Dependencies**: D-03 (fleet map for alert display).  
**Priority**: Medium

---

### D-09: Multi-Park Dispatch Coordination
**Title**: Cross-park trip coordination for operators with multiple terminals  
**Description**: The Dispatcher Dashboard currently shows trips for one operator globally. Add terminal/park filtering and cross-park coordination views: a dispatcher at Ojota can see whether the Abuja-bound bus that originates from Jibowu is on schedule.  
**Why it matters**: Large operators run buses from 3–5 parks simultaneously. Without cross-park visibility, dispatchers at each park work in silos.  
**Implementation**: Add `park_id` filter to `GET /api/operator/trips`. Add park selector to dispatcher dashboard. Show cross-park trip timeline.  
**Reuse/Integration**: Build in this repo. Bus park registry (A-11) is a prerequisite.  
**Dependencies**: Bus park registry (A-11).  
**Priority**: Medium

---

### D-10: Passenger Compensation Automation on Long Delays
**Title**: Automatic passenger compensation credit on delays exceeding SLA  
**Description**: If a trip delay exceeds a configurable SLA (e.g., 3 hours beyond scheduled departure), automatically credit all confirmed passengers with a defined compensation amount (e.g., 10% of fare as a booking credit). Opt-in per operator.  
**Why it matters**: Delay compensation is a trust-building tool. Operators who automatically compensate passengers for long delays earn loyalty and reduce negative reviews. It also creates an incentive for operators to minimize delays.  
**Implementation**: `sweepDelayedTrips()` triggers compensation credit on SLA breach. New `booking_credits` table. Credits redeemable on next booking.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: D-05 (delay escalation).  
**Priority**: Medium

---

### D-11: Manifest Digital Signature and Tamper-Evidence
**Title**: Cryptographically signed digital manifest for FRSC checkpoint compliance  
**Description**: Generate a HMAC-SHA256 signature over the manifest JSON at the moment of trip departure. The signature is included on the printed manifest. An FRSC officer can verify the manifest's authenticity using a public key QR code at the checkpost.  
**Why it matters**: Paper manifests can be forged or altered between dispatch and the checkpoint. A signed manifest is tamper-evident and can be verified digitally.  
**Implementation**: On `in_transit` state transition, compute `HMAC-SHA256(manifest_json, operator_signing_key)`. Store signature in `trips.manifest_signature`. Include on printed manifest with a verification URL.  
**Reuse/Integration**: Build in this repo. Signing key stored in `Env` secrets.  
**Dependencies**: Pre-trip inspection (P05-T5), boarding scan (P05-T3).  
**Priority**: Medium

---

### D-12: Trip Cloning for Recurring Routes
**Title**: Enhanced recurring schedule with skip/holiday logic and frequency variance  
**Description**: The recurring schedule endpoint (P15-T5) creates trips at fixed intervals. Extend it with: holiday skip logic (public holidays calendar), frequency variance (e.g., 3 trips on weekdays, 5 on weekends), and a preview-before-generate confirmation step.  
**Why it matters**: Raw CRON-style recurrence is too rigid for transport operations. Nigerian public holidays, Eid, and Christmas require schedule overrides. Operators need fine-grained control over their schedule generation.  
**Implementation**: Extend `POST /api/operator/schedules` with `holiday_skip: boolean`, `frequency_map: { weekday: 3, weekend: 5 }`. Preview endpoint `GET /api/operator/schedules/preview?config=...` returns the list of trips that would be created.  
**Reuse/Integration**: Build in this repo. Extend P15-T5 auto_schedule.  
**Dependencies**: Auto-schedule (P15-T5).  
**Priority**: Medium

---

### D-13: Roadside Assistance Integration
**Title**: One-tap roadside assistance request from driver SOS  
**Description**: Extend the SOS trigger to also initiate a roadside assistance request to an integrated partner (Nigeria AutoMag, Julius Berger, or operator's own maintenance team). The request includes GPS location, vehicle registration, and incident type.  
**Why it matters**: SOS without a coordinated response is just an alarm. Integrating with a roadside assistance service closes the loop and turns the SOS into a rescue action.  
**Implementation**: On SOS trigger, call a configured roadside assistance API endpoint (operator-configurable URL). Include GPS, vehicle reg, and `sos_reason`. Log response reference.  
**Reuse/Integration**: Build in this repo. New external dependency (roadside assistance provider).  
**Dependencies**: SOS trigger (P05-T2).  
**Priority**: Low

---

### D-14: Trip Schedule Template Library
**Title**: Reusable trip schedule templates for common routes  
**Description**: Allow SUPER_ADMIN and TENANT_ADMIN to save and apply trip schedule templates (route, vehicle type, departure times, seat configuration) to quickly spin up a new route without re-configuring every parameter.  
**Why it matters**: Operators launching new routes re-enter the same parameters repeatedly. A template library reduces launch time from 30 minutes to 2 minutes for a familiar route configuration.  
**Implementation**: New `trip_templates` table. `POST/GET /api/operator/templates`. Apply template via `POST /api/operator/trips?template_id=...`.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Low

---

### D-15: Driver Performance Scorecard
**Title**: Automated driver performance score based on trips, incidents, and reviews  
**Description**: Compute a weekly driver performance score from: trips completed on time, delay incidents (initiated), SOS activations, inspection completion rate, and passenger review ratings (average). Visible to TENANT_ADMIN and SUPERVISOR.  
**Why it matters**: Driver accountability is the top operator pain point. An objective performance score creates incentive alignment and simplifies performance management.  
**Implementation**: `GET /api/operator/drivers/:id/scorecard`. Aggregate from `trips`, `trip_inspections`, `trip_delays`, `sos_activations`, `operator_reviews`. Normalize to a 100-point score.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Operator reviews (P13).  
**Priority**: Low

---

### D-16: Checkpoint Digital Pass
**Title**: Driver-presented digital checkpoint pass for FRSC stops  
**Description**: A driver-accessible screen showing: vehicle registration, roadworthiness certificate expiry, insurance expiry, FRSC approval, driver license expiry, and current manifest count. All data verified from the platform's document store. Includes a verification QR.  
**Why it matters**: FRSC checkpoint officers request vehicle and driver documents. A single digital screen showing all documents — verified by the platform — is faster than a folder of papers and harder to forge.  
**Implementation**: Frontend screen accessible from driver view. Data pulled from `vehicle_documents` and `driver_documents`. QR encodes a short-lived verification URL. Document display is read-only.  
**Reuse/Integration**: Build in this repo (frontend). All backend data already exists (P09).  
**Dependencies**: Vehicle and driver documents (P09).  
**Priority**: Low

---

### D-17: Trip Revenue Reconciliation on Completion
**Title**: Automated revenue reconciliation report at trip completion  
**Description**: When a trip is marked `completed`, automatically generate a reconciliation report comparing: expected revenue (booked seats × fare), agent sales revenue, total collected revenue, refunds issued, outstanding payments, and net settlement.  
**Why it matters**: Operators frequently discover revenue discrepancies days after a trip. An automated completion report surfaces discrepancies immediately while memories are fresh.  
**Implementation**: Trigger reconciliation on trip `completed` state transition. Aggregate bookings and sales transactions for the trip. Store reconciliation record. Alert TENANT_ADMIN on discrepancy.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Low

---

### D-18: Live Passenger Manifest for Checkpoint Officers
**Title**: Public, time-limited manifest verification URL for FRSC use  
**Description**: Generate a short-lived (4-hour) public URL that FRSC checkpoint officers can visit to verify a passenger is on the official manifest. The URL is printed on the manifest and accessible without authentication.  
**Why it matters**: FRSC officers cannot log into the WebWaka platform. A public, time-limited manifest URL lets them verify passenger details using their own phone at a checkpoint stop.  
**Implementation**: `POST /api/operator/trips/:id/manifest/public-link` generates a `SESSIONS_KV`-stored token with 4-hour TTL. Public `GET /manifest/:token` returns sanitized manifest (names and seat numbers, no contact details).  
**Reuse/Integration**: Build in this repo. `SESSIONS_KV` already used for OTP.  
**Dependencies**: D-11 (signed manifest).  
**Priority**: Low

---

### D-19: Dispatch Communication Log
**Title**: Structured log of all dispatcher communications per trip  
**Description**: Record every dispatch action (delay report, SOS trigger, boarding status update, vehicle swap, message to driver) in an append-only `dispatch_log` table, timestamped and attributed to the actor.  
**Why it matters**: When an incident occurs (accident, robbery, passenger complaint), there is currently no way to reconstruct the sequence of dispatcher actions taken. A dispatch log creates accountability and enables post-incident review.  
**Implementation**: New `dispatch_log` table: `trip_id, actor_id, action_type, action_data JSON, at_ms`. Insert trigger on SOS, delay, board, location, state transition endpoints.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Low

---

### D-20: Real-Time Departure Board (Public Display)
**Title**: Public departure board screen for bus park display  
**Description**: A public, auto-refreshing departure board page (`GET /departures/:park_id`) showing all upcoming departures from a park in the next 4 hours: route, operator, departure time, status (on time / delayed / boarding / departed), available seats. Optimized for large-screen display.  
**Why it matters**: Bus parks have TVs and display boards that currently show static information or nothing. A real-time departure board gives passengers immediate visibility into what's running, from which bay, and how many seats are left.  
**Implementation**: Public `GET /api/public/departures?park_id=X` (no auth). Returns trips by park, next 4 hours. Frontend board with 60-second auto-refresh. CSS optimized for large horizontal display.  
**Reuse/Integration**: Build in this repo. Bus park registry (A-11) is a prerequisite.  
**Dependencies**: Bus park registry (A-11).  
**Priority**: Low

---

## 7. Top 20: Operator / Fleet / Route Management Enhancements

### O-01: Unified Operator Configuration Dashboard
**Title**: Single-screen operator settings dashboard covering all config keys  
**Description**: Build a TENANT_ADMIN-facing settings dashboard that surfaces all operator configuration options from `TENANT_CONFIG_KV` in one place: reservation TTL, cancellation policy, boarding window, SLA thresholds, dynamic pricing parameters, overbooking factor, and notification preferences.  
**Why it matters**: Currently operator config is fragmented across multiple API endpoints with no unified UI. TENANT_ADMIN has no single screen to understand how their system is configured or to make changes.  
**Implementation**: Frontend settings dashboard reading from `GET /api/operator/config` (already exists). Group settings by category (Seat Management, Payments, Dispatch, Notifications). Save via `PUT /api/operator/config`.  
**Reuse/Integration**: Build in this repo (frontend).  
**Dependencies**: Operator config API (already implemented in P05/P08).  
**Priority**: High

---

### O-02: Route Demand Heatmap Analytics
**Title**: Origin-destination demand heatmap for route planning insights  
**Description**: Aggregate booking and trip search origin–destination pairs by frequency to generate a demand heatmap. Identify underserved routes (high search demand, low trip supply). Surface insights to SUPER_ADMIN and TENANT_ADMIN.  
**Why it matters**: Trip search data captures passenger intent even when a matching trip doesn't exist. Analyzing search demand reveals where new routes should be launched — a data-driven route expansion strategy.  
**Implementation**: Log AI search queries (non-PII: origin, destination only) with extracted O-D pairs. `GET /api/operator/reports/demand` aggregates search and booking O-D pairs. Heatmap visualization on operator dashboard.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: AI search logging (P13).  
**Priority**: High

---

### O-03: Fleet Utilization Optimization Suggestions
**Title**: AI-generated fleet utilization recommendations  
**Description**: Extend the fleet utilization dashboard (P13) with AI-generated suggestions: "Vehicle V-001 has been idle for 5 days. High-demand Lagos→Abuja route has 3 full trips per day. Consider reassignment."  
**Why it matters**: Operators with 50+ vehicles typically have 15–25% sitting idle at any time due to poor scheduling. AI suggestions translate utilization data into actionable decisions.  
**Implementation**: `GET /api/operator/vehicles/utilization/recommendations`. Fetch low-utilization vehicles and high-demand routes. Pass to OpenRouter for natural language recommendations.  
**Reuse/Integration**: OpenRouter already wired (vendor-neutral).  
**Dependencies**: Fleet utilization dashboard (P13), fill rate forecast (S-12).  
**Priority**: High

---

### O-04: Multi-Terminal Operator Management
**Title**: Terminal entity management with per-terminal trip, agent, and vehicle assignment  
**Description**: New `terminals` entity for physical bus park locations: name, city, state, GPS, operator association. Assign routes, agents, vehicles, and trips to specific terminals. Enable per-terminal reporting.  
**Why it matters**: Large operators run buses from multiple parks simultaneously. Without terminal management, all data is a flat list with no geographic context. A terminal view enables per-location fleet deployment decisions.  
**Implementation**: New `terminals` table. Foreign keys from `routes`, `agents`, `vehicles`. Add `terminal_id` to trip search and operator dashboard.  
**Reuse/Integration**: Build in this repo. Bus park registry (A-11) references terminals.  
**Dependencies**: Bus park registry (A-11).  
**Priority**: High

---

### O-05: Driver Training and Certification Tracking
**Title**: Driver training record and certification expiry tracking  
**Description**: Track driver training records (defensive driving course, first aid certification, route familiarization, company induction) alongside compliance documents. Alert when certifications are expiring.  
**Why it matters**: Beyond license compliance (P09-T2), operators are increasingly required to demonstrate driver training standards. Tracking training records provides a compliance audit trail.  
**Implementation**: New `driver_training_records` table. `POST/GET /api/operator/drivers/:id/training`. Add training status to driver profile.  
**Reuse/Integration**: Build in this repo. Extends driver documents (P09-T2).  
**Dependencies**: Driver documents (P09-T2).  
**Priority**: High

---

### O-06: Operator Referral Programme
**Title**: Operator referral codes with attribution tracking and reward credits  
**Description**: Allow operators to generate referral codes that they share with other potential operators. When a referred operator onboards and runs their first trip, the referring operator receives a platform credit.  
**Why it matters**: Operator acquisition is the hardest part of platform growth. A referral programme turns existing operators into sales agents, reducing customer acquisition cost significantly.  
**Implementation**: New `operator_referrals` table. Add `referral_code` to operators. Track referral attribution on operator creation. Credit on first successful trip by referred operator.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Onboarding wizard (P11-T2).  
**Priority**: High

---

### O-07: Operator Financial Summary with VAT and WHT
**Title**: Monthly financial summary with FIRS-ready VAT and withholding tax computation  
**Description**: Generate a monthly financial summary per operator: gross revenue, refunds, net revenue, VAT collected (7.5% on transport services), and withholding tax (WHT) on agent commissions. Export as a FIRS-ready format.  
**Why it matters**: Nigerian operators are legally obligated to file VAT returns monthly. A pre-computed FIRS-aligned summary reduces the accountant's burden and reduces the risk of late filing penalties.  
**Implementation**: `GET /api/operator/reports/tax?month=2026-04`. Aggregate from bookings and sales transactions. Compute VAT and WHT per current FIRS rates. Generate printable PDF via browser print API.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Revenue report (already implemented).  
**Priority**: High

---

### O-08: Inter-Operator Partnership Management
**Title**: Partnership agreements for code-sharing and revenue splits  
**Description**: Allow SUPER_ADMIN to create partnership agreements between operators, specifying shared routes, commission split, and seat exchange quota. Expose partner operators' available trips on each other's POS.  
**Why it matters**: Code-sharing allows smaller operators to sell seats on each other's trips, increasing revenue without adding capacity. This is standard practice on African bus routes but currently entirely manual.  
**Implementation**: New `operator_partnerships` table. Partnership-aware seat availability query. Commission split tracked in booking record. Requires S-09 (cross-operator seat exchange).  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: S-09 (seat exchange protocol).  
**Priority**: Medium

---

### O-09: Operator Compliance Gating
**Title**: Automated operator account gating based on compliance checklist status  
**Description**: Define a compliance checklist per operator (FIRS TIN, CAC registration, FRSC fleet approval, NDPR registration). SUPER_ADMIN manages compliance status. Non-compliant operators are automatically suspended (read-only, no new trips).  
**Why it matters**: WebWaka could face regulatory liability if it operates routes for non-compliant operators. A compliance gating system protects the platform.  
**Implementation**: Add `compliance_status` JSON to operators. On write API calls, check compliance status for non-SUPER_ADMIN. Return 403 with specific missing compliance item.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Medium

---

### O-10: Third-Party ERP and Accounting Integration
**Title**: Operator API webhooks for ERP/accounting system integration  
**Description**: Allow operators to configure webhook endpoints that receive `booking.confirmed`, `trip.completed`, and `reconciliation.completed` events. Operators with QuickBooks, Sage, or internal ERPs can consume these events without polling.  
**Why it matters**: Mid-sized operators have accounting systems that need to reflect every booking and settlement. Without webhooks, they export CSVs manually. Webhooks eliminate this manual step.  
**Implementation**: New `operator_webhooks` table: `operator_id, url, secret, events[]`. On matching events, sign the payload with HMAC-SHA256 and POST to the configured URL.  
**Reuse/Integration**: Build in this repo. Complements API keys (P11-T1).  
**Dependencies**: API keys (P11-T1).  
**Priority**: Medium

---

### O-11: Vehicle Fuel Efficiency Tracking
**Title**: Fuel consumption tracking per trip for fleet efficiency analysis  
**Description**: Track fuel fill-ups and quantities per vehicle. Compute fuel consumption per 100km. Surface efficiency rankings across the fleet. Alert on vehicles with abnormally high consumption (possible mechanical issue or fuel theft).  
**Why it matters**: Fuel is the single largest operational cost for bus operators (40–60% of total cost). Tracking fuel efficiency per vehicle reveals mechanical inefficiency and driver behavior patterns.  
**Implementation**: New `fuel_records` table: `vehicle_id, trip_id, litres, cost_kobo, odometer_km`. Compute `litres_per_100km` per vehicle. Alert if > configurable threshold.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Medium

---

### O-12: Route Segment Pricing (Origin to Waypoint)
**Title**: Per-segment fare calculation from any stop to any other stop on multi-stop routes  
**Description**: Multi-stop routes (P11-T3) support stop definition. Add per-segment pricing: a passenger boarding at Lagos and alighting at Ibadan pays differently from one boarding at Lagos and going to Abuja. Fare matrix per segment.  
**Why it matters**: Route profitability is partly driven by segment pricing. A passenger riding half the route should pay proportionally to the segment fare, not a flat fare.  
**Implementation**: Extend `route_stops` with `segment_fare_matrix JSON`. On booking creation, compute effective fare from `origin_stop` to `destination_stop`.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Multi-stop routes (P11-T3).  
**Priority**: Medium

---

### O-13: White-Label Booking Page with Custom Domain
**Title**: Operator-branded booking page on a custom subdomain  
**Description**: Extend white-label branding (P15-T4) to support custom domain configuration (e.g., `book.gcoperator.ng`). When a customer lands on the operator's custom domain, the booking portal shows the operator's brand colors, logo, and only their trips.  
**Why it matters**: Large operators want their own booking portal, not a generic WebWaka-branded page. Custom domain support enables true white-labeling.  
**Implementation**: Add `custom_domain` to operator config. Cloudflare Custom Domains on the Pages deployment. The worker reads the request `Host` header to detect the operator and apply their branding.  
**Reuse/Integration**: Build in this repo. Requires Cloudflare Custom Domains setup. Extends P15-T4 branding.  
**Dependencies**: White-label branding (P15-T4).  
**Priority**: Medium

---

### O-14: Operator Performance Benchmarking
**Title**: Operator performance benchmarks compared to platform anonymized average  
**Description**: Show each TENANT_ADMIN how their key metrics (fill rate, cancellation rate, delay rate, review score, booking-to-payment conversion) compare to the anonymized platform average for operators on the same route type and tier.  
**Why it matters**: Operators don't know if their 72% fill rate is good or bad. Benchmarking against peers (anonymized) motivates improvement and helps operators identify their weakest areas.  
**Implementation**: `GET /api/operator/benchmarks` computes the operator's metrics vs. platform anonymized median for their tier. No PII or operator identity exposed in comparison data.  
**Reuse/Integration**: Build in this repo. SUPER_ADMIN analytics endpoint feeds benchmark computation.  
**Dependencies**: Platform analytics (P10-T2).  
**Priority**: Medium

---

### O-15: Operator Revenue Share Programme
**Title**: WebWaka platform revenue share configuration per booking and per tier  
**Description**: Implement the commercial revenue share model: WebWaka retains X% of each booking (configurable per operator tier and route type). Track platform commission per booking, display to SUPER_ADMIN, and settle via operator payout.  
**Why it matters**: Without revenue share tracking, WebWaka has no visibility into its own platform revenue from operator transactions. This is the commercial foundation of the SaaS business.  
**Implementation**: Add `platform_commission_kobo` to bookings, computed on booking creation as `total_amount × platform_rate`. `GET /api/super-admin/platform-revenue` aggregates this. Settlement tracking in a new `platform_settlements` table.  
**Reuse/Integration**: Build in this repo. SUPER_ADMIN access only.  
**Dependencies**: Subscription tiers (P15-T1).  
**Priority**: Medium

---

### O-16: Operator App (Native PWA Install Prompt)
**Title**: Proactive PWA install prompt for TENANT_ADMIN with push notification enrollment  
**Description**: Show a well-designed PWA install prompt to TENANT_ADMIN users on first visit, and on successful install, enroll them in push notifications for critical events (SOS, large delay, reconciliation discrepancy).  
**Why it matters**: TENANT_ADMIN users are the highest-value users of the operator module. If they install the PWA, they are reachable via push even when not actively using the app. This dramatically improves response time to critical events.  
**Implementation**: Wire `beforeinstallprompt` event in `main.tsx`. Show install banner to TENANT_ADMIN after 3 sessions. On install: trigger VAPID push enrollment. On push receive: show critical event notification.  
**Reuse/Integration**: Build in this repo. VAPID already configured.  
**Dependencies**: None.  
**Priority**: Low

---

### O-17: Automated Operator Tier Upgrade Suggestion
**Title**: In-app suggestion to upgrade tier when a gated feature is triggered  
**Description**: When a TENANT_ADMIN attempts to use a tier-gated feature they don't have access to, instead of a generic 403, show a contextual upgrade prompt: "This feature requires the Pro plan. Your current plan: Basic. Upgrade to unlock AI search, dynamic pricing, and more."  
**Why it matters**: The `requireTierFeature` middleware currently returns a JSON error. Converting this into a UX upgrade flow converts feature-gating into a sales funnel.  
**Implementation**: The frontend catches 402/403 responses from tier-gated endpoints and checks the error code. If `tier_insufficient`, display the upgrade modal with the specific feature and the next tier it requires.  
**Reuse/Integration**: Build in this repo (frontend). No backend change needed.  
**Dependencies**: Subscription tier gating (P15-T1).  
**Priority**: Low

---

### O-18: Vehicle Type and Fleet Segmentation
**Title**: Vehicle type registry (bus, minibus, SUV, sprinter) with capacity and amenity metadata  
**Description**: Add a formal `vehicle_types` entity: type name, default seat capacity, amenities (AC, USB charging, WiFi, toilet, reclining seats). Operators assign a vehicle type to each vehicle. Passengers can filter trips by amenity.  
**Why it matters**: Passengers paying premium fares expect specific amenities. Without amenity metadata, the booking portal can't show "AC bus, USB charging" — a key differentiator for luxury operators.  
**Implementation**: New `vehicle_types` table. Add `vehicle_type_id` to vehicles. Add amenity filter to `GET /api/booking/trips/search`.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Low

---

### O-19: API Versioning and Deprecation Framework
**Title**: Structured API versioning (`/api/v1/`, `/api/v2/`) with deprecation headers  
**Description**: Introduce API version prefixes and a deprecation policy. Deprecated endpoints return `Sunset` and `Deprecation` headers. New breaking changes go into `/api/v2/`. Operators who have integrated via API keys (P11-T1) are not broken by updates.  
**Why it matters**: As WebWaka grows and third-party integrations increase, breaking API changes without versioning will damage operator trust. A versioning framework is a prerequisite for a stable public API programme.  
**Implementation**: Add `/api/v1/` prefix aliasing to current routes. New routes default to `/api/v2/` for breaking changes. Middleware reads `Accept-Version` header as fallback.  
**Reuse/Integration**: Build in this repo. Core routing change in `worker.ts`.  
**Dependencies**: API keys (P11-T1).  
**Priority**: Low

---

### O-20: Structured Logging with Correlation IDs
**Title**: Request correlation IDs and structured JSON logging for Cloudflare Logpush  
**Description**: Inject a `X-Request-ID` header (UUID) on every request. All log statements use `console.log(JSON.stringify({ level, msg, requestId, tenantId, userId, ms }))` format. Wire Cloudflare Logpush to ship logs to a centralized logging service (Datadog, Grafana Cloud).  
**Why it matters**: Currently all operational logging is unstructured `console.warn/error`. In production, this makes it impossible to trace a specific booking failure, identify the responsible tenant, or measure endpoint latency. Structured logging is the prerequisite for a serious operations practice.  
**Implementation**: Global Hono middleware in `worker.ts` injects `requestId` into the Hono context. All handlers log structured JSON. `duration_ms` computed from middleware entry/exit.  
**Reuse/Integration**: The structured logging middleware should be added to `@webwaka/core` for cross-repo use.  
**Dependencies**: None.  
**Priority**: Low

---

## 8. Cross-Repo Integration Map

### 8.1 What Should Be Built in This Repo (Transport-specific)

| Feature | Module | Notes |
|---------|---------|-------|
| Seat inventory sync (all S-xx) | TRN-1 | Core transport logic |
| Boarding scan anti-replay (S-01) | TRN-1 | Transport-specific |
| Real-time seat fan-out via DO | TRN-1 | Cloudflare-specific |
| Offline agent POS (all A-xx) | TRN-2 | Bus park workflows |
| Customer booking portal (all B-xx) | TRN-3 | Passenger-facing |
| Driver app and dispatch operations (D-xx) | TRN-4 | Operational workflows |
| Operator management (O-xx) | TRN-4 | Fleet/route management |
| Parcel waybill recording (A-16) | TRN-2 | Logistics interface — waybill creation only |
| Trip schedule automation | TRN-4 | Transport scheduling |
| Revenue share tracking | TRN-4 | Platform commercial layer |

### 8.2 What Should Be Integrated from the Logistics Repo (Not Built Here)

| Feature | Notes |
|---------|-------|
| Parcel delivery tracking | Core logistics feature. Transport publishes `parcel.waybill_created`; logistics subscribes and manages lifecycle. |
| Warehouse management | Logistics-only concern. |
| Delivery route optimization | Logistics-only concern. |
| Courier / last-mile dispatch | Logistics-only concern. |
| Parcel weight/dimension management | Logistics-owned entity. |
| Fulfillment workflows | Logistics-owned process. |

**Integration protocol**: Transport publishes `parcel.waybill_created` to the event bus. Logistics subscribes and manages the parcel lifecycle from pickup to delivery. Logistics publishes `parcel.seats_required` when a parcel needs bus capacity. Transport consumes this and blocks the appropriate seats (S-03). No direct DB cross-access. No API calls — event bus only.

### 8.3 What Should Be Exposed as Shared Platform Capabilities (in `@webwaka/core`)

| Capability | Current State | Action |
|-----------|--------------|--------|
| `applyTenantScope()` / `getOperatorScope()` | In `src/api/types.ts` | Promote to `@webwaka/core` |
| `parsePagination()` / `metaResponse()` | In `src/api/types.ts` | Promote to `@webwaka/core` |
| `parseCsvFile()` | In `src/api/operator-management.ts` | Promote to `@webwaka/core` |
| `requireRateLimit()` | Pattern in `auth.ts` | Formalize as `@webwaka/core` middleware factory |
| Structured logging middleware | Not implemented | New — add to `@webwaka/core` for all repos |
| NDPR consent recording | Duplicated | Centralize in shared NDPR service |
| Notification dispatch (SMS, push) | `src/lib/sms.ts`, `src/lib/push.ts` | Extract to shared notification service |
| OTP generation and verification | `src/api/auth.ts` | Extract to `@webwaka/core` for cross-repo auth |
| JWT generation/verification | `@webwaka/core` ✅ | Already shared — enforce use in all repos |
| RBAC middleware (`requireRole`) | `@webwaka/core` ✅ | Already shared |
| Tier feature gating (`requireTierFeature`) | `@webwaka/core` ✅ | Already shared — all repos must use this |
| Event bus outbox writer (`publishEvent`) | `@webwaka/core` ✅ | Already shared — enforce |
| `nanoid()` ID generation | `@webwaka/core` ✅ | Canonical — deprecate `genId()` in `types.ts` |

### 8.4 What Should Never Be Duplicated

| Concern | Canonical Location |
|---------|-------------------|
| Parcel lifecycle management | Logistics repo only |
| Warehouse operations | Logistics repo only |
| Customer identity and authentication | Transport auth (`src/api/auth.ts`) — share via `@webwaka/core` JWT |
| Financial transaction ledger | Transport repo (bookings, sales_transactions) — no second ledger in logistics |
| NDPR consent audit trail | Transport repo (transport customers) — shared consent service, not data |
| Event bus publisher | `@webwaka/core publishEvent()` — all repos use the same implementation |
| JWT verification | `@webwaka/core verifyJWT()` — never re-implement JWT parsing |
| Tier gating logic | `@webwaka/core TIER_FEATURE_MAP` — all repos use the same feature map |
| ID generation | `@webwaka/core nanoid()` — no competing implementations |

---

## 9. Recommended Execution Order

The sequence below orders enhancements by dependency, business value, operational risk, and platform integrity. Critical path items come first; speculative or low-traffic features come last.

### Phase 16: Security and Data Integrity (Weeks 1–3)
*These address immediate gaps that affect correctness and security at production scale.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 1 | S-01: Boarding scan anti-replay | Prevents double-boarding fraud at scale |
| 2 | S-02: Rate limiting on reservation endpoints | Prevents seat hoarding attacks |
| 3 | S-06: Optimistic locking version enforcement | Eliminates silent overwrites in offline sync conflicts |
| 4 | O-20: Structured logging with correlation IDs | Prerequisite for all future debugging and SLA monitoring |
| 5 | S-03: Logistics event integration (parcel seats) | Closes the transport–logistics coordination gap |

### Phase 17: Driver and Dispatch Completeness (Weeks 4–6)
*These complete the driver-facing module and operational dispatch coverage.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 6 | D-01: Driver app with all P05 features wired | Driver persona has no dedicated UI; this unlocks the full P05 backend value |
| 7 | D-02: Automated departure control | Dispatchers are bottlenecked on manual trip departures |
| 8 | D-03: GPS fleet map with live positions | Dispatchers need visual fleet situational awareness |
| 9 | D-04: Driver expense recording | Closes the cost side of per-trip profitability |
| 10 | D-06: Per-trip profitability report | Data-driven route and fleet decisions require per-trip P&L |

### Phase 18: Agent POS Completeness (Weeks 7–9)
*These close the agent workflow gaps and add the highest-value POS features.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 11 | A-01: Boarding scan from Agent POS | Agents are the gate controllers at small parks; they need this capability |
| 12 | A-02: Offline transaction recovery dashboard | Agents need sync visibility for accountability |
| 13 | A-05: Agent shift management | Float reconciliation requires shift-scoped data |
| 14 | A-06: WhatsApp receipt sharing | Zero backend cost; high passenger trust impact |
| 15 | A-08: Agent commission statement | Eliminates the most common agent dispute |

### Phase 19: Customer Portal Growth (Weeks 10–12)
*These drive booking conversion and passenger retention on the portal.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 16 | B-02: WhatsApp booking channel | Largest under-served booking channel; near-100% Nigerian penetration |
| 17 | B-07: Complete vernacular localization | Converts semi-literate non-English passengers |
| 18 | B-09: Fare calendar / price comparison | Price-sensitive passengers convert better with fare transparency |
| 19 | B-08: Trip status tracking screen | Eliminates top support query: "Where is my bus?" |
| 20 | B-01: Streamlined Paystack inline payment | Pre-populated fields reduce payment page abandonment |

### Phase 20: Operator Analytics and Commercialization (Weeks 13–16)
*These drive operator value, tier upgrade conversion, and platform revenue.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 21 | O-01: Unified operator config dashboard | TENANT_ADMIN needs a single settings screen |
| 22 | O-02: Route demand heatmap | Operators need data for route expansion decisions |
| 23 | O-03: Fleet utilization optimization (AI) | AI suggestions drive measurable fleet ROI |
| 24 | O-07: VAT and WHT financial summary | Compliance tool; every operator needs this |
| 25 | O-15: Revenue share tracking | Platform commercial foundation |
| 26 | O-17: Tier upgrade prompt on feature gate | Converts blocked features into upgrade sales |

### Phase 21: Platform Infrastructure and Partnerships (Weeks 17–20)
*These build the long-term scalability and ecosystem partnership foundations.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 27 | S-04: Seat snapshot at departure | Dispute resolution audit trail |
| 28 | O-04: Multi-terminal management | Required for large operators with multiple parks |
| 29 | O-08: Inter-operator partnership management | Code-sharing unlocks revenue on overlapping routes |
| 30 | O-10: Third-party ERP webhook integration | Reduces manual accounting work for mid-sized operators |
| 31 | O-19: API versioning framework | Prerequisite for stable third-party integrations |

### Phase 22+: Expansion Channels and Market Differentiators
*These are high-impact but high-complexity initiatives for longer-term roadmap.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 32 | B-15: USSD booking channel | Feature phone reach; complex gateway integration |
| 33 | B-05: Insurance upsell | Revenue diversification; requires insurtech partner |
| 34 | D-11: Signed manifest for FRSC | Regulatory trust with law enforcement |
| 35 | A-16: Parcel waybill at POS | Logistics revenue extension |
| 36 | O-13: White-label custom domain | Required for large operator deals |
| 37 | S-18: Seat inventory API for aggregators | Distribution channel expansion |
| 38 | B-19: Multi-leg journey booking | Complex UX; high passenger value for transfers |
| 39 | D-08: Route deviation detection | Safety feature; GPS polyline infrastructure required |
| 40 | O-06: Operator referral programme | Growth lever; requires commercial process |

---

*Document prepared by WebWaka Transport Engineering, April 1, 2026. This document is a living artifact — update sections 1.7, 9 whenever phases are completed or new gaps are identified.*
