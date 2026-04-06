-- WebWaka Transport Suite - Migration 006
-- Adds trns_drivers table for operator-managed driver profiles
-- driver_id already exists as a nullable FK column in trns_trips (001_transport_schema.sql)

CREATE TABLE IF NOT EXISTS trns_drivers (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES trns_operators(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  license_number TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | suspended | inactive
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_drivers_operator ON trns_drivers(operator_id);
CREATE INDEX IF NOT EXISTS idx_drivers_status ON trns_drivers(status);
