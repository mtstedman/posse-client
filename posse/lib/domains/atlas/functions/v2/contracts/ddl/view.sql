-- ATLAS v2 view schema.
--
-- One file per worktree: <worktree>/.posse/atlas/view.db
-- Also used for the always-warm main view: <repo>/.posse/atlas/views/main.view.db
-- And for warmed-but-not-yet-mounted WI views: <repo>/.posse/atlas/views/warmed/wi-{id}.view.db
--
-- A view is a *materialized projection* of the ledger at a specific
-- (branch, ledger_seq). It is denormalized for read speed — every symbol
-- row has its name, kind, and path inline, no joins required for the hot
-- query paths (symbol search, callers, slice).
--
-- A view can always be rebuilt from the ledger. Treat it as a cache, not
-- as truth. If anything looks wrong, blow it away and replay from the
-- ledger.

PRAGMA journal_mode = WAL;
PRAGMA synchronous = NORMAL;
PRAGMA foreign_keys = ON;

-- -----------------------------------------------------------------------------
-- Schema versioning + the ViewMeta payload (see schemas.js).
-- Keys: "schema_version", "branch", "parent_branch", "parent_seq",
--       "ledger_seq", "built_at", "warmed_for_files" (JSON), "repo_root".
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS meta (
  key   TEXT PRIMARY KEY,
  value TEXT
);

-- -----------------------------------------------------------------------------
-- Working-tree snapshot: which content_hash each path currently resolves to.
-- This is the "git tree" overlay layer — branches diverge by overlaying
-- their own path_to_blob entries on top of their parent's.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS path_to_blob (
  repo_rel_path TEXT PRIMARY KEY,
  content_hash  TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_path_to_blob_hash
  ON path_to_blob(content_hash);

-- -----------------------------------------------------------------------------
-- Materialized symbols. global_id is local to this view DB — do not assume
-- stability across views. Stable identity across views is
-- (content_hash, local_id).
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS symbols (
  global_id        INTEGER PRIMARY KEY AUTOINCREMENT,
  content_hash     TEXT NOT NULL,
  local_id         INTEGER NOT NULL,
  kind             TEXT NOT NULL,
  name             TEXT NOT NULL,
  qualified_name   TEXT,
  parent_global_id INTEGER,
  repo_rel_path    TEXT NOT NULL,
  range_start      INTEGER NOT NULL,
  range_end        INTEGER NOT NULL,
  range_start_line INTEGER,                  -- 1-based; nullable for legacy rows pre-line-anchors
  range_end_line   INTEGER,                  -- 1-based; nullable for legacy rows pre-line-anchors
  signature_hash   TEXT NOT NULL,
  signature_text   TEXT,                     -- raw signature; nullable for legacy rows pre-signature-text
  body_identifiers TEXT,                      -- deduped identifier-token bag for symbol-body FTS
  visibility       TEXT,
  doc              TEXT,
  lang             TEXT NOT NULL,
  merged_fingerprint TEXT,                    -- deterministic A+B symbol fingerprint for derived caches
  UNIQUE (repo_rel_path, local_id),
  FOREIGN KEY (parent_global_id) REFERENCES symbols(global_id)
);

CREATE INDEX IF NOT EXISTS idx_symbols_name           ON symbols(name);
CREATE INDEX IF NOT EXISTS idx_symbols_qualified_name ON symbols(qualified_name)
  WHERE qualified_name IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_symbols_path           ON symbols(repo_rel_path);
CREATE INDEX IF NOT EXISTS idx_symbols_kind           ON symbols(kind);
CREATE INDEX IF NOT EXISTS idx_symbols_content_local  ON symbols(content_hash, local_id);

-- Full-text search over symbol names + qualified names. External-content
-- FTS so we do not duplicate the strings.
CREATE VIRTUAL TABLE IF NOT EXISTS symbols_fts USING fts5 (
  name,
  qualified_name,
  body_identifiers,
  content = 'symbols',
  content_rowid = 'global_id',
  tokenize = 'unicode61 remove_diacritics 2'
);

-- FTS sync triggers. Mechanical; ignore unless changing the symbols table.
CREATE TRIGGER IF NOT EXISTS symbols_ai AFTER INSERT ON symbols BEGIN
  INSERT INTO symbols_fts(rowid, name, qualified_name, body_identifiers)
    VALUES (new.global_id, new.name, new.qualified_name, new.body_identifiers);
END;

CREATE TRIGGER IF NOT EXISTS symbols_ad AFTER DELETE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, body_identifiers)
    VALUES ('delete', old.global_id, old.name, old.qualified_name, old.body_identifiers);
END;

CREATE TRIGGER IF NOT EXISTS symbols_au AFTER UPDATE ON symbols BEGIN
  INSERT INTO symbols_fts(symbols_fts, rowid, name, qualified_name, body_identifiers)
    VALUES ('delete', old.global_id, old.name, old.qualified_name, old.body_identifiers);
  INSERT INTO symbols_fts(rowid, name, qualified_name, body_identifiers)
    VALUES (new.global_id, new.name, new.qualified_name, new.body_identifiers);
