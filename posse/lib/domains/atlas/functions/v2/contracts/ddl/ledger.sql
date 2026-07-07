-- ATLAS v2 ledger schema.
--
-- One file per repo: <repo>/.posse/atlas/ledger.db
--
-- This is the single source of truth for ATLAS v2. Worktree views are
-- materialized projections built by replaying ledger ranges; they may be
-- deleted and rebuilt at any time. The ledger is append-only at the
-- application layer (we do not enforce this with triggers — those add
-- per-row overhead and we control all writers).
--
-- Concurrency model:
--   * SQLite in WAL mode.
--   * One writer at a time globally (better-sqlite3 serializes).
--   * Multiple readers concurrent with the writer (WAL).
--   * Worktree workers append only to their own branch partition. Writes
--     to different branches are non-conflicting at the semantic level, and
--     SQLite serializes them at the file level. This is fine because
--     ledger appends are short and rare relative to view reads.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- Schema versioning + free-form metadata.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- -----------------------------------------------------------------------------
-- String interning. Symbol names, qualified names, kinds, edge kinds, and
-- languages repeat heavily across a codebase. Interning keeps blob_symbols
-- and blob_edges narrow.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS interned_paths (
  id   INTEGER PRIMARY KEY AUTOINCREMENT,
  path TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS interned_strings (
  id    INTEGER PRIMARY KEY AUTOINCREMENT,
  value TEXT NOT NULL UNIQUE
);

-- -----------------------------------------------------------------------------
-- Content-addressable blob registry. Once a file's bytes have been parsed
-- under a given content_hash, the parsed rows below are immutable. Any
-- worktree that sees the same content_hash gets the same symbols + edges
-- for free.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS blobs (
  content_hash  TEXT PRIMARY KEY,           -- SHA-256 hex of the file bytes
  lang          TEXT NOT NULL,              -- "ts", "py", etc.
  byte_size     INTEGER NOT NULL,
  first_seen_ts TEXT NOT NULL,              -- ISO-8601
  parser_version TEXT,
  parser_spec_version TEXT
);

-- Fast boot freshness prefilter. The ledger's content_hash remains the source
-- of truth; these per-path file stats let boot skip hashing when the source
-- file's size + mtime match the last observed state for that branch/path.
CREATE TABLE IF NOT EXISTS path_source_stats (
  branch          TEXT NOT NULL,
  path_id         INTEGER NOT NULL,
  content_hash    TEXT NOT NULL,
  size_bytes      INTEGER NOT NULL,
  mtime_epoch_ms  INTEGER NOT NULL,
  indexed_at_epoch_ms INTEGER NOT NULL,
  PRIMARY KEY (branch, path_id),
  FOREIGN KEY (branch) REFERENCES branches(name),
  FOREIGN KEY (path_id) REFERENCES interned_paths(id),
  FOREIGN KEY (content_hash) REFERENCES blobs(content_hash)
);

CREATE INDEX IF NOT EXISTS idx_path_source_stats_hash
  ON path_source_stats(content_hash);

CREATE TABLE IF NOT EXISTS blob_symbols (
  content_hash      TEXT NOT NULL,
  local_id          INTEGER NOT NULL,
  kind_id           INTEGER NOT NULL,       -- interned_strings.id
  name_id           INTEGER NOT NULL,       -- interned_strings.id
  qualified_name_id INTEGER,                -- interned_strings.id, nullable
  parent_local_id   INTEGER,                -- nullable
  range_start       INTEGER NOT NULL,
  range_end         INTEGER NOT NULL,
  range_start_line  INTEGER,                -- 1-based; nullable for legacy rows pre-line-anchors
  range_end_line    INTEGER,                -- 1-based; nullable for legacy rows pre-line-anchors
  signature_hash    TEXT NOT NULL,
  signature_text    TEXT,                   -- raw signature, nullable for legacy rows pre-signature-text
  body_identifiers  TEXT,                   -- deduped identifier-token bag for symbol-body FTS
  visibility        TEXT,                   -- nullable; not interned (cardinality is tiny)
  doc               TEXT,                   -- nullable; may be long
  source            TEXT NOT NULL DEFAULT 'treesitter'
                      CHECK (source IN ('treesitter','scip')),
  PRIMARY KEY (content_hash, local_id),
  FOREIGN KEY (content_hash)      REFERENCES blobs(content_hash),
  FOREIGN KEY (kind_id)           REFERENCES interned_strings(id),
  FOREIGN KEY (name_id)           REFERENCES interned_strings(id),
  FOREIGN KEY (qualified_name_id) REFERENCES interned_strings(id)
);

CREATE INDEX IF NOT EXISTS idx_blob_symbols_name
  ON blob_symbols(name_id);

CREATE INDEX IF NOT EXISTS idx_blob_symbols_qualified
  ON blob_symbols(qualified_name_id)
  WHERE qualified_name_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- External symbols. One row per unique SCIP moniker reachable from this repo.
-- Identity is `(scheme, manager, package_name, package_version, descriptor)`;
-- nullable fields use the sentinel `''` (NOT NULL DEFAULT '') because SQLite
-- treats NULLs as always distinct in UNIQUE constraints.
--
-- Populated lazily by the SCIP ingester. Referenced by `blob_edges.to_external_id`
-- when a parsed edge targets a symbol defined outside this repo (e.g. a call to
-- `node:fs/promises#readFile`).
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS external_symbols (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme          TEXT NOT NULL,                  -- "scip-typescript" | "scip-java" | ...
  manager         TEXT NOT NULL DEFAULT '',       -- "npm" | "maven" | "gomod" | "" for stdlib
  package_name    TEXT NOT NULL,                  -- e.g. "@types/node"
  package_version TEXT NOT NULL DEFAULT '',       -- "" when unknown
  descriptor      TEXT NOT NULL,                  -- raw SCIP descriptor path
  display_name_id INTEGER,                        -- interned_strings.id; nullable
  UNIQUE (scheme, manager, package_name, package_version, descriptor),
  FOREIGN KEY (display_name_id) REFERENCES interned_strings(id)
);

CREATE INDEX IF NOT EXISTS idx_external_symbols_package
  ON external_symbols(package_name);

CREATE TABLE IF NOT EXISTS blob_edges (
  from_content_hash TEXT NOT NULL,
  edge_id           INTEGER NOT NULL,
  from_local_id     INTEGER NOT NULL,
  to_content_hash   TEXT,                   -- nullable (unresolved or external)
  to_local_id       INTEGER,                -- nullable (unresolved or external)
  to_external_id    INTEGER,                -- external_symbols.id; nullable.
                                            --   Set when the edge target lives outside this repo
                                            --   (SCIP-bound external moniker). Mutually exclusive
                                            --   with (to_content_hash, to_local_id).
  to_name_id        INTEGER NOT NULL,       -- always known; resolver may fail to bind to a concrete symbol
  to_module_id      INTEGER,                -- interned_strings.id; nullable. For import edges:
                                            --   the source module string verbatim ("./bar.js", "std::fmt").
                                            --   The resolver joins this against the source blob's path to
                                            --   bind to a concrete target. NULL for non-imports.
  kind_id           INTEGER NOT NULL,
  range_start       INTEGER NOT NULL,
  range_end         INTEGER NOT NULL,
  range_start_line  INTEGER,                -- 1-based; nullable for legacy rows pre-line-anchors
  range_end_line    INTEGER,                -- 1-based; nullable for legacy rows pre-line-anchors
  confidence        INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  source            TEXT NOT NULL DEFAULT 'treesitter'
                      CHECK (source IN ('treesitter','scip')),
  PRIMARY KEY (from_content_hash, edge_id),
  -- At most one target type. Both NULL = unresolved.
  CHECK (to_content_hash IS NULL OR to_external_id IS NULL),
  FOREIGN KEY (from_content_hash, from_local_id)
    REFERENCES blob_symbols(content_hash, local_id),
  FOREIGN KEY (kind_id)        REFERENCES interned_strings(id),
  FOREIGN KEY (to_name_id)     REFERENCES interned_strings(id),
  FOREIGN KEY (to_module_id)   REFERENCES interned_strings(id),
  FOREIGN KEY (to_external_id) REFERENCES external_symbols(id)
);

-- For "find callers of X" cross-blob lookups when the resolver bound a target.
CREATE INDEX IF NOT EXISTS idx_blob_edges_to_resolved
  ON blob_edges(to_content_hash, to_local_id)
  WHERE to_content_hash IS NOT NULL;

-- For unresolved-edge resolution passes (rebind by name when a new blob arrives).
-- Excludes SCIP-bound external edges so they are not re-resolved by the heuristic
-- name-based pass.
CREATE INDEX IF NOT EXISTS idx_blob_edges_to_name_unresolved
  ON blob_edges(to_name_id)
  WHERE to_content_hash IS NULL AND to_external_id IS NULL;

-- For "callers of this external moniker" cross-repo-style queries.
CREATE INDEX IF NOT EXISTS idx_blob_edges_to_external
  ON blob_edges(to_external_id)
  WHERE to_external_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Layered parse storage. Tree-sitter and SCIP are recorded independently here,
-- then merged into retrieval-facing views. The legacy blob_symbols/blob_edges
-- tables above remain as a compatibility projection while callers migrate.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS blob_layers (
  id                  INTEGER PRIMARY KEY,
  content_hash         TEXT NOT NULL,
  lang                 TEXT NOT NULL,
  source               TEXT NOT NULL CHECK (source IN ('treesitter','scip')),
  tool_version         TEXT NOT NULL,
  parser_spec_version  TEXT NOT NULL,
  config_hash          TEXT NOT NULL DEFAULT '',
  deps_hash            TEXT NOT NULL DEFAULT '',
  fileset_hash         TEXT NOT NULL DEFAULT '',
  indexed_at           TEXT NOT NULL,
  status               TEXT NOT NULL DEFAULT 'indexed'
                         CHECK (status IN ('indexed','failed','stale')),
  metadata_json        TEXT,
  UNIQUE (
    content_hash, source, tool_version, parser_spec_version,
    config_hash, deps_hash, fileset_hash
  ),
  FOREIGN KEY (content_hash) REFERENCES blobs(content_hash)
);

CREATE TABLE IF NOT EXISTS blob_layer_symbols (
  layer_id    INTEGER NOT NULL,
  local_id    INTEGER NOT NULL,
  lang        TEXT NOT NULL,
  kind        TEXT NOT NULL,
  name        TEXT NOT NULL,
  signature   TEXT,
  container   TEXT,
  range_json  TEXT,
  doc         TEXT,
  detail_json TEXT,
  PRIMARY KEY (layer_id, local_id),
  FOREIGN KEY (layer_id) REFERENCES blob_layers(id) ON DELETE CASCADE
);

CREATE TABLE IF NOT EXISTS blob_layer_edges (
  layer_id       INTEGER NOT NULL,
  edge_id        INTEGER NOT NULL,
  kind           TEXT NOT NULL,
  from_local_id  INTEGER,
  to_local_id    INTEGER,
  to_symbol      TEXT,
  range_json     TEXT,
  detail_json    TEXT,
  PRIMARY KEY (layer_id, edge_id),
  FOREIGN KEY (layer_id) REFERENCES blob_layers(id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS blob_layers_lookup
  ON blob_layers (content_hash, source, lang, status);

CREATE INDEX IF NOT EXISTS idx_blob_layers_merge_read
  ON blob_layers(content_hash, lang, status, indexed_at DESC, id DESC);

-- -----------------------------------------------------------------------------
-- Branch lineage. main is the root; every other branch is forked at a
-- specific parent seq. Forks are free — they just record lineage.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS branches (
  name          TEXT PRIMARY KEY,
  parent_branch TEXT,                       -- null for "main"
  parent_seq    INTEGER,                    -- null for "main"
  created_at    TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'active'
    CHECK (status IN ('active', 'merged', 'abandoned')),
  FOREIGN KEY (parent_branch) REFERENCES branches(name)
);

-- -----------------------------------------------------------------------------
-- The ledger itself. One row per file-level change on a branch.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS symbol_deltas (
  seq                  INTEGER NOT NULL,    -- monotonic per branch
  branch               TEXT NOT NULL,
  ts                   TEXT NOT NULL,
  op                   TEXT NOT NULL CHECK (op IN ('add', 'remove', 'modify')),
  path_id              INTEGER NOT NULL,    -- interned_paths.id
  before_content_hash  TEXT,                -- null when op='add'
  after_content_hash   TEXT,                -- null when op='remove'
  parent_seq           INTEGER,             -- previous seq on this branch that touched the same path
  PRIMARY KEY (branch, seq),
  FOREIGN KEY (branch)              REFERENCES branches(name),
  FOREIGN KEY (path_id)             REFERENCES interned_paths(id),
  FOREIGN KEY (before_content_hash) REFERENCES blobs(content_hash),
  FOREIGN KEY (after_content_hash)  REFERENCES blobs(content_hash),
  CHECK (
    (op = 'add'    AND before_content_hash IS NULL AND after_content_hash IS NOT NULL)
    OR (op = 'remove' AND before_content_hash IS NOT NULL AND after_content_hash IS NULL)
    OR (op = 'modify' AND before_content_hash IS NOT NULL AND after_content_hash IS NOT NULL)
  )
);

-- Walk a path's history on a branch without scanning all deltas.
CREATE INDEX IF NOT EXISTS idx_symbol_deltas_branch_path
  ON symbol_deltas(branch, path_id, seq DESC);

-- Walk all deltas on a branch in order (view builder's primary access pattern).
CREATE INDEX IF NOT EXISTS idx_symbol_deltas_branch_seq
  ON symbol_deltas(branch, seq);

-- -----------------------------------------------------------------------------
-- Agent feedback signals. Persistent across view rebuilds: feedback is a
-- property of the (symbol identity, task type, time) tuple, not of any one
-- materialized view. The retrieval orchestrator's feedback-boost pass reads
-- recent signals and adjusts symbol scores accordingly.
--
-- Rows are written by the agent.feedback handler. Symbol identity is the
-- stable (content_hash, local_id) pair — same identity used by SymbolRow.
-- We do NOT FK to blob_symbols here: feedback can outlive the symbol
-- (e.g. a symbol was renamed; its old identity is gone from blob_symbols
-- but the feedback still tells us "this kind of name was useful for this
-- task"). The boost pass tolerates missing identities.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS feedback_signals (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  ts              TEXT NOT NULL,                -- ISO-8601
  slice_handle    TEXT,                         -- nullable; opaque from the caller
  content_hash    TEXT NOT NULL,
  local_id        INTEGER NOT NULL,
  signal          TEXT NOT NULL CHECK (signal IN ('useful', 'missing')),
  task_type       TEXT,                         -- nullable; "debug" / "review" / etc.
  task_text       TEXT                          -- nullable; abbreviated task description
);

-- Fast "give me recent feedback for this symbol identity" lookup; bounded
-- scans on (ts) for time-windowed reads.
CREATE INDEX IF NOT EXISTS idx_feedback_signals_symbol
  ON feedback_signals(content_hash, local_id, ts DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_signals_ts
  ON feedback_signals(ts DESC);

CREATE INDEX IF NOT EXISTS idx_feedback_signals_task_ts
  ON feedback_signals(task_type, ts DESC);

CREATE VIRTUAL TABLE IF NOT EXISTS feedback_fts USING fts5 (
  task_text,
  task_type,
  signal,
  content = 'feedback_signals',
  content_rowid = 'id',
  tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TRIGGER IF NOT EXISTS feedback_signals_ai AFTER INSERT ON feedback_signals BEGIN
  INSERT INTO feedback_fts(rowid, task_text, task_type, signal)
    VALUES (new.id, new.task_text, new.task_type, new.signal);
END;

CREATE TRIGGER IF NOT EXISTS feedback_signals_ad AFTER DELETE ON feedback_signals BEGIN
  INSERT INTO feedback_fts(feedback_fts, rowid, task_text, task_type, signal)
    VALUES ('delete', old.id, old.task_text, old.task_type, old.signal);
END;

CREATE TRIGGER IF NOT EXISTS feedback_signals_au AFTER UPDATE ON feedback_signals BEGIN
  INSERT INTO feedback_fts(feedback_fts, rowid, task_text, task_type, signal)
    VALUES ('delete', old.id, old.task_text, old.task_type, old.signal);
  INSERT INTO feedback_fts(rowid, task_text, task_type, signal)
    VALUES (new.id, new.task_text, new.task_type, new.signal);
END;

-- -----------------------------------------------------------------------------
-- Native ATLAS policy. A single JSON policy document is stored per repo context.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS atlas_policy (
  repo_id         TEXT PRIMARY KEY,
  policy_json     TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- -----------------------------------------------------------------------------
-- Native ATLAS usage events. Dispatch writes one compact row per v2 action so
-- usage.stats can report session/history data without the old ATLAS runtime.
-- -----------------------------------------------------------------------------

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

-- -----------------------------------------------------------------------------
-- SCIP index bookkeeping. One row per ingested .scip file. Used to detect
-- whether a given indexer output has already been consumed (so warm jobs
-- can short-circuit) and to capture every input that affects compiler-backed
-- output so we can detect drift.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS scip_indexes (
  id                    INTEGER PRIMARY KEY AUTOINCREMENT,
  scheme                TEXT NOT NULL,                 -- "scip-typescript" | "scip-java" | ...
  tool_name             TEXT NOT NULL,                 -- ToolInfo.name
  indexer_version       TEXT NOT NULL,                 -- ToolInfo.version
  indexer_arguments     TEXT NOT NULL DEFAULT '[]',    -- JSON-encoded ToolInfo.arguments
  project_root          TEXT NOT NULL,                 -- Metadata.project_root
  langs                 TEXT NOT NULL,                 -- comma-separated language tags
  fileset_hash          TEXT NOT NULL,                 -- SHA-256 of (sorted [repo_rel_path,content_hash])
  config_hash           TEXT NOT NULL DEFAULT '',      -- SHA-256 of (tsconfig|go.mod|pom.xml|...)
  deps_hash             TEXT NOT NULL DEFAULT '',      -- SHA-256 of (package-lock|go.sum|...)
  document_count        INTEGER NOT NULL,
  documents_failed      INTEGER NOT NULL DEFAULT 0,
  occurrence_count      INTEGER NOT NULL,
  external_symbol_count INTEGER NOT NULL,
  status                TEXT NOT NULL DEFAULT 'complete'
                          CHECK (status IN ('complete','partial')),
  produced_at           TEXT,                          -- ISO-8601 from the .scip metadata, nullable
  ingested_at           TEXT NOT NULL,                 -- ISO-8601
  scip_bytes_hash       TEXT,                          -- SHA-256 of the raw .scip bytes (pre-decode skip key)
  ingested_head         TEXT,                          -- git HEAD at ingest time (bounds cheap-skip staleness)
  UNIQUE (scheme, indexer_version, fileset_hash, config_hash, deps_hash)
);

CREATE INDEX IF NOT EXISTS idx_scip_indexes_scheme
  ON scip_indexes(scheme);

CREATE INDEX IF NOT EXISTS idx_scip_indexes_bytes_hash
  ON scip_indexes(scip_bytes_hash);
