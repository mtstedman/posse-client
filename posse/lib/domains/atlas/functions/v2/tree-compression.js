// @ts-check
//
// Quick tree-compression snapshot for ATLAS v2.
//
// This is intentionally separate from tree-derived state: tree-derived remains
// raw aggregate facts, while this module turns those facts into compact
// seed annotations that an explicit one-time model pass can refine.

import { sha256Hex } from "./hash.js";
import { runAtlasNativeMethod } from "./native/invoke.js";

export const TREE_COMPRESSION_RUN_KIND = "tree-compression-snapshot";
export const TREE_COMPRESSION_PROFILE = "quick_dirty_tree_ml_features_v0";
export const TREE_COMPRESSION_ML_RUN_KIND = "tree-compression-ml-pass";
export const TREE_COMPRESSION_ML_PROFILE = "one_time_tree_ml_seed_v0";

const DEFAULT_MAX_SEEDS = 80;

const REQUIRED_SOURCE_TABLES = Object.freeze([
  "atlas_tree_scope_nodes",
  "atlas_tree_scope_symbol_files",
  "atlas_tree_scope_term_stats",
]);

/**
 * @param {import("better-sqlite3").Database} db
 */
export function ensureTreeCompressionTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS atlas_tree_compression_snapshots (
      id               INTEGER PRIMARY KEY AUTOINCREMENT,
      built_at         TEXT NOT NULL,
      profile          TEXT NOT NULL,
      source_signature TEXT,
      status           TEXT NOT NULL,
      summary_json     TEXT NOT NULL DEFAULT '{}',
      details_json     TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_compression_snapshots_built
      ON atlas_tree_compression_snapshots(built_at);

    CREATE TABLE IF NOT EXISTS atlas_tree_compression_seeds (
      snapshot_id                          INTEGER NOT NULL,
      node_id                              TEXT NOT NULL,
      repo_rel_path                        TEXT NOT NULL,
      label                                TEXT NOT NULL,
      confidence                           REAL NOT NULL DEFAULT 0,
      aliases_json                         TEXT NOT NULL DEFAULT '[]',
      entrypoints_json                     TEXT NOT NULL DEFAULT '[]',
      likely_tests_json                    TEXT NOT NULL DEFAULT '[]',
      avoid_if_query_only_mentions_json    TEXT NOT NULL DEFAULT '[]',
      ml_features_json                     TEXT NOT NULL DEFAULT '{}',
      signals_json                         TEXT NOT NULL DEFAULT '{}',
      deterministic_signature              TEXT NOT NULL DEFAULT '',
      PRIMARY KEY (snapshot_id, node_id),
      FOREIGN KEY (snapshot_id) REFERENCES atlas_tree_compression_snapshots(id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_atlas_tree_compression_seeds_path
      ON atlas_tree_compression_seeds(repo_rel_path);

    CREATE TABLE IF NOT EXISTS derived_state_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      built_at     TEXT NOT NULL,
      kind         TEXT NOT NULL,
      status       TEXT NOT NULL,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      details_json TEXT NOT NULL DEFAULT '{}'
    );
  `);
  // Older views predate the carry-forward signature column. CREATE TABLE IF NOT
  // EXISTS leaves them untouched, so add it idempotently. The signature lets a
  // reseed match unchanged deterministic seeds against the prior ML snapshot and
  // run the model only on the deltas.
  ensureColumn(db, "atlas_tree_compression_seeds", "deterministic_signature", "TEXT NOT NULL DEFAULT ''");
  // Per-seed label provenance: when the ML pass actually authored the text
  // (carried forward verbatim across reseeds/rebuilds), how many tree
  // refreshes have changed the area since, and when it first drifted.
  ensureColumn(db, "atlas_tree_compression_seeds", "labeled_at", "TEXT");
  ensureColumn(db, "atlas_tree_compression_seeds", "drift_count", "INTEGER NOT NULL DEFAULT 0");
  ensureColumn(db, "atlas_tree_compression_seeds", "stale_since", "TEXT");
  ensureColumn(db, "atlas_tree_compression_seeds", "drift_signature", "TEXT");
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} table
 * @param {string} column
 * @param {string} definition
 */
function ensureColumn(db, table, column, definition) {
  try {
    const present = db.prepare(`PRAGMA table_info(${table})`).all()
      .some((row) => String(row.name || "") === column);
    if (!present) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  } catch {
    // A missing table means ensure-tables has not run yet; the CREATE above owns it.
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @returns {string | null}
 */
export function treeCompressionInputSignature(db) {
  if (missingTables(db, REQUIRED_SOURCE_TABLES).length > 0) return null;
  try {
    const nodes = db.prepare(
      `SELECT node_id, parent_node_id, kind, label, repo_rel_path, depth,
              descendant_symbol_count, descendant_file_count, generated, test, config,
              aggregates_json, terms_json, projected_terms_json
       FROM atlas_tree_scope_nodes
       ORDER BY node_id`,
    ).all();
    const symbols = db.prepare(
      `SELECT sf.symbol_ref, sf.symbol_node_id, sf.file_node_id, sf.repo_rel_path,
              n.kind, n.label, n.aggregates_json
       FROM atlas_tree_scope_symbol_files sf
       LEFT JOIN atlas_tree_nodes n ON n.node_id = sf.symbol_node_id
       ORDER BY sf.repo_rel_path, sf.symbol_ref, sf.symbol_node_id`,
    ).all();
    return sha256Hex(JSON.stringify({ nodes, symbols }));
  } catch {
    return null;
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ maxSeeds?: number, maxDepth?: number, maxFilesPerSeed?: number }} [opts]
 * @returns {{ ok: boolean, durationMs: number, snapshotId?: number, seedCount: number, profile: string, sourceSignature: string | null, error?: string }}
 */
export function refreshTreeCompressionSnapshot(db, opts = {}) {
  ensureTreeCompressionTables(db);
  const started = Date.now();
  const sourceSignature = treeCompressionInputSignature(db);
  db.exec("SAVEPOINT tree_compression_refresh");
  try {
    const snapshot = buildTreeCompressionSnapshot(db, opts);
    if (!snapshot.available) {
      throw new Error(snapshot.reason || "tree_compression_source_unavailable");
    }

    const { snapshotId } = writeTreeCompressionSnapshot(db, snapshot, sourceSignature);
    const drift = updateTreeCompressionDrift(db);
    const durationMs = Date.now() - started;
    recordRun(db, TREE_COMPRESSION_RUN_KIND, "ok", durationMs, {
      profile: snapshot.profile,
      source_signature: sourceSignature,
      seed_count: snapshot.seeds.length,
      totals: snapshot.summary.totals,
      ml_label_drift: drift.ok ? { checked: drift.checked, drifted: drift.drifted, cleared: drift.cleared } : { error: drift.error },
    });
    db.exec("RELEASE tree_compression_refresh");
    return {
      ok: true,
      durationMs,
      snapshotId,
      seedCount: snapshot.seeds.length,
      profile: snapshot.profile,
      sourceSignature,
    };
  } catch (err) {
    rollbackSavepoint(db, "tree_compression_refresh");
    const durationMs = Date.now() - started;
    recordRun(db, TREE_COMPRESSION_RUN_KIND, "error", durationMs, {
      source_signature: sourceSignature,
      error: err?.message || String(err),
    });
    return {
      ok: false,
      durationMs,
      seedCount: 0,
      profile: TREE_COMPRESSION_PROFILE,
      sourceSignature,
      error: err?.message || String(err),
    };
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {{ maxSeeds?: number, maxDepth?: number, maxFilesPerSeed?: number }} [opts]
 */
export function buildTreeCompressionSnapshot(db, opts = {}) {
  const missing = missingTables(db, REQUIRED_SOURCE_TABLES);
  if (missing.length > 0) {
    return {
      available: false,
      reason: "tree_compression_source_missing",
      missingTables: missing,
      profile: TREE_COMPRESSION_PROFILE,
      builtAt: new Date().toISOString(),
      summary: {},
      details: {},
      seeds: [],
    };
  }

  // Deterministic seed construction (scoring, term vectors, entrypoints, labels)
  // is owned by the Rust binary. Node only reads the scope tables into the
  // TreeBuildResult shape the binary consumes. There is no Node fallback — the
  // native route is the single source of truth for tree compression.
  const tree = readScopeTreeForCompression(db);
  return /** @type {any} */ (runAtlasNativeMethod(
    "tree-compression",
    {
      tree,
      maxSeeds: opts.maxSeeds,
      maxDepth: opts.maxDepth,
      maxFilesPerSeed: opts.maxFilesPerSeed,
    },
    opts.nativeManager ? { manager: opts.nativeManager } : {},
  ));
}

/**
 * Read the view's tree-scope tables into the binary's TreeBuildResult shape.
 * Only the fields the compression pass consumes are populated: scope nodes,
 * symbol→file refs, and a minimal node per referenced symbol (kind/label) so the
 * binary can resolve per-file symbols.
 *
 * @param {import("better-sqlite3").Database} db
 */
function readScopeTreeForCompression(db) {
  const scopeNodes = db.prepare(
    `SELECT node_id AS nodeId, parent_node_id AS parentNodeId, kind, label,
            repo_rel_path AS repoRelPath, depth, sort_order AS sortOrder,
            descendant_symbol_count AS descendantSymbolCount,
            descendant_file_count AS descendantFileCount,
            generated, test, config,
            aggregates_json AS aggregatesJson, terms_json AS termsJson,
            projected_terms_json AS projectedTermsJson
     FROM atlas_tree_scope_nodes
     ORDER BY depth ASC, sort_order ASC, node_id ASC`,
  ).all().map((row) => ({
    nodeId: String(row.nodeId || ""),
    parentNodeId: row.parentNodeId ? String(row.parentNodeId) : null,
    kind: String(row.kind || ""),
    label: String(row.label || ""),
    repoRelPath: normalizeRepoPath(row.repoRelPath),
    depth: Number(row.depth || 0),
    sortOrder: Number(row.sortOrder || 0),
    descendantSymbolCount: Number(row.descendantSymbolCount || 0),
    descendantFileCount: Number(row.descendantFileCount || 0),
    generated: Number(row.generated || 0) > 0,
    test: Number(row.test || 0) > 0,
    config: Number(row.config || 0) > 0,
    aggregates: parseJsonObject(row.aggregatesJson),
    terms: parseJsonArray(row.termsJson).map(String),
    projectedTerms: parseJsonArray(row.projectedTermsJson).map(String),
  }));

  const symbolFiles = [];
  if (missingTables(db, ["atlas_tree_scope_symbol_files"]).length === 0) {
    for (const row of db.prepare(
      `SELECT symbol_ref AS symbolRef, symbol_node_id AS symbolNodeId,
              file_node_id AS fileNodeId, repo_rel_path AS repoRelPath
       FROM atlas_tree_scope_symbol_files
       ORDER BY repo_rel_path ASC, symbol_ref ASC, symbol_node_id ASC`,
    ).all()) {
      symbolFiles.push({
        symbolRef: String(row.symbolRef || ""),
        symbolNodeId: String(row.symbolNodeId || ""),
        fileNodeId: String(row.fileNodeId || ""),
        repoRelPath: normalizeRepoPath(row.repoRelPath),
      });
    }
  }

  // Minimal symbol nodes (kind/label) for symbol resolution. The binary
  // tolerates partial nodes (TreeNode deserializes with field defaults).
  const nodes = [];
  if (symbolFiles.length > 0 && missingTables(db, ["atlas_tree_nodes"]).length === 0) {
    for (const row of db.prepare(
      `SELECT node_id AS nodeId, kind, label FROM atlas_tree_nodes
       WHERE node_id IN (SELECT DISTINCT symbol_node_id FROM atlas_tree_scope_symbol_files)`,
    ).all()) {
      nodes.push({
        nodeId: String(row.nodeId || ""),
        kind: String(row.kind || ""),
        label: String(row.label || ""),
      });
    }
  }

  return { nodes, refs: [], scopeNodes, scopeTerms: [], termStats: [], symbolFiles };
}

/**
 * Build the provider prompt from the Rust-produced model input. The deterministic
 * model-input shaping (delta selection, payload trimming) is owned by the binary
 * (`tree-compression-model-input`); this only wraps it in the provider contract.
 *
 * @param {{ seeds?: any[], summary?: any }} modelInput
 */
export function buildTreeCompressionModelPassPrompt(modelInput) {
  const input = modelInput && typeof modelInput === "object" ? modelInput : { seeds: [] };
  return [
    "You are enriching an ATLAS repository tree compression snapshot.",
    "Return JSON only. Do not call tools. Do not include markdown.",
    "",
    "For each seed, add semantic signal that helps retrieval choose or avoid repo areas.",
    "Use only paths already present in each seed. Do not invent files, directories, APIs, or facts.",
    "Prefer short domain labels, useful aliases, and precise avoid guards.",
    "",
    "Output shape:",
    JSON.stringify({
      seeds: [
        {
          nodeId: "same nodeId",
          path: "same path",
          label: "short semantic label",
          aliases: ["domain phrase", "feature phrase"],
          domainTerms: ["term"],
          tags: ["subsystem"],
          entrypoints: ["existing/path/from/seed.ts"],
          likelyTests: ["existing/test/from/seed.test.ts"],
          avoidIfQueryOnlyMentions: ["unrelated query phrase"],
          confidence: 0.8,
          rationale: "brief reason",
        },
      ],
    }, null, 2),
    "",
    "Input:",
    JSON.stringify(input, null, 2),
  ].join("\n");
}

/**
 * One-time / reseed model pass. The deterministic build stays in Node, but the
 * ML shaping is owned by the Rust binary: `tree-compression-model-input` selects
 * the delta seeds (everything new since the prior ML snapshot) and
 * `tree-compression-annotate` merges fresh annotations while carrying unchanged
 * seeds forward from the prior. With no prior this is the full boot-seed pass;
 * with a prior only the deltas reach the provider.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{
 *   maxSeeds?: number,
 *   maxDepth?: number,
 *   maxFilesPerSeed?: number,
 *   modelMaxSeeds?: number,
 *   annotations?: any,
 *   annotator?: ((args: { prompt: string, input: any, snapshot: any }) => any | Promise<any>),
 *   modelMetadata?: Record<string, unknown>,
 *   nativeManager?: import("../../../../../shared/tools/classes/BinaryManager.js").BinaryManager,
 * }} [opts]
 * @returns {Promise<{ ok: boolean, durationMs: number, snapshotId?: number, seedCount: number, profile: string, sourceSignature: string | null, modelSeedCount?: number, deltaSeeds?: number, unannotatedSeeds?: number, carriedForwardSeeds?: number, error?: string }>}
 */
export async function refreshTreeCompressionSnapshotWithModelPass(db, opts = {}) {
  ensureTreeCompressionTables(db);
  const started = Date.now();
  const sourceSignature = treeCompressionInputSignature(db);
  const nativeOpts = opts.nativeManager ? { manager: opts.nativeManager } : {};
  try {
    const base = buildTreeCompressionSnapshot(db, opts);
    if (!base.available) {
      throw new Error(base.reason || "tree_compression_source_unavailable");
    }
    // Prior model-annotated snapshot, if any. Drives carry-forward/delta in the
    // binary; null on first boot (full pass). Read all of it (not the retrieval
    // limit) so no carry-forward candidate is dropped.
    const prior = readPriorMlSnapshot(db);

    const input = /** @type {any} */ (runAtlasNativeMethod(
      "tree-compression-model-input",
      { snapshot: base, maxSeeds: opts.modelMaxSeeds, priorSnapshot: prior },
      nativeOpts,
    ));
    const emittedSeeds = Array.isArray(input?.seeds) ? input.seeds.length : 0;
    // Content deltas (new/changed areas, enrichment stale without a model pass)
    // vs unannotated backlog (unchanged areas an earlier pass never labeled —
    // safe to defer). Older binaries only report the combined pool, so the
    // content gate falls back to the emitted length.
    const deltaSeeds = numberOr(input?.summary?.deltaSeeds, emittedSeeds);
    const unannotatedSeeds = numberOr(input?.summary?.unannotatedSeeds, 0);
    const carriedForwardSeeds = numberOr(input?.summary?.carriedForwardSeeds, 0);

    // Pay for the provider whenever the binary emitted work and we can annotate
    // (content deltas and backlog drain together). Without an annotator only
    // content deltas are fatal; an unlabeled backlog just waits for the next
    // annotator-equipped pass, and the annotate call below still rebuilds the
    // snapshot with every prior annotation carried forward.
    let rawAnnotations = { seeds: [] };
    if (opts.annotations !== undefined) {
      rawAnnotations = opts.annotations;
    } else if (emittedSeeds > 0 && typeof opts.annotator === "function") {
      const prompt = buildTreeCompressionModelPassPrompt(input);
      rawAnnotations = await opts.annotator({ prompt, input, snapshot: base });
      if (rawAnnotations == null || rawAnnotations === "") {
        throw new Error("tree_compression_model_annotations_missing");
      }
    } else if (deltaSeeds > 0) {
      throw new Error("tree_compression_model_annotations_missing");
    }

    const enriched = /** @type {any} */ (runAtlasNativeMethod(
      "tree-compression-annotate",
      {
        snapshot: base,
        annotations: rawAnnotations,
        modelMetadata: opts.modelMetadata || null,
        priorSnapshot: prior,
      },
      nativeOpts,
    ));
    const enrichedSeeds = Array.isArray(enriched?.seeds) ? enriched.seeds : [];
    stampSeedLabelProvenance(enrichedSeeds, readMlSeedProvenance(db), enriched?.builtAt);

    db.exec("SAVEPOINT tree_compression_ml_refresh");
    try {
      const { snapshotId } = writeTreeCompressionSnapshot(db, enriched, sourceSignature);
      const durationMs = Date.now() - started;
      recordRun(db, TREE_COMPRESSION_ML_RUN_KIND, "ok", durationMs, {
        profile: enriched.profile,
        deterministic_profile: base.profile,
        source_signature: sourceSignature,
        seed_count: enrichedSeeds.length,
        model_seed_count: emittedSeeds,
        delta_seeds: deltaSeeds,
        unannotated_seeds: unannotatedSeeds,
        carried_forward_seeds: carriedForwardSeeds,
        model: opts.modelMetadata || null,
      });
      db.exec("RELEASE tree_compression_ml_refresh");
      return {
        ok: true,
        durationMs,
        snapshotId,
        seedCount: enrichedSeeds.length,
        profile: enriched.profile,
        sourceSignature,
        modelSeedCount: emittedSeeds,
        deltaSeeds,
        unannotatedSeeds,
        carriedForwardSeeds,
      };
    } catch (err) {
      rollbackSavepoint(db, "tree_compression_ml_refresh");
      throw err;
    }
  } catch (err) {
    const durationMs = Date.now() - started;
    recordRun(db, TREE_COMPRESSION_ML_RUN_KIND, "error", durationMs, {
      source_signature: sourceSignature,
      error: err?.message || String(err),
      model: opts.modelMetadata || null,
    });
    return {
      ok: false,
      durationMs,
      seedCount: 0,
      profile: TREE_COMPRESSION_ML_PROFILE,
      sourceSignature,
      error: err?.message || String(err),
    };
  }
}

/**
 * Read label provenance for the persisted ML seeds, keyed by node id. Kept
 * separate from readPriorMlSnapshot so the binary-shaped prior payload stays
 * exactly what the native code expects.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {Map<string, { label: string, labeledAt: string | null, driftCount: number, staleSince: string | null, driftSignature: string | null }>}
 */
function readMlSeedProvenance(db) {
  const out = new Map();
  try {
    const rows = db.prepare(
      `SELECT s.node_id AS nodeId, s.label, s.labeled_at AS labeledAt,
              s.drift_count AS driftCount, s.stale_since AS staleSince,
              s.drift_signature AS driftSignature
       FROM atlas_tree_compression_seeds s
       JOIN atlas_tree_compression_snapshots p ON p.id = s.snapshot_id
       WHERE p.profile = ?`,
    ).all(TREE_COMPRESSION_ML_PROFILE);
    for (const row of rows) {
      out.set(String(row.nodeId || ""), {
        label: String(row.label || ""),
        labeledAt: row.labeledAt ? String(row.labeledAt) : null,
        driftCount: numberOr(row.driftCount, 0),
        staleSince: row.staleSince ? String(row.staleSince) : null,
        driftSignature: row.driftSignature ? String(row.driftSignature) : null,
      });
    }
  } catch { /* no prior ML snapshot yet */ }
  return out;
}

/**
 * Stamp label provenance onto seeds about to be persisted. A seed whose label
 * text matches the prior ML seed was carried forward, so it keeps the original
 * labeled_at and any accumulated drift state; a new or re-labeled seed starts
 * fresh (labeled now, zero drift).
 *
 * @param {any[]} seeds
 * @param {Map<string, any>} provenance
 * @param {string | null | undefined} builtAt
 */
export function stampSeedLabelProvenance(seeds, provenance, builtAt) {
  const now = builtAt || new Date().toISOString();
  for (const seed of seeds || []) {
    const prior = provenance.get(String(seed.nodeId || ""));
    if (prior && prior.label === String(seed.label || "")) {
      seed.labeledAt = prior.labeledAt || now;
      seed.driftCount = prior.driftCount;
      seed.staleSince = prior.staleSince;
      seed.driftSignature = prior.driftSignature;
    } else {
      seed.labeledAt = now;
      seed.driftCount = 0;
      seed.staleSince = null;
      seed.driftSignature = null;
    }
  }
  return seeds;
}

/**
 * Reconcile ML seed drift state against the freshest deterministic snapshot.
 * Runs after every deterministic refresh (i.e. every warm), so re-treed areas
 * accumulate an honest "changed N times since the label was written" counter
 * without ever invoking the model:
 *
 * - current signature matches the labeled one: the label is accurate again;
 *   drift state resets.
 * - current signature differs from the LAST OBSERVED one: the area changed
 *   again; drift_count increments, stale_since is set on first drift.
 * - the node vanished from the deterministic seed set: counted once as a
 *   drift to "missing".
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {{ ok: boolean, checked: number, drifted: number, cleared: number, error?: string }}
 */
export function updateTreeCompressionDrift(db) {
  try {
    const mlRow = db.prepare(
      "SELECT id FROM atlas_tree_compression_snapshots WHERE profile = ? ORDER BY id DESC LIMIT 1",
    ).get(TREE_COMPRESSION_ML_PROFILE);
    const detRow = db.prepare(
      "SELECT id FROM atlas_tree_compression_snapshots WHERE profile = ? ORDER BY id DESC LIMIT 1",
    ).get(TREE_COMPRESSION_PROFILE);
    if (!mlRow || !detRow) return { ok: true, checked: 0, drifted: 0, cleared: 0 };

    const detSigs = new Map(db.prepare(
      "SELECT node_id AS nodeId, deterministic_signature AS sig FROM atlas_tree_compression_seeds WHERE snapshot_id = ?",
    ).all(detRow.id).map((row) => [String(row.nodeId || ""), String(row.sig || "")]));

    const mlSeeds = db.prepare(
      `SELECT node_id AS nodeId, deterministic_signature AS labeledSig,
              drift_count AS driftCount, stale_since AS staleSince,
              drift_signature AS driftSignature
       FROM atlas_tree_compression_seeds WHERE snapshot_id = ?`,
    ).all(mlRow.id);

    const update = db.prepare(
      `UPDATE atlas_tree_compression_seeds
       SET drift_count = ?, stale_since = ?, drift_signature = ?
       WHERE snapshot_id = ? AND node_id = ?`,
    );
    const now = new Date().toISOString();
    let drifted = 0;
    let cleared = 0;
    for (const seed of mlSeeds) {
      const nodeId = String(seed.nodeId || "");
      const labeledSig = String(seed.labeledSig || "");
      const lastSeen = seed.driftSignature ? String(seed.driftSignature) : labeledSig;
      const current = detSigs.has(nodeId) ? detSigs.get(nodeId) : "__missing__";
      if (current === labeledSig) {
        if (seed.staleSince || numberOr(seed.driftCount, 0) !== 0 || seed.driftSignature) {
          update.run(0, null, null, mlRow.id, nodeId);
          cleared += 1;
        }
      } else if (current !== lastSeen) {
        update.run(numberOr(seed.driftCount, 0) + 1, seed.staleSince || now, current, mlRow.id, nodeId);
        drifted += 1;
      }
    }
    return { ok: true, checked: mlSeeds.length, drifted, cleared };
  } catch (err) {
    return { ok: false, checked: 0, drifted: 0, cleared: 0, error: String(/** @type {any} */ (err)?.message || err) };
  }
}

/**
 * Export the persisted ML snapshot (with its source signature) so a full view
 * rebuild — which recreates the view FILE and would otherwise destroy it —
 * can carry the annotations into the new file. Without this, every rebuild
 * re-ran the full model pass (~2min of provider time) instead of a delta.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {{ snapshot: object, sourceSignature: string | null } | null}
 */
export function exportTreeCompressionMlSnapshot(db) {
  try {
    const prior = readLatestTreeCompressionSnapshot(db, {
      profile: TREE_COMPRESSION_ML_PROFILE,
      seedLimit: 1000,
    });
    if (!prior.available || !prior.snapshot) return null;
    const reconstructed = readPriorMlSnapshot(db);
    if (!reconstructed) return null;
    const provenance = readMlSeedProvenance(db);
    for (const seed of reconstructed.seeds) {
      const prov = provenance.get(seed.nodeId);
      if (prov) {
        seed.labeledAt = prov.labeledAt;
        seed.driftCount = prov.driftCount;
        seed.staleSince = prov.staleSince;
        seed.driftSignature = prov.driftSignature;
      }
    }
    return {
      snapshot: reconstructed,
      sourceSignature: prior.snapshot.sourceSignature || null,
    };
  } catch {
    return null;
  }
}

/**
 * Import a previously exported ML snapshot into a freshly built view so the
 * next model pass sees it as the carry-forward prior.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ snapshot: object, sourceSignature: string | null } | null} exported
 * @returns {{ ok: boolean, seeds?: number, error?: string }}
 */
export function importTreeCompressionMlSnapshot(db, exported) {
  if (!exported?.snapshot) return { ok: false, error: "nothing_to_import" };
  try {
    ensureTreeCompressionTables(db);
    writeTreeCompressionSnapshot(db, exported.snapshot, exported.sourceSignature ?? null);
    return { ok: true, seeds: Array.isArray(exported.snapshot.seeds) ? exported.snapshot.seeds.length : 0 };
  } catch (err) {
    return { ok: false, error: String(/** @type {any} */ (err)?.message || err) };
  }
}

/**
 * Reconstruct the persisted ML snapshot as a binary-shaped TreeCompressionSnapshot
 * for carry-forward, or null when none exists yet.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {object | null}
 */
function readPriorMlSnapshot(db) {
  const prior = readLatestTreeCompressionSnapshot(db, {
    profile: TREE_COMPRESSION_ML_PROFILE,
    seedLimit: 1000,
  });
  if (!prior.available || !prior.snapshot) return null;
  return {
    available: true,
    profile: prior.snapshot.profile,
    builtAt: prior.snapshot.builtAt || "",
    summary: prior.snapshot.summary || {},
    details: prior.snapshot.details || {},
    seeds: prior.seeds.map((seed) => ({
      nodeId: seed.nodeId,
      path: seed.path,
      label: seed.label,
      aliases: seed.aliases || [],
      entrypoints: seed.entrypoints || [],
      likelyTests: seed.likelyTests || [],
      avoidIfQueryOnlyMentions: seed.avoidIfQueryOnlyMentions || [],
      confidence: numberOr(seed.confidence, 0),
      signals: seed.signals || {},
      mlFeatures: seed.mlFeatures || {},
      deterministicSignature: seed.deterministicSignature || "",
    })),
  };
}

/**
 * Read the most relevant persisted snapshot. With per-profile retention there
 * can be both a deterministic and an ML snapshot at once; when no explicit
 * `profile` is requested the ML snapshot wins (it is the enriched retrieval
 * surface), falling back to the latest deterministic one.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {{ seedLimit?: number, profile?: string }} [opts]
 */
export function readLatestTreeCompressionSnapshot(db, opts = {}) {
  if (missingTables(db, ["atlas_tree_compression_snapshots", "atlas_tree_compression_seeds"]).length > 0) {
    return {
      available: false,
      reason: "tree_compression_tables_missing",
      snapshot: null,
      seeds: [],
    };
  }
  const explicitProfile = typeof opts.profile === "string" && opts.profile ? opts.profile : null;
  const row = explicitProfile
    ? db.prepare(
        `SELECT id, built_at AS builtAt, profile, source_signature AS sourceSignature,
                status, summary_json AS summaryJson, details_json AS detailsJson
         FROM atlas_tree_compression_snapshots
         WHERE profile = ?
         ORDER BY id DESC
         LIMIT 1`,
      ).get(explicitProfile)
    : db.prepare(
        // Prefer the ML profile, then fall back to the newest of anything else.
        `SELECT id, built_at AS builtAt, profile, source_signature AS sourceSignature,
                status, summary_json AS summaryJson, details_json AS detailsJson
         FROM atlas_tree_compression_snapshots
         ORDER BY (profile = ?) DESC, id DESC
         LIMIT 1`,
      ).get(TREE_COMPRESSION_ML_PROFILE);
  if (!row) {
    return {
      available: false,
      reason: "tree_compression_snapshot_missing",
      snapshot: null,
      seeds: [],
    };
  }
  const seedLimit = clampInt(opts.seedLimit, 1, 1000, DEFAULT_MAX_SEEDS);
  const seeds = db.prepare(
    `SELECT node_id AS nodeId, repo_rel_path AS path, label, confidence,
            aliases_json AS aliasesJson, entrypoints_json AS entrypointsJson,
            likely_tests_json AS likelyTestsJson,
            avoid_if_query_only_mentions_json AS avoidJson,
            ml_features_json AS mlFeaturesJson,
            signals_json AS signalsJson,
            deterministic_signature AS deterministicSignature,
            labeled_at AS labeledAt,
            drift_count AS driftCount,
            stale_since AS staleSince,
            drift_signature AS driftSignature
     FROM atlas_tree_compression_seeds
     WHERE snapshot_id = ?
     ORDER BY confidence DESC, repo_rel_path ASC
     LIMIT ?`,
  ).all(row.id, seedLimit).map((seed) => ({
    nodeId: String(seed.nodeId || ""),
    path: String(seed.path || ""),
    label: String(seed.label || ""),
    confidence: numberOr(seed.confidence, 0),
    aliases: parseJsonArray(seed.aliasesJson),
    entrypoints: parseJsonArray(seed.entrypointsJson),
    likelyTests: parseJsonArray(seed.likelyTestsJson),
    avoidIfQueryOnlyMentions: parseJsonArray(seed.avoidJson),
    mlFeatures: parseJsonObject(seed.mlFeaturesJson),
    signals: parseJsonObject(seed.signalsJson),
    deterministicSignature: String(seed.deterministicSignature || ""),
    labeledAt: seed.labeledAt ? String(seed.labeledAt) : null,
    driftCount: numberOr(seed.driftCount, 0),
    staleSince: seed.staleSince ? String(seed.staleSince) : null,
    driftSignature: seed.driftSignature ? String(seed.driftSignature) : null,
  }));

  // Optional staleness decoration: a seed's label is "stale" when the area's
  // CURRENT deterministic signature no longer matches the one the label was
  // written against (the area was re-treed after labeling). Computed against
  // the deterministic-profile snapshot, which refreshes on every warm.
  if (opts.withStaleness && row.profile === TREE_COMPRESSION_ML_PROFILE) {
    try {
      const det = db.prepare(
        `SELECT s.node_id AS nodeId, s.deterministic_signature AS sig
         FROM atlas_tree_compression_seeds s
         JOIN atlas_tree_compression_snapshots p ON p.id = s.snapshot_id
         WHERE p.profile = ?
         ORDER BY p.id DESC`,
      ).all(TREE_COMPRESSION_PROFILE);
      const currentSig = new Map();
      for (const entry of det) {
        if (!currentSig.has(entry.nodeId)) currentSig.set(String(entry.nodeId), String(entry.sig || ""));
      }
      if (currentSig.size > 0) {
        for (const seed of seeds) {
          const sig = currentSig.get(seed.nodeId);
          seed.labelStale = sig === undefined || sig !== seed.deterministicSignature;
        }
      }
    } catch { /* staleness is advisory */ }
  }
  return {
    available: true,
    snapshot: {
      id: Number(row.id),
      builtAt: row.builtAt,
      profile: row.profile,
      sourceSignature: row.sourceSignature || null,
      status: row.status,
      summary: parseJsonObject(row.summaryJson),
      details: parseJsonObject(row.detailsJson),
    },
    seeds,
  };
}

function writeTreeCompressionSnapshot(db, snapshot, sourceSignature) {
  // Retain at most one snapshot per profile. A deterministic warm refresh must
  // not clobber the prior ML snapshot (and vice versa): the reseed reads that
  // prior to carry forward unchanged seeds. Seeds cascade-delete with their
  // snapshot row, so dropping the same-profile snapshot is enough.
  const profile = String(snapshot.profile || TREE_COMPRESSION_PROFILE);
  const priorIds = db.prepare(
    "SELECT id FROM atlas_tree_compression_snapshots WHERE profile = ?",
  ).all(profile).map((row) => Number(row.id));
  if (priorIds.length > 0) {
    const placeholders = priorIds.map(() => "?").join(", ");
    db.prepare(`DELETE FROM atlas_tree_compression_seeds WHERE snapshot_id IN (${placeholders})`).run(...priorIds);
    db.prepare(`DELETE FROM atlas_tree_compression_snapshots WHERE id IN (${placeholders})`).run(...priorIds);
  }
  const inserted = db.prepare(
    `INSERT INTO atlas_tree_compression_snapshots
       (built_at, profile, source_signature, status, summary_json, details_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(
    snapshot.builtAt,
    snapshot.profile,
    sourceSignature,
    "ok",
    JSON.stringify(snapshot.summary || {}),
    JSON.stringify(snapshot.details || {}),
  );
  const snapshotId = Number(inserted.lastInsertRowid);
  const seedInsert = db.prepare(
    `INSERT INTO atlas_tree_compression_seeds
       (snapshot_id, node_id, repo_rel_path, label, confidence, aliases_json,
        entrypoints_json, likely_tests_json, avoid_if_query_only_mentions_json,
        ml_features_json, signals_json, deterministic_signature,
        labeled_at, drift_count, stale_since, drift_signature)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const seed of snapshot.seeds || []) {
    seedInsert.run(
      snapshotId,
      seed.nodeId,
      seed.path,
      seed.label,
      seed.confidence,
      JSON.stringify(seed.aliases || []),
      JSON.stringify(seed.entrypoints || []),
      JSON.stringify(seed.likelyTests || []),
      JSON.stringify(seed.avoidIfQueryOnlyMentions || []),
      JSON.stringify(seed.mlFeatures || {}),
      JSON.stringify(seed.signals || {}),
      String(seed.deterministicSignature || ""),
      seed.labeledAt ?? snapshot.builtAt ?? null,
      Number.isFinite(Number(seed.driftCount)) ? Number(seed.driftCount) : 0,
      seed.staleSince ?? null,
      seed.driftSignature ?? null,
    );
  }
  return { snapshotId };
}

function normalizeRepoPath(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/, "")
    .replace(/\/+/g, "/")
    .replace(/^\/+|\/+$/g, "");
}

function missingTables(db, tableNames) {
  try {
    const present = new Set(db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN (${tableNames.map(() => "?").join(", ")})`,
    ).all(...tableNames).map((row) => String(row.name || "")));
    return tableNames.filter((name) => !present.has(name));
  } catch {
    return [...tableNames];
  }
}

function recordRun(db, kind, status, durationMs, details) {
  try {
    db.prepare(
      "INSERT INTO derived_state_runs(built_at, kind, status, duration_ms, details_json) VALUES (?, ?, ?, ?, ?)",
    ).run(new Date().toISOString(), kind, status, Math.max(0, Math.round(durationMs)), JSON.stringify(details || {}));
  } catch {
    // Derived-state run telemetry must never break indexing.
  }
}

function rollbackSavepoint(db, name) {
  try {
    db.exec(`ROLLBACK TO ${name}`);
  } catch {
    // Preserve the original writer failure.
  }
  try {
    db.exec(`RELEASE ${name}`);
  } catch {
    // Ignore cleanup failures.
  }
}

function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function numberOr(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}
