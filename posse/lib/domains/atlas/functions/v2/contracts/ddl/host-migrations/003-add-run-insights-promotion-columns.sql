-- ATLAS v2 host migration 003
--
-- Adds promotion bookkeeping columns used by the Kaizen-to-ATLAS memory path,
-- plus partial indexes for the promoted-memory lookup. Existing runtime
-- startup also applies this repair through db/migrations.js so installs are
-- protected even when they do not execute HOST_MIGRATIONS directly.
--
-- SQLite does not support ALTER TABLE ... ADD COLUMN IF NOT EXISTS. Apply this
-- SQL only when the listed columns are absent; the JS repair path performs the
-- idempotent PRAGMA table_info guard.

BEGIN TRANSACTION;

ALTER TABLE run_insights ADD COLUMN memory_type TEXT;
ALTER TABLE run_insights ADD COLUMN promotion_status TEXT;
ALTER TABLE run_insights ADD COLUMN promotion_reason TEXT;
ALTER TABLE run_insights ADD COLUMN promoted_memory_id TEXT;
ALTER TABLE run_insights ADD COLUMN rejection_reason TEXT;

CREATE INDEX IF NOT EXISTS idx_run_insights_promotion_status
  ON run_insights(promotion_status)
  WHERE promotion_status IN ('promoted', 'duplicate');

CREATE INDEX IF NOT EXISTS idx_run_insights_promoted_memory_id
  ON run_insights(promoted_memory_id)
  WHERE promoted_memory_id IS NOT NULL AND trim(promoted_memory_id) != '';

COMMIT;
