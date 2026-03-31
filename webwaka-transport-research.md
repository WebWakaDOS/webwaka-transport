# WebWaka Transport Suite — Deep Research & Enhancement Roadmap

> **Prepared for**: WebWaka Platform Engineering  
> **Date**: March 31, 2026  
> **Scope**: Transport codebase deep-dive, Nigeria market research, 100 enhancement recommendations across 5 transport use cases, cross-repo integration map, and recommended execution order.

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

WebWaka Transport is a Cloudflare-first, offline-first, multi-tenant transportation platform designed to serve the Nigerian intercity bus market. It is not a standalone product — it is one vertical module in the broader WebWaka multi-repo ecosystem. It shares a platform core package (`@webwaka/core`) and emits events to the platform event bus for consumption by other services (notably the logistics repo and any future notification or analytics services).

The codebase is organized into four numbered transport modules (TRN-1 through TRN-4), each with its own API router, domain logic layer, and offline data layer. The frontend is a React 19 PWA built with Vite, and the backend is a single Cloudflare Worker using the Hono framework.

### 1.2 Major Modules

#### TRN-1: Seat Inventory (`src/api/seat-inventory.ts`, `src/core/seat-inventory/index.ts`)

The seat inventory module is the atomic foundation of the platform. It manages all seat lifecycle transitions: `available → reserved → confirmed → blocked`. Key design decisions:

- **30-second TTL reservation tokens**: Each reservation is held by a cryptographically random token that expires in 30,000ms. If a booking is not confirmed before expiry, the seat is automatically released by the `sweepExpiredReservations` cron sweeper.
- **Version-stamped seats**: Each seat row carries a `version` integer that is incremented on every update, enabling optimistic concurrency control.
- **Dual implementation**: There is both a server-side D1-backed implementation (`src/api/seat-inventory.ts`) and an in-memory domain model (`src/core/seat-inventory/index.ts`). The in-memory model is used for unit testing and can be used for simulation. These two implementations are not yet unified by a common interface contract — an architectural gap.
- **Client-side seat cache**: `src/core/offline/db.ts` maintains a Dexie `seats` table with a 30-second TTL matching the server reservation TTL. This is used by the POS agent to show locally cached seat status when connectivity is poor.

Routes:
- `GET /api/seat-inventory/trips` — paginated trip list with availability counts
- `POST /api/seat-inventory/trips` — create trip with atomic seat row batch
- `GET /api/seat-inventory/trips/:id/availability` — seat map with live expiry sweep
- `POST /api/seat-inventory/trips/:id/reserve` — atomic single-seat reservation
- `POST /api/seat-inventory/trips/:id/confirm` — confirm reservation by token
- `POST /api/seat-inventory/trips/:id/release` — release reservation by token
- `PATCH /api/seat-inventory/trips/:tripId/seats/:seatId` — SyncEngine seat mutation endpoint
- `POST /api/seat-inventory/sync` — batch offline mutation sync

#### TRN-2: Agent Sales / POS (`src/api/agent-sales.ts`, `src/core/sales/index.ts`)

The agent sales module enables bus park agents to sell tickets at physical counters or via mobile devices, both online and offline.

Key design decisions:
- **Offline-first queueing**: When an agent is offline, `saveOfflineTransaction()` writes the sale to the Dexie `transactions` table. The `SyncEngine.flush()` replays it to `/api/agent-sales/transactions` when connectivity returns, with idempotency keys to prevent double-posting.
- **Seat pre-validation**: Before recording a sale online, the API verifies each seat's status and trip assignment, rejecting any seat that is already `confirmed` or `blocked`.
- **Atomic batch write**: Every online sale writes the transaction record, the receipt record, and all seat status updates in a single D1 `batch()` call — ensuring that a sale is never partially recorded.
- **Event publication**: Every confirmed sale publishes an `agent.sale.completed` event to the platform event bus.
- **Agent session caching**: `src/core/offline/db.ts` maintains an `agent_sessions` Dexie table, caching the JWT hash and expiry for offline agent authentication.
- **Agent dashboard**: `GET /api/agent-sales/dashboard` returns today's transaction count and revenue for the authenticated agent.

Routes:
- `GET /api/agent-sales/agents` — agent list (tenant-scoped)
- `POST /api/agent-sales/agents` — register agent (TENANT_ADMIN+)
- `PATCH /api/agent-sales/agents/:id` — update agent profile/status
- `POST /api/agent-sales/transactions` — record a sale (online)
- `GET /api/agent-sales/transactions` — list transactions (filterable by agent, trip, sync status)
- `GET /api/agent-sales/receipts/:id` — fetch a specific receipt
- `POST /api/agent-sales/sync` — offline batch sync upload
- `GET /api/agent-sales/dashboard` — today's sales summary

#### TRN-3: Booking Portal (`src/api/booking-portal.ts`, `src/core/booking/index.ts`)

The booking portal is the customer-facing self-service booking flow. It handles route search, trip search, customer registration, booking creation, payment initiation, and booking confirmation.

Key design decisions:
- **NDPR enforcement as a hard gate**: Every customer registration and booking creation requires `ndpr_consent: true` in the request body. The API rejects any request without it. Customer PII is never returned in list endpoints.
- **Payment webhook integration**: Paystack and Flutterwave each have a public webhook endpoint (`/webhooks/paystack`, `/webhooks/flutterwave`) that validates signatures and auto-confirms bookings on successful payment events. No manual confirmation step required for online payments.
- **Abandoned booking sweeper**: `sweepAbandonedBookings()` runs every minute and cancels any booking that has been in `pending` state for more than 30 minutes, releasing its seats and publishing a `booking:ABANDONED` event.
- **AI natural language search**: `POST /api/booking/trips/ai-search` accepts a freeform query (e.g. "Lagos to Abuja tomorrow morning, cheapest"), extracts structured parameters using OpenRouter (gpt-4o-mini), and runs a standard SQL search. Rate-limited to 5 requests/minute/IP via SESSIONS_KV. Fails gracefully back to a keyword-based fallback.
- **Event-driven confirmation**: Booking confirmation publishes a `booking.created` event for downstream consumption (push notification, SMS, logistics handoff).
- **Dual implementation**: Like seat inventory, there is an in-memory `BookingManager` domain class and a D1-backed API implementation. Same architectural gap applies.

Routes:
- `GET /api/booking/routes` — public route list (searchable)
- `GET /api/booking/trips/search` — public trip search with seat counts
- `POST /api/booking/trips/ai-search` — AI natural language trip search
- `POST /api/booking/customers` — register/upsert customer (NDPR-gated)
- `POST /api/booking/bookings` — create a booking (NDPR-gated)
- `PATCH /api/booking/bookings/:id` — update payment reference / cancel
- `PATCH /api/booking/bookings/:id/confirm` — confirm and publish event
- `PATCH /api/booking/bookings/:id/cancel` — cancel and release seats
- `GET /api/booking/bookings` — list bookings (customer-scoped or tenant-scoped)
- `GET /api/booking/bookings/:id` — booking detail with route and operator info

#### TRN-4: Operator Management (`src/api/operator-management.ts`)

The operator management module covers the full lifecycle of a transport operator: company profile, routes, vehicles, drivers, trips, and revenue reporting.

Key design decisions:
- **Trip state machine**: Trips follow a strict finite state machine: `scheduled → boarding → in_transit → completed/cancelled`. Every transition is validated against the allowed transitions map and recorded in the `trip_state_transitions` audit table. Trips in `in_transit` or `completed` or `cancelled` states cannot be modified or deleted.
- **Trip copy/clone**: `POST /api/operator/trips/:id/copy` duplicates a trip to a new departure time, copying all seat rows, enabling rapid scheduling of recurring routes.
- **Driver assignment**: Trips carry an optional `driver_id` foreign key. The `GET /api/operator/trips?driver_id=me` query resolves the authenticated user's ID, enabling drivers to fetch only their assigned trips.
- **GPS coordinates**: The `trips` table carries `current_latitude` and `current_longitude` columns, enabling live location tracking — though the update mechanism is not yet wired to a GPS polling endpoint.
- **SOS system**: The schema carries `sos_active`, `sos_triggered_at`, `sos_cleared_at`, `sos_cleared_by` columns — the infrastructure exists but the trigger/clear endpoints are not yet implemented.
- **Revenue reporting**: `GET /api/operator/reports` returns aggregate revenue and booking statistics per route, supporting operator financial oversight.
- **Event publication**: Trip state transitions publish `trip.state_changed` events to the platform event bus.

Routes (selected):
- CRUD for operators, routes, vehicles, drivers
- Trip CRUD, trip copy, trip state machine, driver assignment
- Trip manifest (`GET /api/operator/trips/:id/manifest`)
- Revenue reports (`GET /api/operator/reports`)
- Agent management (read/create/update agents per operator)
- Platform operator management for SUPER_ADMIN

### 1.3 Shared Abstractions and Reusable Components

#### `@webwaka/core` (`packages/core/src/index.ts`)

The platform core package is the canonical location for all shared logic. It currently exports:

| Export | Purpose |
|--------|---------|
| `requireRole(roles[])` | Hono RBAC middleware factory — throws 403 if role not in list |
| `requireTenant()` | Multi-tenant enforcement middleware — sets `tenant_id` on context |
| `getTenantId(c)` | Helper to read enforced tenant ID from context |
| `jwtAuthMiddleware(config)` | JWT verification middleware with public route whitelisting |
| `verifyJWT(token, secret)` | Decode and verify a compact HMAC-SHA256 JWT |
| `generateJWT(user, secret)` | Create a signed compact JWT |
| `nanoid(prefix, length)` | Platform-standard ID generator (Cloudflare Worker compatible) |
| `formatKobo(kobo)` | Nigeria-First: kobo → ₦ naira display |
| `publishEvent(db, event)` | Event Bus D1 outbox writer |
| Type exports: `WakaRole`, `WakaUser`, `PlatformEvent` | Shared platform types |

The core package uses a Vitest detection flag (`process.env.VITEST === 'true'`) to inject a `SUPER_ADMIN` test user into middleware no-ops, allowing unit tests to run without real JWTs.

#### `src/api/types.ts`

Shared types used across all four API modules:
- `Env` interface (D1, KV namespaces, secrets)
- D1 row interfaces (`DbOperator`, `DbRoute`, `DbVehicle`, `DbTrip`, `DbDriver`, `DbSeat`, `DbBooking`, `DbCustomer`, `DbAgent`, `DbSalesTransaction`, `DbReceipt`)
- `getOperatorScope(c)` and `applyTenantScope(c, query, params)` — multi-tenant query scoping helpers
- `parsePagination(q)` and `metaResponse()` — pagination helpers
- `requireFields(body, fields)` — input validation helper
- `genId(prefix)` — ID generation (wraps timestamp + random)

#### `src/core/offline/` — Offline-First Infrastructure

The offline layer is one of the most sophisticated parts of the codebase:

- **Dexie v2 schema**: 9 tables — mutations, transactions, trips, seats, bookings, agent_sessions, conflict_log, operator_config, ndpr_consent. Schema versioned with v1→v2 upgrade migration.
- **SyncEngine**: Class-based, singleton per browser context. Uses Web Locks API for cross-tab mutual exclusion. Exponential backoff (up to 32s) on retry. Maps entity mutations to API routes. Handles 409 conflicts by logging them to the conflict log for manual resolution.
- **Background sync**: Registers a Service Worker `sync` event tag (`webwaka-transport-sync`) to trigger flush when connectivity returns, even if the app is closed.
- **Service Worker message bridge**: `setupSyncMessageHandler()` in `main.tsx` wires the SW `TRIGGER_SYNC` message to `syncEngine.flush()`.

#### `src/lib/sweepers.ts`

Four scheduled maintenance functions run via Cloudflare Cron:
- `drainEventBus()` — every minute: processes up to 50 pending `platform_events`, marks as processed/dead
- `sweepExpiredReservations()` — every minute: releases expired seat holds, publishes `seat.reservation_expired`
- `sweepAbandonedBookings()` — every minute: cancels bookings pending >30min, releases seats, publishes `booking:ABANDONED`
- `sweepExpiredPII()` — daily: anonymizes customers inactive 2+ years (NDPR Article 2.1)
- `purgeExpiredFinancialData()` — daily: soft-deletes financial records >7 years (FIRS compliance)

#### `src/core/i18n/index.ts`

Multi-language support for 4 languages (English, Yoruba, Igbo, Hausa) and 5 currencies (NGN, GHS, KES, UGX, RWF). Used throughout the React UI.

#### `src/middleware/`

- `auth.ts` — `jwtAuthMiddleware` and `requireTenantMiddleware`, wired in `worker.ts` to guard all `/api/*` routes
- `idempotency.ts` — reads `X-Idempotency-Key` header and serves cached responses from `IDEMPOTENCY_KV`, preventing double-processing of offline sync retries

### 1.4 Integration Points

| Integration Point | Direction | Purpose |
|--|--|--|
| Cloudflare D1 | Internal | Primary persistence (operators, routes, vehicles, trips, seats, bookings, agents, customers, events) |
| Cloudflare KV (`SESSIONS_KV`) | Internal | OTP storage, AI rate limiting |
| Cloudflare KV (`TENANT_CONFIG_KV`) | Internal | Per-operator configuration cache |
| Cloudflare KV (`SEAT_CACHE_KV`) | Internal | Edge seat availability cache (invalidated by event bus) |
| Cloudflare KV (`IDEMPOTENCY_KV`) | Internal | Idempotency token store for offline sync |
| Paystack (`/webhooks/paystack`) | Inbound | Charge success → booking confirmation |
| Flutterwave (`/webhooks/flutterwave`) | Inbound | Charge completion → booking confirmation |
| OpenRouter (gpt-4o-mini) | Outbound | AI natural language trip search |
| Termii / Yournotify (SMS) | Outbound | OTP and notification delivery (wired in `src/lib/sms.ts`, not fully deployed) |
| VAPID Web Push | Outbound | Push notifications (infrastructure exists, consumer not yet wired) |
| Logistics repo (`https://logistics.webwaka.app`) | Outbound | `parcel.*` events forwarded to logistics service via event bus |
| Dexie IndexedDB | Client | Offline mutation queue, seat/trip cache, conflict log, agent sessions, NDPR consent trail |

### 1.5 Gaps, Duplication, and Missing Functionality

