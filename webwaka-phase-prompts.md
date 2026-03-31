# WebWaka — Phase Implementation Prompts

> **Purpose**: Each section below is a self-contained, copy-paste prompt for an agent to implement a specific phase. Each prompt specifies the target repo, the exact tasks, and all technical context needed.  
> **How to use**: Copy the entire block for a phase and paste it as the first message to an agent in the target repo. Do not start a phase until all phases it depends on are merged and deployed.  
> **Reference documents**: Both `webwaka-transport-research.md` and `webwaka-implementation-plan.md` exist in the `webwaka-transport` repo for full context.

---

## PROMPT — P01-CORE
**Target Repo**: `@webwaka/core` (the shared packages/core directory)  
**Depends on**: Nothing — start immediately  
**Unlocks**: P02-TRANSPORT and P04-TRANSPORT

---

```
You are implementing Phase P01-CORE of the WebWaka platform.
Target repo: @webwaka/core (packages/core/src/)

This phase makes four changes to the shared platform core package. Do not touch any other repo. Do all four tasks.

=== CONTEXT ===
WebWaka is a multi-repo Nigerian transport platform. @webwaka/core is the shared package imported by all repos. It currently exports: requireRole, requireTenant, getTenantId, jwtAuthMiddleware, verifyJWT, generateJWT, nanoid, formatKobo, publishEvent. The main file is packages/core/src/index.ts.

=== TASK P01-T1: Consolidate ID Generation ===
Problem: Two ID generators exist — genId() in webwaka-transport/src/api/types.ts and nanoid() in @webwaka/core. We need to standardize on nanoid in core.

Steps:
1. In packages/core/src/index.ts, verify that nanoid(prefix, length) is exported. Add a JSDoc comment: "Cloudflare Worker-compatible nanoid. Uses crypto.getRandomValues. prefix is prepended to the ID. Default length 21."
2. Also export: export const genId = nanoid; — this alias allows the transport repo to migrate without breaking during transition.
3. Bump the package version in packages/core/package.json (minor version bump).
4. Run tsc --noEmit to verify zero type errors.

=== TASK P01-T2: Promote Shared Query Helpers to Core ===
Problem: parsePagination(), metaResponse(), and applyTenantScope() are defined only in the transport repo but are generic enough for any repo.

Steps:
1. Add to packages/core/src/index.ts (or a new file packages/core/src/query-helpers.ts, re-exported from index.ts):

export function parsePagination(q: Record<string, string>, maxLimit = 100): { limit: number; offset: number } {
  const limit = Math.min(Math.max(parseInt(q.limit ?? '20', 10) || 20, 1), maxLimit);
  const offset = Math.max(parseInt(q.offset ?? '0', 10) || 0, 0);
  return { limit, offset };
}

export function metaResponse<T>(data: T[], total: number, limit: number, offset: number) {
  return {
    data,
    meta: {
      total,
      limit,
      offset,
      has_more: offset + limit < total,
    },
  };
}

export function applyTenantScope(
  baseQuery: string,
  params: unknown[],
  tenantId: string,
  column = 'operator_id'
): { query: string; params: unknown[] } {
  const hasWhere = /\bWHERE\b/i.test(baseQuery);
  const clause = hasWhere ? ` AND ${column} = ?` : ` WHERE ${column} = ?`;
  return { query: baseQuery + clause, params: [...params, tenantId] };
}

2. Export all three from packages/core/src/index.ts.
3. Run tsc --noEmit.

=== TASK P01-T3: Add NDPR Consent Utility to Core ===
Problem: NDPR consent is checked inconsistently across repos. A shared utility ensures uniformity.

Steps:
1. Create packages/core/src/ndpr.ts:

import type { D1Database } from '@cloudflare/workers-types';

export interface NdprConsentLog {
  id: string;
  entity_id: string;
  entity_type: string;
  consented_at: number;
  ip_address: string | null;
  user_agent: string | null;
  created_at: number;
}

export function assertNdprConsent(body: unknown): void {
  if (typeof body !== 'object' || body === null || (body as Record<string, unknown>).ndpr_consent !== true) {
    const err = new Error('NDPR consent is required');
    (err as any).status = 400;
    (err as any).code = 'NDPR_CONSENT_REQUIRED';
    throw err;
  }
}

export async function recordNdprConsent(
  db: D1Database,
  entityId: string,
  entityType: string,
  ipAddress: string | null,
  userAgent: string | null
): Promise<void> {
  const now = Date.now();
  await db.prepare(
    `INSERT OR IGNORE INTO ndpr_consent_log (id, entity_id, entity_type, consented_at, ip_address, user_agent, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).bind(`ndpr_${now}_${Math.random().toString(36).slice(2, 7)}`, entityId, entityType, now, ipAddress, userAgent, now).run();
}

2. Re-export from packages/core/src/index.ts: export * from './ndpr';
3. Run tsc --noEmit.

=== TASK P01-T4: Add API Key Authentication Support to jwtAuthMiddleware ===
Problem: There is no way for third-party systems to authenticate without a user JWT. API keys are the standard B2B mechanism.

Steps:
1. Add verifyApiKey to packages/core/src/index.ts (or a new auth-helpers.ts re-exported from index):

export async function verifyApiKey(
  rawKey: string,
  db: D1Database
): Promise<WakaUser | null> {
  const encoder = new TextEncoder();
  const data = encoder.encode(rawKey);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const keyHash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  const row = await db.prepare(
    `SELECT ak.*, o.name as operator_name FROM api_keys ak
     JOIN operators o ON o.id = ak.operator_id
     WHERE ak.key_hash = ? AND ak.revoked_at IS NULL AND ak.deleted_at IS NULL`
  ).bind(keyHash).first<{
    id: string; operator_id: string; scope: string;
    operator_name: string;
  }>();

  if (!row) return null;

  // Non-blocking: update last_used_at
  db.prepare(`UPDATE api_keys SET last_used_at = ? WHERE id = ?`)
    .bind(Date.now(), row.id).run().catch(() => {});

  return {
    id: row.id,
    tenant_id: row.operator_id,
    role: row.scope === 'read_write' ? 'TENANT_ADMIN' : 'STAFF',
    name: `api_key:${row.id}`,
    phone: '',
    operator_id: row.operator_id,
  } as WakaUser;
}

2. In jwtAuthMiddleware, before JWT verification, check for Authorization: ApiKey {key} header:

const authHeader = c.req.header('Authorization') ?? '';
if (authHeader.startsWith('ApiKey ')) {
  const rawKey = authHeader.slice(7).trim();
  const user = await verifyApiKey(rawKey, (c.env as any).DB);
  if (!user) return c.json({ error: 'Invalid API key' }, 401);
  c.set('user', user);
  return next();
}

3. Export verifyApiKey from the index.
4. Run tsc --noEmit. Ensure WakaUser type includes operator_id field (add it if missing).

=== DONE ===
After all four tasks: bump core package version, run tsc --noEmit, confirm zero errors. The webwaka-transport repo will be updated to use these exports in the next phase.
```

---

## PROMPT — P02-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P01-CORE must be merged and deployed  
**Unlocks**: P03-TRANSPORT

---

```
You are implementing Phase P02-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This phase fixes two critical bugs and introduces the foundational DB schema for all future phases. Read webwaka-implementation-plan.md for full context.

Platform invariants you must preserve:
- All monetary values are stored as kobo (integers). Never use floats for money.
- All timestamps are Unix milliseconds (integers). Never use ISO strings in DB.
- Every write endpoint must check for NDPR consent where customer PII is involved.
- Every API route uses tenant scoping via applyTenantScope or equivalent.
- Event-driven: every significant state change publishes a platform_event.

=== TASK P02-T1: Wire Offline Agent Transaction Sync to SyncEngine ===

File: src/core/offline/sync.ts
File: src/core/offline/db.ts

In sync.ts, inside the flush() method, after the existing mutations loop, add a second phase for offline transactions:

  const pendingTx = await this.db.getPendingTransactions();
  for (const tx of pendingTx) {
    try {
      const response = await fetch('/api/agent-sales/sync', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${this.authToken}`,
          'X-Idempotency-Key': tx.idempotencyKey,
        },
        body: JSON.stringify({ transactions: [tx] }),
      });
      if (response.ok || response.status === 409) {
        await this.db.markTransactionSynced(tx.id);
      } else {
        await this.db.incrementTransactionRetry(tx.id);
      }
    } catch {
      // network error — will retry on next flush
    }
  }

In db.ts:
1. Add markTransactionSynced(id: string): Promise<void> — sets synced_at = Date.now() on the transaction row.
2. Add incrementTransactionRetry(id: string): Promise<void> — increments retry_count on the transaction row. If retry_count >= 5, set an error_at timestamp.
3. Add idempotencyKey field to the transactions Dexie schema. If the transactions table is currently at schema version 1, add a schema upgrade: version 2 adds idempotencyKey with default `tx_${Date.now()}_${Math.random().toString(36).slice(2)}`.
4. Verify getPendingTransactions() returns transactions where synced_at IS NULL and retry_count < 5.

=== TASK P02-T2: Multi-Seat Atomic Reservation Batch Endpoint ===

File: src/api/seat-inventory.ts

Add this route to the seat inventory Hono router:

POST /api/seat-inventory/trips/:tripId/reserve-batch

Request body: { seat_ids: string[], user_id: string, idempotency_key: string }

Implementation:
1. Check idempotency key in IDEMPOTENCY_KV. Return cached response if present.
2. Read all requested seats in one query: SELECT id, status, version FROM seats WHERE trip_id = ? AND id IN ({placeholders}) AND deleted_at IS NULL
3. If any seat is not 'available', return 409: { error: 'seat_unavailable', seat_id: '{first_unavailable_id}', message: 'One or more seats are not available' }
4. For each seat, generate reservation token: nanoid('tok', 32) from @webwaka/core.
5. Compute reservation_expires_at: Date.now() + 30000 (will be made configurable in P03-T1).
6. Build a D1 batch() of UPDATE statements, one per seat:
   UPDATE seats SET status='reserved', reserved_by=?, reservation_token=?, reservation_expires_at=?, version=version+1, updated_at=?
   WHERE id=? AND status='available' AND version=?
   (include the version for optimistic locking)
7. Execute the batch. For each result, check meta.changes. If any result has changes=0, the seat was taken between read and write.
   - In that case: run a second batch to release any seats that succeeded (UPDATE seats SET status='available', reserved_by=NULL, reservation_token=NULL, reservation_expires_at=NULL WHERE id=? AND reservation_token=?)
   - Return 409: { error: 'concurrent_conflict', message: 'Seat taken by another agent — please retry' }
8. Publish platform event: publishEvent(env.DB, { event_type: 'seat.batch_reserved', aggregate_id: tripId, aggregate_type: 'trip', payload: { trip_id: tripId, seat_ids, user_id, tokens }, tenant_id: operatorId })
9. Cache the success response in IDEMPOTENCY_KV with 24h TTL.
10. Return 200: { tokens: [ { seat_id, token, expires_at }, ... ] }

=== TASK P02-T3: Schema Migration 002 ===

Create file: migrations/002_phase2_tables.sql

This migration creates all the new tables needed for Phases P02 through P11. Copy the exact SQL from webwaka-implementation-plan.md section "Phase P02-TRANSPORT > P02-T3: Schema Migration for New Tables".

After creating the file:
1. Register migration 002 in src/api/admin.ts migration runner (look at how migration 001 is registered and follow the same pattern).
2. Run wrangler d1 execute DB --local --file=migrations/002_phase2_tables.sql to verify zero SQL errors.
3. Fix any SQL syntax errors until the migration runs cleanly.

Note on ALTER TABLE: Cloudflare D1/SQLite does not support all ALTER TABLE operations. If ADD COLUMN IF NOT EXISTS fails, use a TRY/CATCH or check the D1 docs. Use separate statements for each column addition.

=== DONE ===
After all three tasks: verify tsc --noEmit passes, run npm run dev:ui and confirm the app still loads without runtime errors.
```

---

## PROMPT — P03-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P02-TRANSPORT must be merged and deployed  
**Unlocks**: P05-TRANSPORT (partial)

---

```
You are implementing Phase P03-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This phase builds the complete payment and confirmation flow: configurable TTL, seat hold extension, Paystack inline payment, SMS confirmation, e-ticket with QR boarding pass, and guest booking. Read webwaka-implementation-plan.md for full context.

Platform invariants:
- All monetary values in kobo (integers). Never floats.
- All timestamps as Unix milliseconds integers.
- Non-fatal policy: SMS, push, and AI failures must never block the user's booking journey.
- NDPR consent is a hard gate on all customer PII creation.

=== TASK P03-T1: Configurable Reservation TTL via Operator Config ===

File: src/api/seat-inventory.ts
File: src/api/operator-management.ts

1. Create a shared helper getOperatorConfig(env: Env, operatorId: string): Promise<OperatorConfig>:
   - Reads from TENANT_CONFIG_KV using operatorId as the key
   - Parses JSON, applies defaults for any missing fields
   - Default OperatorConfig: { reservation_ttl_ms: 30000, online_reservation_ttl_ms: 180000, abandonment_window_ms: 1800000, surge_multiplier_cap: 2.0, boarding_window_minutes: 30, parcel_acceptance_enabled: false, cancellation_policy: { free_before_hours: 24, half_refund_before_hours: 12 }, emergency_contact_phone: '', sos_escalation_email: '', inspection_required_before_boarding: false }

2. In POST /api/seat-inventory/trips/:id/reserve (existing single-seat reserve endpoint):
   - Call getOperatorConfig(env, operatorId)
   - If request Origin header is present (web browser request), use online_reservation_ttl_ms
   - If no Origin header (agent POS request), use reservation_ttl_ms
   - Apply the TTL to reservation_expires_at

3. Apply the same TTL logic in the reserve-batch endpoint from P02-T2.

4. Add GET /api/operator/config: returns getOperatorConfig(env, authenticatedOperatorId) as JSON.

5. Add PUT /api/operator/config (TENANT_ADMIN+):
   - Validates the submitted JSON matches OperatorConfig shape (check all required fields exist and are the right types)
   - Writes to TENANT_CONFIG_KV: await env.TENANT_CONFIG_KV.put(operatorId, JSON.stringify(config))
   - Publishes platform event: operator.config_updated
   - Returns 200 with the saved config

=== TASK P03-T2: Seat Hold Extension Heartbeat Endpoint ===

File: src/api/seat-inventory.ts

Add POST /api/seat-inventory/trips/:tripId/extend-hold

Request body: { seat_id: string, token: string }

Logic:
1. SELECT status, reservation_token, reservation_expires_at FROM seats WHERE id = ? AND trip_id = ?
2. If status !== 'reserved' OR reservation_token !== body.token: return 409 { error: 'invalid_hold', message: 'Hold is invalid or does not belong to you' }
3. If reservation_expires_at < Date.now(): return 410 { error: 'hold_expired', message: 'Reservation has expired. Please rebook.' }
4. Read operator config to get online_reservation_ttl_ms (extension increment).
5. Define MAX_HOLD_MS = 10 * 60 * 1000 (10 minutes).
6. Compute original_reserved_at: reservation_expires_at - online_reservation_ttl_ms (approximate).
7. Compute new_expires_at = Math.min(Date.now() + online_reservation_ttl_ms, original_reserved_at + MAX_HOLD_MS).
8. If new_expires_at <= Date.now(): return 410 { error: 'max_hold_reached', message: 'Maximum hold time reached.' }
9. UPDATE seats SET reservation_expires_at = ? WHERE id = ? AND reservation_token = ?
10. Return 200: { expires_at: new_expires_at }

=== TASK P03-T3: Paystack Inline Popup SDK Integration ===

Files: index.html, and the booking confirmation React component (wherever the "Pay Now" button exists)

1. Add to index.html <head>: <script src="https://js.paystack.co/v1/inline.js"></script>

2. In the booking confirmation component, replace any external redirect payment initiation with:

const handlePayNow = () => {
  const paystackPopup = (window as any).PaystackPop.setup({
    key: import.meta.env.VITE_PAYSTACK_PUBLIC_KEY,
    email: customerEmail || 'guest@webwaka.ng',
    amount: bookingTotalKobo,
    ref: paymentReference,
    currency: 'NGN',
    onSuccess: async (transaction: { reference: string }) => {
      // Confirm the booking on our server
      await fetch(`/api/booking/bookings/${bookingId}/confirm`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
        body: JSON.stringify({ payment_reference: transaction.reference }),
      });
      // Navigate to e-ticket
      window.location.href = `/b/${bookingId}`;
    },
    onClose: async () => {
      // Extend the seat hold while user is still on the page
      if (seatHoldToken) {
        await fetch(`/api/seat-inventory/trips/${tripId}/extend-hold`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${authToken}` },
          body: JSON.stringify({ seat_id: seatId, token: seatHoldToken }),
        }).catch(() => {});
      }
    },
  });
  paystackPopup.openIframe();
};

