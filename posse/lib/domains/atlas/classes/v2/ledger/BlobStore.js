// @ts-check
//
// ATLAS v2 Ledger — content-addressable blob store. Owns the layered parse
// data: `blobs` (one row per content hash), `blob_symbols` / `blob_edges` (the
// canonical merged parse rows), and `blob_layers` / `blob_layer_symbols` /
// `blob_layer_edges` (the A+B per-source layers that can coexist for one
// content_hash without overwriting each other). Extracted from the Ledger
// monolith; the wireframe constructs one (sharing the connection + Interner)
// and delegates. Error messages keep the `Ledger.` prefix so the public
// contract — including thrown-message text — is unchanged.

import { runSqliteWrite } from "../../../../../shared/concurrency/functions/sqlite-gate.js";
import { nowIso } from "../../../functions/v2/ledger/normalize.js";
import { isContentHash } from "../../../functions/v2/hash.js";
import { isCanonicalRepoPath } from "../../../functions/v2/paths.js";
import { ATLAS_PARSER_SPEC_VERSION, ATLAS_PARSER_VERSION } from "../../../functions/v2/parser/version.js";
import { tableColumnSet, tableExists } from "../../../functions/v2/ledger/schema.js";
import { mergeLayerRows } from "../../../functions/v2/ledger/layer-merge.js";

/** @typedef {import("../../../functions/v2/contracts/schemas.js").SymbolRow} SymbolRow */
/** @typedef {import("../../../functions/v2/contracts/schemas.js").EdgeRow} EdgeRow */
/** @typedef {import("../../../functions/v2/contracts/api.js").BlobIngest} BlobIngest */

/**
 * Coerce a SymbolRow/EdgeRow `source` value to a valid storage tag. Unknown
 * or missing values fall back to `'treesitter'` to match the column default
 * and the pre-SCIP writer contract.
 *
 * @param {unknown} source
 * @returns {"treesitter" | "scip"}
 */
function normalizeRowSource(source) {
  return source === "scip" ? "scip" : "treesitter";
}

/**
 * @param {unknown} source
 * @returns {"treesitter" | "scip"}
 */
function normalizeLayerSource(source) {
  return source === "scip" ? "scip" : "treesitter";
}

/**
 * @param {unknown} status
 * @returns {"indexed" | "failed" | "stale"}
 */
function normalizeLayerStatus(status) {
  if (status === "failed" || status === "stale") return status;
  return "indexed";
}

/**
 * @param {Array<{ source?: string | null }> | undefined} symbols
 * @param {Array<{ source?: string | null }> | undefined} edges
 * @returns {"treesitter" | "scip"}
 */