#### Gaps
1. **No GPS update endpoint**: The `trips` table has `current_latitude`/`current_longitude` columns but there is no `PATCH /api/operator/trips/:id/location` endpoint or polling mechanism.
2. **SOS system incomplete**: Schema has full SOS field set but no trigger/clear/escalation endpoints.
3. **No QR code generation**: `receipts` table has a `qr_code` column but it is never populated.
4. **No passenger boarding scan**: The `bookings` table has `boarded_at` and `boarded_by` columns but no boarding/check-in endpoint.
5. **No refund flow**: Cancellations release seats but do not initiate Paystack/Flutterwave refunds.
6. **No schedule/recurrence system**: Trips must be manually created or cloned one by one. No recurring schedule (e.g. "daily 6am Lagos→Abuja") engine exists.
7. **No push notification consumer**: The event bus wires `booking:CONFIRMED` to a `console.log` placeholder. VAPID push is configured but not delivered.
8. **No SMS consumer**: `src/lib/sms.ts` exists but the booking confirmation and OTP confirmation flows are not fully plumbed.
9. **Agent offline sync is partial**: The Dexie `transactions` table correctly holds offline sales, but `getPendingTransactions()` is not called by the SyncEngine — agents must trigger sync manually or wait for the SW background sync tag.
10. **No multi-seat reservation atomicity**: The reserve endpoint accepts one seat at a time. Booking multiple seats requires multiple round trips, creating a race condition window.
11. **Dual domain model / API implementation split**: `src/core/seat-inventory/index.ts` and `src/core/booking/index.ts` are in-memory implementations that diverge from the D1 API logic. No shared interface enforces consistency.
12. **No rate limiting on standard API endpoints**: Only AI search is rate-limited. Auth OTP has no rate limiter in the code (only documented as needed).
13. **No real-time seat update mechanism**: Seat availability is polled — there is no WebSocket, SSE, or Durable Object push to notify other clients when a seat is taken.

#### Duplication Risks
- `genId()` in `src/api/types.ts` and `nanoid()` in `@webwaka/core` both generate IDs. There are now two ID generation strategies in the same codebase.
- `publishEvent()` is imported from both `@webwaka/core` and `src/core/events/index.ts` in different routers — the local re-export must match the core implementation exactly.
- Trip creation logic exists in both `seat-inventory.ts` (creates trips with seats) and `operator-management.ts` (also creates trips with seats) — duplicated SQL and batch logic.

#### Reuse Opportunities
- The `applyTenantScope()` helper in `types.ts` could move to `@webwaka/core` and be shared across all repos.
- The `parsePagination()` and `metaResponse()` helpers are generic and belong in `@webwaka/core`.
- The NDPR consent recording pattern appears in both the offline DB and the server API — a single platform service should own consent.

---

## 2. Nigeria Transport Market Research Summary

### 2.1 Key Transport Patterns

**Intercity dominance**: Nigeria's intercity bus transport market is one of the largest in Africa. The Lagos–Abuja corridor alone moves an estimated 10,000–15,000 passengers per day. Other high-volume corridors include Lagos–Ibadan, Lagos–Benin, Abuja–Kano, Port Harcourt–Owerri, and Lagos–Owerri.

**Bus park centrality**: Unlike hub-and-spoke airline models, Nigerian bus travel is organized around motor parks (bus parks). Major parks — Ojota, Jibowu, and Mile 2 in Lagos; Utako and Mararaba in Abuja; Onitsha main market — are the physical nerve centers of the transport network. Passengers show up at the park, agents sell them tickets, and buses depart when full or at a scheduled time depending on the operator.

**Two scheduling models coexist**:
- **Full-bus (departure-time)**: Luxury operators (ABC Transport, GUO, Peace Mass Transit, Chisco) run fixed-departure schedules with advance booking. Seats are assigned, passengers expect their specific seat.
- **Fill-and-go (load-and-depart)**: Budget operators fill the bus and leave when full. No fixed departure time. Agents sell seats from the front of the queue. Seat assignment is informal.

**Seasonal peaks**: Travel surges dramatically around Eid (Eid al-Fitr, Eid al-Adha), Christmas, Easter, and major public holidays. Seat availability drops to near zero 24–72 hours before these peaks. Operators often run 200–400% of normal capacity.

### 2.2 Passenger and Agent Behavior

**Payment behavior**:
- Cash is king at the bus park. The vast majority of agent sales are cash transactions.
- Mobile money (Opay, PalmPay, Moniepoint, MTN MoMo) is growing rapidly and is now common at parks in Lagos, Abuja, and Port Harcourt.
- Bank transfer (USSD and app-based) is used by more affluent passengers.
- Online card payments (Paystack, Flutterwave) are used by passengers booking in advance via mobile app or web.
- Trust is a significant issue: passengers often distrust online payments without immediate physical confirmation.

**Booking behavior**:
- Walk-in purchases (same-day, at the park) remain the dominant mode.
- Advance booking is growing, particularly for long-distance routes (>5 hours).
- Passengers heavily favor WhatsApp for post-booking support (confirming a booking, requesting refunds, asking about delays).
- Many passengers are semi-literate in English but fluent in Yoruba, Igbo, or Hausa — vernacular UI is a meaningful differentiator.

**Agent behavior**:
- Agents work on commission. Speed of transaction is critical — a slow POS means lost revenue.
- Agents frequently operate in areas with 2G or intermittent 3G. Offline-first is not a feature, it is a survival requirement.
- Agents share devices. Multi-session or fast agent switching on a single device is a real use case.
- Agents manually track cash in paper ledgers. Any digital tool that replaces this must be simpler and faster.
- Supervisors reconcile agent cash daily — a daily float reconciliation workflow is expected.

**Operator behavior**:
- Mid-sized operators (20–100 buses) are the primary target segment. They are organized enough to benefit from digital tools but not large enough to have built their own systems.
- Small operators (1–5 buses) are highly price-sensitive and may share infrastructure.
- Operators are deeply concerned with driver accountability and bus utilization.
- Driver absenteeism, mechanical breakdown, and route deviation are the top operational pain points.

### 2.3 Operational Realities

**Connectivity**:
- Lagos, Abuja, Port Harcourt: intermittent 4G/LTE. Apps function with occasional drops.
- Secondary cities (Owerri, Enugu, Calabar, Ibadan): 3G typical, 4G in commercial areas.
- Bus parks on outskirts and inter-state routes: 2G/EDGE, GPRS. Data throughput can be as low as 10–50 Kbps.
- Power outages affect charging cycles. Agents may be on low-battery devices.

**Compliance**:
- **NDPR (Nigeria Data Protection Regulation)**: Enforced by the Nigeria Data Protection Bureau. Passenger PII requires explicit consent, retention limits, and data subject rights support.
- **FIRS (Federal Inland Revenue Service)**: Financial records must be retained 7 years. VAT applies to transport services above threshold.
- **VIO/FRSC (Vehicle Inspection Officers / FRSC)**: Vehicles must carry valid documents. Digital manifests can support compliance checks at road stops.
- **NIMET weather data**: Long-distance operators are expected to monitor weather-related route disruptions.

**Trust and fraud patterns**:
- Double-selling of seats is a known fraud vector — two agents on different devices selling the same seat simultaneously.
- Receipt forgery is common where paper receipts are used. QR-coded digital receipts are a fraud deterrent.
- Agent float fraud: agents collect cash but under-report sales. Daily reconciliation tools directly address this.
- Ghost passengers: manifests may include fake names to inflate head counts. Digital boarding scan closes this loop.

### 2.4 Market and Ecosystem Insights

- The Nigerian intercity bus market is fragmented — thousands of operators, no single dominant player with more than ~5% of routes.
- Digital transformation is accelerating rapidly: GUO, ABC, and Peace Mass Transit all have basic booking apps, but their systems are aging and poorly mobile-optimized.
- Aggregation platforms (Buupass, Treepz/Shuttlers) have gained traction but are primarily focused on commuter/shuttle services rather than intercity.
- There is no dominant interoperable seat inventory system — operators currently do not sell seats through each other's systems.
- Logistics adjacency is real: almost every intercity bus carries parcels alongside passengers. Parcel revenue represents 10–20% of total revenue for many operators.

### 2.5 Product Implications

- Every feature must be designed for 2G minimum. Payload size, request count, and image size matter.
- The receipt is a trust artifact. It must look professional, carry a unique ID, and be verifiable.
- Offline capability is not optional — it is the primary mode for agents at many parks.
- Seat assignment matters to passengers on luxury routes. Seat class (window, aisle, front, VIP) is a revenue opportunity.
- Real-time seat availability is a strong competitive advantage — most operators still call each other by phone to check seats.
- Driver and vehicle compliance documentation (license, roadworthiness) should be managed in the platform to build trust with regulators.
- Parcel/logistics integration with the WebWaka logistics repo is a natural revenue extension, not a future-state idea.

---

## 3. Top 20: Seat Inventory Synchronization Enhancements

---

### S-01: Multi-Seat Atomic Reservation
**Title**: Atomic multi-seat batch reservation in a single API call  
**Description**: Replace the current single-seat reserve endpoint with a batch version that reserves N seats atomically inside a D1 transaction. If any seat is unavailable, the entire batch is rejected and no seats are held.  
**Why it matters**: The current design requires the client to make N sequential `/reserve` calls. Between calls, another agent can claim a seat the customer intended to book, leading to partial reservations, UI confusion, and customer frustration.  
**Implementation**: `POST /api/seat-inventory/trips/:id/reserve-batch` accepting `{ seat_ids: string[], user_id: string }`. Implemented as a D1 batch with a conditional `WHERE status = 'available'` check on every row before writing.  
**Reuse/Integration**: Build in this repo. Expose via `@webwaka/core` as a shared utility type. Booking Portal and Agent POS both benefit.  
**Dependencies**: D1 batch API (already in use for trip creation).  
**Priority**: Critical

---

### S-02: Configurable Reservation TTL Per Operator
**Title**: Per-operator configurable seat reservation TTL  
**Description**: Allow operators to set custom reservation TTL windows (e.g. 5 minutes for online bookings, 2 minutes for agent POS, 60 minutes for VIP routes). Currently hardcoded at 30 seconds, which is too short for online payment flows.  
**Why it matters**: 30 seconds is insufficient for Paystack/Flutterwave redirected payment pages (typical payment completion takes 60–180 seconds). Many bookings are abandoned not by choice but because the seat expires before payment completes.  
**Implementation**: Add `reservation_ttl_ms` to `TENANT_CONFIG_KV` per operator, read it in the reserve endpoint, cache per operator in Dexie `operator_config`. Default 30s remains for agent POS.  
**Reuse/Integration**: `TENANT_CONFIG_KV` already exists. Extend the operator config schema in `@webwaka/core`.  
**Dependencies**: S-05 (operator config service).  
**Priority**: Critical

---

### S-03: Real-Time Seat Availability via Cloudflare Durable Objects
**Title**: Real-time seat availability push using Cloudflare Durable Objects  
**Description**: Replace polling-based seat availability with a Durable Object per trip that broadcasts seat state changes via WebSocket to all connected clients (agents, customer portal). When a seat is reserved or confirmed, all connected sessions see the update instantly.  
**Why it matters**: Without real-time updates, two agents simultaneously see seat "01" as available and attempt to sell it. The second one gets a 409 conflict. The customer who was about to pay sees an available seat that is then gone. Real-time eliminates these races.  
**Implementation**: A `TripSeatDO` Durable Object per trip stores current seat state in memory, accepts WebSocket upgrade from clients, and broadcasts `seat_state_changed` messages on every write. The existing D1 remains the source of truth; the DO is the broadcast layer.  
**Reuse/Integration**: Build in this repo. Expose the WebSocket URL to the booking portal frontend.  
**Dependencies**: Cloudflare Durable Objects binding in `wrangler.toml`.  
**Priority**: High

---

### S-04: Seat Class and Pricing Tiers
**Title**: Seat class support (standard, window, VIP, front) with class-based pricing  
**Description**: Extend the `seats` table schema to support `seat_class` (currently exists as a column but always defaults to `standard`) with class-specific pricing overrides at the trip or route level.  
**Why it matters**: Luxury operators charge premiums for VIP sections, front seats, and window seats. This is a direct revenue lever — operators who can charge ₦2,000 more for a front seat on a 5-hour trip will. Passengers who prefer specific seats will pay for the certainty.  
**Implementation**: Add `seat_class_prices` JSON column to `routes` table. Populate `seat_class` on seat creation from a vehicle seat map template. Expose `seat_class` in the availability response.  
**Reuse/Integration**: Build in this repo. Revenue reporting module benefits immediately.  
**Dependencies**: Vehicle seat map template (see O-03).  
**Priority**: High

---

### S-05: Operator Config Service via TENANT_CONFIG_KV
**Title**: Centralized operator configuration service with KV caching  
**Description**: Build a dedicated operator config API (`GET/PUT /api/operator/config`) that reads and writes to `TENANT_CONFIG_KV` and is mirrored in the Dexie `operator_config` offline cache. Config keys include: reservation TTL, seat class prices, fare multipliers, boarding window, parcel acceptance, etc.  
**Why it matters**: Currently per-operator customization is hardcoded or absent. Without a config service, every operator customization requires a code change.  
**Implementation**: Extend `wrangler.toml` to bind `TENANT_CONFIG_KV`. Build `GET /api/operator/config` and `PUT /api/operator/config` in `operator-management.ts`. Cache result in Dexie `operator_config` with 1-hour TTL (already implemented in `db.ts`).  
**Reuse/Integration**: Shared by TRN-1, TRN-2, TRN-3, TRN-4. Expose config type in `@webwaka/core`.  
**Dependencies**: None (KV binding already in wrangler.toml as placeholder).  
**Priority**: High

---

### S-06: Seat Hold Extension (Heartbeat)
**Title**: Seat reservation heartbeat / extension endpoint  
**Description**: Provide a `POST /api/seat-inventory/trips/:id/extend-hold` endpoint that refreshes the TTL on a held seat, provided the requesting user holds the valid token and the seat has not yet expired. This supports longer payment flows without requiring a full re-reservation.  
**Why it matters**: Payment pages sometimes take 2–3 minutes. With a configurable TTL (S-02), a 2-minute window is workable, but only if the client can extend it while the user is actively on the payment page.  
**Implementation**: Simple `UPDATE seats SET reservation_expires_at = ? WHERE id = ? AND reservation_token = ?`. Expose configurable max extensions per hold (e.g. 3 extensions of 60s each).  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: S-02 (configurable TTL).  
**Priority**: High

---

