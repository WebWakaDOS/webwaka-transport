-- Migration 007: P05-TRANSPORT trip operations columns
-- Managed via admin.ts MIGRATIONS array (name: '012_p05_trip_ops')
-- This file documents the additive schema changes for Phase P05.

-- GPS location timestamp (P05-T1)
ALTER TABLE trips ADD COLUMN location_updated_at INTEGER;

-- SOS: who triggered it (sos_triggered_at already added in migration 001; P05-T2)
ALTER TABLE trips ADD COLUMN sos_triggered_by TEXT;

-- Delay reporting columns (P05-T6)
ALTER TABLE trips ADD COLUMN delay_reason_code TEXT;
ALTER TABLE trips ADD COLUMN delay_reported_at INTEGER;
ALTER TABLE trips ADD COLUMN estimated_departure_ms INTEGER;
