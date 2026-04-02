# WebWaka Transport Codebase Architecture Report

## 1. Repository Overview

The **webwaka-transport** repository is a Cloudflare-first, offline-first, multi-tenant transportation platform designed specifically for the Nigerian intercity bus market. It is not a standalone product but rather one vertical module within the broader WebWaka OS v4 multi-repo ecosystem. The repository shares a platform core package (`@webwaka/core`) and emits events to the platform event bus for consumption by other services, notably the logistics, fintech, and central management repositories.

## 2. Technology Stack & Deployment Architecture

| Component | Technology | Purpose |
| :--- | :--- | :--- |
| **Runtime** | Cloudflare Workers | Serverless edge compute for API and scheduled tasks |
| **Database** | Cloudflare D1 (SQLite) | Primary persistence for operators, routes, vehicles, trips, seats, bookings, agents, customers, and events |
| **Key-Value Store** | Cloudflare KV | Session storage, tenant configuration cache, seat availability cache, idempotency tokens |
| **Object Storage** | Cloudflare R2 | Operator branding assets (logos, images) |
| **Real-Time Sync** | Cloudflare Durable Objects | WebSocket fan-out for per-trip seat availability updates (`TripSeatDO`) |
| **Frontend** | React 18 + Vite + TypeScript | Progressive Web App (PWA) for agent POS, customer booking, and operator management |
| **Offline Storage** | Dexie (IndexedDB) | Client-side offline mutation queue, seat/trip cache, conflict log, agent sessions, NDPR consent trail |
| **API Framework** | Hono | Lightweight, type-safe HTTP router for Cloudflare Workers |
| **Shared Core** | `@webwaka/core` | Platform primitives: JWT auth, RBAC, event bus, KYC, notifications, AI, payments, tax, SMS, optimistic locking |

## 3. Database Schema & Domain Model

The transport database schema consists of **21 tables** across 9 migrations, organized into five functional domains.

### 3.1 Operator & Fleet Management (TRN-4)
Tables: `operators`, `routes`, `route_stops`, `vehicles`, `drivers`, `terminals`, `schedules`, `agent_broadcasts`, `dispute_tickets`.

### 3.2 Trip & Seat Inventory (TRN-1)
Tables: `trips` (state machine: scheduled → boarding → in_transit → completed/cancelled), `seats` (status: available/reserved/sold, with reservation expiry, seat class, and price).

### 3.3 Agent Sales & Offline POS (TRN-2)
Tables: `agents`, `sales_transactions` (with offline `sync_status`), `receipts` (with `qr_code` column, currently unpopulated).

### 3.4 Customer Booking Portal (TRN-3)
Tables: `customers` (with NDPR consent, `customer_type` individual/corporate, `credit_limit_kobo`), `bookings` (with `boarded_at`/`boarded_by` columns, insurance fields, origin/destination stop IDs), `operator_reviews`.

### 3.5 Platform Integration & Sync
Tables: `sync_mutations` (offline queue), `platform_events` (event bus outbox).

## 4. Core Modules & Business Logic

### 4.1 Seat Inventory Manager (`src/core/seat-inventory/index.ts`)
Implements atomic seat reservation logic with optimistic concurrency control. Reservations expire after a configurable TTL (default 15 minutes). Version-based optimistic locking prevents double-booking across concurrent agents.

### 4.2 Booking Manager (`src/core/booking/index.ts`)
Orchestrates the customer booking flow, integrating with the seat inventory manager for atomic seat holds and publishing `booking.created` events to the platform event bus.

### 4.3 Trip State Machine (`src/core/trip-state/index.ts`)
Manages the trip lifecycle through a strict state machine: `scheduled` → `boarding` → `in_transit` → `completed` | `cancelled`. Each transition emits a `trip.state_changed` event.

### 4.4 Offline Sync Engine (`src/core/offline/sync.ts`)
The most sophisticated component of the codebase. Queues offline agent transactions, booking updates, and seat changes in Dexie IndexedDB. Uses the Web Locks API for cross-tab mutual exclusion. Implements exponential backoff (up to 32 seconds) on retry. Detects 409 Conflict responses and logs them to the conflict log for manual resolution. Registers a Service Worker background sync event (`webwaka-transport-sync`) to flush the queue when connectivity returns, even if the app is closed.

### 4.5 Durable Object: TripSeatDO (`src/durables/trip-seat-do.ts`)
A Cloudflare Durable Object that maintains a WebSocket fan-out for a single trip's seat map. Each trip gets its own DO instance keyed by `tripId`. Broadcasts `seat_changed` messages to all connected clients when a seat status changes, enabling real-time seat map updates without polling.

### 4.6 Scheduled Sweepers (`src/lib/sweepers.ts`)
Four cron-triggered maintenance functions:
- `drainEventBus()` — every minute: processes up to 50 pending `platform_events`
- `sweepExpiredReservations()` — every minute: releases expired seat holds
- `sweepAbandonedBookings()` — every minute: cancels bookings pending > 30 minutes
- `sweepExpiredPII()` — daily: anonymizes customers inactive 2+ years (NDPR/NDPA compliance)
- `purgeExpiredFinancialData()` — daily: soft-deletes financial records > 7 years (FIRS compliance)

## 5. API Surface

| Router | Path Prefix | Key Endpoints |
| :--- | :--- | :--- |
| **auth.ts** | `/api/auth` | OTP send/verify, logout |
| **seat-inventory.ts** | `/api/seat-inventory` | Seat availability, reserve, release, real-time WebSocket |
| **agent-sales.ts** | `/api/agent-sales` | Transactions, reconciliation, performance, broadcasts |
| **booking-portal.ts** | `/api/booking` | Trip search (AI-powered), bookings CRUD, payment initiation, reviews |
| **operator-management.ts** | `/api/operator` | Routes, vehicles, drivers, trips, schedules, reports, branding, bulk import |
| **payments.ts** | `/api/payments` | Paystack and Flutterwave initiate/verify |
| **notifications.ts** | `/api/notifications` | Push subscription management |

## 6. Cross-Repo Integration Points

| Integration Domain | Direction | Counterpart Repo | Event / API | Status |
| :--- | :--- | :--- | :--- | :--- |
| **Parcel Waybill** | Outbound | Logistics | `parcel.waybill_created` | Wired in event bus, no recording endpoint yet |
| **Parcel Seat Blocking** | Inbound | Logistics | `parcel.seats_required` | Event consumer not yet implemented |
| **Payment Processing** | Outbound | Core (Payments) | `initializePayment()` | Active via Paystack/Flutterwave |
| **KYC Verification** | Outbound | Core (KYC) | `verifyKYC()` | Available, not yet wired for corporate customers |
| **SMS Notifications** | Outbound | Core (Notifications) | `sendSMS()` | Infrastructure exists, not fully deployed |
| **AI Trip Search** | Outbound | Core (AI) | `AIEngine.chat()` | Active via OpenRouter |
| **Tax Calculation** | Outbound | Core (Tax) | `calculateVAT()` | Available, not yet applied to bookings |
| **Central Ledger** | Outbound | Central Mgmt | `booking.created` event | Event emitted, consumer not confirmed |

## 7. Gaps, Duplication, and Missing Functionality

### 7.1 Critical Gaps (Schema exists, implementation missing)
1. **No GPS update endpoint** — `current_latitude`, `current_longitude`, `location_updated_at` columns exist in `trips` but no `PATCH /api/operator/trips/:id/location` endpoint.
2. **SOS system incomplete** — `sos_triggered_at`, `sos_triggered_by`, `sos_cleared_at`, `sos_escalated_at` columns exist but no trigger/clear/escalate endpoints.
3. **QR code never generated** — `receipts.qr_code` column exists but is always null.
4. **No boarding scan endpoint** — `bookings.boarded_at` and `boarded_by` columns exist but no check-in/boarding API.
5. **No trip manifest export** — No `GET /api/operator/trips/:id/manifest` endpoint for FRSC compliance.
6. **No parcel waybill recording** — `parcel.waybill_created` event defined but no recording endpoint.
7. **No corporate credit booking** — `customers.credit_limit_kobo` exists but no credit booking flow.

