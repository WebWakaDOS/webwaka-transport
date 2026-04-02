# PHASE 5 PROMPTS — Transport Domain

This file contains all copy-paste implementation and QA prompts for Phase 5 (Transport Suite).

**Tasks in this phase:** T-TRN-01, T-TRN-02, T-TRN-03, T-TRN-04, T-TRN-05

**Execution target:** Replit (`webwaka-transport`)

---


---

## TASK T-TRN-01 — Implement Multi-Seat Atomic Reservation Engine

### PROMPT 1 — IMPLEMENTATION
```markdown
You are a Replit execution agent responsible for implementing a new feature in the `webwaka-transport` repository.

**Task ID:** T-TRN-01
**Task Title:** Implement Multi-Seat Atomic Reservation Engine

**Context & Objective:**
High-traffic bus routes sell out fast. Multiple agents and online customers trying to book the same seat simultaneously will cause double-booking without atomic, serialized reservation holds. We must rebuild the core seat reservation engine to use Cloudflare Durable Objects for optimistic locking and concurrent booking conflict resolution.

**WebWaka Invariants to Honor:**
1. **Cloudflare-First Deployment:** You MUST use Durable Objects for the in-memory serialization lock. Do not rely on D1 transactions for this, as D1 is eventually consistent globally.
2. **Multi-Tenant Tenant-as-Code:** Enforce strict `tenant_id` isolation within the DO state.

**Execution Steps:**
1. Read the `webwaka_transport_research_report.md` (Enhancement S-01) for context.
2. Inspect the current Drizzle schema and reservation logic in `webwaka-transport`.
3. Update the schema for `seat_holds` if necessary.
4. Implement the `TripSeatDO` Durable Object to handle atomic seat reservation requests.
5. Update the booking API endpoints to route reservation requests through the DO before writing to D1.
6. Write tests covering concurrent booking attempts for the same seat on the same trip.
7. Report completion, summarizing the files changed and confirming adherence to the invariants.
```

### PROMPT 2 — QA / TEST / BUG-FIX
```markdown
You are a Replit QA and Bug-Fix agent responsible for verifying the implementation of Task T-TRN-01 (Implement Multi-Seat Atomic Reservation Engine) in the `webwaka-transport` repository.

**Verification Steps:**
1. Review the intended scope: A Durable Object must serialize concurrent booking requests, granting a hold to the first request and rejecting subsequent requests for the same seat.
2. Inspect the actual codebase changes.
3. **Audit Cloudflare Architecture:** Verify that a Durable Object is actually used for the locking mechanism, rather than relying on D1 transactions.
4. **Audit Concurrency Handling:** Verify that the DO correctly handles race conditions and prevents double-booking.
5. If any omissions, bugs, or invariant violations are found, **FIX THE CODE DIRECTLY**. Do not merely report the issue.
6. Re-test after applying fixes.
7. Provide a final certification report.
```

---

## TASK T-TRN-02 — Implement Digital Passenger Manifest Export

### PROMPT 1 — IMPLEMENTATION
```markdown
You are a Replit execution agent responsible for implementing a new feature in the `webwaka-transport` repository.

**Task ID:** T-TRN-02
**Task Title:** Implement Digital Passenger Manifest Export

**Context & Objective:**
Lagos State and FRSC mandate digital manifests for all interstate travel. Non-compliance results in heavy fines. We must generate a fully compliant PDF passenger manifest including names, next of kin, and hashed NINs, ready for printing or digital submission.

**WebWaka Invariants to Honor:**
1. **Nigeria-First, Africa-Ready:** Ensure PII (like full NINs) is partially masked on the printed copy to comply with NDPR.
2. **Build Once Use Infinitely:** The PDF generation utility should be built modularly so it can be moved to Core later for invoice generation.

**Execution Steps:**
1. Read the `webwaka_transport_research_report.md` (Enhancement D-02) for context.
2. Inspect the current passenger data model and dispatcher UI.
3. Implement a modular PDF generation utility (using `pdfmake` or similar).
4. Build an Admin/Dispatcher UI button to "Generate Manifest" for a specific trip.
5. Build an API endpoint to generate and serve the PDF, ensuring it includes all boarded passengers (excluding canceled/no-show tickets) and a signature line for the driver.
6. Ensure the generated PDF partially masks sensitive PII.
7. Write tests covering the PDF generation endpoint.
8. Report completion, summarizing the files changed and confirming adherence to the invariants.
```

