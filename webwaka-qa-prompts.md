# WebWaka — QA & Verification Prompts

> **Purpose**: Each prompt below is a self-contained QA instruction for an agent to deeply verify and fix the implementation of its corresponding phase. Copy the entire block for a phase and paste it to the agent working in the target repo immediately after that phase's implementation is complete.  
> **Agent behaviour expected**: The agent will read all relevant code, run all available checks, test every endpoint and UI path, identify any gap between the plan and the implementation, and fix every issue found before declaring the phase verified.

---

## QA PROMPT — P01-CORE
**Target Repo**: `@webwaka/core`  
**Verifies**: Phase P01-CORE implementation

---

```
You are the QA agent for Phase P01-CORE of the WebWaka platform.
Target repo: @webwaka/core (packages/core/src/)

Your job is to deeply verify that every task in P01-CORE was implemented correctly, find every bug or gap, and fix everything before declaring this phase verified. Do not skip any step.

=== VERIFICATION CHECKLIST ===

--- P01-T1: ID Generation Consolidation ---
1. Read packages/core/src/index.ts. Confirm nanoid(prefix, length) is exported with a JSDoc comment mentioning Cloudflare Worker compatibility.
2. Confirm export const genId = nanoid is also exported (backward-compat alias).
3. Run: grep -r "genId" packages/core/src/ — should only appear as the alias assignment, nowhere else as a separate implementation.
4. Run: grep -r "Math.random\|randomBytes\|uuid" packages/core/src/ — confirm no non-crypto random is used in ID generation.
5. Invoke the function mentally: nanoid('trp', 16) — verify it would produce a string starting with 'trp' followed by at least 16 random characters.
6. Confirm packages/core/package.json has had its version bumped (minor or patch).

If any of these fail: fix the issue immediately before moving on.

--- P01-T2: Shared Query Helpers ---
1. Read packages/core/src/index.ts (or the query-helpers.ts it imports from). Confirm all three functions are exported: parsePagination, metaResponse, applyTenantScope.
2. Verify parsePagination signature: accepts Record<string, string>, returns { limit: number; offset: number }. Confirm it caps limit at a configurable max (default 100) and floor-clamps offset at 0.
3. Verify metaResponse signature: accepts (data: T[], total: number, limit: number, offset: number), returns an object with { data, meta: { total, limit, offset, has_more } }.
4. Verify applyTenantScope signature: accepts (baseQuery: string, params: unknown[], tenantId: string, column?: string), returns { query: string; params: unknown[] }.
5. Mental test of applyTenantScope:
   - Input: ('SELECT * FROM trips', [], 'op_123') → must return { query: 'SELECT * FROM trips WHERE operator_id = ?', params: ['op_123'] }
   - Input: ('SELECT * FROM trips WHERE state = ?', ['active'], 'op_123') → must return { query: '...WHERE state = ? AND operator_id = ?', params: ['active', 'op_123'] }
6. Run: tsc --noEmit in packages/core/ — must pass with zero errors.

If any fail: fix immediately.

--- P01-T3: NDPR Consent Utility ---
1. Read packages/core/src/ndpr.ts (or wherever the NDPR code lives). Confirm it exports: assertNdprConsent(body), recordNdprConsent(db, entityId, entityType, ipAddress, userAgent).
2. Verify assertNdprConsent: throws an error when body.ndpr_consent is not exactly true (test: null, undefined, 'true' string, 0, false — all must throw).
3. Verify the error thrown has a status property of 400 and a code of 'NDPR_CONSENT_REQUIRED'.
4. Verify recordNdprConsent: constructs the correct SQL INSERT into ndpr_consent_log with all 7 required columns. Confirm the generated id is unique (uses timestamp + random).
5. Confirm ndpr_consent_log table schema requires these columns: id, entity_id, entity_type, consented_at, ip_address, user_agent, created_at.
6. Confirm assertNdprConsent and recordNdprConsent are both exported from packages/core/src/index.ts.
7. Run tsc --noEmit — zero errors required.

If any fail: fix immediately.

--- P01-T4: API Key Authentication ---
1. Read the verifyApiKey function. Confirm it:
   a. Accepts rawKey (string) and db (D1Database)
   b. Computes SHA-256 of the raw key using crypto.subtle.digest
   c. Converts the hash to lowercase hex
   d. Queries the api_keys table joining operators
   e. Returns null if no matching key or if revoked_at is set
   f. Non-blockingly updates last_used_at
   g. Returns a WakaUser object with role set based on scope ('read_write' → 'TENANT_ADMIN', else 'STAFF')
2. Verify jwtAuthMiddleware was extended to detect 'ApiKey ' prefix in the Authorization header and call verifyApiKey instead of JWT verification.
3. Confirm verifyApiKey is exported from packages/core/src/index.ts.
4. Confirm WakaUser type includes tenant_id and operator_id fields. If missing: add them.
5. Run tsc --noEmit — zero errors required.

--- FINAL CHECKS ---
1. Run tsc --noEmit one final time on the entire packages/core directory. Must show zero errors.
2. Check that all four new exports (nanoid/genId, parsePagination/metaResponse/applyTenantScope, assertNdprConsent/recordNdprConsent, verifyApiKey/requireTierFeature) appear in the public exports of packages/core/src/index.ts.
3. Confirm package.json version was bumped.
4. If webwaka-transport imports @webwaka/core, run tsc --noEmit in webwaka-transport to confirm it still compiles after core changes.

Report every issue found and every fix applied. Do not declare verified until tsc --noEmit passes with zero errors and every checklist item above is confirmed.
```

---

## QA PROMPT — P02-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P02-TRANSPORT implementation

---

```
You are the QA agent for Phase P02-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

Deeply verify P02-TRANSPORT. Find every gap, bug, or missing piece. Fix everything. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P02-T1: Offline Agent Transaction Sync ---
1. Read src/core/offline/sync.ts. Locate the flush() method. Confirm it has a second phase after the mutations loop that:
   a. Calls this.db.getPendingTransactions() (or equivalent)
   b. Loops through pending transactions
   c. POSTs each to /api/agent-sales/sync with Authorization header and X-Idempotency-Key header
   d. Calls markTransactionSynced on HTTP 200 or 409
   e. Calls incrementTransactionRetry on non-success responses
   f. Has a try/catch that silently absorbs network errors (non-fatal)
2. Read src/core/offline/db.ts. Confirm:
   a. markTransactionSynced(id) exists and sets synced_at = Date.now()
   b. incrementTransactionRetry(id) exists and increments retry_count
   c. getPendingTransactions() returns rows where synced_at IS NULL and retry_count < 5
   d. The transactions Dexie table schema includes idempotencyKey field
   e. If the idempotencyKey field was added in a schema version upgrade, confirm the version was incremented and an upgrade migration function handles existing rows (assigns a default idempotencyKey to rows that don't have one)
3. Mental walkthrough: agent makes an offline sale → saveOfflineTransaction called → transaction written to Dexie → connectivity restored → flush() called → getPendingTransactions returns it → POST to /api/agent-sales/sync → markTransactionSynced called → transaction no longer appears in getPendingTransactions. Trace each step in the code.
4. Check for type safety: confirm all Dexie operations are typed. No `any` types on transaction objects unless explicitly necessary.

Fix any missing steps or bugs found.

--- P02-T2: Multi-Seat Atomic Reservation Batch Endpoint ---
1. Locate POST /api/seat-inventory/trips/:tripId/reserve-batch in src/api/seat-inventory.ts.
2. Verify the request body is validated: seat_ids must be a non-empty array, user_id must be a non-empty string, idempotency_key must be present.
3. Verify idempotency: the endpoint reads from IDEMPOTENCY_KV before processing. If key found, returns cached response immediately.
4. Verify the read-then-write optimistic concurrency pattern:
   a. One SELECT query reads all seats at once (not N queries)
   b. If any seat is not 'available', returns 409 immediately without writing anything
   c. The UPDATE statements all include AND version = {originalVersion} in their WHERE clause
   d. After batch execute, each result's meta.changes is checked
   e. If any result has changes=0, a compensating batch releases already-reserved seats in the same batch
   f. The compensating release returns 409 (not 500)
5. Verify tokens: each seat gets its own unique token (not one shared token). Tokens use nanoid from @webwaka/core.
6. Verify the platform event seat.batch_reserved is published via publishEvent.
7. Verify idempotency key is stored in IDEMPOTENCY_KV after success with at least a 24-hour TTL.
8. Verify response shape: { tokens: [ { seat_id, token, expires_at }, ... ] }
9. Check: what happens if seat_ids is an empty array? Should return 400. Confirm it does.
10. Check: what happens if tripId does not exist? Should return 404. Confirm it does.

Fix all issues found.

--- P02-T3: Schema Migration 002 ---
1. Confirm the file migrations/002_phase2_tables.sql exists.
2. Read it and verify these tables are defined: api_keys, ndpr_consent_log, bus_parks, agent_bus_parks, float_reconciliation, trip_inspections, seat_history, vehicle_maintenance_records, vehicle_documents, driver_documents, waiting_list, operator_reviews, schedules, agent_broadcasts, dispute_tickets, route_stops.
3. Verify each table has appropriate indexes (at minimum: foreign key columns and frequently-queried columns should be indexed).
4. Verify the ALTER TABLE statements at the bottom add the required new columns to existing tables: commission_rate on agents, seat_template on vehicles, fare_matrix on routes, cancellation_policy on routes.
5. Verify migration 002 is registered in src/api/admin.ts migration runner.
6. Attempt to parse the SQL mentally for obvious errors: unmatched parentheses, missing semicolons, references to tables that don't exist yet in the migration. Fix any syntax errors found.
7. Run the migration SQL through a syntax check if a tool is available. If not, read it carefully for errors.

--- FINAL CHECKS ---
1. Run tsc --noEmit — zero errors required.
2. Start the dev server (npm run dev:ui) and confirm it starts without runtime errors.
3. Confirm all new imports from @webwaka/core resolve correctly (nanoid, publishEvent, etc.).
4. If any import from @webwaka/core fails to resolve, check packages/core/package.json exports and tsconfig paths.

Report every issue found and every fix applied.
```

