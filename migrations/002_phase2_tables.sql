-- WebWaka Transport Suite — Phase P02 Schema Migration
-- Creates all new tables needed for Phases P02-P11.
-- NOTE: This file is the canonical reference. The authoritative runtime source is
--       src/api/admin.ts (embedded migration '010_phase2_tables').
-- Monetary values in kobo (integers). Timestamps in Unix milliseconds.

-- api_keys (P01-T4)
CREATE TABLE IF NOT EXISTS api_keys (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  name TEXT NOT NULL,
  key_hash TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL DEFAULT 'read',
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  last_used_at INTEGER,
  revoked_at INTEGER,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_api_keys_operator ON api_keys(operator_id);
CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash);

-- ndpr_consent_log (P01-T3)
CREATE TABLE IF NOT EXISTS ndpr_consent_log (
  id TEXT PRIMARY KEY,
  entity_id TEXT NOT NULL,
  entity_type TEXT NOT NULL,
  consented_at INTEGER NOT NULL,
  ip_address TEXT,
  user_agent TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ndpr_entity ON ndpr_consent_log(entity_id, entity_type);

-- bus_parks / terminals (A-07, O-01)
CREATE TABLE IF NOT EXISTS bus_parks (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  name TEXT NOT NULL,
  city TEXT NOT NULL,
  state TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS agent_bus_parks (
  agent_id TEXT NOT NULL REFERENCES agents(id),
  park_id TEXT NOT NULL REFERENCES bus_parks(id),
  PRIMARY KEY (agent_id, park_id)
);

-- float_reconciliation (A-03)
CREATE TABLE IF NOT EXISTS float_reconciliation (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  operator_id TEXT NOT NULL,
  period_date TEXT NOT NULL,
  expected_kobo INTEGER NOT NULL,
  submitted_kobo INTEGER NOT NULL,
  discrepancy_kobo INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  reviewed_by TEXT,
  reviewed_at INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_reconciliation_agent_date ON float_reconciliation(agent_id, period_date);

-- trip_inspections (D-05)
CREATE TABLE IF NOT EXISTS trip_inspections (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  inspected_by TEXT NOT NULL,
  tires_ok INTEGER NOT NULL DEFAULT 0,
  brakes_ok INTEGER NOT NULL DEFAULT 0,
  lights_ok INTEGER NOT NULL DEFAULT 0,
  fuel_ok INTEGER NOT NULL DEFAULT 0,
  emergency_equipment_ok INTEGER NOT NULL DEFAULT 0,
  manifest_count INTEGER,
  notes TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_inspection_trip ON trip_inspections(trip_id);

-- seat_history (S-19)
CREATE TABLE IF NOT EXISTS seat_history (
  id TEXT PRIMARY KEY,
  seat_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  from_status TEXT,
  to_status TEXT NOT NULL,
  actor_id TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_seat_history_seat ON seat_history(seat_id);

-- vehicle_maintenance_records (O-02)
CREATE TABLE IF NOT EXISTS vehicle_maintenance_records (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  operator_id TEXT NOT NULL,
  service_type TEXT NOT NULL,
  service_date INTEGER NOT NULL,
  next_service_due INTEGER,
  notes TEXT,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_maintenance_vehicle ON vehicle_maintenance_records(vehicle_id);

-- vehicle_documents (O-02)
CREATE TABLE IF NOT EXISTS vehicle_documents (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  operator_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_number TEXT,
  issued_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_vehicle_docs ON vehicle_documents(vehicle_id, doc_type);

-- driver_documents (O-04)
CREATE TABLE IF NOT EXISTS driver_documents (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES drivers(id),
  operator_id TEXT NOT NULL,
  doc_type TEXT NOT NULL,
  doc_number TEXT,
  license_category TEXT,
  issued_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_driver_docs ON driver_documents(driver_id, doc_type);

-- waiting_list (S-18)
CREATE TABLE IF NOT EXISTS waiting_list (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  seat_class TEXT NOT NULL DEFAULT 'standard',
  position INTEGER NOT NULL,
  notified_at INTEGER,
  expires_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_waiting_list_trip ON waiting_list(trip_id, position);

-- operator_reviews (B-10)
CREATE TABLE IF NOT EXISTS operator_reviews (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  booking_id TEXT NOT NULL REFERENCES bookings(id),
  customer_id TEXT NOT NULL REFERENCES customers(id),
  rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
  review_text TEXT,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_booking ON operator_reviews(booking_id);

-- schedules (D-16)
CREATE TABLE IF NOT EXISTS schedules (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  route_id TEXT NOT NULL REFERENCES routes(id),
  vehicle_id TEXT,
  driver_id TEXT,
  departure_time TEXT NOT NULL,
  recurrence TEXT NOT NULL DEFAULT 'daily',
  recurrence_days TEXT,
  horizon_days INTEGER NOT NULL DEFAULT 30,
  active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- agent_broadcasts (A-13)
CREATE TABLE IF NOT EXISTS agent_broadcasts (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  sent_by TEXT NOT NULL,
  message TEXT NOT NULL,
  priority TEXT NOT NULL DEFAULT 'normal',
  created_at INTEGER NOT NULL,
  expires_at INTEGER
);

-- dispute_tickets (A-20)
CREATE TABLE IF NOT EXISTS dispute_tickets (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  category TEXT NOT NULL,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  resolved_by TEXT,
  resolved_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tickets_agent ON dispute_tickets(agent_id);

-- route_stops (O-06)
CREATE TABLE IF NOT EXISTS route_stops (
  id TEXT PRIMARY KEY,
  route_id TEXT NOT NULL REFERENCES routes(id),
  stop_name TEXT NOT NULL,
  sequence INTEGER NOT NULL,
  distance_from_origin_km REAL,
  fare_from_origin_kobo INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_route_stops ON route_stops(route_id, sequence);

-- Add new columns to existing tables
-- Note: duplicate column errors are silently swallowed by the migration runner
ALTER TABLE trips ADD COLUMN inspection_completed_at INTEGER;
ALTER TABLE trips ADD COLUMN park_id TEXT;
ALTER TABLE bookings ADD COLUMN origin_stop_id TEXT;
ALTER TABLE bookings ADD COLUMN destination_stop_id TEXT;
ALTER TABLE bookings ADD COLUMN insurance_selected INTEGER DEFAULT 0;
ALTER TABLE bookings ADD COLUMN insurance_premium_kobo INTEGER DEFAULT 0;
ALTER TABLE agents ADD COLUMN commission_rate REAL DEFAULT 0.05;
ALTER TABLE vehicles ADD COLUMN seat_template TEXT;
ALTER TABLE routes ADD COLUMN route_stops_enabled INTEGER DEFAULT 0;
ALTER TABLE routes ADD COLUMN cancellation_policy TEXT;
ALTER TABLE routes ADD COLUMN fare_matrix TEXT;
