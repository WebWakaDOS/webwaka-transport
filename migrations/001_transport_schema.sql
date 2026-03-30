-- WebWaka Transport Suite - D1 Schema Migration
-- TRN-1: Seat Inventory, TRN-2: Agent Sales, TRN-3: Customer Booking, TRN-4: Operator Management
-- All monetary values in kobo (integer), soft deletes enforced
-- ============================================================
-- OPERATORS & ROUTES
-- ============================================================
CREATE TABLE IF NOT EXISTS operators (
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

CREATE TABLE IF NOT EXISTS routes (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
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

CREATE TABLE IF NOT EXISTS vehicles (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
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
-- TRIPS & SEAT INVENTORY (TRN-1)
-- ============================================================
CREATE TABLE IF NOT EXISTS trips (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  route_id TEXT NOT NULL REFERENCES routes(id),
  vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
  driver_id TEXT,
  departure_time INTEGER NOT NULL, -- unix timestamp
  estimated_arrival_time INTEGER,
  state TEXT NOT NULL DEFAULT 'scheduled', -- scheduled | boarding | in_transit | completed | cancelled
  current_latitude REAL,
  current_longitude REAL,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS seats (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  seat_number TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'available', -- available | reserved | confirmed | blocked
  reserved_by TEXT,
  reservation_token TEXT,
  reservation_expires_at INTEGER, -- unix timestamp
  confirmed_by TEXT,
  confirmed_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS trip_state_transitions (
  id TEXT PRIMARY KEY,
  trip_id TEXT NOT NULL REFERENCES trips(id),
  from_state TEXT NOT NULL,
  to_state TEXT NOT NULL,
  reason TEXT,
  transitioned_at INTEGER NOT NULL
);

-- ============================================================
-- AGENTS (TRN-2)
-- ============================================================
CREATE TABLE IF NOT EXISTS agents (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES operators(id),
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  role TEXT NOT NULL DEFAULT 'agent', -- agent | supervisor
  bus_parks TEXT, -- JSON array of bus park IDs
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

-- ============================================================
-- SALES TRANSACTIONS (TRN-2: Agent Sales)
-- ============================================================
CREATE TABLE IF NOT EXISTS sales_transactions (
  id TEXT PRIMARY KEY,
  agent_id TEXT NOT NULL REFERENCES agents(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
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

CREATE TABLE IF NOT EXISTS receipts (
  id TEXT PRIMARY KEY,
  transaction_id TEXT NOT NULL REFERENCES sales_transactions(id),
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
CREATE TABLE IF NOT EXISTS customers (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  phone TEXT NOT NULL,
  email TEXT,
  ndpr_consent INTEGER NOT NULL DEFAULT 0, -- 1 = consented
  status TEXT NOT NULL DEFAULT 'active',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE TABLE IF NOT EXISTS bookings (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES customers(id),
  trip_id TEXT NOT NULL REFERENCES trips(id),
  seat_ids TEXT NOT NULL, -- JSON array
  passenger_names TEXT NOT NULL, -- JSON array
  total_amount INTEGER NOT NULL, -- kobo
  status TEXT NOT NULL DEFAULT 'pending', -- pending | confirmed | cancelled | completed
  payment_status TEXT NOT NULL DEFAULT 'pending', -- pending | completed | failed
  payment_method TEXT NOT NULL, -- paystack | flutterwave | bank_transfer
  payment_reference TEXT,
  created_at INTEGER NOT NULL,
  confirmed_at INTEGER,
  cancelled_at INTEGER,
  deleted_at INTEGER
);

-- ============================================================
-- OFFLINE SYNC QUEUE
-- ============================================================
CREATE TABLE IF NOT EXISTS sync_mutations (
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
-- INDEXES
-- ============================================================
CREATE INDEX IF NOT EXISTS idx_trips_operator ON trips(operator_id);
CREATE INDEX IF NOT EXISTS idx_trips_state ON trips(state);
CREATE INDEX IF NOT EXISTS idx_trips_departure ON trips(departure_time);
CREATE INDEX IF NOT EXISTS idx_seats_trip ON seats(trip_id);
CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status);
CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id);
CREATE INDEX IF NOT EXISTS idx_bookings_trip ON bookings(trip_id);
CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status);
CREATE INDEX IF NOT EXISTS idx_sales_agent ON sales_transactions(agent_id);
CREATE INDEX IF NOT EXISTS idx_sales_trip ON sales_transactions(trip_id);
CREATE INDEX IF NOT EXISTS idx_sales_sync ON sales_transactions(sync_status);
CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_mutations(status);