### S-07: Seat Availability Delta Sync (Incremental Polling)
**Title**: Delta-based seat availability sync for offline agents  
**Description**: Add a `GET /api/seat-inventory/trips/:id/availability?since=<timestamp>` endpoint that returns only seat rows whose `updated_at` is after the given timestamp. Agents cache seats locally and sync only the delta on connectivity restoration, reducing payload size significantly.  
**Why it matters**: On a 50-seat bus at a busy Lagos park with 10 agents on 2G, polling the full seat map every 30 seconds is 10 × 50 rows × every 30s. Delta sync reduces this to a few changed rows per poll.  
**Implementation**: Add `updated_at` index on `seats` (already exists). Filter by `updated_at > ?` in the availability query.  
**Reuse/Integration**: Build in this repo. SyncEngine uses this as the pull strategy in offline mode.  
**Dependencies**: Seat cache in Dexie (already exists).  
**Priority**: Medium

---

### S-08: Seat Block / Unblock by Operator
**Title**: Bulk seat blocking for maintenance, staff, or VIP hold  
**Description**: Provide `POST /api/seat-inventory/trips/:id/block` and `POST /api/seat-inventory/trips/:id/unblock` endpoints accepting arrays of seat IDs. Blocked seats are visible in the seat map as unavailable but carry a reason field (maintenance, staff, VIP hold, driver seat).  
**Why it matters**: Operators routinely block certain seats (driver companion, load inspector, VIP guest). Currently there is no way to mark a seat as blocked without manually setting status — and no way to record why it was blocked.  
**Implementation**: Add `blocked_by`, `blocked_reason`, `blocked_at` columns to `seats`. Batch `UPDATE` via D1 batch.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Medium

---

### S-09: Conflict Resolution UI for Seat Sync Conflicts
**Title**: Agent-facing seat conflict resolution panel  
**Description**: Surface the Dexie `conflict_log` as an in-app panel for agents, allowing them to see which mutations conflicted during sync and choose to retry, accept the server's state, or discard the local mutation. Currently `ConflictLog` component exists but is not prominent.  
**Why it matters**: When an agent sells a seat offline and the sync discovers that seat was already sold online, the conflict is silently logged. Agents have no visibility. This leads to double-selling disputes that are resolved manually and angrily.  
**Implementation**: `ConflictLog` component already exists in `src/components/conflict-log.tsx`. Promote it to a primary notification badge in the Agent POS module. Wire `resolveConflict()` from `db.ts` to the retry/accept/discard buttons.  
**Reuse/Integration**: Build in this repo (frontend only).  
**Dependencies**: None.  
**Priority**: Medium

---

### S-10: Version-Based Optimistic Locking Enforcement
**Title**: Server-side version check enforcement for seat mutations  
**Description**: The `seats` table carries a `version` column that is incremented on every update. Currently the version is tracked but not enforced as a precondition on `PATCH` requests. Enforce `version` as a required precondition: reject mutations where the submitted version does not match the current DB version.  
**Why it matters**: Without version enforcement, two offline agents can both read version 3 of a seat, make independent modifications, and both succeed on sync — silently overwriting each other. With version enforcement, the second write gets a 409 conflict.  
**Implementation**: Add `AND version = ?` to `WHERE` clause on all seat `UPDATE` statements. Return 409 on version mismatch.  
**Reuse/Integration**: Build in this repo. Propagate to SyncEngine conflict handling.  
**Dependencies**: S-09 (conflict resolution UI).  
**Priority**: Medium

---

### S-11: Seat Map Visual Representation API
**Title**: Structured seat map layout API for front-end rendering  
**Description**: Extend the availability response to include a structured seat map layout (rows, columns, aisle positions) derived from the vehicle's seat configuration template. This enables the frontend to render an accurate visual seat map (bus interior view) instead of a flat grid.  
**Why it matters**: Passengers strongly prefer selecting a specific seat by its visual position (window/aisle/front/back) rather than by number. This is a booking conversion driver for the customer portal.  
**Implementation**: Add a `seat_layout` JSON column to `vehicles` defining row/column/aisle structure. Return `layout` alongside `seats` in the availability response.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: Vehicle seat map template (O-03).  
**Priority**: Medium

---

### S-12: Seat Inventory Snapshot for Audit
**Title**: Point-in-time seat inventory snapshot for audit and dispute resolution  
**Description**: Implement a `POST /api/seat-inventory/trips/:id/snapshot` endpoint that writes the current seat states to an immutable `seat_snapshots` table. Snapshots can be triggered at departure boarding, at trip completion, or on demand by SUPER_ADMIN.  
**Why it matters**: When a dispute arises ("I bought seat 14 but someone else was sitting in it"), there is no immutable record of who held seat 14 at what time. A snapshot at boarding resolves disputes quickly.  
**Implementation**: New `seat_snapshots` table with `trip_id`, `snapshot_at`, `snapshot_data` (JSON of all seat states). Triggered manually and by trip state transition to `in_transit`.  
**Reuse/Integration**: Build in this repo. SUPER_ADMIN and TENANT_ADMIN access only.  
**Dependencies**: None.  
**Priority**: Low

---

### S-13: KV-Backed Seat Availability Edge Cache
**Title**: Cloudflare KV edge cache for seat availability with event-driven invalidation  
**Description**: Cache the full seat availability response per trip in `SEAT_CACHE_KV` with a 30-second TTL. Serve cached responses for public reads. Invalidate the cache entry via the event bus when a seat changes state.  
**Why it matters**: During peak booking periods, the `GET /api/seat-inventory/trips/:id/availability` endpoint may receive hundreds of concurrent reads. Serving from KV eliminates D1 load and reduces latency globally.  
**Implementation**: `SEAT_CACHE_KV` binding already exists in `wrangler.toml`. On read: try KV first, fall back to D1. On write (reserve/confirm/release): delete the KV entry. Event bus already deletes KV on `seat:RESERVED` events (wired in `drainEventBus`).  
**Reuse/Integration**: Build in this repo. KV binding already exists.  
**Dependencies**: S-05 (operator config for TTL).  
**Priority**: Low

---

### S-14: Cross-Operator Seat Exchange Protocol
**Title**: Inter-operator seat inventory sharing protocol  
**Description**: Define and implement a protocol by which WebWaka SUPER_ADMIN can expose available seats from one operator's trip to another operator's booking portal (code-sharing / interline). This is an opt-in feature at the operator level.  
**Why it matters**: Popular routes are overbooked on some operators and underbooked on others simultaneously. Seat exchange allows passengers to be rerouted to the next available operator without leaving the platform.  
**Implementation**: Add `interline_enabled` flag to operators. Expose a cross-tenant seat availability query that SUPER_ADMIN can execute. Build an interline booking record referencing two operator_ids.  
**Reuse/Integration**: Build in this repo. Requires SUPER_ADMIN tooling.  
**Dependencies**: S-04 (seat class), S-05 (operator config).  
**Priority**: Low

---

### S-15: Automated Seat Reallocation on Vehicle Swap
**Title**: Seat remapping on vehicle change for a trip  
**Description**: When an operator changes the vehicle assigned to a trip (e.g. a bus breaks down and is replaced by a 45-seater instead of a 54-seater), automatically remap confirmed seats to equivalent positions in the new vehicle and notify affected passengers.  
**Why it matters**: Mid-operation vehicle swaps are common in Nigeria. Without automated remapping, confirmed bookings reference seat IDs that no longer exist on the new vehicle.  
**Implementation**: `PATCH /api/operator/trips/:id` vehicle change triggers a seat remapping job: cancels seats beyond the new vehicle capacity with event notifications, remaps remaining seats by position number.  
**Reuse/Integration**: Build in this repo. Notification delivery via shared notification service.  
**Dependencies**: S-04 (seat class), notification service.  
**Priority**: Low

---

### S-16: Seat Inventory Forecasting Dashboard
**Title**: AI-driven seat fill rate forecast for operators  
**Description**: Use historical booking and fill rate data per route and time-of-day to generate a 7-day fill rate forecast visible to operators. Expose this via `GET /api/operator/routes/:id/forecast`.  
**Why it matters**: Operators often under-schedule on high-demand days and over-schedule on low-demand days. A forecast gives them data to right-size their fleet allocation.  
**Implementation**: Compute rolling 4-week average fill rates per route and day-of-week. Optionally enhance with OpenRouter for anomaly commentary. Build in this repo, exposed via operator dashboard.  
**Reuse/Integration**: Vendor-neutral AI via OpenRouter (already wired in this repo).  
**Dependencies**: S-05 (operator config for window), historical data accumulation.  
**Priority**: Low

---

### S-17: Parcel Seat Blocking Integration
**Title**: Integrate parcel booking with seat blocking via logistics repo events  
**Description**: When the logistics repo confirms a parcel shipment on a specific trip, publish a `parcel.seats_required` event. The transport repo consumes this event and blocks the requested seats (luggage hold or dedicated parcel seats).  
**Why it matters**: Buses regularly carry parcels as cargo. Currently there is no mechanism for the logistics system to reserve seat/cargo capacity on a transport trip. Without integration, parcel loading is uncoordinated and frequently exceeds bus capacity.  
**Implementation**: Subscribe to `parcel.*` events from the logistics repo. Implement `deliverToConsumer` wiring for inbound parcel events. Block seats programmatically on matching trips.  
**Reuse/Integration**: Integration with logistics repo via event bus. Do NOT rebuild parcel management here.  
**Dependencies**: Logistics repo event schema, S-08 (seat blocking).  
**Priority**: Medium

---

### S-18: Waiting List / Standby Queue
**Title**: Automated waiting list with auto-assignment when seats become available  
**Description**: Allow customers to join a standby queue for fully booked trips. When a seat is released (cancellation, expiry), automatically notify the next person on the waiting list and give them a 10-minute priority reservation window.  
**Why it matters**: Fully booked trips turn away customers who would pay. A waiting list captures that demand and converts it on cancellations — which happen routinely (8–15% cancellation rate is typical).  
**Implementation**: New `waiting_list` table with `trip_id`, `customer_id`, `position`, `notified_at`. Trigger notification from `sweepExpiredReservations()` and `bookings/:id/cancel` endpoint.  
**Reuse/Integration**: Notification delivery via shared service. Build list management in this repo.  
**Dependencies**: SMS/push notification service.  
**Priority**: Medium

---

### S-19: Seat History Timeline per Seat ID
**Title**: Full audit timeline for each seat (available → reserved → confirmed → released)  
**Description**: Record every state transition for every seat in an immutable `seat_history` append-only log table, with timestamp, actor ID, and reason. Expose via `GET /api/seat-inventory/trips/:id/seats/:id/history`.  
**Why it matters**: Dispute resolution currently requires inferring history from partial data. A seat timeline gives SUPER_ADMIN and TENANT_ADMIN a complete chain of custody.  
**Implementation**: New `seat_history` table. Trigger inserts via the existing seat update endpoints. Lightweight — one row per transition.  
**Reuse/Integration**: Build in this repo. SUPER_ADMIN and TENANT_ADMIN access only.  
**Dependencies**: None.  
**Priority**: Low

---

### S-20: Seat Availability SSE Feed for Booking Portal
**Title**: Server-Sent Events stream for live seat availability on the booking portal  
**Description**: Implement a `GET /api/seat-inventory/trips/:id/live` SSE endpoint that pushes seat state changes to the customer portal as they happen. As an alternative to full Durable Objects (S-03), SSE is simpler to deploy and sufficient for the booking portal's read-only use case.  
**Why it matters**: Customers on the booking portal often wait on the seat selection screen while choosing. Without live updates, they select a seat that another customer just confirmed, triggering a jarring conflict error.  
**Implementation**: SSE endpoint using Cloudflare Workers' `ReadableStream`. Each seat mutation triggers a broadcast via a lightweight fanout mechanism (Durable Object or KV-polling fallback).  
**Reuse/Integration**: Build in this repo. Lower complexity than S-03 — implement S-20 first, upgrade to S-03 if needed.  
**Dependencies**: None.  
**Priority**: Medium

---

## 4. Top 20: Offline Agent Sales / Bus Park POS Enhancements

---

### A-01: Offline Transaction Auto-Sync on Reconnect
**Title**: Automatic offline transaction flush on network restoration  
**Description**: Currently the Dexie `transactions` table (agent offline sales) is populated correctly but `getPendingTransactions()` is not called by the SyncEngine. Wire the offline transaction flush into the SyncEngine so that agent sales created offline are automatically batched and submitted to `POST /api/agent-sales/sync` when connectivity returns.  
**Why it matters**: Agents who sold tickets offline during a network outage currently have no automated path to sync those sales. They may forget, the sync may never run, and the official record is permanently missing those transactions.  
**Implementation**: Add `entity_type: 'transaction'` to the SyncEngine route mapping (it only handles CREATE). On `queueAndSync`, serialize the offline transaction payload through the existing mutation queue.  
**Reuse/Integration**: Build in this repo. Minor change to `src/core/offline/sync.ts`.  
**Dependencies**: None.  
**Priority**: Critical

---

### A-02: Thermal Receipt Printing Support
**Title**: Agent POS print-to-thermal-printer integration  
**Description**: Implement a browser Print API-based receipt template optimized for 58mm and 80mm thermal printers commonly available at Nigerian bus parks. The receipt must include: operator name, route, departure time, seat number(s), passenger name, amount paid, payment method, receipt ID, and a QR code linking to the booking verification URL.  
**Why it matters**: Paper receipts are required in Nigerian bus parks for boarding control and passenger peace of mind. Agents currently handwrite or use pre-printed generic receipts — which are easily forged. A digital-to-thermal receipt is a fraud deterrent and a professionalism signal.  
**Implementation**: Add a CSS `@media print` stylesheet targeting 58mm/80mm width. Add QR code generation (use a lightweight browser-side library). Trigger via `window.print()`. Do not require a native app.  
**Reuse/Integration**: Build in this repo (frontend). `qr_code` column already exists in `receipts` table.  
**Dependencies**: QR code library (browser-compatible).  
**Priority**: Critical

---

### A-03: Agent Daily Float Reconciliation
**Title**: End-of-day cash float reconciliation workflow for agents  
**Description**: Add a float reconciliation flow where agents submit their physical cash count at end of day. The system compares this against expected sales totals (from transaction records) and flags discrepancies. Supervisors review and sign off reconciliations.  
**Why it matters**: The primary pain point for operators managing agents is float accountability. Without digital reconciliation, under-reporting by agents (keeping the difference between cash collected and reported sales) is extremely common and hard to detect.  
**Implementation**: New `float_reconciliation` table. `POST /api/agent-sales/reconciliation` accepts `agent_id`, `date`, `cash_submitted_kobo`. Compare against `SUM(total_amount)` for confirmed cash transactions for that agent and date. Publish discrepancy events.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Critical

---

