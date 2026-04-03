/**
 * WebWaka Platform — Admin API
 * POST /api/admin/migrations/run — applies pending D1 schema migrations
 *
 * Security: MIGRATION_SECRET header (Bearer token, not JWT) required.
 * This endpoint is intentionally excluded from jwtAuthMiddleware.
 *
 * Invariants: Build Once Use Infinitely, Zero Skipping (no `|| true`)
 */

import { Hono } from 'hono';

export interface AdminEnv {
  DB: D1Database;
  MIGRATION_SECRET?: string;
}

// ============================================================
// Schema migrations — embedded because Workers cannot read
// files at runtime. Must be kept in sync with migrations/*.sql
// Each migration is an array of individual SQL statements
// (D1 does not support multi-statement prepare).
// ============================================================

interface Migration {
  name: string;
  statements: string[];
}

const MIGRATIONS: Migration[] = [
  {
    name: '001_transport_schema',
    statements: [
      `CREATE TABLE IF NOT EXISTS operators (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        code TEXT NOT NULL UNIQUE,
        phone TEXT,
        email TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS routes (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        origin TEXT NOT NULL,
        destination TEXT NOT NULL,
        distance_km INTEGER,
        duration_minutes INTEGER,
        base_fare INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS vehicles (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        plate_number TEXT NOT NULL UNIQUE,
        vehicle_type TEXT NOT NULL,
        model TEXT,
        total_seats INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS trips (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        route_id TEXT NOT NULL REFERENCES routes(id),
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
        driver_id TEXT,
        departure_time INTEGER NOT NULL,
        estimated_arrival_time INTEGER,
        state TEXT NOT NULL DEFAULT 'scheduled',
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
      )`,
      `CREATE TABLE IF NOT EXISTS seats (
        id TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL REFERENCES trips(id),
        operator_id TEXT,
        seat_number TEXT NOT NULL,
        seat_class TEXT NOT NULL DEFAULT 'standard',
        status TEXT NOT NULL DEFAULT 'available',
        reserved_by TEXT,
        reservation_token TEXT,
        reservation_expires_at INTEGER,
        confirmed_by TEXT,
        confirmed_at INTEGER,
        version INTEGER NOT NULL DEFAULT 0,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS trip_state_transitions (
        id TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL REFERENCES trips(id),
        from_state TEXT NOT NULL,
        to_state TEXT NOT NULL,
        reason TEXT,
        transitioned_at INTEGER NOT NULL
      )`,
      `CREATE TABLE IF NOT EXISTS agents (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT,
        role TEXT NOT NULL DEFAULT 'agent',
        bus_parks TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS sales_transactions (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        trip_id TEXT NOT NULL REFERENCES trips(id),
        seat_ids TEXT NOT NULL,
        passenger_names TEXT NOT NULL,
        total_amount INTEGER NOT NULL,
        payment_method TEXT NOT NULL,
        payment_status TEXT NOT NULL DEFAULT 'pending',
        sync_status TEXT NOT NULL DEFAULT 'pending',
        receipt_id TEXT,
        created_at INTEGER NOT NULL,
        synced_at INTEGER,
        deleted_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        name TEXT,
        phone TEXT NOT NULL,
        email TEXT,
        ndpr_consent INTEGER NOT NULL DEFAULT 0,
        consent_given_at INTEGER,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS bookings (
        id TEXT PRIMARY KEY,
        customer_id TEXT NOT NULL REFERENCES customers(id),
        trip_id TEXT NOT NULL REFERENCES trips(id),
        seat_ids TEXT NOT NULL,
        passenger_names TEXT NOT NULL,
        total_amount INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        payment_status TEXT NOT NULL DEFAULT 'pending',
        payment_method TEXT NOT NULL,
        payment_reference TEXT,
        payment_provider TEXT,
        paid_at INTEGER,
        boarded_at INTEGER,
        boarded_by TEXT,
        created_at INTEGER NOT NULL,
        confirmed_at INTEGER,
        cancelled_at INTEGER,
        deleted_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS sync_mutations (
        id TEXT PRIMARY KEY,
        entity_type TEXT NOT NULL,
        entity_id TEXT NOT NULL,
        action TEXT NOT NULL,
        payload TEXT NOT NULL,
        version INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'PENDING',
        retry_count INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL,
        synced_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS drivers (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        license_number TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_drivers_operator ON drivers(operator_id)`,
      `CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status)`,
      `CREATE INDEX IF NOT EXISTS idx_trips_operator ON trips(operator_id)`,
      `CREATE INDEX IF NOT EXISTS idx_trips_state ON trips(state)`,
      `CREATE INDEX IF NOT EXISTS idx_trips_departure ON trips(departure_time)`,
      `CREATE INDEX IF NOT EXISTS idx_seats_trip ON seats(trip_id)`,
      `CREATE INDEX IF NOT EXISTS idx_seats_status ON seats(status)`,
      `CREATE INDEX IF NOT EXISTS idx_seats_reserved_expires ON seats(status, reservation_expires_at)`,
      `CREATE INDEX IF NOT EXISTS idx_bookings_customer ON bookings(customer_id)`,
      `CREATE INDEX IF NOT EXISTS idx_bookings_trip ON bookings(trip_id)`,
      `CREATE INDEX IF NOT EXISTS idx_bookings_status ON bookings(status)`,
      `CREATE INDEX IF NOT EXISTS idx_sales_agent ON sales_transactions(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sales_trip ON sales_transactions(trip_id)`,
      `CREATE INDEX IF NOT EXISTS idx_sales_sync ON sales_transactions(sync_status)`,
      `CREATE INDEX IF NOT EXISTS idx_sync_status ON sync_mutations(status)`,
    ],
  },
  {
    name: '002_platform_events',
    statements: [
      `CREATE TABLE IF NOT EXISTS platform_events (
        id            TEXT PRIMARY KEY,
        event_type    TEXT NOT NULL,
        aggregate_id  TEXT NOT NULL,
        aggregate_type TEXT NOT NULL,
        payload       TEXT NOT NULL,
        tenant_id     TEXT,
        correlation_id TEXT,
        status        TEXT NOT NULL DEFAULT 'pending',
        retry_count   INTEGER DEFAULT 0,
        processed_at  INTEGER,
        last_error    TEXT,
        created_at    INTEGER NOT NULL,
        dispatched_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_platform_events_status ON platform_events(status)`,
      `CREATE INDEX IF NOT EXISTS idx_platform_events_event_type ON platform_events(event_type)`,
      `CREATE INDEX IF NOT EXISTS idx_platform_events_aggregate ON platform_events(aggregate_type, aggregate_id)`,
      `CREATE INDEX IF NOT EXISTS idx_platform_events_pending ON platform_events(status, retry_count, created_at)`,
    ],
  },
  {
    // 003 and 004 are additive columns — included in 001's CREATE TABLE above
    // These no-op entries ensure schema_migrations records are consistent
    name: '003_vehicles_model_column',
    statements: [
      // model TEXT is already included in vehicles CREATE TABLE in 001 above
      // This entry is a no-op marker for migration tracking consistency
      `SELECT 1`,
    ],
  },
  {
    name: '004_event_bus_and_seats_hardening',
    statements: [
      // All 004 columns are included in 001+002 CREATE TABLE statements above
      // This entry is a no-op marker for migration tracking consistency
      `SELECT 1`,
    ],
  },
  {
    name: '005_drivers_and_schema_hardening',
    statements: [
      `CREATE TABLE IF NOT EXISTS drivers (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        license_number TEXT,
        status TEXT NOT NULL DEFAULT 'active',
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_drivers_operator ON drivers(operator_id)`,
      `CREATE INDEX IF NOT EXISTS idx_drivers_status ON drivers(status)`,
      `ALTER TABLE sales_transactions ADD COLUMN deleted_at INTEGER`,
      `ALTER TABLE bookings ADD COLUMN payment_provider TEXT`,
      `ALTER TABLE bookings ADD COLUMN paid_at INTEGER`,
    ],
  },
  {
    name: '006_performance_indexes',
    statements: [
      `CREATE INDEX IF NOT EXISTS idx_routes_operator_id ON routes(operator_id)`,
      `CREATE INDEX IF NOT EXISTS idx_vehicles_operator_id ON vehicles(operator_id)`,
      `CREATE INDEX IF NOT EXISTS idx_seats_operator_trip ON seats(operator_id, trip_id)`,
      `CREATE INDEX IF NOT EXISTS idx_bookings_payment_ref ON bookings(payment_reference)`,
      `CREATE INDEX IF NOT EXISTS idx_bookings_customer_id ON bookings(customer_id)`,
      `CREATE INDEX IF NOT EXISTS idx_bookings_trip_id ON bookings(trip_id)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_agent_id ON sales_transactions(agent_id)`,
      `CREATE INDEX IF NOT EXISTS idx_transactions_trip_id ON sales_transactions(trip_id)`,
      `CREATE INDEX IF NOT EXISTS idx_platform_events_status ON platform_events(status, created_at)`,
      `CREATE INDEX IF NOT EXISTS idx_trips_operator_departure ON trips(operator_id, departure_time)`,
    ],
  },
  {
    name: '007_push_subscriptions',
    statements: [
      `CREATE TABLE IF NOT EXISTS push_subscriptions (
        id TEXT PRIMARY KEY,
        customer_id TEXT,
        operator_id TEXT,
        endpoint TEXT NOT NULL UNIQUE,
        subscription_json TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_customer ON push_subscriptions(customer_id)`,
      `CREATE INDEX IF NOT EXISTS idx_push_subscriptions_operator ON push_subscriptions(operator_id)`,
    ],
  },
  {
    name: '008_customer_last_active',
    statements: [
      `ALTER TABLE customers ADD COLUMN last_active_at INTEGER`,
    ],
  },
  {
    name: '009_booking_boarding_cols',
    statements: [
      `ALTER TABLE bookings ADD COLUMN boarded_at INTEGER`,
      `ALTER TABLE bookings ADD COLUMN boarded_by TEXT`,
    ],
  },
  {
    name: '010_phase2_tables',
    statements: [
      `CREATE TABLE IF NOT EXISTS api_keys (
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
      )`,
      `CREATE INDEX IF NOT EXISTS idx_api_keys_operator ON api_keys(operator_id)`,
      `CREATE INDEX IF NOT EXISTS idx_api_keys_hash ON api_keys(key_hash)`,
      `CREATE TABLE IF NOT EXISTS ndpr_consent_log (
        id TEXT PRIMARY KEY,
        entity_id TEXT NOT NULL,
        entity_type TEXT NOT NULL,
        consented_at INTEGER NOT NULL,
        ip_address TEXT,
        user_agent TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_ndpr_entity ON ndpr_consent_log(entity_id, entity_type)`,
      `CREATE TABLE IF NOT EXISTS bus_parks (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        name TEXT NOT NULL,
        city TEXT NOT NULL,
        state TEXT NOT NULL,
        latitude REAL,
        longitude REAL,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS agent_bus_parks (
        agent_id TEXT NOT NULL REFERENCES agents(id),
        park_id TEXT NOT NULL REFERENCES bus_parks(id),
        PRIMARY KEY (agent_id, park_id)
      )`,
      `CREATE TABLE IF NOT EXISTS float_reconciliation (
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
      )`,
      `CREATE INDEX IF NOT EXISTS idx_reconciliation_agent_date ON float_reconciliation(agent_id, period_date)`,
      `CREATE TABLE IF NOT EXISTS trip_inspections (
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
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_inspection_trip ON trip_inspections(trip_id)`,
      `CREATE TABLE IF NOT EXISTS seat_history (
        id TEXT PRIMARY KEY,
        seat_id TEXT NOT NULL,
        trip_id TEXT NOT NULL,
        from_status TEXT,
        to_status TEXT NOT NULL,
        actor_id TEXT,
        reason TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_seat_history_seat ON seat_history(seat_id)`,
      `CREATE TABLE IF NOT EXISTS vehicle_maintenance_records (
        id TEXT PRIMARY KEY,
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
        operator_id TEXT NOT NULL,
        service_type TEXT NOT NULL,
        service_date INTEGER NOT NULL,
        next_service_due INTEGER,
        notes TEXT,
        created_by TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_maintenance_vehicle ON vehicle_maintenance_records(vehicle_id)`,
      `CREATE TABLE IF NOT EXISTS vehicle_documents (
        id TEXT PRIMARY KEY,
        vehicle_id TEXT NOT NULL REFERENCES vehicles(id),
        operator_id TEXT NOT NULL,
        doc_type TEXT NOT NULL,
        doc_number TEXT,
        issued_at INTEGER,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_vehicle_docs ON vehicle_documents(vehicle_id, doc_type)`,
      `CREATE TABLE IF NOT EXISTS driver_documents (
        id TEXT PRIMARY KEY,
        driver_id TEXT NOT NULL REFERENCES drivers(id),
        operator_id TEXT NOT NULL,
        doc_type TEXT NOT NULL,
        doc_number TEXT,
        license_category TEXT,
        issued_at INTEGER,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_driver_docs ON driver_documents(driver_id, doc_type)`,
      `CREATE TABLE IF NOT EXISTS waiting_list (
        id TEXT PRIMARY KEY,
        trip_id TEXT NOT NULL REFERENCES trips(id),
        customer_id TEXT NOT NULL REFERENCES customers(id),
        seat_class TEXT NOT NULL DEFAULT 'standard',
        position INTEGER NOT NULL,
        notified_at INTEGER,
        expires_at INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE INDEX IF NOT EXISTS idx_waiting_list_trip ON waiting_list(trip_id, position)`,
      `CREATE TABLE IF NOT EXISTS operator_reviews (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        booking_id TEXT NOT NULL REFERENCES bookings(id),
        customer_id TEXT NOT NULL REFERENCES customers(id),
        rating INTEGER NOT NULL CHECK(rating BETWEEN 1 AND 5),
        review_text TEXT,
        created_at INTEGER NOT NULL,
        deleted_at INTEGER
      )`,
      `CREATE UNIQUE INDEX IF NOT EXISTS idx_reviews_booking ON operator_reviews(booking_id)`,
      `CREATE TABLE IF NOT EXISTS schedules (
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
      )`,
      `CREATE TABLE IF NOT EXISTS agent_broadcasts (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL REFERENCES operators(id),
        sent_by TEXT NOT NULL,
        message TEXT NOT NULL,
        priority TEXT NOT NULL DEFAULT 'normal',
        created_at INTEGER NOT NULL,
        expires_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS dispute_tickets (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL,
        agent_id TEXT NOT NULL REFERENCES agents(id),
        category TEXT NOT NULL,
        description TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'open',
        resolved_by TEXT,
        resolved_at INTEGER,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_tickets_agent ON dispute_tickets(agent_id)`,
      `CREATE TABLE IF NOT EXISTS route_stops (
        id TEXT PRIMARY KEY,
        route_id TEXT NOT NULL REFERENCES routes(id),
        stop_name TEXT NOT NULL,
        sequence INTEGER NOT NULL,
        distance_from_origin_km REAL,
        fare_from_origin_kobo INTEGER,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_route_stops ON route_stops(route_id, sequence)`,
      `ALTER TABLE trips ADD COLUMN inspection_completed_at INTEGER`,
      `ALTER TABLE trips ADD COLUMN park_id TEXT`,
      `ALTER TABLE bookings ADD COLUMN origin_stop_id TEXT`,
      `ALTER TABLE bookings ADD COLUMN destination_stop_id TEXT`,
      `ALTER TABLE bookings ADD COLUMN insurance_selected INTEGER DEFAULT 0`,
      `ALTER TABLE bookings ADD COLUMN insurance_premium_kobo INTEGER DEFAULT 0`,
      `ALTER TABLE agents ADD COLUMN commission_rate REAL DEFAULT 0.05`,
      `ALTER TABLE vehicles ADD COLUMN seat_template TEXT`,
      `ALTER TABLE routes ADD COLUMN route_stops_enabled INTEGER DEFAULT 0`,
      `ALTER TABLE routes ADD COLUMN cancellation_policy TEXT`,
      `ALTER TABLE routes ADD COLUMN fare_matrix TEXT`,
    ],
  },
  {
    name: '011_guest_bookings',
    statements: [
      `ALTER TABLE bookings ADD COLUMN is_guest INTEGER DEFAULT 0`,
    ],
  },
  {
    name: '012_p05_trip_ops',
    statements: [
      // P05-T1: GPS location timestamp
      `ALTER TABLE trips ADD COLUMN location_updated_at INTEGER`,
      // P05-T2: SOS triggered_by (cleared_by already exists)
      `ALTER TABLE trips ADD COLUMN sos_triggered_by TEXT`,
      // P05-T6: Delay reporting columns
      `ALTER TABLE trips ADD COLUMN delay_reason_code TEXT`,
      `ALTER TABLE trips ADD COLUMN delay_reported_at INTEGER`,
      `ALTER TABLE trips ADD COLUMN estimated_departure_ms INTEGER`,
    ],
  },
  {
    name: '013_p07_agent_ops',
    statements: [
      // P07-T5: Passenger ID capture (hashed, never raw)
      `ALTER TABLE sales_transactions ADD COLUMN passenger_id_type TEXT`,
      `ALTER TABLE sales_transactions ADD COLUMN passenger_id_hash TEXT`,
      // P07-T2: QR code string embedded in receipt for thermal printing
      `ALTER TABLE receipts ADD COLUMN qr_code TEXT`,
      // P07-T4: Bus park the transaction was recorded at (optional)
      `ALTER TABLE sales_transactions ADD COLUMN park_id TEXT`,
      // P07-T4: Departure park for a trip (optional — lets trips be filtered by park)
      `ALTER TABLE trips ADD COLUMN departure_park_id TEXT`,
    ],
  },
  {
    name: '014_p08_revenue',
    statements: [
      // P08-T3: Cancellation refund tracking on bookings
      `ALTER TABLE bookings ADD COLUMN refund_reference TEXT`,
      `ALTER TABLE bookings ADD COLUMN refund_amount_kobo INTEGER`,
      `ALTER TABLE bookings ADD COLUMN manual_refund_required INTEGER DEFAULT 0`,
      // P08-T5: Link bookings to group booking records
      `ALTER TABLE bookings ADD COLUMN group_booking_id TEXT`,
      // P08-T5: Group bookings table
      `CREATE TABLE IF NOT EXISTS group_bookings (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        trip_id TEXT NOT NULL REFERENCES trips(id),
        booking_id TEXT NOT NULL REFERENCES bookings(id),
        group_name TEXT NOT NULL,
        leader_name TEXT NOT NULL,
        leader_phone TEXT NOT NULL,
        seat_count INTEGER NOT NULL,
        seat_class TEXT NOT NULL DEFAULT 'standard',
        total_amount_kobo INTEGER NOT NULL,
        payment_method TEXT NOT NULL,
        receipt_id TEXT,
        created_at INTEGER NOT NULL
      )`,
      `CREATE INDEX IF NOT EXISTS idx_group_bookings_trip ON group_bookings(trip_id)`,
      `CREATE INDEX IF NOT EXISTS idx_group_bookings_agent ON group_bookings(agent_id)`,
    ],
  },
  {
    name: '015_p09_compliance',
    statements: [
      // P09-T3: Notification read-receipts (composite PK prevents duplicate reads)
      `CREATE TABLE IF NOT EXISTS notification_reads (
        event_id TEXT NOT NULL,
        user_id  TEXT NOT NULL,
        read_at  INTEGER NOT NULL,
        PRIMARY KEY (event_id, user_id)
      )`,
    ],
  },
  {
    name: '016_p10_booking_reminders',
    statements: [
      `ALTER TABLE bookings ADD COLUMN reminder_24h_sent_at INTEGER`,
      `ALTER TABLE bookings ADD COLUMN reminder_2h_sent_at INTEGER`,
    ],
  },
  {
    name: '017_trn02_manifest_next_of_kin',
    statements: [
      // T-TRN-02: Next-of-kin capture for FRSC digital manifest compliance
      `ALTER TABLE bookings ADD COLUMN next_of_kin_name TEXT`,
      `ALTER TABLE bookings ADD COLUMN next_of_kin_phone TEXT`,
      `ALTER TABLE sales_transactions ADD COLUMN next_of_kin_name TEXT`,
      `ALTER TABLE sales_transactions ADD COLUMN next_of_kin_phone TEXT`,
    ],
  },
];