### 7.2 Duplication Risks
1. `genId()` in `src/api/types.ts` duplicates `nanoid()` from `@webwaka/core`
2. `parsePagination()` and `metaResponse()` should be in `@webwaka/core/query-helpers`
3. `src/lib/sms.ts` and `src/lib/push.ts` duplicate logic already in `@webwaka/core/notifications`
4. NDPR consent recording is duplicated between Dexie and the booking API

### 7.3 Missing High-Value Features
Dynamic seat pricing, waiting list, route deviation alerts, trip recovery workflow, USSD booking channel, WhatsApp booking bot, insurance integration, loyalty program, and automated schedule generation from recurring templates.



# Nigeria Transport Market Research Summary

## 1. Market Overview

Nigeria's intercity road transport market is the dominant mode of passenger movement in Africa's most populous nation. With over 220 million people and a road network spanning more than 195,000 kilometres, road transport accounts for an estimated 90% of all passenger and freight movement in the country. The formal intercity bus market is fragmented across thousands of operators, with no single player commanding more than approximately 5% of all routes. The global intercity bus travel market was valued at $42.8 billion in 2025 and is projected to reach $73.6 billion by 2034 at a 6.2% CAGR, with sub-Saharan Africa representing a rapidly growing segment [1].

The Nigerian government's ₦142 billion investment in six national bus terminals — announced in January 2026 — signals a structural shift toward formalised, regulated intercity travel infrastructure [2]. The Federal Capital Territory's three new bus terminals in Kugbo, Mabushi, and the Central Business District are awaiting Federal Executive Council approval to begin operations [3], creating an immediate opportunity for digital ticketing and manifest management systems.

## 2. Key Transport Operators & Digital Landscape

The dominant intercity operators include GIG Mobility (GIGM), GUO Transport, ABC Transport, Peace Mass Transit (PMT), Chisco Transport, Young Shall Grow, and Greener Line. Of these, GIGM has the most advanced digital infrastructure, operating a dedicated mobile application and web booking portal with seat selection. However, their systems are proprietary, aging, and poorly optimized for low-bandwidth environments. The vast majority of mid-sized operators (20–100 buses) have no digital ticketing infrastructure whatsoever and rely entirely on paper-based agent sales.

Aggregation platforms such as Shuttlers (commuter/corporate shuttles) and BuuPass (primarily East Africa) have demonstrated the market appetite for digital booking but have not yet penetrated the Nigerian intercity segment at scale. This represents a significant white-space opportunity for WebWaka Transport.

## 3. Passenger Behavior & Booking Preferences

Nigerian intercity passengers exhibit distinct behavioral patterns that must inform every product decision:

**Walk-in dominance**: The overwhelming majority of intercity bus journeys are still purchased at the bus park on the day of travel. Advance booking is growing, particularly for long-distance routes exceeding five hours, but it remains a minority behavior. This means the agent POS is not a legacy feature — it is the primary revenue channel and must be treated as the core product.

**Payment method mix**: Cash remains the dominant payment method at bus parks, accounting for an estimated 60–70% of agent transactions. Mobile money (OPay, PalmPay, Moniepoint, MTN MoMo) is growing rapidly and is now common at parks in Lagos, Abuja, and Port Harcourt. Bank transfer via USSD is used by more affluent passengers. Online card payments (Paystack, Flutterwave) are used primarily by passengers booking in advance via mobile app or web. The CBN's upgrade of OPay, Moniepoint, and PalmPay to national banking licences in March 2025 will accelerate mobile money adoption at bus parks [4].

**Trust barriers**: Trust is a significant barrier to online booking adoption. Passengers frequently distrust online payments without immediate physical confirmation. The receipt is a critical trust artifact — it must look professional, carry a unique ID, and be verifiable. QR-coded digital receipts are both a fraud deterrent and a professionalism signal.

**Vernacular preference**: Many passengers are semi-literate in English but fluent in Yoruba, Igbo, or Hausa. The transport repo already includes i18n support for these four languages, which is a meaningful competitive differentiator.

**WhatsApp as the support channel**: Passengers heavily favor WhatsApp for post-booking support — confirming a booking, requesting refunds, and asking about delays. Any notification or support system must integrate with WhatsApp as the primary channel.

## 4. Agent Behavior & Bus Park Operations

Bus park sales agents are the backbone of the Nigerian transport ticketing ecosystem. Their behavior and constraints must be the primary design input for the agent POS module:

**Commission-driven speed**: Agents work on commission. The speed of transaction is critical — a slow POS means lost revenue. Any digital tool must be faster than the paper alternative, not slower.

**Offline-first is survival**: Agents frequently operate in areas with 2G or intermittent 3G connectivity. Offline-first is not a product feature — it is a survival requirement. The system must function fully offline and sync later without data loss.

**Shared devices**: Agents share tablets and phones. Multi-session or fast agent switching on a single device is a real operational requirement, not an edge case.

**Manual float tracking**: Agents manually track cash in paper ledgers. Supervisors reconcile agent cash daily. Any digital tool that replaces this must be simpler and faster than the paper alternative, and it must support the daily float reconciliation workflow that operators depend on for fraud prevention.

**Passenger ID requirements**: Nigerian law enforcement (FRSC, police) increasingly requires bus manifests to include passenger identification. The Lagos State Government launched a digital passenger manifest program in November 2024, with agents assigned to parks to manage digital manifest collection [5]. Operators face fines and delays at checkpoints if manifests are incomplete.

## 5. Operator Pain Points

Mid-sized operators (20–100 buses) are the primary target segment. They are organized enough to benefit from digital tools but not large enough to have built their own systems. Their top operational pain points are:

**Driver accountability**: Driver absenteeism, unauthorized route deviations, and cash misappropriation are chronic problems. Digital manifests, GPS tracking, and boarding scans directly address these.

**Double-selling fraud**: Two agents on different devices selling the same seat simultaneously is a known fraud vector. Real-time seat inventory synchronization is the primary technical solution.

**Agent float fraud**: Agents collect cash but under-report sales, keeping the difference. Daily digital reconciliation tools directly address this.

**Vehicle compliance**: Operators must maintain valid roadworthiness certificates, insurance, and driver licenses. FRSC's new roadworthiness inspection regime (September 2025) has increased compliance pressure [6]. Digital document management reduces the risk of operating with expired documents.

**Revenue visibility**: Most operators have no real-time visibility into how many seats have been sold, how much cash has been collected, or which routes are most profitable. A digital dashboard provides this visibility for the first time.

## 6. Logistics Adjacency

The parcel revenue stream is a critical and often overlooked aspect of the Nigerian intercity bus market. Almost every intercity bus carries parcels alongside passengers, and parcel revenue represents an estimated 10–20% of total revenue for many operators. This is currently managed with paper waybills that are frequently lost or unreadable.

The Nigeria freight and logistics market is projected to grow from $10.95 billion in 2025 to $11.66 billion in 2026 [7], and the courier, express, and parcel (CEP) segment is valued at $129.77 million in 2025 [8]. The intersection of transport and logistics — where intercity buses serve as the physical backbone of parcel movement — is a significant revenue opportunity that WebWaka Transport must address through integration with the logistics repository, not by rebuilding logistics capabilities.

## 7. Compliance & Regulatory Realities

**NDPR/NDPA (Data Protection)**: The Nigeria Data Protection Commission issued the General Application and Implementation Directive (GAID) on 20 March 2025, which became effective on 19 September 2025 [9]. The transport repo's existing NDPR consent trail and PII anonymization sweeper must be updated to comply with GAID's more specific requirements for data subject rights, breach notification, and cross-border data transfers.

**FIRS (Tax Compliance)**: Financial records must be retained for 7 years. VAT applies to transport services above the threshold. The transport repo's daily `purgeExpiredFinancialData()` sweeper is correctly implemented but the VAT calculation from `@webwaka/core/tax` is not yet applied to bookings.

