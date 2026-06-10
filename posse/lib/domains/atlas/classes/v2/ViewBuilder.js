// @ts-check
//
// ATLAS v2 ViewBuilder — produces and updates view files from the ledger.
// Implements the `ViewBuilder` contract.
//
// Three public operations:
//   * buildFrom         — assemble a fresh view from ledger at (branch, atSeq).
//   * incrementalApply  — apply new ledger entries to a live view.
//   * cloneView         — filesystem copy for the fork-from-main fast path.
//
// Internally the builder works in three passes when materializing
// symbols + edges:
//   1. Insert symbols with parent_global_id=NULL, tracking
//      (repo_rel_path, local_id) -> global_id.
//   2. UPDATE parent_global_id for symbols with parent_local_id.
//   3. Insert edges, resolving from_/to_global_id via the map and
//      leaving cross-path or cross-blob targets unresolved when they
//      cannot be bound.

import fs from "fs";
import path from "path";
import Database from "better-sqlite3";
import { View } from "./View.js";
import { VIEW_SCHEMA_VERSION } from "../../functions/v2/contracts/index.js";
import { isCanonicalRepoPath } from "../../functions/v2/paths.js";
import { resolveEdges } from "../../functions/v2/resolver/index.js";
import { graphDerivedInputSignature, refreshGraphDerivedState } from "../../functions/v2/graph-derived.js";
import { refreshTreeDerivedState, treeDerivedInputSignature } from "../../functions/v2/tree-derived.js";
import { refreshTreeCompressionSnapshot, treeCompressionInputSignature } from "../../functions/v2/tree-compression.js";
import { runSqliteWrite } from "../../../../shared/concurrency/functions/sqlite-gate.js";
import { normalizeLangFromScip } from "../../functions/v2/scip/to-rows.js";
import { mergeLayerRows } from "../../functions/v2/ledger/layer-merge.js";

/** @typedef {import("../../functions/v2/contracts/schemas.js").ViewMeta} ViewMeta */
/** @typedef {import("../../functions/v2/contracts/schemas.js").LedgerEntry} LedgerEntry */
/** @typedef {import("../../functions/v2/contracts/api.js").ViewBuilder} ViewBuilderContract */
/** @typedef {import("../../functions/v2/contracts/api.js").BuildOptions} BuildOptions */
/** @typedef {import("../../functions/v2/contracts/api.js").BuildHint} BuildHint */
/** @typedef {import("./Ledger.js").Ledger} Ledger */

const GRAPH_DERIVED_SIGNATURE_META_KEY = "graph_derived_input_signature";
const TREE_DERIVED_SIGNATURE_META_KEY = "tree_derived_input_signature";
const TREE_COMPRESSION_SIGNATURE_META_KEY = "tree_compression_input_signature";

/** @implements {ViewBuilderContract} */
export class ViewBuilder {
  /**
   * @param {{
   *   ledger: Ledger,
   *   branch: string,
   *   atSeq: number,
   *   outPath: string,
   *   options?: BuildOptions,
   *   onProgress?: ((event: { phase: string, current: number, total: number }) => void) | null,
   * }} args
   * @returns {ViewMeta}
   */
  buildFrom({ ledger, branch, atSeq, outPath, options = {}, onProgress = null }) {
    if (!ledger) throw new TypeError("ViewBuilder.buildFrom: ledger is required");
    if (!branch) throw new TypeError("ViewBuilder.buildFrom: branch is required");
    if (!Number.isInteger(atSeq) || atSeq < 0) {
      throw new RangeError("ViewBuilder.buildFrom: atSeq must be a non-negative integer");
    }
    if (!outPath) throw new TypeError("ViewBuilder.buildFrom: outPath is required");
    if (fs.existsSync(outPath)) {
      throw new Error(`ViewBuilder.buildFrom: outPath already exists: ${outPath}`);
    }

    const branchRec = ledger.getBranch(branch);
    if (!branchRec) {
      throw new Error(`ViewBuilder.buildFrom: unknown branch '${branch}'`);
    }
    const headSeq = ledger.headSeq(branch);
    if (atSeq > headSeq) {
      throw new RangeError(
        `ViewBuilder.buildFrom: atSeq ${atSeq} exceeds branch head ${headSeq}`,
      );
    }

    const lineage = buildLineage(ledger, branch, atSeq);
    const pathToBlob = assemblePathToBlob(ledger, lineage);

    const view = View.mount({ dbPath: outPath, mode: "readwrite" });
    try {
      const db = view._unsafeDb();
      /** @type {string[] | null} */
      let warmedFor = options.warmedForFiles ?? null;
      /** @type {number | null} */
      let prefetchedSymbols = null;
      /** @type {number | null} */
      let prefetchedEdges = null;
      const hint = options.hint;
      const hasHint = !!hint && Array.isArray(hint.paths) && hint.paths.length > 0;
      const progress = typeof onProgress === "function" ? onProgress : null;
      const emitPhase = (phase, current, total) => {
        if (!progress) return;
        const event = phase && typeof phase === "object"
          ? phase
          : { phase, current, total };
        try { progress(event); } catch { /* observational */ }
      };
      // Build in per-phase transactions rather than one giant all-or-nothing
      // transaction. Each phase commits on its own, so a crash mid-build leaves
      // the view WITHOUT its meta marker (writeMeta is strictly last) — consumers
      // treat a meta-less view as absent and rebuild from the ledger (the
      // untouched source of truth), so there's no partial-state corruption.
      // Smaller transactions also keep lock windows short and let the symbol/
      // edge passes report progress between chunks. db.transaction() can't nest,
      // so each phase wraps its own work; populateSymbolsAndEdges chunks
      // internally (its own per-batch transactions).
      db.transaction(() => populatePathToBlob(db, pathToBlob))();
      populateSymbolsAndEdges(db, ledger._unsafeDb(), pathToBlob, options.layerMerge === true, {
        onProgress: emitPhase,
      });
      db.transaction(() => {
        refreshGraphDerivedStateIfChanged(db, { force: true });
        refreshTreeDerivedStateIfChanged(db, { force: true });
        refreshTreeCompressionSnapshotIfChanged(db, {
          force: true,
          mode: options.treeCompressionMode,
          maxSeeds: options.treeCompressionMaxSeeds,
        });
      })();
      if (hasHint) {
        db.transaction(() => {
          const stats = runPrefetch(db, hint);
          prefetchedSymbols = stats.symbols;
          prefetchedEdges = stats.edges;
          if (!warmedFor) warmedFor = hint.paths.filter(isCanonicalRepoPath).slice();
        })();
      }
      // Final phase — the meta row is the "view is valid" commit marker. Written
      // last and on its own so a partial build never looks complete.
      db.transaction(() => {
        writeMeta(db, {
          schema_version: VIEW_SCHEMA_VERSION,
          branch,
          parent_branch: branchRec.parent_branch ?? null,
          parent_seq: branchRec.parent_seq ?? null,
          ledger_seq: atSeq,
          built_at: new Date().toISOString(),
          warmed_for_files: warmedFor,
          prefetched_symbols: prefetchedSymbols,
          prefetched_edges: prefetchedEdges,
          repo_root: options.repoRoot ?? null,
        });
      })();
      emitPhase("done", 1, 1);
      return view.meta();
    } finally {
      view.close();
    }
  }

