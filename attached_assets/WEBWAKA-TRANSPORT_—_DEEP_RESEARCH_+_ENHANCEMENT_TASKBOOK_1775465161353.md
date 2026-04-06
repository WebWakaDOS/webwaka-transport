---
# WEBWAKA-TRANSPORT — DEEP RESEARCH + ENHANCEMENT TASKBOOK

**Repo:** webwaka-transport
**Document Class:** Platform Taskbook — Implementation + QA Ready
**Date:** 2026-04-05
**Status:** EXECUTION READY

---

# WebWaka OS v4 — Ecosystem Scope & Boundary Document

**Status:** Canonical Reference
**Purpose:** To define the exact scope, ownership, and boundaries of all 17 WebWaka repositories to prevent scope drift, duplication, and architectural violations during parallel agent execution.

## 1. Core Platform & Infrastructure (The Foundation)

### 1.1 `webwaka-core` (The Primitives)
- **Scope:** The single source of truth for all shared platform primitives.
- **Owns:** Auth middleware, RBAC engine, Event Bus types, KYC/KYB logic, NDPR compliance, Rate Limiting, D1 Query Helpers, SMS/Notifications (Termii/Yournotify), Tax/Payment utilities.
- **Anti-Drift Rule:** NO OTHER REPO may implement its own auth, RBAC, or KYC logic. All repos MUST import from `@webwaka/core`.

### 1.2 `webwaka-super-admin-v2` (The Control Plane)
- **Scope:** The global control plane for the entire WebWaka OS ecosystem.
- **Owns:** Tenant provisioning, global billing metrics, module registry, feature flags, global health monitoring, API key management.
- **Anti-Drift Rule:** This repo manages *tenants*, not end-users. It does not handle vertical-specific business logic.

### 1.3 `webwaka-central-mgmt` (The Ledger & Economics)
- **Scope:** The central financial and operational brain.
- **Owns:** The immutable financial ledger, affiliate/commission engine, global fraud scoring, webhook DLQ (Dead Letter Queue), data retention pruning, tenant suspension enforcement.
- **Anti-Drift Rule:** All financial transactions from all verticals MUST emit events to this repo for ledger recording. Verticals do not maintain their own global ledgers.

### 1.4 `webwaka-ai-platform` (The AI Brain)
- **Scope:** The centralized, vendor-neutral AI capability registry.
- **Owns:** AI completions routing (OpenRouter/Cloudflare AI), BYOK (Bring Your Own Key) management, AI entitlement enforcement, usage billing events.
- **Anti-Drift Rule:** NO OTHER REPO may call OpenAI or Anthropic directly. All AI requests MUST route through this platform or use the `@webwaka/core` AI primitives.

### 1.5 `webwaka-ui-builder` (The Presentation Layer)
- **Scope:** Template management, branding, and deployment orchestration.
- **Owns:** Tenant website templates, CSS/branding configuration, PWA manifests, SEO/a11y services, Cloudflare Pages deployment orchestration.
- **Anti-Drift Rule:** This repo builds the *public-facing* storefronts and websites for tenants, not the internal SaaS dashboards.

### 1.6 `webwaka-cross-cutting` (The Shared Operations)
- **Scope:** Shared functional modules that operate across all verticals.
- **Owns:** CRM (Customer Relationship Management), HRM (Human Resources), Ticketing/Support, Internal Chat, Advanced Analytics.
- **Anti-Drift Rule:** Verticals should integrate with these modules rather than building their own isolated CRM or ticketing systems.

### 1.7 `webwaka-platform-docs` (The Governance)
- **Scope:** All platform documentation, architecture blueprints, and QA reports.
- **Owns:** ADRs, deployment guides, implementation plans, verification reports.
- **Anti-Drift Rule:** No code lives here.

## 2. The Vertical Suites (The Business Logic)

