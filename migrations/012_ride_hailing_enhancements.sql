-- WebWaka Transport Suite — Phase Enhancement Migration
-- Adds: Ride Hailing, Surge Pricing, Driver Verification, Vehicle Inspections (Daily),
--       Promo Codes, Tips, Lost & Found, EV Stations, Scheduled Rides, Carpooling,
--       Corporate Billing, Wait-Time Billing, Toll Fees, Multi-Stop Rides
-- All monetary values in kobo (integer), timestamps in Unix milliseconds.

-- ============================================================
-- RIDE HAILING: Active Drivers (real-time location index)
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_active_drivers (
  driver_id TEXT PRIMARY KEY REFERENCES trns_drivers(id),
  operator_id TEXT NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  status TEXT NOT NULL DEFAULT 'available', -- available | on_ride | offline
  vehicle_id TEXT REFERENCES trns_vehicles(id),
  last_seen_at INTEGER NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_active_drivers_status ON trns_active_drivers(status);
CREATE INDEX IF NOT EXISTS idx_active_drivers_operator ON trns_active_drivers(operator_id);

-- ============================================================
-- RIDE HAILING: Ride Requests
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_ride_requests (
  id TEXT PRIMARY KEY,
  customer_id TEXT REFERENCES trns_customers(id),
  operator_id TEXT,
  pickup_latitude REAL NOT NULL,
  pickup_longitude REAL NOT NULL,
  pickup_address TEXT,
  dropoff_latitude REAL NOT NULL,
  dropoff_longitude REAL NOT NULL,
  dropoff_address TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | matched | accepted | in_progress | completed | cancelled
  driver_id TEXT REFERENCES trns_drivers(id),
  vehicle_id TEXT REFERENCES trns_vehicles(id),
  matched_at INTEGER,
  accepted_at INTEGER,
  started_at INTEGER,
  completed_at INTEGER,
  cancelled_at INTEGER,
  cancellation_reason TEXT,
  base_fare_kobo INTEGER,
  surge_multiplier REAL NOT NULL DEFAULT 1.0,
  final_fare_kobo INTEGER,
  toll_fees_kobo INTEGER NOT NULL DEFAULT 0,
  wait_time_seconds INTEGER NOT NULL DEFAULT 0,
  wait_time_charge_kobo INTEGER NOT NULL DEFAULT 0,
  tip_kobo INTEGER NOT NULL DEFAULT 0,
  distance_km REAL,
  duration_minutes REAL,
  is_carpooled INTEGER NOT NULL DEFAULT 0,
  carpool_group_id TEXT,
  is_scheduled INTEGER NOT NULL DEFAULT 0,
  scheduled_for INTEGER,
  promo_code TEXT,
  promo_discount_kobo INTEGER NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ride_requests_customer ON trns_ride_requests(customer_id);
CREATE INDEX IF NOT EXISTS idx_ride_requests_driver ON trns_ride_requests(driver_id);
CREATE INDEX IF NOT EXISTS idx_ride_requests_status ON trns_ride_requests(status);
CREATE INDEX IF NOT EXISTS idx_ride_requests_carpool ON trns_ride_requests(carpool_group_id) WHERE carpool_group_id IS NOT NULL;

-- ============================================================
-- RIDE HAILING: Multi-stop waypoints for a ride request
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_ride_waypoints (
  id TEXT PRIMARY KEY,
  ride_request_id TEXT NOT NULL REFERENCES trns_ride_requests(id),
  sequence INTEGER NOT NULL,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  address TEXT,
  arrived_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_ride_waypoints ON trns_ride_waypoints(ride_request_id, sequence);

-- ============================================================
-- SURGE PRICING: Zone demand snapshots
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_surge_snapshots (
  id TEXT PRIMARY KEY,
  zone_id TEXT NOT NULL,
  operator_id TEXT,
  active_riders INTEGER NOT NULL DEFAULT 0,
  available_drivers INTEGER NOT NULL DEFAULT 0,
  demand_ratio REAL NOT NULL DEFAULT 1.0,
  surge_multiplier REAL NOT NULL DEFAULT 1.0,
  ai_context TEXT, -- JSON: weather, time_of_day, etc.
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_surge_zone ON trns_surge_snapshots(zone_id, created_at);

-- ============================================================
-- DRIVER VERIFICATION: Daily selfie check (shift start)
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_driver_verifications (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES trns_drivers(id),
  operator_id TEXT NOT NULL,
  verification_type TEXT NOT NULL DEFAULT 'selfie_check', -- selfie_check | document | biometric
  selfie_url TEXT,
  status TEXT NOT NULL DEFAULT 'pending', -- pending | approved | rejected | expired
  reviewed_by TEXT,
  reviewed_at INTEGER,
  expires_at INTEGER NOT NULL,
  shift_date TEXT NOT NULL, -- YYYY-MM-DD, unique per driver per day
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_verification_shift ON trns_driver_verifications(driver_id, shift_date);
CREATE INDEX IF NOT EXISTS idx_driver_verification_driver ON trns_driver_verifications(driver_id);

-- ============================================================
-- VEHICLE INSPECTIONS: Daily pre-trip digital forms
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_daily_vehicle_inspections (
  id TEXT PRIMARY KEY,
  vehicle_id TEXT NOT NULL REFERENCES trns_vehicles(id),
  driver_id TEXT REFERENCES trns_drivers(id),
  operator_id TEXT NOT NULL,
  inspection_date TEXT NOT NULL, -- YYYY-MM-DD
  tires_ok INTEGER NOT NULL DEFAULT 0,
  brakes_ok INTEGER NOT NULL DEFAULT 0,
  lights_ok INTEGER NOT NULL DEFAULT 0,
  fuel_level TEXT, -- full | 3/4 | 1/2 | 1/4 | empty
  engine_ok INTEGER NOT NULL DEFAULT 0,
  ac_ok INTEGER NOT NULL DEFAULT 0,
  mirrors_ok INTEGER NOT NULL DEFAULT 0,
  emergency_equipment_ok INTEGER NOT NULL DEFAULT 0,
  fire_extinguisher_ok INTEGER NOT NULL DEFAULT 0,
  first_aid_ok INTEGER NOT NULL DEFAULT 0,
  mileage_km INTEGER,
  notes TEXT,
  photos TEXT, -- JSON array of URLs
  status TEXT NOT NULL DEFAULT 'passed', -- passed | failed | conditional
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_daily_inspection ON trns_daily_vehicle_inspections(vehicle_id, inspection_date);
CREATE INDEX IF NOT EXISTS idx_daily_inspection_operator ON trns_daily_vehicle_inspections(operator_id);

-- ============================================================
-- PROMO CODES
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_promo_codes (
  id TEXT PRIMARY KEY,
  operator_id TEXT REFERENCES trns_operators(id),
  code TEXT NOT NULL UNIQUE,
  description TEXT,
  discount_type TEXT NOT NULL, -- percentage | flat
  discount_value INTEGER NOT NULL, -- percent (0-100) or kobo
  max_uses INTEGER,
  used_count INTEGER NOT NULL DEFAULT 0,
  min_fare_kobo INTEGER NOT NULL DEFAULT 0,
  max_discount_kobo INTEGER,
  valid_from INTEGER NOT NULL,
  valid_until INTEGER NOT NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_by TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_promo_code ON trns_promo_codes(code);
CREATE INDEX IF NOT EXISTS idx_promo_operator ON trns_promo_codes(operator_id);

CREATE TABLE IF NOT EXISTS trns_promo_code_uses (
  id TEXT PRIMARY KEY,
  promo_code_id TEXT NOT NULL REFERENCES trns_promo_codes(id),
  customer_id TEXT REFERENCES trns_customers(id),
  booking_id TEXT REFERENCES trns_bookings(id),
  ride_request_id TEXT REFERENCES trns_ride_requests(id),
  discount_applied_kobo INTEGER NOT NULL,
  used_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_promo_uses_code ON trns_promo_code_uses(promo_code_id);
CREATE INDEX IF NOT EXISTS idx_promo_uses_customer ON trns_promo_code_uses(customer_id);

-- ============================================================
-- DRIVER TIPPING
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_driver_tips (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES trns_drivers(id),
  customer_id TEXT REFERENCES trns_customers(id),
  booking_id TEXT REFERENCES trns_bookings(id),
  ride_request_id TEXT REFERENCES trns_ride_requests(id),
  amount_kobo INTEGER NOT NULL,
  payment_method TEXT NOT NULL DEFAULT 'card', -- card | cash | wallet
  payment_reference TEXT,
  message TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_tips_driver ON trns_driver_tips(driver_id);
CREATE INDEX IF NOT EXISTS idx_tips_customer ON trns_driver_tips(customer_id);

-- ============================================================
-- DRIVER EARNINGS
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_driver_earnings (
  id TEXT PRIMARY KEY,
  driver_id TEXT NOT NULL REFERENCES trns_drivers(id),
  operator_id TEXT NOT NULL,
  date TEXT NOT NULL, -- YYYY-MM-DD
  trips_completed INTEGER NOT NULL DEFAULT 0,
  gross_earnings_kobo INTEGER NOT NULL DEFAULT 0,
  platform_commission_kobo INTEGER NOT NULL DEFAULT 0,
  net_earnings_kobo INTEGER NOT NULL DEFAULT 0,
  tips_kobo INTEGER NOT NULL DEFAULT 0,
  bonuses_kobo INTEGER NOT NULL DEFAULT 0,
  km_driven REAL NOT NULL DEFAULT 0,
  hours_online REAL NOT NULL DEFAULT 0,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_driver_earnings_date ON trns_driver_earnings(driver_id, date);
CREATE INDEX IF NOT EXISTS idx_driver_earnings_driver ON trns_driver_earnings(driver_id);

-- ============================================================
-- LOST & FOUND
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_lost_found_items (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  reporter_type TEXT NOT NULL DEFAULT 'passenger', -- passenger | driver | staff
  reporter_id TEXT,
  reporter_name TEXT NOT NULL,
  reporter_phone TEXT NOT NULL,
  trip_id TEXT REFERENCES trns_trips(id),
  vehicle_id TEXT REFERENCES trns_vehicles(id),
  item_description TEXT NOT NULL,
  item_category TEXT, -- bag | phone | wallet | clothing | documents | electronics | other
  found_at TEXT, -- location description
  status TEXT NOT NULL DEFAULT 'reported', -- reported | stored | claimed | unclaimed | disposed
  photos TEXT, -- JSON array of photo URLs
  claimant_name TEXT,
  claimant_phone TEXT,
  claimed_at INTEGER,
  storage_location TEXT,
  notes TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_lost_found_operator ON trns_lost_found_items(operator_id);
CREATE INDEX IF NOT EXISTS idx_lost_found_trip ON trns_lost_found_items(trip_id);
CREATE INDEX IF NOT EXISTS idx_lost_found_status ON trns_lost_found_items(status);

-- ============================================================
-- EV CHARGING STATIONS
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_ev_charging_stations (
  id TEXT PRIMARY KEY,
  operator_id TEXT REFERENCES trns_operators(id),
  name TEXT NOT NULL,
  address TEXT,
  city TEXT NOT NULL,
  state TEXT,
  latitude REAL NOT NULL,
  longitude REAL NOT NULL,
  connector_types TEXT NOT NULL, -- JSON array: ["Type2","CCS","CHAdeMO"]
  total_points INTEGER NOT NULL DEFAULT 1,
  available_points INTEGER NOT NULL DEFAULT 1,
  max_power_kw REAL,
  price_per_kwh_kobo INTEGER,
  is_public INTEGER NOT NULL DEFAULT 1,
  amenities TEXT, -- JSON array: ["wifi","restroom","food"]
  operating_hours TEXT, -- "24/7" or "06:00-22:00"
  status TEXT NOT NULL DEFAULT 'active', -- active | offline | maintenance
  last_heartbeat INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);
CREATE INDEX IF NOT EXISTS idx_ev_stations_city ON trns_ev_charging_stations(city, status);
CREATE INDEX IF NOT EXISTS idx_ev_stations_operator ON trns_ev_charging_stations(operator_id);

-- ============================================================
-- TOLL FEES: Route toll gate definitions
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_toll_gates (
  id TEXT PRIMARY KEY,
  route_id TEXT REFERENCES trns_routes(id),
  name TEXT NOT NULL,
  location TEXT NOT NULL,
  latitude REAL,
  longitude REAL,
  fee_kobo INTEGER NOT NULL,
  vehicle_type TEXT, -- null = all, or specific type
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_toll_gates_route ON trns_toll_gates(route_id);

-- ============================================================
-- WAIT TIME BILLING CONFIGURATION
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_wait_time_config (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL REFERENCES trns_operators(id),
  free_wait_seconds INTEGER NOT NULL DEFAULT 180, -- 3 min free wait
  charge_per_minute_kobo INTEGER NOT NULL DEFAULT 5000, -- ₦50/min after free period
  max_wait_minutes INTEGER NOT NULL DEFAULT 15,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_wait_config_operator ON trns_wait_time_config(operator_id);

-- ============================================================
-- CARPOOLING / RIDE SHARING
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_carpool_groups (
  id TEXT PRIMARY KEY,
  operator_id TEXT,
  origin TEXT NOT NULL,
  destination TEXT NOT NULL,
  departure_time INTEGER NOT NULL,
  driver_id TEXT REFERENCES trns_drivers(id),
  vehicle_id TEXT REFERENCES trns_vehicles(id),
  max_passengers INTEGER NOT NULL DEFAULT 4,
  current_passengers INTEGER NOT NULL DEFAULT 0,
  base_fare_per_seat_kobo INTEGER NOT NULL,
  status TEXT NOT NULL DEFAULT 'open', -- open | full | in_progress | completed | cancelled
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_carpool_status ON trns_carpool_groups(status, departure_time);

-- ============================================================
-- CORPORATE BILLING ACCOUNTS (extend existing corporate customer support)
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_corporate_accounts (
  id TEXT PRIMARY KEY,
  customer_id TEXT NOT NULL REFERENCES trns_customers(id),
  company_name TEXT NOT NULL,
  company_registration TEXT,
  billing_email TEXT NOT NULL,
  credit_limit_kobo INTEGER NOT NULL DEFAULT 0,
  current_balance_kobo INTEGER NOT NULL DEFAULT 0,
  billing_cycle TEXT NOT NULL DEFAULT 'monthly', -- monthly | weekly
  payment_terms_days INTEGER NOT NULL DEFAULT 30,
  is_active INTEGER NOT NULL DEFAULT 1,
  approved_by TEXT,
  approved_at INTEGER,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_corporate_customer ON trns_corporate_accounts(customer_id);

CREATE TABLE IF NOT EXISTS trns_corporate_invoices (
  id TEXT PRIMARY KEY,
  corporate_account_id TEXT NOT NULL REFERENCES trns_corporate_accounts(id),
  period_start INTEGER NOT NULL,
  period_end INTEGER NOT NULL,
  total_amount_kobo INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL DEFAULT 'draft', -- draft | sent | paid | overdue
  due_date INTEGER NOT NULL,
  payment_reference TEXT,
  paid_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_corporate_invoices ON trns_corporate_invoices(corporate_account_id, status);

-- ============================================================
-- INTER-CITY TRANSPORT (Luggage allowances for long-distance)
-- ============================================================
CREATE TABLE IF NOT EXISTS trns_intercity_bookings (
  id TEXT PRIMARY KEY,
  booking_id TEXT NOT NULL REFERENCES trns_bookings(id),
  luggage_count INTEGER NOT NULL DEFAULT 0,
  excess_luggage_kg REAL NOT NULL DEFAULT 0,
  excess_luggage_fee_kobo INTEGER NOT NULL DEFAULT 0,
  insurance_opted INTEGER NOT NULL DEFAULT 0,
  insurance_premium_kobo INTEGER NOT NULL DEFAULT 0,
  special_assistance TEXT,
  created_at INTEGER NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_intercity_booking ON trns_intercity_bookings(booking_id);

-- Extend trns_trips with SOS fields if not present
ALTER TABLE trns_trips ADD COLUMN sos_message TEXT;
ALTER TABLE trns_trips ADD COLUMN sos_location_lat REAL;
ALTER TABLE trns_trips ADD COLUMN sos_location_lng REAL;
