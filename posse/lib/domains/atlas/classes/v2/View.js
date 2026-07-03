// @ts-check
//
// ATLAS v2 View — read-side materialized projection of the ledger. One
// SQLite file per consumer (worktree, warmed slot, or main warm). Built
// by ViewBuilder; queried by retrieval code.
//
// A view is a CACHE, not authoritative. It can always be rebuilt from
// the ledger. If anything looks wrong, delete the file and rebuild.

import path from "path";
import fs from "fs";
import crypto from "crypto";
import Database from "better-sqlite3";
import { VIEW_DDL, VIEW_SCHEMA_VERSION } from "../../functions/v2/contracts/index.js";
import { isCanonicalRepoPath } from "../../functions/v2/paths.js";
import { ensureGraphDerivedTables } from "../../functions/v2/graph-derived.js";
import { ftsQueryForTerm, normalizeSearchScope } from "../../functions/v2/view-fts.js";
import { runBlastRadius, runSlice } from "../../functions/v2/view-slice.js";

/** @typedef {import("../../functions/v2/contracts/schemas.js").ViewMeta} ViewMeta */
/** @typedef {import("../../functions/v2/contracts/api.js").View} ViewContract */
/** @typedef {import("../../functions/v2/contracts/api.js").ViewQuery} ViewQuery */
/** @typedef {import("../../functions/v2/contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../../functions/v2/contracts/api.js").ViewEdge} ViewEdge */
/** @typedef {import("../../functions/v2/contracts/api.js").SymbolSearchOptions} SymbolSearchOptions */
/** @typedef {import("../../functions/v2/contracts/api.js").SliceOptions} SliceOptions */

/**
 * @param {Database.Database} db
 * @param {string} sql
 */
function runDdl(db, sql) {
  db["exec"](sql);
}

const VIEW_INDEXES = Object.freeze([
  {
    name: "idx_symbols_path",
    sql: "CREATE INDEX IF NOT EXISTS idx_symbols_path ON symbols(repo_rel_path, range_start, global_id)",
  },
  {
    name: "idx_symbols_lang",
    sql: "CREATE INDEX IF NOT EXISTS idx_symbols_lang ON symbols(lang)",
  },
  {
    name: "idx_edges_from",
    sql: "CREATE INDEX IF NOT EXISTS idx_edges_from ON edges(from_global_id, range_start)",
  },
  {
    name: "idx_edges_to",
    sql: `CREATE INDEX IF NOT EXISTS idx_edges_to ON edges(to_global_id, from_global_id)
      WHERE to_global_id IS NOT NULL`,
  },
  {
    name: "idx_edges_source",
    sql: "CREATE INDEX IF NOT EXISTS idx_edges_source ON edges(source)",
  },
]);

/**
 * @param {string} dbPath
 * @returns {Database.Database}
 */
function openDbReadOnly(dbPath) {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma("busy_timeout = 5000");
  return db;
}

/**
 * @param {string} dbPath
 * @returns {Database.Database}
 */
function openDbReadWrite(dbPath) {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  let fresh = !fs.existsSync(dbPath);
  let db;
  try {
    db = new Database(dbPath);
  } catch {
    removeSqliteFile(dbPath);
    db = new Database(dbPath);
    fresh = true;
  }
  if (!fresh) {
    let reset = false;
    try {
      reset = viewNeedsFormatReset(db);
    } catch {
      reset = true;
    }
    if (reset) {
      try { db.close(); } catch { /* ignore close failures while resetting */ }
      removeSqliteFile(dbPath);
      db = new Database(dbPath);
      fresh = true;
    }
  }
  // busy_timeout and synchronous are per-connection; the DDL's pragmas only
  // ever applied to the connection that created the file, so reopens ran with
  // busy_timeout=0 and synchronous=FULL.
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  if (fresh) runDdl(db, VIEW_DDL);
  // Idempotent additive column adds for pre-line-anchor view DBs.
  ensureColumn(db, "symbols", "range_start_line", "INTEGER");
  ensureColumn(db, "symbols", "range_end_line", "INTEGER");
  ensureColumn(db, "edges", "range_start_line", "INTEGER");
  ensureColumn(db, "edges", "range_end_line", "INTEGER");
  // Pre-signature-text view DBs: legacy rows get NULL signature_text.
  ensureColumn(db, "symbols", "signature_text", "TEXT");
  ensureColumn(db, "symbols", "body_identifiers", "TEXT");
  ensureColumn(db, "symbols", "merged_fingerprint", "TEXT");
  // Pre-SCIP view DBs: SCIP-bound external edges carry a pointer back to
  // external_symbols(id) (denormalized into external_descriptor for hot
  // path retrieval), and `source` mirrors the ledger's row provenance so
  // the resolver can skip SCIP-bound rows.
  ensureColumn(db, "edges", "to_external_id", "INTEGER");
  ensureColumn(db, "edges", "external_descriptor", "TEXT");
  ensureColumn(db, "edges", "source", "TEXT NOT NULL DEFAULT 'treesitter'");
  ensureViewIndexes(db);
  ensureGraphDerivedTables(db);
  return db;
}

