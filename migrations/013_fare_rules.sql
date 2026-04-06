-- Migration 013: fare_rules table — Dynamic Pricing Engine (WWT-005)
-- Supports rule types: surge_period, peak_hours, peak_days, weekend, always
-- Multi-tenant: scoped by operator_id + route_id
-- Managed via admin.ts MIGRATIONS array

CREATE TABLE IF NOT EXISTS fare_rules (
  id TEXT PRIMARY KEY,
  operator_id TEXT NOT NULL,
  route_id TEXT NOT NULL,
  name TEXT NOT NULL,
  rule_type TEXT NOT NULL CHECK(rule_type IN ('surge_period','peak_hours','peak_days','weekend','always')),
  starts_at INTEGER,
  ends_at INTEGER,
  days_of_week TEXT,           -- JSON array: e.g. [5,6]
  hour_from INTEGER,           -- 0–23 UTC (inclusive)
  hour_to INTEGER,             -- 0–23 UTC (exclusive)
  class_multipliers TEXT,      -- JSON: Record<string,number> e.g. {"vip":1.5}
  base_multiplier REAL NOT NULL DEFAULT 1.0,
  priority INTEGER NOT NULL DEFAULT 0,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  deleted_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_fare_rules_route ON fare_rules(route_id, operator_id, is_active);
CREATE INDEX IF NOT EXISTS idx_fare_rules_operator ON fare_rules(operator_id);
