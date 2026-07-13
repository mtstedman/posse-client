// @ts-check
//
// DDL loader for ATLAS v2. Reads the adjacent .sql files at module init and
// exports them as strings. Phase 1 storage implementations import these
// and apply them to a freshly opened SQLite database.
//
// Schema versions are bumped here when an on-disk format must be rebuilt.
// The ATLAS v2 stores are rebuildable from repo state; stale formats should
// be flushed instead of kept alive with risky partial migrations.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function load(name) {
  return readFileSync(path.join(__dirname, name), "utf-8");
}

export const LEDGER_DDL = load("ledger.sql");
export const VIEW_DDL = load("view.sql");

/**
 * Bumped whenever rebuildable ATLAS data or index layout changes. Cold boot
 * uses a ledger mismatch as the generation marker and recreates every
 * rebuildable store together; memory.db is intentionally outside this boundary.
 */
export const ATLAS_DATA_SCHEMA_VERSION = 3;
export const LEDGER_SCHEMA_VERSION = ATLAS_DATA_SCHEMA_VERSION;
export const VIEW_SCHEMA_VERSION = ATLAS_DATA_SCHEMA_VERSION;
