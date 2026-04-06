-- WebWaka Transport Suite — Migration 005
-- Payment provider tracking and timestamp on trns_bookings
-- Supports Paystack / Flutterwave / manual / cash
-- ============================================================

-- Track which payment provider processed the transaction
ALTER TABLE trns_bookings ADD COLUMN payment_provider TEXT DEFAULT 'manual';

-- Timestamp when payment was confirmed by the gateway
ALTER TABLE trns_bookings ADD COLUMN paid_at INTEGER;

-- Index: look up trns_bookings by payment_reference (webhook + verify)
CREATE INDEX IF NOT EXISTS idx_bookings_payment_ref ON trns_bookings(payment_reference);