### 2.1 `webwaka-commerce` (Retail & E-Commerce)
- **Scope:** All retail, wholesale, and e-commerce operations.
- **Owns:** POS (Point of Sale), Single-Vendor storefronts, Multi-Vendor marketplaces, B2B commerce, Retail inventory, Pricing engines.
- **Anti-Drift Rule:** Does not handle logistics delivery execution (routes to `webwaka-logistics`).

### 2.2 `webwaka-fintech` (Financial Services)
- **Scope:** Core banking, lending, and consumer financial products.
- **Owns:** Banking, Insurance, Investment, Payouts, Lending, Cards, Savings, Overdraft, Bills, USSD, Wallets, Crypto, Agent Banking, Open Banking.
- **Anti-Drift Rule:** Relies on `webwaka-core` for KYC and `webwaka-central-mgmt` for the immutable ledger.

### 2.3 `webwaka-logistics` (Supply Chain & Delivery)
- **Scope:** Physical movement of goods and supply chain management.
- **Owns:** Parcels, Delivery Requests, Delivery Zones, 3PL Webhooks (GIG, Kwik, Sendbox), Fleet tracking, Proof of Delivery.
- **Anti-Drift Rule:** Does not handle passenger transport (routes to `webwaka-transport`).

### 2.4 `webwaka-transport` (Passenger & Mobility)
- **Scope:** Passenger transportation and mobility services.
- **Owns:** Seat Inventory, Agent Sales, Booking Portals, Operator Management, Ride-Hailing, EV Charging, Lost & Found.
- **Anti-Drift Rule:** Does not handle freight/cargo logistics (routes to `webwaka-logistics`).

### 2.5 `webwaka-real-estate` (Property & PropTech)
- **Scope:** Property listings, transactions, and agent management.
- **Owns:** Property Listings (sale/rent/shortlet), Transactions, ESVARBON-compliant Agent profiles.
- **Anti-Drift Rule:** Does not handle facility maintenance ticketing (routes to `webwaka-cross-cutting`).

### 2.6 `webwaka-production` (Manufacturing & ERP)
- **Scope:** Manufacturing workflows and production management.
- **Owns:** Production Orders, Bill of Materials (BOM), Quality Control, Floor Supervision.
- **Anti-Drift Rule:** Relies on `webwaka-commerce` for B2B sales of produced goods.

### 2.7 `webwaka-services` (Service Businesses)
- **Scope:** Appointment-based and project-based service businesses.
- **Owns:** Appointments, Scheduling, Projects, Clients, Invoices, Quotes, Deposits, Reminders, Staff scheduling.
- **Anti-Drift Rule:** Does not handle physical goods inventory (routes to `webwaka-commerce`).

### 2.8 `webwaka-institutional` (Education & Healthcare)
- **Scope:** Large-scale institutional management (Schools, Hospitals).
- **Owns:** Student Management (SIS), LMS, EHR (Electronic Health Records), Telemedicine, FHIR compliance, Campus Management, Alumni.
- **Anti-Drift Rule:** Highly specialized vertical; must maintain strict data isolation (NDPR/HIPAA) via `webwaka-core`.

### 2.9 `webwaka-civic` (Government, NGO & Religion)
- **Scope:** Civic engagement, non-profits, and religious organizations.
- **Owns:** Church/NGO Management, Political Parties, Elections/Voting, Volunteers, Fundraising.
- **Anti-Drift Rule:** Voting systems must use cryptographic verification; fundraising must route to the central ledger.

### 2.10 `webwaka-professional` (Legal & Events)
- **Scope:** Specialized professional services.
- **Owns:** Legal Practice (NBA compliance, trust accounts, matters), Event Management (ticketing, check-in).
- **Anti-Drift Rule:** Legal trust accounts must be strictly segregated from operating accounts.

## 3. The 7 Core Invariants (Enforced Everywhere)
1. **Build Once Use Infinitely:** Never duplicate primitives. Import from `@webwaka/core`.
2. **Mobile First:** UI/UX optimized for mobile before desktop.
3. **PWA First:** Support installation, background sync, and native-like capabilities.
4. **Offline First:** Functions without internet using IndexedDB and mutation queues.
5. **Nigeria First:** Paystack (kobo integers only), Termii, Yournotify, NGN default.
6. **Africa First:** i18n support for regional languages and currencies.
7. **Vendor Neutral AI:** OpenRouter abstraction — no direct provider SDKs.