### A-04: Multi-Agent Device Session Management
**Title**: Fast agent switching and multi-session support on shared devices  
**Description**: Enable multiple agents to log in and out quickly on a single shared device (tablet or phone). Each agent's session is stored in the Dexie `agent_sessions` table. Switching agents flushes the current session's offline queue, logs out, and loads the next agent's session and pending transactions.  
**Why it matters**: At a busy bus park, a single tablet may be handed between 2–3 agents during a shift. Currently, one login is implicitly assumed. Agents sharing a device share a session, making per-agent accountability impossible.  
**Implementation**: Add agent-select screen on POS. On agent switch: call `syncEngine.flush()`, then clear auth state, then initialize new agent session from `agent_sessions` Dexie table. Prompt login if session expired.  
**Reuse/Integration**: Build in this repo (frontend). `AgentSession` type already exists in `db.ts`.  
**Dependencies**: A-01 (offline sync).  
**Priority**: High

---

### A-05: Passenger ID Capture at POS
**Title**: Optional NIN / BVN / passport ID capture at point of sale  
**Description**: Add optional identity document fields to the agent sale form (National Identification Number, BVN, passport number). Store these fields (encrypted or hashed) in the transaction record and include them on the trip manifest.  
**Why it matters**: Nigerian law enforcement (FRSC, police) increasingly requires bus manifests to include passenger identification. Operators face fines and delays at checkpoints if manifests are incomplete. ID capture at POS closes this gap.  
**Implementation**: Add `passenger_id_type` and `passenger_id_number` (SHA-256 hashed for NDPR compliance) to `sales_transactions`. Add to the POS form as optional fields. Include in manifest export.  
**Reuse/Integration**: Build in this repo. NDPR-compliant — hash before storage, never display in full.  
**Dependencies**: A-02 (receipt with ID reference).  
**Priority**: High

---

### A-06: Agent Performance Leaderboard and Incentive Tracking
**Title**: Agent sales performance dashboard with commission calculation  
**Description**: Add a supervisor-level performance dashboard showing per-agent sales count, revenue, average fare, payment method mix, and sync reliability. Include a configurable commission rate per agent, calculated from confirmed transaction totals.  
**Why it matters**: Operators manage agent commission payments manually and often inaccurately. A digital commission calculator prevents disputes and gives supervisors real-time visibility into which agents are performing.  
**Implementation**: Add `commission_rate` to `agents` table. Build `GET /api/agent-sales/performance?period=today|week|month` aggregating per-agent stats. Frontend leaderboard for supervisors.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: A-03 (reconciliation data for accuracy).  
**Priority**: High

---

### A-07: Bus Park / Terminal Management
**Title**: Bus park and terminal registry with agent-to-park assignment  
**Description**: Build a `bus_parks` entity (name, city, state, GPS coordinates, operator associations). Assign agents to one or more parks. Filter trip and seat views by park when the agent is at a specific park.  
**Why it matters**: Large operators have agents at multiple parks simultaneously. Currently `bus_parks` in the `agents` table is a raw JSON string. A proper park registry enables per-park analytics, agent deployment, and passenger-facing "buy at this park" information.  
**Implementation**: New `bus_parks` table. Assign agents via `agent_bus_parks` junction table. Add `park_id` filter to trip queries.  
**Reuse/Integration**: Build in this repo. Park location data can be shared with the booking portal for "nearest park" feature.  
**Dependencies**: None.  
**Priority**: Medium

---

### A-08: Offline Seat Map Caching with Background Refresh
**Title**: Pro-active offline seat map caching before agents lose connectivity  
**Description**: When an agent device detects good connectivity, pre-fetch and cache the seat availability maps for all upcoming trips assigned to their park. The cache refreshes every 5 minutes when online. Agents on 2G or offline see the cached map with a staleness indicator.  
**Why it matters**: Currently seat maps are fetched on demand. An agent who loses connectivity mid-POS flow can no longer see the seat map. Pro-active caching eliminates this failure mode for expected offline periods.  
**Implementation**: Use the Service Worker `background-fetch` API (or periodic background sync) to pre-fetch availability for the next 4 hours of trips. Store results in Dexie `seats` table. Display age of cache to agent.  
**Reuse/Integration**: Build in this repo. Leverages existing Dexie seat cache infrastructure.  
**Dependencies**: A-07 (park assignment to filter relevant trips).  
**Priority**: Medium

---

### A-09: Agent WhatsApp Receipt Sharing
**Title**: One-tap WhatsApp receipt sharing from the POS  
**Description**: After completing a sale, show a "Share via WhatsApp" button that deep-links to `wa.me/?text=...` with the receipt details (passenger name, route, seat, amount, receipt ID, verification link) pre-filled. Agents can send the receipt to passengers who don't have printers.  
**Why it matters**: WhatsApp is the primary communication channel for Nigerian passengers. Sharing a digital receipt via WhatsApp is faster and more trusted than a paper receipt that can be lost.  
**Implementation**: Construct a URL-encoded WhatsApp message from the receipt data. Use the `wa.me/?text=` deep link. No WhatsApp Business API needed.  
**Reuse/Integration**: Build in this repo (frontend). Zero backend work required.  
**Dependencies**: A-02 (receipt data).  
**Priority**: Medium

---

### A-10: Agent Offline Authentication with JWT Replay Window
**Title**: Extend offline agent authentication validity for extended offline periods  
**Description**: Allow agents to continue operating the POS for up to 8 hours after their JWT expires, provided the token was valid at the last sync. The `agent_sessions` Dexie table already stores `expires_at` but currently invalidates the session immediately on expiry.  
**Why it matters**: An agent who starts their shift with a valid token, goes offline for 4 hours during a long journey, and then tries to finalize a sale at the destination will be locked out if their 1-hour JWT expires mid-shift.  
**Implementation**: Extend the `expires_at` check in `getAgentSession()` to allow a configurable grace period (`offline_auth_grace_ms`, default 8 hours). Log a warning when operating in grace period. Require fresh login on next online sync.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Medium

---

### A-11: Trip Quick-Select via QR Code Scan
**Title**: Trip selection by QR code scan at bus park kiosks  
**Description**: Allow agents to tap a QR code printed on a bus or manifest board to instantly load that trip into the POS, bypassing the trip dropdown search. The QR encodes the `trip_id`.  
**Why it matters**: At a busy park with 20+ buses running simultaneously, finding the right trip in a dropdown is slow and error-prone. A QR scan is instant and eliminates wrong-trip mistakes.  
**Implementation**: Use the browser `getUserMedia` camera API (works on mobile without app installation). Decode QR in-browser using a lightweight library. Navigate to seat selection for the decoded `trip_id`.  
**Reuse/Integration**: Build in this repo (frontend). QR codes are already planned for receipts.  
**Dependencies**: QR code library.  
**Priority**: Medium

---

### A-12: POS Dark Mode for Outdoor Use
**Title**: High-contrast / outdoor mode for agent POS  
**Description**: Add a high-contrast display mode (dark background, large high-contrast text) optimized for agents using phones in direct sunlight at outdoor bus parks.  
**Why it matters**: Standard web UI contrast ratios are unreadable in direct outdoor sunlight in Nigeria (noon sun is intense). This is a genuine usability issue that affects transaction speed and error rate.  
**Implementation**: Add a `prefers-contrast: more` media query + a manual toggle. Use CSS variables for the color scheme.  
**Reuse/Integration**: Build in this repo (frontend).  
**Dependencies**: None.  
**Priority**: Low

---

### A-13: Agent Communication Channel (Broadcast Announcements)
**Title**: Operator → agent broadcast messaging system  
**Description**: Enable operators (TENANT_ADMIN, SUPERVISOR) to send broadcast messages to all active agents (e.g. "Bus 14 delayed 2 hours", "Price increase for Abuja routes from today"). Messages appear as a notification banner in the POS.  
**Why it matters**: Currently operators communicate with agents via personal WhatsApp, which is untracked and unreliable. In-app broadcasts give operators a formal coordination channel and create an audit trail of operational communications.  
**Implementation**: New `agent_broadcasts` table. `POST /api/agent-sales/broadcasts` (SUPERVISOR+). Agents pull unread broadcasts on login and on sync. Display as dismissible banner.  
**Reuse/Integration**: Build in this repo. Optionally forward via SMS to agents who are offline.  
**Dependencies**: None.  
**Priority**: Low

---

### A-14: Supervisor Remote Cash Drawer Audit
**Title**: Remote real-time supervisor view of agent sales (streaming)  
**Description**: Give supervisors a live view of all agent transactions as they happen, filterable by agent and trip, with running revenue totals. This is a real-time overlay for park supervisors who walk the floor.  
**Why it matters**: Supervisors currently have no live visibility without calling agents individually. A live dashboard allows supervisors to spot anomalies (agent selling at wrong price, unusual number of cash transactions) in real time.  
**Implementation**: `GET /api/agent-sales/live-feed?agent_id=&park_id=` SSE stream returning new transaction events. Frontend renders an updating transaction ticker.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: A-07 (park assignment).  
**Priority**: Low

---

### A-15: Agent Commission Payout Integration
**Title**: Commission calculation output to payroll/disbursement  
**Description**: Generate a commission payout summary per agent per period, exportable as CSV or via API, suitable for import into the operator's payroll system or direct disbursement via Paystack Transfer API.  
**Why it matters**: Operators pay agents weekly or bi-weekly. Manual calculation is error-prone and a common source of agent disputes.  
**Implementation**: `GET /api/agent-sales/commissions?period=week&agent_id=` returns calculated commission. Add Paystack Transfer API integration to initiate direct bank transfers. Requires operator's Paystack subaccount configuration.  
**Reuse/Integration**: Build in this repo. Payments integration is already present.  
**Dependencies**: A-06 (commission rate), Paystack Transfer API.  
**Priority**: Low

---

### A-16: Fare Override with Approval Workflow
**Title**: Agent fare override with supervisor approval for dynamic pricing  
**Description**: Allow agents to submit a fare override request (e.g. negotiated group fare) which is approved or rejected by a supervisor in real time. Only approved overrides take effect.  
**Why it matters**: Group bookings, VIP clients, and last-minute discounts are real scenarios where agents need flexibility. Without an override system, agents discount informally (pocket the difference). With an approval workflow, every discount is authorized and auditable.  
**Implementation**: Add `override_approved_by`, `override_reason` to `sales_transactions`. `POST /api/agent-sales/fare-override-request`. Push approval request to supervisor via SSE or WebSocket.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: A-14 (supervisor visibility).  
**Priority**: Low

---

### A-17: Group Booking Workflow for Agents
**Title**: Batch group booking for student groups, corporate travel, pilgrimage  
**Description**: Add a group booking mode to the POS where an agent can book multiple seats (5–30) for a named group, entering group leader details once and distributing seats automatically. Generate a group manifest PDF.  
**Why it matters**: Group travel (schools, churches, Hajj pilgrims, corporate events) represents a significant revenue segment. Booking 20 seats individually in the current POS takes 20× the time and has 20× the error surface.  
**Implementation**: Add `group_booking_id` foreign key to `sales_transactions`. `POST /api/agent-sales/group-bookings` accepts count, group_name, leader phone, and distributes available seats.  
**Reuse/Integration**: Build in this repo. Generate manifest PDF via browser print (no server-side PDF needed).  
**Dependencies**: A-01 (sync), A-02 (receipt).  
**Priority**: Medium

---

### A-18: Offline Trip Creation Mode
**Title**: Allow agents to create new trip records offline when operator system is down  
**Description**: Give SUPERVISOR-level agents the ability to create a trip record offline (using a locally cached route and vehicle) that is queued for sync and server-side validation when connectivity returns.  
**Why it matters**: When the backend is unreachable (rare but possible), agents cannot create new trips even though the bus and route are known. Offline trip creation allows operations to continue and sync reconciliation to handle conflicts.  
**Implementation**: Extend SyncEngine entity type to include `trip` CREATE mutations. Add offline trip form to the operator section of the POS (SUPERVISOR+ only).  
**Reuse/Integration**: Build in this repo. `entity_type: 'trip'` is already defined in the SyncEngine route mapping.  
**Dependencies**: A-01 (sync).  
**Priority**: Low

---

### A-19: POS Performance Optimization for Low-End Devices
**Title**: Lightweight POS mode for entry-level Android phones  
**Description**: Provide a simplified "lite" POS mode that strips all non-essential UI, reduces JavaScript bundle size, and disables animations. The lite mode is auto-detected based on `navigator.deviceMemory < 2` or manually toggled.  
**Why it matters**: Many bus park agents in secondary cities use entry-level Android phones (512MB RAM, slow CPUs). The current full React PWA may lag or crash on these devices, making the tool unusable.  
**Implementation**: Use React lazy-loading and code splitting to create a lite bundle. Replace heavy components with minimal HTML forms. Target < 100KB initial JS load for lite mode.  
**Reuse/Integration**: Build in this repo (frontend). Pure optimization work.  
**Dependencies**: None.  
**Priority**: Medium

---

### A-20: Agent Dispute and Escalation Ticket System
**Title**: In-app dispute and escalation ticketing for agents  
**Description**: Allow agents to file a dispute ticket (wrong price charged, passenger complaint, system error) from within the POS. Tickets are routed to the supervisor, who can escalate to TENANT_ADMIN or SUPER_ADMIN. All parties can view ticket status.  
**Why it matters**: Currently disputes are handled via phone calls or WhatsApp groups, leaving no audit trail. A ticket system creates accountability, documents resolutions, and gives SUPER_ADMIN visibility into operational issues across operators.  
**Implementation**: New `dispute_tickets` table. `POST /api/agent-sales/disputes`. SUPERVISOR and above can respond and close tickets. Front-end ticketing panel in POS.  
**Reuse/Integration**: Build in this repo. Optionally notify via SMS/push from the shared notification service.  
**Dependencies**: None.  
**Priority**: Low

---

## 5. Top 20: Customer Booking Portal Enhancements

---

### B-01: Integrated Paystack Payment Flow (In-Portal)
**Title**: Embedded Paystack payment without redirect — inline Popup SDK  
**Description**: Replace the current external redirect payment flow with the Paystack Inline Popup SDK, which opens a payment modal in the same browser window. The user pays without leaving the booking portal, and the confirmation is handled by the existing webhook.  
**Why it matters**: External redirects cause ~30–40% additional abandonment in Nigerian mobile banking UX. Staying in-portal maintains context and reduces the perceived risk of payment.  
**Implementation**: Load `https://js.paystack.co/v1/inline.js`. Initiate popup on "Pay Now" click with the booking's `payment_reference`. On `onSuccess`, call `PATCH /api/booking/bookings/:id/confirm`.  
**Reuse/Integration**: Build in this repo (frontend). Paystack already integrated on backend.  
**Dependencies**: S-02 (extended TTL to accommodate payment).  
**Priority**: Critical