END;

-- -----------------------------------------------------------------------------
-- Materialized edges. Resolved edges have to_global_id set; unresolved edges
-- carry to_name only. Retrieval queries use both — "find callers" walks
-- to_global_id, "find what references this name anywhere" walks to_name.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS edges (
  from_global_id       INTEGER NOT NULL,
  to_global_id         INTEGER,
  to_name              TEXT NOT NULL,
  to_module            TEXT,
  to_external_id       INTEGER,                  -- mirrored from ledger blob_edges.to_external_id
                                                 --   when the edge target is a SCIP external moniker.
  external_descriptor  TEXT,                     -- denormalized SCIP descriptor for display so
                                                 --   retrieval doesn't need a JOIN on the hot path.
  source               TEXT NOT NULL DEFAULT 'treesitter',  -- mirrored from ledger blob_edges.source
  kind                 TEXT NOT NULL,
  repo_rel_path        TEXT NOT NULL,
  range_start          INTEGER NOT NULL,
  range_end            INTEGER NOT NULL,
  range_start_line     INTEGER,                  -- 1-based; nullable for legacy rows pre-line-anchors
  range_end_line       INTEGER,                  -- 1-based; nullable for legacy rows pre-line-anchors
  confidence           INTEGER NOT NULL CHECK (confidence BETWEEN 0 AND 100),
  FOREIGN KEY (from_global_id) REFERENCES symbols(global_id) ON DELETE CASCADE,
  FOREIGN KEY (to_global_id)   REFERENCES symbols(global_id) ON DELETE SET NULL
);

CREATE INDEX IF NOT EXISTS idx_edges_from    ON edges(from_global_id);
CREATE INDEX IF NOT EXISTS idx_edges_to      ON edges(to_global_id)
  WHERE to_global_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_edges_to_name ON edges(to_name);
CREATE INDEX IF NOT EXISTS idx_edges_kind    ON edges(kind);
CREATE INDEX IF NOT EXISTS idx_edges_external ON edges(to_external_id)
  WHERE to_external_id IS NOT NULL;

