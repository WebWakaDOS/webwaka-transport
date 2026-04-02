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