/**
 * @param {string} dbPath
 */
function removeSqliteFile(dbPath) {
  for (const sfx of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(dbPath + sfx); }
    catch { /* disposable cache cleanup is best effort */ }
  }
}

/**
 * @param {Database.Database} db
 * @returns {Set<string>}
 */
function applicationTableNames(db) {
  const rows = /** @type {Array<{ name: string }>} */ (
    db.prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'",
    ).all()
  );
  return new Set(rows.map((r) => r.name));
}

/**
 * View DBs are rebuildable caches. If an existing file is stale or malformed,
 * recreate it instead of trying to run current statements against old tables.
 *
 * @param {Database.Database} db
 * @returns {boolean}
 */
function viewNeedsFormatReset(db) {
  const tables = applicationTableNames(db);
  if (tables.size === 0) return true;
  for (const table of ["meta", "path_to_blob", "symbols", "edges"]) {
    if (!tables.has(table)) return true;
  }
  const existing = /** @type {{ value: string } | undefined} */ (
    db.prepare("SELECT value FROM meta WHERE key = ?").get("schema_version")
  );
  return !existing || Number(existing.value) !== VIEW_SCHEMA_VERSION;
}

/**
 * Add `column` to `table` if it does not already exist. Used during
 * read-write open so additive view-schema evolutions stay backwards
 * compatible without bumping VIEW_SCHEMA_VERSION.
 *
 * @param {Database.Database} db
 * @param {string} table
 * @param {string} column
 * @param {string} sqlType
 */
function ensureColumn(db, table, column, sqlType) {
  const cols = /** @type {Array<{ name: string }>} */ (
    db.prepare(`PRAGMA table_info(${table})`).all()
  );
  if (cols.some((c) => c.name === column)) return;
  runDdl(db, `ALTER TABLE ${table} ADD COLUMN ${column} ${sqlType}`);
}

/**
 * Keep additive/replacement index upgrades compatible with existing view DBs.
 * Views are rebuildable caches, but replacing the known index definitions here
 * avoids forcing a schema-version bump just to improve planner choices.
 *
 * @param {Database.Database} db
 */
function ensureViewIndexes(db) {
  for (const index of VIEW_INDEXES) {
    ensureIndex(db, index.name, index.sql);
  }
}

/**
 * @param {Database.Database} db
 * @param {string} name
 * @param {string} sql
 */
function ensureIndex(db, name, sql) {
  const row = /** @type {{ sql: string | null } | undefined} */ (
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?").get(name)
  );
  if (row && normalizeIndexSql(row.sql) !== normalizeIndexSql(sql)) {
    runDdl(db, `DROP INDEX IF EXISTS ${name}`);
  }
  runDdl(db, sql);
}

/**
 * @param {string | null | undefined} sql
 */
function normalizeIndexSql(sql) {
  return String(sql || "")
    .replace(/\s+/g, " ")
    .replace(/;$/, "")
    .trim()
    .toLowerCase();
}

/**
 * @param {string} prefix
 */
function pathPrefixBounds(prefix) {
  const normalized = String(prefix || "").replace(/\/+$/, "");
  return {
    exact: normalized,
    lower: `${normalized}/`,
    // Repo paths use forward slashes; "0" is the next ASCII code point after
    // "/". This bounds descendants without matching sibling prefixes.
    upper: `${normalized}0`,
  };
}

/** @implements {ViewContract} */
export class View {
  /** @type {Database.Database} */
  #db;
  /** @type {string} */
  #dbPath;
  /** @type {ViewQuery} */
  #query;
  /** @type {"readonly" | "readwrite"} */
  #mode;