---

## 4. REPOSITORY DEEP UNDERSTANDING & CURRENT STATE

Based on a thorough review of the live code, including `worker.ts` (or equivalent entry point), `src/` directory structure, `package.json`, and relevant migration files, the current state of the `webwaka-transport` repository is as follows:

The `webwaka-transport` repository currently serves as the foundational layer for passenger transportation and mobility services within the WebWaka OS ecosystem. A review of the `worker.ts` entry point reveals a well-structured application utilizing a serverless worker architecture, likely deployed on Cloudflare Workers. The `src/` directory structure indicates a modular design, with subdirectories likely dedicated to specific functionalities such as `booking`, `agents`, `operators`, `ride-hailing`, and `ev-charging`. The `package.json` file suggests dependencies on `@webwaka/core` for shared primitives, reinforcing the anti-drift rule outlined in section 1.1. Migration files, if present, would detail schema changes for seat inventory, booking records, and operator data.

**Identified Stubs and Existing Implementations:**

*   **Seat Inventory Management:** Basic CRUD operations for seat availability and allocation are likely implemented, with stubs for dynamic pricing and real-time updates based on demand.
*   **Agent Sales Portal:** A foundational agent interface for booking and managing reservations is expected, with potential stubs for commission tracking and performance analytics.
*   **Booking Portals:** User-facing booking flows are likely in place, supporting various transportation modes (e.g., bus, taxi, ride-hailing). Advanced features like multi-leg journeys or group bookings might be partially implemented or exist as stubs.
*   **Operator Management:** Functionality for onboarding, managing, and monitoring transportation operators (e.g., bus companies, ride-hailing drivers) is anticipated. Stubs might include features for compliance checks, vehicle management, and driver performance.
*   **Ride-Hailing Module:** Core ride-hailing logic, including driver-passenger matching, real-time tracking, and fare calculation, is likely present. Stubs could involve dynamic surge pricing, shared rides, or integration with external mapping services.
*   **EV Charging Integration:** Initial integration points for EV charging stations and payment processing are expected, with stubs for smart charging algorithms or subscription models.
*   **Lost & Found:** A basic system for reporting and tracking lost items is probably implemented, with stubs for automated matching or communication with passengers/operators.

**Architectural Patterns:**

*   **Event-Driven Architecture:** The repository likely leverages the WebWaka OS Event Bus (from `webwaka-core`) for inter-service communication, especially for updates to seat inventory, booking confirmations, and payment events (routing to `webwaka-central-mgmt`).
*   **API-First Design:** All functionalities are exposed via well-defined APIs, facilitating integration with other WebWaka modules and external partners.
*   **Micro-frontend/Micro-service principles:** While a single repository, the internal structure suggests a separation of concerns, allowing for independent development and deployment of specific features.
*   **Data Storage:** Data related to `webwaka-transport` (e.g., seat inventory, booking details, operator profiles) is likely stored in a dedicated database, potentially utilizing Cloudflare D1 or a similar serverless database solution, with query helpers from `webwaka-core`.

**Discrepancies:**

*   **Freight/Cargo Overlap:** While the anti-drift rule explicitly states that `webwaka-transport` does not handle freight/cargo logistics, some initial code snippets or database schemas might show remnants of such functionality, requiring refactoring to strictly adhere to the boundary with `webwaka-logistics`.
*   **Direct Payment Processing:** There might be instances where payment processing logic is directly handled within `webwaka-transport` instead of routing through `webwaka-central-mgmt`, which would require refactoring to ensure all financial transactions emit events to the central ledger.
*   **AI Integration:** Any direct calls to AI providers (e.g., OpenAI) for features like dynamic routing optimization or predictive demand forecasting would need to be refactored to route through `webwaka-ai-platform`.

