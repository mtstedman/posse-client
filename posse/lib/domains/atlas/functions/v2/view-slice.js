// @ts-check
//
// ATLAS v2 view slice + blast-radius graph walks — weighted neighborhood
// expansion and inbound-reference closure over the view's edges table.
// Stateless: every entry point takes the view db plus a row hydrator.
// Lifted out of the View class.

import { isCanonicalRepoPath } from "./paths.js";

/** @typedef {import("./contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("./contracts/api.js").SliceOptions} SliceOptions */

/**
 * Weighted neighborhood expansion over edges from `seedGlobalIds`.
 * Edges contribute confidence * depth decay, then results are ranked by
 * aggregate impact instead of whichever flat BFS path hit the cap first.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {(row: any) => ViewSymbol} hydrateSymbol
 * @param {number[]} seedGlobalIds
 * @param {SliceOptions} opts
 * @returns {{ symbols: ViewSymbol[], frontier: { symbol: ViewSymbol, score: number, why: string }[] }}
 */
export function runSlice(db, hydrateSymbol, seedGlobalIds, opts) {
  const depth = typeof opts.depth === "number" && opts.depth > 0 ? opts.depth : 2;
  const maxSymbols =
    typeof opts.maxSymbols === "number" && opts.maxSymbols > 0 ? opts.maxSymbols : 200;
  const kindFilter = opts.edgeKinds && opts.edgeKinds.length > 0 ? new Set(opts.edgeKinds) : null;
  const minConfidence = opts.minConfidence == null ? 0.5 : normalizeConfidence(opts.minConfidence);
  const beamWidth = Math.min(Math.max(maxSymbols * 3, 1), 200);
  const DECAY = 0.72;

  /** @type {Set<number>} */
  const visited = new Set();
  /** @type {Map<number, number>} */
  const scoreById = new Map();
  /** @type {Map<number, number>} */
  const depthById = new Map();
  /** @type {number[]} */
  const seedOrder = [];
  /** @type {number[]} */
  let frontier = [];
  for (const seed of seedGlobalIds || []) {
    if (typeof seed === "number" && !visited.has(seed)) {
      visited.add(seed);
      seedOrder.push(seed);
      scoreById.set(seed, Number.POSITIVE_INFINITY);
      depthById.set(seed, 0);
      frontier.push(seed);
    }
  }
  const neighborsStmt = db.prepare(
    "SELECT from_global_id, to_global_id, kind, confidence FROM edges WHERE from_global_id = ? OR to_global_id = ?",
  );
  for (let d = 0; d < depth && frontier.length > 0 && visited.size < maxSymbols; d++) {
    /** @type {Map<number, number>} */
    const nextScores = new Map();
    for (const node of frontier) {
      const rows = /** @type {any[]} */ (neighborsStmt.all(node, node));
      for (const r of rows) {
        if (kindFilter && !kindFilter.has(r.kind)) continue;
        const neighbor = r.from_global_id === node ? r.to_global_id : r.from_global_id;
        if (neighbor == null) continue;
        const confidence = normalizeConfidence(r.confidence);
        if (confidence < minConfidence) continue;
        const edgeWeight = edgeWeightForKind(r.kind);
        const baseScore = Number.isFinite(scoreById.get(node)) ? Number(scoreById.get(node)) : 1;
        const contribution = baseScore * edgeWeight * confidence * (DECAY ** (d + 1));
        scoreById.set(neighbor, (scoreById.get(neighbor) || 0) + contribution);
        if (!visited.has(neighbor)) {
          nextScores.set(neighbor, (nextScores.get(neighbor) || 0) + contribution);
          if (!depthById.has(neighbor)) depthById.set(neighbor, d + 1);
        }
      }
    }
    const rankedNext = Array.from(nextScores.entries())
      .sort((a, b) => b[1] - a[1] || a[0] - b[0])
      .slice(0, beamWidth)
      .map(([id]) => id);
    frontier = [];
    for (const id of rankedNext) {
      if (visited.size >= maxSymbols) break;
      if (visited.has(id)) continue;
      visited.add(id);
      frontier.push(id);
    }
  }

  if (visited.size === 0) return { symbols: [], frontier: [] };
  const seedRank = new Map(seedOrder.map((id, idx) => [id, idx]));
  const ids = Array.from(visited)
    .sort((a, b) => {
      const aSeed = seedRank.has(a);
      const bSeed = seedRank.has(b);
      if (aSeed || bSeed) {
        if (aSeed && bSeed) return /** @type {number} */ (seedRank.get(a)) - /** @type {number} */ (seedRank.get(b));
        return aSeed ? -1 : 1;
      }
      const scoreDelta = (scoreById.get(b) || 0) - (scoreById.get(a) || 0);
      if (Math.abs(scoreDelta) > 1e-12) return scoreDelta;
      return (depthById.get(a) || 0) - (depthById.get(b) || 0) || a - b;
    });
  const placeholders = ids.map(() => "?").join(",");
  const rows = /** @type {any[]} */ (
    db.prepare(`SELECT * FROM symbols WHERE global_id IN (${placeholders})`).all(...ids)
  );
  const byId = new Map(rows.map((row) => [row.global_id, hydrateSymbol(row)]));
  const symbols = ids.map((id) => {
    const sym = byId.get(id);
    if (sym) {
      Object.defineProperty(sym, "_sliceImpact", {
        value: Number.isFinite(scoreById.get(id)) ? scoreById.get(id) : 1,
        enumerable: false,
        configurable: true,
      });
    }
    return sym;
  }).filter(Boolean);
  return {
    symbols,
    frontier: collectSliceFrontier({
      db,
      hydrateSymbol,
      visited,
      scoreById,
      kindFilter,
      minConfidence,
      neighborsStmt,
    }),
  };
}