**FRSC (Road Safety)**: The Federal Road Safety Corps reported a 9.2% rise in road traffic crashes in 2025 compared to 2024 [10]. FRSC's new roadworthiness inspection regime (September 2025) has increased compliance pressure on operators. Digital manifests, pre-trip vehicle inspections, and driver document management directly support FRSC compliance.

**Lagos Digital Manifest Mandate**: The Lagos State Ministry of Transportation launched a digital passenger manifest program in November 2024, with a pilot at Ojota park. This is expected to become mandatory across all 30 regulated parks and eventually the 100+ currently unregulated parks [5]. WebWaka Transport's manifest export capability is therefore not optional — it is a regulatory requirement for Lagos-based operators.

## 8. Product Implications

The following product principles emerge from this market research and must govern all enhancement decisions:

1. **Agent POS is the primary product**: Walk-in, same-day agent sales dominate. The POS must be faster, more reliable, and more fraud-resistant than paper.
2. **Offline is the default, not the exception**: Design for 2G minimum. Payload size, request count, and image size matter.
3. **The receipt is a trust artifact**: It must look professional, carry a unique ID, and be verifiable via QR code.
4. **Real-time seat sync is a competitive advantage**: Most operators still call each other by phone to check seat availability. Real-time sync is a strong differentiator.
5. **Digital manifests are a regulatory requirement**: Lagos mandate and FRSC pressure make this non-negotiable for operators in regulated parks.
6. **Parcel revenue is a natural extension**: Integrate with the logistics repo rather than rebuild parcel management.
7. **WhatsApp is the customer support channel**: All notifications and post-booking support must flow through WhatsApp.
8. **Vernacular UI is a differentiator**: Yoruba, Igbo, and Hausa support is already built — it must be maintained and extended.

---

### References
[1] MarketIntelo. "Intercity Bus Travel Market Research Report 2034." March 2026.
[2] Independent Nigeria. "N142bn Mobility Makeover: How Nigeria's Six National Bus Terminals Could Redefine Intercity Travel." January 2026.
[3] Vanguard. "FCT bus terminals awaiting FEC approval to begin operations." February 2026.
[4] Nigeria Communications Week. "CBN Upgrades Licences of OPay, Moniepoint, Kuda, PalmPay to National Status." March 2025.
[5] Punch Newspapers. "Lagos modernises interstate travel with digital passenger manifests, park accreditation." November 2024.
[6] This Day Live. "FRSC's New Roadworthiness Inspections." September 2025.
[7] Mordor Intelligence. "Nigeria Freight and Logistics Market Size & Growth 2031." January 2026.
[8] Mordor Intelligence. "Nigeria Courier, Express, and Parcel (CEP) Market Report." January 2026.
[9] IAPP. "From principles to practice: Operationalizing Nigeria's Data Protection Act through the GAID." February 2026.
[10] FRSC Instagram. "The Federal Road Safety Corps reports a 9.2% rise in road traffic crashes in 2025." 2025.



# Top 20 Seat Inventory Sync Enhancements

Seat inventory synchronization is the technical core of the transport platform. Double-booking is a primary source of passenger conflict and operator revenue loss in Nigeria. The following 20 enhancements focus on atomic reservations, offline-resilient holds, and real-time distribution across the multi-tenant architecture.

## 1. Core Sync & Atomicity

1. **Multi-Seat Atomic Reservation Engine (S-01)**
   - **Description**: Ensure that when an agent or customer selects multiple seats (e.g., a family of 4), the entire block is reserved atomically. If any single seat is taken by a concurrent transaction, the entire hold fails cleanly.
   - **Why it matters**: Prevents split parties and partial bookings, which are major friction points at bus parks.
   - **Implementation**: Utilize the `@webwaka/core/optimistic-lock` primitive to validate versions across all requested seats in a single D1 transaction.
   - **Reuse/Integration**: Core primitive reuse.
   - **Priority**: Critical

2. **Durable Object Real-Time Seat Fan-out (S-03)**
   - **Description**: Fully wire the existing `TripSeatDO` to broadcast `seat_changed` WebSocket messages to all connected agent POS terminals and customer booking clients.
   - **Why it matters**: Replaces expensive polling with instant updates, ensuring agents see seats turn red the millisecond they are selected elsewhere.
   - **Implementation**: In the `reserveSeat` mutation, dispatch a POST to the DO's `/broadcast` endpoint.
   - **Reuse/Integration**: Build in transport repo.
   - **Priority**: Critical

3. **Configurable Reservation TTL by Channel (S-02)**
   - **Description**: Implement dynamic Time-To-Live (TTL) for seat holds based on the booking channel. Agent POS holds might expire in 3 minutes, while online Paystack holds get 15 minutes to allow for OTP/bank transfer completion.
   - **Why it matters**: Maximizes inventory utilization while accommodating the reality of slow Nigerian payment gateways.
   - **Implementation**: Extend the `sweepExpiredReservations()` cron job to respect a per-reservation `expires_at` timestamp rather than a global default.
   - **Reuse/Integration**: Build in transport repo.
   - **Priority**: High

4. **Offline Optimistic Hold Queue**
   - **Description**: When an agent operates offline, the Dexie `syncEngine` must record a local "optimistic hold." When connectivity returns, the engine attempts to commit the hold. If a 409 Conflict occurs, the transaction is routed to the Conflict Resolution UI.
   - **Why it matters**: Allows agents to continue selling seats rapidly in 2G environments without waiting for server confirmation.
   - **Implementation**: Enhance `src/core/offline/sync.ts` to handle seat mutation conflicts gracefully.
   - **Reuse/Integration**: Build in transport repo.
   - **Priority**: Critical

5. **Background Sync Conflict Resolution UI**
   - **Description**: A dedicated dashboard for terminal supervisors to resolve offline sync conflicts (e.g., Agent A and Agent B both sold Seat 4 offline).
   - **Why it matters**: Conflicts will happen in offline-first systems. Supervisors need a tool to reassign passengers to empty seats or different trips before the bus departs.
   - **Implementation**: Build a React UI over the `conflict_log` Dexie table.
   - **Reuse/Integration**: Build in transport repo.
   - **Priority**: High

## 2. Inventory Segmentation & Yield

6. **Dynamic Seat Class Segmentation (S-04)**
   - **Description**: Allow operators to define seat classes (e.g., VIP Front, Standard Window, Rear Aisle) with distinct pricing tiers on the same vehicle.
   - **Why it matters**: Unlocks ancillary revenue. Nigerian passengers are willing to pay a premium for front seats to avoid the bumpy rear.
   - **Implementation**: Update the `seats` table schema and UI to support `seat_class` and `price_modifier`.
   - **Reuse/Integration**: Build in transport repo.
   - **Priority**: High

7. **Logistics Parcel Seat Blocking (S-17)**
   - **Description**: Automatically block designated rear or undercarriage "seats" when the logistics repository confirms a large parcel shipment for a specific trip.
   - **Why it matters**: Intercity buses derive 10-20% of revenue from parcels. Uncoordinated loading leads to buses leaving passengers behind because seats are filled with cargo.
   - **Implementation**: Subscribe to `parcel.seats_required` events from the platform event bus and execute a system-level seat hold.
   - **Reuse/Integration**: Deep integration with Logistics repo via Event Bus.
   - **Priority**: High

8. **Agent Quota Allocation**
   - **Description**: Allow operators to hard-allocate specific seat blocks (e.g., Seats 1-10) to specific agents or partner agencies.
   - **Why it matters**: Common practice in Nigerian bus parks where freelance "touts" or partner agencies guarantee sales for a block of seats.
   - **Implementation**: Add an `allocated_to_agent_id` column to the `seats` table.
   - **Reuse/Integration**: Build in transport repo.
   - **Priority**: Medium

9. **Dynamic Yield Pricing (B-18)**
   - **Description**: Automatically increase seat prices as the bus fills up or as the departure time approaches (e.g., last 5 seats cost 20% more).
   - **Why it matters**: Maximizes revenue on high-demand routes (e.g., Lagos to Onitsha during Christmas).
   - **Implementation**: Build a pricing rules engine that evaluates inventory percentage before returning the fare.
   - **Reuse/Integration**: Build in transport repo.
   - **Priority**: Medium

