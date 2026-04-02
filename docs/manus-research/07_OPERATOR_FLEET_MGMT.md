# Top 20 Operator, Fleet & Route Management Enhancements

The operator management module is the administrative backbone of the transport repository. It enables mid-sized transport companies to configure their fleets, define routes, and analyze revenue. The following 20 enhancements focus on automation, compliance, and B2B integration.

## 1. Route & Schedule Automation

**Automated Schedule Generation (D-16)**
Operators spend hours manually creating individual trips. The `schedules` table exists but lacks an execution engine. The system must implement a cron job that reads active schedules (e.g., "Lagos to Abuja, daily at 07:00 AM") and automatically generates the corresponding `trips` and `seats` records 30 days in advance (defined by `horizon_days`). This is a massive time-saver and ensures inventory is always available for advance booking.

**Dynamic Fare Matrix Engine (O-08)**
The `routes` table contains a `fare_matrix` JSON column. The system must provide a UI for operators to define complex pricing rules based on seasonality (e.g., Christmas surge), day of the week, and booking lead time. This engine intercepts the base fare and applies the modifiers before the booking portal displays the price.

**Multi-Leg Route Stop Configuration (O-06)**
The `route_stops` table exists to support intermediate drop-offs (e.g., Lagos → Ibadan → Akure). The management UI must allow operators to define the sequence, distance, and partial fare for each stop. This is a prerequisite for Multi-Leg Seat Release, enabling a single physical seat to be sold twice on the same journey.

**Bulk Import Wizard (O-18)**
Migrating a mid-sized operator with 50 buses, 60 drivers, and 20 routes is a major onboarding barrier. The existing `/import/routes`, `/import/vehicles`, and `/import/drivers` endpoints must be wired to a user-friendly CSV upload wizard in the admin portal. This drastically reduces time-to-first-trip for new tenants.

**Operator Onboarding Wizard (O-09)**
A step-by-step setup guide for new operators that enforces the configuration of essential settings (branding, payment gateways, base routes, and initial fleet) before their portal goes live. This utilizes the `TENANT_CONFIG_KV` store to track onboarding progress.

## 2. Fleet & Driver Compliance

**Vehicle Maintenance Scheduling (O-02)**
The `vehicles` table includes a `maintenance_status` column. The system must provide a maintenance log where operators can schedule routine servicing (e.g., oil changes every 10,000 km). When a vehicle is marked as "In Maintenance," the automated schedule generator must exclude it from trip assignments, preventing operational failures.

**Driver Document Expiry Tracking (O-04)**
FRSC compliance requires valid driver's licenses and certifications. The `drivers` table must be enhanced to store document expiry dates. The system must run a daily cron job that publishes a `driver.document_expiring` event 30 days before expiration. The `@webwaka/core/notifications` module alerts the operator's HR team.

**Vehicle Seat Templates (O-03)**
Buses come in various configurations (e.g., 14-seater Hiace, 50-seater Marcopolo). The `vehicles` table has a `seat_template` column. The management UI must include a visual drag-and-drop seat map builder. When a trip is generated, it clones this template to populate the `seats` table, ensuring the booking portal accurately reflects the physical vehicle layout.

**Terminal Registry & Assignment (O-01)**
The `terminals` table must be fully exposed in the UI. Operators need to assign agents, vehicles, and specific routes to physical terminals. This enables terminal-specific reporting and allows dispatchers to filter their dashboard to only see trips originating from their location.

**Fleet Telemetry Dashboard**
A unified view for the fleet manager showing the real-time status of all vehicles: In Transit, Available, In Maintenance, or Out of Service. This aggregates data from the `trips` and `vehicles` tables to maximize fleet utilization.

## 3. Financial & B2B Integration

**Revenue per Route Analytics (O-05)**
Operators lack visibility into route profitability. The system must provide a BI dashboard that aggregates `sales_transactions` and `bookings` data to calculate Revenue per Available Seat Kilometer (RASK) and load factors for each route. This requires querying the D1 database with tenant scoping applied.

**Operator API Keys (O-12)**
Large operators often want to integrate their transport inventory with third-party aggregators (e.g., Treepz, BuuPass) or their own legacy ERP systems. The system must expose the `/api-keys` endpoints to allow operators to generate scoped API tokens for secure B2B integration.

**Subscription Tier Gating (O-15)**
The `operators` table includes a `subscription_tier` column (basic/pro/enterprise). The backend currently uses a `requireTierFeature` middleware. This must be fully mapped so that premium features (like the API keys, white-label portal, and advanced analytics) are strictly gated, driving SaaS revenue for WebWaka.

**Corporate Travel Account Management**
Operators need an interface to approve and manage corporate clients. This involves setting the `credit_limit_kobo` in the `customers` table and reviewing monthly invoices. This feature bridges the Transport repository and the Central Management repository's billing engine.

**Agent Commission Settlement Export**
At the end of a pay period, operators need to export the aggregated agent commissions (calculated from A-06) into a format suitable for their payroll system. The system should provide a CSV export or directly integrate with the Fintech repository to initiate bulk transfers to the agents' mobile wallets.

## 4. Platform Administration & Security

**SUPER_ADMIN Analytics (O-20)**
WebWaka platform administrators need a macro view of the entire transport ecosystem. This dashboard must aggregate GMV, total trips, active operators, and system error rates across all tenants. This is critical for platform health monitoring and investor reporting.

**White-Label Branding Config (O-14)**
The `/config/logo` and `/config/branding` endpoints currently write to the `ASSETS_R2` bucket and `TENANT_CONFIG_KV`. The admin UI must expose a comprehensive branding editor allowing Enterprise-tier operators to customize their booking portal's primary colors, fonts, and custom domain routing.

**Role-Based Access Control (RBAC) UI**
Operators must be able to invite staff and assign specific roles (`TENANT_ADMIN`, `SUPERVISOR`, `DISPATCHER`, `AGENT`). The `@webwaka/core/rbac` primitive handles the enforcement, but the transport repo needs the user management UI to assign these roles to the operator's `tenant_id`.

**Audit Log Viewer**
For dispute resolution and security, operators need an audit trail of sensitive actions (e.g., voiding a ticket, changing a fare, overriding a float reconciliation). The system should query the platform event bus for `audit.*` events related to the tenant and display them in a chronological log.

**System Configuration & Sweeper Status**
A developer-focused dashboard within the SUPER_ADMIN view that displays the health of the Cloudflare infrastructure: Durable Object connection counts, offline sync queue depths, and the execution status of the critical scheduled sweepers (`drainEventBus`, `sweepExpiredReservations`).
