# Top 20 Customer Booking Portal Enhancements

The customer booking portal is the primary digital touchpoint for passengers. In Nigeria, trust deficit and payment friction are the two largest barriers to online booking conversion. The following 20 enhancements focus on building trust, smoothing the payment experience, and expanding digital channels beyond the traditional web app.

## 1. Conversion & Payment Friction

**Paystack Inline Payment (B-01)**
The current payment flow redirects the user to a Paystack or Flutterwave hosted page. This context switch causes significant drop-off, especially on slow 3G networks where the redirect may timeout. The portal must implement the Paystack Inline JS or Flutterwave Modal to keep the user within the PWA context. This is a frontend change that directly impacts the bottom line.

**Guest Booking Flow (B-04)**
Forcing users to create an account before seeing the payment screen is a known conversion killer. The portal must support a frictionless guest checkout where only a phone number and name are required. The system can silently create a shadow `customers` record and associate the booking. If the user later registers with that phone number, the history is merged.

**Dynamic Fare Estimator**
Before the user enters the full booking flow, they should see a dynamic fare estimator on the search results page. This must calculate the base fare, any applicable dynamic pricing modifiers (B-18), and mandatory taxes (VAT) using the `@webwaka/core/tax` primitive. Transparency reduces cart abandonment.

**Installment Booking (BNPL Integration)**
For high-value interstate trips (e.g., Lagos to Kano) or group bookings, the portal should offer a "Buy Now, Pay Later" option at checkout. This requires integration with the Fintech repository's credit scoring module to offer instant installment plans based on the user's phone number and BVN.

**Corporate Travel Portal (B-13)**
The `customers` table already supports `customer_type` (individual/corporate) and `credit_limit_kobo`. The portal must expose a dedicated B2B view where corporate admins can book trips for employees against a pre-approved credit line. This requires integration with the Central Management repository for invoicing and the KYC module for corporate verification.

## 2. Trust & Communication

**SMS & WhatsApp Booking Confirmation (B-02, B-15)**
An email confirmation is insufficient in Nigeria; many users rarely check their inbox. The system must wire the `booking.created` event to the `@webwaka/core/notifications` service to immediately dispatch a WhatsApp message or SMS containing the booking reference, departure time, and a link to the e-ticket. This is the primary trust artifact for online buyers.

**E-Ticket with Scannable QR (B-03)**
The portal must generate a downloadable PDF or image e-ticket. This ticket must feature a scannable QR code that the driver or agent can read using the POS app at boarding (D-03). The ticket serves as the passenger's proof of purchase and must be accessible offline once downloaded.

**Transparent Refund Policy Display (B-06)**
Trust is built on clarity. The `routes` table contains a `cancellation_policy` column. The booking portal must prominently display this policy (e.g., "100% refund if cancelled 24h before, 50% within 12h") during checkout. The portal must also provide a self-service `PATCH /bookings/:id/cancel` endpoint that automatically processes the refund via the payment gateway or issues store credit.

**Verified Operator Reviews (B-10)**
The `operator_reviews` table exists but is underutilized. The portal should display aggregated ratings (e.g., "4.5/5 for Punctuality") on the search results page. To maintain integrity, reviews can only be submitted by passengers who have a `completed` trip state, ensuring all feedback is verified.

**Automated Booking Reminders (B-09)**
To reduce no-shows and departure delays, the system should schedule an automated WhatsApp or SMS reminder 12 hours and 2 hours before the `departure_time`. This utilizes the event bus and the `@webwaka/core/notifications` module.

## 3. Channel Expansion

**USSD Booking Channel (B-16)**
While smartphone penetration is growing, millions of Nigerians still rely on feature phones. The platform must expose a USSD menu (e.g., *123*4#) that interacts with the `booking-portal.ts` API. Users can search routes, select a date, and pay via their mobile money wallet, entirely over USSD.

**WhatsApp Conversational Booking Bot**
Leverage the `@webwaka/core/ai` module to build a conversational booking flow on WhatsApp. A user can message "I need a bus from Lagos to Abuja tomorrow morning." The AI parses the intent, queries the `GET /trips/search` endpoint, presents options, and generates a Paystack payment link within the chat.

**White-Label Operator Portals (O-14)**
Enterprise operators (e.g., GIGM, GUO) will not direct their customers to a generic WebWaka aggregator. The portal must support white-labeling, reading the `TENANT_CONFIG_KV` namespace to dynamically load the operator's logo, color scheme, and custom domain, while utilizing the shared backend infrastructure.

**Full i18n Vernacular Support (B-07)**
The `src/core/i18n/index.ts` module supports Yoruba, Igbo, and Hausa. The booking portal UI must expose a language toggle. Providing a booking experience in a user's native language significantly lowers the cognitive barrier to online transactions.

**Logistics Parcel Tracking Portal**
Passengers often ship parcels on the same buses they travel on. The booking portal should include a "Track Parcel" tab. When a user enters a waybill number, the portal queries the Logistics repository via an API gateway or reads a replicated read-model to display the parcel's status. The Transport repo does not manage the parcel; it merely displays the logistics data.

## 4. Personalization & Ancillary Revenue

**AI-Powered Trip Search**
The existing `AIEngine.chat()` integration should be enhanced to support natural language queries with fuzzy matching (e.g., "cheap bus to eastern Nigeria next weekend"). The AI maps this to specific `routes` and `departure_time` queries, providing a superior search experience.

**Seat Selection & Class Upsell**
If the operator has defined `seat_template` (O-03) and seat classes (S-04), the booking portal must render an interactive seat map. Users can select their preferred seat and pay the associated premium (e.g., VIP Front Row). This directly increases the Average Order Value (AOV).

**Travel Insurance Add-on**
The `bookings` table already includes `insurance_selected` and `insurance_premium_kobo` columns. The checkout flow must offer an opt-in travel insurance product (e.g., ₦500 for medical/baggage cover). This requires integration with a third-party insurtech API or the Central Management repository for premium reconciliation.

**Loyalty Points & Wallet Integration**
Frequent travelers should earn points for every booking. The portal should display a "Wallet Balance" tied to the customer's profile. Points can be redeemed for discounts on future trips. This requires a dedicated loyalty ledger, likely managed within the Central Management or Fintech repository.

**Post-Trip Cross-Sell**
When a trip reaches the `completed` state, the system should trigger a post-trip email or WhatsApp message asking for a review (B-10) and offering a discount code for their next booking or a related service (e.g., a hotel booking partner). This drives retention and repeat purchases.
