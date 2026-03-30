-- WebWaka Transport Suite — Platform Event Bus Outbox
-- Event-Driven invariant: all cross-module events stored durably in D1
-- A Cloudflare Worker Cron / Queues consumer drains and forwards these events
-- ============================================================
CREATE TABLE IF NOT EXISTS platform_events (
  id            TEXT PRIMARY KEY,
  event_type    TEXT NOT NULL,          -- e.g. 'booking.created'
  aggregate_id  TEXT NOT NULL,          -- e.g. booking id
  aggregate_type TEXT NOT NULL,         -- e.g. 'booking'
  payload       TEXT NOT NULL,          -- JSON blob
  tenant_id     TEXT,
  correlation_id TEXT,
  status        TEXT NOT NULL DEFAULT 'pending', -- pending | dispatched | failed
  created_at    INTEGER NOT NULL,
  dispatched_at INTEGER
);

CREATE INDEX IF NOT EXISTS idx_platform_events_status ON platform_events(status);
CREATE INDEX IF NOT EXISTS idx_platform_events_event_type ON platform_events(event_type);
CREATE INDEX IF NOT EXISTS idx_platform_events_aggregate ON platform_events(aggregate_type, aggregate_id);