-- -----------------------------------------------------------------------------
-- Rebuildable graph-derived state. These tables are caches over symbols/edges:
-- clusters, process chains, and centrality rankings can always be recomputed.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS symbol_centrality (
  symbol_global_id INTEGER PRIMARY KEY,
  fan_in           INTEGER NOT NULL DEFAULT 0,
  fan_out          INTEGER NOT NULL DEFAULT 0,
  call_fan_in      INTEGER NOT NULL DEFAULT 0,
  call_fan_out     INTEGER NOT NULL DEFAULT 0,
  score            REAL NOT NULL DEFAULT 0,
  FOREIGN KEY (symbol_global_id) REFERENCES symbols(global_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symbol_centrality_score
  ON symbol_centrality(score DESC);

CREATE TABLE IF NOT EXISTS symbol_clusters (
  symbol_global_id INTEGER PRIMARY KEY,
  cluster_id       TEXT NOT NULL,
  membership_score REAL NOT NULL DEFAULT 1.0,
  FOREIGN KEY (symbol_global_id) REFERENCES symbols(global_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_symbol_clusters_cluster
  ON symbol_clusters(cluster_id);

CREATE TABLE IF NOT EXISTS cluster_summaries (
  cluster_id            TEXT PRIMARY KEY,
  symbol_count          INTEGER NOT NULL DEFAULT 0,
  file_count            INTEGER NOT NULL DEFAULT 0,
  dominant_path         TEXT,
  bridge_count          INTEGER NOT NULL DEFAULT 0,
  entry_symbol_ids_json TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS process_summaries (
  process_id       TEXT PRIMARY KEY,
  entry_global_id  INTEGER NOT NULL,
  entry_name       TEXT NOT NULL,
  depth            INTEGER NOT NULL DEFAULT 0,
  symbol_count     INTEGER NOT NULL DEFAULT 0,
  path_json        TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (entry_global_id) REFERENCES symbols(global_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_process_summaries_entry
  ON process_summaries(entry_global_id);

CREATE TABLE IF NOT EXISTS process_steps (
  process_id       TEXT NOT NULL,
  step_order       INTEGER NOT NULL,
  symbol_global_id INTEGER NOT NULL,
  depth            INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (process_id, step_order),
  FOREIGN KEY (process_id) REFERENCES process_summaries(process_id) ON DELETE CASCADE,
  FOREIGN KEY (symbol_global_id) REFERENCES symbols(global_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_process_steps_symbol
  ON process_steps(symbol_global_id);

-- -----------------------------------------------------------------------------
-- Rebuildable tree-derived state. This is a stable containment map over the
-- view: repo path nodes plus symbol parent/child nodes. It stores raw facts and
-- aggregate counts only; query ranking, pruning, and summaries are projection
-- concerns.
-- -----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS atlas_tree_nodes (
  node_id                 TEXT PRIMARY KEY,
  parent_node_id          TEXT,
  kind                    TEXT NOT NULL,
  label                   TEXT NOT NULL,
  stable_ref              TEXT NOT NULL,
  repo_rel_path           TEXT,
  symbol_ref              TEXT,
  symbol_global_id        INTEGER,           -- convenience FK; view-local. Use symbol_ref / node_id for stable identity.
  depth                   INTEGER NOT NULL DEFAULT 0,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  child_count             INTEGER NOT NULL DEFAULT 0,
  descendant_symbol_count INTEGER NOT NULL DEFAULT 0,
  descendant_file_count   INTEGER NOT NULL DEFAULT 0,
  aggregates_json         TEXT NOT NULL DEFAULT '{}',
  terms_json              TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (parent_node_id) REFERENCES atlas_tree_nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (symbol_global_id) REFERENCES symbols(global_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_atlas_tree_nodes_parent
  ON atlas_tree_nodes(parent_node_id);

CREATE INDEX IF NOT EXISTS idx_atlas_tree_nodes_path
  ON atlas_tree_nodes(repo_rel_path)
  WHERE repo_rel_path IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_atlas_tree_nodes_symbol
  ON atlas_tree_nodes(symbol_global_id)
  WHERE symbol_global_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS atlas_tree_refs (
  node_id  TEXT NOT NULL,
  ref_type TEXT NOT NULL,
  ref_id   TEXT NOT NULL,
  weight   REAL NOT NULL DEFAULT 1,
  PRIMARY KEY (node_id, ref_type, ref_id),
  FOREIGN KEY (node_id) REFERENCES atlas_tree_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_atlas_tree_refs_ref
  ON atlas_tree_refs(ref_type, ref_id);

CREATE TABLE IF NOT EXISTS atlas_tree_scope_nodes (
  node_id                 TEXT PRIMARY KEY,
  parent_node_id          TEXT,
  kind                    TEXT NOT NULL,
  label                   TEXT NOT NULL,
  repo_rel_path           TEXT NOT NULL,
  depth                   INTEGER NOT NULL DEFAULT 0,
  sort_order              INTEGER NOT NULL DEFAULT 0,
  descendant_symbol_count INTEGER NOT NULL DEFAULT 0,
  descendant_file_count   INTEGER NOT NULL DEFAULT 0,
  generated               INTEGER NOT NULL DEFAULT 0,
  test                    INTEGER NOT NULL DEFAULT 0,
  config                  INTEGER NOT NULL DEFAULT 0,
  aggregates_json         TEXT NOT NULL DEFAULT '{}',
  terms_json              TEXT NOT NULL DEFAULT '[]',
  projected_terms_json    TEXT NOT NULL DEFAULT '[]',
  FOREIGN KEY (node_id) REFERENCES atlas_tree_nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (parent_node_id) REFERENCES atlas_tree_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_atlas_tree_scope_nodes_path
  ON atlas_tree_scope_nodes(repo_rel_path);

CREATE INDEX IF NOT EXISTS idx_atlas_tree_scope_nodes_parent
  ON atlas_tree_scope_nodes(parent_node_id);

CREATE INDEX IF NOT EXISTS idx_atlas_tree_scope_nodes_kind
  ON atlas_tree_scope_nodes(kind);

CREATE TABLE IF NOT EXISTS atlas_tree_scope_terms (
  term        TEXT NOT NULL,
  node_id     TEXT NOT NULL,
  kind        TEXT NOT NULL,
  direct      INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (term, node_id, direct),
  FOREIGN KEY (node_id) REFERENCES atlas_tree_scope_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_atlas_tree_scope_terms_term_kind
  ON atlas_tree_scope_terms(term, kind, direct);

CREATE TABLE IF NOT EXISTS atlas_tree_scope_term_stats (
  term                 TEXT PRIMARY KEY,
  direct_file_count    INTEGER NOT NULL DEFAULT 0,
  projected_file_count INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS atlas_tree_scope_symbol_files (
  symbol_ref     TEXT NOT NULL,
  symbol_node_id TEXT NOT NULL,
  file_node_id   TEXT NOT NULL,
  repo_rel_path  TEXT NOT NULL,
  PRIMARY KEY (symbol_ref, symbol_node_id),
  FOREIGN KEY (symbol_node_id) REFERENCES atlas_tree_nodes(node_id) ON DELETE CASCADE,
  FOREIGN KEY (file_node_id) REFERENCES atlas_tree_scope_nodes(node_id) ON DELETE CASCADE
);

CREATE INDEX IF NOT EXISTS idx_atlas_tree_scope_symbol_files_node
  ON atlas_tree_scope_symbol_files(symbol_node_id);

CREATE TABLE IF NOT EXISTS derived_state_runs (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  built_at     TEXT NOT NULL,
  kind         TEXT NOT NULL,
  status       TEXT NOT NULL,
  duration_ms  INTEGER NOT NULL DEFAULT 0,
  details_json TEXT NOT NULL DEFAULT '{}'
);