10. **Automated Waiting List (S-18)**
    - **Description**: Allow customers to join a waiting list for sold-out trips. If a seat reservation expires or a booking is cancelled, the system automatically notifies the next person via SMS.
    - **Why it matters**: Recovers revenue from abandoned online carts and last-minute cancellations.
    - **Implementation**: New `waiting_list` table. Triggered by the `sweepExpiredReservations()` cron.
    - **Reuse/Integration**: Uses `@webwaka/core/notifications` for SMS alerts.
    - **Priority**: Medium

## 3. Cross-Repo Integration

11. **Central Ledger Revenue Sync**
    - **Description**: When a seat transitions to `sold`, publish a financial event to the central management repository's double-entry ledger.
    - **Why it matters**: Ensures transport revenue is consolidated with logistics and commerce revenue for platform-wide financial reporting.
    - **Implementation**: Emit `transport.seat_sold` to the event bus.
    - **Reuse/Integration**: Integration with Central Mgmt repo.
    - **Priority**: High

12. **Corporate Credit Seat Holds**
    - **Description**: Allow verified corporate customers to reserve seats against their `credit_limit_kobo` balance without immediate payment.
    - **Why it matters**: Secures high-value B2B transport contracts.
    - **Implementation**: Integrate with the Fintech/Billing module to verify credit limits before confirming the hold.
    - **Reuse/Integration**: Integration with Fintech/Billing repo.
    - **Priority**: Medium

13. **Cross-Tenant Interline Booking**
    - **Description**: Allow Operator A to sell excess seat inventory on Operator B's bus, taking a commission.
    - **Why it matters**: Creates a true marketplace effect, increasing overall platform GMV.
    - **Implementation**: Complex RBAC and tenant-scoping updates to allow cross-tenant seat queries with commission splits.
    - **Reuse/Integration**: Relies heavily on `@webwaka/core/rbac`.
    - **Priority**: Low (Future Phase)

## 4. Operational Resilience

14. **Trip Recovery Seat Mapping (D-12)**
    - **Description**: When a bus breaks down, provide a 1-click tool to transfer all sold seats to a rescue vehicle, attempting to maintain original seat assignments.
    - **Why it matters**: Vehicle breakdowns are common. Manual reassignment during a breakdown causes chaos and passenger anger.
    - **Implementation**: Build a `POST /api/operator/trips/:id/rescue` endpoint that executes a bulk seat mutation.
    - **Reuse/Integration**: Build in transport repo.
    - **Priority**: High

15. **Pre-Trip Seat Audit Sweep**
    - **Description**: 30 minutes before departure, run an automated sweep that identifies any seats stuck in `reserved` state (zombie holds) and force-clears them to `available`.
    - **Why it matters**: Ensures no seats depart empty due to technical glitches or abandoned payment sessions.
    - **Implementation**: Add a specific pre-departure trigger to the existing `sweepExpiredReservations()` cron.
    - **Reuse/Integration**: Build in transport repo.
    - **Priority**: High

16. **VIP/Disabled Seat Locking**
    - **Description**: Allow supervisors to permanently lock specific seats (e.g., front row) for VIPs, disabled passengers, or armed escorts.
    - **Why it matters**: Operational necessity for security and accessibility on Nigerian highways.
    - **Implementation**: Add a `locked_reason` column to the `seats` table.
    - **Reuse/Integration**: Build in transport repo.
    - **Priority**: Medium

17. **Vehicle Swap Capacity Handling**
    - **Description**: If an operator swaps a 50-seater bus for a 15-seater bus due to low demand, automatically flag overbooked seats and trigger a refund/rebooking workflow.
    - **Why it matters**: Prevents the dangerous scenario of passengers arriving at the park with valid tickets but no physical seats.
    - **Implementation**: Hook into the `PATCH /trips/:id/vehicle` endpoint to validate capacity against `sold` seats.
    - **Reuse/Integration**: Build in transport repo.
    - **Priority**: High

18. **Multi-Leg Seat Release**
    - **Description**: For trips with intermediate stops (e.g., Lagos → Ibadan → Abuja), release the seat for resale once the passenger disembarks at Ibadan.
    - **Why it matters**: Doubles the revenue potential of a single physical seat on long routes.
    - **Implementation**: Complex routing logic requiring origin/destination stop IDs on the `seats` table.
    - **Reuse/Integration**: Build in transport repo.
    - **Priority**: Medium

19. **Agent Hold Extension (S-06)**
    - **Description**: Allow an agent to manually extend a seat hold by 5 minutes if a passenger is struggling to find cash or complete a USSD transfer at the counter.
    - **Why it matters**: Prevents the agent from losing the sale to an online booking while the passenger is physically present.
    - **Implementation**: Add a `PATCH /seats/:id/extend-hold` endpoint.
    - **Reuse/Integration**: Build in transport repo.
    - **Priority**: Low

20. **Seat Inventory Analytics Export**
    - **Description**: Generate daily reports on seat utilization (load factor), abandonment rates, and peak booking times.
    - **Why it matters**: Provides operators with the data needed to optimize schedules and vehicle sizes.
    - **Implementation**: Aggregate seat transition events and export to the analytics dashboard.
    - **Reuse/Integration**: Integration with Central Analytics service.
    - **Priority**: Medium



# Top 20 Offline Agent Sales & Bus Park POS Enhancements

The agent POS is the primary revenue channel for Nigerian intercity transport, accounting for the vast majority of daily sales. Because agents operate in environments with intermittent connectivity, offline capability and speed are paramount. The following 20 enhancements are designed to maximize throughput, prevent fraud, and integrate seamlessly with the platform's core services.

## 1. Offline Resilience & Sync

**Automated Offline Transaction Sync (A-01)**
The offline sync engine must be upgraded to handle full end-to-end transaction syncing without manual intervention. Currently, if an agent loses connection, transactions queue in the Dexie `sync_mutations` table. The enhancement requires wiring the Service Worker's background sync event (`webwaka-transport-sync`) to automatically flush this queue the moment connectivity is restored, even if the POS application is closed. This prevents the silent loss of agent sales, which is a critical operational failure. This should be built entirely within the transport repository's frontend and Service Worker layer.

**Conflict Resolution Dashboard**
When an agent operates offline and sells a seat that was concurrently sold online, the server returns a 409 Conflict. The system must quarantine this transaction and present it in a dedicated "Sync Health" dashboard for the terminal supervisor. The supervisor can then manually reassign the passenger to an empty seat or the next available trip. This ensures no cash is lost while maintaining strict inventory invariants. This is a transport-specific UI feature.

**Multi-Agent Device Session Management (A-04)**
In busy Nigerian bus parks, a single tablet is frequently shared among 2-3 agents during a shift. The POS must support fast agent switching. When Agent A logs out, the system must flush their offline queue, clear the auth state, and initialize Agent B's session from the Dexie `agent_sessions` table. This guarantees per-agent accountability and prevents commissions from being misattributed. This requires updates to the React frontend and Dexie schema.

**Offline Fare Matrix Cache**
Agents cannot wait for a server response to calculate complex fares (e.g., dynamic pricing or multi-leg journeys). The POS must cache the complete `fare_matrix` for the assigned terminal in IndexedDB at the start of each shift. This allows instant, accurate fare calculation regardless of network status.

**Idempotency Key Enforcement**
To prevent double-charging or duplicate bookings during unstable network conditions, every agent transaction must generate a UUID idempotency key before leaving the device. The server must cache these keys in the `IDEMPOTENCY_KV` namespace for 24 hours. If a sync retry sends a duplicate key, the server must return the cached success response rather than processing the transaction again. This utilizes the existing `@webwaka/core` idempotency middleware.

## 2. Fraud Prevention & Accountability

**Agent Daily Float Reconciliation (A-03)**
The primary pain point for operators is float accountability. Agents frequently under-report cash sales. The system must implement an end-of-day reconciliation workflow where agents input their physical cash count. The system compares this against the sum of confirmed cash transactions for that agent and date. Discrepancies trigger an event for supervisor review. This eliminates manual paper ledgers and provides immediate fraud detection. This is a transport-specific workflow.

