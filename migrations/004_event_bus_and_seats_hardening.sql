-- WebWaka Transport Suite — Migration 004
-- Event Bus hardening: retry_count, processed_at, last_error columns
-- Seat Inventory: version column for optimistic concurrency
-- Cron sweeper compatibility: all columns referenced by scheduled() handler
-- ============================================================

-- Event Bus outbox: columns required by the cron drain consumer
ALTER TABLE platform_events ADD COLUMN retry_count INTEGER DEFAULT 0;
ALTER TABLE platform_events ADD COLUMN processed_at INTEGER;
ALTER TABLE platform_events ADD COLUMN last_error TEXT;

-- Seat Inventory: version vector for optimistic concurrency control
-- Incremented on every state change; used by sync conflict detection
ALTER TABLE seats ADD COLUMN version INTEGER NOT NULL DEFAULT 0;

-- Seats: operator_id denormalization for cron sweeper performance
-- Avoids a JOIN to trips→operators on every sweeper tick
ALTER TABLE seats ADD COLUMN operator_id TEXT;

-- Seats: seat class for future pricing tiers
ALTER TABLE seats ADD COLUMN seat_class TEXT NOT NULL DEFAULT 'standard';

-- Trips: actual departure/arrival tracking
ALTER TABLE trips ADD COLUMN actual_departure_time INTEGER;
ALTER TABLE trips ADD COLUMN actual_arrival_time INTEGER;

-- Trips: SOS safety protocol fields
ALTER TABLE trips ADD COLUMN sos_active INTEGER NOT NULL DEFAULT 0;
ALTER TABLE trips ADD COLUMN sos_triggered_at INTEGER;
ALTER TABLE trips ADD COLUMN sos_cleared_at INTEGER;
ALTER TABLE trips ADD COLUMN sos_cleared_by TEXT;

-- Trips: departure mode for fill-and-go operations
ALTER TABLE trips ADD COLUMN departure_mode TEXT NOT NULL DEFAULT 'scheduled';

-- Bookings: boarding check-in columns
ALTER TABLE bookings ADD COLUMN boarded_at INTEGER;
ALTER TABLE bookings ADD COLUMN boarded_by TEXT;

-- Index for cron sweeper performance (expired reservations query)
CREATE INDEX IF NOT EXISTS idx_seats_reserved_expires ON seats(status, reservation_expires_at);

-- Index for pending events drain
CREATE INDEX IF NOT EXISTS idx_platform_events_pending ON platform_events(status, retry_count, created_at);