  /**
   * @param {{
   *   ledger: Ledger,
   *   branch: string,
   *   atSeq: number,
   *   outPath: string,
   *   options?: BuildOptions,
   *   onProgress?: ((event: { phase: string, current: number, total: number }) => void) | null,
   * }} args
   * @param {{ waitMs?: number, label?: string, onProgress?: ((event: { phase: string, current: number, total: number }) => void) | null }} [opts]
   * @returns {Promise<ViewMeta>}
   */
  buildFromAsync(args, opts = {}) {
    const onProgress = typeof opts.onProgress === "function"
      ? opts.onProgress
      : (typeof args?.onProgress === "function" ? args.onProgress : null);
    return runSqliteWrite(args?.outPath, () => this.buildFrom({ ...args, onProgress }), {
      label: opts.label || "ViewBuilder.buildFrom",
      waitMs: opts.waitMs,
    });
  }

  /**
   * @param {{
   *   view: View,
   *   ledger: Ledger,
   *   entries: LedgerEntry[],
   *   options?: BuildOptions,
   *   onProgress?: ((e: { phase: string, current: number, total: number }) => void) | null,
   * }} args
   * @returns {ViewMeta}
   */
  incrementalApply({ view, ledger, entries, options = {}, onProgress = null }) {
    if (!view) throw new TypeError("ViewBuilder.incrementalApply: view is required");
    if (view._mode() !== "readwrite") {
      throw new Error("ViewBuilder.incrementalApply: view must be opened readwrite");
    }
    if (!ledger) throw new TypeError("ViewBuilder.incrementalApply: ledger is required");
    if (!Array.isArray(entries)) {
      throw new TypeError("ViewBuilder.incrementalApply: entries must be an array");
    }
    const progress = typeof onProgress === "function" ? onProgress : null;
    const emitPhase = (phase, current, total) => {
      if (!progress) return;
      try { progress({ phase, current, total }); } catch { /* observational */ }
    };
    const current = view.meta();
    if (entries.length === 0) return current;
    // All entries must be on this view's branch, strictly increasing seq,
    // and strictly greater than current.ledger_seq.
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i];
      if (e.branch !== current.branch) {
        throw new RangeError(
          `incrementalApply: entry ${i} branch '${e.branch}' does not match view branch '${current.branch}'`,
        );
      }
      if (e.seq <= current.ledger_seq) {
        throw new RangeError(
          `incrementalApply: entry ${i} seq ${e.seq} not greater than current ledger_seq ${current.ledger_seq}`,
        );
      }
      if (i > 0 && e.seq <= entries[i - 1].seq) {
        throw new RangeError(
          `incrementalApply: entries not strictly increasing at index ${i}`,
        );
      }
    }

    const db = view._unsafeDb();
    /** @type {ViewMeta} */
    let updated;
    const txn = db.transaction(() => {
      const ledgerDb = ledger._unsafeDb();
      // Track the last successfully-applied seq. If an entry skips (missing
      // blob in the ledger), ledger_seq must NOT advance past it — otherwise
      // queries would see stale symbols at the new claimed seq.
      let lastAppliedSeq = current.ledger_seq;
      let applied = 0;
      emitPhase("entries", 0, entries.length);
      for (const e of entries) {
        const outcome = applyEntry(db, ledgerDb, e);
        if (outcome && outcome.skipped) break;
        lastAppliedSeq = e.seq;
        applied++;
        if (applied === entries.length || applied % VIEW_BUILD_CHUNK === 0) {
          emitPhase("entries", applied, entries.length);
        }
      }
      // New symbols may now satisfy references that were previously
      // unresolved (e.g. a fresh class makes earlier `new Foo()` edges
      // bindable). Re-run the resolver over current state.
      const pathToBlob = readPathToBlobMap(db);
      emitPhase("resolve", 0, 1);
      runResolverPass(db, pathToBlob);
      refreshGraphDerivedStateIfChanged(db);
      refreshTreeDerivedStateIfChanged(db);
      refreshTreeCompressionSnapshotIfChanged(db, {
        mode: options.treeCompressionMode,
        maxSeeds: options.treeCompressionMaxSeeds,
      });
      emitPhase("resolve", 1, 1);
      writeMeta(db, {
        ...current,
        ledger_seq: lastAppliedSeq,
        built_at: new Date().toISOString(),
      });
    });
    txn();
    emitPhase("done", 1, 1);
    updated = view.meta();
    return updated;
  }

  /**
   * @param {{
   *   view: View,
   *   ledger: Ledger,
   *   entries: LedgerEntry[],
   *   options?: BuildOptions,
   * }} args
   * @param {{ waitMs?: number, label?: string, onProgress?: ((event: { phase: string, current: number, total: number }) => void) | null }} [opts]
   * @returns {Promise<ViewMeta>}
   */
  incrementalApplyAsync(args, opts = {}) {
    const viewPath = args?.view && typeof args.view._dbPath === "function"
      ? args.view._dbPath()
      : "view";
    const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
    return runSqliteWrite(viewPath, () => this.incrementalApply({ ...args, onProgress }), {
      label: opts.label || "ViewBuilder.incrementalApply",
      waitMs: opts.waitMs,
    });
  }

  /**
   * @param {{ sourcePath: string, destPath: string }} args
   * @returns {void}
   */
  cloneView({ sourcePath, destPath }) {
    if (!sourcePath || !destPath) {
      throw new TypeError("ViewBuilder.cloneView: sourcePath and destPath required");
    }
    if (!fs.existsSync(sourcePath)) {
      throw new Error(`ViewBuilder.cloneView: source does not exist: ${sourcePath}`);
    }
    if (fs.existsSync(destPath)) {
      throw new Error(`ViewBuilder.cloneView: destination already exists: ${destPath}`);
    }
    fs.mkdirSync(path.dirname(destPath), { recursive: true });
    const source = new Database(sourcePath, { fileMustExist: true });
    try {
      source.pragma("wal_checkpoint(TRUNCATE)");
    } finally {
      source.close();
    }
    fs.copyFileSync(sourcePath, destPath);
  }

  /**
   * @param {{ sourcePath: string, destPath: string }} args
   * @param {{ waitMs?: number, label?: string }} [opts]
   * @returns {Promise<void>}
   */
  cloneViewAsync(args, opts = {}) {
    return runSqliteWrite(args?.destPath, () => this.cloneView(args), {
      label: opts.label || "ViewBuilder.cloneView",
      waitMs: opts.waitMs,
    });
  }
}