---

### B-02: SMS Booking Confirmation and E-Ticket
**Title**: SMS booking confirmation with e-ticket link sent to passenger phone  
**Description**: Wire the `booking.created` event consumer in `drainEventBus()` to send an SMS via Termii/Yournotify to the passenger's phone with: trip details, seat number(s), boarding time, receipt ID, and a short URL to their digital e-ticket.  
**Why it matters**: Passengers frequently lose track of their booking reference, especially if they booked days in advance. An SMS confirmation is the single most requested feature by passengers in Nigerian transport apps. It also serves as the boarding pass.  
**Implementation**: `src/lib/sms.ts` already exists. Wire it into the `booking.created` event handler in `drainEventBus()`. Generate a short booking URL (`webwaka.ng/b/{id}`).  
**Reuse/Integration**: SMS library is already in this repo. Shared notification service could own this long-term.  
**Dependencies**: `booking.created` event already published.  
**Priority**: Critical

---

### B-03: E-Ticket with QR Boarding Pass
**Title**: Shareable digital e-ticket with scannable QR boarding pass  
**Description**: Generate a browser-renderable e-ticket page (`/ticket/{booking_id}`) containing all trip details, seat assignment, passenger name, and a QR code encoding `{booking_id}:{seat_id}` for scanning at the boarding gate.  
**Why it matters**: Physical boarding passes are easily lost. A digital e-ticket on the passenger's phone (saved to home screen or PDF) serves as the boarding document. The QR code enables fast digital boarding scan by the driver or supervisor.  
**Implementation**: Public `GET /ticket/:id` route serving a minimal HTML e-ticket. QR encodes `booking_id:seat_id` pair. Also returned as a link in the SMS (B-02).  
**Reuse/Integration**: Build in this repo. Boarding scan endpoint needed in TRN-4 (see D-03).  
**Dependencies**: B-02 (SMS delivery of the ticket link).  
**Priority**: Critical

---

### B-04: Guest Booking Without Account Creation
**Title**: Phone-number-only guest booking (no account required)  
**Description**: Allow passengers to book a seat by providing only their phone number (OTP-verified) and passenger name, without creating a full account. Booking is confirmed via SMS. Account can be created post-booking if desired.  
**Why it matters**: The current flow requires NDPR consent + customer registration before booking. Many passengers abandon at the registration step. A guest booking flow (OTP → seat selection → payment → SMS ticket) reduces friction to the minimum.  
**Implementation**: Introduce a `guest_booking` flag on bookings. Guest customer records are created with a system-generated ID and name from the passenger_names field. Full NDPR consent still collected on first booking.  
**Reuse/Integration**: Build in this repo. Auth module already supports OTP.  
**Dependencies**: B-02 (SMS confirmation), B-03 (e-ticket).  
**Priority**: High

---

### B-05: Saved Trips and Booking History
**Title**: Passenger booking history with repeat booking shortcut  
**Description**: Provide authenticated customers with a booking history view showing past and upcoming trips. Add a "Book same route again" shortcut that pre-fills the search form with the last trip's origin, destination, and preferred departure time.  
**Why it matters**: Repeat customers (regular commuters, business travelers) are the highest-value segment. Reducing re-booking friction increases retention and lifetime value. "Book same route" is a one-tap conversion for returning users.  
**Implementation**: `GET /api/booking/bookings?customer_id={id}&status=confirmed` already exists. Build the frontend history view. Add `repeat_booking_shortcut` endpoint that returns last booking's route params.  
**Reuse/Integration**: Build in this repo (primarily frontend).  
**Dependencies**: B-04 (guest vs. authenticated session).  
**Priority**: High

---

### B-06: Flexible Cancellation Policy with Partial Refund
**Title**: Configurable cancellation policy with automated refund initiation  
**Description**: Allow operators to configure cancellation windows (e.g. free cancellation >24 hours before departure, 50% refund 12–24 hours, no refund <12 hours). When a customer cancels, calculate the refund amount per policy and initiate a Paystack/Flutterwave refund API call.  
**Why it matters**: Currently cancellations release seats but issue no refund. This is a trust-breaker for online payments. Passengers hesitate to pay online if they believe they cannot get a refund. A clear, automated refund policy is a booking conversion driver.  
**Implementation**: Add `cancellation_policy` JSON to operator config. On `PATCH /api/booking/bookings/:id/cancel`, compute refund_amount based on departure time delta and policy. Call Paystack Refund API.  
**Reuse/Integration**: Build in this repo. Policy config via S-05.  
**Dependencies**: S-02 (operator config), B-01 (payment provider already known on booking record).  
**Priority**: High

---

### B-07: Multi-Language Booking Portal (Vernacular UX)
**Title**: Full Yoruba, Igbo, and Hausa localization of the booking portal  
**Description**: Complete the i18n implementation for all customer-facing strings in the booking portal (search form, seat selection, payment flow, confirmation screen, e-ticket). Currently `src/core/i18n/index.ts` supports 4 languages but many strings are English-only.  
**Why it matters**: A significant share of intercity bus passengers in Nigeria are more comfortable in their mother tongue than in English. Yoruba (Southwest), Igbo (Southeast), and Hausa (North) together cover the majority of the target passenger base.  
**Implementation**: Audit all i18n string keys in the booking flow. Add Yoruba, Igbo, and Hausa translations for all missing strings. Auto-detect from browser `navigator.language`.  
**Reuse/Integration**: Build in this repo. i18n module already in place.  
**Dependencies**: None.  
**Priority**: High

---

### B-08: Price Transparency and Fare Breakdown
**Title**: Itemized fare breakdown on booking confirmation  
**Description**: Show passengers a full fare breakdown before payment: base fare × seats, seat class premium (if any), booking fee (if any), and total. This screen must be shown and acknowledged before payment is initiated.  
**Why it matters**: Nigerian passengers are highly price-sensitive and distrust opaque pricing. Hidden fees are a common complaint. Full transparency reduces checkout abandonment and payment disputes.  
**Implementation**: Compute fare breakdown on `POST /api/booking/bookings` and return it in the response. Frontend shows the breakdown screen before redirecting to payment.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: S-04 (seat class pricing).  
**Priority**: High

---

### B-09: Booking Reminder Push Notifications
**Title**: Push notification reminders 24 hours and 2 hours before departure  
**Description**: When a booking is confirmed, schedule two push notifications: one 24 hours before departure ("Your trip tomorrow: Lagos → Abuja, seat 14, 6:00 AM") and one 2 hours before ("Get ready! Your bus departs in 2 hours from Ojota Park"). Wire through Web Push (VAPID) and SMS fallback.  
**Why it matters**: Passengers miss departures because they forgot their booking time. A reminder reduces no-shows and improves the operator's departure punctuality.  
**Implementation**: On booking confirmation, store `remind_at_1` and `remind_at_2` timestamps. Cron sweeper checks for due reminders and delivers via VAPID (already configured) and SMS fallback.  
**Reuse/Integration**: VAPID keys already in `Env`. SMS lib already in this repo. Reminder scheduling could be a shared platform service long-term.  
**Dependencies**: B-02 (SMS), VAPID push.  
**Priority**: High

---

### B-10: Operator Reviews and Rating System
**Title**: Post-trip passenger rating and review submission  
**Description**: After a trip is marked `completed`, send passengers an SMS/push prompt to rate their experience (1–5 stars, optional text review). Aggregate ratings per operator and expose them on the trip search results.  
**Why it matters**: Passengers have no quality signal when choosing between operators on the same route. Ratings give them a trust signal and give operators an incentive to improve service.  
**Implementation**: New `operator_reviews` table. `POST /api/booking/reviews` (CUSTOMER only, after completed trip). Aggregate `avg_rating` on `GET /api/booking/trips/search`.  
**Reuse/Integration**: Build in this repo. Reviews data can be shared to a platform-wide reputation service.  
**Dependencies**: B-09 (post-trip trigger).  
**Priority**: Medium

---

### B-11: Trip Status Tracking for Passengers
**Title**: Real-time trip status display for booked passengers  
**Description**: Expose trip state (`scheduled`, `boarding`, `in_transit`, `completed`) and estimated departure/arrival times on the passenger's booking detail screen. When the trip transitions to `boarding`, send a push/SMS notification.  
**Why it matters**: "Where is my bus?" is the single most common passenger support query. A status screen eliminates most of these support contacts and reduces passenger anxiety.  
**Implementation**: `GET /api/booking/bookings/:id` already joins trip data. Add `trip.state` and `trip.current_latitude/longitude` to the response. Push notification on `boarding` state triggered by the trip state machine.  
**Reuse/Integration**: Build in this repo. GPS update endpoint needed in TRN-4 (D-04).  
**Dependencies**: D-04 (GPS update), B-09 (push notifications).  
**Priority**: Medium

---

### B-12: Passenger Name Edit Before Departure
**Title**: Allow passengers to edit passenger names on a booking before departure  
**Description**: Allow customers to update the `passenger_names` field on a confirmed booking, subject to a cutoff (e.g. >2 hours before departure). This handles name corrections and name transfers without a full cancellation and rebook.  
**Why it matters**: Name corrections are a routine support request (misspelled name, family member name swap). Without a self-service edit, every correction requires agent intervention, generating support cost.  
**Implementation**: `PATCH /api/booking/bookings/:id` already accepts updates. Add `passenger_names` as an allowed field with a departure-time cutoff check.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Medium

---

### B-13: Corporate Travel / Bulk Booking Portal
**Title**: Corporate account portal for bulk seat procurement  
**Description**: Create a corporate customer type with a credit account. Corporate accounts can book multiple seats across multiple trips with a single invoice, paying via bank transfer with a 7-day payment term.  
**Why it matters**: Corporate travel (oil company workers, government agencies, NGOs) accounts for a disproportionate share of intercity travel revenue. These customers require invoicing, not card payment. A corporate portal captures this high-value segment.  
**Implementation**: Add `customer_type: 'corporate' | 'individual'` and `credit_limit_kobo` to customers. Build a corporate portal view with bulk booking form and invoice generation.  
**Reuse/Integration**: Build in this repo. Invoice generation can use browser print (no server PDF required).  
**Dependencies**: B-08 (fare breakdown).  
**Priority**: Medium

---

### B-14: AI-Powered Trip Recommendation
**Title**: Personalized trip recommendations based on booking history  
**Description**: Extend the AI search endpoint to also return personalized recommendations ("Based on your past trips: Lagos → Abuja, next available departure tomorrow at 6 AM, ₦5,200") for authenticated returning customers.  
**Why it matters**: Returning customers who see a personalized recommendation convert at much higher rates than those who see a generic search prompt. Personalization is a retention and conversion tool.  
**Implementation**: Fetch the customer's last 5 bookings. Pass route history and current time to OpenRouter. Return structured trip recommendations. Rate-limited and non-fatal.  
**Reuse/Integration**: OpenRouter abstraction already in `src/lib/ai.ts`. Vendor-neutral.  
**Dependencies**: B-05 (booking history).  
**Priority**: Medium

---

### B-15: WhatsApp Booking Channel
**Title**: Book a seat via WhatsApp chatbot flow  
**Description**: Expose a WhatsApp Business API chatbot flow (via Twilio or Termii WhatsApp gateway) that guides passengers through: origin/destination search → trip selection → seat selection → payment link → confirmation. Runs entirely within WhatsApp.  
**Why it matters**: WhatsApp penetration in Nigeria is near 100% among smartphone users. A large share of passengers who will not install an app or visit a web portal will readily interact via WhatsApp. This channel dramatically expands addressable reach.  
**Implementation**: Build a webhook handler for WhatsApp Business API. Manage session state in `SESSIONS_KV`. Translate WhatsApp messages to API calls on the existing booking portal endpoints.  
**Reuse/Integration**: WhatsApp gateway is a new dependency. All booking logic is already built in this repo. Session state can reuse `SESSIONS_KV`.  
**Dependencies**: WhatsApp Business API account (Twilio/Termii).  
**Priority**: Medium

---

