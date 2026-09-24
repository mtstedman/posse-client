// @ts-check
//
// ATLAS v2 Ledger — SCIP bookkeeping store. Owns `external_symbols` (the
// dedupe-on-write registry of cross-package monikers) and `scip_indexes` (one
// row per ingested SCIP index, with partial/complete status). Extracted from
// the Ledger monolith; the wireframe constructs one (sharing the connection +
// Interner) and delegates. Error messages keep the `Ledger.` prefix so the
// public contract — including thrown-message text — is unchanged.

import { nowIso } from "../../../functions/v2/ledger/normalize.js";
import { SCIP_RECLAIM_ANCHOR_META_KEY } from "../../../functions/v2/ledger/schema.js";

/**
 * @typedef {{ source: "full" | "bootstrap", ids: number[], sessions: string[] }} ScipReclaimAnchor
 * @typedef {{ deleted: number, schemes: string[], anchor: ScipReclaimAnchor | null }} ScipReclaimResult
 */

export class ScipIndexStore {
  /** @type {Record<string, import("better-sqlite3").Statement>} */
  #stmt;
  /** @type {import("./Interner.js").Interner} */
  #interner;
  /** @type {(keepIds: number[], anchorSessions: string[]) => ScipReclaimResult} */
  #pruneFullTxn;
  /** @type {(keepIds: number[], presentSessions: string[]) => ScipReclaimResult} */
  #pruneIncrementalTxn;

