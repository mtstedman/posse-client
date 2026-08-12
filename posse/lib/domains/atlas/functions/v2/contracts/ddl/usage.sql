-- Dedicated, best-effort native ATLAS usage telemetry store.

CREATE TABLE IF NOT EXISTS usage_meta (
  key             TEXT PRIMARY KEY,
  value           TEXT NOT NULL
);

INSERT OR IGNORE INTO usage_meta(key, value) VALUES('schema_version', '1');

CREATE TABLE IF NOT EXISTS usage_events (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,
  repo_id         TEXT,
  action          TEXT NOT NULL,
  ok              INTEGER NOT NULL,
  duration_ms     INTEGER NOT NULL DEFAULT 0,
  result_bytes    INTEGER NOT NULL DEFAULT 0,
  version_id      TEXT,
  task_type       TEXT,
  error_code      TEXT
);

CREATE INDEX IF NOT EXISTS idx_usage_events_repo_ts
  ON usage_events(repo_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_usage_events_action_ts
  ON usage_events(action, ts DESC);
