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