// ============================================================================
// Lineage walking
// ============================================================================

/**
 * Build the oldest-to-newest lineage of branches leading to `branch`,
 * with each ancestor's effective ledger cutoff inclusive.
 *
 * Example: wi-2 forked from wi-1 at seq 7, wi-1 forked from main at seq 3.
 * buildLineage(ledger, "wi-2", atSeq=4) returns:
 *   [ {branch: "main", cutoff: 3}, {branch: "wi-1", cutoff: 7}, {branch: "wi-2", cutoff: 4} ]
 *
 * @param {Ledger} ledger
 * @param {string} branch
 * @param {number} atSeq
 * @returns {{ branch: string, cutoff: number }[]}
 */
function buildLineage(ledger, branch, atSeq) {
  /** @type {{ branch: string, cutoff: number }[]} */
  const chain = [];
  let current = ledger.getBranch(branch);
  if (!current) throw new Error(`buildLineage: unknown branch '${branch}'`);
  chain.push({ branch: current.name, cutoff: atSeq });
  while (current.parent_branch) {
    const cutoff = current.parent_seq ?? 0;
    chain.unshift({ branch: current.parent_branch, cutoff });
    const parent = ledger.getBranch(current.parent_branch);
    if (!parent) throw new Error(`buildLineage: unknown parent '${current.parent_branch}'`);
    current = parent;
  }
  return chain;
}

/**
 * Apply every ancestor's deltas (each bounded by its cutoff) in order
 * and return the final repo-relative-path -> content_hash map.
 *
 * @param {Ledger} ledger
 * @param {{ branch: string, cutoff: number }[]} lineage
 * @returns {Map<string, string>}
 */
function assemblePathToBlob(ledger, lineage) {
  /** @type {Map<string, string>} */
  const pathToBlob = new Map();
  for (const step of lineage) {
    if (step.cutoff <= 0) continue;
    const deltas = ledger.tail(step.branch, 0, { upToSeq: step.cutoff });
    for (const d of deltas) {
      if (d.op === "remove") {
        pathToBlob.delete(d.repo_rel_path);
      } else if (d.after_content_hash) {
        pathToBlob.set(d.repo_rel_path, d.after_content_hash);
      }
    }
  }
  return pathToBlob;
}

// ============================================================================
// View DB writes
// ============================================================================

/**
 * @param {import("better-sqlite3").Database} db
 * @param {Map<string, string>} pathToBlob
 */
function populatePathToBlob(db, pathToBlob) {
  const ins = db.prepare(
    "INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)",
  );
  for (const [p, h] of pathToBlob) {
    if (!isCanonicalRepoPath(p)) {
      throw new RangeError(`populatePathToBlob: non-canonical path '${p}'`);
    }
    ins.run(p, h);
  }
}

/**
 * Three-pass materialization of symbols + edges.
 *
 * @param {import("better-sqlite3").Database} viewDb
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {Map<string, string>} pathToBlob
 */
// How many source paths to materialize per committed transaction. Chunking
// keeps each write small (short lock windows, bounded WAL) and lets the build
// report progress between batches, instead of one giant all-or-nothing
// transaction. Output is identical regardless of chunk size: global_ids are
// autoincrement rowids assigned in pathToBlob iteration order, which chunk
// boundaries don't change.
const VIEW_BUILD_CHUNK = 64;

/**
 * @param {import("better-sqlite3").Database} viewDb
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {Map<string,string>} pathToBlob
 * @param {boolean} useLayerMerge
 * @param {{ onProgress?: ((e: { phase: string, current: number, total: number }) => void) | null }} [opts]
 */