---

## QA PROMPT — P03-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P03-TRANSPORT implementation

---

```
You are the QA agent for Phase P03-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

Deeply verify P03-TRANSPORT. Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P03-T1: Configurable Reservation TTL ---
1. Locate the getOperatorConfig helper. Confirm it reads from TENANT_CONFIG_KV, parses JSON, and merges with DEFAULT_OPERATOR_CONFIG (so missing fields always get defaults, never undefined).
2. Confirm GET /api/operator/config exists and returns the full config with defaults applied.
3. Confirm PUT /api/operator/config validates the submitted body. Check: what happens if someone submits reservation_ttl_ms: -1? Should be rejected (must be positive integer). What if surge_multiplier_cap: 100? Should be capped at a reasonable max. Verify validation exists.
4. Confirm PUT writes to TENANT_CONFIG_KV and publishes a platform event.
5. In the reserve endpoint, confirm it reads the TTL from the operator config (not a hardcoded 30000).
6. Confirm Origin header detection works: if Origin header is present, uses online_reservation_ttl_ms; if absent, uses reservation_ttl_ms.
7. Check that getOperatorConfig is consistent — used the same way in both the single-seat reserve and reserve-batch endpoints.

--- P03-T2: Seat Hold Extension ---
1. Locate POST /api/seat-inventory/trips/:tripId/extend-hold.
2. Verify it checks that the token matches (not just that the seat is reserved — any agent with the right token should be able to extend).
3. Verify it returns 410 Gone when the seat is already expired (not 409, not 404).
4. Verify the max hold cap is enforced: no hold can exceed 10 minutes from its creation.
5. Check: what happens if the seat_id or token is missing from the body? Should return 400. Confirm it does.
6. Check: what happens if the seat does not belong to the specified tripId? Should return 404. Confirm it does.

--- P03-T3: Paystack Inline Popup SDK ---
1. Open index.html. Confirm the Paystack inline SDK script tag is present in the <head>: <script src="https://js.paystack.co/v1/inline.js"></script>.
2. Find the booking payment component. Confirm window.PaystackPop.setup is called (not a redirect to a Paystack URL).
3. Verify the onSuccess callback calls PATCH /api/booking/bookings/:id/confirm with the transaction reference.
4. Verify the onClose callback calls the extend-hold endpoint to preserve the seat.
5. Check: is VITE_PAYSTACK_PUBLIC_KEY correctly referenced from import.meta.env? Confirm it is not hardcoded.
6. Confirm .env.example has VITE_PAYSTACK_PUBLIC_KEY=your_paystack_public_key_here or similar.
7. Check: what happens if the Paystack script fails to load (CDN down)? The page should not crash. Verify there is a guard: if (!window.PaystackPop) — show a fallback message.

--- P03-T4: SMS Booking Confirmation ---
1. Read src/lib/sms.ts. Confirm sendSms is a complete implementation calling the Termii API (not a stub/placeholder).
2. Verify the Termii API URL is correct: https://api.ng.termii.com/api/sms/send.
3. Confirm sendSms is non-fatal: a failed Termii API call logs an error but does not throw (so a failed SMS cannot prevent a booking from being confirmed).
4. Read drainEventBus() in src/lib/sweepers.ts. Find the booking.created / booking:CONFIRMED handler. Confirm it:
   a. Parses the event payload as JSON
   b. Reads customer_phone from the payload
   c. Builds a human-readable SMS message with route, date, seats, booking reference, and ticket URL
   d. Calls sendSms with the phone and message
   e. Does not throw on SMS failure
5. Confirm the publishEvent call in booking-portal.ts for booking creation includes customer_phone, origin, destination, departure_date, seat_numbers in the payload. If any of these are missing, the SMS will be incomplete — fix the payload.
6. Check: what if customer_phone is empty or NDPR-anonymized ('NDPR_...')? The code should skip the SMS gracefully. Confirm there is a guard: if (phone && !phone.startsWith('NDPR_')).

--- P03-T5: E-Ticket Page with QR ---
1. Confirm GET /b/:bookingId route exists and is public (no auth required).
2. Confirm it returns 404 for bookings with status != 'confirmed'.
3. Confirm it returns the booking details including: origin, destination, departure_time, operator_name, passenger_names, seat_numbers, booking_id.
4. Confirm src/pages/ticket.tsx (or equivalent) exists and is registered in the React router.
5. Confirm the QR code library is installed (check package.json for qrcode or similar).
6. Confirm the QR encodes the correct data: `{bookingId}:{seatIds_comma_separated}`.
7. Confirm the "Share via WhatsApp" button uses wa.me/?text= and not the WhatsApp Business API.
8. Load the e-ticket page in the dev server. Confirm it renders without errors in the browser console.
9. Check: does the e-ticket page work without authentication? Navigate to /b/someId directly without a JWT cookie and confirm no 401 redirect.
10. Check @media print: confirm there are print-specific CSS rules that hide navigation and make the receipt layout compact.

--- P03-T6: Guest Booking ---
1. Confirm POST /api/booking/verify-phone exists and is public.
2. Confirm it validates Nigerian phone format before sending OTP.
3. Confirm OTP is stored in SESSIONS_KV with key guest_otp_{phone} and has a TTL (not stored indefinitely).
4. Confirm POST /api/booking/verify-phone/confirm returns a JWT on correct OTP, and 401 on wrong OTP.
5. Confirm the guest JWT has a short TTL (15 minutes or less).
6. Confirm POST /api/booking/bookings accepts guest JWTs (same auth middleware path).
7. Confirm that when a guest user books, a customer record is created with the guest phone and is_guest = 1.
8. Confirm is_guest column exists on the bookings table (check migration 002 or 003).
9. Check: NDPR consent is still enforced for guest bookings (ndpr_consent: true must be in the body).

--- FINAL CHECKS ---
1. Run tsc --noEmit — zero errors.
2. Start the dev server. Open the app. Confirm no console errors on load.
3. Navigate to /b/test — confirm a 404 or "booking not found" message (not a crash).
4. Grep for TODO or FIXME in all files touched in this phase — resolve or document every one.

Report every issue found and every fix applied.
```

---

## QA PROMPT — P04-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P04-TRANSPORT implementation

---

```
You are the QA agent for Phase P04-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

Deeply verify P04-TRANSPORT. Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P04-T1: Full Operator Config Service ---
1. Confirm OperatorConfig interface exists in src/api/types.ts with all required fields: reservation_ttl_ms, online_reservation_ttl_ms, abandonment_window_ms, surge_multiplier_cap, boarding_window_minutes, parcel_acceptance_enabled, cancellation_policy, emergency_contact_phone, sos_escalation_email, inspection_required_before_boarding.
2. Confirm DEFAULT_OPERATOR_CONFIG is defined and every field has a safe non-undefined default.
3. Confirm getOperatorConfig(env, operatorId) uses a spread merge so no field can be undefined: { ...DEFAULT_OPERATOR_CONFIG, ...stored }. A missing field in KV must always fall back to the default.
4. Test config roundtrip: PUT /api/operator/config with a partial config → GET /api/operator/config must return the merged result with all defaults filled in.
5. In src/core/offline/db.ts: confirm getLocalOperatorConfig and saveLocalOperatorConfig exist and use the Dexie operator_config table.
6. Confirm the Dexie operator_config table stores a timestamp and the app checks the TTL (1 hour) before trusting the cached value.
7. Confirm the app fetches config on login and saves it locally. Trace this from the login success handler to the saveLocalOperatorConfig call.
8. Check: what if TENANT_CONFIG_KV is not bound in wrangler.toml? The app should not crash — getOperatorConfig should return the defaults. Confirm there is a null-check on env.TENANT_CONFIG_KV.

--- P04-T2: Automated Schedule Engine ---
1. Confirm POST /api/operator/schedules exists and validates:
   - departure_time matches /^\d{2}:\d{2}$/
   - recurrence is one of 'daily', 'weekdays', 'weekends', 'custom'
   - recurrence_days is required when recurrence = 'custom'
   - horizon_days is between 1 and 90
2. Confirm GET, PATCH, and DELETE /api/operator/schedules/:id all exist.
3. Read generateScheduledTrips in src/lib/sweepers.ts. Verify:
   a. It fetches all active schedules (active=1, deleted_at IS NULL)
   b. For each schedule, it computes the correct dates based on the recurrence rule
   c. It checks for existing trips before creating (no duplicates)
   d. It skips dates in the past
   e. It creates trip records AND seat records in a single D1 batch
   f. Seat count comes from the route/vehicle, not hardcoded
4. Confirm generateScheduledTrips is called in the daily cron handler in src/worker.ts (0 0 * * *).
5. Confirm generateScheduledTrips is also called immediately when a new schedule is created (POST /api/operator/schedules).
6. Check edge cases:
   - What if the route_id in the schedule references a deleted route? The sweep should skip it gracefully (log warning, not crash).
   - What if horizon_days = 0? Should not generate any trips. Confirm.
   - What if all days in recurrence_days are excluded? Should generate no trips for the next horizon period.
7. Check: DELETE /api/operator/schedules/:id soft-deletes (sets deleted_at). Confirm future sweeps ignore deleted schedules.

--- FINAL CHECKS ---
1. Run tsc --noEmit — zero errors.
2. Start the dev server. POST /api/operator/schedules with a valid daily schedule. Confirm trips are created for the next horizon_days.
3. GET /api/operator/schedules — confirm the created schedule appears.
4. GET /api/operator/config — confirm defaults are returned when no config is set in KV.
5. PUT /api/operator/config — confirm the response echoes the saved config with all fields present.

Report every issue found and every fix applied.
```