  /**
   * @param {import("better-sqlite3").Database} db
   * @param {import("./Interner.js").Interner} interner
   */
  constructor(db, interner) {
    this.#interner = interner;
    this.#stmt = {
      // external_symbols dedupe-on-write. SQLite treats NULL as distinct
      // in UNIQUE, so the schema uses '' (sentinel) for nullable fields;
      // callers must normalize before passing in. SELECT-then-INSERT
      // because ON CONFLICT DO UPDATE ... RETURNING does not return rows
      // unmodified by the conflict in older better-sqlite3 versions.
      externalSymbolSelect: db.prepare(
        `SELECT id FROM external_symbols
         WHERE scheme = ? AND manager = ? AND package_name = ?
           AND package_version = ? AND descriptor = ?`,
      ),
      externalSymbolInsert: db.prepare(
        `INSERT INTO external_symbols
           (scheme, manager, package_name, package_version, descriptor, display_name_id)
         VALUES(?, ?, ?, ?, ?, ?)
         ON CONFLICT(scheme, manager, package_name, package_version, descriptor)
           DO UPDATE SET descriptor = descriptor
         RETURNING id`,
      ),

      // SCIP index bookkeeping.
      scipIndexSelect: db.prepare(
        `SELECT id, status, document_count, documents_failed FROM scip_indexes
         WHERE scheme = ? AND indexer_version = ? AND fileset_hash = ?
            AND config_hash = ? AND deps_hash = ?`,
      ),
      // Pre-decode idempotency probe: raw `.scip` bytes identify a prior
      // ingest without paying decode/hydrate/native-rows. Head matching
      // happens in the caller so it can resolve the current git head LAZILY —
      // only after this query proves a candidate exists at all.
      scipIndexSelectByBytesHash: db.prepare(
        `SELECT id, status, ingested_head FROM scip_indexes
         WHERE scip_bytes_hash = ? AND config_hash = ? AND deps_hash = ?
            AND status = 'complete'
         ORDER BY id DESC
         LIMIT 1`,
      ),
      scipIndexInsert: db.prepare(
        `INSERT INTO scip_indexes
            (scheme, tool_name, indexer_version, indexer_arguments,
             project_root, langs, fileset_hash, config_hash, deps_hash,
             document_count, documents_failed, occurrence_count, external_symbol_count,
             status, produced_at, ingested_at, scip_bytes_hash, ingested_head)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(scheme, indexer_version, fileset_hash, config_hash, deps_hash)
            DO NOTHING
         RETURNING id`,
      ),
      scipIndexUpdate: db.prepare(
        `UPDATE scip_indexes
         SET tool_name = ?,
             indexer_arguments = ?,
             project_root = ?,
             langs = ?,
             document_count = ?,
             documents_failed = ?,
             occurrence_count = ?,
             external_symbol_count = ?,
             status = ?,
             produced_at = ?,
             ingested_at = ?,
             scip_bytes_hash = COALESCE(?, scip_bytes_hash),
             ingested_head = COALESCE(?, ingested_head)
         WHERE id = ?`,
      ),
      scipIndexTouchBytesHash: db.prepare(
        `UPDATE scip_indexes
         SET scip_bytes_hash = ?, ingested_head = ?
         WHERE id = ?`,
      ),
      scipIndexList: db.prepare(
        `SELECT id, scheme, tool_name, indexer_version, indexer_arguments,
                 project_root, langs, fileset_hash, config_hash, deps_hash,
                 document_count, documents_failed, occurrence_count,
                 external_symbol_count, status, produced_at, ingested_at,
                 scip_bytes_hash, ingested_head
         FROM scip_indexes
         ORDER BY ingested_at DESC`,
      ),
      scipIndexSelectKept: db.prepare(
        `SELECT id, scheme, status FROM scip_indexes
         WHERE id IN (SELECT value FROM json_each(?))`,
      ),
      scipIndexAllIds: db.prepare(`SELECT id FROM scip_indexes ORDER BY id`),
      scipReclaimAnchorGet: db.prepare(`SELECT value FROM meta WHERE key = ?`),
      scipReclaimAnchorPut: db.prepare(
        `INSERT INTO meta(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
      ),
      scipIndexDeleteSuperseded: db.prepare(
        `DELETE FROM scip_indexes
         WHERE scheme = ? AND id NOT IN (SELECT value FROM json_each(?))`,
      ),
      // The ledger's only external references: flat `blob_edges` (a foreign
      // key) and every layer edge, whatever its status (`to_symbol` and
      // `detail_json` both carry the id). Views copy ids but never read these
      // rows back, and AUTOINCREMENT ids are never reused.
      externalSymbolDeleteUnreferenced: db.prepare(
        `DELETE FROM external_symbols
         WHERE id NOT IN (
                 SELECT to_external_id FROM blob_edges WHERE to_external_id IS NOT NULL)
           AND id NOT IN (
                 SELECT CAST(json_extract(detail_json, '$.to_external_id') AS INTEGER)
                 FROM blob_layer_edges
                 WHERE json_extract(detail_json, '$.to_external_id') IS NOT NULL)
           AND id NOT IN (
                 SELECT CAST(substr(to_symbol, 10) AS INTEGER)
                 FROM blob_layer_edges WHERE to_symbol LIKE 'external:%')`,
      ),
    };
    this.#pruneFullTxn = db.transaction((
      /** @type {number[]} */ keepIds,
      /** @type {string[]} */ anchorSessions,
    ) => {
      const pruned = this.#pruneCommittedSchemes(keepIds, []);
      if (!pruned) return { deleted: 0, schemes: [], anchor: null };
      // The table a complete full session leaves is the next full session's
      // reusable state: incremental reclaim must never touch it.
      const anchor = this.#writeAnchor("full", anchorSessions);
      return { ...pruned, anchor };
    });
    this.#pruneIncrementalTxn = db.transaction((
      /** @type {number[]} */ keepIds,
      /** @type {string[]} */ presentSessions,
    ) => {
      const anchor = this.#readAnchor();
      // No trustworthy anchor (a ledger no full session has anchored yet):
      // everything present now becomes the anchor and nothing is reclaimed.
      if (!anchor) return { deleted: 0, schemes: [], anchor: this.#writeAnchor("bootstrap", presentSessions) };
      const pruned = this.#pruneCommittedSchemes(keepIds, anchor.ids);
      if (!pruned) return { deleted: 0, schemes: [], anchor: null };
      return { ...pruned, anchor };
    });
  }

  /**
   * @param {{ scheme: string, manager?: string | null, package_name?: string | null, package_version?: string | null, descriptor: string, display_name?: string | null }} input
   * @returns {number}
   */
  upsertExternalSymbol(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("Ledger.upsertExternalSymbol: input is required");
    }
    const scheme = String(input.scheme || "").trim();
    const packageName = String(input.package_name || "").trim();
    const descriptor = String(input.descriptor || "").trim();
    if (!scheme) throw new RangeError("Ledger.upsertExternalSymbol: scheme is required");
    if (!descriptor) {
      throw new RangeError("Ledger.upsertExternalSymbol: descriptor is required");
    }
    const manager = input.manager == null ? "" : String(input.manager);
    const packageVersion = input.package_version == null ? "" : String(input.package_version);
    const displayNameId =
      input.display_name == null ? null : this.#interner.internString(String(input.display_name));

    const existing = /** @type {{ id: number } | undefined} */ (
      this.#stmt.externalSymbolSelect.get(
        scheme,
        manager,
        packageName,
        packageVersion,
        descriptor,
      )
    );
    if (existing) return existing.id;
    const inserted = /** @type {{ id: number } | undefined} */ (
      this.#stmt.externalSymbolInsert.get(
        scheme,
        manager,
        packageName,
        packageVersion,
        descriptor,
        displayNameId,
      )
    );
    if (!inserted) {
      // ON CONFLICT path lost a race; re-select.
      const refetch = /** @type {{ id: number } | undefined} */ (
        this.#stmt.externalSymbolSelect.get(
          scheme,
          manager,
          packageName,
          packageVersion,
          descriptor,
        )
      );
      if (!refetch) {
        throw new Error("Ledger.upsertExternalSymbol: insert produced no row");
      }
      return refetch.id;
    }
    return inserted.id;
  }

  /**
   * @param {{
   *   scheme: string,
   *   tool_name: string,
   *   indexer_version: string,
   *   indexer_arguments?: string[] | string,
   *   project_root?: string,
   *   langs?: string[] | string,
   *   fileset_hash: string,
   *   config_hash?: string | null,
   *   deps_hash?: string | null,
   *   document_count: number,
   *   documents_failed?: number,
   *   occurrence_count: number,
   *   external_symbol_count: number,
   *   status?: "complete" | "partial",
   *   produced_at?: string | null,
   *   return_existing?: boolean,
   *   scip_bytes_hash?: string | null,
   *   ingested_head?: string | null,
   * }} input
   * @returns {number | null}
   */
  recordScipIndex(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("Ledger.recordScipIndex: input is required");
    }
    const scheme = String(input.scheme || "").trim();
    const toolName = String(input.tool_name || "").trim();
    const indexerVersion = String(input.indexer_version || "").trim();
    const projectRoot = String(input.project_root || "");
    const filesetHash = String(input.fileset_hash || "").trim();
    if (!scheme || !toolName || !indexerVersion || !filesetHash) {
      throw new RangeError(
        "Ledger.recordScipIndex: scheme, tool_name, indexer_version, fileset_hash are required",
      );
    }
    const langsValue = Array.isArray(input.langs)
      ? input.langs.join(",")
      : String(input.langs || "");
    const indexerArguments = Array.isArray(input.indexer_arguments)
      ? JSON.stringify(input.indexer_arguments)
      : "[]";
    const configHash = input.config_hash == null ? "" : String(input.config_hash);
    const depsHash = input.deps_hash == null ? "" : String(input.deps_hash);
    const status = input.status === "partial" ? "partial" : "complete";
    const documentsFailed = Math.max(0, Math.floor(Number(input.documents_failed) || 0));
    const documentCount = Math.max(0, Math.floor(Number(input.document_count) || 0));
    const occurrenceCount = Math.max(0, Math.floor(Number(input.occurrence_count) || 0));
    const externalSymbolCount = Math.max(0, Math.floor(Number(input.external_symbol_count) || 0));
    const bytesHash = normalizeHashField(input.scip_bytes_hash);
    const ingestedHead = normalizeHashField(input.ingested_head);

    const existing = /** @type {{ id: number, status?: string } | undefined} */ (
      this.#stmt.scipIndexSelect.get(scheme, indexerVersion, filesetHash, configHash, depsHash)
    );
    if (existing) {
      if (existing.status === "complete" && status === "complete" && !input.return_existing) {
        // Same identity already recorded — still refresh the cheap-skip key so
        // a restage that produced byte-different-but-content-identical output
        // (or a pre-migration row) converges onto the bytes-hash fast path.
        if (bytesHash && ingestedHead) {
          this.#stmt.scipIndexTouchBytesHash.run(bytesHash, ingestedHead, existing.id);
        }
        return null;
      }
      if (existing.status === "complete" && status === "partial") {
        return existing.id;
      }
      this.#stmt.scipIndexUpdate.run(
        toolName,
        indexerArguments,
        projectRoot,
        langsValue,
        documentCount,
        documentsFailed,
        occurrenceCount,
        externalSymbolCount,
        status,
        input.produced_at ?? null,
        nowIso(),
        bytesHash,
        ingestedHead,
        existing.id,
      );
      return existing.id;
    }

    const inserted = /** @type {{ id: number } | undefined} */ (
      this.#stmt.scipIndexInsert.get(
        scheme,
        toolName,
        indexerVersion,
        indexerArguments,
        projectRoot,
        langsValue,
        filesetHash,
        configHash,
        depsHash,
        documentCount,
        documentsFailed,
        occurrenceCount,
        externalSymbolCount,
        status,
        input.produced_at ?? null,
        nowIso(),
        bytesHash,
        ingestedHead,
      )
    );
    return inserted ? inserted.id : null;
  }

  /**
   * Look up the bookkeeping row id for a SCIP index identity without creating
   * it. Used by ingesters so partially failed runs do not mark an index as
   * complete before all document rows land.
   *
   * A row only counts as "already ingested" when its run made progress: a
   * total-failure row (every document failed, e.g. a branch-snapshot read
   * error or a stale .scip whose files all moved) returns null so the next
   * ingest retries instead of being silently masked as done forever.
   *
   * @param {{
   *   scheme: string,
   *   indexer_version: string,
   *   fileset_hash: string,
   *   config_hash?: string | null,
   *   deps_hash?: string | null,
   * }} input
   * @returns {number | null}
   */
  findScipIndexId(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("Ledger.findScipIndexId: input is required");
    }
    const scheme = String(input.scheme || "").trim();
    const indexerVersion = String(input.indexer_version || "").trim();
    const filesetHash = String(input.fileset_hash || "").trim();
    if (!scheme || !indexerVersion || !filesetHash) {
      throw new RangeError(
        "Ledger.findScipIndexId: scheme, indexer_version, fileset_hash are required",
      );
    }
    const configHash = input.config_hash == null ? "" : String(input.config_hash);
    const depsHash = input.deps_hash == null ? "" : String(input.deps_hash);
    const existing = /** @type {{ id: number, status?: string, document_count?: number, documents_failed?: number } | undefined} */ (
      this.#stmt.scipIndexSelect.get(scheme, indexerVersion, filesetHash, configHash, depsHash)
    );
    if (!existing) return null;
    if (String(existing.status || "") !== "complete") {
      const documentCount = Number(existing.document_count) || 0;
      const documentsFailed = Number(existing.documents_failed) || 0;
      if (documentCount > 0 && documentsFailed >= documentCount) return null;
    }
    return existing.id;
  }

  /**
   * Pre-decode idempotency probe: find the newest COMPLETE ingest of
   * byte-identical `.scip` input, without needing scheme/indexer_version
   * (both are implied by the bytes). Partial rows never match — a cheap skip
   * must not mask an ingest that still has work to do. The caller compares
   * `ingested_head` against the current git head; keeping that comparison
   * out of SQL lets the caller skip the git spawn entirely when no candidate
   * row exists (the fresh-DB / restaged-bytes common case).
   *
   * @param {{
   *   scip_bytes_hash: string,
   *   config_hash?: string | null,
   *   deps_hash?: string | null,
   * }} input
   * @returns {{ id: number, ingested_head: string | null } | null}
   */
  findScipIndexByBytesHash(input) {
    if (!input || typeof input !== "object") {
      throw new TypeError("Ledger.findScipIndexByBytesHash: input is required");
    }
    const bytesHash = normalizeHashField(input.scip_bytes_hash);
    if (!bytesHash) return null;
    const configHash = input.config_hash == null ? "" : String(input.config_hash);
    const depsHash = input.deps_hash == null ? "" : String(input.deps_hash);
    const existing = /** @type {{ id: number, ingested_head?: string | null } | undefined} */ (
      this.#stmt.scipIndexSelectByBytesHash.get(bytesHash, configHash, depsHash)
    );
    if (!existing) return null;
    return { id: existing.id, ingested_head: normalizeHashField(existing.ingested_head) };
  }

  /**
   * Best-effort backfill of the cheap-skip key onto an existing row (the
   * legacy fileset-hash skip path, where no recordScipIndex call happens).
   * No-op when either field is missing.
   *
   * @param {number} id
   * @param {{ scip_bytes_hash?: string | null, ingested_head?: string | null }} fields
   */
  updateScipIndexBytesHash(id, fields = {}) {
    const rowId = Number(id);
    if (!Number.isInteger(rowId) || rowId <= 0) return;
    const bytesHash = normalizeHashField(fields.scip_bytes_hash);
    const ingestedHead = normalizeHashField(fields.ingested_head);
    if (!bytesHash || !ingestedHead) return;
    this.#stmt.scipIndexTouchBytesHash.run(bytesHash, ingestedHead, rowId);
  }

  /**
   * Drop the bookkeeping rows a completed full-fileset SCIP staging session
   * superseded, in one transaction. `keepIds` is the session's full committed
   * set; for each scheme among those rows, every other row of that scheme is
   * deleted. A scheme is left untouched when any of its committed rows is
   * `partial`, and the whole prune is a no-op (no anchor) when a committed id
   * no longer exists. Schemes the session did not commit are never touched.
   * The table left behind becomes the reclaim anchor, together with
   * `anchorSessions` (the batch session dirs the session reads).
   *
   * @param {number[]} keepIds
   * @param {{ anchorSessions?: string[] }} [opts]
   * @returns {ScipReclaimResult}
   */
  pruneSupersededScipIndexes(keepIds, { anchorSessions = [] } = {}) {
    return this.#pruneFullTxn(
      normalizeKeepIds(keepIds, "pruneSupersededScipIndexes"),
      normalizeSessionIds(anchorSessions),
    );
  }

  /**
   * Drop the rows earlier incremental SCIP sessions left behind, after a
   * completed incremental session committed `keepIds`, in one transaction.
   * For each scheme among the committed rows (all `complete`), every row that
   * is neither committed now nor named by the reclaim anchor is deleted: only
   * the anchor and the latest incremental set survive, so an incremental-only
   * history stays bounded. Without a readable anchor nothing is deleted and
   * the current table (plus `presentSessions`) becomes a `bootstrap` anchor.
   * A vanished committed id makes the call a no-op with `anchor: null`.
   *
   * @param {number[]} keepIds
   * @param {{ presentSessions?: string[] }} [opts]
   * @returns {ScipReclaimResult}
   */
  pruneIncrementalScipIndexes(keepIds, { presentSessions = [] } = {}) {
    return this.#pruneIncrementalTxn(
      normalizeKeepIds(keepIds, "pruneIncrementalScipIndexes"),
      normalizeSessionIds(presentSessions),
    );
  }

  /**
   * Delete, per committed scheme whose committed rows are all complete, every
   * row outside `keepIds` and `alsoKeep`. Null when a committed id vanished.
   * Runs inside the caller's transaction.
   *
   * @param {number[]} keepIds
   * @param {number[]} alsoKeep
   * @returns {{ deleted: number, schemes: string[] } | null}
   */
  #pruneCommittedSchemes(keepIds, alsoKeep) {
    if (keepIds.length === 0) return { deleted: 0, schemes: [] };
    const kept = /** @type {Array<{ id: number, scheme: string, status: string }>} */ (
      this.#stmt.scipIndexSelectKept.all(JSON.stringify(keepIds))
    );
    // Every committed id must still exist: a vanished row means the set is
    // not the one the session committed, so nothing is provably superseded.
    if (kept.length !== keepIds.length) return null;
    /** @type {Map<string, boolean>} */
    const completeByScheme = new Map();
    for (const row of kept) {
      const scheme = String(row.scheme);
      completeByScheme.set(scheme, (completeByScheme.get(scheme) ?? true) && row.status === "complete");
    }
    const survivorsJson = JSON.stringify([...new Set([...keepIds, ...alsoKeep])]);
    let deleted = 0;
    /** @type {string[]} */
    const schemes = [];
    for (const [scheme, complete] of completeByScheme) {
      if (!complete) continue;
      deleted += this.#stmt.scipIndexDeleteSuperseded.run(scheme, survivorsJson).changes;
      schemes.push(scheme);
    }
    return { deleted, schemes: schemes.sort() };
  }

  /** @returns {ScipReclaimAnchor | null} */
  #readAnchor() {
    const row = /** @type {{ value?: string | null } | undefined} */ (
      this.#stmt.scipReclaimAnchorGet.get(SCIP_RECLAIM_ANCHOR_META_KEY)
    );
    if (!row?.value) return null;
    try {
      const parsed = JSON.parse(String(row.value));
      if (parsed?.source !== "full" && parsed?.source !== "bootstrap") return null;
      if (!Array.isArray(parsed.ids) || !parsed.ids.every((id) => Number.isSafeInteger(id) && id > 0)) return null;
      if (!Array.isArray(parsed.sessions) || !parsed.sessions.every((id) => typeof id === "string" && id)) return null;
      return { source: parsed.source, ids: parsed.ids, sessions: parsed.sessions };
    } catch {
      return null;
    }
  }

  /**
   * @param {"full" | "bootstrap"} source
   * @param {string[]} sessions
   * @returns {ScipReclaimAnchor}
   */
  #writeAnchor(source, sessions) {
    const ids = /** @type {Array<{ id: number }>} */ (this.#stmt.scipIndexAllIds.all()).map((row) => Number(row.id));
    const anchor = { source, ids, sessions };
    this.#stmt.scipReclaimAnchorPut.run(SCIP_RECLAIM_ANCHOR_META_KEY, JSON.stringify(anchor));
    return anchor;
  }

  /**
   * Delete every `external_symbols` row no ledger edge references, in one
   * statement. A row is bound (committed) before the layer write that
   * references it; the native layer write re-checks each id inside its own
   * transaction, so an ingest racing this collection fails that document
   * instead of committing a dangling target.
   *
   * @returns {{ deleted: number }}
   */
  collectUnreferencedExternalSymbols() {
    return { deleted: this.#stmt.externalSymbolDeleteUnreferenced.run().changes };
  }

  /**
   * Snapshot of every ingested SCIP index, newest first.
   *
   * @returns {Array<{
   *   id: number,
   *   scheme: string,
   *   tool_name: string,
   *   indexer_version: string,
   *   indexer_arguments: string[],
   *   project_root: string,
   *   langs: string,
   *   fileset_hash: string,
   *   config_hash: string,
   *   deps_hash: string,
   *   document_count: number,
   *   documents_failed: number,
   *   occurrence_count: number,
   *   external_symbol_count: number,
   *   status: "complete" | "partial",
   *   produced_at: string | null,
   *   ingested_at: string,
   *   scip_bytes_hash: string | null,
   *   ingested_head: string | null,
   * }>}
   */
  listScipIndexes() {
    const rows = /** @type {any[]} */ (this.#stmt.scipIndexList.all());
    return rows.map((r) => {
      /** @type {string[]} */
      let args = [];
      try {
        const parsed = JSON.parse(r.indexer_arguments || "[]");
        if (Array.isArray(parsed)) args = parsed.map((v) => String(v));
      } catch {
        args = [];
      }
      return {
        id: Number(r.id),
        scheme: r.scheme,
        tool_name: r.tool_name,
        indexer_version: r.indexer_version,
        indexer_arguments: args,
        project_root: r.project_root,
        langs: r.langs,
        fileset_hash: r.fileset_hash,
        config_hash: r.config_hash,
        deps_hash: r.deps_hash,
        document_count: Number(r.document_count) || 0,
        documents_failed: Number(r.documents_failed) || 0,
        occurrence_count: Number(r.occurrence_count) || 0,
        external_symbol_count: Number(r.external_symbol_count) || 0,
        status: r.status === "partial" ? "partial" : "complete",
        produced_at: r.produced_at ?? null,
        ingested_at: r.ingested_at,
        scip_bytes_hash: r.scip_bytes_hash ?? null,
        ingested_head: r.ingested_head ?? null,
      };
    });
  }
}

/**
 * Hash-ish text fields (bytes hash, git head) normalize to a trimmed string or
 * null — empty/whitespace values must never participate in cheap-skip matches.
 *
 * @param {unknown} value
 * @returns {string | null}
 */
function normalizeHashField(value) {
  const text = value == null ? "" : String(value).trim();
  return text ? text : null;
}

/**
 * @param {unknown} keepIds
 * @param {string} method
 * @returns {number[]}
 */
function normalizeKeepIds(keepIds, method) {
  if (!Array.isArray(keepIds)) {
    throw new TypeError(`Ledger.${method}: keepIds must be an array`);
  }
  const ids = [...new Set(keepIds.map((value) => Number(value)))];
  if (ids.some((id) => !Number.isSafeInteger(id) || id <= 0)) {
    throw new RangeError(`Ledger.${method}: keepIds must be positive integers`);
  }
  return ids;
}

/**
 * @param {unknown} sessions
 * @returns {string[]}
 */
function normalizeSessionIds(sessions) {
  const list = Array.isArray(sessions) ? sessions : [];
  return [...new Set(list.map((value) => String(value || "")).filter(Boolean))].sort();
}