/**
 * @param {{
 *   db: import("better-sqlite3").Database,
 *   hydrateSymbol: (row: any) => ViewSymbol,
 *   visited: Set<number>,
 *   scoreById: Map<number, number>,
 *   kindFilter: Set<string> | null,
 *   minConfidence: number,
 *   neighborsStmt: import("better-sqlite3").Statement,
 * }} args
 * @returns {{ symbol: ViewSymbol, score: number, why: string }[]}
 */
function collectSliceFrontier({ db, hydrateSymbol, visited, scoreById, kindFilter, minConfidence, neighborsStmt }) {
  /** @type {Map<number, { score: number, sourceId: number, kind: string, confidence: number }>} */
  const candidates = new Map();
  for (const node of visited) {
    const rows = /** @type {any[]} */ (neighborsStmt.all(node, node));
    for (const r of rows) {
      if (kindFilter && !kindFilter.has(r.kind)) continue;
      const neighbor = r.from_global_id === node ? r.to_global_id : r.from_global_id;
      if (neighbor == null || visited.has(neighbor)) continue;
      const confidence = normalizeConfidence(r.confidence);
      if (confidence < minConfidence) continue;
      const baseScore = Number.isFinite(scoreById.get(node)) ? Number(scoreById.get(node)) : 1;
      const score = baseScore * edgeWeightForKind(r.kind) * confidence;
      const previous = candidates.get(neighbor);
      if (!previous || score > previous.score) {
        candidates.set(neighbor, {
          score,
          sourceId: node,
          kind: String(r.kind),
          confidence,
        });
      }
    }
  }
  const ranked = Array.from(candidates.entries())
    .sort((a, b) => b[1].score - a[1].score || a[0] - b[0])
    .slice(0, 10);
  if (ranked.length === 0) return [];
  const ids = ranked.map(([id]) => id);
  const byId = symbolsByGlobalId(db, hydrateSymbol, ids);
  const sourceById = symbolsByGlobalId(db, hydrateSymbol, ranked.map(([, meta]) => meta.sourceId));
  return ranked.map(([id, meta]) => {
    const symbol = byId.get(id);
    const sourceLabel = symbolDisplayName(sourceById.get(meta.sourceId), meta.sourceId);
    return symbol
      ? {
        symbol,
        score: meta.score,
        why: `${meta.kind} edge from ${sourceLabel} (${Math.round(meta.confidence * 100)}%)`,
      }
      : null;
  }).filter(Boolean);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {(row: any) => ViewSymbol} hydrateSymbol
 * @param {number[]} ids
 * @returns {Map<number, ViewSymbol>}
 */
function symbolsByGlobalId(db, hydrateSymbol, ids) {
  const unique = [...new Set(ids.filter((id) => typeof id === "number"))];
  if (unique.length === 0) return new Map();
  const placeholders = unique.map(() => "?").join(",");
  const rows = /** @type {any[]} */ (
    db.prepare(`SELECT * FROM symbols WHERE global_id IN (${placeholders})`).all(...unique)
  );
  return new Map(rows.map((row) => [row.global_id, hydrateSymbol(row)]));
}

/**
 * @param {ViewSymbol | undefined} symbol
 * @param {number} fallbackId
 * @returns {string}
 */
function symbolDisplayName(symbol, fallbackId) {
  return symbol?.qualified_name || symbol?.name || String(fallbackId);
}

/**
 * @param {string} kind
 * @returns {number}
 */
function edgeWeightForKind(kind) {
  switch (kind) {
    case "calls": return 1.0;
    case "implements": return 0.9;
    case "extends": return 0.85;
    case "imports": return 0.6;
    case "writes": return 0.55;
    case "references":
    case "reads":
    case "uses_type":
      return 0.5;
    default:
      return 0.45;
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function normalizeConfidence(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  const scaled = n > 1 ? n / 100 : n;
  return Math.max(0, Math.min(1, scaled));
}

/**
 * Transitive set of symbols that reference any symbol defined in any of
 * the given files. Walks inbound edges from the "defined-in-paths" seed
 * until closure or until size budget reached. Results are ranked by
 * weighted impact:
 *
 *   sum(edge.confidence / 100 * decay^depth)
 *
 * so high-confidence direct callers sort ahead of weak or distant
 * references.
 *
 * @param {import("better-sqlite3").Database} db
 * @param {(row: any) => ViewSymbol} hydrateSymbol
 * @param {string[]} paths
 * @returns {ViewSymbol[]}
 */
export function runBlastRadius(db, hydrateSymbol, paths) {
  const MAX = 1000;
  const MAX_DEPTH = 8;
  const DECAY = 0.65;
  if (!paths || paths.length === 0) return [];
  const seedsStmt = db.prepare("SELECT global_id FROM symbols WHERE repo_rel_path = ?");
  /** @type {Set<number>} */
  const seedSet = new Set();
  for (const p of paths) {
    if (!isCanonicalRepoPath(p)) continue;
    for (const row of /** @type {any[]} */ (seedsStmt.all(p))) seedSet.add(row.global_id);
  }
  if (seedSet.size === 0) return [];

  /** @type {Map<number, number>} */
  const impactById = new Map();
  /** @type {Set<number>} */
  const expanded = new Set(seedSet);
  /** @type {Set<number>} */
  let frontier = new Set(seedSet);
  const callersStmt = db.prepare("SELECT from_global_id, confidence FROM edges WHERE to_global_id = ? AND from_global_id IS NOT NULL");
  for (let depth = 1; depth <= MAX_DEPTH && frontier.size > 0 && impactById.size < MAX; depth++) {
    /** @type {Set<number>} */
    const next = new Set();
    for (const node of frontier) {
      const rows = /** @type {any[]} */ (callersStmt.all(node));
      for (const r of rows) {
        if (seedSet.has(r.from_global_id)) continue;
        const confidence = Math.max(0, Math.min(100, Number(r.confidence) || 0)) / 100;
        const contribution = confidence * (DECAY ** depth);
        impactById.set(r.from_global_id, (impactById.get(r.from_global_id) || 0) + contribution);
        if (!expanded.has(r.from_global_id)) {
          next.add(r.from_global_id);
          if (impactById.size >= MAX) break;
        }
      }
      if (impactById.size >= MAX) break;
    }
    for (const id of next) expanded.add(id);
    frontier = next;
  }
  if (impactById.size === 0) return [];
  const ids = Array.from(impactById.entries())
    .sort((a, b) => b[1] - a[1] || a[0] - b[0])
    .slice(0, MAX)
    .map(([id]) => id);
  const placeholders = ids.map(() => "?").join(",");
  const rows = /** @type {any[]} */ (
    db.prepare(`SELECT * FROM symbols WHERE global_id IN (${placeholders})`).all(...ids)
  );
  const byId = new Map(rows.map((row) => [row.global_id, hydrateSymbol(row)]));
  return ids.map((id) => {
    const sym = byId.get(id);
    if (sym && !Object.prototype.hasOwnProperty.call(sym, "_impact")) {
      Object.defineProperty(sym, "_impact", {
        value: impactById.get(id) || 0,
        enumerable: false,
        configurable: true,
      });
    }
    return sym;
  }).filter(Boolean);
}