---

## QA PROMPT — P05-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P05-TRANSPORT implementation

---

```
You are the QA agent for Phase P05-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

Deeply verify P05-TRANSPORT. Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P05-T1: GPS Location Update ---
1. Confirm POST /api/operator/trips/:id/location exists and requires DRIVER role or above.
2. Confirm validation: latitude ∈ [-90, 90] and longitude ∈ [-180, 180]. Test boundary values: lat=90.1 should return 400.
3. Confirm the endpoint returns 422 for completed or cancelled trips (GPS update on a finished trip makes no sense).
4. Confirm current_latitude, current_longitude, and location_updated_at are written to the trips table.
5. Confirm location_updated_at column exists in the trips table (check migration 002 or 003).
6. Confirm GET /api/operator/trips/:id response includes current_latitude, current_longitude, location_updated_at.
7. Confirm GET /api/booking/bookings/:id response also includes these trip location fields (for passenger tracking).
8. Confirm a platform event trip.location_updated is published with the coordinates.

--- P05-T2: SOS System ---
1. Confirm POST /api/operator/trips/:id/sos exists and requires DRIVER role.
2. Confirm it returns 409 if sos_active is already 1 (cannot trigger SOS twice).
3. Confirm it sets sos_active=1, sos_triggered_at, and sos_triggered_by in the database.
4. Confirm it reads emergency_contact_phone from operator config and sends an SMS.
5. Confirm the SMS is sent even if the Termii response is slow — it must not block the response to the driver.
6. Confirm it publishes a trip:SOS_ACTIVATED platform event.
7. Confirm POST /api/operator/trips/:id/sos/clear exists and requires SUPERVISOR role.
8. Confirm clear returns 409 if sos_active is already 0.
9. Confirm clear sets sos_active=0, sos_cleared_at, and sos_cleared_by.
10. Confirm drainEventBus handles trip:SOS_ACTIVATED — does not silently swallow it (should log as console.error at minimum, attempt email if configured).
11. Check: what if emergency_contact_phone is empty string? SMS should be skipped gracefully, not crash.
12. Check RBAC: a CUSTOMER or AGENT role must receive 403 when calling the SOS trigger.

--- P05-T3: Boarding Scan ---
1. Confirm POST /api/operator/trips/:id/board exists and requires STAFF role.
2. Confirm qr_payload is parsed as "{bookingId}:{seatIds_comma}". Test: what if qr_payload has no colon? Should return 400.
3. Confirm the booking is validated against the tripId (cannot board a passenger from a different trip).
4. Confirm already-boarded tickets return 409 with the original boarded_at timestamp in the response.
5. Confirm invalid tickets (not found for this trip) return 404 — not a generic 500 error.
6. Confirm boarded_at and boarded_by are written to the bookings table.
7. Confirm a booking.boarded platform event is published.
8. Confirm GET /api/operator/trips/:id/boarding-status returns total_confirmed, total_boarded, remaining, last_boarded_at.
9. Check: what if a ticket is in 'pending' status (unpaid)? It must return 422 'booking_not_confirmed', not allow boarding.
10. Check: what if a ticket is in 'cancelled' status? Also must return 422, not allow boarding.

--- P05-T4: Manifest Export ---
1. Confirm GET /api/operator/trips/:id/manifest returns enhanced manifest with passenger_names, seat_numbers, boarded_at, payment_method, passenger_id_type, booking_id for each booking.
2. Confirm CSV export works: sending Accept: text/csv returns a CSV file with the correct Content-Disposition header.
3. Confirm the CSV has a header row and data rows. Verify the header matches the data columns.
4. Check: what if the trip has zero confirmed bookings? CSV and JSON should return empty data (not crash).
5. Check: manifest endpoint requires authentication and operator scope — a different operator cannot read another operator's manifest. Confirm tenant scope is applied.

--- P05-T5: Pre-Trip Inspection ---
1. Confirm POST /api/operator/trips/:id/inspection exists and requires DRIVER role.
2. Confirm that submitting any boolean field as false causes a 422 error identifying the specific failed item.
3. Confirm duplicate inspection attempts return 409.
4. Confirm inspection_completed_at is written to the trips table.
5. Confirm GET /api/operator/trips/:id/inspection returns the record or null.
6. In the trip state transition endpoint, confirm that transitioning to 'boarding' checks inspection_required_before_boarding from config. If true and no inspection: return 422 with the correct error code.
7. Check: if inspection_required_before_boarding is false (default), trips can transition to boarding without an inspection. Confirm this default path works.

--- P05-T6: Delay Reporting ---
1. Confirm POST /api/operator/trips/:id/delay exists and requires SUPERVISOR role.
2. Confirm reason_code is validated against the allowed set: traffic, breakdown, weather, accident, fuel, other. An invalid code like 'alien_abduction' must return 400.
3. Confirm estimated_departure_ms must be in the future (> Date.now()). A past timestamp must return 400.
4. Confirm delay columns are written to the trips table (delay_reason_code, delay_reported_at, estimated_departure_ms).
5. Confirm a trip:DELAYED platform event is published.
6. Confirm drainEventBus handles trip:DELAYED: queries confirmed bookings and sends SMS to each passenger phone. Confirm this is non-fatal (failed SMS does not mark the event as dead).
7. Confirm GET /api/operator/trips/:id/delay returns the delay info or null.
8. Check: can a delay be filed on a 'completed' or 'cancelled' trip? It should return 422. Confirm.

--- FINAL CHECKS ---
1. Run tsc --noEmit — zero errors.
2. Confirm migration 003 file exists with the new columns for delay_reason_code, delay_reported_at, estimated_departure_ms, location_updated_at, and any others added in P05.
3. Run the migration locally and confirm no SQL errors.
4. Start the dev server. Confirm no runtime errors on startup.
5. Grep for any TODO or placeholder comment in files modified in P05. Resolve all of them.

Report every issue found and every fix applied.
```

---

## QA PROMPT — P06-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P06-TRANSPORT implementation

---