function inferLayerSource(symbols, edges) {
  const rows = [...(symbols || []), ...(edges || [])];
  return rows.some((row) => row?.source === "scip") ? "scip" : "treesitter";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function stableJson(value) {
  return JSON.stringify(value ?? null);
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function parseLayerJson(value) {
  if (typeof value !== "string" || !value) return null;
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

/**
 * @param {{ kind: string, name: string, qualified_name?: string | null }} sym
 * @returns {string}
 */
function symbolMergeKey(sym) {
  return `${String(sym.kind || "")}\0${String(sym.qualified_name || sym.name || "")}`;
}

export class BlobStore {
  /** @type {import("better-sqlite3").Database} */
  #db;
  /** @type {string} */
  #dbPath;
  /** @type {import("./Interner.js").Interner} */
  #interner;
  /** @type {Record<string, import("better-sqlite3").Statement>} */
  #stmt;

  /**
   * @param {import("better-sqlite3").Database} db
   * @param {string} dbPath
   * @param {import("./Interner.js").Interner} interner
   */
  constructor(db, dbPath, interner) {
    this.#db = db;
    this.#dbPath = dbPath;
    this.#interner = interner;
    const blobColumns = tableExists(db, "blobs") ? tableColumnSet(db, "blobs") : new Set();
    const blobSymbolColumns = tableExists(db, "blob_symbols") ? tableColumnSet(db, "blob_symbols") : new Set();
    const hasBlobLayers = tableExists(db, "blob_layers");
    const hasBlobParserVersion = blobColumns.has("parser_version") && blobColumns.has("parser_spec_version");
    const hasBodyIdentifiers = blobSymbolColumns.has("body_identifiers");
    this.#stmt = {
      blobExists: db.prepare("SELECT 1 AS one FROM blobs WHERE content_hash = ? LIMIT 1"),
      blobByHash: db.prepare("SELECT content_hash, lang, byte_size FROM blobs WHERE content_hash = ? LIMIT 1"),
      blobParseState: db.prepare(
        hasBlobParserVersion
          ? `SELECT parser_version, parser_spec_version
             FROM blobs
             WHERE content_hash = ?
             LIMIT 1`
          : "SELECT NULL AS parser_version, NULL AS parser_spec_version WHERE ? IS NOT NULL LIMIT 1",
      ),
      blobSymbolsByHash: db.prepare(
        `SELECT bs.content_hash, bs.local_id,
                ks.value AS kind, ns.value AS name,
                qs.value AS qualified_name, bs.parent_local_id,
                bs.range_start, bs.range_end,
                bs.range_start_line, bs.range_end_line,
                bs.signature_hash, bs.signature_text,
                ${hasBodyIdentifiers ? "bs.body_identifiers" : "NULL AS body_identifiers"},
                bs.visibility, bs.doc, b.lang AS lang
         FROM blob_symbols bs
         JOIN blobs b ON b.content_hash = bs.content_hash
         JOIN interned_strings ks ON ks.id = bs.kind_id
         JOIN interned_strings ns ON ns.id = bs.name_id
         LEFT JOIN interned_strings qs ON qs.id = bs.qualified_name_id
         WHERE bs.content_hash = ?
         ORDER BY bs.local_id ASC`,
      ),
      blobInsert: db.prepare(
        hasBlobParserVersion
          ? `INSERT INTO blobs
               (content_hash, lang, byte_size, first_seen_ts, parser_version, parser_spec_version)
             VALUES(?, ?, ?, ?, ?, ?)
             ON CONFLICT(content_hash) DO UPDATE SET
               lang = excluded.lang,
               byte_size = excluded.byte_size,
               parser_version = excluded.parser_version,
               parser_spec_version = excluded.parser_spec_version`
          : "INSERT INTO blobs(content_hash, lang, byte_size, first_seen_ts) VALUES(?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING",
      ),
      blobInsertIfMissing: db.prepare(
        hasBlobParserVersion
          ? `INSERT INTO blobs
               (content_hash, lang, byte_size, first_seen_ts, parser_version, parser_spec_version)
             VALUES(?, ?, ?, ?, ?, ?)
             ON CONFLICT(content_hash) DO NOTHING`
          : "INSERT INTO blobs(content_hash, lang, byte_size, first_seen_ts) VALUES(?, ?, ?, ?) ON CONFLICT(content_hash) DO NOTHING",
      ),
      symbolInsert: db.prepare(
        hasBodyIdentifiers
          ? `INSERT INTO blob_symbols
               (content_hash, local_id, kind_id, name_id, qualified_name_id, parent_local_id,
                range_start, range_end, range_start_line, range_end_line,
                signature_hash, signature_text, body_identifiers, visibility, doc, source)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
          : `INSERT INTO blob_symbols
               (content_hash, local_id, kind_id, name_id, qualified_name_id, parent_local_id,
                range_start, range_end, range_start_line, range_end_line,
                signature_hash, signature_text, visibility, doc, source)
             VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      edgeInsert: db.prepare(
        `INSERT INTO blob_edges
           (from_content_hash, edge_id, from_local_id, to_content_hash, to_local_id,
            to_external_id, to_name_id, to_module_id, kind_id,
            range_start, range_end, range_start_line, range_end_line,
            confidence, source)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      blobLayerUpsert: db.prepare(
        `INSERT INTO blob_layers
           (content_hash, lang, source, tool_version, parser_spec_version,
            config_hash, deps_hash, fileset_hash, indexed_at, status)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(content_hash, source, tool_version, parser_spec_version, config_hash, deps_hash, fileset_hash)
           DO UPDATE SET
             lang = excluded.lang,
             indexed_at = excluded.indexed_at,
             status = excluded.status
         RETURNING id`,
      ),
      blobLayerMarkStale: db.prepare(
        `UPDATE blob_layers
         SET status = 'stale'
         WHERE content_hash = ?
           AND source = ?
           AND id <> ?
           AND status = 'indexed'`,
      ),
      blobLayerPruneStale: db.prepare(
        `DELETE FROM blob_layers
         WHERE content_hash = ?
           AND source = ?
           AND id <> ?
           AND status = 'stale'`,
      ),
      blobLayerSymbolDelete: db.prepare("DELETE FROM blob_layer_symbols WHERE layer_id = ?"),
      blobLayerEdgeDelete: db.prepare("DELETE FROM blob_layer_edges WHERE layer_id = ?"),
      blobLayerSymbolInsert: db.prepare(
        `INSERT INTO blob_layer_symbols
           (layer_id, local_id, lang, kind, name, signature, container, range_json, doc, detail_json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      blobLayerEdgeInsert: db.prepare(
        `INSERT INTO blob_layer_edges
           (layer_id, edge_id, kind, from_local_id, to_local_id, to_symbol, range_json, detail_json)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?)`,
      ),
      blobLayerListByHash: db.prepare(
        `SELECT id, content_hash, lang, source, tool_version, parser_spec_version,
                config_hash, deps_hash, fileset_hash, indexed_at, status
         FROM blob_layers
         WHERE content_hash = ?
         ORDER BY source ASC, indexed_at ASC, id ASC`,
      ),
      blobLayerSymbolsByLayer: db.prepare(
        `SELECT layer_id, local_id, lang, kind, name, signature, container, range_json, doc, detail_json
         FROM blob_layer_symbols
         WHERE layer_id = ?
         ORDER BY local_id ASC`,
      ),
      blobLayerEdgesByLayer: db.prepare(
        `SELECT layer_id, edge_id, kind, from_local_id, to_local_id, to_symbol, range_json, detail_json
         FROM blob_layer_edges
         WHERE layer_id = ?
         ORDER BY edge_id ASC`,
      ),

      // Reingest: drop parsed rows tied to a blob while keeping the blob row
      // itself. symbol_deltas references blobs(content_hash), so deleting the
      // blob would violate FK constraints in production ledgers.
      reingestDeleteEdges: db.prepare(
        "DELETE FROM blob_edges WHERE from_content_hash = ?",
      ),
      mergeDeleteSourceEdges: db.prepare(
        "DELETE FROM blob_edges WHERE from_content_hash = ? AND source = ?",
      ),
      reingestDeleteSymbols: db.prepare(
        "DELETE FROM blob_symbols WHERE content_hash = ?",
      ),
      reingestClearBlobParseVersion: db.prepare(
        hasBlobParserVersion
          ? "UPDATE blobs SET parser_version = NULL, parser_spec_version = NULL WHERE content_hash = ?"
          : "SELECT 0 WHERE ? IS NOT NULL",
      ),
      currentTreeSitterLayer: db.prepare(
        hasBlobLayers
          ? `SELECT 1 AS one
             FROM blob_layers
             WHERE content_hash = ?
               AND source = 'treesitter'
               AND tool_version = ?
               AND parser_spec_version = ?
               AND status = 'indexed'
             LIMIT 1`
          : "SELECT 1 AS one WHERE 0 AND ? IS NOT NULL AND ? IS NOT NULL AND ? IS NOT NULL",
      ),
    };
  }

  /**
   * Write one parse layer for a content blob. This is the new A/B storage
   * surface: source='treesitter' and source='scip' identities can coexist for
   * the same content_hash without overwriting each other.
   *
   * @param {BlobIngest & {
   *   source?: "treesitter" | "scip",
   *   tool_version?: string,
   *   parser_spec_version?: string,
   *   config_hash?: string,
   *   deps_hash?: string,
   *   fileset_hash?: string,
   *   indexed_at?: string,
   *   status?: "indexed" | "failed" | "stale",
   * }} layer
   * @returns {{ layer_id: number, source: "treesitter" | "scip", symbols: number, edges: number }}
   */
  ingestBlobLayer(layer) {
    if (!layer || typeof layer !== "object") {
      throw new TypeError("Ledger.ingestBlobLayer: layer is required");
    }
    const txn = this.#db.transaction(() => this.#writeBlobLayerRecord(layer));
    return txn();
  }

  /**
   * @param {Parameters<BlobStore["ingestBlobLayer"]>[0]} layer
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<ReturnType<BlobStore["ingestBlobLayer"]>>}
   */
  ingestBlobLayerAsync(layer, opts = {}) {
    return runSqliteWrite(this.#dbPath, () => this.ingestBlobLayer(layer), {
      label: opts.label || "Ledger.ingestBlobLayer",
      waitMs: opts.waitMs,
    });
  }

  /**
   * Idempotent. If the blob already exists, returns without re-inserting.
   *
   * @param {BlobIngest} blob
   * @returns {void}
   */
  ingestBlob(blob) {
    if (!blob || typeof blob !== "object") {
      throw new TypeError("Ledger.ingestBlob: blob is required");
    }
    const { content_hash, lang, byte_size, symbols, edges } = blob;
    if (!isContentHash(content_hash)) {
      throw new RangeError("Ledger.ingestBlob: content_hash must be SHA-256 hex");
    }
    if (!lang || typeof lang !== "string") {
      throw new TypeError("Ledger.ingestBlob: lang is required");
    }
    if (!Number.isInteger(byte_size) || byte_size < 0) {
      throw new RangeError("Ledger.ingestBlob: byte_size must be a non-negative integer");
    }

    if (this.hasCurrentParsedBlob(content_hash)) return;

    const txn = this.#db.transaction(() => {
      this.#stmt.reingestDeleteEdges.run(content_hash);
      this.#stmt.reingestDeleteSymbols.run(content_hash);
      this.#stmt.blobInsert.run(
        content_hash,
        lang,
        byte_size,
        nowIso(),
        ATLAS_PARSER_VERSION,
        ATLAS_PARSER_SPEC_VERSION,
      );
      const seenLocalIds = new Set();
      for (const sym of symbols || []) {
        this.#assertSymbolShape(sym, content_hash);
        if (seenLocalIds.has(sym.local_id)) {
          throw new RangeError(
            `Ledger.ingestBlob: duplicate local_id ${sym.local_id} in blob ${content_hash}`,
          );
        }
        seenLocalIds.add(sym.local_id);
        const kindId = this.#interner.internString(sym.kind);
        const nameId = this.#interner.internString(sym.name);
        const qualifiedNameId =
          sym.qualified_name == null ? null : this.#interner.internString(sym.qualified_name);
        this.#stmt.symbolInsert.run(
          content_hash,
          sym.local_id,
          kindId,
          nameId,
          qualifiedNameId,
          sym.parent_local_id ?? null,
          sym.range_start,
          sym.range_end,
          Number.isInteger(sym.range_start_line) ? sym.range_start_line : null,
          Number.isInteger(sym.range_end_line) ? sym.range_end_line : null,
          sym.signature_hash,
          sym.signature_text ?? null,
          typeof /** @type {any} */ (sym).body_identifiers === "string"
            ? /** @type {any} */ (sym).body_identifiers
            : null,
          sym.visibility ?? null,
          sym.doc ?? null,
          normalizeRowSource(sym.source),
        );
      }
      const seenEdgeIds = new Set();
      for (const edge of edges || []) {
        this.#assertEdgeShape(edge, content_hash);
        if (seenEdgeIds.has(edge.edge_id)) {
          throw new RangeError(
            `Ledger.ingestBlob: duplicate edge_id ${edge.edge_id} in blob ${content_hash}`,
          );
        }
        seenEdgeIds.add(edge.edge_id);
        const kindId = this.#interner.internString(edge.kind);
        const toNameId = this.#interner.internString(edge.to_name);
        const toModuleId = edge.to_module ? this.#interner.internString(edge.to_module) : null;
        this.#stmt.edgeInsert.run(
          content_hash,
          edge.edge_id,
          edge.from_local_id,
          edge.to_content_hash ?? null,
          edge.to_local_id ?? null,
          edge.to_external_id ?? null,
          toNameId,
          toModuleId,
          kindId,
          edge.range_start,
          edge.range_end,
          Number.isInteger(edge.range_start_line) ? edge.range_start_line : null,
          Number.isInteger(edge.range_end_line) ? edge.range_end_line : null,
          edge.confidence,
          normalizeRowSource(edge.source),
        );
      }
      this.#writeBlobLayerRecord({
        content_hash,
        lang,
        byte_size,
        symbols,
        edges,
        source: inferLayerSource(symbols, edges),
      });
    });
    txn();
  }

  /**
   * @param {BlobIngest} blob
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<void>}
   */
  ingestBlobAsync(blob, opts = {}) {
    return runSqliteWrite(this.#dbPath, () => this.ingestBlob(blob), {
      label: opts.label || "Ledger.ingestBlob",
      waitMs: opts.waitMs,
    });
  }

  /**
   * Merge parser rows into an already-known blob without discarding rows from
   * another backend. This is intentionally narrower than `ingestBlob`: it keeps
   * SCIP compiler edges while adding tree-sitter declarations that a SCIP
   * indexer may omit, such as procedural PHP functions.
   *
   * @param {BlobIngest} blob
   * @returns {{ inserted_symbols: number, mapped_symbols: number, inserted_edges: number, skipped_edges: number }}
   */
  mergeBlobParseRows(blob) {
    if (!blob || typeof blob !== "object") {
      throw new TypeError("Ledger.mergeBlobParseRows: blob is required");
    }
    const { content_hash, lang, byte_size, symbols, edges } = blob;
    if (!isContentHash(content_hash)) {
      throw new RangeError("Ledger.mergeBlobParseRows: content_hash must be SHA-256 hex");
    }
    if (!this.hasBlob(content_hash)) {
      this.ingestBlob({ content_hash, lang, byte_size, symbols, edges });
      return {
        inserted_symbols: Array.isArray(symbols) ? symbols.length : 0,
        mapped_symbols: 0,
        inserted_edges: Array.isArray(edges) ? edges.length : 0,
        skipped_edges: 0,
      };
    }

    /** @type {{ inserted_symbols: number, mapped_symbols: number, inserted_edges: number, skipped_edges: number }} */
    const counts = { inserted_symbols: 0, mapped_symbols: 0, inserted_edges: 0, skipped_edges: 0 };
    const txn = this.#db.transaction(() => {
      const layerSource = inferLayerSource(symbols, edges);
      if (layerSource === "scip") {
        this.#stmt.mergeDeleteSourceEdges.run(content_hash, "scip");
      }
      const existingRows = /** @type {Array<{ local_id: number, kind: string, name: string, qualified_name: string | null }>} */ (
        this.#db.prepare(
          `SELECT bs.local_id, ks.value AS kind, ns.value AS name, qs.value AS qualified_name
           FROM blob_symbols bs
           JOIN interned_strings ks ON ks.id = bs.kind_id
           JOIN interned_strings ns ON ns.id = bs.name_id
           LEFT JOIN interned_strings qs ON qs.id = bs.qualified_name_id
           WHERE bs.content_hash = ?
           ORDER BY bs.local_id ASC`,
        ).all(content_hash)
      );
      const existingByKey = new Map();
      let nextLocalId = -1;
      for (const row of existingRows) {
        nextLocalId = Math.max(nextLocalId, Number(row.local_id));
        existingByKey.set(symbolMergeKey(row), Number(row.local_id));
      }
      nextLocalId += 1;
      const edgeMax = /** @type {{ max_edge_id: number | null } | undefined} */ (
        this.#db.prepare("SELECT MAX(edge_id) AS max_edge_id FROM blob_edges WHERE from_content_hash = ?").get(content_hash)
      );
      let nextEdgeId = Number.isInteger(edgeMax?.max_edge_id) ? Number(edgeMax?.max_edge_id) + 1 : 0;

      /** @type {Map<number, number>} */
      const localIdMap = new Map();
      /** @type {Array<{ sym: SymbolRow, newLocalId: number }>} */
      const symbolsToInsert = [];
      for (const sym of symbols || []) {
        this.#assertSymbolShape(sym, content_hash);
        const key = symbolMergeKey(sym);
        const existingLocalId = existingByKey.get(key);
        if (existingLocalId != null) {
          localIdMap.set(sym.local_id, existingLocalId);
          counts.mapped_symbols++;
          continue;
        }
        const newLocalId = nextLocalId++;
        localIdMap.set(sym.local_id, newLocalId);
        existingByKey.set(key, newLocalId);
        symbolsToInsert.push({ sym, newLocalId });
      }

      for (const { sym, newLocalId } of symbolsToInsert) {
        const kindId = this.#interner.internString(sym.kind);
        const nameId = this.#interner.internString(sym.name);
        const qualifiedNameId =
          sym.qualified_name == null ? null : this.#interner.internString(sym.qualified_name);
        const parentLocalId = sym.parent_local_id == null
          ? null
          : (localIdMap.get(sym.parent_local_id) ?? null);
        this.#stmt.symbolInsert.run(
          content_hash,
          newLocalId,
          kindId,
          nameId,
          qualifiedNameId,
          parentLocalId,
          sym.range_start,
          sym.range_end,
          Number.isInteger(sym.range_start_line) ? sym.range_start_line : null,
          Number.isInteger(sym.range_end_line) ? sym.range_end_line : null,
          sym.signature_hash,
          sym.signature_text ?? null,
          typeof /** @type {any} */ (sym).body_identifiers === "string"
            ? /** @type {any} */ (sym).body_identifiers
            : null,
          sym.visibility ?? null,
          sym.doc ?? null,
          normalizeRowSource(sym.source),
        );
        counts.inserted_symbols++;
      }

      for (const edge of edges || []) {
        this.#assertEdgeShape(edge, content_hash);
        const fromLocalId = localIdMap.get(edge.from_local_id);
        if (fromLocalId == null) {
          counts.skipped_edges++;
          continue;
        }
        const toLocalId = edge.to_content_hash === content_hash && edge.to_local_id != null
          ? localIdMap.get(edge.to_local_id)
          : edge.to_local_id;
        if (edge.to_content_hash === content_hash && edge.to_local_id != null && toLocalId == null) {
          counts.skipped_edges++;
          continue;
        }
        const kindId = this.#interner.internString(edge.kind);
        const toNameId = this.#interner.internString(edge.to_name);
        const toModuleId = edge.to_module ? this.#interner.internString(edge.to_module) : null;
        this.#stmt.edgeInsert.run(
          content_hash,
          nextEdgeId++,
          fromLocalId,
          edge.to_content_hash ?? null,
          toLocalId ?? null,
          edge.to_external_id ?? null,
          toNameId,
          toModuleId,
          kindId,
          edge.range_start,
          edge.range_end,
          Number.isInteger(edge.range_start_line) ? edge.range_start_line : null,
          Number.isInteger(edge.range_end_line) ? edge.range_end_line : null,
          edge.confidence,
          normalizeRowSource(edge.source),
        );
        counts.inserted_edges++;
      }
      if (layerSource === "treesitter") {
        this.#writeBlobLayerRecord({
          content_hash,
          lang,
          byte_size,
          symbols,
          edges,
          source: layerSource,
        });
      }
    });
    txn();
    return counts;
  }

  /**
   * @param {BlobIngest} blob
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<{ inserted_symbols: number, mapped_symbols: number, inserted_edges: number, skipped_edges: number }>}
   */
  mergeBlobParseRowsAsync(blob, opts = {}) {
    return runSqliteWrite(this.#dbPath, () => this.mergeBlobParseRows(blob), {
      label: opts.label || "Ledger.mergeBlobParseRows",
      waitMs: opts.waitMs,
    });
  }

  /**
   * @param {string} content_hash
   * @returns {Array<{
   *   id: number,
   *   content_hash: string,
   *   lang: string,
   *   source: "treesitter" | "scip",
   *   tool_version: string,
   *   parser_spec_version: string,
   *   config_hash: string,
   *   deps_hash: string,
   *   fileset_hash: string,
   *   indexed_at: string,
   *   status: "indexed" | "failed" | "stale",
   * }>}
   */
  listBlobLayers(content_hash) {
    if (!isContentHash(content_hash)) return [];
    return /** @type {any[]} */ (this.#stmt.blobLayerListByHash.all(content_hash)).map((row) => ({
      id: Number(row.id),
      content_hash: row.content_hash,
      lang: row.lang,
      source: normalizeLayerSource(row.source),
      tool_version: row.tool_version,
      parser_spec_version: row.parser_spec_version,
      config_hash: row.config_hash || "",
      deps_hash: row.deps_hash || "",
      fileset_hash: row.fileset_hash || "",
      indexed_at: row.indexed_at,
      status: normalizeLayerStatus(row.status),
    }));
  }

  /**
   * @param {number} layerId
   * @returns {{ symbols: any[], edges: any[] }}
   */
  blobLayerRows(layerId) {
    const id = Number(layerId);
    if (!Number.isInteger(id) || id <= 0) return { symbols: [], edges: [] };
    const symbols = /** @type {any[]} */ (this.#stmt.blobLayerSymbolsByLayer.all(id)).map((row) => ({
      ...row,
      range: parseLayerJson(row.range_json),
      detail: parseLayerJson(row.detail_json),
    }));
    const edges = /** @type {any[]} */ (this.#stmt.blobLayerEdgesByLayer.all(id)).map((row) => ({
      ...row,
      range: parseLayerJson(row.range_json),
      detail: parseLayerJson(row.detail_json),
    }));
    return { symbols, edges };
  }

  /**
   * @param {string} content_hash
   * @returns {boolean}
   */
  hasBlob(content_hash) {
    if (!isContentHash(content_hash)) return false;
    return !!this.#stmt.blobExists.get(content_hash);
  }

  /**
   * @param {string} content_hash
   * @returns {boolean}
   */
  hasCurrentParsedBlob(content_hash) {
    if (!isContentHash(content_hash)) return false;
    const row = /** @type {{ parser_version?: string | null, parser_spec_version?: string | null } | undefined} */ (
      this.#stmt.blobParseState.get(content_hash)
    );
    return row?.parser_version === ATLAS_PARSER_VERSION
      && row?.parser_spec_version === ATLAS_PARSER_SPEC_VERSION;
  }

  /**
   * @param {string} content_hash
   * @returns {boolean}
   */
  hasCurrentTreeSitterLayer(content_hash) {
    if (!isContentHash(content_hash)) return false;
    return !!this.#stmt.currentTreeSitterLayer.get(
      content_hash,
      ATLAS_PARSER_VERSION,
      ATLAS_PARSER_SPEC_VERSION,
    );
  }

  /**
   * Return all symbols belonging to a blob. Rows are hydrated to the
   * SymbolRow shape (matching the in-memory parser output). Empty when
   * the blob is unknown.
   *
   * @param {string} content_hash
   * @returns {SymbolRow[]}
   */
  getBlobSymbols(content_hash) {
    if (!content_hash) return [];
    // Layers are the source of truth post-cutover; return the merged A+B set so
    // readers (e.g. blast-radius) see tree-sitter symbols that no longer land in
    // the flat table. Fall back to flat for legacy blobs written pre-cutover.
    const layered = mergeLayerRows(this.#db, content_hash);
    if (layered.symbols.length > 0) {
      return layered.symbols.map((s) => ({
        content_hash: s.content_hash,
        local_id: s.local_id,
        kind: s.kind,
        name: s.name,
        qualified_name: s.qualified_name ?? null,
        parent_local_id: s.parent_local_id ?? null,
        repo_rel_path: "",
        lang: s.lang,
        range_start: s.range_start,
        range_end: s.range_end,
        range_start_line: Number.isInteger(s.range_start_line) ? s.range_start_line : 1,
        range_end_line: Number.isInteger(s.range_end_line) ? s.range_end_line : 1,
        signature_hash: s.signature_hash,
        signature_text: s.signature_text ?? null,
        body_identifiers: s.body_identifiers ?? null,
        visibility: s.visibility ?? null,
        doc: s.doc ?? null,
      }));
    }
    const rows = /** @type {any[]} */ (this.#stmt.blobSymbolsByHash.all(content_hash));
    return rows.map((row) => ({
      content_hash: row.content_hash,
      local_id: row.local_id,
      kind: row.kind,
      name: row.name,
      qualified_name: row.qualified_name ?? null,
      parent_local_id: row.parent_local_id ?? null,
      repo_rel_path: "", // SymbolRow carries this for the caller; the
                        // Ledger blob view is path-agnostic. Callers that
                        // need a path pair this with pathSnapshotAt.
      lang: row.lang,
      range_start: row.range_start,
      range_end: row.range_end,
      range_start_line: Number.isInteger(row.range_start_line) ? row.range_start_line : 1,
      range_end_line: Number.isInteger(row.range_end_line) ? row.range_end_line : 1,
      signature_hash: row.signature_hash,
      signature_text: row.signature_text ?? null,
      body_identifiers: row.body_identifiers ?? null,
      visibility: row.visibility ?? null,
      doc: row.doc ?? null,
    }));
  }

  /**
   * Discard every parsed-symbol / edge row tied to `content_hash`, inside a
   * single transaction. The blob row remains because symbol_deltas points at
   * blobs(content_hash); `ingestBlob` can refill parse rows for a blob whose
   * parsed rows were cleared.
   *
   * Opt-in only — used by `posse atlas-v2 scip reparse` so operators can
   * migrate an existing tree-sitter-only ledger to SCIP, and by the
   * main-merge warmer when staged SCIP must refresh blobs that just landed on
   * the default branch.
   *
   * @param {{ content_hash: string }} input
   * @returns {{ removed_symbols: number, removed_edges: number, removed_blob: number }}
   */
  reingestBlobWithBackend(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("Ledger.reingestBlobWithBackend: input is required");
    }
    const { content_hash } = input;
    if (!isContentHash(content_hash)) {
      throw new RangeError(
        "Ledger.reingestBlobWithBackend: content_hash must be SHA-256 hex",
      );
    }
    /** @type {{ removed_symbols: number, removed_edges: number, removed_blob: number }} */
    const counts = { removed_symbols: 0, removed_edges: 0, removed_blob: 0 };
    const txn = this.#db.transaction(() => {
      const edgesInfo = this.#stmt.reingestDeleteEdges.run(content_hash);
      counts.removed_edges = Number(edgesInfo.changes) || 0;
      const symbolsInfo = this.#stmt.reingestDeleteSymbols.run(content_hash);
      counts.removed_symbols = Number(symbolsInfo.changes) || 0;
      this.#stmt.reingestClearBlobParseVersion.run(content_hash);
    });
    txn();
    return counts;
  }

  /**
   * @param {{ content_hash: string }} input
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<{ removed_symbols: number, removed_edges: number, removed_blob: number }>}
   */
  reingestBlobWithBackendAsync(input, opts = {}) {
    return runSqliteWrite(this.#dbPath, () => this.reingestBlobWithBackend(input), {
      label: opts.label || "Ledger.reingestBlobWithBackend",
      waitMs: opts.waitMs,
    });
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /**
   * @param {BlobIngest & {
   *   source?: "treesitter" | "scip",
   *   tool_version?: string,
   *   parser_spec_version?: string,
   *   config_hash?: string,
   *   deps_hash?: string,
   *   fileset_hash?: string,
   *   indexed_at?: string,
   *   status?: "indexed" | "failed" | "stale",
   * }} layer
   * @returns {{ layer_id: number, source: "treesitter" | "scip", symbols: number, edges: number }}
   */
  #writeBlobLayerRecord(layer) {
    const { content_hash, lang, byte_size, symbols, edges } = layer;
    if (!isContentHash(content_hash)) {
      throw new RangeError("Ledger.ingestBlobLayer: content_hash must be SHA-256 hex");
    }
    if (!lang || typeof lang !== "string") {
      throw new TypeError("Ledger.ingestBlobLayer: lang is required");
    }
    let effectiveByteSize = Number(byte_size);
    if (!Number.isInteger(effectiveByteSize) || effectiveByteSize < 0) {
      const existing = /** @type {{ byte_size?: number } | undefined} */ (
        this.#stmt.blobByHash.get(content_hash)
      );
      effectiveByteSize = Number(existing?.byte_size);
    }
    if (!Number.isInteger(effectiveByteSize) || effectiveByteSize < 0) {
      throw new RangeError("Ledger.ingestBlobLayer: byte_size must be a non-negative integer");
    }
    const source = normalizeLayerSource(layer.source || inferLayerSource(symbols, edges));
    const toolVersion = String(layer.tool_version || (source === "treesitter" ? ATLAS_PARSER_VERSION : "unknown"));
    const parserSpecVersion = String(layer.parser_spec_version || (source === "treesitter" ? ATLAS_PARSER_SPEC_VERSION : "scip"));
    const configHash = layer.config_hash == null ? "" : String(layer.config_hash);
    const depsHash = layer.deps_hash == null ? "" : String(layer.deps_hash);
    const filesetHash = layer.fileset_hash == null ? "" : String(layer.fileset_hash);
    const indexedAt = layer.indexed_at || nowIso();
    const status = normalizeLayerStatus(layer.status);

    this.#stmt.blobInsertIfMissing.run(
      content_hash,
      lang,
      effectiveByteSize,
      nowIso(),
      source === "treesitter" ? ATLAS_PARSER_VERSION : toolVersion,
      parserSpecVersion,
    );

    const row = /** @type {{ id: number } | undefined} */ (this.#stmt.blobLayerUpsert.get(
      content_hash,
      lang,
      source,
      toolVersion,
      parserSpecVersion,
      configHash,
      depsHash,
      filesetHash,
      indexedAt,
      status,
    ));
    const layerId = Number(row?.id);
    if (!Number.isInteger(layerId) || layerId <= 0) {
      throw new Error("Ledger.ingestBlobLayer: failed to resolve layer id");
    }
    if (status === "indexed") {
      this.#stmt.blobLayerMarkStale.run(content_hash, source, layerId);
      this.#stmt.blobLayerPruneStale.run(content_hash, source, layerId);
    }

    this.#stmt.blobLayerEdgeDelete.run(layerId);
    this.#stmt.blobLayerSymbolDelete.run(layerId);

    const seenLocalIds = new Set();
    for (const sym of symbols || []) {
      this.#assertSymbolShape(sym, content_hash);
      if (seenLocalIds.has(sym.local_id)) {
        throw new RangeError(
          `Ledger.ingestBlobLayer: duplicate local_id ${sym.local_id} in layer ${layerId}`,
        );
      }
      seenLocalIds.add(sym.local_id);
      this.#stmt.blobLayerSymbolInsert.run(
        layerId,
        sym.local_id,
        sym.lang || lang,
        sym.kind,
        sym.name,
        sym.signature_text || sym.signature_hash || null,
        sym.qualified_name ?? null,
        stableJson({
          range_start: sym.range_start,
          range_end: sym.range_end,
          range_start_line: Number.isInteger(sym.range_start_line) ? sym.range_start_line : null,
          range_end_line: Number.isInteger(sym.range_end_line) ? sym.range_end_line : null,
        }),
        sym.doc ?? null,
        stableJson({
          content_hash,
          local_id: sym.local_id,
          qualified_name: sym.qualified_name ?? null,
          parent_local_id: sym.parent_local_id ?? null,
          repo_rel_path: sym.repo_rel_path,
          signature_hash: sym.signature_hash,
          signature_text: sym.signature_text ?? null,
          body_identifiers: typeof /** @type {any} */ (sym).body_identifiers === "string"
            ? /** @type {any} */ (sym).body_identifiers
            : null,
          visibility: sym.visibility ?? null,
          source: normalizeRowSource(sym.source || source),
        }),
      );
    }

    const seenEdgeIds = new Set();
    for (const edge of edges || []) {
      this.#assertEdgeShape(edge, content_hash);
      if (seenEdgeIds.has(edge.edge_id)) {
        throw new RangeError(
          `Ledger.ingestBlobLayer: duplicate edge_id ${edge.edge_id} in layer ${layerId}`,
        );
      }
      seenEdgeIds.add(edge.edge_id);
      this.#stmt.blobLayerEdgeInsert.run(
        layerId,
        edge.edge_id,
        edge.kind,
        edge.from_local_id ?? null,
        edge.to_content_hash === content_hash ? edge.to_local_id ?? null : null,
        edge.to_external_id != null ? `external:${edge.to_external_id}` : edge.to_name,
        stableJson({
          range_start: edge.range_start,
          range_end: edge.range_end,
          range_start_line: Number.isInteger(edge.range_start_line) ? edge.range_start_line : null,
          range_end_line: Number.isInteger(edge.range_end_line) ? edge.range_end_line : null,
        }),
        stableJson({
          from_content_hash: edge.from_content_hash,
          from_local_id: edge.from_local_id,
          to_content_hash: edge.to_content_hash ?? null,
          to_local_id: edge.to_local_id ?? null,
          to_external_id: edge.to_external_id ?? null,
          to_name: edge.to_name,
          to_module: edge.to_module ?? null,
          confidence: edge.confidence,
          source: normalizeRowSource(edge.source || source),
        }),
      );
    }

    return {
      layer_id: layerId,
      source,
      symbols: Array.isArray(symbols) ? symbols.length : 0,
      edges: Array.isArray(edges) ? edges.length : 0,
    };
  }

  /**
   * @param {SymbolRow} sym
   * @param {string} expectedHash
   */
  #assertSymbolShape(sym, expectedHash) {
    if (!sym || typeof sym !== "object") {
      throw new TypeError("Ledger.ingestBlob: each symbol must be an object");
    }
    if (sym.content_hash !== expectedHash) {
      throw new RangeError(
        `Ledger.ingestBlob: symbol.content_hash mismatch (expected ${expectedHash}, got ${sym.content_hash})`,
      );
    }
    if (!Number.isInteger(sym.local_id) || sym.local_id < 0) {
      throw new RangeError("Ledger.ingestBlob: symbol.local_id must be a non-negative integer");
    }
    if (!sym.kind || !sym.name) {
      throw new RangeError("Ledger.ingestBlob: symbol.kind and symbol.name are required");
    }
    if (!isCanonicalRepoPath(sym.repo_rel_path)) {
      throw new RangeError(
        `Ledger.ingestBlob: symbol.repo_rel_path must be canonical; got '${sym.repo_rel_path}'`,
      );
    }
    if (!Number.isInteger(sym.range_start) || !Number.isInteger(sym.range_end)) {
      throw new RangeError("Ledger.ingestBlob: symbol range_start/range_end must be integers");
    }
    if (!sym.signature_hash || typeof sym.signature_hash !== "string") {
      throw new RangeError("Ledger.ingestBlob: symbol.signature_hash is required");
    }
    if (sym.source != null && sym.source !== "treesitter" && sym.source !== "scip") {
      throw new RangeError(
        `Ledger.ingestBlob: symbol.source must be 'treesitter' or 'scip'; got '${sym.source}'`,
      );
    }
    if (
      /** @type {any} */ (sym).body_identifiers != null &&
      typeof /** @type {any} */ (sym).body_identifiers !== "string"
    ) {
      throw new RangeError("Ledger.ingestBlob: symbol.body_identifiers must be a string or null");
    }
  }

  /**
   * @param {EdgeRow} edge
   * @param {string} expectedHash
   */
  #assertEdgeShape(edge, expectedHash) {
    if (!edge || typeof edge !== "object") {
      throw new TypeError("Ledger.ingestBlob: each edge must be an object");
    }
    if (edge.from_content_hash !== expectedHash) {
      throw new RangeError(
        `Ledger.ingestBlob: edge.from_content_hash mismatch (expected ${expectedHash}, got ${edge.from_content_hash})`,
      );
    }
    if (!Number.isInteger(edge.edge_id) || edge.edge_id < 0) {
      throw new RangeError("Ledger.ingestBlob: edge.edge_id must be a non-negative integer");
    }
    if (!Number.isInteger(edge.from_local_id)) {
      throw new RangeError("Ledger.ingestBlob: edge.from_local_id is required");
    }
    if (!edge.to_name || typeof edge.to_name !== "string") {
      throw new RangeError("Ledger.ingestBlob: edge.to_name is required");
    }
    if (edge.to_module != null && typeof edge.to_module !== "string") {
      throw new RangeError("Ledger.ingestBlob: edge.to_module must be a string or null/undefined");
    }
    if (!edge.kind) {
      throw new RangeError("Ledger.ingestBlob: edge.kind is required");
    }
    if (
      !Number.isInteger(edge.confidence) ||
      edge.confidence < 0 ||
      edge.confidence > 100
    ) {
      throw new RangeError("Ledger.ingestBlob: edge.confidence must be 0..100");
    }
    if (edge.to_content_hash != null && !isContentHash(edge.to_content_hash)) {
      throw new RangeError("Ledger.ingestBlob: edge.to_content_hash must be SHA-256 hex or null");
    }
    if (edge.to_external_id != null) {
      if (!Number.isInteger(edge.to_external_id) || edge.to_external_id <= 0) {
        throw new RangeError(
          "Ledger.ingestBlob: edge.to_external_id must be a positive integer or null",
        );
      }
      if (edge.to_content_hash != null) {
        throw new RangeError(
          "Ledger.ingestBlob: edge.to_external_id and edge.to_content_hash are mutually exclusive",
        );
      }
    }
    if (edge.source != null && edge.source !== "treesitter" && edge.source !== "scip") {
      throw new RangeError(
        `Ledger.ingestBlob: edge.source must be 'treesitter' or 'scip'; got '${edge.source}'`,
      );
    }
  }
}