**Digital-to-Thermal Receipt Printing (A-02)**
Paper receipts are required in Nigerian bus parks for boarding control, but handwritten receipts are easily forged. The POS must generate a digital receipt formatted for 58mm/80mm thermal Bluetooth printers. The receipt must include a scannable QR code containing the unique `receipt_id` and transaction details. This serves as a critical fraud deterrent and professionalism signal. The `qr_code` column already exists in the `receipts` table and must be populated using a browser-side generation library.

**Agent Performance & Commission Tracking (A-06)**
Operators manage agent commission payments manually, leading to disputes. The system must provide a supervisor dashboard displaying per-agent sales count, revenue, average fare, and calculated commission based on the `commission_rate` defined in the `agents` table. This provides real-time visibility into agent performance and automates payroll inputs.

**Supervisor Override PIN**
For sensitive operations such as voiding a cash transaction or applying a manual discount, the POS must prompt for a supervisor's PIN. This prevents agents from unilaterally altering financial records after cash has been collected. The PIN hashing and verification should utilize the `@webwaka/core/pin` primitive.

**Float Limit Lockout**
To reduce the risk of theft or loss, operators can define a maximum cash float limit per agent (e.g., ₦500,000). Once an agent's un-reconciled cash sales reach this limit, the POS automatically locks further cash transactions until the supervisor performs a mid-shift cash drop and resets the counter.

## 3. Passenger Experience & Compliance

**Passenger ID Capture at POS (A-05)**
Nigerian law enforcement (FRSC) increasingly requires bus manifests to include passenger identification. The POS form must include optional fields for National Identification Number (NIN) or passport number. To comply with the NDPA/GAID regulations, these identifiers must be SHA-256 hashed before storage and never displayed in full on the UI. This requires integration with the `@webwaka/core/kyc` module for validation if needed.

**Vernacular POS UI**
Many agents and passengers are more comfortable operating in local languages. The POS interface must fully implement the existing i18n infrastructure to support Yoruba, Igbo, and Hausa. This reduces transaction time by eliminating translation friction at the counter.

**WhatsApp Digital Receipts**
In addition to the thermal printout, the POS should offer to send a digital copy of the receipt to the passenger's WhatsApp number. This saves thermal paper costs and provides the passenger with a durable record. This requires publishing a `payment.completed` event to the platform event bus, which is consumed by the `@webwaka/core/notifications` service.

**Group Booking Workflow (A-17)**
Agents frequently process bookings for large groups (churches, schools, corporate retreats). The POS must include a streamlined group booking mode that allows the agent to reserve an entire vehicle or a large block of seats with a single passenger manifest upload and a consolidated payment flow.

**NDPR Consent Checkbox**
To comply with the Nigeria Data Protection Act (NDPA) and the new GAID directive, the agent POS must explicitly ask for and record the passenger's consent to store their PII (phone number, name). This consent must be logged in the Dexie `ndpr_consent` table and synced to the server.

## 4. Integration & Ecosystem

**Mobile Money Push Integration**
Cash is dominant, but mobile money is growing rapidly. The POS must integrate directly with Tier-1 mobile wallets (Moniepoint, OPay, PalmPay). The agent enters the passenger's phone number, and the system pushes a payment request to the passenger's mobile app. This reduces cash handling and bypasses slow USSD networks. This requires integration with the Fintech/Payments repository.

**Agency Banking Cash Deposits**
Given the volume of cash at bus parks, operators can generate ancillary revenue by allowing agents to act as mobile money agents. The POS could support a workflow where a passenger hands cash to the agent, and the agent initiates a transfer to the passenger's bank account. This requires deep integration with the Fintech repository's agency banking APIs and is a significant revenue opportunity.

**Logistics Waybill Generation at POS (D-14)**
Agents frequently accept parcels for shipment on departing buses. The POS must include a "Logistics" tab where agents can record sender/recipient details, weight, and declared value, and collect the fee. The system generates a digital waybill and publishes a `parcel.waybill_created` event. The Logistics repository consumes this event to manage the parcel lifecycle. The Transport repo must NOT rebuild logistics tracking; it merely acts as the point of sale.

**Central Ledger Revenue Sync**
Every completed agent sale must be recorded in the platform's central double-entry ledger. The transport service publishes a `transaction.created` event containing the revenue breakdown (base fare, taxes, commission). The Central Management repository consumes this to maintain accurate, platform-wide financial records.

**Operator-to-Agent Broadcasts**
Operators need a reliable way to communicate urgent updates (e.g., "Road closure on Lagos-Ibadan expressway") to all agents simultaneously. The POS must include a notification center that polls or receives WebPush alerts from the `agent_broadcasts` table. This utilizes the `@webwaka/core/notifications` infrastructure.



# Top 20 Customer Booking Portal Enhancements

The customer booking portal is the primary digital touchpoint for passengers. In Nigeria, trust deficit and payment friction are the two largest barriers to online booking conversion. The following 20 enhancements focus on building trust, smoothing the payment experience, and expanding digital channels beyond the traditional web app.

## 1. Conversion & Payment Friction

**Paystack Inline Payment (B-01)**
The current payment flow redirects the user to a Paystack or Flutterwave hosted page. This context switch causes significant drop-off, especially on slow 3G networks where the redirect may timeout. The portal must implement the Paystack Inline JS or Flutterwave Modal to keep the user within the PWA context. This is a frontend change that directly impacts the bottom line.

**Guest Booking Flow (B-04)**
Forcing users to create an account before seeing the payment screen is a known conversion killer. The portal must support a frictionless guest checkout where only a phone number and name are required. The system can silently create a shadow `customers` record and associate the booking. If the user later registers with that phone number, the history is merged.

**Dynamic Fare Estimator**
Before the user enters the full booking flow, they should see a dynamic fare estimator on the search results page. This must calculate the base fare, any applicable dynamic pricing modifiers (B-18), and mandatory taxes (VAT) using the `@webwaka/core/tax` primitive. Transparency reduces cart abandonment.

**Installment Booking (BNPL Integration)**
For high-value interstate trips (e.g., Lagos to Kano) or group bookings, the portal should offer a "Buy Now, Pay Later" option at checkout. This requires integration with the Fintech repository's credit scoring module to offer instant installment plans based on the user's phone number and BVN.

**Corporate Travel Portal (B-13)**
The `customers` table already supports `customer_type` (individual/corporate) and `credit_limit_kobo`. The portal must expose a dedicated B2B view where corporate admins can book trips for employees against a pre-approved credit line. This requires integration with the Central Management repository for invoicing and the KYC module for corporate verification.

## 2. Trust & Communication

**SMS & WhatsApp Booking Confirmation (B-02, B-15)**
An email confirmation is insufficient in Nigeria; many users rarely check their inbox. The system must wire the `booking.created` event to the `@webwaka/core/notifications` service to immediately dispatch a WhatsApp message or SMS containing the booking reference, departure time, and a link to the e-ticket. This is the primary trust artifact for online buyers.

**E-Ticket with Scannable QR (B-03)**
The portal must generate a downloadable PDF or image e-ticket. This ticket must feature a scannable QR code that the driver or agent can read using the POS app at boarding (D-03). The ticket serves as the passenger's proof of purchase and must be accessible offline once downloaded.

**Transparent Refund Policy Display (B-06)**
Trust is built on clarity. The `routes` table contains a `cancellation_policy` column. The booking portal must prominently display this policy (e.g., "100% refund if cancelled 24h before, 50% within 12h") during checkout. The portal must also provide a self-service `PATCH /bookings/:id/cancel` endpoint that automatically processes the refund via the payment gateway or issues store credit.

**Verified Operator Reviews (B-10)**
The `operator_reviews` table exists but is underutilized. The portal should display aggregated ratings (e.g., "4.5/5 for Punctuality") on the search results page. To maintain integrity, reviews can only be submitted by passengers who have a `completed` trip state, ensuring all feedback is verified.