```
You are the QA agent for Phase P06-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

Deeply verify P06-TRANSPORT (Driver Mobile App). Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P06-T1: Complete Driver View ---

Section 1 — My Trips Tab:
1. Open src/components/driver-view.tsx (or the driver-specific components). Confirm a trips list section fetches GET /api/operator/trips?driver_id=me.
2. Confirm it handles loading state, error state, and empty state (no trips assigned) gracefully — no blank white screen in any of these cases.
3. Confirm state badges are shown for each trip: scheduled, boarding, in_transit, completed.
4. Confirm tapping a trip navigates to the detail view (does not crash, renders the trip's details).

Section 2 — Trip Detail:
5. Confirm departure time, route, vehicle plate, driver name, seat count, and inspection status are shown.
6. Confirm "Start Inspection" button appears ONLY for 'scheduled' state trips.
7. Confirm "Scan Boarding Pass" and "View Manifest" appear ONLY for 'boarding' state trips.
8. Confirm "Share Location" toggle and "Report Delay" appear ONLY for 'in_transit' state trips.
9. Confirm the inspection status badge shows correctly based on whether inspection_completed_at is set.

Section 3 — Inspection Form:
10. Confirm all five checkboxes are present: Tires OK, Brakes OK, Lights OK, Fuel Adequate, Emergency Equipment Present.
11. Confirm the submit button is disabled (grayed out) until ALL five checkboxes are checked.
12. Confirm submission calls POST /api/operator/trips/:id/inspection.
13. Confirm success navigates back to Trip Detail showing the ✓ Inspected badge.
14. Confirm error responses are shown to the driver (not silently swallowed).

Section 4 — Boarding Scan:
15. Confirm the camera QR scanner opens on tap (uses getUserMedia — may require HTTPS in production, which Replit proxies handle).
16. Confirm the jsQR library (or equivalent) is installed (check package.json).
17. Confirm on successful decode, POST /api/operator/trips/:id/board is called.
18. Confirm success shows passenger name + seat for 2 seconds then re-opens scanner.
19. Confirm 409 (already boarded) shows an amber warning, not a crash.
20. Confirm 404 (invalid ticket) shows a red error card.
21. Confirm the running counter updates after each scan.
22. Check: if the camera is denied permission, the component shows an error message, not a blank screen.

Section 5 — GPS Location Share:
23. Confirm the toggle calls navigator.geolocation.watchPosition when turned on.
24. Confirm each position update calls POST /api/operator/trips/:id/location.
25. Confirm the toggle clears the watch when turned off.
26. Confirm permission denied shows an explanatory error message.

Section 6 — SOS Button:
27. Confirm the SOS button is prominently styled (red, large).
28. Confirm a confirmation dialog appears before the SOS is sent (no accidental triggers).
29. Confirm POST /api/operator/trips/:id/sos is called on confirmation.
30. Confirm a full-screen SOS ACTIVE banner appears after activation.
31. Confirm the SOS ACTIVE banner also appears on load if sos_active=1 in the trip data.

Section 7 — Delay Report:
32. Confirm the form has a reason_code dropdown with the correct options.
33. Confirm the estimated departure time picker is present.
34. Confirm POST /api/operator/trips/:id/delay is called on submit.

RBAC:
35. Confirm users with role != DRIVER are not routed to DriverView (they should see the appropriate dashboard for their role).
36. Confirm all driver-facing API calls include the auth JWT in the Authorization header.

Offline Behavior:
37. Confirm that at least the boarding scan queues offline (the mutation is saved to Dexie if the network request fails). Check that the Dexie mutation entry has the correct entity_type and payload for boarding.

--- FINAL CHECKS ---
1. Run tsc --noEmit — zero errors.
2. Start the dev server. Log in with a DRIVER role account. Confirm the driver view renders without errors.
3. Confirm no console errors in the browser dev tools.
4. Check mobile responsiveness: open browser dev tools, set viewport to iPhone SE size (375×667). Confirm all buttons are tappable and text is readable.

Report every issue found and every fix applied.
```

---

## QA PROMPT — P07-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P07-TRANSPORT implementation

---

```
You are the QA agent for Phase P07-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

Deeply verify P07-TRANSPORT (Agent Operations). Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P07-T1: Float Reconciliation ---
1. Confirm POST /api/agent-sales/reconciliation validates date format (YYYY-MM-DD) and rejects invalid dates.
2. Confirm it rejects duplicate filings for the same agent and date (returns 409).
3. Confirm the expected amount is computed using only cash transactions for that agent on that date (not card or bank transfer).
4. Confirm discrepancy_kobo = expected_kobo - submitted_kobo (sign matters: negative means agent submitted MORE cash than expected, positive means less).
5. Confirm the reconciliation record is inserted and returned with the discrepancy.
6. Confirm agent.reconciliation_filed platform event is published.
7. Confirm GET /api/agent-sales/reconciliation scopes correctly: AGENT role sees only their own, SUPERVISOR+ sees all for the operator.
8. Confirm PATCH /api/agent-sales/reconciliation/:id requires SUPERVISOR role and allows setting status to approved or disputed.
9. Frontend: confirm the "End of Day" button is visible in the agent POS. Confirm it shows today's transaction count and sum. Confirm a cash count input is present. Confirm submitting calls the reconciliation API.

--- P07-T2: Thermal Receipt ---
1. Confirm the receipt component exists and renders without crashing.
2. Confirm it renders all required fields: operator name, route, departure time, seat numbers, passenger names, amount in ₦ (using formatKobo from @webwaka/core), payment method, booking reference (last 8 chars uppercased), and a QR code.
3. Confirm the QR code renders as an image (not a broken image icon). The QR data must be `{bookingId}:{seatIds}`.
4. Confirm the "Print Receipt" button calls window.print() (or opens a print dialog).
5. Confirm the "Share via WhatsApp" button constructs a wa.me/?text= link (not a WhatsApp API call).
6. Open browser dev tools → Elements → and check that @media print styles are applied correctly (inspect the print stylesheet).
7. Confirm the qrcode package is listed in package.json dependencies.
8. Confirm the receipt is shown after a successful POS sale (not before, not on a failed sale).
9. Check: what if passengerNames is an empty array? Receipt should still render without crashing.
10. Confirm the qr_code column is populated in the receipts table when a transaction is completed (check src/api/agent-sales.ts).

--- P07-T3: Multi-Agent Device Sessions ---
1. Confirm the agent session switcher UI element exists in the POS header (shows "Agent: {name}" with a clickable control).
2. Confirm "Switch Agent" triggers syncEngine.flush() first, then clears auth state.
3. Confirm the Dexie getAgentSession function checks the offline grace period: expired sessions within 8 hours are returned with gracePeriod: true when offline.
4. Confirm online expired sessions return null (force re-login).
5. Confirm a yellow banner is shown in the POS when operating in grace mode.
6. Confirm multiple agents' sessions can be stored in Dexie simultaneously (keyed by agentId, not a single shared record).
7. Check: if syncEngine.flush() fails during switch, is the switch still allowed? It should be — the switch should proceed even if flush encounters an error (errors are logged, not blocking).

--- P07-T4: Bus Park Management ---
1. Confirm POST /api/agent-sales/parks exists, requires TENANT_ADMIN role, and inserts into bus_parks.
2. Confirm GET /api/agent-sales/parks returns parks for the authenticated operator only (tenant scope applied).
3. Confirm POST /api/agent-sales/parks/:id/agents inserts into agent_bus_parks.
4. Confirm DELETE /api/agent-sales/parks/:id/agents/:agentId removes from agent_bus_parks.
5. Confirm park_id filter works on GET /api/agent-sales/transactions.
6. Confirm park_id filter works on GET /api/operator/trips.
7. Check: assigning an agent to a park that belongs to a different operator must return 403. Confirm tenant scope is enforced.
8. Frontend: confirm the agent login flow checks park assignments and either auto-selects or prompts.

--- P07-T5: Passenger ID Capture ---
1. Confirm POST /api/agent-sales/transactions accepts optional passenger_id_type and passenger_id_number fields.
2. Confirm the raw passenger_id_number is NEVER stored — only the SHA-256 hash.
3. Confirm passenger_id_type (un-hashed) IS stored.
4. Confirm the hash is computed using crypto.subtle.digest (not a JS library).
5. Confirm GET /api/operator/trips/:id/manifest includes passenger_id_type but NOT passenger_id_hash.
6. Confirm no API endpoint anywhere returns passenger_id_hash in its response.
7. Check: what if passenger_id_number is provided but passenger_id_type is not? Should return 400 (both required together or neither). Confirm validation exists.
8. Check: what if the QR code in the receipt encodes the passenger ID? It must not. Only bookingId:seatIds should be in the QR.

--- FINAL CHECKS ---
1. Run tsc --noEmit — zero errors.
2. Start the dev server. Open the agent POS. Confirm no runtime errors.
3. Create a test sale and confirm the receipt modal appears with a QR code.
4. Confirm the whatsapp share link is correctly encoded (test with a booking that has special characters in the route name).

Report every issue found and every fix applied.
```

---

## QA PROMPT — P08-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P08-TRANSPORT implementation

---

