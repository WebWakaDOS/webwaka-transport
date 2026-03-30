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
        synced_at INTEGER
      )`,
      `CREATE TABLE IF NOT EXISTS customers (
        id TEXT PRIMARY KEY,
        operator_id TEXT NOT NULL,
        name TEXT NOT NULL,
        phone TEXT NOT NULL,
        email TEXT,
        ndpr_consent INTEGER NOT NULL DEFAULT 0,
        consent_given_at INTEGER,
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
