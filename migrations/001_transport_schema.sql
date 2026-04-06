-- WebWaka Transport Suite - D1 Schema Migration
-- TRN-1: Seat Inventory, TRN-2: Agent Sales, TRN-3: Customer Booking, TRN-4: Operator Management
-- All monetary values in kobo (integer), soft deletes enforced
-- NOTE: This file is the canonical reference. The authoritative runtime source is
--       src/api/admin.ts (embedded migrations) which Cloudflare Workers execute.
-- ============================================================
-- OPERATORS & ROUTES
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_operators (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  phone TEXT,
  email TEXT,
  status TEXT NOT NULL DEFAULT 'active', -- active | suspended
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS trns_routes (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES trns_operators(id),
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  distance_km INTEGER,
  duration_minutes INTEGER,
  base_fare INTEGER NOT NULL, -- kobo
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS trns_vehicles (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES trns_operators(id),
  plate_number TEXT NOT NULL UNIQUE,
  vehicle_type TEXT NOT NULL, -- bus | minibus | car
  model TEXT, -- e.g. Toyota Coaster, Ford Transit
  total_seats INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- ============================================================
-- DRIVERS (TRN-4)
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_drivers (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES trns_operators(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  license_number TEXT,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- ============================================================
-- TRIPS & SEAT INVENTORY (TRN-1)
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_trips (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES trns_operators(id),
  route_id TEXT NOT NULL REFERENCES trns_routes(id),
  vehicle_id TEXT NOT NULL REFERENCES trns_vehicles(id),
  driver_id TEXT REFERENCES trns_drivers(id),
  departure_time INTEGER NOT NULL, -- unix timestamp ms
  estimated_arrival_time INTEGER,
  state TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | boarding | in_transit | completed | cancelled
  current_latitude REAL,
  current_longitude REAL,
  actual_departure_time INTEGER,
  actual_arrival_time INTEGER,
  departure_mode TEXT NOT NULL DEFAULT 'scheduled',
  sos_active INTEGER NOT NULL DEFAULT 0,
  sos_triggered_at INTEGER,
  sos_cleared_at INTEGER,
  sos_cleared_by TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS trns_seats (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trns_trips(id),
  operator_id TEXT,
  seat_number TEXT NOT NULL,
  seat_class TEXT NOT NULL DEFAULT 'standard',
  status TEXT NOT NULL DEFAULT 'available', -- available | reserved | confirmed | blocked
  reserved_by TEXT,
  reservation_token TEXT,
  reservation_expires_at INTEGER, -- unix timestamp ms
  confirmed_by TEXT,
  confirmed_at INTEGER,
  version INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trns_trip_state_transitions (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trns_trips(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT,
  transitioned_at INTEGER NOT NULL
);

-- ============================================================
-- AGENTS (TRN-2)
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_agents (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES trns_operators(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'agent', -- agent | supervisor
  trns_bus_parks TEXT, -- JSON array of bus park IDs
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- ============================================================
-- SALES TRANSACTIONS (TRN-2: Agent Sales)
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_sales_transactions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES trns_agents(id),
  trip_id TEXT NOT NULL REFERENCES trns_trips(id),
  seat_ids TEXT NOT NULL, -- JSON array
  passenger_names TEXT NOT NULL, -- JSON array
  total_amount INTEGER NOT NULL, -- kobo
  payment_method TEXT NOT NULL, -- cash | mobile_money | card
  payment_status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | failed
  sync_status TEXT NOT NULL DEFAULT 'pending', -- pending | synced | failed
  receipt_id TEXT,
  metadata TEXT, -- JSON
  created_at INTEGER NOT NULL,
  synced_at INTEGER,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS trns_receipts (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES trns_sales_transactions(id),
  agent_id TEXT NOT NULL,
  trip_id TEXT NOT NULL,
  passenger_names TEXT NOT NULL, -- JSON array
  seat_numbers TEXT NOT NULL, -- JSON array
  total_amount INTEGER NOT NULL, -- kobo
  payment_method TEXT NOT NULL,
  issued_at INTEGER NOT NULL,
  qr_code TEXT
);

-- ============================================================
-- CUSTOMERS & BOOKINGS (TRN-3: Customer Booking Portal)
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_customers (
  id TEXT PRIMARY KEY,
  name TEXT, -- nullable: OTP-auth creates trns_customers before name is collected
  phone TEXT NOT NULL,
  email TEXT,
  ndpr_consent INTEGER NOT NULL DEFAULT 0, -- 1 = consented
  consent_given_at INTEGER,
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS trns_bookings (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES trns_customers(id),
  trip_id TEXT NOT NULL REFERENCES trns_trips(id),
  seat_ids TEXT NOT NULL, -- JSON array
  passenger_names TEXT NOT NULL, -- JSON array
  total_amount INTEGER NOT NULL, -- kobo
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled | completed
  payment_status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | failed
  payment_method TEXT NOT NULL, -- paystack | flutterwave | bank_transfer | mobile_money
  payment_reference TEXT,
  payment_provider TEXT, -- paystack | dev
  paid_at INTEGER,
  boarded_at INTEGER,
  boarded_by TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  cancelled_at INTEGER,
  deleted_at INTEGER
);

-- ============================================================
-- OFFLINE SYNC QUEUE
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_sync_mutations (
  id TEXT PRIMARY KEY,
  entity_type TEXT NOT NULL, -- trip | seat | booking | transaction
  entity_id TEXT NOT NULL,
  action TEXT NOT NULL, -- CREATE | UPDATE | DELETE
  payload TEXT NOT NULL, -- JSON
  version INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'PENDING', -- PENDING | SYNCING | SYNCED | FAILED
  retry_count INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  created_at INTEGER NOT NULL,
  synced_at INTEGER
);

-- ============================================================
-- EVENT BUS (trns_platform_events outbox — migration 002)
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_platform_events (
  id TEXT PRIMARY KEY,
  event_type TEXT NOT NULL,
  aggregate_id TEXT NOT NULL,
  aggregate_type TEXT NOT NULL,
  payload TEXT NOT NULL,
  tenant_id TEXT,
  correlation_id TEXT,
  status TEXT NOT NULL DEFAULT 'pending',
  retry_count INTEGER DEFAULT 0,
  processed_at INTEGER,
  last_error TEXT,
  created_at INTEGER NOT NULL,
  dispatched_at INTEGER
);

-- ============================================================
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_drivers_operator ON trns_drivers(operator_id);
CREATE INDEX IF NOT EXISTS idx_drivers_status ON trns_drivers(status);
CREATE INDEX IF NOT EXISTS idx_trips_operator ON trns_trips(operator_id);
CREATE INDEX IF NOT EXISTS idx_trips_state ON trns_trips(state);
CREATE INDEX IF NOT EXISTS idx_trips_departure ON trns_trips(departure_time);
CREATE INDEX IF NOT EXISTS idx_seats_trip ON trns_seats(trip_id);
CREATE INDEX IF NOT EXISTS idx_seats_status ON trns_seats(status);
CREATE INDEX IF NOT EXISTS idx_seats_reserved_expires ON trns_seats(status, reservation_expires_at);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON trns_bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_trip ON trns_bookings(trip_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON trns_bookings(status);
CREATE INDEX IF NOT EXISTS idx_sales_agent ON trns_sales_transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sales_trip ON trns_sales_transactions(trip_id);
CREATE INDEX IF NOT EXISTS idx_sales_sync ON trns_sales_transactions(sync_status);
CREATE INDEX IF NOT EXISTS idx_sync_status ON trns_sync_mutations(status);
CREATE INDEX IF NOT EXISTS idx_platform_events_status ON trns_platform_events(status);
CREATE INDEX IF NOT EXISTS idx_platform_events_event_type ON trns_platform_events(event_type);
CREATE INDEX IF NOT EXISTS idx_platform_events_aggregate ON trns_platform_events(aggregate_type, aggregate_id);
CREATE INDEX IF NOT EXISTS idx_platform_events_pending ON trns_platform_events(status, retry_count, created_at);