```
You are the QA agent for Phase P08-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

Deeply verify P08-TRANSPORT (Revenue Features). Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P08-T1: Seat Templates ---
1. Confirm PUT /api/operator/vehicles/:id/template validates: all seat numbers are unique, all class values are in the allowed set (standard, window, vip, front), the template JSON is parseable.
2. Confirm the template is stored in the seat_template column of the vehicles table.
3. Confirm that when creating a trip via POST /api/seat-inventory/trips, if the vehicle has a seat_template, seats are generated from it (with correct seat_class per template).
4. Confirm that when no seat_template exists, seats are generated sequentially with class='standard' (backward compatible).
5. Confirm GET /api/seat-inventory/trips/:id/availability returns the seat_layout object alongside the seats array.
6. Check: what if the seat_template JSON is malformed (invalid JSON stored in DB)? The trip creation must not crash — it should fall back to sequential seat generation and log an error.
7. Check: what if the template defines 54 seats but the vehicle capacity is 45? The system should use the template's seat count, not the vehicle capacity field. Confirm this is the behavior.

--- P08-T2: Seat Class Pricing ---
1. Confirm PUT /api/operator/routes/:id/fare-matrix validates that all multipliers are ≥ 1.0 and ≤ 5.0 (or a configurable max). An invalid value like 0.5 or 10 must return 400.
2. Confirm the fare matrix is stored in the fare_matrix column of the routes table.
3. Confirm GET /api/booking/trips/search returns effective_fare_by_class in each trip result.
4. Confirm the class multipliers are applied: a route with base_fare=5000 kobo and vip_multiplier=1.5 must return vip_fare=7500 kobo.
5. Confirm time_multipliers are applied when configured (a peak-hour multiplier of 1.2 must raise the fare by 20%).
6. Confirm the lowest-class fare is returned as effective_fare for sorting purposes.
7. In POST /api/booking/bookings, confirm total_amount_kobo is validated against the computed fare. Test: submit a booking with total_amount_kobo=0 — must return 422 with fare mismatch. Submit with the correct amount — must succeed.
8. Confirm the ±2% tolerance is applied for rounding (a 1 kobo difference due to rounding must not fail the booking).

--- P08-T3: Cancellation Refund ---
1. Confirm the cancellation policy is read from operator config (not hardcoded values).
2. Confirm the refund amount is computed correctly for all three scenarios: full refund, half refund, no refund.
3. Specifically: confirm time math uses kobo correctly — refund = Math.floor(total_amount_kobo / 2) for half, not a float division.
4. Confirm initiatePaystackRefund is only called when payment_status='completed' AND payment_method IN ('paystack', 'flutterwave'). Cash cancellations must NOT trigger the Paystack API.
5. Confirm manual_refund_required=1 is set on cash cancellations.
6. Confirm refund_reference and refund_amount_kobo columns exist on the bookings table (migration 003).
7. Confirm a booking:REFUNDED event is published after a successful refund.
8. Check: what if the Paystack Refund API returns an error (e.g. invalid reference)? The booking should still be cancelled, but refund_reference should not be set, and the error should be logged. The cancellation must succeed even if the refund fails.
9. Confirm seats are released on cancellation regardless of refund outcome.

--- P08-T4: Waiting List ---
1. Confirm POST /api/booking/trips/:id/waitlist returns 400 if seats of the requested class ARE available (don't allow joining a non-full waitlist).
2. Confirm position numbering is correct: first person gets 1, second gets 2, etc.
3. Confirm GET /api/booking/waitlist returns only non-deleted, non-expired entries for the customer.
4. Confirm DELETE /api/booking/trips/:id/waitlist soft-deletes (sets deleted_at, does not hard-delete).
5. Confirm the notification logic in sweepExpiredReservations: after a seat is released, the first notified waiting customer gets an SMS with a 10-minute booking link.
6. Confirm notified_at is set so the same customer is not notified twice for the same seat release event.
7. Check: what if all customers on the waitlist have been notified and none booked? The next seat release should notify position 2 (the next un-notified entry). Confirm the query correctly orders by position and filters notified_at IS NULL.
8. Confirm waiting_list entries have an expires_at and the sweep does not notify expired entries.

--- P08-T5: Group Booking ---
1. Confirm POST /api/agent-sales/group-bookings validates seat_count ∈ [2, 50].
2. Confirm it uses atomic seat reservation (same optimistic locking pattern as reserve-batch from P02-T2).
3. Confirm that if fewer seats than requested are available, it returns 422 with the available count.
4. Confirm one bookings record is created (not N individual records).
5. Confirm the passenger_names array is populated (group_name repeated seat_count times, or equivalent).
6. Confirm one sales_transactions record is created for the total.
7. Confirm one receipts record is created.
8. Confirm a group_booking_id is generated and stored on the booking.
9. Confirm GET /api/agent-sales/group-bookings/:id returns the group booking detail.
10. Check: what if the group booking fails mid-transaction (e.g. DB error after reserving but before creating the booking record)? The seats should be released. Confirm the error handling rolls back the seat reservations.

--- FINAL CHECKS ---
1. Run tsc --noEmit — zero errors.
2. Run migration 003 locally and confirm no SQL errors.
3. Start the dev server. Test the fare matrix endpoint. GET /api/booking/trips/search with a route that has a fare matrix — confirm class prices appear in the response.
4. Test cancellation: create a booking with paymentStatus='completed', cancel it, confirm refund_amount_kobo is computed correctly.

Report every issue found and every fix applied.
```

---

## QA PROMPT — P09-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P09-TRANSPORT implementation

---

```
You are the QA agent for Phase P09-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

Deeply verify P09-TRANSPORT (Fleet and Compliance). Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P09-T1: Vehicle Maintenance ---
1. Confirm POST /api/operator/vehicles/:id/maintenance validates service_date_ms is a positive integer and service_type is non-empty.
2. Confirm it inserts into vehicle_maintenance_records.
3. Confirm an immediate vehicle.maintenance_due_soon event is published if next_service_due_ms < now + 7 days.
4. Confirm GET /api/operator/vehicles/:id/maintenance returns records ordered by service_date DESC.
5. Confirm POST /api/operator/vehicles/:id/documents validates doc_type against the allowed set.
6. Confirm GET /api/operator/vehicles/:id/documents returns documents with computed expiry_status: 'valid', 'expiring_soon' (< 30 days), or 'expired'.
7. Confirm sweepVehicleMaintenanceDue is defined in sweepers.ts and wired to the daily cron in worker.ts.
8. Confirm sweepVehicleDocumentExpiry is defined and wired to the daily cron.
9. CRITICAL: Confirm that when assigning a vehicle to a trip, the system checks for expired roadworthiness certificate. Test: a vehicle with an expired doc should return 422 when assigned. Confirm the check is actually executed in the assignment code path.
10. Check: the tenant scope is enforced on all vehicle maintenance endpoints — an operator cannot read another operator's maintenance records.

--- P09-T2: Driver Documents ---
1. Confirm POST /api/operator/drivers/:id/documents validates doc_type and expires_at_ms.
2. Confirm GET /api/operator/drivers/:id/documents returns documents with expiry_status.
3. Confirm sweepDriverDocumentExpiry is defined and wired to the daily cron.
4. CRITICAL: Confirm that driver assignment to a trip checks for expired drivers_license. A driver with an expired license must return 422. Trace this check in the code.
5. Check: does the expired document check apply to ALL document types, or only drivers_license? Per the plan, only drivers_license should block assignment. Confirm this is the behavior.

--- P09-T3: Notification Center ---
1. Confirm GET /api/operator/notifications returns events filtered by tenant_id and the correct actionable event types.
2. Confirm the query filters to events from the last 7 days only.
3. Confirm each event has a read_at field based on the notification_reads table.
4. Confirm unread_count is computed correctly (events without a read_at entry for the current user).
5. Confirm POST /api/operator/notifications/:eventId/read inserts into notification_reads and returns 200.
6. Confirm the notification_reads table exists (created in migration 003).
7. Frontend: confirm a notification badge is visible in the operator dashboard header.
8. Frontend: confirm the badge count reflects unread notifications.
9. Frontend: confirm SOS notifications (trip:SOS_ACTIVATED events) are displayed as a persistent red banner that cannot be dismissed.
10. Frontend: confirm the notification panel auto-refreshes (polling or on-demand). Check that the polling does not fire more than once every 30 seconds (no infinite loop or aggressive polling).
11. Check: the notifications endpoint requires TENANT_ADMIN+ role. A CUSTOMER or AGENT should receive 403. Confirm.

--- FINAL CHECKS ---
1. Run tsc --noEmit — zero errors.
2. Confirm all three sweepers (sweepVehicleMaintenanceDue, sweepVehicleDocumentExpiry, sweepDriverDocumentExpiry) appear in the daily cron handler in worker.ts.
3. Run migration 003 locally — no SQL errors.
4. Start dev server. Open the operator dashboard. Confirm the notification badge appears (may show 0 if no events — it should not crash).
5. Check that all compliance endpoints enforce tenant scoping (an operator cannot view another operator's vehicle or driver documents).

Report every issue found and every fix applied.
```

---

## QA PROMPT — P10-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P10-TRANSPORT implementation

---

