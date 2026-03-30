-- WebWaka Transport Suite — Migration 005
-- Payment provider tracking and timestamp on bookings
-- Supports Paystack / Flutterwave / manual / cash
-- ============================================================

-- Track which payment provider processed the transaction
ALTER TABLE bookings ADD COLUMN payment_provider TEXT DEFAULT 'manual';

-- Timestamp when payment was confirmed by the gateway
ALTER TABLE bookings ADD COLUMN paid_at INTEGER;

-- Index: look up bookings by payment_reference (webhook + verify)
CREATE INDEX IF NOT EXISTS idx_bookings_payment_ref ON bookings(payment_reference);
