// @ts-check
//
// ATLAS v2 Ledger — SCIP bookkeeping store. Owns `external_symbols` (the
// dedupe-on-write registry of cross-package monikers) and `scip_indexes` (one
// row per ingested SCIP index, with partial/complete status). Extracted from
// the Ledger monolith; the wireframe constructs one (sharing the connection +
// Interner) and delegates. Error messages keep the `Ledger.` prefix so the
// public contract — including thrown-message text — is unchanged.

import { nowIso } from "../../../functions/v2/ledger/normalize.js";

export class ScipIndexStore {
  /** @type {Record<string, import("better-sqlite3").Statement>} */
  #stmt;
  /** @type {import("./Interner.js").Interner} */
  #interner;

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
        `SELECT id, status FROM scip_indexes
         WHERE scheme = ? AND indexer_version = ? AND fileset_hash = ?
            AND config_hash = ? AND deps_hash = ?`,
      ),
      scipIndexInsert: db.prepare(
        `INSERT INTO scip_indexes
            (scheme, tool_name, indexer_version, indexer_arguments,
             project_root, langs, fileset_hash, config_hash, deps_hash,
             document_count, documents_failed, occurrence_count, external_symbol_count,
             status, produced_at, ingested_at)
         VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
             ingested_at = ?
         WHERE id = ?`,
      ),
      scipIndexList: db.prepare(
        `SELECT id, scheme, tool_name, indexer_version, indexer_arguments,
                 project_root, langs, fileset_hash, config_hash, deps_hash,
                 document_count, documents_failed, occurrence_count,
                 external_symbol_count, status, produced_at, ingested_at
         FROM scip_indexes
         ORDER BY ingested_at DESC`,
      ),
    };
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

    const existing = /** @type {{ id: number, status?: string } | undefined} */ (
      this.#stmt.scipIndexSelect.get(scheme, indexerVersion, filesetHash, configHash, depsHash)
    );
    if (existing) {
      if (existing.status === "complete" && status === "complete" && !input.return_existing) {
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
      )
    );
    return inserted ? inserted.id : null;
  }

  /**
   * Look up the bookkeeping row id for a SCIP index identity without creating
   * it. Used by ingesters so partially failed runs do not mark an index as
   * complete before all document rows land.
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
    const existing = /** @type {{ id: number, status?: string } | undefined} */ (
      this.#stmt.scipIndexSelect.get(scheme, indexerVersion, filesetHash, configHash, depsHash)
    );
    return existing ? existing.id : null;
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
      };
    });
  }
}