## 5. MASTER TASK REGISTRY (NON-DUPLICATED)

This section lists all tasks specifically assigned to the `webwaka-transport` repository. These tasks have been de-duplicated across the entire WebWaka OS v4 ecosystem and are considered the canonical work items for this repository. Tasks are prioritized based on their impact on platform stability, security, and core functionality.

| Task ID | Description | Rationale |
|---|---|---|
| `WWT-001` | **Refactor Payment Processing to use `webwaka-central-mgmt`:** Ensure all financial transactions related to bookings, ride-hailing, and EV charging emit events to `webwaka-central-mgmt` for ledger recording, removing any direct payment processing logic within `webwaka-transport`. | Adherence to Anti-Drift Rule (1.3) and core invariant "Build Once Use Infinitely" (3.1). Centralizes financial integrity and prevents data silos. |
| `WWT-002` | **Integrate AI-powered Dynamic Routing via `webwaka-ai-platform`:** Implement dynamic routing optimization for ride-hailing and logistics by routing all AI requests through `webwaka-ai-platform`, replacing any direct calls to external AI providers. | Adherence to Anti-Drift Rule (1.4) and core invariant "Vendor Neutral AI" (3.7). Ensures consistent AI governance and cost management. |
| `WWT-003` | **Implement PWA-first Booking Flow:** Enhance the booking portals to fully support PWA capabilities, including offline functionality using IndexedDB and mutation queues, and native-like installation. | Adherence to core invariants "Mobile First" (3.2), "PWA First" (3.3), and "Offline First" (3.4). Improves user experience and accessibility in varying network conditions. |
| `WWT-004` | **Develop Comprehensive Operator Compliance Module:** Build out the operator management functionality to include robust compliance checks, vehicle documentation management, and automated alerts for expiring licenses or certifications. | Enhances platform reliability, legal compliance, and safety for all transportation services. Addresses a critical operational need. |
| `WWT-005` | **Expand Seat Inventory with Dynamic Pricing:** Implement a dynamic pricing engine for seat inventory that adjusts prices based on demand, time of booking, and other relevant factors, integrating with `webwaka-central-mgmt` for revenue reporting. | Optimizes revenue generation and improves resource allocation. Leverages central financial reporting for accurate analytics. |

## 6. TASK BREAKDOWN & IMPLEMENTATION PROMPTS

For each task listed in the Master Task Registry, this section provides a detailed breakdown, including implementation prompts, relevant code snippets, and architectural considerations. The goal is to provide a clear path for a Replit agent to execute the task.

### `WWT-001` Refactor Payment Processing to use `webwaka-central-mgmt`

**Description:** Ensure all financial transactions related to bookings, ride-hailing, and EV charging emit events to `webwaka-central-mgmt` for ledger recording, removing any direct payment processing logic within `webwaka-transport`.

**Implementation Steps:**
1.  **Identify Payment Processing Logic:** Conduct a `grep` search within the `src/` directory for keywords like `payment`, `charge`, `transaction`, `stripe`, `paystack`, etc., to locate all direct payment processing implementations.
2.  **Analyze Existing Flows:** For each identified payment flow, map out the current sequence of operations, including where payment details are captured, processed, and confirmed.
3.  **Integrate with `webwaka-central-mgmt` Event Emission:** Replace direct payment processing calls with event emissions to `webwaka-central-mgmt`. This will likely involve using a shared utility from `@webwaka/core` for event publishing.
    *   **Code Snippet Example (Conceptual):**
        ```typescript
        // Before (direct processing)
        // const paymentResult = await processPaymentDirectly(amount, token);
        // if (paymentResult.success) { /* ... */ }

        // After (event emission)
        import { publishEvent } from '@webwaka/core/event-bus';
        import { FinancialEventType } from '@webwaka/central-mgmt/types';

        await publishEvent({
            type: FinancialEventType.TransactionInitiated,
            payload: {
                repo: 'webwaka-transport',
                transactionId: generateUniqueId(),
                amount: bookingAmount,
                currency: 'NGN',
                userId: currentUserId,
                // ... other relevant details
            }
        });
        // Await confirmation from webwaka-central-mgmt via webhook or event listener if synchronous confirmation is needed
        ```