### PROMPT 2 — QA / TEST / BUG-FIX
```markdown
You are a Replit QA and Bug-Fix agent responsible for verifying the implementation of Task T-TRN-02 (Implement Digital Passenger Manifest Export) in the `webwaka-transport` repository.

**Verification Steps:**
1. Review the intended scope: A modular PDF generator, an API endpoint to serve the manifest, and a Dispatcher UI button. The manifest must mask PII and exclude canceled tickets.
2. Inspect the actual codebase changes.
3. **Audit Compliance:** Verify that the generated PDF masks sensitive PII (like NINs) in accordance with NDPR.
4. **Audit Modularity:** Verify that the PDF generation utility is built modularly, not tightly coupled to the transport manifest logic.
5. If any omissions, bugs, or invariant violations are found, **FIX THE CODE DIRECTLY**. Do not merely report the issue.
6. Re-test after applying fixes.
7. Provide a final certification report.
```

---

## TASK T-TRN-03 — Implement Dynamic Fare Matrix Engine

### PROMPT 1 — IMPLEMENTATION
```markdown
You are a Replit execution agent responsible for implementing a new feature in the `webwaka-transport` repository.

**Task ID:** T-TRN-03
**Task Title:** Implement Dynamic Fare Matrix Engine

**Context & Objective:**
Transport operators maximize yield by adjusting prices based on demand and seasonality. A static `price` column is insufficient. We must build a pricing engine supporting base fares, seasonal surge multipliers, weekend pricing, and multi-leg fare calculations.

**WebWaka Invariants to Honor:**
1. **Multi-Tenant Tenant-as-Code:** Enforce strict `tenant_id` isolation for all pricing rules.
2. **Thoroughness Over Speed:** The calculated price must be locked in the `seat_holds` table to prevent the price changing between reservation and payment.

**Execution Steps:**
1. Read the `webwaka_transport_research_report.md` (Enhancement O-08) for context.
2. Update the Drizzle schema to add `fare_rules` and `route_segments` tables.
3. Build the Admin UI to configure surge periods and multipliers.
4. Update the Booking API to calculate the final price dynamically based on the active rules.
5. Ensure the calculated price is locked when a `seat_hold` is created.
6. Write tests covering various pricing scenarios (surge, weekend, multi-leg).
7. Report completion, summarizing the files changed and confirming adherence to the invariants.
```

### PROMPT 2 — QA / TEST / BUG-FIX
```markdown
You are a Replit QA and Bug-Fix agent responsible for verifying the implementation of Task T-TRN-03 (Implement Dynamic Fare Matrix Engine) in the `webwaka-transport` repository.

**Verification Steps:**
1. Review the intended scope: Schema updates, Admin UI for surge rules, dynamic price calculation in the Booking API, and price locking during reservation.
2. Inspect the actual codebase changes.
3. **Audit Price Locking:** Verify that the dynamically calculated price is saved to the `seat_holds` table and used for final payment, rather than recalculated at checkout time.
4. **Audit Tenancy:** Verify strict `tenant_id` isolation on all new tables and pricing queries.
5. If any omissions, bugs, or invariant violations are found, **FIX THE CODE DIRECTLY**. Do not merely report the issue.
6. Re-test after applying fixes.
7. Provide a final certification report.
```

---

## TASK T-TRN-04 — Implement Paystack Inline Payment Integration

