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