### B-16: USSD Booking Channel
**Title**: USSD-based ticket booking for feature phone users  
**Description**: Integrate with a Nigerian USSD gateway (Africa's Talking, Infobip) to offer a `*384*WEBWAKA#` USSD menu for booking tickets. Flow: select route → select date → available trips → confirm → payment via mobile money → SMS confirmation.  
**Why it matters**: A significant portion of Nigerian intercity travelers use feature phones or have limited data. USSD works on any phone, on any network, without internet. It reaches the truly offline passenger.  
**Implementation**: USSD gateway webhook accepts menu selections and session state. Each menu step maps to an API call. Payment via mobile money (Paystack USSD payment flow).  
**Reuse/Integration**: New dependency (USSD gateway). All booking logic already in this repo.  
**Dependencies**: USSD gateway, mobile money payment.  
**Priority**: Low

---

### B-17: Booking Insurance Upsell
**Title**: Optional travel insurance add-on at checkout  
**Description**: Partner with a Nigerian insurtech (HeiDi, Curacel) to offer optional trip insurance at checkout (₦200–₦500 per booking, covering delays, accidents, luggage loss). The insurance is embedded as a checkbox during the booking flow.  
**Why it matters**: Insurance penetration in Nigerian transport is near zero. Passengers who pay online are more likely to be interested in protection products. This is a direct revenue share opportunity for WebWaka.  
**Implementation**: Add `insurance_selected` and `insurance_premium_kobo` to bookings. Integrate with insurer's API to issue a policy on confirmed bookings. Include policy number in SMS/e-ticket.  
**Reuse/Integration**: New dependency (insurtech API). Build integration wrapper in this repo.  
**Dependencies**: B-01 (payment), B-02 (confirmation SMS).  
**Priority**: Low

---

### B-18: Dynamic Pricing Engine
**Title**: Demand-based dynamic pricing with passenger-facing fare calendar  
**Description**: Implement surge pricing based on route demand (remaining seat count + days to departure). Show passengers a fare calendar on the search results so they can choose a cheaper departure date/time.  
**Why it matters**: Nigerian operators lose significant revenue by charging flat fares during peak periods (Christmas, Eid) when passengers would pay 2–3× the base fare. Dynamic pricing captures this surplus.  
**Implementation**: Pricing formula: `base_fare × (1 + surge_factor)` where `surge_factor` is derived from `fill_rate` and `days_to_departure`. Add `effective_fare` to trip search results. Operator-configurable surge cap.  
**Reuse/Integration**: Build in this repo. Pricing engine is transport-specific.  
**Dependencies**: S-05 (operator config for pricing parameters).  
**Priority**: Medium

---

### B-19: Accessibility Mode for Visually Impaired Users
**Title**: Screen reader-friendly booking portal with voice guidance  
**Description**: Ensure the booking portal passes WCAG 2.1 AA accessibility standards. Add ARIA labels, semantic HTML, keyboard navigation, and an optional voice-guidance mode using the Web Speech API.  
**Why it matters**: Accessibility is a legal and ethical obligation. A voice-guided booking flow also serves passengers in low-literacy contexts who may struggle with a standard UI.  
**Implementation**: ARIA audit on all booking flow components. Add `aria-live` regions for dynamic content (seat availability, booking status). Web Speech API voice prompts as an optional overlay.  
**Reuse/Integration**: Build in this repo (frontend only).  
**Dependencies**: None.  
**Priority**: Low

---

### B-20: Passenger Profile and Travel Preferences
**Title**: Passenger preference profile (seat preference, payment method, dietary/mobility needs)  
**Description**: Allow authenticated passengers to save preferences: preferred seat position (window/aisle/front), default payment method, dietary requirements (for operators offering meals), and accessibility needs. Pre-fill these in the booking flow automatically.  
**Why it matters**: Repeat customers who have their preferences remembered convert faster and with less friction. Accessibility needs (wheelchair, extra legroom) also need to be communicated to operators before boarding.  
**Implementation**: Add `preferences` JSON column to `customers`. `PATCH /api/booking/customers/:id` to save preferences. Apply preferences to seat selection pre-selection and payment method default.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: B-04 (authenticated session).  
**Priority**: Low

---

## 6. Top 20: Dispatch / Trip Operations Enhancements

---

### D-01: Driver Mobile App (Dedicated Driver View)
**Title**: Driver-optimized mobile view with trip details, manifest, and SOS  
**Description**: The `DriverView` component (`src/components/driver-view.tsx`) already exists. Extend it into a full driver-facing module: trip details, passenger manifest, boarding scan, departure checklist, location sharing, and SOS trigger.  
**Why it matters**: Drivers are a primary operational persona with no dedicated tooling. They currently receive manifests on paper. A digital driver view connects them to the platform and enables real-time operations visibility.  
**Implementation**: Extend `DriverView`. Add `GET /api/operator/trips?driver_id=me` (already implemented). Add boarding scan (D-03), GPS sharing (D-04), and SOS trigger (D-08).  
**Reuse/Integration**: Build in this repo (frontend). DRIVER role is already in RBAC.  
**Dependencies**: D-03, D-04, D-08.  
**Priority**: Critical

---

### D-02: Trip Manifest Generation and Export
**Title**: Digital trip manifest with export to PDF and NFC/QR verification  
**Description**: `GET /api/operator/trips/:id/manifest` already exists and returns the manifest. Extend it with a printable PDF layout (via browser print API), a CSV export, and a per-row QR code linking to the passenger's e-ticket for roadside verification by law enforcement.  
**Why it matters**: Nigerian FRSC and police checkpoints require bus manifests. Digital manifests with QR codes allow officers to quickly verify passengers on their own devices, reducing checkpoint delays.  
**Implementation**: Frontend manifest view with `@media print` layout. Each row includes passenger name, seat, ID number (if captured), and a QR link. CSV export via Blob download.  
**Reuse/Integration**: Build in this repo. Boarding scan (D-03) uses the same manifest data.  
**Dependencies**: A-05 (passenger ID capture for full manifest).  
**Priority**: Critical

---

### D-03: Digital Boarding Scan at Bus Gate
**Title**: QR boarding scan at departure gate to verify tickets and mark passengers as boarded  
**Description**: A supervisor or driver scans each passenger's e-ticket QR at the boarding gate. Each scan calls `POST /api/operator/trips/:id/board` with the `booking_id:seat_id` payload, marks `bookings.boarded_at = now()` and `boarded_by = scanner_id`.  
**Why it matters**: Currently there is no digital boarding gate. The `boarded_at` and `boarded_by` columns in the `bookings` table exist but are never populated. Without boarding scan, ghost passengers (fake manifests) and duplicate ticket fraud are undetectable.  
**Implementation**: `POST /api/operator/trips/:id/board` endpoint (STAFF+ role). Frontend QR scanner using browser camera API. Returns passenger details on valid scan, error on invalid/already-scanned ticket.  
**Reuse/Integration**: Build in this repo. QR scan library is shared with A-11.  
**Dependencies**: B-03 (e-ticket with QR), D-01 (driver view), D-02 (manifest).  
**Priority**: Critical

---

### D-04: Real-Time GPS Location Sharing
**Title**: Driver GPS location shared in real time via trip update endpoint  
**Description**: Add `POST /api/operator/trips/:id/location` accepting `{ latitude, longitude }` from the driver's device. Store in `trips.current_latitude` and `trips.current_longitude` (columns already exist). Push updated location to the passenger's trip status screen via SSE.  
**Why it matters**: Passengers and operators alike have zero visibility into where a bus is in transit. Real-time GPS closes the most frequent "where is my bus?" support query. It also enables dispatcher oversight of fleet in motion.  
**Implementation**: `PATCH /api/operator/trips/:id` (already exists) or a dedicated `POST .../location` endpoint. Driver sends location every 30 seconds from the driver view. SSE pushes to passenger booking status screen.  
**Reuse/Integration**: Build in this repo. GPS coordinates already in schema.  
**Dependencies**: D-01 (driver view for sender), B-11 (passenger view for receiver).  
**Priority**: High

---

### D-05: Departure Checklist and Pre-Trip Inspection
**Title**: Digital pre-departure vehicle inspection checklist  
**Description**: A structured checklist (tires, brakes, lights, fuel, manifest count, emergency equipment) that the driver completes before each trip. Checklist results are stored against the trip record. Trips cannot transition to `boarding` until the checklist is complete.  
**Why it matters**: Vehicle inspection is a regulatory requirement (VIO) and a safety imperative. Without a digital record, operators have no proof of pre-trip inspection and no ability to audit driver compliance.  
**Implementation**: New `trip_inspections` table. `POST /api/operator/trips/:id/inspection`. Add inspection status as a prerequisite gate on `boarding` state transition.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: D-01 (driver view).  
**Priority**: High

---

### D-06: Delay and Exception Reporting
**Title**: Structured delay reporting with reason codes and passenger notification  
**Description**: Allow dispatchers or drivers to report trip delays with a reason code (traffic, breakdown, weather, accident, fuel shortage) and estimated recovery time. Automatically notify all confirmed passengers via SMS/push.  
**Why it matters**: Passengers who arrive at a bus park and find their bus delayed with no information are the most vocal complainers and worst-case safety risks. A structured delay notification system manages expectations and reduces park congestion from waiting passengers.  
**Implementation**: `POST /api/operator/trips/:id/delay` (SUPERVISOR+). Stores delay reason, reported_at, estimated_departure. Triggers SMS/push to all booking holders on that trip.  
**Reuse/Integration**: Build in this repo. Notification delivery via shared service.  
**Dependencies**: B-09 (push), B-02 (SMS), D-01 (driver can also file delays).  
**Priority**: High

---

### D-07: Fleet Dispatcher Dashboard
**Title**: Real-time dispatcher dashboard showing all active trips across all parks  
**Description**: A SUPERVISOR/TENANT_ADMIN-facing dispatch board showing: all trips (by state), bus locations (via GPS), departure status (on-time / delayed), boarding status, and agent activity by park. Refreshes via SSE or polling.  
**Why it matters**: Operators running 20+ simultaneous trips have no real-time visibility. Dispatchers currently coordinate by phone. A digital dispatch board replaces phone calls with a live data view.  
**Implementation**: `GET /api/operator/trips?state=boarding,in_transit` with GPS and manifest summary. Frontend dispatch board with real-time polling (30s interval).  
**Reuse/Integration**: Build in this repo (frontend + existing API).  
**Dependencies**: D-04 (GPS), D-06 (delay reports).  
**Priority**: High

---

### D-08: SOS Emergency Trigger and Escalation
**Title**: Driver SOS trigger with automated emergency contact and fleet alert  
**Description**: The `trips` table already has `sos_active`, `sos_triggered_at`, `sos_cleared_at`, `sos_cleared_by` columns. Implement: `POST /api/operator/trips/:id/sos` (DRIVER role) to activate SOS, `POST /api/operator/trips/:id/sos/clear` (SUPERVISOR+) to clear. On SOS: immediately send SMS to dispatcher + TENANT_ADMIN, publish `trip:SOS_ACTIVATED` event, add red alert to dispatch board.  
**Why it matters**: Driver safety on Nigerian highways is a genuine risk (armed robbery, accidents, medical emergencies). An in-app SOS that alerts the operator and logs the incident is a meaningful safety feature that operators will use as a marketing differentiator.  
**Implementation**: Wire the existing schema columns to actual endpoints. SOS SMS goes to an emergency contact configured per operator.  
**Reuse/Integration**: Build in this repo. Emergency contact stored in operator config (S-05).  
**Dependencies**: D-01 (driver view SOS button), SMS notification.  
**Priority**: High

---

### D-09: Automated Departure Control (ADC)
**Title**: Automated departure trigger when manifest reaches 100% boarding  
**Description**: When the last passenger scans their QR at the gate (D-03), automatically transition the trip state from `boarding` to `in_transit` (or prompt the dispatcher to confirm departure). Configurable: auto-transition or require manual confirmation.  
**Why it matters**: Manual departure control requires dispatcher attention for every trip. At parks running 50+ trips per day, this is a bottleneck. Automated departure based on manifest completion frees dispatchers for exception handling only.  
**Implementation**: After each boarding scan (D-03), check if all confirmed passengers are boarded. If yes, optionally trigger state transition. Configurable per operator via S-05.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: D-03 (boarding scan), D-05 (pre-trip inspection complete).  
**Priority**: Medium

---

### D-10: Route Deviation Alert
**Title**: Automated alert when a bus deviates from the expected route corridor  
**Description**: Define the expected route corridor (bounding box or polyline from origin to destination) per route. When the GPS position (D-04) deviates beyond a threshold distance from the corridor, send an alert to the dispatcher.  
**Why it matters**: Route deviation by drivers (taking unauthorized detours, avoiding tolls via dangerous routes, or driver abduction scenarios) is a genuine operational and safety concern. Automated alerts close the loop without requiring constant human monitoring.  
**Implementation**: Store route corridor as a GeoJSON polyline in `routes.route_geometry`. On each GPS update (D-04), compute distance from nearest corridor point. Alert if > configurable threshold (e.g. 5km).  
**Reuse/Integration**: Build in this repo. GeoJSON route data can be sourced from OpenStreetMap.  
**Dependencies**: D-04 (GPS updates).  
**Priority**: Medium

---

### D-11: Driver Behavior Scoring
**Title**: Driver performance scoring based on trip outcomes  
**Description**: Automatically score drivers on: on-time departure rate, on-time arrival rate, SOS trigger frequency, passenger rating (B-10), and complaint ticket rate (A-20). Expose a driver performance report to TENANT_ADMIN.  
**Why it matters**: Operators need to evaluate driver performance objectively. Currently evaluation is subjective or based on passenger complaints only. A composite score enables performance-based bonuses, disciplinary action, and route assignment decisions.  
**Implementation**: `GET /api/operator/drivers/:id/performance`. Aggregate metrics from existing tables. Publish monthly performance events.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: D-08 (SOS), B-10 (ratings), D-06 (delays).  
**Priority**: Medium

---

### D-12: Trip Recovery Workflow (Breakdown / Substitute Vehicle)
**Title**: Structured trip recovery when a vehicle breaks down mid-route  
**Description**: When a trip is halted mid-journey (vehicle breakdown, accident), enable a recovery workflow: mark trip as `disrupted`, assign a substitute vehicle, create a continuation trip record for passengers, and notify all passengers of the updated arrangement.  
**Why it matters**: Vehicle breakdowns are a routine operational reality in Nigeria. Without a digital recovery workflow, passengers are stranded with no information and operators have no record of the incident.  
**Implementation**: Add `disrupted` state to the trip state machine. `POST /api/operator/trips/:id/recover` creates a continuation trip, transfers confirmed passengers, publishes `trip:DISRUPTED` event.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: B-09 (passenger notifications), D-06 (delay reporting).  
**Priority**: Medium

---

### D-13: Estimated Arrival Time Calculation
**Title**: Dynamic ETA calculation using departure time + route duration  
**Description**: Compute and expose `estimated_arrival_time` for each trip based on `departure_time + routes.duration_minutes`. Update the estimate dynamically based on delay reports (D-06) and GPS progress (D-04).  
**Why it matters**: Passengers booking trips need to know arrival times. Route duration is stored in `routes.duration_minutes` but is not surfaced on trip search results or passenger-facing screens.  
**Implementation**: Add `estimated_arrival_time` computation to `GET /api/booking/trips/search`. Update dynamically on delay reports.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: D-06 (delay adjustment).  
**Priority**: Medium

---

### D-14: Digital Waybill for Parcels on Passenger Buses
**Title**: Digital parcel waybill recording for buses that carry parcels  
**Description**: Allow agents and dispatchers to record parcels loaded onto a bus at departure: sender, recipient, description, weight, declared value, fees collected. Generate a digital waybill. This is transport's interface into the logistics module — waybill data is forwarded via event.  
**Why it matters**: Most Nigerian intercity buses carry parcels as a secondary revenue stream. Currently this is managed with paper waybills that are often lost or unreadable. A digital waybill creates a paper trail and enables the logistics module to track parcel status.  
**Implementation**: Build `POST /api/operator/trips/:id/waybills` in this repo for parcel recording. Publish `parcel.waybill_created` event to the platform event bus (forwarded to logistics repo). Do NOT rebuild logistics in this repo.  
**Reuse/Integration**: Thin integration layer in this repo. Core parcel logic lives in the logistics repo.  
**Dependencies**: D-02 (manifest), event bus (already wired).  
**Priority**: Medium

---

### D-15: Trip Performance Benchmarking
**Title**: Operational KPI report (on-time rate, fill rate, revenue per km)  
**Description**: Compute and expose a structured operational KPI report for TENANT_ADMIN and SUPERVISOR: on-time departure rate, on-time arrival rate, average fill rate per route, revenue per km, vehicle utilization rate.  
**Why it matters**: Operators currently have no objective benchmarks. Without data, they cannot identify underperforming routes, underutilized vehicles, or poorly performing drivers.  
**Implementation**: `GET /api/operator/reports/operations` aggregating from `trips`, `trip_state_transitions`, `seats`, `bookings`. Filterable by date range, route, vehicle.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: D-13 (ETA for on-time calculation), D-04 (GPS for arrival tracking).  
**Priority**: Low

---

### D-16: Automated Schedule Generation
**Title**: Recurring schedule engine for daily/weekly trips  
**Description**: Allow operators to define a recurring schedule (e.g. "Lagos → Abuja, every day at 6 AM, 9 AM, and 12 PM, Bus ABC1234") and have the system auto-generate trip records for the next 30 days. Operators can modify individual occurrences.  
**Why it matters**: Currently operators manually create or clone each trip. For operators running 10+ daily trips on 20+ routes, this is a major administrative burden. Automated schedule generation eliminates that burden.  
**Implementation**: New `schedules` table with recurrence rule (cron-like). Cron sweeper creates trip records 7 days ahead, skipping existing records.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: High

---

### D-17: Passenger Head Count Reconciliation
**Title**: Digital head count vs. manifest reconciliation at departure gate  
**Description**: At departure, the driver or supervisor performs a final head count and submits it via `POST /api/operator/trips/:id/headcount`. The system flags any discrepancy between head count and the number of boarded passengers in the manifest.  
**Why it matters**: Overloading is a major road safety risk in Nigeria. Digital head count enforcement prevents operators from loading more passengers than the vehicle is licensed to carry.  
**Implementation**: Simple count endpoint. Compare against `seats.confirmed` count. Alert if head count exceeds vehicle `total_seats`.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: D-03 (boarding scan for comparison).  
**Priority**: Low

---

### D-18: Customs and Border Declaration Manifest
**Title**: Cross-border trip declaration manifest for customs compliance  
**Description**: For international routes (Lagos→Cotonou, Abuja→Niamey), generate a customs-compliant passenger declaration manifest in the format required by ECOWAS border agencies, including passenger nationality, travel document type, and declaration of goods.  
**Why it matters**: International route operators face significant delays at ECOWAS borders when their passenger manifest is not in the required format. A compliant digital manifest accelerates border clearance.  
**Implementation**: Add `is_international`, `border_crossing` flags to routes. Add `nationality`, `travel_doc_type`, `travel_doc_number` to `passenger_names` schema. Generate border manifest template.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: A-05 (ID capture), D-02 (manifest generation).  
**Priority**: Low

---

### D-19: Trip Cost Recording (Driver Expenses)
**Title**: Driver expense recording during a trip (fuel, tolls, maintenance)  
**Description**: Allow drivers to record in-trip expenses (fuel stops, toll payments, emergency repairs) with amounts, receipts (photo), and categories. Aggregate against trip revenue for profitability reporting.  
**Why it matters**: Operators cannot compute accurate per-trip profitability without recording trip costs. Driver expense recording closes the cost side of the per-trip P&L.  
**Implementation**: New `trip_expenses` table. `POST /api/operator/trips/:id/expenses` (DRIVER role). Photo upload stored in Cloudflare R2.  
**Reuse/Integration**: Cloudflare R2 is a new dependency for image storage.  
**Dependencies**: D-01 (driver view), R2 binding.  
**Priority**: Low

---

### D-20: NIMET Weather Integration for Route Risk Assessment
**Title**: Automated weather-based route risk alerts using NIMET data  
**Description**: Integrate with the NIMET (Nigerian Meteorological Agency) API to retrieve weather forecasts for major route corridors. Flag trips departing into severe weather conditions (flooding, harmattan, heavy rain) with an alert to the dispatcher.  
**Why it matters**: Weather conditions cause road accidents, route closures, and trip cancellations on Nigerian highways. Proactive weather alerts give dispatchers advance warning to delay, reroute, or cancel trips safely.  
**Implementation**: Cron sweeper queries NIMET API daily. Compare trip departure coordinates against forecast zones. Publish `route:WEATHER_ALERT` events for flagged trips.  
**Reuse/Integration**: Build in this repo. NIMET API as external dependency.  
**Dependencies**: D-07 (dispatcher dashboard for alert display).  
**Priority**: Low

---

## 7. Top 20: Operator / Fleet / Route Management Enhancements

---

### O-01: Multi-Terminal / Multi-Park Operator Management
**Title**: Terminal and park entity management with per-terminal assignment  
**Description**: Add a `terminals` entity (physical bus park locations) that operators can manage. Assign routes, agents, vehicles, and trips to specific terminals. Enable per-terminal reporting and seat inventory management.  
**Why it matters**: Large operators (GUO, Peace Mass Transit) operate from multiple parks simultaneously. Without terminal management, all their data is a flat list with no geographic context.  
**Implementation**: New `terminals` table. Foreign key references from `routes`, `agents`, `vehicles`. Add `terminal_id` to trip search and operator dashboard.  
**Reuse/Integration**: Build in this repo. Park management (A-07) references terminals.  
**Dependencies**: A-07 (bus park management).  
**Priority**: High

---

### O-02: Vehicle Maintenance Schedule and Compliance Tracking
**Title**: Digital vehicle maintenance log with service schedule and compliance status  
**Description**: Track vehicle service history (oil change, tire replacement, brake service), service due dates, and compliance documents (roadworthiness certificate, insurance, VIO inspection). Alert operators when a vehicle is due for service or compliance documents are expiring.  
**Why it matters**: Vehicle mechanical failure is a leading cause of accidents on Nigerian highways. Operators who maintain digital service logs can enforce maintenance schedules, reduce breakdowns, and demonstrate compliance to regulators.  
**Implementation**: New `vehicle_maintenance_records` and `vehicle_documents` tables. Add `next_service_due` to vehicles. Cron alert when due within 7 days. Block trip assignment for vehicles with expired compliance docs.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: D-05 (pre-trip inspection links to maintenance history).  
**Priority**: High

---

### O-03: Vehicle Seat Configuration Templates
**Title**: Configurable seat layout templates per vehicle type  
**Description**: Define seat layout templates (rows, columns, aisle position, seat classes) per vehicle type or per specific vehicle. When a trip is created, generate seats from the template automatically, preserving seat numbering and class.  
**Why it matters**: Currently all seats are generated as sequential numbers with no layout. This prevents accurate visual seat maps, seat class pricing, and window/aisle preferences. A template system is the foundation for all seat-class features.  
**Implementation**: Add `seat_template` JSON to vehicles (or vehicle types). Trip creation applies template to generate structured seat rows.  
**Reuse/Integration**: Build in this repo. Required by S-04, S-11.  
**Dependencies**: None.  
**Priority**: High

---

### O-04: Driver License and Compliance Document Management
**Title**: Digital driver document vault with expiry alerts  
**Description**: Store and manage driver compliance documents: driver's license (category, number, expiry), FRSC certification, medical certificate, vehicle type endorsement. Alert when documents are within 30 days of expiry. Block driver assignment on expired documents.  
**Why it matters**: FRSC enforcement on Nigerian roads targets operators with unlicensed or unqualified drivers. Document expiry tracking protects operators from fines and liability.  
**Implementation**: New `driver_documents` table. Add `license_expiry` to drivers. Cron alert sweeper for expiring documents. Gate on `PATCH /api/operator/trips/:id` driver assignment.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: High

---

### O-05: Revenue and Profitability Report per Route
**Title**: Per-route revenue and profitability analytics  
**Description**: `GET /api/operator/reports` already exists. Extend it with: revenue per route per period, cost per route (if D-19 is implemented), average fill rate, number of trips, average fare, refund rate, and margin estimate.  
**Why it matters**: Operators make route decisions (add frequency, abandon route, adjust price) based on intuition. Revenue-per-route analytics replace intuition with data.  
**Implementation**: Extend the existing reports endpoint. Add `route_id` grouping to revenue aggregation. Join with trip and booking data.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: D-19 (cost data for profitability), S-04 (fare data by class).  
**Priority**: High

---

### O-06: Route Planning with Waypoint Support
**Title**: Multi-stop route definition with intermediate waypoints and boarding/alighting points  
**Description**: Extend the `routes` table to support multiple stops (waypoints) between origin and destination. Passengers can board at intermediate points. Fares are calculated based on distance from boarding point to alighting point.  
**Why it matters**: Many popular routes in Nigeria have established intermediate stops (Lagos → Ibadan → Ogbomosho → Ilorin → Abuja). Passengers board and alight at any stop. Without waypoint support, these routes must be modeled as multiple independent point-to-point routes, losing context and revenue optimization.  
**Implementation**: New `route_stops` table: `route_id`, `stop_name`, `sequence`, `distance_from_origin_km`, `fare_from_origin_kobo`. Booking references origin_stop and destination_stop from the route_stops list.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: None.  
**Priority**: Medium

---

### O-07: Fleet Utilization Dashboard
**Title**: Fleet utilization rate dashboard with idle vehicle identification  
**Description**: Show operators which vehicles are assigned to trips, which are idle, which are in maintenance, and the utilization rate (hours in service / total available hours) per vehicle per week.  
**Why it matters**: Operators with 50+ vehicles typically have 15–25% sitting idle at any time due to poor scheduling. Utilization data drives fleet right-sizing decisions and revenue per asset.  
**Implementation**: `GET /api/operator/vehicles/utilization` — compute hours assigned to completed/in-transit trips per vehicle per period. Identify vehicles with <X% utilization.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: O-02 (maintenance status for exclusion from utilization).  
**Priority**: Medium

---

### O-08: Dynamic Fare Matrix per Route Segment and Time
**Title**: Fare matrix with time-of-day, day-of-week, and seat class dimensions  
**Description**: Replace the single `base_fare` per route with a fare matrix: `base_fare × time_multiplier × class_multiplier`. Operators configure multipliers for peak hours, peak days, and seat classes.  
**Why it matters**: A ₦5,000 seat on a Friday 5 PM Lagos → Abuja bus is worth more than the same seat on a Tuesday 6 AM bus. Time-aware pricing captures this revenue differential.  
**Implementation**: Add `fare_matrix` JSON to routes or operator config. Compute `effective_fare` in the trip search query using the matrix.  
**Reuse/Integration**: Build in this repo. Required by B-18 (dynamic pricing).  
**Dependencies**: S-04 (seat class), S-05 (operator config).  
**Priority**: Medium

---

### O-09: Operator Onboarding Wizard
**Title**: Step-by-step operator onboarding wizard for new tenants  
**Description**: A guided multi-step wizard for new operator accounts: company profile → add vehicles → add routes → set fares → add drivers → add agents → create first trip. Each step validates inputs and provides field-level guidance.  
**Why it matters**: New operators currently face a blank system with no guidance. The time-to-first-trip metric is a critical adoption driver. An onboarding wizard reduces it from days to hours.  
**Implementation**: Frontend wizard with step-by-step forms for each entity (operator, route, vehicle, driver, agent, trip). Calls existing APIs at each step. Progress saved across sessions.  
**Reuse/Integration**: Build in this repo (frontend only, all APIs already exist).  
**Dependencies**: None.  
**Priority**: Medium

---

### O-10: Operator Financial Summary and Tax Reporting
**Title**: Monthly operator financial summary with VAT and WHT computation  
**Description**: Generate a monthly financial summary per operator including: gross revenue, refunds, net revenue, VAT collected (7.5% on transport services), and withholding tax (WHT) on agent commissions. Export as a PDF suitable for FIRS submission.  
**Why it matters**: Nigerian operators are obligated to file VAT returns monthly. A pre-computed financial summary that maps to FIRS form requirements reduces the accountant's burden significantly.  
**Implementation**: `GET /api/operator/reports/tax?month=2026-03`. Aggregate from bookings and sales transactions. Compute VAT and WHT per FIRS rates. Generate PDF via browser print.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: O-05 (revenue report), A-15 (commission data for WHT).  
**Priority**: Medium

---

### O-11: Multi-Operator Partnership Management (Code-Sharing)
**Title**: Inter-operator partnership management for code-sharing and seat exchange  
**Description**: Allow SUPER_ADMIN to create partnership agreements between operators, specifying which routes are shared, commission split, and seat exchange quota. Expose partner operators' available trips on each other's POS and portal.  
**Why it matters**: Operators regularly experience route overlap (Lagos→Abuja is served by 10+ operators). Code-sharing allows smaller operators to sell seats on each other's trips, increasing revenue without adding capacity.  
**Implementation**: New `operator_partnerships` table. Partnership-aware seat availability query. Commission split tracked in booking record.  
**Reuse/Integration**: Build in this repo. SUPER_ADMIN tooling.  
**Dependencies**: S-14 (seat exchange protocol).  
**Priority**: Low

---

### O-12: Operator API Key for Third-Party Integration
**Title**: Operator-scoped API keys for third-party system integration  
**Description**: Allow operators to generate named API keys (scoped to their tenant) for integrating their own systems (legacy booking systems, accounting software, HR systems) with the WebWaka API.  
**Why it matters**: Mid-sized operators often have existing systems (spreadsheets, accounting software) that they want to connect to WebWaka. Without API keys, every integration requires a user account. API keys are the standard B2B integration mechanism.  
**Implementation**: New `api_keys` table. `POST /api/operator/api-keys` (TENANT_ADMIN only). Keys are SHA-256 hashed before storage. Include `scope` field (read-only vs. read-write). Auth middleware accepts API key in `Authorization: ApiKey {key}` header as an alternative to JWT.  
**Reuse/Integration**: Build in this repo. `@webwaka/core` auth middleware needs to support API key validation.  
**Dependencies**: None.  
**Priority**: Low

---

### O-13: Automated Operator Suspension and Compliance Gating
**Title**: Automated operator account gating based on compliance status  
**Description**: Define a compliance checklist per operator (FIRS TIN registered, CAC registration, FRSC fleet approval, NDPR registration). SUPER_ADMIN manages compliance status. Non-compliant operators are automatically suspended (read-only mode, no new trips).  
**Why it matters**: WebWaka could face regulatory liability if it knowingly operates routes for non-compliant operators. A compliance gating system protects the platform and gives operators a clear path to compliance.  
**Implementation**: Add `compliance_status` JSON to operators. On any write API call, check compliance status for non-SUPER_ADMIN users. Return 403 with specific missing compliance item.  
**Reuse/Integration**: Build in this repo. SUPER_ADMIN tooling.  
**Dependencies**: None.  
**Priority**: Low

---

### O-14: Operator Branding and White-Label Portal
**Title**: Per-operator branding (logo, colors) applied to customer-facing booking portal  
**Description**: Allow operators to configure their logo, brand colors, and display name. When a customer accesses the booking portal via the operator's branded domain (e.g. `booking.gcoperator.ng`), the portal shows the operator's brand.  
**Why it matters**: Large operators want their own booking portal, not a generic WebWaka portal. White-labeling enables operators to maintain their own brand while using WebWaka's infrastructure.  
**Implementation**: Add `branding` JSON to operator config (logo URL, primary color, secondary color). On portal load, detect operator from subdomain or API parameter. Apply CSS variables for branding.  
**Reuse/Integration**: Build in this repo. Branding assets stored in Cloudflare R2.  
**Dependencies**: S-05 (operator config), R2 binding.  
**Priority**: Low

---

### O-15: Operator Tier and Subscription Management
**Title**: Operator subscription tier management with feature gating  
**Description**: Define operator subscription tiers (Basic, Professional, Enterprise) with feature entitlements (number of routes, number of agents, dynamic pricing, AI search, white-labeling). SUPER_ADMIN manages tier assignments.  
**Why it matters**: WebWaka's commercial model requires differentiating features by plan. Without tier gating, all operators get all features, making monetization impossible.  
**Implementation**: Add `subscription_tier` to operators. Feature flags per tier in `TENANT_CONFIG_KV`. Middleware checks tier before executing feature-gated endpoints.  
**Reuse/Integration**: Build in this repo. Subscription management can integrate with Paystack Subscriptions for automated billing.  
**Dependencies**: S-05 (operator config).  
**Priority**: Low

---

### O-16: Route Demand Heatmap Analytics
**Title**: Origin–destination demand heatmap for route planning insights  
**Description**: Aggregate booking origin–destination pairs by frequency to generate a demand heatmap. Identify underserved routes (high search demand, low trip supply). Surface insights to SUPER_ADMIN and TENANT_ADMIN.  
**Why it matters**: Trip search data (including AI search queries) captures passenger intent even when a matching trip doesn't exist. Analyzing search demand reveals where new routes should be launched.  
**Implementation**: Log AI search queries (non-personally-identifying) with extracted origin/destination. `GET /api/operator/reports/demand` aggregates booking O-D pairs. Heatmap visualization on operator dashboard.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: B-14 (AI search logging).  
**Priority**: Low

---

### O-17: Operator Referral and Growth Programme
**Title**: Operator referral programme with tracked referral codes and commission  
**Description**: Allow operators to generate referral codes that they share with other potential operators. When a referred operator onboards and runs their first trip, the referring operator receives a credit.  
**Why it matters**: Operator acquisition is the hardest part of platform growth. A referral programme turns existing operators into sales agents, reducing customer acquisition cost.  
**Implementation**: New `operator_referrals` table. Add `referral_code` to operators. Track referral attribution on operator creation. Credit on first successful trip by referred operator.  
**Reuse/Integration**: Build in this repo.  
**Dependencies**: O-09 (onboarding wizard to surface referral code).  
**Priority**: Low

---

### O-18: Bulk Import of Existing Routes and Vehicles
**Title**: CSV/Excel bulk import for routes, vehicles, and drivers  
**Description**: Allow new operators to import their existing route and vehicle data via CSV upload, rather than entering each record manually through the API or UI.  
**Why it matters**: An operator with 50 routes, 100 vehicles, and 30 drivers will not manually enter each record into a new system. A bulk import is the difference between onboarding in hours vs. weeks.  
**Implementation**: `POST /api/operator/import/routes` (CSV). Parse with a server-side CSV parser. Validate each row. Return a summary of created, skipped, and failed records.  
**Reuse/Integration**: Build in this repo. CSV parsing can use a lightweight edge-compatible library.  
**Dependencies**: O-09 (onboarding context).  
**Priority**: Medium

---

### O-19: Notifications Center for Operators
**Title**: In-app notification center for operators with event-driven alerts  
**Description**: A notification inbox for TENANT_ADMIN and SUPERVISOR showing: new booking received, agent conflict detected, vehicle compliance expiring, driver SOS, trip delayed, reconciliation discrepancy, high-priority platform event.  
**Why it matters**: Operators currently have no consolidated view of what requires their attention. They discover issues when customers complain or agents call. A notification center surfaces issues proactively.  
**Implementation**: `GET /api/operator/notifications` pulling unread events from `platform_events` filtered by `tenant_id`. Mark-read endpoint. Push notification for critical events (SOS, large discrepancy).  
**Reuse/Integration**: Build in this repo. Platform events already flow through the event bus.  
**Dependencies**: Event bus (already built).  
**Priority**: Medium

---

### O-20: SUPER_ADMIN Cross-Tenant Analytics Dashboard
**Title**: Platform-wide analytics dashboard for WebWaka SUPER_ADMIN  
**Description**: A SUPER_ADMIN-only analytics dashboard showing: total operators, total trips by state, total bookings by status, total revenue across all tenants, top routes by volume, top operators by revenue, and platform-level KPIs.  
**Why it matters**: WebWaka's platform team has no visibility into aggregate platform health. Without this, capacity planning, operator support prioritization, and commercial reporting are impossible.  
**Implementation**: `GET /api/admin/analytics` (SUPER_ADMIN only). Aggregations across all operators (no tenant filter). Displayed in a SUPER_ADMIN section of the operator dashboard.  
**Reuse/Integration**: Build in this repo. SUPER_ADMIN already has cross-tenant query capability.  
**Dependencies**: None.  
**Priority**: Medium

---

## 8. Cross-Repo Integration Map

### 8.1 What Should Be Built in This Repo (Transport-specific)

| Feature | Module | Notes |
|---------|---------|-------|
| Multi-seat atomic reservation (S-01) | TRN-1 | Core transport logic |
| Seat class and pricing (S-04) | TRN-1 | Transport-specific |
| Real-time seat availability via SSE/DO (S-03/S-20) | TRN-1 | Cloudflare-first |
| Boarding scan endpoint (D-03) | TRN-4 | Transport-specific |
| GPS location update endpoint (D-04) | TRN-4 | Transport-specific |
| SOS trigger and escalation (D-08) | TRN-4 | Transport-specific |
| Trip state machine and manifest (D-02) | TRN-4 | Transport-specific |
| Agent daily float reconciliation (A-03) | TRN-2 | Transport agent operations |
| Passenger e-ticket and QR boarding pass (B-03) | TRN-3 | Transport booking artifact |
| Offline sync wire-up for agent transactions (A-01) | TRN-2 | Sync architecture |
| Fare matrix and dynamic pricing (O-08, B-18) | TRN-3/4 | Business logic |
| Operator config service (S-05) | All | Transport-scoped config |
| Bus park / terminal management (A-07, O-01) | TRN-2/4 | Physical location entities |
| Vehicle maintenance and compliance (O-02) | TRN-4 | Fleet management |
| Driver document management (O-04) | TRN-4 | Driver compliance |
| Digital parcel waybill recording (D-14) | TRN-4 | Logistics interface only |
| Recurring schedule engine (D-16) | TRN-4 | Trip automation |

### 8.2 What Should Be Integrated from the Logistics Repo (Not Built Here)

| Feature | Notes |
|---------|-------|
| Parcel delivery tracking | Core logistics feature — do not rebuild. Integrate via events. |
| Warehouse management | Logistics-only concern |
| Delivery route optimization | Logistics-only concern |
| Courier/last-mile dispatch | Logistics-only concern |
| Parcel weight/dimension management | Logistics-owned entity |
| Fulfillment workflows | Logistics-owned process |

**Integration protocol**: Transport publishes `parcel.waybill_created` events to the event bus. The logistics repo subscribes and manages the parcel lifecycle. Transport receives `parcel.seats_required` events to block cargo space on buses. No direct DB cross-access. No API calls except via the event bus consumer pattern.

### 8.3 What Should Be Exposed as Shared Platform Capabilities (in `@webwaka/core`)

| Capability | Current State | Action |
|-----------|--------------|--------|
| `applyTenantScope()` / `getOperatorScope()` | In `src/api/types.ts` | Move to `@webwaka/core` |
| `parsePagination()` / `metaResponse()` | In `src/api/types.ts` | Move to `@webwaka/core` |
| NDPR consent recording | Duplicated in `db.ts` and booking API | Centralize in `@webwaka/core` or a shared NDPR service |
| Notification dispatch (SMS, push) | In `src/lib/sms.ts` and `src/lib/push.ts` | Extract to a shared platform notification service |
| Event bus outbox writer (`publishEvent`) | In `@webwaka/core` ✅ | Already shared — ensure all repos use this |
| OTP generation and verification | In `src/api/auth.ts` | Extract to `@webwaka/core` for cross-repo auth |
| JWT generation/verification | In `@webwaka/core` ✅ | Already shared |
| RBAC middleware (`requireRole`) | In `@webwaka/core` ✅ | Already shared |
| Tenant middleware (`requireTenant`) | In `@webwaka/core` ✅ | Already shared |
| ID generation | Duplicated (`genId` in types.ts, `nanoid` in core) | Consolidate to `nanoid` in `@webwaka/core` |

### 8.4 What Should Never Be Duplicated

| Concern | Canonical Location |
|---------|-------------------|
| Parcel lifecycle management | Logistics repo only |
| Warehouse operations | Logistics repo only |
| Customer identity and authentication | Transport auth service (shared via `@webwaka/core`) |
| Financial transaction ledger | Transport repo (bookings, sales_transactions) — do not create a second ledger in logistics |
| NDPR consent audit trail | Transport repo (for transport customers) — share consent service, not data |
| Event bus publisher | `@webwaka/core` — all repos use the same `publishEvent()` |
| JWT verification | `@webwaka/core` — never implement JWT parsing again in another repo |

---

## 9. Recommended Execution Order

The sequence below orders enhancements by dependency, business value, and risk. Critical path items first, speculative/low-priority items last.

### Phase 1: Foundation Fixes (Weeks 1–4)
*These fix current bugs and gaps that affect all modules.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 1 | A-01: Offline Transaction Auto-Sync | Fixes a broken sync path that silently loses agent sales |
| 2 | S-01: Multi-Seat Atomic Reservation | Eliminates seat race conditions blocking reliable booking |
| 3 | S-02: Configurable Reservation TTL | Extends TTL for online payments — critical for Paystack/Flutterwave |
| 4 | B-01: Paystack Inline Payment | Eliminates redirect abandonment — direct conversion impact |
| 5 | B-02: SMS Booking Confirmation | Wires the existing `booking.created` event to the SMS lib |
| 6 | B-03: E-Ticket with QR | Depends on B-02; produces the boarding artifact |
| 7 | S-06: Seat Hold Extension | Supports longer payment flows after S-02 |

### Phase 2: Operational Core (Weeks 5–10)
*These build the essential operations layer that operators need to run daily.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 8 | D-02: Trip Manifest Generation | Required for FRSC compliance — legal requirement |
| 9 | D-03: Digital Boarding Scan | Closes fraud loop on boarding; requires B-03 |
| 10 | D-01: Driver Mobile App | Packages D-02, D-03, D-04, D-08 into driver experience |
| 11 | D-04: Real-Time GPS | Required by B-11 (passenger tracking) and D-07 (dispatcher) |
| 12 | D-08: SOS Trigger | Safety feature — high operator demand |
| 13 | A-02: Thermal Receipt Printing | Completes the agent POS receipting flow |
| 14 | A-03: Float Reconciliation | High operator pain point — eliminates manual ledger |
| 15 | D-16: Automated Schedule Generation | Eliminates the largest operator administrative burden |

### Phase 3: Revenue Acceleration (Weeks 11–18)
*These directly increase revenue for operators and WebWaka.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 16 | S-04: Seat Classes and Pricing | Direct revenue per seat — requires O-03 |
| 17 | O-03: Vehicle Seat Templates | Foundation for S-04 and S-11 |
| 18 | B-06: Refund Policy | Trust builder that increases online payment conversion |
| 19 | B-18: Dynamic Pricing | Captures peak-demand revenue — requires S-04 and O-08 |
| 20 | O-08: Fare Matrix | Required by B-18 |
| 21 | S-18: Waiting List | Converts cancellations into revenue |
| 22 | B-04: Guest Booking | Reduces registration abandonment |
| 23 | A-17: Group Booking | High-value segment (churches, schools, corporate) |

### Phase 4: Platform and Ecosystem (Weeks 19–28)
*These expand the platform's reach and deepen ecosystem integration.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 24 | D-05: Pre-Trip Inspection | Safety compliance — regulatory risk reduction |
| 25 | O-02: Vehicle Maintenance | Fleet compliance — regulatory risk reduction |
| 26 | O-04: Driver Document Management | Driver compliance — regulatory risk reduction |
| 27 | D-06: Delay Reporting | Passenger experience — reduces support volume |
| 28 | D-07: Fleet Dispatch Dashboard | Operator operational control center |
| 29 | B-09: Booking Reminders | Reduces no-show rate and departure delays |
| 30 | D-14: Digital Waybill (Logistics Integration) | Activates parcel revenue stream — cross-repo |
| 31 | S-17: Parcel Seat Blocking | Logistics repo integration for capacity coordination |
| 32 | B-07: Full i18n (Yoruba/Igbo/Hausa) | Market expansion — vernacular UX |
| 33 | A-04: Multi-Agent Device Sharing | Operational necessity for shared-device parks |

### Phase 5: Platform Maturity and Monetization (Weeks 29–40)
*These build the platform-level and commercial features.*

| Priority | Enhancement | Rationale |
|----------|------------|-----------|
| 34 | S-03: Durable Objects Real-Time Seats | Performance at scale — replaces SSE (S-20) |
| 35 | B-15: WhatsApp Booking | Channel expansion — reaches non-app users |
| 36 | B-10: Operator Reviews | Trust system — booking conversion signal |
| 37 | O-05: Revenue per Route Analytics | Operator data intelligence |
| 38 | O-20: SUPER_ADMIN Analytics | Platform health visibility |
| 39 | O-09: Operator Onboarding Wizard | Reduces time-to-first-trip |
| 40 | O-18: Bulk Import | Onboarding acceleration |
| 41 | O-01: Terminal Management | Multi-park operators |
| 42 | D-10: Route Deviation Alert | Safety monitoring at scale |
| 43 | O-15: Subscription Tiers | Commercial monetization |
| 44 | O-12: Operator API Keys | B2B integration capability |
| 45 | B-13: Corporate Travel Portal | High-value segment |
| 46 | B-16: USSD Channel | Feature phone / rural reach |
| 47 | O-14: White-Label Portal | Enterprise operator tier |
| 48 | D-12: Trip Recovery Workflow | Operational resilience |

---

*This document covers 100 transport enhancements across 5 use cases, a full codebase architecture report, Nigeria market research synthesis, a cross-repo integration map, and a phased execution sequence. All recommendations are grounded in the actual codebase as read on March 31, 2026, and are consistent with the platform principles: Nigeria-First, Offline-First, Mobile-First, Cloudflare-First, Multi-Repo, Build Once Use Everywhere, Vendor-Neutral AI, and Event-Driven Architecture.*