3. Add VITE_PAYSTACK_PUBLIC_KEY to .env.example with a placeholder value. Never commit the real key.
4. Ensure POST /api/booking/bookings response includes payment_reference (a server-generated Paystack reference string: `waka_${nanoid('', 16)}`).

=== TASK P03-T4: SMS Booking Confirmation Wire-Up ===

File: src/lib/sweepers.ts
File: src/lib/sms.ts

1. First, verify src/lib/sms.ts has a complete working sendSms(to: string, message: string, env: Env): Promise<void> implementation using the Termii API:

export async function sendSms(to: string, message: string, env: { TERMII_API_KEY?: string }): Promise<void> {
  if (!env.TERMII_API_KEY) {
    console.warn('[sms] TERMII_API_KEY not configured — SMS skipped');
    return;
  }
  const response = await fetch('https://api.ng.termii.com/api/sms/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      to,
      from: 'WebWaka',
      sms: message,
      type: 'plain',
      channel: 'generic',
      api_key: env.TERMII_API_KEY,
    }),
  });
  if (!response.ok) {
    const err = await response.text().catch(() => `HTTP ${response.status}`);
    console.error(`[sms] Send failed: ${err}`);
    // Non-fatal: do not throw
  }
}

2. In drainEventBus() in sweepers.ts, replace the booking:CONFIRMED / booking.created handler console.log placeholder with:

if (eventType === 'booking.created' || eventType === 'booking:CONFIRMED') {
  try {
    const payload = JSON.parse(String(evt['payload'] ?? '{}')) as Record<string, unknown>;
    const phone = String(payload['customer_phone'] ?? '');
    const origin = String(payload['origin'] ?? '');
    const destination = String(payload['destination'] ?? '');
    const departureDate = payload['departure_date'] ? new Date(Number(payload['departure_date'])).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short' }) : '';
    const seats = String(payload['seat_numbers'] ?? '');
    const bookingId = String(payload['booking_id'] ?? evt['aggregate_id'] ?? '');
    const shortId = bookingId.slice(-8).toUpperCase();
    const message = `WebWaka: Booking confirmed! ${origin} → ${destination}, ${departureDate}, Seat(s): ${seats}. Ref: ${shortId}. View: https://webwaka.ng/b/${bookingId}`;
    if (phone) await sendSms(phone, message, env);
  } catch (err) {
    console.error('[EventBus] SMS send error:', err instanceof Error ? err.message : err);
  }
  return;
}

3. In booking-portal.ts, update the publishEvent call on booking confirmation to include customer_phone, origin, destination, departure_date, seat_numbers, booking_id in the payload.

=== TASK P03-T5: E-Ticket Page with QR Boarding Pass ===

File: src/worker.ts (or Hono router) — add public /b/:bookingId route
File: src/pages/ticket.tsx — new React component

1. Add public API endpoint GET /b/:bookingId in worker.ts (no auth required):
   - SELECT b.*, t.departure_time, t.current_latitude, t.current_longitude, r.origin, r.destination, o.name as operator_name, s.seat_number FROM bookings b JOIN trips t ON t.id = b.trip_id JOIN routes r ON r.id = t.route_id JOIN operators o ON o.id = t.operator_id LEFT JOIN seats s ON s.id IN (b.seat_ids) WHERE b.id = ? AND b.status = 'confirmed' AND b.deleted_at IS NULL
   - Return 404 for non-confirmed or not-found bookings
   - Return booking detail as JSON (for the React page to consume)

2. Install a lightweight browser-compatible QR code library. Use qrcode (npm package) which works in browser environments. Run: npm install qrcode @types/qrcode

3. Create src/pages/ticket.tsx:
   - Fetches booking data from GET /b/:bookingId
   - Renders: operator name, "WebWaka Transport" header, route (origin ⟶ destination) in large text, departure date and time, seat number(s), passenger name(s), booking reference (last 8 chars uppercased), QR code
   - QR code data: `${bookingId}:${seatIds.join(',')}` — use QRCode.toCanvas or QRCode.toDataURL
   - WhatsApp share button: wa.me/?text={urlencode(receipt_summary)}
   - @media print CSS: white background, no navigation, clean layout, 80mm max-width option
   - Add a Download/Print button

4. Register the /b/:bookingId route in the React Router (src/app.tsx) as a public route that does not require authentication.

=== TASK P03-T6: Guest Booking (Phone-Number-Only) ===

File: src/api/booking-portal.ts
File: src/api/auth.ts

1. Add POST /api/booking/verify-phone (public):
   - Body: { phone: string }
   - Validates phone format (Nigerian numbers: starts with +234 or 0, 11 digits)
   - Generates 6-digit OTP, stores in SESSIONS_KV with key guest_otp_{phone}, TTL 10 minutes
   - Sends OTP via SMS using sendSms
   - Returns 200 { message: 'OTP sent' }

2. Add POST /api/booking/verify-phone/confirm (public):
   - Body: { phone: string, otp: string }
   - Reads from SESSIONS_KV: guest_otp_{phone}
   - If match: delete the KV entry, return a short-lived guest JWT (15-minute TTL) with role: 'CUSTOMER' and a generated guest customer ID
   - If no match or expired: return 401

3. Modify POST /api/booking/bookings to accept a guest JWT (same jwtAuthMiddleware flow):
   - If user.id starts with 'guest_': create a minimal customer record: { id: user.id, name: passengerNames[0], phone: user.phone, email: null, ndpr_consent: true }
   - Flag the booking record: is_guest = 1
   - Proceed with the normal booking flow

4. Add is_guest INTEGER DEFAULT 0 to the bookings table (add to migration 002 if not already there, or migration 003).

=== DONE ===
After all six tasks: run tsc --noEmit. Start the dev server and manually test:
1. The seat hold extension returns a new expires_at.
2. The /b/{bookingId} page renders for a confirmed booking.
3. The operator config PUT/GET roundtrip works.
```

---

## PROMPT — P04-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P01-CORE must be merged and deployed  
**Can run in parallel with P03-TRANSPORT**  
**Unlocks**: P05-TRANSPORT, P07-TRANSPORT, P08-TRANSPORT

---

```
You are implementing Phase P04-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This phase builds the full Operator Config Service and the Automated Schedule Engine. These are foundational for Phases P05, P07, and P08. Read webwaka-implementation-plan.md for full context.

=== TASK P04-T1: Full Operator Config Service ===

This expands the lightweight config helper from P03-T1 into the definitive config service.

File: src/api/operator-management.ts
File: src/core/offline/db.ts
File: src/api/types.ts

1. Define OperatorConfig interface in src/api/types.ts:

export interface OperatorConfig {
  reservation_ttl_ms: number;
  online_reservation_ttl_ms: number;
  abandonment_window_ms: number;
  surge_multiplier_cap: number;
  boarding_window_minutes: number;
  parcel_acceptance_enabled: boolean;
  cancellation_policy: {
    free_before_hours: number;
    half_refund_before_hours: number;
  };
  emergency_contact_phone: string;
  sos_escalation_email: string;
  inspection_required_before_boarding: boolean;
}

export const DEFAULT_OPERATOR_CONFIG: OperatorConfig = {
  reservation_ttl_ms: 30_000,
  online_reservation_ttl_ms: 180_000,
  abandonment_window_ms: 1_800_000,
  surge_multiplier_cap: 2.0,
  boarding_window_minutes: 30,
  parcel_acceptance_enabled: false,
  cancellation_policy: { free_before_hours: 24, half_refund_before_hours: 12 },
  emergency_contact_phone: '',
  sos_escalation_email: '',
  inspection_required_before_boarding: false,
};

2. Create a shared server-side helper getOperatorConfig(env: Env, operatorId: string): Promise<OperatorConfig>:
   - Reads TENANT_CONFIG_KV.get(operatorId, { type: 'json' })
   - Merges result with DEFAULT_OPERATOR_CONFIG (spread: { ...DEFAULT_OPERATOR_CONFIG, ...stored })
   - Cache the result in a module-level Map with a 60-second TTL (optional optimization)

3. In operator-management.ts, add:
   - GET /api/operator/config — calls getOperatorConfig, returns config
   - PUT /api/operator/config (TENANT_ADMIN+) — validates, writes to TENANT_CONFIG_KV, publishes operator.config_updated event
   
4. In src/core/offline/db.ts:
   - Add getLocalOperatorConfig(): Promise<OperatorConfig | null> — reads from Dexie operator_config table, checks TTL (1 hour)
   - Add saveLocalOperatorConfig(config: OperatorConfig): Promise<void> — writes to Dexie with timestamp
   
5. In the PWA app initialization (src/app.tsx or equivalent), after login, fetch the operator config from the API and save it locally via saveLocalOperatorConfig.

=== TASK P04-T2: Automated Schedule Engine ===

File: src/api/operator-management.ts — schedule CRUD routes
File: src/lib/sweepers.ts — generateScheduledTrips function
File: src/worker.ts — wire to cron

1. Add schedule CRUD to operator-management.ts:

POST /api/operator/schedules (TENANT_ADMIN+):
  Body: { route_id, vehicle_id?, driver_id?, departure_time: "HH:MM", recurrence: "daily"|"weekdays"|"weekends"|"custom", recurrence_days?: number[], horizon_days?: number }
  Validation: departure_time must match /^\d{2}:\d{2}$/. recurrence_days required if recurrence = 'custom'. horizon_days default 30, max 90.
  Insert into schedules table.
  After insert, immediately call generateScheduledTrips(env) filtered to this schedule to populate the next horizon_days of trips.
  Return the created schedule.

