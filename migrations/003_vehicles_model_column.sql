-- Migration 003: Add model column to vehicles table
-- Additive migration for environments where 001 has already been applied
ALTER TABLE vehicles ADD COLUMN model TEXT;
