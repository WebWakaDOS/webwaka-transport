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