```
You are the QA agent for Phase P10-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

Deeply verify P10-TRANSPORT (Real-Time Infrastructure and Analytics). Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P10-T1: SSE Seat Availability Feed ---
1. Confirm GET /api/seat-inventory/trips/:id/live returns Content-Type: text/event-stream.
2. Confirm the response includes Cache-Control: no-cache and X-Accel-Buffering: no.
3. Confirm the SSE endpoint uses a ReadableStream / TransformStream (not a regular JSON response).
4. Confirm it sends data: ... events (not just comments) when seat state changes.
5. Confirm it sends keep-alive pings (: ping) when there are no changes.
6. Confirm the maximum connection lifetime is enforced (stream closes after ~5 minutes).
7. Frontend: confirm an EventSource is opened on the seat selection screen.
8. Frontend: confirm the onmessage handler updates seat state without a full page re-render.
9. Frontend: confirm the EventSource is closed (es.close()) when the component unmounts.
10. Check: is the SSE endpoint public (no auth required)? Per the plan it should be read-only public. Confirm no auth middleware is applied to this specific route.
11. Check: what if the tripId does not exist? The SSE stream should immediately close or send an error event, not hang indefinitely.

--- P10-T2: Dispatcher Dashboard ---
1. Confirm GET /api/operator/dispatch exists and requires SUPERVISOR role.
2. Confirm it returns trips in states: scheduled, boarding, in_transit (not completed or cancelled).
3. Confirm each trip includes: state, route origin/destination, departure_time, vehicle plate, driver name, confirmed_count, boarded_count, sos_active, current_lat/lng, delay_reason_code, estimated_departure_ms, total_seats.
4. Confirm tenant scope is applied — only the authenticated operator's trips are returned.
5. Frontend: confirm the dispatcher dashboard exists and is accessible via a nav link for SUPERVISOR+ roles.
6. Frontend: confirm trips with sos_active=1 are visually distinct (red border, warning indicator).
7. Frontend: confirm delayed trips (delay_reason_code IS NOT NULL) are visually distinct (yellow indicator).
8. Frontend: confirm the dashboard auto-refreshes. Confirm the refresh interval is ≤ 60 seconds.
9. Frontend: confirm "View Manifest" links work and open the correct trip's manifest.

--- P10-T3: Booking Reminder Sweeper ---
1. Read sweepBookingReminders in sweepers.ts. Confirm it queries two windows: 23h–25h for 24h reminders, and 105min–135min for 2h reminders.
2. Confirm reminder_24h_sent_at and reminder_2h_sent_at columns are checked before sending — a booking should never receive the same reminder twice.
3. Confirm these columns exist on the bookings table (migration 003).
4. Confirm sendSms is called with a human-readable message including route, time, seat numbers, and ticket URL.
5. Confirm NDPR-anonymized phone numbers (starting with 'NDPR_') are skipped.
6. Confirm the sweeper is non-fatal: a failed SMS does not prevent the next booking's reminder from being processed.
7. Confirm sweepBookingReminders is wired to the minute cron in worker.ts (not just the daily cron).
8. Check: the sweeper uses a LIMIT clause (50 per run) to prevent processing thousands of reminders in one cron tick. Confirm this limit is present.
9. Check: what if departure_time has already passed? These bookings should not appear in the reminder queries (the BETWEEN condition naturally excludes past departures). Verify this is correct.

--- P10-T4: Revenue Analytics ---
1. Confirm GET /api/operator/reports accepts groupby query param with values: route, vehicle, driver.
2. Confirm the response includes: total_trips, confirmed_seats, fill_rate_pct, gross_revenue_kobo, refunds_kobo, net_revenue_kobo, avg_fare_kobo.
3. Confirm fill_rate_pct is computed correctly: (confirmed_seats / total_seats) * 100, rounded to 1 decimal.
4. Confirm net_revenue_kobo = gross_revenue_kobo - refunds_kobo.
5. Confirm date range filters (from, to) work correctly and default to the current month when not provided.
6. Confirm tenant scope is applied — TENANT_ADMIN sees only their operator's data.
7. Confirm SUPER_ADMIN can call with groupby=operator to see cross-tenant aggregates.
8. Check: what if a route has no completed bookings? It should still appear with zero revenue values (not be omitted from the response).

--- P10-T5: SUPER_ADMIN Analytics ---
1. Confirm GET /api/internal/admin/analytics exists and requires SUPER_ADMIN role.
2. Confirm the response includes: operators (total/active/suspended), trips (by state and by period), bookings (by status and by period), revenue (this month and all time), top 10 routes, top 10 operators, event bus health (pending/dead counts).
3. Confirm a non-SUPER_ADMIN user gets 403.
4. Confirm no tenant scope is applied (SUPER_ADMIN sees all operators' data).
5. Frontend: confirm the analytics section is only visible in the navigation for SUPER_ADMIN role users.

--- FINAL CHECKS ---
1. Run tsc --noEmit — zero errors.
2. Start the dev server. Open two browser tabs on the seat selection page for the same trip. Confirm both show the seat list.
3. Grep for any hardcoded 30-second or similar magic numbers in the SSE endpoint — ensure they are well-named constants.
4. Confirm the sweepBookingReminders function name is spelled consistently between its definition and its call in worker.ts.

Report every issue found and every fix applied.
```

---

## QA PROMPT — P11-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P11-TRANSPORT implementation

---

```
You are the QA agent for Phase P11-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

Deeply verify P11-TRANSPORT (Operator Management and Platform Features). Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P11-T1: Operator API Keys ---
1. Confirm POST /api/operator/api-keys requires TENANT_ADMIN role (not SUPERVISOR, not STAFF).
2. Confirm it generates a raw key in the format waka_live_{randomString}.
3. CRITICAL: Confirm the raw key is returned ONCE in the response and is NOT stored in the database — only the SHA-256 hex hash is stored. Read the insert statement: it must store key_hash, not the raw key.
4. Confirm the response includes a warning message telling the user to save the key.
5. Confirm GET /api/operator/api-keys returns metadata but never returns key_hash in the response (it must be excluded from the SELECT or explicitly deleted from the response object).
6. Confirm DELETE /api/operator/api-keys/:id sets revoked_at and returns 204 (not a hard delete).
7. Confirm after revocation, a request using that key returns 401 (the verifyApiKey function checks revoked_at IS NULL).
8. Confirm tenant scope: an operator can only manage their own API keys (operator_id on the api_keys table must match the authenticated operator).
9. Confirm API key authentication works: make a request with Authorization: ApiKey waka_live_{validKey} and confirm it authenticates as the correct operator.

--- P11-T2: Onboarding Wizard ---
1. Confirm the onboarding wizard appears for new operators (those with no routes AND no vehicles).
2. Confirm it does NOT appear for existing operators who already have routes and vehicles.
3. Confirm all 7 steps are implemented. List each step and confirm:
   - Step 1 saves to the operator profile (PATCH or equivalent endpoint)
   - Step 2 calls POST /api/operator/vehicles
   - Step 3 calls POST /api/operator/routes
   - Step 4 is optional (can be skipped)
   - Step 5 calls POST /api/operator/drivers
   - Step 6 calls POST /api/operator/agents
   - Step 7 calls POST /api/seat-inventory/trips
4. Confirm progress is saved to localStorage and an incomplete wizard resumes from the last step on next visit.
5. Confirm a "Skip for now" button is available on optional steps (at minimum Steps 4, 5, 6) without blocking the wizard from proceeding.
6. Confirm Step 7's "Create Trip" shows the newly created trip and offers a "Go to Dashboard" link.
7. Check: what if an API call in a wizard step fails? The error message should be shown to the user, and they should be able to retry without losing their progress on previous steps.
8. Check: if the user closes the browser mid-wizard, reopening the app shows the wizard at the last completed step.

--- P11-T3: Multi-Stop Route Management ---
1. Confirm POST /api/operator/routes/:id/stops validates at minimum 2 stops and unique sequence values.
2. Confirm it deletes existing stops before inserting new ones (idempotent replacement).
3. Confirm it sets route_stops_enabled=1 on the route.
4. Confirm GET /api/operator/routes/:id/stops returns stops ordered by sequence.
5. Confirm GET /api/booking/trips/search supports origin_stop and destination_stop query params.
6. When both stop params are provided, confirm the segment fare is computed: fare_from_origin[destination_stop] - fare_from_origin[origin_stop]. A passenger booking Lagos → Ilorin on a Lagos→Abuja route should pay the Lagos→Ilorin segment fare, not the full Lagos→Abuja fare.
7. Confirm POST /api/booking/bookings accepts and stores origin_stop_id and destination_stop_id.
8. Confirm sequence validation: origin_stop must have a lower sequence number than destination_stop. Booking in reverse (Abuja → Lagos on a Lagos-to-Abuja route) must return 422.
9. Check: routes without route_stops_enabled=1 should work exactly as before (no regression). Confirm standard single-origin single-destination search still works.

--- FINAL CHECKS ---
1. Run tsc --noEmit — zero errors.
2. Start the dev server. Create a new API key via POST. Confirm it appears in GET list (without the hash). Use the key in a request header and confirm it authenticates.
3. Clear localStorage and log in as a new operator with no routes/vehicles. Confirm the onboarding wizard appears.
4. Create a route with 3 stops. Search for trips using origin_stop and destination_stop. Confirm the partial fare is returned.
5. Grep for any place where raw API key values might be logged (console.log(key) etc.). Remove any such logs — API keys must never appear in logs.

Report every issue found and every fix applied.
```

---

## QA PROMPT — P12-LOGISTICS
**Target Repo**: `webwaka-logistics`  
**Verifies**: Phase P12-LOGISTICS implementation

---