function populateSymbolsAndEdges(viewDb, ledgerDb, pathToBlob, useLayerMerge = false, opts = {}) {
  const onProgress = typeof opts.onProgress === "function" ? opts.onProgress : null;
  const emit = (phase, current, total) => {
    if (!onProgress) return;
    try { onProgress({ phase, current, total }); } catch { /* progress is observational */ }
  };
  // Total work for progress = paths visited in the symbol pass + the edge pass
  // (two full sweeps over pathToBlob) plus a slice for parent backfill + resolver.
  const pathCount = pathToBlob.size;
  // Build reverse map content_hash -> [paths] for cross-blob edge resolution.
  /** @type {Map<string, string[]>} */
  const blobToPaths = new Map();
  for (const [p, h] of pathToBlob) {
    const list = blobToPaths.get(h) || [];
    list.push(p);
    blobToPaths.set(h, list);
  }

  const symbolReadStmt = prepareLedgerSymbolReadStmt(ledgerDb);
  const edgeReadStmt = prepareLedgerEdgeReadStmt(ledgerDb);
  // Order-independent layer source: merge the per-blob tree-sitter+SCIP layers
  // into the same flat row shape the legacy read returns, cached per blob so
  // the symbol and edge passes share one merge. When off, read flat tables.
  /** @type {Map<string, { symbols: any[], edges: any[] }>} */
  const mergeCache = new Map();
  const mergedFor = (content_hash) => {
    let m = mergeCache.get(content_hash);
    if (!m) { m = mergeLayerRows(ledgerDb, content_hash); mergeCache.set(content_hash, m); }
    return m;
  };
  const readSymbols = (content_hash) => (useLayerMerge
    ? mergedFor(content_hash).symbols
    : /** @type {any[]} */ (symbolReadStmt.all(content_hash)));
  const readEdges = (content_hash) => (useLayerMerge
    ? mergedFor(content_hash).edges
    : /** @type {any[]} */ (edgeReadStmt.all(content_hash)));
  const symbolInsert = prepareViewSymbolInsert(viewDb);
  const updateParent = viewDb.prepare(
    "UPDATE symbols SET parent_global_id = ? WHERE global_id = ?",
  );
  const edgeInsert = prepareViewEdgeInsert(viewDb);

  // (repo_rel_path, local_id) -> global_id
  /** @type {Map<string, number>} */
  const localToGlobal = new Map();
  // Track parent backfill: list of [global_id, parent_local_id, repo_rel_path]
  /** @type {{ global_id: number, parent_local_id: number, repo_rel_path: string }[]} */
  const parentBackfill = [];

  const entries = [...pathToBlob];

  // Pass 1: insert symbols (parent_global_id=NULL), record id mapping.
  // Chunked into per-batch transactions so the build commits incrementally and
  // can report progress. global_ids are autoincrement rowids assigned in this
  // iteration order; chunk boundaries don't change the order, so the result is
  // identical to the single-transaction build.
  const insertSymbolsForEntry = ([repo_rel_path, content_hash]) => {
    const rows = readSymbols(content_hash);
    for (const r of rows) {
      const info = symbolInsert.run(
        r.content_hash,
        r.local_id,
        r.kind,
        r.name,
        r.qualified_name,
        repo_rel_path,
        r.range_start,
        r.range_end,
        r.range_start_line,
        r.range_end_line,
        r.signature_hash,
        r.signature_text ?? null,
        r.body_identifiers ?? null,
        r.visibility,
        r.doc,
        normalizeLedgerLang(r.lang),
      );
      const globalId = Number(info.lastInsertRowid);
      localToGlobal.set(localKey(repo_rel_path, r.local_id), globalId);
      if (r.parent_local_id != null) {
        parentBackfill.push({
          global_id: globalId,
          parent_local_id: r.parent_local_id,
          repo_rel_path,
        });
      }
    }
  };
  const insertSymbolChunk = viewDb.transaction((batch) => {
    for (const entry of batch) insertSymbolsForEntry(entry);
  });
  for (let i = 0; i < entries.length; i += VIEW_BUILD_CHUNK) {
    insertSymbolChunk(entries.slice(i, i + VIEW_BUILD_CHUNK));
    emit("symbols", Math.min(i + VIEW_BUILD_CHUNK, entries.length), pathCount);
  }
  emit("symbols", pathCount, pathCount);

  // Pass 2: backfill parent_global_id (one transaction — fast, in-memory map).
  viewDb.transaction(() => {
    for (const pb of parentBackfill) {
      const parentGid = localToGlobal.get(localKey(pb.repo_rel_path, pb.parent_local_id));
      if (parentGid != null) updateParent.run(parentGid, pb.global_id);
      // Else leave NULL — parser referenced a parent_local_id that wasn't
      // emitted (shouldn't happen for a well-formed blob, but tolerate).
    }
  })();

  // Pass 3: insert edges with best-effort resolution. Chunked like pass 1.
  const insertEdgesForEntry = ([repo_rel_path, content_hash]) => {
    const rows = readEdges(content_hash);
    for (const r of rows) {
      const fromGid = localToGlobal.get(localKey(repo_rel_path, r.from_local_id));
      if (fromGid == null) continue; // edge references a symbol that didn't materialize
      let toGid = null;
      if (r.to_content_hash && r.to_local_id != null) {
        // Resolve to the target blob's host path. If the target blob
        // appears at multiple paths in this view, pick the same path as
        // the from-blob when possible, otherwise the first.
        const candidatePaths = blobToPaths.get(r.to_content_hash);
        if (candidatePaths && candidatePaths.length > 0) {
          const preferred =
            candidatePaths.find((p) => p === repo_rel_path) ?? candidatePaths[0];
          const candidate = localToGlobal.get(localKey(preferred, r.to_local_id));
          if (candidate != null) toGid = candidate;
        }
      }
      edgeInsert.run(
        fromGid,
        toGid,
        r.to_name,
        r.to_module ?? null,
        r.to_external_id ?? null,
        r.external_descriptor ?? null,
        r.source || "treesitter",
        r.kind,
        repo_rel_path,
        r.range_start,
        r.range_end,
        r.range_start_line,
        r.range_end_line,
        r.confidence,
      );
    }
  };
  const insertEdgeChunk = viewDb.transaction((batch) => {
    for (const entry of batch) insertEdgesForEntry(entry);
  });
  for (let i = 0; i < entries.length; i += VIEW_BUILD_CHUNK) {
    insertEdgeChunk(entries.slice(i, i + VIEW_BUILD_CHUNK));
    emit("edges", Math.min(i + VIEW_BUILD_CHUNK, entries.length), pathCount);
  }
  emit("edges", pathCount, pathCount);

  // Pass 4: resolver. Bind unresolved edges (to_global_id IS NULL)
  // using import context + global name index + qualified-name lookup.
  // This is where cross-file calls/extends/implements actually pick up
  // their target IDs. runResolverPass wraps its own transaction, so call it
  // directly — do NOT wrap it here (better-sqlite3 can't nest transactions).
  emit("resolve", 0, 1);
  runResolverPass(viewDb, pathToBlob);
  emit("resolve", 1, 1);
}

