// @ts-check
//
// ATLAS v2 View — read-side materialized projection of the ledger. One
// SQLite file per consumer (worktree, warmed slot, or main warm). Built
// by ViewBuilder; queried by retrieval code.
//
// A view is a CACHE, not authoritative. It can always be rebuilt from
// the ledger. If anything looks wrong, delete the file and rebuild.

import path from "path";
import crypto from "crypto";
import { VIEW_SCHEMA_VERSION } from "../../functions/v2/contracts/index.js";
import { isCanonicalRepoPath } from "../../functions/v2/paths.js";
import { openViewDbReadOnly, openViewDbReadWrite } from "../../functions/v2/view-database.js";
import { runNativeViewRead } from "../../functions/v2/native/view-read.js";
import { invalidateStorageCacheNativeAsync } from "../../functions/v2/native/storage.js";
import { hydrateNativeBlastRadius, hydrateNativeSlice } from "../../functions/v2/view-slice.js";

/** @typedef {import("../../functions/v2/contracts/schemas.js").ViewMeta} ViewMeta */
/** @typedef {import("../../functions/v2/contracts/api.js").View} ViewContract */
/** @typedef {import("../../functions/v2/contracts/api.js").ViewQuery} ViewQuery */
/** @typedef {import("../../functions/v2/contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../../functions/v2/contracts/api.js").ViewEdge} ViewEdge */
/** @typedef {import("../../functions/v2/contracts/api.js").SymbolSearchOptions} SymbolSearchOptions */
/** @typedef {import("../../functions/v2/contracts/api.js").SliceOptions} SliceOptions */

/** @implements {ViewContract} */
export class View {
  /** @type {any} */
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
    this.#db = mode === "readonly" ? openViewDbReadOnly(dbPath) : openViewDbReadWrite(dbPath);
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

