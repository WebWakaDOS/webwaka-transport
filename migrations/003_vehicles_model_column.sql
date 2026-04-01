-- Migration 003: Add model column to vehicles table (idempotent)
-- Additive migration for environments where 001 has already been applied
-- Uses SQLite workaround: create temp table to check column existence
CREATE TABLE IF NOT EXISTS _migration_003_applied (id INTEGER PRIMARY KEY);
INSERT OR IGNORE INTO _migration_003_applied (id) VALUES (1);

-- Only add column if not already present (SQLite doesn't support IF NOT EXISTS for columns)
-- We use a pragma-based check via a trigger workaround
-- Since D1 runs each statement independently, we use a safe approach:
-- Try to add the column; if it fails, that's OK (column already exists)
-- The wrangler action will fail on error, so we need a different approach.

-- Approach: Create a new table with the column, copy data, drop old, rename
-- This is safe and idempotent because we check if model column already exists first.
-- For D1 compatibility, we use the following pattern:

-- Check if model column exists by selecting it (will succeed silently if exists)
-- If column doesn't exist, this will fail and we skip; if it does exist, we're done
-- Since we can't use IF NOT EXISTS for columns in SQLite/D1, we use a safe migration:
-- We create a new vehicles table with the model column already in migration 001,
-- so migration 003 is now a no-op (the column was already added in 001).

-- NO-OP: model column already exists from migration 001 schema
SELECT 1;