```
You are the QA agent for Phase P12-LOGISTICS of the WebWaka platform.
Target repo: webwaka-logistics (and a brief cross-check of webwaka-transport)

Deeply verify P12-LOGISTICS (Transport-Logistics Integration). Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P12-T1: Transport Event Receiver ---
1. Confirm POST /internal/transport-events exists in the logistics repo.
2. Confirm it checks the Authorization header: Authorization: Bearer {INTER_SERVICE_SECRET}. Return 401 if absent or wrong. Confirm the secret is read from env.INTER_SERVICE_SECRET (not hardcoded).
3. Confirm it reads X-Webwaka-Event-Type to determine the handler.
4. Confirm parcel.waybill_created handler: parses payload and creates a parcel record in the logistics DB.
5. Confirm trip.state_changed handler:
   - in_transit: marks linked parcels as in_transit
   - completed: marks linked parcels as delivered with delivered_at timestamp
6. Confirm unrecognized event types return 200 (not 400 or 500) — the receiver must be tolerant of unknown event types.
7. Check: what if the payload JSON is malformed? The endpoint must return 200 (or at worst 400 for truly unprocessable content) — it must never crash with a 500 that causes the transport repo's drainEventBus to mark the event as dead.

--- P12-T2: Parcel Seat Requirement Events ---
1. Confirm the logistics parcel confirmation flow calls POST {TRANSPORT_BASE_URL}/api/internal/transport-events with event type parcel.seats_required.
2. Confirm the payload includes: trip_id, seats_needed (computed from weight), parcel_id, weight_kg, declared_value_kobo.
3. Confirm the Authorization header is set: Bearer {INTER_SERVICE_SECRET}.
4. Confirm the response is handled:
   - seats_confirmed: true → parcel is fully confirmed
   - seats_unavailable: true → parcel is flagged for rescheduling (not silently lost)
   - Network error → parcel marked pending_seat_assignment with a retry flag
5. Confirm TRANSPORT_BASE_URL is read from env (not hardcoded). Confirm it is not a secret (public URL).

--- P12-T3: Transport Repo — Internal Events Endpoint (cross-repo check) ---
Switch to the webwaka-transport repo for this section.

1. Confirm POST /api/internal/transport-events exists in webwaka-transport.
2. Confirm it checks Authorization: Bearer {INTER_SERVICE_SECRET}.
3. Confirm the parcel.seats_required handler:
   a. Queries available seats of any class on the trip
   b. Blocks exactly seats_needed seats by updating their status to 'blocked' with blocked_reason='parcel_cargo'
   c. Returns 200 { seats_confirmed: true, blocked_seat_ids: [...] } when enough seats found
   d. Returns 200 { seats_unavailable: true, available: N, requested: seats_needed } when insufficient
4. Confirm the blocked seats are not available for passenger booking (status='blocked' is excluded from the availability query).
5. Check: what if trip_id does not exist? Should return 200 { seats_unavailable: true } — not 404 (caller must handle this gracefully).

--- Integration Test (End-to-End) ---
6. If both repos are deployed (or can be run locally with inter-service communication), perform an end-to-end test:
   a. Create a transport trip with 20 seats in webwaka-transport.
   b. Trigger a parcel.seats_required event from webwaka-logistics for 3 seats on that trip.
   c. Confirm in webwaka-transport: 3 seats are now 'blocked'.
   d. Confirm webwaka-logistics receives seats_confirmed: true.
   e. Transition the trip to 'completed' in webwaka-transport (triggering trip.state_changed event to logistics).
   f. Confirm in webwaka-logistics: the parcel linked to that trip is marked 'delivered'.
7. If live inter-service testing is not possible: confirm that the mocked integration (calling the actual API code paths locally) produces the expected data transformations.

--- FINAL CHECKS ---
1. Run tsc --noEmit in webwaka-logistics — zero errors.
2. Run tsc --noEmit in webwaka-transport — zero errors.
3. Grep for INTER_SERVICE_SECRET in both repos: it must only appear as env.INTER_SERVICE_SECRET and never as a hardcoded string.
4. Confirm both repos have INTER_SERVICE_SECRET documented in their .env.example files.

Report every issue found and every fix applied.
```

---

## QA PROMPT — P13-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P13-TRANSPORT implementation

---

```
You are the QA agent for Phase P13-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

Deeply verify P13-TRANSPORT (Channel Expansion). Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P13-T1: WhatsApp Sharing ---
1. Confirm the receipt component has a "Share via WhatsApp" button.
2. Confirm the e-ticket page (/b/:bookingId) also has a "Share via WhatsApp" button.
3. Confirm the button uses wa.me/?text= deep link (not wa.me/send, not api.whatsapp.com, not any WhatsApp Business API endpoint).
4. Confirm the text is URL-encoded (encodeURIComponent is called on the message string).
5. Confirm the message includes: route, date, seat numbers, passenger name, booking reference, and the ticket URL.
6. Confirm the button has target="_blank" rel="noopener noreferrer" to open in a new tab/app.
7. Check: does the message contain any unencoded special characters (₦, →, etc.) that could break the URL? Test the URL encoding with a route name that contains special characters.
8. Confirm the button is styled in WhatsApp green (#25D366) with appropriate contrast for text readability.

--- P13-T2: Operator Reviews ---
1. Confirm POST /api/booking/reviews requires authenticated CUSTOMER role.
2. Confirm the booking must belong to the authenticated customer (cannot review someone else's trip).
3. Confirm the trip must be in 'completed' state before a review is accepted. A review on an in-progress trip returns 422.
4. Confirm duplicate reviews for the same booking return 409.
5. Confirm rating is validated as an integer between 1 and 5. Rating = 0, rating = 6, rating = 2.5 must all return 400.
6. Confirm GET /api/booking/operators/:id/reviews is public and returns avg_rating, total_reviews, and paginated reviews.
7. Confirm reviews do NOT expose any customer PII (no customer name, phone, or email in the review list).
8. Confirm GET /api/booking/trips/search includes avg_rating for each operator in the trip results.
9. Confirm the post-trip review prompt SMS is sent from drainEventBus when a trip.state_changed event fires for 'completed' state.
10. Confirm review_prompt_sent_at is set after the SMS is sent, preventing duplicate prompts.
11. Check: what if the customer has NDPR-anonymized phone? The SMS should be skipped. Confirm the guard exists.

--- P13-T3: Full i18n ---
1. Read src/core/i18n/index.ts. Confirm the translations object has at minimum 4 language keys: english, yoruba, igbo, hausa.
2. Audit the booking flow translation keys. Confirm the following key categories have non-empty, non-English-copy translations in ALL three vernacular languages:
   - Search form labels (From, To, Date, Search Trips)
   - Trip list labels (Available seats, Book Now, Sold Out)
   - Seat selection labels (Select your seat, Available, Reserved, Window, Aisle, VIP)
   - Payment flow (Proceed to Payment, Total Amount, Pay Now)
   - Confirmation (Booking Confirmed, View E-Ticket)
   - Error messages (Seat no longer available, Payment failed)
   - Common (Loading, Back, Cancel, Confirm, Done)
3. Confirm language auto-detection is implemented: navigator.language is read on app init and mapped to the correct language key.
4. Confirm a language selector dropdown exists in the booking portal header.
5. Confirm the selected language is stored in localStorage and persists across page reloads.
6. Confirm the i18n system is actually used in the booking portal components — that text strings are pulled from the i18n module, not hardcoded in English. Spot-check at least 5 different UI text elements.
7. Check: what happens if navigator.language returns a value not in the mapping (e.g. 'fr-FR')? It should fall back to English. Confirm this fallback exists.

--- FINAL CHECKS ---
1. Run tsc --noEmit — zero errors.
2. Start the dev server. Change the browser language to Yoruba (or manually set localStorage language to 'yoruba'). Reload the booking portal. Confirm UI text is in Yoruba.
3. Navigate to the e-ticket page. Confirm the WhatsApp share button is present and the link is correctly encoded.
4. Open browser developer tools → Network tab. Navigate to a trip search. Confirm avg_rating appears in the trip search API response.

Report every issue found and every fix applied.
```

---

## QA PROMPT — P14-CORE
**Target Repo**: `@webwaka/core`  
**Verifies**: Phase P14-CORE implementation

---