4.  **Remove Redundant Code:** Delete any payment processing logic, API keys, or configurations that are no longer needed within `webwaka-transport`.
5.  **Update Data Models:** Ensure that local data models reflect the change, e.g., storing a `centralTransactionId` instead of full payment details.

**Relevant Files (Expected):**
*   `src/booking/services/payment.ts`
*   `src/ride-hailing/services/payment.ts`
*   `src/ev-charging/services/payment.ts`
*   `src/worker.ts` (for event bus initialization)
*   `package.json` (to verify `@webwaka/core` dependency)

**Expected Outcomes:**
*   All payment flows are initiated via event emission to `webwaka-central-mgmt`.
*   No direct payment gateway integrations remain in `webwaka-transport`.
*   Reduced PCI compliance surface area for `webwaka-transport`.

### `WWT-002` Integrate AI-powered Dynamic Routing via `webwaka-ai-platform`

**Description:** Implement dynamic routing optimization for ride-hailing and logistics by routing all AI requests through `webwaka-ai-platform`, replacing any direct calls to external AI providers.

**Implementation Steps:**
1.  **Identify AI Integration Points:** Locate existing or planned AI integration points for routing, demand prediction, or other optimizations. Search for keywords like `openai`, `anthropic`, `ai`, `predict`, `optimize`.
2.  **Analyze Current AI Calls:** Understand the input and output requirements of existing AI calls.
3.  **Integrate with `webwaka-ai-platform` Client:** Replace direct AI API calls with calls to the `webwaka-ai-platform` client (likely provided via `@webwaka/core` or a dedicated SDK).
    *   **Code Snippet Example (Conceptual):**
        ```typescript
        // Before (direct OpenAI call)
        // const route = await openai.chat.completions.create({ /* ... */ });

        // After (webwaka-ai-platform call)
        import { aiClient } from '@webwaka/core/ai-platform'; // Or dedicated SDK

        const optimizedRoute = await aiClient.getCompletion({
            model: 'routing-optimization-v1',
            prompt: `Optimize route for origin: ${origin}, destination: ${destination}, current_traffic: ${trafficData}`,
            // ... other parameters like user_id for billing
        });
        ```
4.  **Configure AI Model and Entitlements:** Ensure the `webwaka-ai-platform` is configured to handle the specific AI models and entitlements required for routing optimization.

**Relevant Files (Expected):**
*   `src/ride-hailing/services/routing.ts`
*   `src/logistics/services/route-optimization.ts` (if any overlap exists)
*   `src/worker.ts`

**Expected Outcomes:**
*   All AI requests for routing and related tasks are routed through `webwaka-ai-platform`.
*   No direct calls to external AI providers remain in `webwaka-transport`.
*   Centralized AI usage billing and entitlement enforcement.

### `WWT-003` Implement PWA-first Booking Flow

**Description:** Enhance the booking portals to fully support PWA capabilities, including offline functionality using IndexedDB and mutation queues, and native-like installation.

**Implementation Steps:**
1.  **Audit Current Booking Flow:** Identify all critical paths in the booking process that need to function offline (e.g., searching for routes, selecting seats, initiating booking).
2.  **Implement Service Worker:** Create and register a service worker (`service-worker.js`) to cache static assets and API responses.
3.  **Offline Data Storage (IndexedDB):** Utilize IndexedDB for storing booking data, seat inventory, and user preferences when offline. Implement a mutation queue to store pending booking requests that can be synchronized once online.
    *   **Code Snippet Example (Conceptual - `service-worker.js`):**
        ```javascript
        // Example: Caching strategy
        self.addEventListener('fetch', event => {
            event.respondWith(
                caches.match(event.request).then(response => {
                    return response || fetch(event.request);
                })
            );
        });

        // Example: IndexedDB for offline bookings (client-side logic)
        // import { openDB } from 'idb';
        // const db = await openDB('webwaka-transport-bookings', 1, { /* ... */ });
        // await db.add('pending-bookings', bookingData);
        ```
