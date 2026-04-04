# WebWaka Transport (`webwaka-transport`) Implementation Plan

**Prepared by:** Manus AI
**Date:** April 2026
**Target Repository:** `webwaka-transport`

## 1. Executive Summary

`webwaka-transport` powers the ride-hailing, bus ticketing, and fleet management operations for the WebWaka ecosystem. This plan details the next phase of enhancements to support dynamic surge pricing, offline-first driver apps, and real-time ride matching.

## 2. Current State vs. Target State

**Current State:**
- Basic ride booking and driver assignment.
- Simple fare calculation.
- Integration with `webwaka-core` for canonical events.

**Target State:**
- AI-driven dynamic surge pricing based on real-time demand and traffic.
- Offline-first driver PWA with Dexie.js for ride completion.
- Real-time ride matching algorithm using geospatial indexing.
- Multi-modal transport support (e.g., bus ticketing + ride-hailing).

## 3. Enhancement Backlog (Top 20)

1. **Dynamic Surge Pricing:** Use `webwaka-ai-platform` to calculate surge multipliers based on real-time demand, weather, and traffic data.
2. **Real-Time Ride Matching:** Implement a geospatial indexing system (e.g., H3 or Geohash) to match riders with the nearest available drivers.
3. **Offline-First Driver App:** PWA for drivers to accept rides and complete trips even in low-connectivity areas.
4. **Bus Ticketing System:** Allow users to book seats on scheduled bus routes with QR code tickets.
5. **Carpooling/Ride-Sharing:** Enable riders to share rides and split fares.
6. **Driver Earnings Dashboard:** Real-time visibility into daily earnings, bonuses, and commissions.
7. **In-App Navigation:** Integrate Mapbox or Google Maps SDK for turn-by-turn navigation within the driver app.
8. **SOS/Emergency Button:** One-tap emergency alert system for both riders and drivers.
9. **Toll & Airport Fee Calculator:** Automatically add toll gate fees to the final fare.
10. **Scheduled Rides:** Allow riders to book rides in advance (e.g., airport transfers).
11. **Corporate Billing:** Support corporate accounts where employees can charge rides to their company.
12. **Driver Verification (Selfie Check):** Require drivers to take a selfie before starting their shift to prevent account sharing.
13. **Vehicle Inspection Reports:** Digital forms for drivers to log daily vehicle inspections.
14. **Multi-Stop Rides:** Allow riders to add multiple destinations to a single trip.
15. **Wait Time Billing:** Automatically charge riders for excessive wait times at pickup locations.
16. **Driver Tipping:** Allow riders to add a tip at the end of the trip.
17. **Lost & Found Portal:** System for reporting and tracking items left in vehicles.
18. **Promo Code Engine:** Support percentage and flat-rate discounts for marketing campaigns.
19. **Inter-City Transport:** Support long-distance travel bookings with luggage allowances.
20. **EV Charging Station Locator:** Map view showing nearby charging stations for electric vehicle fleets.

## 4. Execution Phases

### Phase 1: Ride Matching & Pricing
- Implement Real-Time Ride Matching.
- Implement Dynamic Surge Pricing.

### Phase 2: Driver Experience & Offline Resilience
- Implement Offline-First Driver App (Dexie.js).
- Implement Driver Earnings Dashboard.

### Phase 3: Multi-Modal & Safety
- Implement Bus Ticketing System.
- Implement SOS/Emergency Button.

## 5. Replit Execution Prompts

**Prompt 1: Real-Time Ride Matching**
```text
You are the Replit execution agent for `webwaka-transport`.
Task: Implement Real-Time Ride Matching.
1. Create `src/modules/matching/engine.ts`.
2. Implement a function that takes a rider's coordinates and queries the `active_drivers` D1 table.
3. Use a bounding box or Haversine formula to find the 5 nearest available drivers.
4. Emit a `transport.ride.requested` event to notify the selected drivers.
```

**Prompt 2: Dynamic Surge Pricing**
```text
You are the Replit execution agent for `webwaka-transport`.
Task: Implement Dynamic Surge Pricing.
1. Create `src/modules/pricing/surge.ts`.
2. Implement a function that calculates the ratio of active riders to available drivers in a specific zone.
3. Call `getAICompletion()` from `src/core/ai-platform-client.ts` to factor in external variables (e.g., weather, time of day) and return a surge multiplier (e.g., 1.5x).
4. Apply the multiplier to the base fare calculation.
```