  /**
   * @param {{ dbPath: string, mode?: "readonly" | "readwrite" }} args
   */
  constructor({ dbPath, mode = "readonly" }) {
    if (!dbPath) throw new Error("View: dbPath is required");
    this.#dbPath = path.resolve(dbPath);
    this.#mode = mode;
    this.#db = mode === "readonly" ? openDbReadOnly(dbPath) : openDbReadWrite(dbPath);
    try {
      // PRAGMAs from DDL only bind to the connection that ran them; re-assert
      // here so every open enforces FK constraints (needed for the
      // symbols/edges cascade-on-delete behavior).
      this.#db.pragma("foreign_keys = ON");
      this.#query = this.#buildQueryApi();
    } catch (err) {
      try { this.#db.close(); } catch { /* ignore cleanup failures */ }
      throw err;
    }
  }

  /**
   * @param {{ dbPath: string, mode?: "readonly" | "readwrite" }} args
   * @returns {View}
   */
  static mount(args) {
    return new View(args);
  }

  /** @returns {ViewMeta} */
  meta() {
    const rows = this.#db.prepare("SELECT key, value FROM meta").all();
    /** @type {Record<string, string>} */
    const map = {};
    for (const r of /** @type {any[]} */ (rows)) {
      if (r.value !== null && r.value !== undefined) map[r.key] = r.value;
    }
    const schemaVersion = map.schema_version ? Number(map.schema_version) : NaN;
    if (Number.isNaN(schemaVersion)) {
      throw new Error("View.meta: missing or invalid schema_version in view DB");
    }
    if (schemaVersion !== VIEW_SCHEMA_VERSION) {
      throw new Error(
        `View.meta: schema_version mismatch (db=${schemaVersion}, code=${VIEW_SCHEMA_VERSION})`,
      );
    }
    // branch is load-bearing for ViewBuilder.incrementalApply (mismatch
    // means the entire batch gets rejected). Catch the corruption here
    // rather than letting a mid-query rebuild silently no-op.
    if (typeof map.branch !== "string" || map.branch.length === 0) {
      throw new Error("View.meta: missing or empty branch in view DB");
    }
    const ledgerSeqRaw = map.ledger_seq;
    const ledgerSeq = Number(ledgerSeqRaw);
    if (ledgerSeqRaw == null || !Number.isInteger(ledgerSeq) || ledgerSeq < 0) {
      throw new Error("View.meta: missing or invalid ledger_seq in view DB");
    }
    return {
      schema_version: schemaVersion,
      branch: map.branch,
      parent_branch: map.parent_branch ?? null,
      parent_seq: map.parent_seq != null ? Number(map.parent_seq) : null,
      ledger_seq: ledgerSeq,
      built_at: map.built_at,
      warmed_for_files: map.warmed_for_files ? JSON.parse(map.warmed_for_files) : null,
      prefetched_symbols: map.prefetched_symbols != null ? Number(map.prefetched_symbols) : null,
      prefetched_edges: map.prefetched_edges != null ? Number(map.prefetched_edges) : null,
      repo_root: map.repo_root ?? null,
      layer_merge: map.layer_merge === "on" || map.layer_merge === "true" || map.layer_merge === "1",
    };
  }

  /** @returns {ViewQuery} */
  get query() {
    return this.#query;
  }

  /**
   * Merge the latest tree-sitter (A) and SCIP (B) layers for one language into
   * this retrieval-facing view. Existing path_to_blob rows determine which
   * content hashes are queryable in this view; layer rows for other blobs stay
   * dormant until the branch/view points at them.
   *
   * @param {{
   *   ledger: { _unsafeDb?: () => Database.Database },
   *   lang: string,
   *   contentHashes?: string[] | null,
   * }} args
   * @returns {{ skipped: boolean, reason?: string, lang: string, sources: string[], mergedSymbols: number, mergedEdges: number, status: "indexed" | "enriched" | "stale" }}
   */
  mergeLanguageLayers(args) {
    if (this.#mode !== "readwrite") {
      throw new Error("View.mergeLanguageLayers: view must be opened readwrite");
    }
    const lang = String(args?.lang || "").trim();
    if (!lang) throw new TypeError("View.mergeLanguageLayers: lang is required");
    const ledgerDb = args?.ledger && typeof args.ledger._unsafeDb === "function"
      ? args.ledger._unsafeDb()
      : null;
    if (!ledgerDb) throw new TypeError("View.mergeLanguageLayers: ledger with _unsafeDb is required");

    const latest = latestLayerWatermarks(ledgerDb, lang, args.contentHashes || null);
    const currentTree = viewMetaValue(this.#db, `merged_treesitter_at_${lang}`);
    const currentScip = viewMetaValue(this.#db, `merged_scip_at_${lang}`);
    const treeFresh = !latest.treesitter || latest.treesitter <= (currentTree || "");
    const scipFresh = !latest.scip || latest.scip <= (currentScip || "");
    if (treeFresh && scipFresh) {
      return {
        skipped: true,
        reason: "watermark_current",
        lang,
        sources: latest.sources,
        mergedSymbols: 0,
        mergedEdges: 0,
        status: latest.scip ? "enriched" : latest.treesitter ? "indexed" : "stale",
      };
    }

    const selectedHashes = selectedLayerContentHashes(this.#db, ledgerDb, lang, args.contentHashes || null);
    if (selectedHashes.length === 0) {
      return {
        skipped: true,
        reason: "no_queryable_layers",
        lang,
        sources: latest.sources,
        mergedSymbols: 0,
        mergedEdges: 0,
        status: "stale",
      };
    }

    const txn = this.#db.transaction(() => {
      let mergedSymbols = 0;
      let mergedEdges = 0;
      for (const contentHash of selectedHashes) {
        const result = materializeLayeredContentHash({
          viewDb: this.#db,
          ledgerDb,
          lang,
          contentHash,
        });
        mergedSymbols += result.symbols;
        mergedEdges += result.edges;
      }
      if (latest.treesitter) viewSetMetaValue(this.#db, `merged_treesitter_at_${lang}`, latest.treesitter);
      if (latest.scip) viewSetMetaValue(this.#db, `merged_scip_at_${lang}`, latest.scip);
      viewSetMetaValue(this.#db, `parse_status_${lang}`, latest.scip ? "enriched" : "indexed");
      return { mergedSymbols, mergedEdges };
    });
    const counts = txn();
    return {
      skipped: false,
      lang,
      sources: latest.sources,
      mergedSymbols: counts.mergedSymbols,
      mergedEdges: counts.mergedEdges,
      status: latest.scip ? "enriched" : "indexed",
    };
  }

  /** @returns {void} */
  close() {
    this.#db.close();
  }

  // ---------------------------------------------------------------------------
  // Internals — used by ViewBuilder for write-side population.
  // ---------------------------------------------------------------------------

  /** @returns {Database.Database} */
  _unsafeDb() {
    return this.#db;
  }

  /** @returns {"readonly" | "readwrite"} */
  _mode() {
    return this.#mode;
  }

  /** @returns {string} */
  _dbPath() {
    return this.#dbPath;
  }

  // ---------------------------------------------------------------------------
  // Query API
  // ---------------------------------------------------------------------------

  /** @returns {ViewQuery} */
  #buildQueryApi() {
    const db = this.#db;

    const stmtFindSymbolFts = db.prepare(
      `SELECT s.*
       FROM symbols_fts f
       JOIN symbols s ON s.global_id = f.rowid
       WHERE symbols_fts MATCH ?
       ORDER BY rank
       LIMIT ?`,
    );
    const stmtFindSymbolExact = db.prepare(
      `SELECT * FROM symbols
       WHERE name = ?
       ORDER BY global_id ASC
       LIMIT ?`,
    );
    const stmtGetSymbol = db.prepare("SELECT * FROM symbols WHERE global_id = ?");
    const stmtSymbolsInFile = db.prepare(
      "SELECT * FROM symbols WHERE repo_rel_path = ? ORDER BY range_start ASC, global_id ASC",
    );
    const stmtCallers = db.prepare(
      `SELECT from_global_id, to_global_id, to_name, to_module,
              to_external_id, external_descriptor, source,
              kind, repo_rel_path,
              range_start, range_end, range_start_line, range_end_line, confidence
       FROM edges
       WHERE to_global_id = ?
       ORDER BY from_global_id ASC`,
    );
    const stmtCallees = db.prepare(
      `SELECT from_global_id, to_global_id, to_name, to_module,
              to_external_id, external_descriptor, source,
              kind, repo_rel_path,
              range_start, range_end, range_start_line, range_end_line, confidence
       FROM edges
       WHERE from_global_id = ?
       ORDER BY range_start ASC`,
    );
    const stmtUnresolvedToName = db.prepare(
      `SELECT from_global_id, to_global_id, to_name, to_module,
              to_external_id, external_descriptor, source,
              kind, repo_rel_path,
              range_start, range_end, range_start_line, range_end_line, confidence
       FROM edges
       WHERE to_global_id IS NULL AND to_external_id IS NULL AND to_name = ?`,
    );
    const stmtGetByContentLocal = db.prepare(
      `SELECT * FROM symbols
       WHERE content_hash = ? AND local_id = ?
       LIMIT 1`,
    );
    const stmtHasContentHash = db.prepare(
      `SELECT 1 AS present
       FROM symbols
       WHERE content_hash = ?
       LIMIT 1`,
    );
    const stmtAllSymbols = db.prepare(
      `SELECT * FROM symbols ORDER BY global_id ASC LIMIT ?`,
    );
    const stmtAllSymbolsPrefixed = db.prepare(
      `SELECT * FROM symbols
       WHERE repo_rel_path = ?
          OR (repo_rel_path >= ? AND repo_rel_path < ?)
       ORDER BY global_id ASC LIMIT ?`,
    );

    /** @param {any} row @returns {ViewSymbol} */
    const hydrateSymbol = (row) => ({
      global_id: row.global_id,
      content_hash: row.content_hash,
      local_id: row.local_id,
      kind: row.kind,
      name: row.name,
      qualified_name: row.qualified_name ?? null,
      repo_rel_path: row.repo_rel_path,
      range_start: row.range_start,
      range_end: row.range_end,
      // Default legacy NULLs to 1 — preserves the pre-line-anchors
      // behavior for views built before the migration ran.
      range_start_line: Number.isInteger(row.range_start_line) ? row.range_start_line : 1,
      range_end_line: Number.isInteger(row.range_end_line) ? row.range_end_line : 1,
      signature_hash: row.signature_hash,
      signature_text: row.signature_text ?? null,
      body_identifiers: row.body_identifiers ?? null,
      visibility: row.visibility ?? null,
      doc: row.doc ?? null,
      lang: row.lang,
    });

    /** @param {any} row @returns {ViewEdge} */
    const hydrateEdge = (row) => ({
      from_global_id: row.from_global_id,
      to_global_id: row.to_global_id ?? null,
      to_name: row.to_name,
      to_module: row.to_module ?? null,
      to_external_id: row.to_external_id ?? null,
      external_descriptor: row.external_descriptor ?? null,
      source: row.source || "treesitter",
      kind: row.kind,
      repo_rel_path: row.repo_rel_path,
      range_start: row.range_start,
      range_end: row.range_end,
      range_start_line: Number.isInteger(row.range_start_line) ? row.range_start_line : 1,
      range_end_line: Number.isInteger(row.range_end_line) ? row.range_end_line : 1,
      confidence: row.confidence,
    });

    /** @type {ViewQuery} */
    const api = {
      findSymbol: (name, opts = {}) => {
        const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : 50;
        const fuzzy = opts.fuzzy !== false;
        const scope = normalizeSearchScope(opts.scope);
        /** @type {any[]} */
        let rows;
        if (fuzzy) {
          // FTS5 prefix match; quote to handle punctuation.
          const ftsQuery = ftsQueryForTerm(name, { fuzzy: true, scope });
          rows = stmtFindSymbolFts.all(ftsQuery, limit);
        } else if (scope === "body") {
          rows = stmtFindSymbolFts.all(ftsQueryForTerm(name, { fuzzy: false, scope }), limit);
        } else {
          rows = stmtFindSymbolExact.all(name, limit);
        }
        let results = rows.map(hydrateSymbol);
        if (opts.kinds && opts.kinds.length > 0) {
          const k = new Set(opts.kinds);
          results = results.filter((s) => k.has(s.kind));
        }
        if (opts.langs && opts.langs.length > 0) {
          const l = new Set(opts.langs);
          results = results.filter((s) => l.has(s.lang));
        }
        if (opts.pathPrefix) {
          if (!isCanonicalRepoPath(opts.pathPrefix)) {
            // Tolerate a non-strictly-canonical prefix (the user may pass
            // a directory like "src" without trailing slash); only reject
            // truly malformed inputs (absolute, parent-escape).
            const trimmed = String(opts.pathPrefix).replace(/^\/+|\/+$/g, "");
            if (trimmed.startsWith("..") || /^[a-zA-Z]:\//.test(trimmed)) {
              throw new RangeError(`findSymbol: invalid pathPrefix '${opts.pathPrefix}'`);
            }
          }
          const prefix = String(opts.pathPrefix).replace(/\/+$/, "");
          results = results.filter(
            (s) => s.repo_rel_path === prefix || s.repo_rel_path.startsWith(prefix + "/"),
          );
        }
        return results;
      },

      getSymbol: (global_id) => {
        const row = /** @type {any} */ (stmtGetSymbol.get(global_id));
        return row ? hydrateSymbol(row) : null;
      },

      symbolsInFile: (repo_rel_path) => {
        if (!isCanonicalRepoPath(repo_rel_path)) {
          throw new RangeError(`symbolsInFile: invalid path '${repo_rel_path}'`);
        }
        const rows = /** @type {any[]} */ (stmtSymbolsInFile.all(repo_rel_path));
        return rows.map(hydrateSymbol);
      },

      callers: (global_id) => {
        const rows = /** @type {any[]} */ (stmtCallers.all(global_id));
        return rows.map(hydrateEdge);
      },

      callees: (global_id) => {
        const rows = /** @type {any[]} */ (stmtCallees.all(global_id));
        return rows.map(hydrateEdge);
      },

      unresolvedReferencesTo: (name) => {
        const rows = /** @type {any[]} */ (stmtUnresolvedToName.all(name));
        return rows.map(hydrateEdge);
      },

      slice: (seedGlobalIds, opts = {}) => {
        return runSlice(db, hydrateSymbol, seedGlobalIds, opts).symbols;
      },

      sliceWithMetadata: (seedGlobalIds, opts = {}) => {
        return runSlice(db, hydrateSymbol, seedGlobalIds, opts);
      },

      blastRadius: (paths) => {
        return runBlastRadius(db, hydrateSymbol, paths);
      },

      getByContentLocal: (content_hash, local_id) => {
        const row = /** @type {any} */ (stmtGetByContentLocal.get(content_hash, local_id));
        return row ? hydrateSymbol(row) : null;
      },

      hasContentHash: (content_hash) => {
        if (typeof content_hash !== "string" || content_hash.length === 0) return false;
        return !!stmtHasContentHash.get(content_hash);
      },

      allSymbols: (opts = {}) => {
        const limit = typeof opts.limit === "number" && opts.limit > 0 ? opts.limit : 10000;
        if (opts.pathPrefix) {
          if (!isCanonicalRepoPath(opts.pathPrefix)) {
            const trimmed = String(opts.pathPrefix).replace(/^\/+|\/+$/g, "");
            if (trimmed.startsWith("..") || /^[a-zA-Z]:\//.test(trimmed)) {
              throw new RangeError(`allSymbols: invalid pathPrefix '${opts.pathPrefix}'`);
            }
          }
          const bounds = pathPrefixBounds(String(opts.pathPrefix));
          const rows = /** @type {any[]} */ (
            stmtAllSymbolsPrefixed.all(bounds.exact, bounds.lower, bounds.upper, limit)
          );
          return rows.map(hydrateSymbol);
        }
        const rows = /** @type {any[]} */ (stmtAllSymbols.all(limit));
        return rows.map(hydrateSymbol);
      },
    };
    return Object.freeze(api);
  }
}

/**
 * @param {Database.Database} db
 * @param {string} key
 * @returns {string | null}
 */
function viewMetaValue(db, key) {
  const row = /** @type {{ value: string | null } | undefined} */ (
    db.prepare("SELECT value FROM meta WHERE key = ?").get(key)
  );
  return row?.value ?? null;
}

/**
 * @param {Database.Database} db
 * @param {string} key
 * @param {string} value
 */
function viewSetMetaValue(db, key, value) {
  db.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * @param {Database.Database} ledgerDb
 * @param {string} lang
 * @param {string[] | null} contentHashes
 * @returns {{ treesitter: string | null, scip: string | null, sources: string[] }}
 */
function latestLayerWatermarks(ledgerDb, lang, contentHashes) {
  const hashes = normalizeHashFilter(contentHashes);
  const params = [lang];
  const hashSql = hashes.length > 0
    ? ` AND content_hash IN (${hashes.map(() => "?").join(",")})`
    : "";
  params.push(...hashes);
  const rows = /** @type {Array<{ source: string, indexed_at: string }>} */ (
    ledgerDb.prepare(
      `SELECT source, MAX(indexed_at) AS indexed_at
       FROM blob_layers
       WHERE lang = ? AND status = 'indexed'${hashSql}
       GROUP BY source`,
    ).all(...params)
  );
  const out = { treesitter: null, scip: null, sources: [] };
  for (const row of rows) {
    if (row.source === "treesitter") out.treesitter = row.indexed_at;
    if (row.source === "scip") out.scip = row.indexed_at;
  }
  if (out.treesitter) out.sources.push("treesitter");
  if (out.scip) out.sources.push("scip");
  return out;
}

/**
 * @param {Database.Database} viewDb
 * @param {Database.Database} ledgerDb
 * @param {string} lang
 * @param {string[] | null} contentHashes
 * @returns {string[]}
 */
function selectedLayerContentHashes(viewDb, ledgerDb, lang, contentHashes) {
  const requested = normalizeHashFilter(contentHashes);
  const viewRows = requested.length > 0
    ? requested.map((content_hash) => ({ content_hash }))
    : /** @type {Array<{ content_hash: string }>} */ (
        viewDb.prepare("SELECT DISTINCT content_hash FROM path_to_blob ORDER BY content_hash").all()
      );
  const hasLayer = ledgerDb.prepare(
    "SELECT 1 AS one FROM blob_layers WHERE content_hash = ? AND lang = ? AND status = 'indexed' LIMIT 1",
  );
  return viewRows
    .map((row) => row.content_hash)
    .filter((contentHash) => !!hasLayer.get(contentHash, lang));
}

/**
 * @param {string[] | null | undefined} values
 * @returns {string[]}
 */
function normalizeHashFilter(values) {
  if (!Array.isArray(values)) return [];
  return [...new Set(values.map((v) => String(v || "").trim()).filter((v) => /^[0-9a-f]{64}$/i.test(v)))];
}

/**
 * @param {{
 *   viewDb: Database.Database,
 *   ledgerDb: Database.Database,
 *   lang: string,
 *   contentHash: string,
 * }} args
 * @returns {{ symbols: number, edges: number }}
 */
function materializeLayeredContentHash({ viewDb, ledgerDb, lang, contentHash }) {
  const paths = /** @type {Array<{ repo_rel_path: string }>} */ (
    viewDb.prepare("SELECT repo_rel_path FROM path_to_blob WHERE content_hash = ? ORDER BY repo_rel_path").all(contentHash)
  );
  if (paths.length === 0) return { symbols: 0, edges: 0 };
  const layers = latestLayersForContentHash(ledgerDb, contentHash, lang);
  if (layers.length === 0) return { symbols: 0, edges: 0 };

  let symbols = 0;
  let edges = 0;
  for (const pathRow of paths) {
    const result = materializeLayeredPath({
      viewDb,
      ledgerDb,
      layers,
      repoRelPath: pathRow.repo_rel_path,
      contentHash,
      lang,
    });
    symbols += result.symbols;
    edges += result.edges;
  }
  return { symbols, edges };
}

/**
 * @param {Database.Database} ledgerDb
 * @param {string} contentHash
 * @param {string} lang
 * @returns {Array<{ id: number, source: "treesitter" | "scip" }>}
 */
function latestLayersForContentHash(ledgerDb, contentHash, lang) {
  const rows = /** @type {Array<{ id: number, source: string }>} */ (
    ledgerDb.prepare(
      `SELECT id, source
       FROM blob_layers
       WHERE content_hash = ? AND lang = ? AND status = 'indexed'
       ORDER BY indexed_at DESC, id DESC`,
    ).all(contentHash, lang)
  );
  const bySource = new Map();
  for (const row of rows) {
    if ((row.source === "treesitter" || row.source === "scip") && !bySource.has(row.source)) {
      bySource.set(row.source, { id: Number(row.id), source: row.source });
    }
  }
  return ["treesitter", "scip"].map((source) => bySource.get(source)).filter(Boolean);
}

/**
 * @param {{
 *   viewDb: Database.Database,
 *   ledgerDb: Database.Database,
 *   layers: Array<{ id: number, source: "treesitter" | "scip" }>,
 *   repoRelPath: string,
 *   contentHash: string,
 *   lang: string,
 * }} args
 * @returns {{ symbols: number, edges: number }}
 */
function materializeLayeredPath({ viewDb, ledgerDb, layers, repoRelPath, contentHash, lang }) {
  viewDb.prepare("DELETE FROM symbols WHERE repo_rel_path = ?").run(repoRelPath);
  const symbolInsert = viewDb.prepare(
    `INSERT INTO symbols
       (content_hash, local_id, kind, name, qualified_name, parent_global_id,
        repo_rel_path, range_start, range_end, range_start_line, range_end_line,
        signature_hash, signature_text, body_identifiers, visibility, doc, lang,
        merged_fingerprint)
     VALUES(?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const edgeInsert = viewDb.prepare(
    `INSERT INTO edges
       (from_global_id, to_global_id, to_name, to_module, to_external_id,
        external_descriptor, source, kind, repo_rel_path,
        range_start, range_end, range_start_line, range_end_line, confidence)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  const canonical = new Map();
  const sourceLocalToKey = new Map();
  for (const layer of layers) {
    const rows = layerSymbols(ledgerDb, layer.id);
    for (const row of rows) {
      const detail = layerJson(row.detail_json);
      const range = layerJson(row.range_json);
      const qualified = stringOrNull(detail?.qualified_name ?? row.container);
      const key = symbolLayerMergeKey(row.kind, qualified || row.name);
      let entry = canonical.get(key);
      if (!entry) {
        entry = {
          local_id: canonical.size,
          kind: row.kind,
          name: row.name,
          qualified_name: qualified,
          repo_rel_path: repoRelPath,
          range_start: numberOr(detail?.range_start, range?.range_start, 0),
          range_end: numberOr(detail?.range_end, range?.range_end, 0),
          range_start_line: nullableNumber(range?.range_start_line),
          range_end_line: nullableNumber(range?.range_end_line),
          signature_hash: stringOrNull(detail?.signature_hash) || shaText(row.signature || row.name),
          signature_text: stringOrNull(detail?.signature_text) || row.signature || null,
          body_identifiers: stringOrNull(detail?.body_identifiers),
          visibility: stringOrNull(detail?.visibility),
          doc: row.doc ?? null,
          lang: row.lang || lang,
          source: layer.source,
        };
        canonical.set(key, entry);
      } else if (layer.source === "scip") {
        entry.name = row.name || entry.name;
        entry.qualified_name = qualified || entry.qualified_name;
        entry.signature_hash = stringOrNull(detail?.signature_hash) || entry.signature_hash;
        entry.signature_text = stringOrNull(detail?.signature_text) || row.signature || entry.signature_text;
        entry.visibility = stringOrNull(detail?.visibility) || entry.visibility;
        entry.doc = row.doc ?? entry.doc;
      }
      sourceLocalToKey.set(`${layer.id}:${row.local_id}`, key);
    }
  }

  const globalByKey = new Map();
  for (const [key, row] of canonical) {
    const fingerprint = mergedFingerprint({
      content_hash: contentHash,
      kind: row.kind,
      name: row.name,
      qualified_name: row.qualified_name,
      signature_hash: row.signature_hash,
      signature_text: row.signature_text,
      source: row.source,
    });
    const info = symbolInsert.run(
      contentHash,
      row.local_id,
      row.kind,
      row.name,
      row.qualified_name,
      row.repo_rel_path,
      row.range_start,
      row.range_end,
      row.range_start_line,
      row.range_end_line,
      row.signature_hash,
      row.signature_text,
      row.body_identifiers,
      row.visibility,
      row.doc,
      row.lang,
      fingerprint,
    );
    globalByKey.set(key, Number(info.lastInsertRowid));
  }

  const seenEdges = new Set();
  let edgeCount = 0;
  for (const layer of layers) {
    for (const row of layerEdges(ledgerDb, layer.id)) {
      const detail = layerJson(row.detail_json);
      const range = layerJson(row.range_json);
      const fromKey = sourceLocalToKey.get(`${layer.id}:${row.from_local_id}`);
      const fromGlobal = fromKey ? globalByKey.get(fromKey) : null;
      if (!fromGlobal) continue;
      const toKey = detail?.to_content_hash === contentHash && detail?.to_local_id != null
        ? sourceLocalToKey.get(`${layer.id}:${detail.to_local_id}`)
        : null;
      const toGlobal = toKey ? globalByKey.get(toKey) : null;
      const toName = stringOrNull(detail?.to_name) || row.to_symbol || "";
      if (!toName) continue;
      const edgeSource = detail?.source === "scip" || layer.source === "scip" ? "scip" : "treesitter";
      const sameBlob = detail?.to_content_hash === contentHash && detail?.to_local_id != null;
      const edgeKey = [
        fromGlobal,
        toGlobal || "",
        sameBlob ? "" : stringOrNull(detail?.to_content_hash),
        sameBlob ? "" : nullableNumber(detail?.to_local_id),
        detail?.to_external_id || "",
        toName,
        row.kind,
        numberOr(range?.range_start, detail?.range_start, 0),
        edgeSource,
      ].join("\0");
      if (seenEdges.has(edgeKey)) continue;
      seenEdges.add(edgeKey);
      edgeInsert.run(
        fromGlobal,
        toGlobal || null,
        toName,
        stringOrNull(detail?.to_module),
        nullableNumber(detail?.to_external_id),
        row.to_symbol && String(row.to_symbol).startsWith("external:") ? row.to_symbol : null,
        edgeSource,
        row.kind,
        repoRelPath,
        numberOr(range?.range_start, detail?.range_start, 0),
        numberOr(range?.range_end, detail?.range_end, 0),
        nullableNumber(range?.range_start_line),
        nullableNumber(range?.range_end_line),
        numberOr(detail?.confidence, null, 50),
      );
      edgeCount++;
    }
  }

  return { symbols: canonical.size, edges: edgeCount };
}

/**
 * @param {Database.Database} ledgerDb
 * @param {number} layerId
 * @returns {any[]}
 */
function layerSymbols(ledgerDb, layerId) {
  return /** @type {any[]} */ (
    ledgerDb.prepare(
      `SELECT layer_id, local_id, lang, kind, name, signature, container, range_json, doc, detail_json
       FROM blob_layer_symbols
       WHERE layer_id = ?
       ORDER BY local_id ASC`,
    ).all(layerId)
  );
}

/**
 * @param {Database.Database} ledgerDb
 * @param {number} layerId
 * @returns {any[]}
 */
function layerEdges(ledgerDb, layerId) {
  return /** @type {any[]} */ (
    ledgerDb.prepare(
      `SELECT layer_id, edge_id, kind, from_local_id, to_local_id, to_symbol, range_json, detail_json
       FROM blob_layer_edges
       WHERE layer_id = ?
       ORDER BY edge_id ASC`,
    ).all(layerId)
  );
}

/**
 * @param {unknown} value
 * @returns {any}
 */
function layerJson(value) {
  if (typeof value !== "string" || !value) return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {string} kind
 * @param {string} name
 */
function symbolLayerMergeKey(kind, name) {
  return `${kind}\0${name}`;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function stringOrNull(value) {
  if (typeof value !== "string") return null;
  return value.length > 0 ? value : null;
}

function nullableNumber(value) {
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

function numberOr(value, fallbackValue, ultimateFallback) {
  const n = Number(value);
  if (Number.isFinite(n)) return n;
  const f = Number(fallbackValue);
  if (Number.isFinite(f)) return f;
  return ultimateFallback;
}

function shaText(text) {
  return crypto.createHash("sha256").update(String(text || "")).digest("hex");
}

/**
 * @param {Record<string, unknown>} value
 */
function mergedFingerprint(value) {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(value, Object.keys(value).sort()))
    .digest("hex");
}