/**
 * @param {string} repo_rel_path
 * @param {number} local_id
 * @returns {string}
 */
function localKey(repo_rel_path, local_id) {
  return `${repo_rel_path}\x00${local_id}`;
}

/**
 * Normalize legacy ledger language tags while materializing views. Older
 * SCIP PHP indexes wrote protobuf enum numbers (for example "19") into
 * blob.lang; keeping the normalization here lets full rebuilds heal those
 * existing ledgers.
 *
 * @param {string} lang
 * @returns {string}
 */
function normalizeLedgerLang(lang) {
  return normalizeLangFromScip(lang);
}

/**
 * @param {import("better-sqlite3").Database} ledgerDb
 */
function prepareLedgerSymbolReadStmt(ledgerDb) {
  return ledgerDb.prepare(
    `SELECT bs.content_hash, bs.local_id,
            ks.value AS kind, ns.value AS name,
            qs.value AS qualified_name,
            bs.parent_local_id,
            bs.range_start, bs.range_end,
            bs.range_start_line, bs.range_end_line,
            bs.signature_hash, bs.signature_text, bs.body_identifiers, bs.visibility, bs.doc,
            b.lang
     FROM blob_symbols bs
     JOIN interned_strings ks ON ks.id = bs.kind_id
     JOIN interned_strings ns ON ns.id = bs.name_id
     LEFT JOIN interned_strings qs ON qs.id = bs.qualified_name_id
     JOIN blobs b ON b.content_hash = bs.content_hash
     WHERE bs.content_hash = ?
     ORDER BY bs.local_id ASC`,
  );
}

/**
 * @param {import("better-sqlite3").Database} ledgerDb
 */
function prepareLedgerEdgeReadStmt(ledgerDb) {
  return ledgerDb.prepare(
    `SELECT be.from_content_hash, be.from_local_id,
            be.to_content_hash, be.to_local_id, be.to_external_id,
            tns.value AS to_name, tms.value AS to_module, ks.value AS kind,
            be.range_start, be.range_end,
            be.range_start_line, be.range_end_line,
            be.confidence, be.source,
            es.descriptor AS external_descriptor
     FROM blob_edges be
     JOIN interned_strings tns ON tns.id = be.to_name_id
     LEFT JOIN interned_strings tms ON tms.id = be.to_module_id
     JOIN interned_strings ks ON ks.id = be.kind_id
     LEFT JOIN external_symbols es ON es.id = be.to_external_id
     WHERE be.from_content_hash = ?
     ORDER BY be.edge_id ASC`,
  );
}

/**
 * @param {import("better-sqlite3").Database} viewDb
 */