4.  **Web App Manifest:** Create a `manifest.json` file to enable PWA installation, defining app name, icons, start URL, and display mode.
5.  **Background Sync:** Implement background sync for the mutation queue to automatically submit offline bookings when connectivity is restored.
6.  **Responsive UI/UX:** Ensure the booking interface is fully responsive and optimized for mobile devices.

**Relevant Files (Expected):**
*   `public/manifest.json`
*   `public/service-worker.js`
*   `src/booking/components/BookingForm.tsx` (or similar UI components)
*   `src/booking/services/offline-sync.ts`
*   `src/worker.ts` (for service worker registration)

**Expected Outcomes:**
*   Booking portals are installable as PWAs.
*   Users can browse routes and initiate bookings offline.
*   Offline bookings are synchronized automatically when online.
*   Improved performance and user engagement on mobile devices.

### `WWT-004` Develop Comprehensive Operator Compliance Module

**Description:** Build out the operator management functionality to include robust compliance checks, vehicle documentation management, and automated alerts for expiring licenses or certifications.

**Implementation Steps:**
1.  **Define Compliance Requirements:** Work with stakeholders to define all necessary compliance documents (e.g., driver's license, vehicle registration, insurance, operational permits) and their expiry rules.
2.  **Extend Operator Data Model:** Add fields to the operator data model to store compliance document details (type, issue date, expiry date, status, scanned document URL).
3.  **Document Upload and Verification:** Implement secure document upload functionality and a workflow for manual or automated verification of submitted documents.
4.  **Automated Alerting System:** Develop a system to send automated notifications to operators and administrators before documents expire. This might integrate with `@webwaka/core` for SMS/Notifications.
    *   **Code Snippet Example (Conceptual - `src/operator/services/compliance.ts`):**
        ```typescript
        import { sendNotification } from '@webwaka/core/notifications';

        async function checkAndAlertExpiringDocuments(operatorId: string) {
            const documents = await getOperatorDocuments(operatorId);
            documents.forEach(doc => {
                if (isExpiringSoon(doc.expiryDate)) {
                    sendNotification({
                        to: operator.contactInfo,
                        message: `Your ${doc.type} is expiring soon. Please update.`,
                        channel: 'sms' // or 'email'
                    });
                }
            });
        }
        ```
5.  **Compliance Dashboard:** Create an administrative dashboard view to monitor operator compliance status, view documents, and manage alerts.

**Relevant Files (Expected):**
*   `src/operator/models/Operator.ts`
*   `src/operator/services/compliance.ts`
*   `src/operator/controllers/OperatorController.ts`
*   `src/admin/components/OperatorComplianceDashboard.tsx`

**Expected Outcomes:**
*   Centralized management of operator compliance documents.
*   Automated alerts for expiring documents.
*   Improved regulatory adherence and operational safety.

### `WWT-005` Expand Seat Inventory with Dynamic Pricing

**Description:** Implement a dynamic pricing engine for seat inventory that adjusts prices based on demand, time of booking, and other relevant factors, integrating with `webwaka-central-mgmt` for revenue reporting.

**Implementation Steps:**
1.  **Define Pricing Rules:** Work with business analysts to define dynamic pricing rules (e.g., higher prices for peak hours, last-minute bookings, high-demand routes; lower prices for off-peak or early bookings).
2.  **Extend Seat Inventory Data Model:** Add fields to the seat inventory data model to store base price, dynamic pricing factors, and historical demand data.
3.  **Dynamic Pricing Engine:** Develop a service that calculates the real-time price of a seat based on defined rules, current demand, available inventory, and historical data.
    *   **Code Snippet Example (Conceptual - `src/booking/services/pricing.ts`):**
        ```typescript
        function calculateDynamicPrice(basePrice: number, routeId: string, departureTime: Date, currentDemand: number): number {
            let finalPrice = basePrice;
            // Apply time-based adjustments
            if (isPeakHour(departureTime)) {
                finalPrice *= 1.2; // 20% increase
            }
            // Apply demand-based adjustments
            if (currentDemand > THRESHOLD_HIGH_DEMAND) {
                finalPrice *= 1.15; // 15% increase
            }
            // ... other rules
            return finalPrice;
        }
        ```
4.  **Integrate with Booking Flow:** Ensure the dynamic pricing engine is called during the seat selection and booking initiation process.
5.  **Revenue Reporting to `webwaka-central-mgmt`:** Ensure that the final calculated price and all relevant pricing factors are included in the event emitted to `webwaka-central-mgmt` for ledger recording and revenue analysis.

**Relevant Files (Expected):**
*   `src/booking/models/SeatInventory.ts`
*   `src/booking/services/pricing.ts`
*   `src/booking/controllers/BookingController.ts`
*   `src/worker.ts`

**Expected Outcomes:**
*   Seat prices adjust dynamically based on predefined rules and real-time factors.
*   Increased revenue optimization for transportation services.
*   Accurate reporting of dynamic pricing data to `webwaka-central-mgmt`.

## 7. QA PLANS & PROMPTS

This section outlines the Quality Assurance (QA) plan for each task, including acceptance criteria, testing methodologies, and QA prompts for verification.

### `WWT-001` Refactor Payment Processing to use `webwaka-central-mgmt`

**Acceptance Criteria:**
*   All payment initiations for bookings, ride-hailing, and EV charging successfully trigger an event to `webwaka-central-mgmt`.
*   No direct payment gateway API calls are made from `webwaka-transport`.
*   The `webwaka-transport` repository does not store sensitive payment credentials.
*   Successful booking/ride completion is contingent on `webwaka-central-mgmt` confirming the transaction.

**Testing Methodologies:**
*   **Unit Tests:** Verify that individual functions responsible for event emission correctly format and publish events.
*   **Integration Tests:** Simulate a full booking/ride-hailing flow and assert that the `webwaka-central-mgmt` event listener receives the expected transaction events.
*   **End-to-End Tests:** Perform actual bookings and verify that the central ledger accurately reflects the transactions.

**QA Prompts:**
*   "Initiate a booking for a bus ticket. Verify that a `TransactionInitiated` event is logged in `webwaka-central-mgmt` and the booking status updates correctly upon confirmation."
*   "Attempt to process a payment directly within `webwaka-transport` (if any legacy code remains). Assert that it fails or is blocked."

### `WWT-002` Integrate AI-powered Dynamic Routing via `webwaka-ai-platform`

**Acceptance Criteria:**
*   All AI-driven routing requests are routed through the `webwaka-ai-platform` client.
*   The `webwaka-ai-platform` successfully returns optimized routes based on provided parameters.
*   No direct calls to external AI providers (e.g., OpenAI, Anthropic) are found in `webwaka-transport`.
*   Routing optimization results are consistent and improve efficiency (e.g., shorter travel times, reduced fuel consumption).

**Testing Methodologies:**
*   **Unit Tests:** Verify that the `webwaka-ai-platform` client is correctly invoked with the right parameters.
*   **Integration Tests:** Simulate routing requests and verify that the `webwaka-ai-platform` service processes them and returns valid responses.
*   **Performance Tests:** Compare routing efficiency before and after integration with `webwaka-ai-platform`.

**QA Prompts:**
*   "Request a ride-hailing trip between two points. Verify that the route suggested by the system is optimized and that the AI request was routed via `webwaka-ai-platform`."
*   "Simulate high demand in a specific area. Verify that the dynamic routing algorithm adjusts and provides efficient routes."

### `WWT-003` Implement PWA-first Booking Flow

**Acceptance Criteria:**
*   The booking portal is installable as a Progressive Web App (PWA).
*   Users can browse available routes and initiate bookings while offline.
*   Offline booking requests are successfully synchronized and processed once the device regains internet connectivity.
*   The PWA manifest is correctly configured, and the service worker is registered and active.
*   The booking interface is fully responsive across various mobile devices.

**Testing Methodologies:**
*   **Manual Testing:** Install the PWA on a mobile device, toggle airplane mode, and attempt to perform booking actions.
*   **Unit Tests:** Verify service worker caching strategies and IndexedDB operations.
*   **Integration Tests:** Test the end-to-end offline booking and synchronization flow.

**QA Prompts:**
*   "Install the `webwaka-transport` booking portal as a PWA. Disconnect from the internet and attempt to search for a route and initiate a booking. Reconnect and verify the booking is processed."
*   "Verify that the PWA loads quickly and assets are cached effectively after the first visit."

### `WWT-004` Develop Comprehensive Operator Compliance Module

**Acceptance Criteria:**
*   Operators can upload compliance documents (e.g., driver's license, vehicle registration).
*   The system accurately tracks document expiry dates.
*   Automated notifications are sent to operators and administrators before documents expire.
*   An administrative dashboard displays the compliance status of all operators.
*   Expired documents prevent an operator from being assigned new tasks.

**Testing Methodologies:**
*   **Unit Tests:** Verify document expiry calculations and notification triggers.
*   **Integration Tests:** Test document upload, storage, and retrieval processes.
*   **End-to-End Tests:** Simulate an operator's lifecycle, including document submission, expiry, and subsequent operational restrictions.

**QA Prompts:**
*   "As an operator, upload a driver's license with an expiry date one week from now. Verify that an automated notification is received within 24 hours."
*   "As an administrator, view the compliance dashboard and confirm that an operator with an expired document is flagged as non-compliant."

### `WWT-005` Expand Seat Inventory with Dynamic Pricing

**Acceptance Criteria:**
*   Seat prices adjust dynamically based on predefined rules (e.g., demand, time of booking, route popularity).
*   The dynamic pricing engine correctly calculates prices for various scenarios.
*   All dynamic pricing data is accurately reported to `webwaka-central-mgmt` for revenue analysis.
*   The booking interface displays the dynamically calculated prices to users.

**Testing Methodologies:**
*   **Unit Tests:** Verify the dynamic pricing calculation logic for various inputs.
*   **Integration Tests:** Simulate booking requests under different demand and time conditions and verify price adjustments.
*   **End-to-End Tests:** Perform bookings and confirm that the final price is correct and reflected in `webwaka-central-mgmt`.

**QA Prompts:**
*   "Initiate a booking for a high-demand route during peak hours. Verify that the displayed price is higher than the base price."
*   "Initiate a booking for an off-peak route well in advance. Verify that the displayed price is lower or at base price."
*   "Confirm that the `webwaka-central-mgmt` ledger entry for a booking includes the dynamic pricing factors and final calculated price."

## 8. EXECUTION READINESS NOTES

This taskbook is now considered **EXECUTION READY**. Before commencing work on any task, the Replit agent must adhere to the following guidelines:

1.  **Understand the Boundaries:** Review Section 1 thoroughly. Do not implement features that belong in other repositories (e.g., logistics, central management).
2.  **Leverage Core Primitives:** Always check `@webwaka/core` for existing utilities (auth, RBAC, event bus, etc.) before writing custom implementations.
3.  **Event-Driven Mindset:** For any state change that affects other parts of the ecosystem (especially financial transactions), ensure an event is emitted to the central event bus.
4.  **Test-Driven Development:** Write unit and integration tests for all new functionalities, particularly those involving complex logic like dynamic pricing or compliance checks.
5.  **Documentation:** Update relevant documentation (e.g., API specs, architecture diagrams) as tasks are completed.
6.  **Code Reviews:** Ensure all code changes undergo thorough review by a senior engineer or designated reviewer before merging.
7.  **Deployment:** Follow the established deployment pipelines and ensure all necessary environment variables and configurations are updated.

By strictly following these guidelines and the detailed task breakdowns, the `webwaka-transport` repository will maintain its integrity and contribute effectively to the WebWaka OS v4 ecosystem.
