-- WebWaka Transport Suite — Migration 005
-- Payment provider tracking and timestamp on trsp_bookings
-- NOTE: payment_provider, paid_at, payment_reference were already added in
--       001_transport_schema.sql — the ALTER TABLE statements are omitted here
--       to prevent "duplicate column" errors on the shared production database.
-- ============================================================

-- Index: look up trsp_bookings by payment_reference (webhook + verify)
CREATE INDEX IF NOT EXISTS idx_bookings_payment_ref ON trsp_bookings(payment_reference);