function prepareViewSymbolInsert(viewDb) {
  return viewDb.prepare(
    `INSERT INTO symbols
       (content_hash, local_id, kind, name, qualified_name, parent_global_id,
        repo_rel_path, range_start, range_end, range_start_line, range_end_line,
        signature_hash, signature_text, body_identifiers, visibility, doc, lang)
     VALUES (?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
}

/**
 * @param {import("better-sqlite3").Database} viewDb
 */
function prepareViewEdgeInsert(viewDb) {
  return viewDb.prepare(
    `INSERT INTO edges
       (from_global_id, to_global_id, to_name, to_module, to_external_id,
        external_descriptor, source, kind, repo_rel_path,
        range_start, range_end, range_start_line, range_end_line, confidence)
     VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
}

// ============================================================================
// Incremental apply
// ============================================================================

/**
 * @param {import("better-sqlite3").Database} viewDb
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {LedgerEntry} entry
 */
function applyEntry(viewDb, ledgerDb, entry) {
  const updatePath = viewDb.prepare(
    "INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?) " +
      "ON CONFLICT(repo_rel_path) DO UPDATE SET content_hash = excluded.content_hash",
  );
  const deletePath = viewDb.prepare(
    "DELETE FROM path_to_blob WHERE repo_rel_path = ?",
  );
  const deleteSymbolsAtPath = viewDb.prepare(
    "DELETE FROM symbols WHERE repo_rel_path = ?",
  );

  if (entry.op === "remove") {
    deleteSymbolsAtPath.run(entry.repo_rel_path);
    deletePath.run(entry.repo_rel_path);
    return;
  }

  // For add/modify: verify the ledger has the new blob BEFORE mutating
  // the view. Without this guard, an entry whose after_content_hash is
  // missing from `blobs` (e.g. a ledger/view store mismatch or a race
  // with ingest) leaves path_to_blob updated and writeMeta advanced but
  // no symbols populated — the view is then inconsistent until full
  // rebuild. Skip the entry instead so the caller can retry.
  const blobExists = /** @type {{ n: number } | undefined} */ (
    ledgerDb.prepare("SELECT 1 AS n FROM blobs WHERE content_hash = ? LIMIT 1").get(entry.after_content_hash)
  );
  if (!blobExists) {
    return { skipped: true, reason: "missing_blob", content_hash: entry.after_content_hash };
  }

  // For add/modify: wipe existing symbols at this path (if any) and
  // re-materialize from the new content_hash. Edges with from_global_id
  // at this path will CASCADE delete; edges pointing INTO this path
  // become unresolved (SET NULL) automatically per FK.
  deleteSymbolsAtPath.run(entry.repo_rel_path);
  updatePath.run(entry.repo_rel_path, entry.after_content_hash);

  // Rebuild path_to_blob view (it now has the new mapping) and ask
  // populateSymbolsAndEdges to re-materialize just this path. We pass
  // a single-entry map but the helper expects the FULL current map for
  // accurate cross-blob edge resolution.
  /** @type {Map<string, string>} */
  const fullMap = new Map();
  const rows = /** @type {any[]} */ (
    viewDb.prepare("SELECT repo_rel_path, content_hash FROM path_to_blob").all()
  );
  for (const r of rows) fullMap.set(r.repo_rel_path, r.content_hash);

  // We only want to insert the NEW path's symbols, but cross-blob
  // resolution needs to see the full map. Use a scoped helper.
  populateSinglePath(viewDb, ledgerDb, fullMap, entry.repo_rel_path);
}

/**
 * Like populateSymbolsAndEdges but only emits symbols + edges for one
 * target path. Cross-blob edge resolution still consults the full map.
 *
 * @param {import("better-sqlite3").Database} viewDb
 * @param {import("better-sqlite3").Database} ledgerDb
 * @param {Map<string, string>} fullPathToBlob
 * @param {string} onlyPath
 */
function populateSinglePath(viewDb, ledgerDb, fullPathToBlob, onlyPath) {
  const content_hash = fullPathToBlob.get(onlyPath);
  if (!content_hash) return;

  /** @type {Map<string, string[]>} */
  const blobToPaths = new Map();
  for (const [p, h] of fullPathToBlob) {
    const list = blobToPaths.get(h) || [];
    list.push(p);
    blobToPaths.set(h, list);
  }

  const symbolReadStmt = prepareLedgerSymbolReadStmt(ledgerDb);
  const edgeReadStmt = prepareLedgerEdgeReadStmt(ledgerDb);
  const symbolInsert = prepareViewSymbolInsert(viewDb);
  const updateParent = viewDb.prepare(
    "UPDATE symbols SET parent_global_id = ? WHERE global_id = ?",
  );
  const edgeInsert = prepareViewEdgeInsert(viewDb);
  // For resolving edges into OTHER paths whose content_hash already
  // existed in the view, we need to look up their existing global_ids.
  const lookupExistingGlobal = viewDb.prepare(
    "SELECT global_id FROM symbols WHERE repo_rel_path = ? AND local_id = ?",
  );

  /** @type {Map<string, number>} */
  const localToGlobal = new Map();
  /** @type {{ global_id: number, parent_local_id: number }[]} */
  const parentBackfill = [];

  const symRows = /** @type {any[]} */ (symbolReadStmt.all(content_hash));
  for (const r of symRows) {
    const info = symbolInsert.run(
      r.content_hash,
      r.local_id,
      r.kind,
      r.name,
      r.qualified_name,
      onlyPath,
      r.range_start,
      r.range_end,
      r.range_start_line,
      r.range_end_line,
      r.signature_hash,
      r.signature_text ?? null,
      r.body_identifiers ?? null,
      r.visibility,
      r.doc,
      normalizeLedgerLang(r.lang),
    );
    const globalId = Number(info.lastInsertRowid);
    localToGlobal.set(String(r.local_id), globalId);
    if (r.parent_local_id != null) {
      parentBackfill.push({ global_id: globalId, parent_local_id: r.parent_local_id });
    }
  }
  for (const pb of parentBackfill) {
    const parentGid = localToGlobal.get(String(pb.parent_local_id));
    if (parentGid != null) updateParent.run(parentGid, pb.global_id);
  }

  const edgeRows = /** @type {any[]} */ (edgeReadStmt.all(content_hash));
  for (const r of edgeRows) {
    const fromGid = localToGlobal.get(String(r.from_local_id));
    if (fromGid == null) continue;
    let toGid = null;
    if (r.to_content_hash && r.to_local_id != null) {
      const candidatePaths = blobToPaths.get(r.to_content_hash);
      if (candidatePaths && candidatePaths.length > 0) {
        const preferred = candidatePaths.find((p) => p === onlyPath) ?? candidatePaths[0];
        if (preferred === onlyPath) {
          const fresh = localToGlobal.get(String(r.to_local_id));
          if (fresh != null) toGid = fresh;
        } else {
          const existing = /** @type {{ global_id: number } | undefined} */ (
            lookupExistingGlobal.get(preferred, r.to_local_id)
          );
          if (existing) toGid = existing.global_id;
        }
      }
    }
    edgeInsert.run(
      fromGid,
      toGid,
      r.to_name,
      r.to_module ?? null,
      r.to_external_id ?? null,
      r.external_descriptor ?? null,
      r.source || "treesitter",
      r.kind,
      onlyPath,
      r.range_start,
      r.range_end,
      r.range_start_line,
      r.range_end_line,
      r.confidence,
    );
  }
}

// ============================================================================
// Meta writes
// ============================================================================

/**
 * Write a ViewMeta into the view's meta key/value table. Null-valued
 * fields are deleted (not stored as "") so View.meta reads cleanly.
 *
 * @param {import("better-sqlite3").Database} viewDb
 * @param {ViewMeta} meta
 */
function writeMeta(viewDb, meta) {
  const set = viewDb.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  );
  const del = viewDb.prepare("DELETE FROM meta WHERE key = ?");
  /**
   * @param {string} key
   * @param {string | null | undefined} value
   */
  const put = (key, value) => {
    if (value == null) del.run(key);
    else set.run(key, value);
  };
  put("schema_version", String(meta.schema_version));
  put("branch", meta.branch);
  put("parent_branch", meta.parent_branch ?? null);
  put("parent_seq", meta.parent_seq != null ? String(meta.parent_seq) : null);
  put("ledger_seq", String(meta.ledger_seq));
  put("built_at", meta.built_at);
  put(
    "warmed_for_files",
    meta.warmed_for_files ? JSON.stringify(meta.warmed_for_files) : null,
  );
  put(
    "prefetched_symbols",
    meta.prefetched_symbols != null ? String(meta.prefetched_symbols) : null,
  );
  put(
    "prefetched_edges",
    meta.prefetched_edges != null ? String(meta.prefetched_edges) : null,
  );
  put("repo_root", meta.repo_root ?? null);
}

/**
 * @param {import("better-sqlite3").Database} viewDb
 * @param {{ force?: boolean }} [opts]
 */
