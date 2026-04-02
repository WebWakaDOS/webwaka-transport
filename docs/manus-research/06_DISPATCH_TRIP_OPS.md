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