### PROMPT 1 — IMPLEMENTATION
```markdown
You are a Replit execution agent responsible for implementing a new feature in the `webwaka-transport` repository.

**Task ID:** T-TRN-04
**Task Title:** Implement Paystack Inline Payment Integration

**Context & Objective:**
Redirecting to external payment pages causes massive drop-off on slow Nigerian mobile networks. We must integrate the Paystack Inline popup directly into the PWA checkout flow to keep the user in the app.

**WebWaka Invariants to Honor:**
1. **Build Once Use Infinitely:** You MUST use the `@webwaka/core` payment abstraction for webhook verification and payload formatting.
2. **Event-Driven Architecture:** You must publish `payment.successful` to the Event Bus for the Central Ledger.

**Execution Steps:**
1. Read the `webwaka_transport_research_report.md` (Enhancement B-01) for context.
2. Build a React component for the checkout UI that loads the Paystack script and opens the inline modal.
3. Implement a backend webhook handler to verify the payment using the Core payment provider.
4. Upon successful verification, convert the `seat_hold` to a confirmed `ticket` and emit the `payment.successful` event.
5. Write tests covering the webhook verification and event emission.
6. Report completion, summarizing the files changed and confirming adherence to the invariants.
```

### PROMPT 2 — QA / TEST / BUG-FIX
```markdown
You are a Replit QA and Bug-Fix agent responsible for verifying the implementation of Task T-TRN-04 (Implement Paystack Inline Payment Integration) in the `webwaka-transport` repository.

**Verification Steps:**
1. Review the intended scope: Frontend React component for Paystack Inline, backend webhook handler using Core abstraction, conversion of hold to ticket, and event emission.
2. Inspect the actual codebase changes.
3. **Audit Security:** Verify that the backend actually verifies the payment via webhook or API call, and DOES NOT trust the frontend success callback alone.
4. **Audit Event Emission:** Verify that `payment.successful` is emitted to the Event Bus.
5. If any omissions, bugs, or invariant violations are found, **FIX THE CODE DIRECTLY**. Do not merely report the issue.
6. Re-test after applying fixes.
7. Provide a final certification report.
```

---

## TASK T-TRN-05 — Implement Digital Parcel Waybill Recording

### PROMPT 1 — IMPLEMENTATION
```markdown
You are a Replit execution agent responsible for implementing a new feature in the `webwaka-transport` repository.

**Task ID:** T-TRN-05
**Task Title:** Implement Digital Parcel Waybill Recording

**Context & Objective:**
Intercity buses carry significant cargo (waybills). We must build the Logistics handoff endpoint, allowing dispatchers to record cargo loaded onto a passenger bus and emit events to the Logistics repository.

**WebWaka Invariants to Honor:**
1. **Event-Driven Architecture:** Do not build the parcel tracking portal here. Transport only records the physical movement of the asset. You must emit `trip.cargo_loaded` and `trip.cargo_unloaded` events.
2. **Multi-Repo Platform Architecture:** Rely on the Logistics repo to consume these events and update the customer-facing tracking state.

**Execution Steps:**
1. Read the `webwaka_transport_research_report.md` (Enhancement D-14) for context.
2. Build a Dispatcher UI to scan/enter parcel tracking numbers and link them to a specific `trip_id`.
3. Implement the backend logic to handle the linking and emit the `trip.cargo_loaded` event.
4. Implement the logic to emit `trip.cargo_unloaded` when the trip arrives at the destination terminal.
5. Write tests covering the linking logic and event emission.
6. Report completion, summarizing the files changed and confirming adherence to the invariants.
```

### PROMPT 2 — QA / TEST / BUG-FIX
```markdown
You are a Replit QA and Bug-Fix agent responsible for verifying the implementation of Task T-TRN-05 (Implement Digital Parcel Waybill Recording) in the `webwaka-transport` repository.

**Verification Steps:**
1. Review the intended scope: Dispatcher UI to link parcels to trips, backend logic, and emission of `trip.cargo_loaded` and `trip.cargo_unloaded` events.
2. Inspect the actual codebase changes.
3. **Audit Separation of Concerns:** Verify that Transport does not attempt to manage the parcel lifecycle or tracking portal internally. It must only emit the physical movement events.
4. **Audit Event Emission:** Verify that the events are correctly published using the `@webwaka/core` event publisher.
5. If any omissions, bugs, or invariant violations are found, **FIX THE CODE DIRECTLY**. Do not merely report the issue.
6. Re-test after applying fixes.
7. Provide a final certification report.
```