function refreshGraphDerivedStateIfChanged(viewDb, opts = {}) {
  const nextSignature = graphDerivedInputSignature(viewDb);
  const previousSignature = opts.force ? null : readMetaValue(viewDb, GRAPH_DERIVED_SIGNATURE_META_KEY);
  if (nextSignature && nextSignature === previousSignature && graphDerivedStateLooksCurrent(viewDb)) {
    return { skipped: true, signature: nextSignature };
  }
  const result = refreshGraphDerivedState(viewDb);
  if (result.ok && nextSignature) {
    writeMetaValue(viewDb, GRAPH_DERIVED_SIGNATURE_META_KEY, nextSignature);
  }
  return { skipped: false, signature: nextSignature, result };
}

/**
 * @param {import("better-sqlite3").Database} viewDb
 * @param {{ force?: boolean }} [opts]
 */
function refreshTreeDerivedStateIfChanged(viewDb, opts = {}) {
  const nextSignature = treeDerivedInputSignature(viewDb);
  const previousSignature = opts.force ? null : readMetaValue(viewDb, TREE_DERIVED_SIGNATURE_META_KEY);
  if (nextSignature && nextSignature === previousSignature && treeDerivedStateLooksCurrent(viewDb)) {
    return { skipped: true, signature: nextSignature };
  }
  const result = refreshTreeDerivedState(viewDb);
  if (result.ok && nextSignature) {
    writeMetaValue(viewDb, TREE_DERIVED_SIGNATURE_META_KEY, nextSignature);
  }
  return { skipped: false, signature: nextSignature, result };
}

/**
 * @param {import("better-sqlite3").Database} viewDb
 * @param {{ force?: boolean }} [opts]
 */
function refreshTreeCompressionSnapshotIfChanged(viewDb, opts = {}) {
  const mode = normalizeTreeCompressionMode(opts.mode);
  if (mode === "off") {
    if (opts.force) writeMetaValue(viewDb, TREE_COMPRESSION_SIGNATURE_META_KEY, null);
    return { skipped: true, reason: "tree_compression_off" };
  }
  const nextSignature = treeCompressionInputSignature(viewDb);
  const previousSignature = opts.force ? null : readMetaValue(viewDb, TREE_COMPRESSION_SIGNATURE_META_KEY);
  if (nextSignature && nextSignature === previousSignature && treeCompressionSnapshotLooksCurrent(viewDb)) {
    return { skipped: true, signature: nextSignature };
  }
  const result = refreshTreeCompressionSnapshot(viewDb, {
    maxSeeds: positiveIntOrNull(opts.maxSeeds) ?? undefined,
  });
  if (result.ok && nextSignature) {
    writeMetaValue(viewDb, TREE_COMPRESSION_SIGNATURE_META_KEY, nextSignature);
  }
  return { skipped: false, signature: nextSignature, result };
}

function normalizeTreeCompressionMode(value) {
  const raw = String(value || "deterministic").trim().toLowerCase();
  if (raw === "off" || raw === "deterministic" || raw === "ml") return raw;
  return "deterministic";
}

function positiveIntOrNull(value) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * @param {import("better-sqlite3").Database} viewDb
 * @param {string} key
 */
function readMetaValue(viewDb, key) {
  const row = viewDb.prepare("SELECT value FROM meta WHERE key = ?").get(key);
  return typeof row?.value === "string" ? row.value : null;
}

/**
 * @param {import("better-sqlite3").Database} viewDb
 * @param {string} key
 * @param {string | null | undefined} value
 */
function writeMetaValue(viewDb, key, value) {
  if (value == null) {
    viewDb.prepare("DELETE FROM meta WHERE key = ?").run(key);
    return;
  }
  viewDb.prepare(
    "INSERT INTO meta(key, value) VALUES(?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
  ).run(key, value);
}

/**
 * @param {import("better-sqlite3").Database} viewDb
 */
function graphDerivedStateLooksCurrent(viewDb) {
  try {
    const symbols = viewDb.prepare("SELECT COUNT(*) AS cnt FROM symbols").get();
    const centrality = viewDb.prepare("SELECT COUNT(*) AS cnt FROM symbol_centrality").get();
    const latest = viewDb.prepare(
      "SELECT status FROM derived_state_runs WHERE kind = 'graph-derived' ORDER BY id DESC LIMIT 1",
    ).get();
    return Number(symbols?.cnt || 0) === Number(centrality?.cnt || 0)
      && String(latest?.status || "") === "ok";
  } catch {
    return false;
  }
}

/**
 * @param {import("better-sqlite3").Database} viewDb
 */
function treeDerivedStateLooksCurrent(viewDb) {
  try {
    const symbols = viewDb.prepare("SELECT COUNT(*) AS cnt FROM symbols").get();
    const treeSymbols = viewDb.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_nodes WHERE symbol_ref IS NOT NULL").get();
    const scopeSymbols = viewDb.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_scope_symbol_files").get();
    const treeFiles = viewDb.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_nodes WHERE kind = 'file'").get();
    const scopeFiles = viewDb.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_scope_nodes WHERE kind = 'file'").get();
    const root = viewDb.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_nodes WHERE node_id = 'root'").get();
    const latest = viewDb.prepare(
      "SELECT status FROM derived_state_runs WHERE kind = 'tree-derived' ORDER BY id DESC LIMIT 1",
    ).get();
    return Number(symbols?.cnt || 0) === Number(treeSymbols?.cnt || 0)
      && Number(treeSymbols?.cnt || 0) === Number(scopeSymbols?.cnt || 0)
      && Number(treeFiles?.cnt || 0) === Number(scopeFiles?.cnt || 0)
      && Number(root?.cnt || 0) === 1
      && String(latest?.status || "") === "ok";
  } catch {
    return false;
  }
}

/**
 * @param {import("better-sqlite3").Database} viewDb
 */
function treeCompressionSnapshotLooksCurrent(viewDb) {
  try {
    const latest = viewDb.prepare(
      "SELECT status FROM derived_state_runs WHERE kind = 'tree-compression-snapshot' ORDER BY id DESC LIMIT 1",
    ).get();
    const snapshot = viewDb.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_compression_snapshots").get();
    return Number(snapshot?.cnt || 0) > 0 && String(latest?.status || "") === "ok";
  } catch {
    return false;
  }
}

// ============================================================================
// Neighborhood prefetch (3.4 active warming)
// ============================================================================

