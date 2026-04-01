-- Migration 004: Event Bus hardening + Seat Inventory versioning (idempotent)
-- These columns were already added in migration 001 schema.
-- This migration is now a no-op to prevent duplicate column errors on re-run.
-- NO-OP: all columns already exist from migration 001
SELECT 1;
