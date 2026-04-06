-- Migration 010: Offline ticket_number support
-- Stores the client-generated ticket number when an offline ticket is synced
-- to the server via POST /api/agent-sales/transactions.
-- This allows boarding-scan endpoints to match against the locally-issued
-- ticket_number without requiring a separate lookup table.
--
-- Note: trns_sync_mutations.entity_type now also accepts 'ticket' (no CHECK
-- constraint is enforced by SQLite, but API callers must pass one of:
--   trip | seat | booking | transaction | ticket)

ALTER TABLE trns_sales_transactions ADD COLUMN ticket_number TEXT;
ALTER TABLE trns_receipts ADD COLUMN ticket_number TEXT;

CREATE INDEX IF NOT EXISTS idx_sales_transactions_ticket_number
  ON trns_sales_transactions(ticket_number)
  WHERE ticket_number IS NOT NULL;