/**
 * Walk the symbol neighborhood around hint.paths to prime the OS page
 * cache for the worker that will mount this view next. Reading the rows
 * is the whole point — the returned counts are observational.
 *
 * The view contents are NOT modified; the 3.3 rebuildable-from-ledger
 * invariant is preserved.
 *
 * @param {import("better-sqlite3").Database} viewDb
 * @param {BuildHint} hint
 * @returns {{ symbols: number, edges: number }}
 */
function runPrefetch(viewDb, hint) {
  const rawPaths = Array.isArray(hint?.paths) ? hint.paths : [];
  const paths = rawPaths.filter((p) => typeof p === "string" && isCanonicalRepoPath(p));
  if (paths.length === 0) return { symbols: 0, edges: 0 };

  const depth = Math.max(1, Math.min(Number.isInteger(hint.depth) ? /** @type {number} */ (hint.depth) : 2, 4));
  const maxSymbols = Math.max(1, Math.min(Number.isInteger(hint.maxSymbols) ? /** @type {number} */ (hint.maxSymbols) : 500, 5000));

  const seedStmt = viewDb.prepare("SELECT global_id FROM symbols WHERE repo_rel_path = ?");
  const neighborStmt = viewDb.prepare(
    "SELECT from_global_id, to_global_id FROM edges WHERE from_global_id = ? OR to_global_id = ?",
  );

  /** @type {Set<number>} */
  const visited = new Set();
  /** @type {number[]} */
  let frontier = [];

  seedLoop: for (const p of paths) {
    for (const r of /** @type {Iterable<any>} */ (seedStmt.iterate(p))) {
      const gid = Number(r.global_id);
      if (visited.has(gid)) continue;
      visited.add(gid);
      frontier.push(gid);
      if (visited.size >= maxSymbols) break seedLoop;
    }
  }

  let edges = 0;
  for (let hop = 0; hop < depth && frontier.length > 0 && visited.size < maxSymbols; hop++) {
    /** @type {number[]} */
    const next = [];
    hopLoop: for (const gid of frontier) {
      for (const e of /** @type {Iterable<any>} */ (neighborStmt.iterate(gid, gid))) {
        edges++;
        const other = e.from_global_id === gid ? e.to_global_id : e.from_global_id;
        if (other == null) continue;
        if (visited.has(other)) continue;
        visited.add(other);
        next.push(other);
        if (visited.size >= maxSymbols) break hopLoop;
      }
    }
    frontier = next;
  }

  return { symbols: visited.size, edges };
}

/**
 * Read the current path_to_blob map out of a view DB. Used by the
 * incremental-apply path to feed the resolver after entries are
 * applied.
 *
 * @param {import("better-sqlite3").Database} viewDb
 * @returns {Map<string, string>}
 */
function readPathToBlobMap(viewDb) {
  /** @type {Map<string, string>} */
  const out = new Map();
  const rows = /** @type {any[]} */ (
    viewDb.prepare("SELECT repo_rel_path, content_hash FROM path_to_blob").all()
  );
  for (const r of rows) out.set(r.repo_rel_path, r.content_hash);
  return out;
}

/**
 * Resolver pass — runs after edge materialization. Reads every
 * unresolved edge (to_global_id IS NULL), resolves via
 * `resolveEdges()`, and writes back the resulting to_global_id +
 * confidence updates inside a single transaction.
 *
 * Idempotent: re-running on a view that's already been resolved is a
 * no-op (no unresolved edges remain to bind).
 *
 * @param {import("better-sqlite3").Database} viewDb
 * @param {Map<string, string>} pathToBlob
 */
function runResolverPass(viewDb, pathToBlob) {
  // Pull every symbol — feeds the global name index.
  const allSymbols = /** @type {any[]} */ (
    viewDb.prepare(
      "SELECT global_id, content_hash, local_id, repo_rel_path, kind, name, qualified_name FROM symbols",
    ).all()
  );

  // Pull import edges (they carry to_module). The resolver builds the
  // per-file ImportContext from these.
  const importEdges = /** @type {any[]} */ (
    viewDb.prepare(
      `SELECT e.repo_rel_path, e.to_name, e.to_module, e.kind, e.confidence, s.lang
       FROM edges e
       JOIN symbols s ON s.global_id = e.from_global_id
       WHERE e.kind = 'imports' AND e.to_module IS NOT NULL`,
    ).all()
  );

  // Pull every unresolved edge so the resolver can try to bind it.
  // ROWID is implicit in SQLite — used to UPDATE the right row later.
  //
  // Edges already bound by SCIP (source='scip' OR to_external_id IS NOT NULL)
  // are deliberately skipped: SCIP is compiler-precise, so the heuristic
  // resolver must not second-guess it (and must not rebind a SCIP external
  // moniker to a same-named in-repo symbol).
  const unresolvedRows = /** @type {any[]} */ (
    viewDb.prepare(
      // JOIN symbols so each edge carries the language of its source
      // file. The resolver dispatches per-language adapters using this.
      `SELECT e.ROWID AS edge_rowid, e.from_global_id, e.repo_rel_path,
              e.to_name, e.to_module, e.kind, s.lang
       FROM edges e
       JOIN symbols s ON s.global_id = e.from_global_id
       WHERE e.to_global_id IS NULL
         AND e.to_external_id IS NULL
         AND e.source = 'treesitter'`,
    ).all()
  );
  if (unresolvedRows.length === 0) return;

  const resolutions = resolveEdges({
    allSymbols,
    importEdges,
    pathToBlob,
    unresolved: unresolvedRows,
  });

  const update = viewDb.prepare(
    "UPDATE edges SET to_global_id = ?, confidence = ? WHERE ROWID = ?",
  );
  const txn = viewDb.transaction(() => {
    for (const r of resolutions) {
      if (r.to_global_id != null) {
        update.run(r.to_global_id, r.confidence, r.edge_rowid);
      } else {
        // Update confidence to reflect "unresolved" even though
        // to_global_id stays NULL.
        update.run(null, r.confidence, r.edge_rowid);
      }
    }
  });
  txn();
}