  /** @returns {Promise<ViewMeta>} */
  async meta() {
    const response = await runNativeViewRead(this.#dbPath, "meta");
    if (response.result !== "meta" || !response.value) {
      throw new Error("ATLAS view-read returned an invalid meta result");
    }
    return normalizeViewMeta(response.value);
  }

  /**
   * Synchronous meta read against this handle's OWN open connection. For the
   * write lane (ViewBuilder/ParseEngine) which already holds the database
   * open in-process — no native hop, no process involvement. Read-lane
   * consumers use {@link meta} (native-validated, daemon-routed).
   *
   * @returns {ViewMeta}
   */
  metaLocal() {
    const rows = /** @type {Array<{ key: string, value: string | null }>} */ (
      this.#db.prepare("SELECT key, value FROM meta").all()
    );
    /** @type {Record<string, string>} */
    const values = {};
    for (const row of rows) {
      if (row.value != null) values[row.key] = row.value;
    }
    return normalizeViewMeta(values);
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

  /**
   * Close both the in-process connection and any validated Rust worker handle
   * for this view. Writers and cleanup paths must await this before replacing
   * or removing the SQLite file on Windows.
   */
  async closeNative() {
    this.close();
    await invalidateStorageCacheNativeAsync(this.#dbPath);
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

  /**
   * Every query routes through the persistent worker (async); validation of
   * arguments stays synchronous so contract errors throw eagerly.
   *
   * @returns {ViewQuery}
   */
  #buildQueryApi() {
    const read = async (query, params = {}) => (await runNativeViewRead(this.#dbPath, query, params)).value;

    /** @type {ViewQuery} */
    const api = {
      stats: () => read("stats"),
      edgeStats: () => read("edge_stats"),
      symbolMetrics: () => read("symbol_metrics"),
      edgeTaxonomyInput: () => read("edge_taxonomy_input"),

      findSymbol: (name, opts = {}) => {
        if (opts.pathPrefix) {
          assertPathPrefix("findSymbol", opts.pathPrefix);
        }
        return read("find_symbol", {
          name: String(name),
          options: {
            ...(positiveInteger(opts.limit) != null ? { limit: positiveInteger(opts.limit) } : {}),
            kinds: Array.isArray(opts.kinds) ? opts.kinds : [],
            langs: Array.isArray(opts.langs) ? opts.langs : [],
            ...(opts.pathPrefix ? { path_prefix: opts.pathPrefix } : {}),
            ...(opts.fuzzy != null ? { fuzzy: opts.fuzzy } : {}),
            ...(opts.scope ? { scope: opts.scope } : {}),
          },
        });
      },

      getSymbol: (global_id) => read("get_symbol", { global_id }),

      symbolsInFile: (repo_rel_path) => {
        if (!isCanonicalRepoPath(repo_rel_path)) {
          throw new RangeError(`symbolsInFile: invalid path '${repo_rel_path}'`);
        }
        return read("symbols_in_file", { repo_rel_path });
      },

      callers: (global_id) => read("callers", { global_id }),

      callees: (global_id) => read("callees", { global_id }),

      unresolvedReferencesTo: (name) => read("unresolved_references_to", { name: String(name) }),

      slice: async (seedGlobalIds, opts = {}) => {
        const result = await read("slice", sliceParams(seedGlobalIds, opts));
        return hydrateNativeSlice(result).symbols;
      },

      sliceWithMetadata: async (seedGlobalIds, opts = {}) => {
        const result = await read("slice", sliceParams(seedGlobalIds, opts));
        return hydrateNativeSlice(result);
      },

      blastRadius: async (paths) => hydrateNativeBlastRadius(await read("blast_radius", { paths })),

      getByContentLocal: (content_hash, local_id) => read("get_by_content_local", {
        content_hash,
        local_id,
      }),

      hasContentHash: async (content_hash) => {
        if (typeof content_hash !== "string" || content_hash.length === 0) return false;
        return (await read("has_content_hash", { content_hash })) === true;
      },

      contentHashForPath: (repo_rel_path) => {
        if (!isCanonicalRepoPath(repo_rel_path)) {
          throw new RangeError(`contentHashForPath: invalid path '${repo_rel_path}'`);
        }
        return read("content_hash_for_path", { repo_rel_path });
      },

      hasSnapshotContentHash: async (content_hash) => {
        if (typeof content_hash !== "string" || content_hash.length === 0) return false;
        return (await read("has_snapshot_content_hash", { content_hash })) === true;
      },

      indexedPaths: (opts = {}) => {
        if (opts.pathPrefix) assertPathPrefix("indexedPaths", opts.pathPrefix);
        return read("indexed_paths", {
          ...(opts.pathPrefix ? { path_prefix: opts.pathPrefix } : {}),
          ...(positiveInteger(opts.limit) != null ? { limit: positiveInteger(opts.limit) } : {}),
        });
      },

      allSymbols: (opts = {}) => {
        if (opts.pathPrefix) {
          assertPathPrefix("allSymbols", opts.pathPrefix);
        }
        return read("all_symbols", {
          options: {
            ...(positiveInteger(opts.limit) != null ? { limit: positiveInteger(opts.limit) } : {}),
            ...(opts.pathPrefix ? { path_prefix: opts.pathPrefix } : {}),
          },
        });
      },
    };
    return Object.freeze(api);
  }
}

function assertPathPrefix(operation, value) {
  if (isCanonicalRepoPath(value)) return;
  throw new RangeError(`${operation}: invalid pathPrefix '${value}'`);
}

function sliceParams(seedGlobalIds, opts) {
  return {
    seed_global_ids: Array.isArray(seedGlobalIds) ? seedGlobalIds : [],
    options: {
      ...(positiveInteger(opts.depth) != null ? { depth: positiveInteger(opts.depth) } : {}),
      edge_kinds: Array.isArray(opts.edgeKinds) ? opts.edgeKinds : [],
      ...(positiveInteger(opts.maxSymbols) != null ? { max_symbols: positiveInteger(opts.maxSymbols) } : {}),
      ...(opts.minConfidence != null ? { min_confidence: opts.minConfidence } : {}),
    },
  };
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.floor(value)
    : null;
}

/** @param {string | undefined} value */
function optionalIntegerMeta(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isInteger(n) ? n : null;
}

/**
 * Normalize metadata from either SQLite text rows or the typed native payload.
 * A view is disposable cache state, so malformed identity/watermark fields
 * fail loudly and let the caller rebuild instead of serving a poisoned view.
 *
 * @param {Record<string, any>} values
 * @returns {ViewMeta}
 */
export function normalizeViewMeta(values) {
  const schemaVersion = values?.schema_version == null || values.schema_version === ""
    ? Number.NaN
    : Number(values.schema_version);
  if (schemaVersion !== VIEW_SCHEMA_VERSION) {
    throw new Error(
      `ATLAS view schema version mismatch (db=${values?.schema_version ?? "missing"}, code=${VIEW_SCHEMA_VERSION})`,
    );
  }
  if (typeof values.branch !== "string" || !values.branch.trim()) {
    throw new Error("ATLAS view meta is missing branch");
  }
  const ledgerSeq = values.ledger_seq == null || values.ledger_seq === ""
    ? Number.NaN
    : Number(values.ledger_seq);
  if (!Number.isInteger(ledgerSeq) || ledgerSeq < 0) {
    throw new Error("ATLAS view meta has an invalid ledger_seq");
  }

  let warmedForFiles = values.warmed_for_files ?? null;
  if (typeof warmedForFiles === "string") {
    try {
      warmedForFiles = JSON.parse(warmedForFiles);
    } catch {
      throw new Error("ATLAS view meta has invalid warmed_for_files JSON");
    }
  }
  if (warmedForFiles != null && !Array.isArray(warmedForFiles)) {
    throw new Error("ATLAS view meta has invalid warmed_for_files JSON");
  }

  return /** @type {ViewMeta} */ ({
    schema_version: schemaVersion,
    branch: values.branch,
    parent_branch: values.parent_branch ?? null,
    parent_seq: optionalIntegerMeta(values.parent_seq),
    ledger_seq: ledgerSeq,
    built_at: typeof values.built_at === "string" ? values.built_at : "",
    warmed_for_files: warmedForFiles,
    prefetched_symbols: optionalIntegerMeta(values.prefetched_symbols),
    prefetched_edges: optionalIntegerMeta(values.prefetched_edges),
    repo_root: values.repo_root ?? null,
    layer_merge: values.layer_merge === true
      || values.layer_merge === 1
      || values.layer_merge === "on"
      || values.layer_merge === "true"
      || values.layer_merge === "1",
  });
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
 * @returns {Array<{ id: number, source: "treesitter" | "scip", metadata: Record<string, any> }>}
 */
function latestLayersForContentHash(ledgerDb, contentHash, lang) {
  const metadataSelect = tableHasColumn(ledgerDb, "blob_layers", "metadata_json")
    ? "metadata_json"
    : "NULL AS metadata_json";
  const rows = /** @type {Array<{ id: number, source: string, metadata_json?: string | null }>} */ (
    ledgerDb.prepare(
      `SELECT id, source, ${metadataSelect}
       FROM blob_layers
       WHERE content_hash = ? AND lang = ? AND status = 'indexed'
       ORDER BY indexed_at DESC, id DESC`,
    ).all(contentHash, lang)
  );
  const bySource = new Map();
  for (const row of rows) {
    if ((row.source === "treesitter" || row.source === "scip") && !bySource.has(row.source)) {
      bySource.set(row.source, {
        id: Number(row.id),
        source: row.source,
        metadata: layerJson(row.metadata_json),
      });
    }
  }
  return ["treesitter", "scip"].map((source) => bySource.get(source)).filter(Boolean);
}

/**
 * @param {{
 *   viewDb: Database.Database,
 *   ledgerDb: Database.Database,
 *   layers: Array<{ id: number, source: "treesitter" | "scip", metadata: Record<string, any> }>,
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

  const scipCallProofFull = layers.some((layer) => layer.source === "scip" && callProofCoverage(layer) === "full");
  const edgeRowsByKey = new Map();
  for (const layer of layers) {
    for (const row of layerEdges(ledgerDb, layer.id)) {
      if (scipCallProofFull && layer.source === "treesitter" && row.kind === "calls") continue;
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
      const edgeRow = {
        fromGlobal,
        toGlobal: toGlobal || null,
        toName,
        toModule: stringOrNull(detail?.to_module),
        toExternalId: nullableNumber(detail?.to_external_id),
        externalDescriptor: row.to_symbol && String(row.to_symbol).startsWith("external:") ? row.to_symbol : null,
        edgeSource,
        kind: row.kind,
        repoRelPath,
        rangeStart: numberOr(range?.range_start, detail?.range_start, 0),
        rangeEnd: numberOr(range?.range_end, detail?.range_end, 0),
        rangeStartLine: nullableNumber(range?.range_start_line),
        rangeEndLine: nullableNumber(range?.range_end_line),
        confidence: numberOr(detail?.confidence, null, 50),
        toContentHash: sameBlob ? contentHash : stringOrNull(detail?.to_content_hash),
        toLocalId: nullableNumber(detail?.to_local_id),
      };
      const edgeKey = materializedEdgeDedupKey(edgeRow);
      const existing = edgeRowsByKey.get(edgeKey);
      if (existing) {
        if (edgeRow.kind === "calls" && confidenceScore(edgeRow.confidence) > confidenceScore(existing.confidence)) {
          edgeRowsByKey.set(edgeKey, edgeRow);
        }
        continue;
      }
      edgeRowsByKey.set(edgeKey, edgeRow);
    }
  }

  for (const edgeRow of edgeRowsByKey.values()) {
    edgeInsert.run(
      edgeRow.fromGlobal,
      edgeRow.toGlobal,
      edgeRow.toName,
      edgeRow.toModule,
      edgeRow.toExternalId,
      edgeRow.externalDescriptor,
      edgeRow.edgeSource,
      edgeRow.kind,
      edgeRow.repoRelPath,
      edgeRow.rangeStart,
      edgeRow.rangeEnd,
      edgeRow.rangeStartLine,
      edgeRow.rangeEndLine,
      edgeRow.confidence,
    );
  }

  return { symbols: canonical.size, edges: edgeRowsByKey.size };
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

function objectOrEmpty(value) {
  if (typeof value === "string") return layerJson(value);
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

/**
 * @param {Database.Database} db
 * @param {string} table
 * @param {string} column
 */
function tableHasColumn(db, table, column) {
  try {
    const cols = /** @type {Array<{ name: string }>} */ (db.prepare(`PRAGMA table_info(${table})`).all());
    return cols.some((col) => col.name === column);
  } catch {
    return false;
  }
}

function callProofCoverage(layer) {
  const metadata = objectOrEmpty(layer?.metadata);
  const raw = metadata.call_proof_coverage
    ?? metadata.callProofCoverage
    ?? objectOrEmpty(metadata.call_proof).coverage
    ?? objectOrEmpty(metadata.callProof).coverage;
  const value = String(raw || "").toLowerCase();
  return value === "full" || value === "partial" || value === "none" ? value : "none";
}

function confidenceScore(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : -1;
}

function materializedEdgeDedupKey(edge) {
  if (edge.kind === "calls") {
    return [
      "calls",
      edge.fromGlobal,
      edge.toGlobal || "",
      edge.toContentHash || "",
      edge.toLocalId ?? "",
      edge.toExternalId ?? "",
      edge.toName,
      edge.toModule || "",
      edge.rangeStart,
    ].join("\0");
  }
  return [
    edge.fromGlobal,
    edge.toGlobal || "",
    edge.toContentHash || "",
    edge.toLocalId ?? "",
    edge.toExternalId ?? "",
    edge.toName,
    edge.kind,
    edge.rangeStart,
    edge.edgeSource,
  ].join("\0");
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
