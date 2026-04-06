-- Migration 011: Trip Parcels (T-TRN-05)
-- Records cargo/parcel tracking numbers physically loaded onto a bus trip.
-- Transport owns waybill creation; the Logistics repo owns delivery tracking.
-- Events emitted:
--   trip.cargo_loaded   — on parcel(s) linked to a trip
--   trip.cargo_unloaded — when trip completes or parcel is manually removed

CREATE TABLE IF NOT EXISTS trns_trip_parcels (
  id              TEXT    PRIMARY KEY,
  trip_id         TEXT    NOT NULL REFERENCES trns_trips(id),
  operator_id     TEXT    NOT NULL,
  tracking_ref    TEXT    NOT NULL,
  description     TEXT,
  weight_kg       REAL,
  sender_name     TEXT,
  receiver_name   TEXT,
  receiver_phone  TEXT,
  loaded_at       INTEGER NOT NULL,
  loaded_by       TEXT,
  unloaded_at     INTEGER,
  status          TEXT    NOT NULL DEFAULT 'on_board',
  created_at      INTEGER NOT NULL,
  UNIQUE(trip_id, tracking_ref)
);

CREATE INDEX IF NOT EXISTS idx_trip_parcels_trip_id
  ON trns_trip_parcels(trip_id);

CREATE INDEX IF NOT EXISTS idx_trip_parcels_tracking_ref
  ON trns_trip_parcels(tracking_ref);

CREATE INDEX IF NOT EXISTS idx_trip_parcels_status
  ON trns_trip_parcels(trip_id, status);