GET /api/operator/schedules:
  Returns all active schedules for the operator, ordered by departure_time.

PATCH /api/operator/schedules/:id (TENANT_ADMIN+):
  Allows updating vehicle_id, driver_id, departure_time, recurrence, recurrence_days, horizon_days, active.

DELETE /api/operator/schedules/:id (TENANT_ADMIN+):
  Soft deletes (sets deleted_at).

2. Add generateScheduledTrips(env: Env): Promise<void> to sweepers.ts:

export async function generateScheduledTrips(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();
  
  const schedules = await db.prepare(
    `SELECT s.*, r.base_fare_kobo, r.total_seats, r.operator_id
     FROM schedules s JOIN routes r ON r.id = s.route_id
     WHERE s.active = 1 AND s.deleted_at IS NULL`
  ).all<Record<string, unknown>>();
  
  if (!schedules.results?.length) return;
  
  let tripsGenerated = 0;
  
  for (const schedule of schedules.results) {
    const horizonDays = Number(schedule.horizon_days) || 30;
    const [hStr, mStr] = String(schedule.departure_time).split(':');
    const depHour = parseInt(hStr, 10);
    const depMin = parseInt(mStr, 10);
    const recurrence = String(schedule.recurrence);
    const recurrenceDays: number[] = schedule.recurrence_days
      ? JSON.parse(String(schedule.recurrence_days))
      : [0, 1, 2, 3, 4, 5, 6];
    
    for (let d = 0; d < horizonDays; d++) {
      const date = new Date(now + d * 86_400_000);
      const dayOfWeek = date.getUTCDay();
      
      // Determine if this day is scheduled
      const isScheduled =
        recurrence === 'daily' ||
        (recurrence === 'weekdays' && dayOfWeek >= 1 && dayOfWeek <= 5) ||
        (recurrence === 'weekends' && (dayOfWeek === 0 || dayOfWeek === 6)) ||
        (recurrence === 'custom' && recurrenceDays.includes(dayOfWeek));
      
      if (!isScheduled) continue;
      
      // Compute departure timestamp for this date
      const depMs = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate(), depHour, depMin, 0, 0);
      if (depMs < now) continue; // Skip past departures
      
      // Check if a trip already exists for this route + vehicle + departure time
      const existing = await db.prepare(
        `SELECT id FROM trips WHERE route_id = ? AND vehicle_id = ? AND departure_time = ? AND deleted_at IS NULL`
      ).bind(schedule.route_id, schedule.vehicle_id ?? null, depMs).first();
      
      if (existing) continue;
      
      // Generate the trip + seats (reuse the trip creation logic)
      const tripId = `trp_${Date.now()}_${Math.random().toString(36).slice(2, 7)}`;
      const totalSeats = Number(schedule.total_seats) || 45;
      
      const seatInserts = Array.from({ length: totalSeats }, (_, i) => {
        const seatId = `seat_${tripId}_${i + 1}`;
        return db.prepare(
          `INSERT INTO seats (id, trip_id, operator_id, seat_number, seat_class, status, created_at)
           VALUES (?, ?, ?, ?, 'standard', 'available', ?)`
        ).bind(seatId, tripId, schedule.operator_id, String(i + 1), now);
      });
      
      await db.batch([
        db.prepare(
          `INSERT INTO trips (id, operator_id, route_id, vehicle_id, driver_id, departure_time, total_seats, state, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'scheduled', ?)`
        ).bind(tripId, schedule.operator_id, schedule.route_id, schedule.vehicle_id ?? null, schedule.driver_id ?? null, depMs, totalSeats, now),
        ...seatInserts,
      ]);
      
      tripsGenerated++;
    }
  }
  
  if (tripsGenerated > 0) {
    console.log(`[ScheduleEngine] Generated ${tripsGenerated} trips`);
  }
}

3. In src/worker.ts, in the scheduled() handler for the daily cron (cron: '0 0 * * *'), add:
   await generateScheduledTrips(env);

=== DONE ===
Run tsc --noEmit. Confirm zero errors. Test that POST /api/operator/schedules creates a schedule and immediately generates trips for the next 30 days.
```

---

## PROMPT — P05-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P02-TRANSPORT AND P04-TRANSPORT must both be merged and deployed  
**Unlocks**: P06-TRANSPORT, P09-TRANSPORT

---

```
You are implementing Phase P05-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This phase builds the core trip operations layer: GPS location tracking, SOS system, digital boarding scan, manifest export, pre-trip inspection, and delay reporting. Read webwaka-implementation-plan.md for full context.

=== TASK P05-T1: GPS Location Update Endpoint ===
File: src/api/operator-management.ts