export const adminRouter = new Hono<{ Bindings: AdminEnv }>();

// ============================================================
// POST /api/admin/migrations/run
// Applies all pending migrations in order. Idempotent.
// Requires: Authorization: Bearer <MIGRATION_SECRET> header
// ============================================================
adminRouter.post('/migrations/run', async (c) => {
  const secret = c.env.MIGRATION_SECRET;
  if (!secret) {
    return c.json({ success: false, error: 'MIGRATION_SECRET not configured' }, 503);
  }

  const authHeader = c.req.header('Authorization') ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (provided !== secret) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const db = c.env.DB;

  // Ensure the schema_migrations tracking table exists
  await db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `).run();

  const applied: string[] = [];
  const skipped: string[] = [];
  const errors: { name: string; error: string }[] = [];

  for (const migration of MIGRATIONS) {
    // Check if already applied
    const existing = await db.prepare(
      `SELECT name FROM schema_migrations WHERE name = ?`
    ).bind(migration.name).first<{ name: string }>();

    if (existing) {
      skipped.push(migration.name);
      continue;
    }

    // Run each statement individually (D1 does not support multi-statement prepare)
    let migrationFailed = false;
    for (const sql of migration.statements) {
      try {
        await db.prepare(sql).run();
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        // ALTER TABLE ADD COLUMN errors are non-fatal if the column already exists
        if (msg.includes('duplicate column name') || msg.includes('already exists')) {
          continue;
        }
        errors.push({ name: migration.name, error: msg });
        migrationFailed = true;
        break;
      }
    }

    if (!migrationFailed) {
      // Record migration as applied
      await db.prepare(
        `INSERT OR IGNORE INTO schema_migrations (name, applied_at) VALUES (?, ?)`
      ).bind(migration.name, Date.now()).run();
      applied.push(migration.name);
    }
  }

  const success = errors.length === 0;
  return c.json({
    success,
    applied,
    skipped,
    errors,
    total: MIGRATIONS.length,
    message: success
      ? `Migrations complete: ${applied.length} applied, ${skipped.length} skipped`
      : `Migrations failed: ${errors.length} error(s)`,
  }, success ? 200 : 500);
});

// ============================================================
// GET /api/admin/migrations/status
// Lists applied migrations. Requires same MIGRATION_SECRET.
// ============================================================
adminRouter.get('/migrations/status', async (c) => {
  const secret = c.env.MIGRATION_SECRET;
  if (!secret) {
    return c.json({ success: false, error: 'MIGRATION_SECRET not configured' }, 503);
  }
  const authHeader = c.req.header('Authorization') ?? '';
  const provided = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : '';
  if (provided !== secret) {
    return c.json({ success: false, error: 'Unauthorized' }, 401);
  }

  const db = c.env.DB;

  await db.prepare(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY,
      applied_at INTEGER NOT NULL
    )
  `).run();

  const { results } = await db.prepare(
    `SELECT name, applied_at FROM schema_migrations ORDER BY applied_at ASC`
  ).all<{ name: string; applied_at: number }>();

  const appliedNames = new Set(results.map(r => r.name));
  const pending = MIGRATIONS.filter(m => !appliedNames.has(m.name)).map(m => m.name);

  return c.json({
    success: true,
    applied: results,
    pending,
    total: MIGRATIONS.length,
  });
});