**Automated Booking Reminders (B-09)**
To reduce no-shows and departure delays, the system should schedule an automated WhatsApp or SMS reminder 12 hours and 2 hours before the `departure_time`. This utilizes the event bus and the `@webwaka/core/notifications` module.

## 3. Channel Expansion

**USSD Booking Channel (B-16)**
While smartphone penetration is growing, millions of Nigerians still rely on feature phones. The platform must expose a USSD menu (e.g., *123*4#) that interacts with the `booking-portal.ts` API. Users can search routes, select a date, and pay via their mobile money wallet, entirely over USSD.

**WhatsApp Conversational Booking Bot**
Leverage the `@webwaka/core/ai` module to build a conversational booking flow on WhatsApp. A user can message "I need a bus from Lagos to Abuja tomorrow morning." The AI parses the intent, queries the `GET /trips/search` endpoint, presents options, and generates a Paystack payment link within the chat.

**White-Label Operator Portals (O-14)**
Enterprise operators (e.g., GIGM, GUO) will not direct their customers to a generic WebWaka aggregator. The portal must support white-labeling, reading the `TENANT_CONFIG_KV` namespace to dynamically load the operator's logo, color scheme, and custom domain, while utilizing the shared backend infrastructure.

**Full i18n Vernacular Support (B-07)**
The `src/core/i18n/index.ts` module supports Yoruba, Igbo, and Hausa. The booking portal UI must expose a language toggle. Providing a booking experience in a user's native language significantly lowers the cognitive barrier to online transactions.

**Logistics Parcel Tracking Portal**
Passengers often ship parcels on the same buses they travel on. The booking portal should include a "Track Parcel" tab. When a user enters a waybill number, the portal queries the Logistics repository via an API gateway or reads a replicated read-model to display the parcel's status. The Transport repo does not manage the parcel; it merely displays the logistics data.

## 4. Personalization & Ancillary Revenue

**AI-Powered Trip Search**
The existing `AIEngine.chat()` integration should be enhanced to support natural language queries with fuzzy matching (e.g., "cheap bus to eastern Nigeria next weekend"). The AI maps this to specific `routes` and `departure_time` queries, providing a superior search experience.

**Seat Selection & Class Upsell**
If the operator has defined `seat_template` (O-03) and seat classes (S-04), the booking portal must render an interactive seat map. Users can select their preferred seat and pay the associated premium (e.g., VIP Front Row). This directly increases the Average Order Value (AOV).

**Travel Insurance Add-on**
The `bookings` table already includes `insurance_selected` and `insurance_premium_kobo` columns. The checkout flow must offer an opt-in travel insurance product (e.g., ₦500 for medical/baggage cover). This requires integration with a third-party insurtech API or the Central Management repository for premium reconciliation.

**Loyalty Points & Wallet Integration**
Frequent travelers should earn points for every booking. The portal should display a "Wallet Balance" tied to the customer's profile. Points can be redeemed for discounts on future trips. This requires a dedicated loyalty ledger, likely managed within the Central Management or Fintech repository.

**Post-Trip Cross-Sell**
When a trip reaches the `completed` state, the system should trigger a post-trip email or WhatsApp message asking for a review (B-10) and offering a discount code for their next booking or a related service (e.g., a hotel booking partner). This drives retention and repeat purchases.



# Top 20 Dispatch & Trip Operations Enhancements

Dispatch and trip operations represent the physical execution of the transport service. In Nigeria, this phase is fraught with regulatory compliance checks, driver accountability issues, and unpredictable road conditions. The following 20 enhancements focus on digitizing the departure sequence, tracking the journey, and integrating with the logistics repository for parcel management.

## 1. Departure Control & Compliance

**Digital Passenger Manifest Export (D-02)**
Nigerian law enforcement (FRSC) and state governments (e.g., Lagos State Ministry of Transportation) mandate accurate passenger manifests for all intercity trips [1][2]. The transport repository must implement a `GET /api/operator/trips/:id/manifest` endpoint that generates a compliant PDF or digital view. This manifest must aggregate data from both the `bookings` (online) and `sales_transactions` (offline) tables, including passenger names, seat numbers, and optional hashed ID numbers (A-05). This is a critical regulatory requirement.

**Digital Boarding Scan (D-03)**
To prevent ticket fraud and ghost passengers, the boarding process must be digitized. The agent or driver must use the POS app to scan the QR code on the passenger's e-ticket (B-03) or thermal receipt (A-02). This triggers a `PATCH /api/operator/trips/:id/board` request, updating the `boarded_at` and `boarded_by` columns in the `bookings` table. This closes the loop between sales and physical occupancy.

**Pre-Trip Vehicle Inspection (D-05)**
Before a trip can transition from `scheduled` to `boarding`, the driver or terminal manager must complete a digital pre-trip inspection checklist (tires, brakes, lights, documents). The `trips` table already contains an `inspection_completed_at` column. Implementing this workflow reduces the risk of breakdowns and satisfies FRSC roadworthiness expectations.

**Digital Parcel Waybill Recording (D-14)**
Intercity buses routinely carry parcels, representing 10-20% of trip revenue [3]. The transport repository must provide a `POST /api/operator/trips/:id/waybills` endpoint for dispatchers to record parcels loaded onto the bus. This endpoint does not manage the parcel lifecycle; it simply publishes a `parcel.waybill_created` event to the platform event bus. The Logistics repository consumes this event to handle tracking and fulfillment. This is a critical cross-repo integration point.

**Automated Dispatch Clearance**
A trip should only be cleared for departure (transitioning to `in_transit`) if all pre-conditions are met: the manifest is generated, the pre-trip inspection is complete, and the driver's documents (O-04) are valid. The `TripStateMachine` must enforce these invariants before allowing the state transition.

## 2. In-Transit Tracking & Safety

**Driver Mobile App (D-01)**
Drivers require a dedicated, simplified interface to manage their trips. This app (or PWA view) should package the manifest, boarding scan, pre-trip inspection, and GPS tracking features into a single, high-contrast, low-distraction UI.

**Real-Time GPS Location Tracking (D-04)**
The `trips` table contains `current_latitude`, `current_longitude`, and `location_updated_at` columns, but lacks an update mechanism. The Driver App must implement a background geolocation service that periodically sends `PATCH /api/operator/trips/:id/location` requests. This data feeds the dispatcher dashboard and customer tracking portals.

**SOS Trigger & Escalation (D-08)**
Safety on Nigerian highways is a major concern. The Driver App must feature a prominent SOS button. Triggering this calls a new endpoint that updates the `sos_triggered_at` and `sos_triggered_by` columns in the `trips` table and immediately publishes an `emergency.sos_triggered` event. The `@webwaka/core/notifications` service consumes this to alert the operator's security team and potentially relevant authorities.

**Route Deviation Alerts (D-10)**
Using the real-time GPS data (D-04) and the defined `routes` coordinates, the system should calculate the bus's cross-track error. If the bus deviates significantly from the approved route (a common indicator of unauthorized stops or security incidents), the system automatically triggers a deviation alert to the dispatcher dashboard.

**Automated Delay Reporting (D-06)**
The `trips` table includes `delay_reason_code`, `delay_reported_at`, and `estimated_departure_ms`. The Driver App should allow drivers to quickly log delays (e.g., traffic, checkpoint, mechanical issue). This data updates the trip's estimated arrival time and can automatically trigger SMS notifications to waiting passengers via the event bus.

## 3. Dispatcher Operations & Fleet Control

**Fleet Dispatch Dashboard (D-07)**
Terminal dispatchers need a "control tower" view of all active trips. This dashboard aggregates the state of all trips (`scheduled`, `boarding`, `in_transit`), displaying real-time GPS locations, current delays, SOS status, and load factors. This provides unprecedented operational visibility for mid-sized operators.

**Trip Recovery Workflow (D-12)**
Vehicle breakdowns are inevitable. The system must provide a workflow for dispatchers to handle a "dead bus." This involves creating a rescue trip, transferring the passenger manifest and parcel waybills to the new vehicle, and notifying passengers of the delay. The seat inventory manager must support bulk seat reassignment.

**Driver & Vehicle Assignment**
The `trips` table links to `vehicles` and `drivers`. The dispatcher UI must facilitate easy assignment and reassignment of these resources, ensuring that a driver is not assigned to two concurrent trips and that a vehicle is not double-booked.

**Terminal Capacity Management (O-01)**
For operators with multiple terminals, dispatchers need visibility into terminal congestion. The system should track the number of scheduled departures and arrivals per terminal to optimize bay allocation and reduce turnaround times.

**Fuel Issuance Tracking**
Fuel is a major operational expense. Dispatchers often issue fuel vouchers or cash for fuel before departure. The system should include a simple ledger to record fuel issuance per trip, allowing operators to calculate the true profitability of each journey.

## 4. Cross-Repo Integration & Post-Trip

**Logistics Handoff at Destination**
When a trip transitions to `completed`, the transport system publishes a `trip.completed` event. The Logistics repository consumes this event to update the status of all parcels associated with that trip (e.g., from "In Transit" to "Ready for Pickup at Destination Terminal"). This seamless handoff eliminates manual data entry.

**Post-Trip Driver Settlement**
Drivers often receive trip allowances or bonuses upon successful completion. The system can trigger a workflow in the Central Management or Fintech repository to disburse these funds to the driver's mobile wallet once the trip state is `completed` and the final GPS location matches the destination terminal.

**Automated Maintenance Ticketing (O-02)**
If a driver reports a mechanical issue during the trip (via the delay reporting feature) or fails a specific check on the pre-trip inspection, the system should automatically generate a maintenance ticket in the operator's fleet management module, flagging the vehicle for repair before its next scheduled trip.

**Passenger Review Prompt (B-10)**
The transition to `completed` state should trigger the `@webwaka/core/notifications` service to send an SMS or WhatsApp message to all boarded passengers, requesting a review of the driver and vehicle. This data feeds back into the `operator_reviews` table.

**Trip Profitability Analytics**
Post-trip, the system aggregates total ticket revenue, parcel revenue (queried from Logistics), and fuel/allowance expenses to calculate the net profitability of the trip. This data is exported to the Central Analytics dashboard, empowering operators to optimize their route planning.

---

### References
[1] Punch Newspapers. "Lagos modernises interstate travel with digital passenger manifests, park accreditation." November 2024.
[2] This Day Live. "FRSC's New Roadworthiness Inspections." September 2025.
[3] Mordor Intelligence. "Nigeria Courier, Express, and Parcel (CEP) Market Report." January 2026.



# Top 20 Operator, Fleet & Route Management Enhancements

The operator management module is the administrative backbone of the transport repository. It enables mid-sized transport companies to configure their fleets, define routes, and analyze revenue. The following 20 enhancements focus on automation, compliance, and B2B integration.

## 1. Route & Schedule Automation

**Automated Schedule Generation (D-16)**
Operators spend hours manually creating individual trips. The `schedules` table exists but lacks an execution engine. The system must implement a cron job that reads active schedules (e.g., "Lagos to Abuja, daily at 07:00 AM") and automatically generates the corresponding `trips` and `seats` records 30 days in advance (defined by `horizon_days`). This is a massive time-saver and ensures inventory is always available for advance booking.

**Dynamic Fare Matrix Engine (O-08)**
The `routes` table contains a `fare_matrix` JSON column. The system must provide a UI for operators to define complex pricing rules based on seasonality (e.g., Christmas surge), day of the week, and booking lead time. This engine intercepts the base fare and applies the modifiers before the booking portal displays the price.

**Multi-Leg Route Stop Configuration (O-06)**
The `route_stops` table exists to support intermediate drop-offs (e.g., Lagos → Ibadan → Akure). The management UI must allow operators to define the sequence, distance, and partial fare for each stop. This is a prerequisite for Multi-Leg Seat Release, enabling a single physical seat to be sold twice on the same journey.

**Bulk Import Wizard (O-18)**
Migrating a mid-sized operator with 50 buses, 60 drivers, and 20 routes is a major onboarding barrier. The existing `/import/routes`, `/import/vehicles`, and `/import/drivers` endpoints must be wired to a user-friendly CSV upload wizard in the admin portal. This drastically reduces time-to-first-trip for new tenants.

**Operator Onboarding Wizard (O-09)**
A step-by-step setup guide for new operators that enforces the configuration of essential settings (branding, payment gateways, base routes, and initial fleet) before their portal goes live. This utilizes the `TENANT_CONFIG_KV` store to track onboarding progress.

## 2. Fleet & Driver Compliance

**Vehicle Maintenance Scheduling (O-02)**
The `vehicles` table includes a `maintenance_status` column. The system must provide a maintenance log where operators can schedule routine servicing (e.g., oil changes every 10,000 km). When a vehicle is marked as "In Maintenance," the automated schedule generator must exclude it from trip assignments, preventing operational failures.

**Driver Document Expiry Tracking (O-04)**
FRSC compliance requires valid driver's licenses and certifications. The `drivers` table must be enhanced to store document expiry dates. The system must run a daily cron job that publishes a `driver.document_expiring` event 30 days before expiration. The `@webwaka/core/notifications` module alerts the operator's HR team.

**Vehicle Seat Templates (O-03)**
Buses come in various configurations (e.g., 14-seater Hiace, 50-seater Marcopolo). The `vehicles` table has a `seat_template` column. The management UI must include a visual drag-and-drop seat map builder. When a trip is generated, it clones this template to populate the `seats` table, ensuring the booking portal accurately reflects the physical vehicle layout.

**Terminal Registry & Assignment (O-01)**
The `terminals` table must be fully exposed in the UI. Operators need to assign agents, vehicles, and specific routes to physical terminals. This enables terminal-specific reporting and allows dispatchers to filter their dashboard to only see trips originating from their location.

**Fleet Telemetry Dashboard**
A unified view for the fleet manager showing the real-time status of all vehicles: In Transit, Available, In Maintenance, or Out of Service. This aggregates data from the `trips` and `vehicles` tables to maximize fleet utilization.

## 3. Financial & B2B Integration

**Revenue per Route Analytics (O-05)**
Operators lack visibility into route profitability. The system must provide a BI dashboard that aggregates `sales_transactions` and `bookings` data to calculate Revenue per Available Seat Kilometer (RASK) and load factors for each route. This requires querying the D1 database with tenant scoping applied.

**Operator API Keys (O-12)**
Large operators often want to integrate their transport inventory with third-party aggregators (e.g., Treepz, BuuPass) or their own legacy ERP systems. The system must expose the `/api-keys` endpoints to allow operators to generate scoped API tokens for secure B2B integration.

**Subscription Tier Gating (O-15)**
The `operators` table includes a `subscription_tier` column (basic/pro/enterprise). The backend currently uses a `requireTierFeature` middleware. This must be fully mapped so that premium features (like the API keys, white-label portal, and advanced analytics) are strictly gated, driving SaaS revenue for WebWaka.

**Corporate Travel Account Management**
Operators need an interface to approve and manage corporate clients. This involves setting the `credit_limit_kobo` in the `customers` table and reviewing monthly invoices. This feature bridges the Transport repository and the Central Management repository's billing engine.

**Agent Commission Settlement Export**
At the end of a pay period, operators need to export the aggregated agent commissions (calculated from A-06) into a format suitable for their payroll system. The system should provide a CSV export or directly integrate with the Fintech repository to initiate bulk transfers to the agents' mobile wallets.

## 4. Platform Administration & Security

**SUPER_ADMIN Analytics (O-20)**
WebWaka platform administrators need a macro view of the entire transport ecosystem. This dashboard must aggregate GMV, total trips, active operators, and system error rates across all tenants. This is critical for platform health monitoring and investor reporting.

**White-Label Branding Config (O-14)**
The `/config/logo` and `/config/branding` endpoints currently write to the `ASSETS_R2` bucket and `TENANT_CONFIG_KV`. The admin UI must expose a comprehensive branding editor allowing Enterprise-tier operators to customize their booking portal's primary colors, fonts, and custom domain routing.

**Role-Based Access Control (RBAC) UI**
Operators must be able to invite staff and assign specific roles (`TENANT_ADMIN`, `SUPERVISOR`, `DISPATCHER`, `AGENT`). The `@webwaka/core/rbac` primitive handles the enforcement, but the transport repo needs the user management UI to assign these roles to the operator's `tenant_id`.

**Audit Log Viewer**
For dispute resolution and security, operators need an audit trail of sensitive actions (e.g., voiding a ticket, changing a fare, overriding a float reconciliation). The system should query the platform event bus for `audit.*` events related to the tenant and display them in a chronological log.

**System Configuration & Sweeper Status**
A developer-focused dashboard within the SUPER_ADMIN view that displays the health of the Cloudflare infrastructure: Durable Object connection counts, offline sync queue depths, and the execution status of the critical scheduled sweepers (`drainEventBus`, `sweepExpiredReservations`).



# Cross-Repo Integration Map & Execution Order

The WebWaka Transport repository is a single vertical module within a multi-repo platform. To adhere to the "Build Once, Use Everywhere" principle, it must integrate deeply with shared services rather than reinventing them. This document maps the boundaries between Transport and other repositories and provides a phased execution roadmap for the 100 enhancements identified.

## 1. Cross-Repo Integration Map

### 1.1 What Should Be Built in the Transport Repo
The transport repository is the canonical owner of the physical movement of people and the associated fleet management. The following domains must be built and maintained exclusively within `webwaka-transport`:

- **Seat Inventory Management**: Atomic reservations, optimistic locking, and real-time Durable Object fan-out (`TripSeatDO`).
- **Agent POS & Offline Sync**: The IndexedDB (Dexie) mutation queue, background sync engine, and conflict resolution logic.
- **Trip State Machine**: The lifecycle of a trip (`scheduled` → `boarding` → `in_transit` → `completed` | `cancelled`).
- **Operator & Fleet Management**: Configuration of routes, stops, vehicles, drivers, and terminals.
- **Passenger Booking Logic**: The specific rules for booking a bus seat, generating an e-ticket (QR code), and managing transport-specific refunds.
- **Dispatch Operations**: Digital boarding scans, pre-trip inspections, and manifest generation (FRSC/Lagos State compliance).

### 1.2 What Should Be Integrated from the Logistics Repo
The Logistics repository (`webwaka-logistics`) is the canonical owner of parcel movement. Transport buses carry parcels, but Transport does not manage them.

- **DO NOT BUILD**: Parcel tracking, warehouse management, delivery routing, courier dispatch, or waybill pricing logic.
- **INTEGRATION POINT**: Transport builds a thin `POST /api/operator/trips/:id/waybills` endpoint. When a dispatcher records a parcel, Transport publishes a `parcel.waybill_created` event to the platform event bus. Logistics consumes this event and manages the parcel lifecycle.
- **INTEGRATION POINT**: When Logistics confirms a large shipment, it publishes a `parcel.seats_required` event. Transport consumes this event to automatically block cargo space (seats) on the specified trip.

### 1.3 What Should Be Exposed via Shared Platform Services (`@webwaka/core`)
The `@webwaka/core` package provides the primitives that all repositories share. The following capabilities currently duplicated or hardcoded in Transport must be delegated to Core:

- **Identity & Auth**: JWT verification, RBAC middleware (`requireRole`), and OTP generation must use the Core implementations.
- **Event Bus Outbox**: All domain events must be published using the Core `publishEvent(db, event)` primitive.
- **Notifications**: SMS (Termii) and Push (VAPID) dispatch must be routed through the Core notifications service, not hardcoded in `src/lib/sms.ts`.
- **AI Abstraction**: Natural language trip search must use the Core `AIEngine.chat()` OpenRouter abstraction.
- **Payment Orchestration**: Paystack/Flutterwave initiation and verification should be standardized via the Core payment module.
- **Tax Calculation**: FIRS compliance (VAT/WHT) must use the Core tax engine.
- **NDPR Consent**: The consent audit trail should ideally be centralized in a shared data protection service, rather than isolated in the Transport Dexie DB.
- **ID Generation**: Replace `genId()` in Transport with `nanoid()` from Core.
- **Query Helpers**: Move `parsePagination()` and `applyTenantScope()` to Core for reuse by Commerce and Logistics.

### 1.4 What Should Never Be Duplicated
- **Financial Ledger**: The Central Management repository maintains the platform's double-entry ledger. Transport must publish `booking.created` and `transaction.created` events to update the ledger; it must not build a secondary accounting system.
- **Corporate Credit**: The Fintech repository manages B2B credit scoring and limits. Transport must query Fintech to authorize a corporate booking; it must not build its own credit engine.

---

## 2. Recommended Execution Order

To manage the complexity of implementing 100 enhancements across five use cases while respecting cross-repo dependencies, we propose a 4-phase execution roadmap.

### Phase 1: Core Reliability & Offline Resilience (Weeks 1-3)
*Focus: Fixing the foundation. Ensure no agent sales are lost and seat reservations are bulletproof.*

1. **Automated Offline Transaction Sync (A-01)**: Wire the Service Worker background sync to flush the Dexie queue automatically.
2. **Multi-Seat Atomic Reservation Engine (S-01)**: Implement optimistic locking for concurrent bookings.
3. **Idempotency Key Enforcement**: Prevent double-charging during unstable network conditions.
4. **Multi-Agent Device Session Management (A-04)**: Enable fast agent switching on shared POS tablets.
5. **Configurable Reservation TTL (S-02)**: Extend hold times for online Paystack payments.

### Phase 2: Compliance & Dispatch Operations (Weeks 4-6)
*Focus: Meeting regulatory requirements (FRSC, Lagos State) and digitizing the departure sequence.*

1. **Digital Passenger Manifest Export (D-02)**: Generate compliant PDFs from bookings and offline sales.
2. **Passenger ID Capture at POS (A-05)**: Collect and hash NIN/Passport numbers for the manifest.
3. **Digital-to-Thermal Receipt Printing (A-02)**: Generate QR-coded receipts at the bus park.
4. **Digital Boarding Scan (D-03)**: Scan QR receipts/e-tickets to mark passengers as boarded.
5. **Pre-Trip Vehicle Inspection (D-05)**: Mandate safety checklists before departure.
6. **Agent Daily Float Reconciliation (A-03)**: Implement the end-of-day cash reconciliation workflow.

### Phase 3: Revenue & Yield Optimization (Weeks 7-9)
*Focus: Increasing AOV, expanding channels, and automating operator workflows.*

1. **Dynamic Seat Class Segmentation (S-04)**: Introduce VIP pricing and seat templates (O-03).
2. **Automated Schedule Generation (D-16)**: Auto-create trips 30 days in advance from recurring schedules.
3. **Dynamic Fare Matrix Engine (O-08)**: Implement surge pricing and multi-leg fares (O-06).
4. **Paystack Inline Payment (B-01)**: Remove redirect friction from the booking portal.
5. **WhatsApp & SMS Booking Confirmation (B-02)**: Wire notifications for trust building.
6. **Durable Object Real-Time Seat Fan-out (S-03)**: Enable live WebSocket seat map updates.

### Phase 4: Platform Ecosystem Integration (Weeks 10-12)
*Focus: Connecting Transport to Logistics, Fintech, and Central Management.*

1. **Digital Parcel Waybill Recording (D-14)**: Build the Logistics handoff endpoint and event publisher.
2. **Logistics Parcel Seat Blocking (S-17)**: Consume events to block cargo space automatically.
3. **Central Ledger Revenue Sync**: Publish financial events for every completed sale.
4. **Corporate Travel Portal (B-13)**: Integrate with Fintech for B2B credit booking.
5. **Real-Time GPS Location Tracking (D-04)**: Build the driver app geolocation updater and dispatcher dashboard (D-07).
6. **SOS Trigger & Escalation (D-08)**: Implement emergency alerts for highway safety.