Add POST /api/operator/trips/:id/location (DRIVER role+):
- Body: { latitude: number, longitude: number, accuracy_meters?: number }
- Validate: latitude ∈ [-90, 90], longitude ∈ [-180, 180], both must be numbers
- SELECT id, state, operator_id FROM trips WHERE id = ? AND deleted_at IS NULL
- If not found: 404. If state = 'completed' or 'cancelled': 422 { error: 'trip_not_active' }
- Apply tenant scope (only the trip's operator can update it)
- UPDATE trips SET current_latitude = ?, current_longitude = ?, location_updated_at = ? WHERE id = ?
- Publish platform event: trip.location_updated with { trip_id, lat, lng, updated_at }
- Return 204 No Content

Add location_updated_at INTEGER column to trips in migration 003 (create this file if it doesn't exist).

Extend GET /api/operator/trips/:id response to include current_latitude, current_longitude, location_updated_at.
Extend GET /api/booking/bookings/:id response to include these same trip location fields (for passenger tracking).

=== TASK P05-T2: SOS Trigger and Clear Endpoints ===
File: src/api/operator-management.ts
File: src/lib/sweepers.ts

Add POST /api/operator/trips/:id/sos (DRIVER role+):
1. SELECT id, sos_active, operator_id, route_id FROM trips WHERE id = ? AND deleted_at IS NULL
2. If sos_active = 1: return 409 { error: 'sos_already_active' }
3. UPDATE trips SET sos_active = 1, sos_triggered_at = ?, sos_triggered_by = ? WHERE id = ?
4. Get operator config: emergency_contact_phone and sos_escalation_email
5. Send SMS to emergency_contact_phone: "🚨 SOS ALERT: Driver triggered emergency on Trip {tripId}, Route {route}. Time: {time}. Check dispatch dashboard immediately."
6. Publish platform event: trip:SOS_ACTIVATED with full trip context
7. Return 200 { message: 'SOS activated. Emergency contacts notified.' }

Add POST /api/operator/trips/:id/sos/clear (SUPERVISOR role+):
1. SELECT id, sos_active FROM trips WHERE id = ?
2. If sos_active = 0: return 409 { error: 'no_active_sos' }
3. UPDATE trips SET sos_active = 0, sos_cleared_at = ?, sos_cleared_by = ? WHERE id = ?
4. Publish platform event: trip:SOS_CLEARED
5. Return 200 { message: 'SOS cleared.' }

In drainEventBus() in sweepers.ts, add handler for trip:SOS_ACTIVATED:
- Log as console.error (critical)
- Non-fatal email alert if SENDGRID_API_KEY is configured
- Do NOT suppress — this is the one event type that should never be silently dropped

=== TASK P05-T3: Digital Boarding Scan Endpoint ===
File: src/api/operator-management.ts

Add POST /api/operator/trips/:id/board (STAFF role+):
- Body: { qr_payload: string } where qr_payload = "{bookingId}:{seatId1},{seatId2}"
- Parse qr_payload: const [bookingId, seatsStr] = qr_payload.split(':'); const seatIds = seatsStr.split(',');
- Validate: both parts must be present and non-empty. Return 400 if malformed.
- Query:
  SELECT b.id, b.passenger_names, b.boarded_at, b.status, b.trip_id,
         GROUP_CONCAT(s.seat_number) as seat_numbers
  FROM bookings b
  LEFT JOIN seats s ON s.booking_id = b.id
  WHERE b.id = ? AND b.trip_id = ? AND b.deleted_at IS NULL
  GROUP BY b.id
- If not found: 404 { error: 'invalid_ticket', message: 'Ticket not found for this trip.' }
- If status != 'confirmed': 422 { error: 'booking_not_confirmed', status: booking.status }
- If boarded_at IS NOT NULL: 409 { error: 'already_boarded', boarded_at: booking.boarded_at, message: 'This passenger has already boarded.' }
- UPDATE bookings SET boarded_at = ?, boarded_by = ? WHERE id = ?
- Publish platform event: booking.boarded
- Return 200 { passenger_names: [...], seat_numbers: '...', boarded_at: timestamp, message: 'Welcome aboard!' }

Add GET /api/operator/trips/:id/boarding-status (STAFF role+):
- Returns { total_confirmed: N, total_boarded: N, remaining: N, last_boarded_at: timestamp }
- Query: SELECT COUNT(*) as total, SUM(CASE WHEN boarded_at IS NOT NULL THEN 1 ELSE 0 END) as boarded, MAX(boarded_at) as last_boarded FROM bookings WHERE trip_id = ? AND status = 'confirmed' AND deleted_at IS NULL

=== TASK P05-T4: Trip Manifest Export ===
File: src/api/operator-management.ts

Extend GET /api/operator/trips/:id/manifest:
1. Current response returns basic manifest. Extend it to include for each booking:
   - passenger_names array
   - seat_numbers (comma-separated)
   - boarded_at (null if not yet boarded)
   - payment_method
   - passenger_id_type (if captured, not the hash)
   - booking_id (for QR generation)
2. Add content negotiation: check Accept header. If 'text/csv':
   - Build CSV string: "Seat,Passenger Name,Boarded,Payment Method,ID Type,Booking Ref\n" + rows
   - Return Response with Content-Type: text/csv and Content-Disposition: attachment; filename=manifest_{tripId}_{date}.csv
3. Frontend manifest component: add "Export CSV" and "Print Manifest" buttons. Each manifest row should display a QR code (encoded as `{bookingId}:{seatId}`) generated client-side. Add a "Boarded" column with ✓ or ○.

=== TASK P05-T5: Pre-Trip Inspection Checklist ===
File: src/api/operator-management.ts

Add POST /api/operator/trips/:id/inspection (DRIVER role+):
- Body: { tires_ok: boolean, brakes_ok: boolean, lights_ok: boolean, fuel_ok: boolean, emergency_equipment_ok: boolean, manifest_count?: number, notes?: string }
- Validate all boolean fields are true (if any is false, the inspection fails — return 422 with the specific failed item)
- Check no existing inspection: SELECT id FROM trip_inspections WHERE trip_id = ? — if exists return 409
- INSERT into trip_inspections
- UPDATE trips SET inspection_completed_at = ? WHERE id = ?
- Publish platform event: trip.inspection_completed
- Return 200 with the inspection record

Add GET /api/operator/trips/:id/inspection (STAFF role+):
- Returns the inspection record or null

In the trip state transition endpoint (PATCH /api/operator/trips/:id/state), when transitioning from 'scheduled' to 'boarding':
- Read operator config: inspection_required_before_boarding
- If true and inspection_completed_at IS NULL on the trip: return 422 { error: 'inspection_required', message: 'Pre-trip inspection must be completed before boarding.' }

=== TASK P05-T6: Delay Reporting with Passenger Notification ===
File: src/api/operator-management.ts
File: src/lib/sweepers.ts
File: migrations/ (003 file)

Add columns to trips in migration 003:
  delay_reason_code TEXT, delay_reported_at INTEGER, estimated_departure_ms INTEGER

Add POST /api/operator/trips/:id/delay (SUPERVISOR role+):
- Body: { reason_code: 'traffic'|'breakdown'|'weather'|'accident'|'fuel'|'other', reason_details?: string, estimated_departure_ms: number }
- Validate: reason_code must be one of the allowed values. estimated_departure_ms must be in the future.
- UPDATE trips SET delay_reason_code = ?, delay_reported_at = ?, estimated_departure_ms = ? WHERE id = ?
- Get all confirmed bookings with customer phone: SELECT b.id, c.phone as customer_phone FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.trip_id = ? AND b.status = 'confirmed' AND b.deleted_at IS NULL
- Publish platform event: trip:DELAYED with payload { trip_id, reason_code, estimated_departure_ms, affected_booking_count }
- Return 200 with delay record

In drainEventBus() in sweepers.ts, add handler for trip:DELAYED:
- Parse payload to get affected_booking_ids (or re-query confirmed bookings for the trip)
- For each customer phone, send SMS: "WebWaka: Your trip {route} on {date} has been delayed. Reason: {reason}. New est. departure: {time}. We apologize for the inconvenience."
- Non-fatal: log send failures, do not rethrow
- Limit SMS batch to 100 per event cycle to avoid rate limits

Add GET /api/operator/trips/:id/delay (STAFF role+):
- Returns { delay_reason_code, delay_reported_at, estimated_departure_ms } or null

=== DONE ===
Run tsc --noEmit. Run migration 003 locally. Test all 6 endpoints manually. Confirm SOS SMS sends (mock the Termii call in dev if no key is present — it should log a warning and continue).
```

---

## PROMPT — P06-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P05-TRANSPORT must be merged and deployed  
**Unlocks**: P09-TRANSPORT (partial)

---

```
You are implementing Phase P06-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This phase completes the Driver Mobile Experience — a full driver-facing view that packages all P05 endpoints into a usable mobile interface. Read webwaka-implementation-plan.md for full context.

=== TASK P06-T1: Complete Driver View ===

File: src/components/driver-view.tsx (extend existing component)
File: src/app.tsx (ensure DRIVER role routes correctly)

The DriverView must have these five tabs/sections. Build each as a sub-component:

1. MY TRIPS TAB (DriverTripList):
   - Fetches GET /api/operator/trips?driver_id=me
   - Lists trips with state badges (scheduled/boarding/in_transit/completed)
   - Tapping a trip navigates to Trip Detail view
   - Shows departure time, route, vehicle plate, seat count

2. TRIP DETAIL VIEW (DriverTripDetail):
   - Shows full trip info
   - If trip state = 'scheduled': shows "Start Inspection" button → opens inspection form
   - If trip state = 'boarding': shows "Scan Boarding Pass" and "View Manifest" buttons
   - If trip state = 'in_transit': shows GPS share toggle and "Report Delay" button
   - Shows inspection status badge: ✓ Inspected or ⚠ Not Inspected

3. INSPECTION FORM (DriverInspectionForm):
   - Checkbox list: Tires OK, Brakes OK, Lights OK, Fuel Adequate, Emergency Equipment Present
   - Notes text field (optional)
   - Manifest Count number field
   - All checkboxes must be checked before submit button activates
   - On submit: POST /api/operator/trips/:id/inspection
   - On success: navigate back to Trip Detail showing ✓ Inspected badge

4. BOARDING SCAN (DriverBoardingScan):
   - Camera QR scanner using getUserMedia + a lightweight QR decode library (install jsQR: npm install jsqr)
   - Opens camera feed, decodes QR in real time
   - On decode: POST /api/operator/trips/:id/board with { qr_payload: decoded_string }
   - On 200: show green success card with passenger name and seat number for 2 seconds, then re-open scanner
   - On 409 (already boarded): show amber warning card "Already boarded at {time}"
   - On 404 (invalid ticket): show red error card "Invalid ticket for this trip"
   - Shows running counter: "18 / 45 boarded" — updates after each scan
   - Works offline: if network is down, queue the boarding scan in Dexie mutations table for sync

5. GPS SHARE TOGGLE (DriverLocationShare):
   - Toggle button: "Share Location" (off by default)
   - When toggled on: request Geolocation permission (navigator.geolocation.watchPosition)
   - On each position update: POST /api/operator/trips/:id/location
   - Shows current coordinates and last update time
   - When toggled off: clears the watch
   - On geolocation permission denied: shows error "Please enable location access in browser settings"

6. SOS BUTTON (DriverSOS):
   - Prominent red button labeled "🚨 Emergency SOS"
   - Shows a confirmation dialog: "This will alert your operator and emergency contacts. Confirm?" with Cancel / SEND SOS buttons
   - On confirm: POST /api/operator/trips/:id/sos
   - After activation: shows full-screen red "SOS ACTIVE" banner that cannot be dismissed by the driver (only supervisor can clear it)
   - If SOS is already active (from GET /api/operator/trips/:id showing sos_active=1): show the banner immediately on load

7. DELAY REPORT (DriverDelayReport):
   - Dropdown for reason_code (Traffic, Breakdown, Weather, Accident, Fuel, Other)
   - Time picker for estimated_departure_ms
   - Optional details text field
   - Submit calls POST /api/operator/trips/:id/delay

In src/app.tsx: ensure that users with role='DRIVER' are routed to DriverView on login. DRIVER role should not see the operator admin dashboard.

All network calls from the driver view should handle offline gracefully: show a "You are offline — this will sync when connected" message where the action cannot be queued.

=== DONE ===
Run tsc --noEmit. Test on a mobile-sized viewport. Confirm the QR scanner works in the browser (getUserMedia requires HTTPS — in dev, Replit's proxy handles this). Confirm the GPS share toggle requests permission and calls the location endpoint.
```

---

## PROMPT — P07-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P04-TRANSPORT must be merged and deployed  
**Can run in parallel with P05-TRANSPORT and P06-TRANSPORT**  
**Unlocks**: P08-TRANSPORT

---

```
You are implementing Phase P07-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This phase builds the agent operations layer: float reconciliation, thermal receipt printing, multi-agent device management, bus park management, and passenger ID capture. Read webwaka-implementation-plan.md for full context.

=== TASK P07-T1: Agent Daily Float Reconciliation ===
File: src/api/agent-sales.ts
Frontend: agent POS

Add POST /api/agent-sales/reconciliation (AGENT role+):
- Body: { date: string (YYYY-MM-DD format), cash_submitted_kobo: number }
- Validate: date must match /^\d{4}-\d{2}-\d{2}$/. cash_submitted_kobo must be a positive integer.
- Check for existing reconciliation: SELECT id FROM float_reconciliation WHERE agent_id = ? AND period_date = ? — return 409 if already filed
- Compute expected: SELECT COALESCE(SUM(total_amount), 0) as expected FROM sales_transactions WHERE agent_id = ? AND strftime('%Y-%m-%d', datetime(created_at/1000, 'unixepoch')) = ? AND payment_method = 'cash' AND deleted_at IS NULL
- Compute discrepancy_kobo = expected_kobo - cash_submitted_kobo
- INSERT into float_reconciliation
- Publish event: agent.reconciliation_filed with { agent_id, date, expected_kobo, submitted_kobo, discrepancy_kobo }
- Return the reconciliation record with discrepancy highlighted

Add GET /api/agent-sales/reconciliation:
- AGENT role: returns their own reconciliations (last 30 days)
- SUPERVISOR+: returns all reconciliations for the operator (filterable by agent_id and date range)

Add PATCH /api/agent-sales/reconciliation/:id (SUPERVISOR+):
- Body: { status: 'approved'|'disputed', notes?: string }
- UPDATE float_reconciliation SET status = ?, reviewed_by = ?, reviewed_at = ?, notes = ? WHERE id = ?
- Return updated record

Frontend: add "End of Day" button in agent POS. Shows today's transaction summary (count and sum from the dashboard API). Prompts for physical cash count. Submits reconciliation. Shows result with discrepancy in red if > ₦500 (50,000 kobo).

=== TASK P07-T2: Thermal Receipt Printing ===
File: src/components/receipt.tsx (create new component)
File: Agent sale completion screen

1. Install QR code library: npm install qrcode @types/qrcode

2. Create src/components/receipt.tsx component:
Props: { receiptId: string, bookingId: string, operatorName: string, origin: string, destination: string, departureTime: number, seatNumbers: string[], passengerNames: string[], totalAmountKobo: number, paymentMethod: string }

Render:
- Header: operator name in bold, "WebWaka Transport" subtitle
- Route: "{origin} ──────────── {destination}"
- Date/Time: formatted departure
- Seat(s): seat numbers listed
- Passenger(s): names listed
- Amount: formatted with formatKobo from @webwaka/core
- Payment Method: formatted (Cash / Card / Transfer)
- Reference: last 8 chars of bookingId uppercased
- QR Code: encoded as `{bookingId}:{seatNumbers.join(',')}` — use QRCode.toDataURL() to generate a data URL and render as <img>
- Footer: "Powered by WebWaka | webwaka.ng"

3. Add styles with @media print CSS:
   - Body: margin 0, padding 0
   - Receipt container: max-width 72mm (for 80mm thermal), font-size 11px, font-family monospace
   - Hide everything except .receipt-printable when printing
   - Each section: clear borders, no shadows

4. After a successful POS sale, show the receipt in a modal with:
   - "Print Receipt" button (calls window.print())
   - "Share via WhatsApp" button: wa.me/?text={encodeURIComponent(summary)}
   - "Done" button to close

5. Populate qr_code column in receipts table: when creating a receipt in POST /api/agent-sales/transactions, set qr_code = `${bookingId}:${seatIds.join(',')}`.

=== TASK P07-T3: Multi-Agent Device Session Management ===
File: src/components/ (agent session switcher component)
File: src/core/offline/db.ts

1. In db.ts, extend getAgentSession(agentId: string) to support offline grace period:
   - If session.expiresAt < Date.now(): check if Date.now() < session.expiresAt + OFFLINE_GRACE_MS (where OFFLINE_GRACE_MS = 8 * 3600 * 1000)
   - If within grace period AND navigator.onLine === false: return { ...session, gracePeriod: true }
   - If online and expired: return null (force re-login)

2. Create a session switcher component in the POS header:
   - Shows "Agent: {agentName}" with a dropdown arrow
   - On click: shows a "Switch Agent" option and current agent name
   - On "Switch Agent":
     a. Call syncEngine.flush() — await completion
     b. Clear current auth state (JWT, agent session in memory)
     c. Navigate to the agent login screen (phone + OTP)
   - After new agent logs in: load their sessions and pending transactions

3. Show a yellow banner when operating in offline grace mode: "Session expired — operating in offline mode. Sync when connected to refresh."

4. Add getAgentSession supporting multiple stored sessions: use agent ID as the Dexie key so multiple agents' sessions can be stored simultaneously.

=== TASK P07-T4: Bus Park / Terminal Management ===
File: src/api/agent-sales.ts

Add POST /api/agent-sales/parks (TENANT_ADMIN+):
- Body: { name, city, state, latitude?, longitude? }
- INSERT into bus_parks
- Return created park

Add GET /api/agent-sales/parks:
- Returns all bus parks for the operator

Add POST /api/agent-sales/parks/:id/agents (SUPERVISOR+):
- Body: { agent_id: string }
- INSERT into agent_bus_parks
- Return 200

Add DELETE /api/agent-sales/parks/:id/agents/:agentId (SUPERVISOR+):
- DELETE from agent_bus_parks
- Return 204

In agent login flow: after login, check agent_bus_parks for the agent. If exactly one park: auto-set active_park_id in agent session. If multiple: show park selector. If none: proceed without park filtering.

Add park_id as optional query param to:
- GET /api/agent-sales/transactions?park_id= — joins via agents table through agent_bus_parks
- GET /api/operator/trips?park_id= — filters trips where park_id = ?

=== TASK P07-T5: Passenger ID Capture at POS ===
File: src/api/agent-sales.ts
Frontend: agent sale form

1. Extend POST /api/agent-sales/transactions body schema to accept optional fields:
   - passenger_id_type: 'NIN' | 'BVN' | 'passport' | 'drivers_license' | null
   - passenger_id_number: string | null

2. Before storing, if passenger_id_number is provided:
   - Hash it: const encoder = new TextEncoder(); const data = encoder.encode(passenger_id_number); const hashBuf = await crypto.subtle.digest('SHA-256', data); const hashHex = Array.from(new Uint8Array(hashBuf)).map(b => b.toString(16).padStart(2, '0')).join('');
   - Store passenger_id_type (un-hashed) and passenger_id_hash (hashed) on the transaction record
   - Add passenger_id_type TEXT, passenger_id_hash TEXT columns to sales_transactions (migration 003)
   - Never store the raw passenger_id_number

3. Include passenger_id_type (not the hash) in GET /api/operator/trips/:id/manifest response for FRSC compliance.

4. Frontend: in the agent sale form, add an optional "Passenger ID" section:
   - Dropdown: NIN / BVN / Passport / Driver's License
   - Text input for ID number
   - Label these as "Optional — for manifests"
   - Disable autocomplete on the ID number field

=== DONE ===
Run tsc --noEmit. Test float reconciliation roundtrip. Test receipt print. Confirm passenger ID hash is stored correctly and never returns the raw number in any API response.
```

---

## PROMPT — P08-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P04-TRANSPORT AND P07-TRANSPORT must both be merged and deployed  
**Unlocks**: P09-TRANSPORT

---

```
You are implementing Phase P08-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This phase builds the revenue features: seat templates, class-based pricing, automated refunds, waiting list, and group bookings. Read webwaka-implementation-plan.md for full context.

=== TASK P08-T1: Vehicle Seat Configuration Templates ===
File: src/api/operator-management.ts
File: src/api/seat-inventory.ts

1. Add PUT /api/operator/vehicles/:id/template (TENANT_ADMIN+):
   - Body is a JSON object with shape:
     { rows: number, columns: number, aisle_after_column: number, seats: [{ number: string, row: number, column: number, class: 'standard'|'window'|'vip'|'front' }] }
   - Validate: all seat numbers unique, class values in allowed set, seat count = rows * columns (minus any intentionally excluded positions)
   - UPDATE vehicles SET seat_template = ? WHERE id = ? AND operator_id = ?
   - Return 200 with the template

2. In POST /api/seat-inventory/trips (trip creation):
   - After determining the vehicle, fetch vehicle.seat_template
   - If seat_template is present: parse it and generate seats from the template using the template's seat definitions (number, class from template)
   - If no seat_template: fall back to the existing sequential integer seat generation with class = 'standard'
   - The seat_class column already exists on seats

3. Extend GET /api/seat-inventory/trips/:id/availability response to include:
   - seat_layout: the vehicle's seat_template object (for frontend visual rendering)
   - Each seat in the seats array includes seat_class

=== TASK P08-T2: Seat Class Pricing ===
File: src/api/operator-management.ts
File: src/api/booking-portal.ts

1. Add PUT /api/operator/routes/:id/fare-matrix (TENANT_ADMIN+):
   - Body: { standard: number (multiplier), window: number, vip: number, front: number, time_multipliers?: { peak_hours: number[], peak_multiplier: number, peak_days: number[], peak_day_multiplier: number } }
   - All multipliers must be >= 1.0 and <= 5.0
   - UPDATE routes SET fare_matrix = ? WHERE id = ? AND operator_id = ?
   - Return 200

2. In GET /api/booking/trips/search, for each trip:
   - Load the route's fare_matrix
   - Compute effective_fare_by_class: { standard: base_fare * class_mult, window: ..., vip: ..., front: ... }
   - Apply time_multipliers: check if current query time (or departure time?) is in peak_hours / peak_days
   - Return effective_fare_by_class in the trip search result
   - Also return the lowest available fare as effective_fare (for sorting by cheapest)

3. In POST /api/booking/bookings:
   - Validate total_amount_kobo against the computed fare for the selected seats and their classes
   - Allow ±2% tolerance for rounding
   - If outside tolerance: return 422 { error: 'fare_mismatch', expected_kobo: N, submitted_kobo: N }

=== TASK P08-T3: Cancellation Policy with Automated Refund ===
File: src/api/booking-portal.ts
File: (create if not exists) src/lib/payments.ts

1. Add initiatePaystackRefund(paymentReference: string, amountKobo: number, env: Env): Promise<string> to payments.ts:
   - POST https://api.paystack.co/refund with Authorization: Bearer {PAYSTACK_SECRET_KEY}
   - Body: { transaction: paymentReference, amount: amountKobo } (amount is optional if full refund)
   - Return refund reference string
   - Throw on non-200 response

2. In PATCH /api/booking/bookings/:id/cancel:
   - Fetch the booking with trip departure_time
   - Get operator cancellation policy from operator config
   - Compute hours_until_departure = (departure_time - Date.now()) / 3_600_000
   - Determine refund_amount_kobo:
     * hours_until_departure > free_before_hours: refund = total_amount_kobo (full)
     * hours_until_departure > half_refund_before_hours: refund = Math.floor(total_amount_kobo / 2) (half)
     * else: refund = 0 (none)
   - Release seats (existing logic)
   - Set booking.status = 'cancelled', cancelled_at = now
   - If refund_amount_kobo > 0 AND payment_status = 'completed' AND payment_method IN ('paystack', 'flutterwave'):
     * Call initiatePaystackRefund(booking.payment_reference, refund_amount_kobo, env)
     * Store refund_reference and refund_amount_kobo on the booking
     * Publish booking:REFUNDED event
   - If payment was cash: set manual_refund_required = 1 on booking
   - Return 200 with { cancelled: true, refund_amount_kobo, refund_reference, manual_refund_required }

3. Add refund_reference TEXT, refund_amount_kobo INTEGER, manual_refund_required INTEGER columns to bookings (migration 003).

=== TASK P08-T4: Waiting List with Auto-Assignment ===
File: src/api/booking-portal.ts
File: src/lib/sweepers.ts

1. Add POST /api/booking/trips/:id/waitlist (CUSTOMER role, authenticated):
   - Body: { seat_class: 'standard'|'window'|'vip'|'front' }
   - Check trip exists and has no available seats of requested class: SELECT COUNT(*) FROM seats WHERE trip_id = ? AND seat_class = ? AND status = 'available'
   - If seats available: return 400 { error: 'seats_available', message: 'Seats are available — book now!' }
   - Check customer not already on waitlist for this trip
   - Compute position: SELECT COALESCE(MAX(position), 0) + 1 FROM waiting_list WHERE trip_id = ? AND deleted_at IS NULL
   - INSERT into waiting_list with expires_at = Date.now() + 7*24*3600*1000 (waitlist expires in 7 days)
   - Return { position, trip_id, seat_class, message: 'You are #N on the waitlist.' }

2. Add GET /api/booking/waitlist (CUSTOMER role) — returns active (non-deleted, non-expired) waitlist entries for the customer.

3. Add DELETE /api/booking/trips/:id/waitlist (CUSTOMER role) — soft-deletes the customer's waitlist entry for the trip.

4. In sweepExpiredReservations() and the cancel endpoint, after releasing seats, add:
   - Check waiting_list for this trip_id ordered by position ASC, limit 1, where notified_at IS NULL
   - If found: send SMS: "WebWaka: A {seat_class} seat just opened on your waitlisted trip {route} on {date}! You have 10 minutes to book: https://webwaka.ng/booking?trip={tripId}&class={seat_class}&priority=waitlist"
   - UPDATE waiting_list SET notified_at = ? WHERE id = ?

=== TASK P08-T5: Group Booking Workflow ===
File: src/api/agent-sales.ts
Frontend: agent POS group booking mode

1. Add POST /api/agent-sales/group-bookings (AGENT role+):
   - Body: { trip_id, seat_count: number, group_name: string, leader_name: string, leader_phone: string, seat_class: 'standard'|'vip', payment_method: 'cash'|'paystack'|'bank_transfer' }
   - Validate: seat_count ∈ [2, 50]. group_name non-empty. leader_phone valid Nigerian format.
   - Find available seats: SELECT id, seat_number FROM seats WHERE trip_id = ? AND seat_class = ? AND status = 'available' ORDER BY seat_number ASC LIMIT ?
   - If available count < seat_count: return 422 { error: 'insufficient_seats', available: N, requested: seat_count }
   - Generate group_booking_id: nanoid('grp', 16)
   - Use the reserve-batch endpoint logic (same atomic pattern from P02-T2) to hold all seats
   - Create one bookings record: passenger_names = Array(seat_count).fill(group_name + ' (Group)'), seat_ids = all reserved seat IDs, group_booking_id
   - Create one sales_transactions record for the total
   - Create one receipts record
   - Return { group_booking_id, booking_id, seat_numbers, total_amount_kobo, receipt_id }

2. Add GET /api/agent-sales/group-bookings/:id — returns group booking detail.

3. Frontend: add "Group Booking" tab in agent POS. Form with: trip selector, passenger count slider (2-50), group name, leader contact, seat class, payment method. After submission, show a combined receipt listing all seat numbers.

=== DONE ===
Run tsc --noEmit. Test fare matrix roundtrip. Test cancellation refund with a completed Paystack booking. Test group booking atomic reservation.
```

---

## PROMPT — P09-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P05-TRANSPORT AND P08-TRANSPORT must both be merged and deployed  
**Unlocks**: P10-TRANSPORT

---

```
You are implementing Phase P09-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This phase builds fleet and compliance management, and the operator notification center. Read webwaka-implementation-plan.md for full context.

=== TASK P09-T1: Vehicle Maintenance Tracking ===
File: src/api/operator-management.ts
File: src/lib/sweepers.ts

Add POST /api/operator/vehicles/:id/maintenance (TENANT_ADMIN+):
- Body: { service_type: string, service_date_ms: number, next_service_due_ms?: number, notes?: string }
- INSERT into vehicle_maintenance_records
- If next_service_due_ms < Date.now() + 7*86400*1000: immediately publish vehicle.maintenance_due_soon event
- Return the created record

Add GET /api/operator/vehicles/:id/maintenance:
- Returns maintenance records ordered by service_date DESC, limit 20

Add POST /api/operator/vehicles/:id/documents (TENANT_ADMIN+):
- Body: { doc_type: 'roadworthiness'|'insurance'|'frsc_approval'|'nafdac', doc_number?, issued_at_ms?, expires_at_ms: number }
- INSERT into vehicle_documents
- Return created document

Add GET /api/operator/vehicles/:id/documents:
- Returns all documents for the vehicle with expiry status: 'valid'|'expiring_soon'|'expired'
  (expired = expires_at < now; expiring_soon = expires_at < now + 30*86400*1000)

Add sweepVehicleMaintenanceDue(env) to sweepers.ts:
- Daily: SELECT v.id, v.plate_number, o.id as operator_id, v.next_service_due_ms FROM vehicles v JOIN operators o ON o.id = v.operator_id WHERE v.next_service_due_ms < ? AND v.deleted_at IS NULL (cutoff = now + 7*86400*1000)
- For each: publish vehicle.maintenance_due_soon event

Add sweepVehicleDocumentExpiry(env) to sweepers.ts:
- Daily: SELECT vd.*, v.plate_number, o.id as operator_id FROM vehicle_documents vd JOIN vehicles v ON v.id = vd.vehicle_id JOIN operators o ON o.id = v.operator_id WHERE vd.expires_at < ? (cutoff = now + 30*86400*1000)
- For each: publish vehicle.document_expiring event

Wire both sweepers to the daily cron in worker.ts.

In driver assignment (PATCH /api/operator/trips/:id where vehicle_id is being set):
- Check: SELECT id FROM vehicle_documents WHERE vehicle_id = ? AND doc_type = 'roadworthiness' AND expires_at < ? (now) — if expired, return 422 { error: 'vehicle_compliance_expired', doc_type: 'roadworthiness' }

=== TASK P09-T2: Driver Document Management ===
File: src/api/operator-management.ts
File: src/lib/sweepers.ts

Add POST /api/operator/drivers/:id/documents (TENANT_ADMIN+):
- Body: { doc_type: 'drivers_license'|'frsc_cert'|'medical_cert', doc_number?: string, license_category?: string, issued_at_ms?: number, expires_at_ms: number }
- INSERT into driver_documents
- Return created document

Add GET /api/operator/drivers/:id/documents:
- Returns all documents with expiry status (same as vehicle documents)

Add sweepDriverDocumentExpiry(env) to sweepers.ts (daily):
- SELECT dd.*, d.name, o.id as operator_id FROM driver_documents dd JOIN drivers d ON d.id = dd.driver_id JOIN operators o ON o.id = d.operator_id WHERE dd.expires_at < ? (now + 30*86400*1000)
- Publish driver.document_expiring for each

Wire to daily cron.

In driver assignment to a trip:
- Check: SELECT id FROM driver_documents WHERE driver_id = ? AND doc_type = 'drivers_license' AND expires_at < ? (now)
- If expired: return 422 { error: 'driver_license_expired', doc_type: 'drivers_license' }

=== TASK P09-T3: Operator Notification Center ===
File: src/api/operator-management.ts
Frontend: operator dashboard notification panel

Add GET /api/operator/notifications (TENANT_ADMIN+):
- Query platform_events where tenant_id = operator_id AND created_at > Date.now() - 7*86400*1000
- Filter to actionable types: trip:SOS_ACTIVATED, agent.reconciliation_filed, vehicle.maintenance_due_soon, vehicle.document_expiring, driver.document_expiring, booking:ABANDONED, payment:AMOUNT_MISMATCH, trip:DELAYED, booking:REFUNDED
- Sort by created_at DESC, limit 50
- For each event, add a read_at field: check notification_reads table (create this table: { event_id, user_id, read_at })
- Return { notifications: [...events with read_at], unread_count: N }

Add POST /api/operator/notifications/:eventId/read (TENANT_ADMIN+):
- INSERT OR IGNORE into notification_reads { event_id, user_id: authenticatedUserId, read_at: now }
- Return 200

Frontend notification panel:
- Show a badge on the operator dashboard header with the unread_count
- Badge is red for SOS events, yellow for compliance events, blue for others
- Click opens a slide-in panel listing notifications with timestamps and action links
- SOS notifications show as a persistent red banner at the top of the dashboard that cannot be closed until the SOS is cleared (check trips with sos_active=1 on dashboard load)
- Auto-refresh notifications every 30 seconds via polling

Create notification_reads table in migration 003:
  CREATE TABLE IF NOT EXISTS notification_reads (event_id TEXT NOT NULL, user_id TEXT NOT NULL, read_at INTEGER NOT NULL, PRIMARY KEY (event_id, user_id));

=== DONE ===
Run tsc --noEmit. Run migration 003. Test vehicle document expiry check blocking a trip assignment. Test notification badge shows unread count.
```

---

## PROMPT — P10-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P05-TRANSPORT AND P09-TRANSPORT must both be merged and deployed  
**Unlocks**: P11-TRANSPORT

---

```
You are implementing Phase P10-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This phase builds real-time infrastructure, the dispatcher dashboard, booking reminders, and analytics. Read webwaka-implementation-plan.md for full context.

=== TASK P10-T1: SSE Seat Availability Feed ===
File: src/api/seat-inventory.ts

Add GET /api/seat-inventory/trips/:id/live (public — no auth required for read-only seat status):
- This is an SSE endpoint. Set response headers: Content-Type: text/event-stream, Cache-Control: no-cache, X-Accel-Buffering: no
- Implementation using Cloudflare Workers TransformStream:

seatInventoryRouter.get('/trips/:id/live', async (c) => {
  const tripId = c.req.param('id');
  const env = c.env as Env;

  let lastHash = '';
  const { readable, writable } = new TransformStream();
  const writer = writable.getWriter();
  const encoder = new TextEncoder();

  const send = async (data: string) => {
    await writer.write(encoder.encode(`data: ${data}\n\n`));
  };
  const ping = async () => {
    await writer.write(encoder.encode(': ping\n\n'));
  };

  const stream = async () => {
    const start = Date.now();
    const MAX_DURATION_MS = 5 * 60 * 1000; // 5 min max

    while (Date.now() - start < MAX_DURATION_MS) {
      try {
        // Try KV cache first, fall back to DB
        let seats: unknown[] = [];
        const cached = await env.SEAT_CACHE_KV?.get(tripId, { type: 'json' }) as unknown[] | null;
        if (cached) {
          seats = cached;
        } else {
          const result = await env.DB.prepare(
            'SELECT id, seat_number, status, seat_class FROM seats WHERE trip_id = ? AND deleted_at IS NULL ORDER BY seat_number ASC'
          ).bind(tripId).all();
          seats = result.results ?? [];
        }

        const hash = JSON.stringify(seats);
        if (hash !== lastHash) {
          lastHash = hash;
          await send(JSON.stringify({ type: 'seat_update', seats }));
        } else {
          await ping();
        }
      } catch {
        await ping();
      }
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
    await writer.close();
  };

  stream().catch(() => writer.close().catch(() => {}));

  return new Response(readable, {
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
});

In the booking portal seat selection component, add:
useEffect(() => {
  const es = new EventSource(`/api/seat-inventory/trips/${tripId}/live`);
  es.onmessage = (event) => {
    const { type, seats } = JSON.parse(event.data);
    if (type === 'seat_update') updateSeatStates(seats);
  };
  return () => es.close();
}, [tripId]);

When a seat transitions to reserved/confirmed, show a subtle "Just taken" animation on that seat.

=== TASK P10-T2: Dispatcher Dashboard ===
File: src/api/operator-management.ts
Frontend: new dispatcher view

Add GET /api/operator/dispatch (SUPERVISOR role+):
- Returns all active trips for the operator (state IN ('scheduled', 'boarding', 'in_transit'))
- Each trip includes:
  SELECT t.id, t.state, t.departure_time, t.estimated_departure_ms, t.delay_reason_code, t.sos_active, t.current_latitude, t.current_longitude, t.location_updated_at, t.vehicle_id, t.driver_id, r.origin, r.destination, v.plate_number, d.name as driver_name, COUNT(CASE WHEN b.status='confirmed' THEN 1 END) as confirmed_count, COUNT(CASE WHEN b.boarded_at IS NOT NULL THEN 1 END) as boarded_count, t.total_seats
  FROM trips t JOIN routes r ON r.id = t.route_id LEFT JOIN vehicles v ON v.id = t.vehicle_id LEFT JOIN drivers d ON d.id = t.driver_id LEFT JOIN bookings b ON b.trip_id = t.id AND b.deleted_at IS NULL
  WHERE t.state IN ('scheduled', 'boarding', 'in_transit') AND t.operator_id = ? AND t.deleted_at IS NULL
  GROUP BY t.id
  ORDER BY t.departure_time ASC

Frontend dispatcher dashboard:
- Grid of trip cards. Each card shows: route, departure time, state badge, boarding progress bar (boarded/confirmed), vehicle plate, driver name
- Color scheme: green = on_time (no delay, no SOS), yellow = delayed (delay_reason_code IS NOT NULL), red = SOS active (sos_active = 1)
- SOS active cards have a pulsing red border animation
- "View Manifest" link on each card
- "File Delay" button on each card (opens inline form)
- Auto-refreshes every 30 seconds via polling
- Add a SUPERVISOR/TENANT_ADMIN nav link to "Dispatch" that opens this view

=== TASK P10-T3: Booking Reminder Cron Sweeper ===
File: src/lib/sweepers.ts
File: src/worker.ts
File: migrations/003_phase3_columns.sql (add reminder columns)

Add to migration 003: ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_24h_sent_at INTEGER; ALTER TABLE bookings ADD COLUMN IF NOT EXISTS reminder_2h_sent_at INTEGER;

Add sweepBookingReminders(env: Env): Promise<void> to sweepers.ts:

export async function sweepBookingReminders(env: Env): Promise<void> {
  const db = env.DB;
  const now = Date.now();

  // 24-hour reminders: departure between 23h and 25h from now
  const remind24 = await db.prepare(
    `SELECT b.id, b.passenger_names, b.seat_ids, c.phone as customer_phone,
            r.origin, r.destination, t.departure_time
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN trips t ON t.id = b.trip_id
     JOIN routes r ON r.id = t.route_id
     WHERE b.status = 'confirmed'
       AND b.reminder_24h_sent_at IS NULL
       AND t.departure_time BETWEEN ? AND ?
       AND b.deleted_at IS NULL
       AND c.phone NOT LIKE 'NDPR_%'
     LIMIT 50`
  ).bind(now + 23*3600*1000, now + 25*3600*1000).all<Record<string, unknown>>();

  for (const booking of (remind24.results ?? [])) {
    try {
      const depDate = new Date(Number(booking.departure_time)).toLocaleDateString('en-NG', { weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
      const seatNums = (JSON.parse(String(booking.seat_ids ?? '[]')) as string[]).join(', ');
      const msg = `WebWaka reminder: Your trip ${booking.origin} → ${booking.destination} departs tomorrow at ${depDate}. Seat(s): ${seatNums}. View ticket: https://webwaka.ng/b/${booking.id}`;
      await sendSms(String(booking.customer_phone), msg, env);
      await db.prepare(`UPDATE bookings SET reminder_24h_sent_at = ? WHERE id = ?`).bind(now, booking.id).run();
    } catch (err) {
      console.error(`[Reminders] 24h reminder failed for ${booking.id}:`, err instanceof Error ? err.message : err);
    }
  }

  // 2-hour reminders: departure between 1h45m and 2h15m from now
  const remind2h = await db.prepare(
    `SELECT b.id, b.passenger_names, c.phone as customer_phone,
            r.origin, r.destination, t.departure_time
     FROM bookings b
     JOIN customers c ON c.id = b.customer_id
     JOIN trips t ON t.id = b.trip_id
     JOIN routes r ON r.id = t.route_id
     WHERE b.status = 'confirmed'
       AND b.reminder_2h_sent_at IS NULL
       AND t.departure_time BETWEEN ? AND ?
       AND b.deleted_at IS NULL
       AND c.phone NOT LIKE 'NDPR_%'
     LIMIT 50`
  ).bind(now + 105*60*1000, now + 135*60*1000).all<Record<string, unknown>>();

  for (const booking of (remind2h.results ?? [])) {
    try {
      const msg = `WebWaka: Your bus departs in ~2 hours! ${booking.origin} → ${booking.destination}. Please make your way to the departure park now.`;
      await sendSms(String(booking.customer_phone), msg, env);
      await db.prepare(`UPDATE bookings SET reminder_2h_sent_at = ? WHERE id = ?`).bind(now, booking.id).run();
    } catch (err) {
      console.error(`[Reminders] 2h reminder failed for ${booking.id}:`, err instanceof Error ? err.message : err);
    }
  }
}

In worker.ts scheduled() handler for the minute cron: await sweepBookingReminders(env);

=== TASK P10-T4: Revenue Per Route Analytics ===
File: src/api/operator-management.ts

Extend GET /api/operator/reports with query params:
- ?groupby=route|vehicle|driver|operator (operator only for SUPER_ADMIN)
- ?from=YYYY-MM-DD&to=YYYY-MM-DD (default: current month)

When groupby=route, return array of:
{
  route_id, origin, destination,
  total_trips, total_seats, confirmed_seats,
  fill_rate_pct (as a float),
  gross_revenue_kobo, refunds_kobo, net_revenue_kobo,
  avg_fare_kobo
}

SQL pattern:
SELECT r.id as route_id, r.origin, r.destination,
  COUNT(DISTINCT t.id) as total_trips,
  SUM(t.total_seats) as total_seats,
  COUNT(CASE WHEN b.status='confirmed' THEN 1 END) as confirmed_seats,
  COALESCE(SUM(CASE WHEN b.status='confirmed' AND b.payment_status='completed' THEN b.total_amount_kobo END), 0) as gross_revenue_kobo,
  COALESCE(SUM(b.refund_amount_kobo), 0) as refunds_kobo
FROM routes r
JOIN trips t ON t.route_id = r.id
LEFT JOIN bookings b ON b.trip_id = t.id AND b.deleted_at IS NULL
WHERE r.operator_id = ? AND t.created_at BETWEEN ? AND ? AND t.deleted_at IS NULL
GROUP BY r.id, r.origin, r.destination
ORDER BY gross_revenue_kobo DESC

Apply tenant scope. SUPER_ADMIN skips the operator_id filter.

=== TASK P10-T5: SUPER_ADMIN Analytics Dashboard ===
File: src/api/admin.ts

Add GET /api/internal/admin/analytics (SUPER_ADMIN only, no tenant scope):
Returns:
{
  operators: { total, active, suspended },
  trips: { today: { scheduled, boarding, in_transit, completed, cancelled }, this_week: N, this_month: N },
  bookings: { today: { pending, confirmed, cancelled }, this_week: N, this_month: N },
  revenue: { this_month_kobo: N, all_time_kobo: N },
  top_routes: [{ origin, destination, booking_count }] (top 10),
  top_operators: [{ operator_name, revenue_kobo }] (top 10),
  event_bus_health: { pending: N, dead: N, processed_today: N }
}

Frontend: add a SUPER_ADMIN section in the operator dashboard header. When the logged-in user has role SUPER_ADMIN, show an "Analytics" link that opens this dashboard.

=== DONE ===
Run tsc --noEmit. Run migration 003. Test the SSE seat availability feed in two browser tabs. Test the dispatcher dashboard with active trips. Confirm reminder sweeper respects the sent flags (no duplicate SMSes).
```

---

## PROMPT — P11-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P10-TRANSPORT must be merged and deployed  
**Unlocks**: P12-LOGISTICS, P14-CORE

---

```
You are implementing Phase P11-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This phase builds operator API keys, the onboarding wizard, and multi-stop route management. Read webwaka-implementation-plan.md for full context.

=== TASK P11-T1: Operator API Keys ===
File: src/api/operator-management.ts

The api_keys table was created in migration 002. The verifyApiKey function was added to @webwaka/core in P01-T4. This task wires the management endpoints.

Add POST /api/operator/api-keys (TENANT_ADMIN only):
- Body: { name: string, scope: 'read'|'read_write' }
- Generate raw key: `waka_live_${nanoid('', 32)}` (use nanoid from @webwaka/core)
- Hash key: SHA-256 via crypto.subtle
- INSERT into api_keys: { id: nanoid('key', 16), operator_id: tenantId, name, key_hash, scope, created_by: userId, created_at: now }
- Return { id, name, scope, key: rawKey, created_at } — WARN in response: "Save this key now. It will never be shown again."
- Never store the raw key

Add GET /api/operator/api-keys (TENANT_ADMIN+):
- Returns api_keys for the operator WITHOUT the key_hash field
- Includes: id, name, scope, created_at, last_used_at, revoked_at

Add DELETE /api/operator/api-keys/:id (TENANT_ADMIN only):
- UPDATE api_keys SET revoked_at = ? WHERE id = ? AND operator_id = ?
- Return 204

=== TASK P11-T2: Operator Onboarding Wizard ===
Frontend only — all APIs already exist.

Detect new operators: on login, call GET /api/operator/routes and GET /api/operator/vehicles. If both return empty arrays, show the onboarding wizard modal instead of the normal dashboard.

Build a multi-step wizard component src/components/onboarding-wizard.tsx with these steps:

Step 1 — Company Profile:
- Fields: company name (pre-filled from operator.name), address, contact phone, CAC registration number, FIRS TIN
- Save button calls PATCH /api/operator/profile (or equivalent update endpoint)

Step 2 — Add Vehicles:
- Vehicle form: make, model, year, plate number, capacity, type (bus/minibus/coaster)
- "Add Vehicle" button submits POST /api/operator/vehicles
- "Add Another" option
- "Skip for now" advances to Step 3

Step 3 — Add Routes:
- Route form: origin (dropdown from Nigerian cities list), destination, base fare (₦, auto-converts to kobo), duration (minutes), distance (km)
- "Add Route" button submits POST /api/operator/routes
- "Add Another" option

Step 4 — Configure Seat Templates (Optional):
- Shows list of vehicles added in Step 2
- For each vehicle: "Configure Seats" opens the template form from P08-T1
- "Skip" advances

Step 5 — Add Drivers:
- Driver form: name, phone, license number
- "Add Driver" submits POST /api/operator/drivers

Step 6 — Add Agents:
- Agent form: name, phone, bus park (select from parks created, or "Add Park" inline)
- "Add Agent" submits POST /api/agent-sales/agents

Step 7 — Create First Trip:
- Trip form: select route (from Step 3), select vehicle (from Step 2), select driver (from Step 5), departure date, departure time
- "Create Trip" submits POST /api/seat-inventory/trips
- On success: show confetti or celebration animation, "Go to Dashboard" button

Progress: save current step to localStorage so incomplete wizards resume. Show step progress indicator (1 of 7).

=== TASK P11-T3: Multi-Stop Route Management ===
File: src/api/operator-management.ts
File: src/api/booking-portal.ts

The route_stops table was created in migration 002.

Add POST /api/operator/routes/:id/stops (TENANT_ADMIN+):
- Body: { stops: [{ stop_name: string, sequence: number, distance_from_origin_km?: number, fare_from_origin_kobo?: number }] }
- Validate: sequence values unique, at least 2 stops, first stop sequence = 1
- DELETE existing stops: DELETE FROM route_stops WHERE route_id = ?
- Batch INSERT all stops
- UPDATE routes SET route_stops_enabled = 1 WHERE id = ?
- Return the full stop list

Add GET /api/operator/routes/:id/stops (public):
- Returns stops ordered by sequence

In GET /api/booking/trips/search, add optional query params: origin_stop and destination_stop
- If provided: join through route_stops to find routes that include both stops in the right sequence
- Compute the segment fare: (fare_from_origin of destination_stop) - (fare_from_origin of origin_stop)
- Return this as the effective fare for this booking

In POST /api/booking/bookings, accept optional fields: origin_stop_id, destination_stop_id
- If provided: store on booking record, validate they belong to the trip's route, validate sequence order

=== DONE ===
Run tsc --noEmit. Test API key generation, usage (with Authorization: ApiKey header), and revocation. Test onboarding wizard step 7 completes to a viewable trip. Test multi-stop route with partial-route booking fare calculation.
```

---

## PROMPT — P12-LOGISTICS
**Target Repo**: `webwaka-logistics`  
**Depends on**: P11-TRANSPORT must be merged and deployed in webwaka-transport  
**Unlocks**: P13-TRANSPORT

---

```
You are implementing Phase P12-LOGISTICS of the WebWaka platform.
Target repo: webwaka-logistics

This phase wires the transport-logistics integration. You are building on the logistics side only. Do not modify the webwaka-transport repo. Read webwaka-implementation-plan.md (available in the webwaka-transport repo) for full context.

The integration protocol:
- Transport → Logistics: transport repo's drainEventBus() posts parcel.* events to the logistics repo endpoint
- Logistics → Transport: logistics repo posts parcel.seats_required events to the transport repo endpoint
- Authentication: both directions use Authorization: Bearer {INTER_SERVICE_SECRET} header (shared secret, stored as a Worker secret in both repos)

=== TASK P12-T1: Transport Event Receiver Endpoint ===
File: src/api/transport-integration.ts (create new file)

Create a webhook handler in the logistics repo: POST /internal/transport-events

1. Verify the Authorization header: Authorization: Bearer {env.INTER_SERVICE_SECRET}. Return 401 if missing or wrong.
2. Read the X-Webwaka-Event-Type header to determine event type.
3. Handle parcel.waybill_created:
   - Parse payload: { trip_id, waybill_id, sender, recipient, description, weight_kg, declared_value_kobo, fees_kobo }
   - Create a parcel record in the logistics DB linked to the trip_id
   - Return 200 { received: true }
4. Handle trip.state_changed:
   - Parse payload: { trip_id, new_state }
   - If new_state = 'in_transit': UPDATE parcels SET status = 'in_transit' WHERE trip_id = ? AND status = 'pending'
   - If new_state = 'completed': UPDATE parcels SET status = 'delivered', delivered_at = ? WHERE trip_id = ? AND status = 'in_transit'
   - Return 200 { received: true }
5. Default: return 200 { received: true, note: 'event type not handled' } — never return non-200 for unrecognized events

Register this route in the logistics app's Hono router.

=== TASK P12-T2: Publish Parcel Seat Requirement Events ===
File: logistics parcel confirmation flow

When a parcel is confirmed for shipment on a specific transport trip:
1. Read the trip_id from the parcel's shipment record
2. Call the transport repo: POST {env.TRANSPORT_BASE_URL}/api/internal/transport-events with:
   - Headers: Authorization: Bearer {env.INTER_SERVICE_SECRET}, Content-Type: application/json, X-Webwaka-Event-Type: parcel.seats_required
   - Body: { trip_id, seats_needed: Math.ceil(parcel.weight_kg / 30), parcel_id: parcel.id, weight_kg: parcel.weight_kg, declared_value_kobo: parcel.declared_value_kobo }
3. Handle the response:
   - 200 with { seats_confirmed: true }: parcel is confirmed, seats are blocked on the bus
   - 200 with { seats_unavailable: true }: notify the logistics operator that cargo space is full on this trip — they must reschedule
   - Non-200 or network error: log, mark parcel as pending_seat_assignment, retry on next sync

Store TRANSPORT_BASE_URL as a Worker environment variable (not a secret — it is the public API URL).

=== TASK P12-T3: Transport Repo — Receive Seat Requirement Events ===
Note: This task modifies webwaka-transport. Include these changes in the P12 work but apply them to the transport repo.

File (webwaka-transport): src/api/ — add internal events endpoint
File (webwaka-transport): src/lib/sweepers.ts — add parcel.seats_required handler

1. Add POST /api/internal/transport-events to the transport repo (protected by INTER_SERVICE_SECRET):
   - Verifies Authorization: Bearer {env.INTER_SERVICE_SECRET}
   - Routes to appropriate handler by X-Webwaka-Event-Type
   
2. Handle parcel.seats_required:
   - Parse payload: { trip_id, seats_needed, parcel_id, weight_kg }
   - Find `seats_needed` available seats on the trip: SELECT id FROM seats WHERE trip_id = ? AND status = 'available' ORDER BY seat_number ASC LIMIT ?
   - If enough seats available: UPDATE seats SET status='blocked', blocked_reason='parcel_cargo', blocked_by=parcel_id WHERE id IN (found_ids). Return 200 { seats_confirmed: true, blocked_seat_ids: [...] }
   - If not enough: Return 200 { seats_unavailable: true, available: N, requested: seats_needed }

=== ENVIRONMENT VARIABLES ===
Both repos need these Worker secrets/vars:
- webwaka-transport: INTER_SERVICE_SECRET (shared secret), and the /api/internal/transport-events endpoint
- webwaka-logistics: INTER_SERVICE_SECRET (same shared secret), TRANSPORT_BASE_URL (webwaka-transport's deployed URL)

Set these via wrangler secret put INTER_SERVICE_SECRET in each repo.

=== DONE ===
Deploy both repos. Test the integration end-to-end: create a parcel in logistics linked to a transport trip ID. Verify the transport trip's seats are blocked. Complete the transport trip → verify the parcel is marked delivered in logistics.
```

---

## PROMPT — P13-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P12-LOGISTICS must be merged and deployed  
**Can run in parallel with P14-CORE**  
**Unlocks**: P15-TRANSPORT

---

```
You are implementing Phase P13-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This phase builds channel expansion features: WhatsApp sharing, operator reviews, and full i18n. Read webwaka-implementation-plan.md for full context.

=== TASK P13-T1: WhatsApp Receipt and Ticket Sharing ===
Files: src/components/receipt.tsx (from P07-T2), src/pages/ticket.tsx (from P03-T5)

These are frontend-only changes. No backend work required.

In both the receipt component and the e-ticket page, add a "Share via WhatsApp" button:

const buildWhatsAppUrl = ({ origin, destination, departureDate, seatNumbers, passengerName, bookingId }: ShareParams) => {
  const text = [
    'WebWaka Booking Confirmed! ✅',
    `Route: ${origin} → ${destination}`,
    `Date: ${departureDate}`,
    `Seat(s): ${seatNumbers}`,
    `Passenger: ${passengerName}`,
    `Ref: ${bookingId.slice(-8).toUpperCase()}`,
    `View ticket: https://webwaka.ng/b/${bookingId}`,
  ].join('\n');
  return `https://wa.me/?text=${encodeURIComponent(text)}`;
};

Render: <a href={buildWhatsAppUrl({...})} target="_blank" rel="noopener noreferrer" className="btn-whatsapp">Share via WhatsApp</a>

Style the button green (#25D366 — WhatsApp's brand color) with a WhatsApp icon (use a simple SVG icon, not an image).

On mobile, this opens the WhatsApp app directly. On desktop, it opens web.whatsapp.com.

=== TASK P13-T2: Operator Reviews and Ratings ===
File: src/api/booking-portal.ts
File: src/lib/sweepers.ts

The operator_reviews table was created in migration 002.

Add POST /api/booking/reviews (CUSTOMER role):
- Body: { booking_id: string, rating: number (1-5), review_text?: string }
- Validate: rating integer between 1 and 5. booking_id must belong to the authenticated customer.
- Fetch booking: must have status='confirmed' or 'completed', and trip.state='completed'. Return 422 if trip not yet completed.
- Check no existing review: SELECT id FROM operator_reviews WHERE booking_id = ? — return 409 if exists
- INSERT into operator_reviews
- Return the created review

Add GET /api/booking/operators/:id/reviews (public):
- Returns { avg_rating: float, total_reviews: N, reviews: [...paginated reviews] }
- Reviews include: rating, review_text (if provided), created_at. Never include customer PII.

In GET /api/booking/trips/search, add avg_rating to each trip's operator info:
- SELECT AVG(r.rating) as avg_rating, COUNT(r.id) as review_count FROM operator_reviews r WHERE r.operator_id = ? AND r.deleted_at IS NULL
- Return as part of each trip result

In drainEventBus() sweepers.ts, add handler for trip.state_changed where new_state='completed':
- SELECT b.id, c.phone FROM bookings b JOIN customers c ON c.id = b.customer_id WHERE b.trip_id = ? AND b.status='confirmed' AND b.review_prompt_sent_at IS NULL AND c.phone NOT LIKE 'NDPR_%'
- For each: sendSms(phone, "WebWaka: How was your journey? Rate your trip in 10 seconds: https://webwaka.ng/b/{booking_id}#review", env)
- UPDATE bookings SET review_prompt_sent_at = ? WHERE id = ?

Add review_prompt_sent_at INTEGER to bookings in migration 003.

=== TASK P13-T3: Full i18n Completion ===
File: src/core/i18n/index.ts

The i18n module supports English, Yoruba, Igbo, and Hausa. Audit and complete all missing translations.

For every key in the translations object:
1. If the Yoruba, Igbo, or Hausa value is empty, missing, or identical to the English value (indicating a placeholder), add a real translation.
2. At minimum, the following booking flow keys must be fully translated in all 4 languages:
   - Search form: "From", "To", "Date", "Search Trips", "Any date"
   - Trip list: "Available seats", "Departs", "Arrives", "Book Now", "Sold Out"
   - Seat selection: "Select your seat", "Available", "Reserved", "Confirmed", "Window", "Aisle", "VIP", "Standard"
   - Payment: "Proceed to Payment", "Total Amount", "Booking Summary", "Pay Now"
   - Confirmation: "Booking Confirmed", "Your ticket", "View E-Ticket", "Share via WhatsApp"
   - Errors: "Seat no longer available", "Payment failed", "Session expired, please log in again"
   - Common: "Loading", "Back", "Cancel", "Confirm", "Done", "Error", "Success"

3. Add language auto-detection: read navigator.language on app init. Map: 'yo' or 'yo-*' → yoruba, 'ig' or 'ig-*' → igbo, 'ha' or 'ha-*' → hausa, default → english.

4. Add a manual language selector (small dropdown in the booking portal header and agent POS header) with flags or abbreviations: EN, YO, IG, HA.

5. Store the user's selected language in localStorage so it persists across sessions.

=== DONE ===
Run tsc --noEmit. Test WhatsApp deep link on mobile (tap should open WhatsApp app). Test review submission after a completed trip. Switch language to Yoruba and verify the entire booking flow is in Yoruba.
```

---

## PROMPT — P14-CORE
**Target Repo**: `@webwaka/core`  
**Depends on**: P11-TRANSPORT must be merged and deployed  
**Can run in parallel with P13-TRANSPORT**  
**Unlocks**: P15-TRANSPORT

---

```
You are implementing Phase P14-CORE of the WebWaka platform.
Target repo: @webwaka/core (packages/core/src/)

This phase adds subscription tier feature gating to the shared platform core. This enables monetization across all repos without duplicating business logic. Read webwaka-implementation-plan.md for full context.

=== TASK P14-T1: Subscription Tier Feature Gating ===

File: packages/core/src/tiers.ts (create new file)
File: packages/core/src/index.ts (re-export)

1. Create packages/core/src/tiers.ts:

export type SubscriptionTier = 'basic' | 'professional' | 'enterprise';

export const TIER_FEATURES: Record<SubscriptionTier, string[]> = {
  basic: [
    'seat_inventory',
    'agent_sales',
    'basic_booking',
    'manual_schedule',
    'manifest',
    'boarding_scan',
    'float_reconciliation',
    'vehicle_management',
    'driver_management',
    'route_management',
    'basic_reports',
  ],
  professional: [
    // Includes all basic features
    'ai_search',
    'dynamic_pricing',
    'waiting_list',
    'api_keys',
    'analytics',
    'auto_schedule',
    'sms_notifications',
    'push_notifications',
    'seat_class_pricing',
    'cancellation_refunds',
    'operator_reviews',
    'driver_performance',
    'advanced_reports',
    'gps_tracking',
    'sos_system',
  ],
  enterprise: [
    // Includes all professional features
    'white_label',
    'multi_park',
    'interline',
    'corporate_portal',
    'custom_domain',
    'bulk_import',
    'route_stops',
    'cross_tenant_analytics',
    'custom_cancellation_policy',
    'priority_support',
  ],
};

export function tierHasFeature(tier: SubscriptionTier, feature: string): boolean {
  // Tiers are cumulative — professional includes all basic features
  if (tier === 'enterprise') return true; // Enterprise has all features
  if (tier === 'professional') {
    return TIER_FEATURES.basic.includes(feature) || TIER_FEATURES.professional.includes(feature);
  }
  return TIER_FEATURES.basic.includes(feature);
}

2. Add requireTierFeature middleware factory:

import type { MiddlewareHandler } from 'hono';

export function requireTierFeature(feature: string): MiddlewareHandler {
  return async (c, next) => {
    const user = c.get('user') as WakaUser | undefined;
    if (!user) return c.json({ error: 'Unauthorized' }, 401);

    // SUPER_ADMIN always has access to all features
    if (user.role === 'SUPER_ADMIN') return next();

    // Read the operator's subscription tier from DB
    const db = (c.env as Record<string, unknown>).DB as D1Database | undefined;
    if (!db) return next(); // Fallback: allow if DB unavailable (dev mode)

    const operator = await db.prepare(
      'SELECT subscription_tier FROM operators WHERE id = ? AND deleted_at IS NULL'
    ).bind(user.tenant_id).first<{ subscription_tier: string }>();

    const tier = (operator?.subscription_tier ?? 'basic') as SubscriptionTier;

    if (!tierHasFeature(tier, feature)) {
      return c.json({
        error: 'feature_not_available',
        feature,
        current_tier: tier,
        upgrade_url: 'https://webwaka.ng/pricing',
        message: `This feature requires a ${feature} subscription tier. Please upgrade at webwaka.ng/pricing`,
      }, 402);
    }

    return next();
  };
}

3. Export both from packages/core/src/index.ts:
   export * from './tiers';
   export { requireTierFeature } from './tiers';

4. Run tsc --noEmit. Bump the core package minor version.

After this phase, the transport repo (P15) will wrap feature-gated endpoints with requireTierFeature calls.

=== DONE ===
Run tsc --noEmit. Confirm tierHasFeature('basic', 'ai_search') returns false. Confirm tierHasFeature('professional', 'ai_search') returns true. Confirm tierHasFeature('enterprise', 'white_label') returns true.
```

---

## PROMPT — P15-TRANSPORT
**Target Repo**: `webwaka-transport`  
**Depends on**: P13-TRANSPORT AND P14-CORE must both be merged and deployed  
**Final phase — no blockers after this**

---

```
You are implementing Phase P15-TRANSPORT of the WebWaka platform.
Target repo: webwaka-transport

This is the final phase. It applies subscription tier gating, builds the real-time Durable Object seat system, corporate travel portal, white-label branding, and bulk import. Read webwaka-implementation-plan.md for full context.

=== TASK P15-T1: Apply Subscription Tier Gating to Feature Endpoints ===

Now that @webwaka/core has requireTierFeature (from P14-T1), apply it to gated endpoints.

File: src/api/booking-portal.ts, src/api/seat-inventory.ts, src/api/operator-management.ts

Import requireTierFeature from @webwaka/core.

Apply to these specific route registrations (add the middleware before the existing handler):

booking-portal.ts:
  POST /api/booking/trips/ai-search → requireTierFeature('ai_search')
  POST /api/booking/trips/:id/waitlist → requireTierFeature('waiting_list')
  POST /api/booking/reviews → requireTierFeature('operator_reviews') (remove if you decide reviews should be basic)

operator-management.ts:
  GET /api/operator/analytics → requireTierFeature('analytics')
  POST /api/operator/schedules → requireTierFeature('auto_schedule')
  POST /api/operator/api-keys → requireTierFeature('api_keys')
  PUT /api/operator/routes/:id/fare-matrix → requireTierFeature('seat_class_pricing')
  POST /api/operator/config/branding → requireTierFeature('white_label')
  POST /api/operator/import/routes → requireTierFeature('bulk_import')
  POST /api/operator/import/vehicles → requireTierFeature('bulk_import')

seat-inventory.ts:
  POST /api/seat-inventory/trips/:id/waitlist → requireTierFeature('waiting_list')

Also add subscription_tier TEXT NOT NULL DEFAULT 'basic' to operators table (migration 003 if not already added).

=== TASK P15-T2: Durable Objects Real-Time Seat Updates ===

File: src/durables/trip-seat-do.ts (create)
File: wrangler.toml (add DO binding)
File: src/api/seat-inventory.ts (add WebSocket upgrade endpoint)

1. In wrangler.toml, add:

[[durable_objects.bindings]]
name = "TRIP_SEAT_DO"
class_name = "TripSeatDO"

[[migrations]]
tag = "v1"
new_classes = ["TripSeatDO"]

2. Create src/durables/trip-seat-do.ts:

export class TripSeatDO implements DurableObject {
  private connections: Set<WebSocket> = new Set();

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      const upgrade = request.headers.get('Upgrade');
      if (upgrade !== 'websocket') return new Response('Expected WebSocket', { status: 426 });
      const { 0: client, 1: server } = new WebSocketPair();
      server.accept();
      this.connections.add(server);
      server.addEventListener('close', () => this.connections.delete(server));
      server.addEventListener('error', () => this.connections.delete(server));
      return new Response(null, { status: 101, webSocket: client });
    }

    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const data = await request.json() as { type: string; seat: unknown };
      const message = JSON.stringify(data);
      const dead: WebSocket[] = [];
      for (const ws of this.connections) {
        try { ws.send(message); } catch { dead.push(ws); }
      }
      dead.forEach(ws => this.connections.delete(ws));
      return new Response('ok');
    }

    return new Response('Not Found', { status: 404 });
  }
}

3. Export TripSeatDO from src/worker.ts at the module level: export { TripSeatDO } from './durables/trip-seat-do';

4. Add WebSocket upgrade route to seat-inventory.ts:

seatInventoryRouter.get('/trips/:id/ws', async (c) => {
  const tripId = c.req.param('id');
  const env = c.env as Env & { TRIP_SEAT_DO: DurableObjectNamespace };
  const id = env.TRIP_SEAT_DO.idFromName(tripId);
  const stub = env.TRIP_SEAT_DO.get(id);
  return stub.fetch(new Request('https://do/ws', { headers: c.req.raw.headers }));
});

5. In all seat mutation endpoints (reserve, confirm, release, reserve-batch), after the D1 write, add a broadcast:

const doId = env.TRIP_SEAT_DO.idFromName(tripId);
const stub = env.TRIP_SEAT_DO.get(doId);
await stub.fetch(new Request('https://do/broadcast', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({ type: 'seat_changed', seat: { id: seatId, status: newStatus, seat_number: seatNumber } }),
})).catch(() => {}); // Non-fatal

6. In the booking portal frontend, replace the SSE EventSource with a WebSocket:

useEffect(() => {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  const ws = new WebSocket(`${protocol}//${location.host}/api/seat-inventory/trips/${tripId}/ws`);
  ws.onmessage = (event) => {
    const { type, seat } = JSON.parse(event.data);
    if (type === 'seat_changed') updateSingleSeat(seat);
  };
  ws.onerror = () => {
    // Fall back to polling if WebSocket fails
    console.warn('[SeatWS] WebSocket failed, falling back to polling');
  };
  return () => ws.close();
}, [tripId]);

Keep the SSE endpoint from P10-T1 as a fallback (older browsers).

=== TASK P15-T3: Corporate Travel Portal ===
File: src/api/booking-portal.ts

1. Add customer_type TEXT NOT NULL DEFAULT 'individual' and credit_limit_kobo INTEGER DEFAULT 0 to customers (migration 003).

2. Add POST /api/booking/corporate-accounts (TENANT_ADMIN+):
   - Body: { company_name, contact_name, contact_phone, contact_email, credit_limit_naira }
   - Creates a customer record with customer_type='corporate', credit_limit_kobo=credit_limit_naira*100
   - Returns the corporate account

3. Add GET /api/booking/corporate-accounts (TENANT_ADMIN+):
   - Lists all corporate customers for the operator

4. Modify POST /api/booking/bookings to support payment_method='credit':
   - Only for corporate customers (customer.customer_type = 'corporate')
   - Compute new_credit_balance = customer.credit_limit_kobo - total_amount_kobo (subtract from available credit, assuming credit_limit is the remaining balance)
   - If new_credit_balance < 0: return 402 { error: 'insufficient_credit', available_kobo: customer.credit_limit_kobo }
   - UPDATE customers SET credit_limit_kobo = new_credit_balance WHERE id = ?
   - Set booking.payment_status = 'completed' (credit purchases are immediately settled)

5. Add GET /api/booking/corporate-accounts/:id/statement (TENANT_ADMIN+):
   - Returns all bookings for this corporate customer ordered by created_at DESC
   - Includes: booking_id, trip summary, amount_kobo, date, seat_numbers
   - Also returns: total_spent_kobo_this_month, remaining_credit_kobo

=== TASK P15-T4: Operator White-Label Branding ===
File: src/api/operator-management.ts
File: src/app.tsx
File: wrangler.toml (add R2 binding)

1. Add R2 bucket binding to wrangler.toml:
[[r2_buckets]]
binding = "ASSETS_R2"
bucket_name = "webwaka-operator-assets"

2. Add PUT /api/operator/config/branding (TENANT_ADMIN+ with requireTierFeature('white_label')):
   - Body: { logo_url?: string, primary_color?: string (hex), secondary_color?: string (hex), display_name?: string }
   - Validate hex colors: /^#[0-9A-Fa-f]{6}$/
   - Merge into operator config under 'branding' key
   - Write to TENANT_CONFIG_KV

3. Add POST /api/operator/config/logo (TENANT_ADMIN+ with requireTierFeature('white_label')):
   - Accepts multipart/form-data with a 'logo' file field
   - Validate: max 2MB, must be image/png or image/jpeg
   - Upload to R2: env.ASSETS_R2.put(`logos/${operatorId}/${Date.now()}`, imageBuffer, { httpMetadata: { contentType } })
   - Return the public URL: https://assets.webwaka.ng/logos/{operatorId}/{filename}

4. In src/app.tsx on mount:
   - Detect operator from URL subdomain (location.hostname.split('.')[0]) or from a ?op= query param
   - If operator detected: fetch GET /api/operator/config for that operator's public branding
   - Apply CSS variables: document.documentElement.style.setProperty('--primary', branding.primary_color)
   - Set document.title = branding.display_name or "WebWaka"

=== TASK P15-T5: Bulk CSV Import ===
File: src/api/operator-management.ts

Add POST /api/operator/import/routes (TENANT_ADMIN+ with requireTierFeature('bulk_import')):
- Accepts multipart/form-data with a 'file' field (CSV)
- Parse CSV: first line is header. Expected columns: origin,destination,base_fare_naira,duration_minutes,distance_km
- Limit: 500 rows. Rows 501+ are ignored (return a note in the response).
- For each valid row:
  - Validate: origin and destination non-empty, base_fare_naira positive number, duration_minutes positive integer
  - Convert base_fare_naira to kobo (multiply by 100)
  - INSERT into routes (skip if origin+destination+operator_id already exists — INSERT OR IGNORE)
- Return: { created: N, skipped: N, errors: [{ row: N, reason: '...' }] }

Add POST /api/operator/import/vehicles — CSV: plate_number,make,model,year,capacity,vehicle_type
Add POST /api/operator/import/drivers — CSV: name,phone,license_number,license_category

Simple CSV parser (no library needed for this schema):
const parseCSV = (text: string): string[][] => {
  return text.trim().split('\n').map(line => line.split(',').map(cell => cell.trim().replace(/^"|"$/g, '')));
};

=== DONE ===
Run tsc --noEmit. Verify the Durable Object class is exported correctly (Cloudflare requires it to be a named export at the worker module level). Test feature gating: a 'basic' tier operator calling /api/booking/trips/ai-search should get 402. Test bulk CSV import with a 10-row CSV. Test WebSocket seat updates in two browser tabs.

This is the final phase. After P15 is deployed, the full WebWaka Transport Suite is feature-complete across all 15 phases.
```

---

*End of phase prompts. Each prompt is self-contained and can be copy-pasted directly into an agent conversation in the specified repo. Execute phases in dependency order as defined by the phase dependency table in `webwaka-implementation-plan.md`.*