```
You are the QA agent for Phase P14-CORE of the WebWaka platform.
Target repo: @webwaka/core (packages/core/src/)

Deeply verify P14-CORE (Subscription Tier Gating). Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P14-T1: Subscription Tier Feature Gating ---
1. Confirm packages/core/src/tiers.ts (or equivalent file) exists.
2. Confirm the SubscriptionTier type is defined as 'basic' | 'professional' | 'enterprise'.
3. Confirm TIER_FEATURES is defined as Record<SubscriptionTier, string[]> with at minimum these features:
   - basic: seat_inventory, agent_sales, basic_booking, manual_schedule, manifest, boarding_scan, float_reconciliation, vehicle_management, driver_management, route_management, basic_reports
   - professional: ai_search, dynamic_pricing, waiting_list, api_keys, analytics, auto_schedule, sms_notifications, seat_class_pricing, cancellation_refunds, gps_tracking, sos_system (plus all basic features)
   - enterprise: white_label, multi_park, corporate_portal, bulk_import, route_stops (plus all professional features)
4. Confirm tierHasFeature(tier, feature) implements cumulative inheritance:
   - tierHasFeature('basic', 'ai_search') → false
   - tierHasFeature('professional', 'ai_search') → true
   - tierHasFeature('professional', 'seat_inventory') → true (inherits basic)
   - tierHasFeature('enterprise', 'white_label') → true
   - tierHasFeature('enterprise', 'basic_booking') → true (inherits basic through professional)
   - tierHasFeature('basic', 'white_label') → false
5. Test all the above cases explicitly in code or mentally trace the logic.
6. Confirm requireTierFeature(feature) is a Hono MiddlewareHandler factory.
7. Confirm it allows SUPER_ADMIN to bypass all tier checks (SUPER_ADMIN always has access to all features).
8. Confirm it reads the operator's subscription_tier from the operators table in D1.
9. Confirm it returns HTTP 402 (Payment Required) when the feature is not available for the tier — NOT 403 or 401.
10. Confirm the 402 response includes: error, feature, current_tier, upgrade_url, message.
11. Confirm both tierHasFeature and requireTierFeature are exported from packages/core/src/index.ts.
12. Run tsc --noEmit in packages/core/ — zero errors.
13. Confirm the core package version was bumped.

--- Cross-repo Compatibility Check ---
14. In webwaka-transport, confirm @webwaka/core is updated to the new version (package.json dependency version matches what was published/linked).
15. Run tsc --noEmit in webwaka-transport — the new exports from core must resolve without errors.

--- FINAL CHECKS ---
1. Mental walkthrough of the full middleware chain for a 'basic' tier operator calling POST /api/booking/trips/ai-search:
   - jwtAuthMiddleware runs → sets user context
   - requireTierFeature('ai_search') runs → reads operator.subscription_tier from DB → it is 'basic' → tierHasFeature('basic', 'ai_search') returns false → returns 402
2. Confirm this chain is correct and would produce a 402 response.
3. Mental walkthrough of SUPER_ADMIN calling the same endpoint:
   - jwtAuthMiddleware runs → user.role = 'SUPER_ADMIN'
   - requireTierFeature('ai_search') runs → sees SUPER_ADMIN → calls next() immediately (no DB query needed)
4. Confirm this chain is correct.

Report every issue found and every fix applied.
```

---

## QA PROMPT — P15-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Verifies**: Phase P15-TRANSPORT implementation

---

```
You are the QA agent for Phase P15-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This is the final phase QA. Verify P15-TRANSPORT completely. Also perform an overall platform integrity check. Fix every issue. Do not declare verified until all checks pass.

=== VERIFICATION CHECKLIST ===

--- P15-T1: Tier Gating Applied to Endpoints ---
1. Confirm requireTierFeature is imported from @webwaka/core in the relevant API files.
2. Check that EACH of the following endpoints has requireTierFeature applied with the correct feature name:
   - POST /api/booking/trips/ai-search → 'ai_search'
   - POST /api/booking/trips/:id/waitlist → 'waiting_list'
   - GET /api/operator/analytics (or the analytics endpoint) → 'analytics'
   - POST /api/operator/schedules → 'auto_schedule'
   - POST /api/operator/api-keys → 'api_keys'
   - PUT /api/operator/routes/:id/fare-matrix → 'seat_class_pricing'
   - POST /api/operator/config/branding → 'white_label'
   - POST /api/operator/import/routes → 'bulk_import'
   - POST /api/operator/import/vehicles → 'bulk_import'
3. Confirm subscription_tier column exists on the operators table (migration 003).
4. Test the gating: read the requireTierFeature middleware code. Confirm that when the DB read of subscription_tier fails (e.g. DB temporarily unavailable), the middleware fails OPEN (allows the request) rather than failing closed (blocking). This is a safety default — log the error, let the request through. Confirm this behavior exists. If it fails closed, fix it.

--- P15-T2: Durable Objects Real-Time Seats ---
1. Confirm wrangler.toml has a Durable Object binding for TripSeatDO.
2. Confirm a migrations section in wrangler.toml registers TripSeatDO as a new class.
3. Confirm src/durables/trip-seat-do.ts (or equivalent) exports the TripSeatDO class implementing DurableObject.
4. Confirm TripSeatDO is exported at the module level from src/worker.ts: export { TripSeatDO }.
5. Confirm GET /api/seat-inventory/trips/:id/ws exists and upgrades to WebSocket via the DO stub.
6. Confirm all seat mutation endpoints (reserve, confirm, release, reserve-batch) send a broadcast to the DO after the D1 write.
7. Confirm the broadcast is non-fatal (wrapped in .catch(() => {})) — a DO broadcast failure must never fail the seat mutation.
8. Frontend: confirm the seat selection component opens a WebSocket connection to /api/seat-inventory/trips/:id/ws.
9. Frontend: confirm the WebSocket onmessage handler calls a function that updates the seat state for the specific seat (not a full re-fetch).
10. Frontend: confirm the WebSocket is closed on component unmount.
11. Frontend: confirm there is a fallback when WebSocket fails — either falls back to SSE from P10-T1 or to periodic polling.
12. Check: what if two identical DO IDs are created for the same trip? They must share state. Confirm idFromName(tripId) is used (not idFromString or a random ID).
13. CRITICAL: Cloudflare Durable Objects require the class to be exported at the top level of the worker module. Confirm this is the case in worker.ts. If not, the entire worker will fail to deploy.

--- P15-T3: Corporate Travel Portal ---
1. Confirm POST /api/booking/corporate-accounts requires TENANT_ADMIN role.
2. Confirm customer_type='corporate' is set on corporate customer records.
3. Confirm payment_method='credit' is accepted in POST /api/booking/bookings ONLY for corporate customers.
4. Confirm a non-corporate customer using payment_method='credit' returns 422.
5. Confirm credit balance is checked before booking: insufficient credit returns 402.
6. Confirm credit_limit_kobo is decremented after a credit booking (atomically — the decrement and booking creation should be in a single D1 batch or transaction check).
7. Confirm GET /api/booking/corporate-accounts/:id/statement returns accurate booking history and remaining credit.
8. Check: can a CUSTOMER role access GET /api/booking/corporate-accounts? It should not — this is TENANT_ADMIN only. Confirm RBAC.

--- P15-T4: White-Label Branding ---
1. Confirm PUT /api/operator/config/branding has requireTierFeature('white_label') applied.
2. Confirm hex color validation uses a regex: /^#[0-9A-Fa-f]{6}$/.
3. Confirm POST /api/operator/config/logo validates file size (max 2MB) and content type (image/png or image/jpeg). A 5MB file must return 413. A PDF must return 415.
4. Confirm the logo is stored in R2 (env.ASSETS_R2.put is called).
5. Confirm R2 binding is in wrangler.toml.
6. Frontend: confirm CSS variables are set on document.documentElement.style when branding config is fetched.
7. Frontend: confirm the portal title changes to the operator's display_name when branding is configured.
8. Check: if no branding is configured for an operator, the default WebWaka branding is shown (not a broken white page). Confirm the fallback is implemented.

--- P15-T5: Bulk CSV Import ---
1. Confirm POST /api/operator/import/routes accepts multipart/form-data with a 'file' field.
2. Confirm routes CSV columns are validated: origin, destination, base_fare_naira (positive number), duration_minutes (positive integer).
3. Confirm base_fare_naira is converted to kobo (×100) before storage.
4. Confirm the 500-row limit is enforced — row 501 and beyond are ignored with a note.
5. Confirm the response includes created, skipped, and errors arrays.
6. Confirm errors include the row number and reason for each failed row.
7. Confirm POST /api/operator/import/vehicles and POST /api/operator/import/drivers also exist.
8. Check: what if the uploaded file is empty? Should return 400 with a clear message.
9. Check: what if the uploaded file has a header row with wrong column names? The system should return errors for each data row (unable to parse) rather than silently creating records with null values.

--- OVERALL PLATFORM INTEGRITY CHECK ---
Perform these checks across the entire codebase:

10. Run tsc --noEmit on the entire webwaka-transport repo — zero errors required.
11. Grep for console.log in production code paths (not tests or dev utilities). Remove or replace with console.error/console.warn where appropriate. Sensitive data (tokens, keys, phone numbers) must never be logged.
12. Grep for TODO and FIXME across all modified files. Resolve or document every one.
13. Grep for 'hardcoded' monetary values not using kobo (e.g. search for /\d+\.\d+\s*(naira|NGN|₦)/ or any division by 100 outside of display formatting). Monetary values must always be kobo integers in the DB and API.
14. Confirm all new API endpoints return consistent error shapes: { error: string, message?: string }. Grep for endpoints that might return raw strings or unstructured error responses.
15. Confirm all new public endpoints (those without requireRole middleware) are intentionally public and do not expose tenant data without scope checks.
16. Start the dev server. Open the full app. Navigate through: login → booking portal → seat selection → e-ticket → agent POS → operator dashboard → dispatcher dashboard → driver view. Confirm no crashes or console errors in any of these views.

Report every issue found and every fix applied. After all checks pass, confirm: "Phase P15-TRANSPORT is verified. The WebWaka Transport Suite is implementation-complete."
```

---

*End of QA prompts. One QA prompt exists for each of the 15 implementation phases. Copy the prompt for a phase and paste it to a QA agent in the specified repo after that phase's implementation agent has completed its work.*
