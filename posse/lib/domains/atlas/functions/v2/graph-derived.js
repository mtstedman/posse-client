// @ts-check
//
// Rebuildable graph-derived state for Atlas view DBs: centrality, simple
// clusters, and entry-point process chains. These are caches over symbols and
// edges; failures are recorded but must not make view materialization fail.

import { sha256Hex } from "./hash.js";

const GRAPH_EDGE_KINDS = new Set(["calls", "imports", "extends", "implements"]);
const PROCESS_ENTRY_NAMES = new Set(["main", "run", "start", "serve", "handler", "execute", "orchestrate"]);
const PROCESS_ENTRY_LIMIT = 10;
const PROCESS_MAX_DEPTH = 8;

/**
 * @param {import("better-sqlite3").Database} db
 */
export function ensureGraphDerivedTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS symbol_centrality (
      symbol_global_id INTEGER PRIMARY KEY,
      fan_in           INTEGER NOT NULL DEFAULT 0,
      fan_out          INTEGER NOT NULL DEFAULT 0,
      call_fan_in      INTEGER NOT NULL DEFAULT 0,
      call_fan_out     INTEGER NOT NULL DEFAULT 0,
      score            REAL NOT NULL DEFAULT 0,
      FOREIGN KEY (symbol_global_id) REFERENCES symbols(global_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_centrality_score ON symbol_centrality(score DESC);

    CREATE TABLE IF NOT EXISTS symbol_clusters (
      symbol_global_id INTEGER PRIMARY KEY,
      cluster_id       TEXT NOT NULL,
      membership_score REAL NOT NULL DEFAULT 1.0,
      FOREIGN KEY (symbol_global_id) REFERENCES symbols(global_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_symbol_clusters_cluster ON symbol_clusters(cluster_id);

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
    CREATE INDEX IF NOT EXISTS idx_process_summaries_entry ON process_summaries(entry_global_id);

    CREATE TABLE IF NOT EXISTS process_steps (
      process_id       TEXT NOT NULL,
      step_order       INTEGER NOT NULL,
      symbol_global_id INTEGER NOT NULL,
      depth            INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (process_id, step_order),
      FOREIGN KEY (process_id) REFERENCES process_summaries(process_id) ON DELETE CASCADE,
      FOREIGN KEY (symbol_global_id) REFERENCES symbols(global_id) ON DELETE CASCADE
    );
    CREATE INDEX IF NOT EXISTS idx_process_steps_symbol ON process_steps(symbol_global_id, process_id);

    CREATE TABLE IF NOT EXISTS derived_state_runs (
      id           INTEGER PRIMARY KEY AUTOINCREMENT,
      built_at     TEXT NOT NULL,
      kind         TEXT NOT NULL,
      status       TEXT NOT NULL,
      duration_ms  INTEGER NOT NULL DEFAULT 0,
      details_json TEXT NOT NULL DEFAULT '{}'
    );
    CREATE INDEX IF NOT EXISTS idx_derived_state_runs_kind_id
      ON derived_state_runs(kind, id DESC);
  `);
}

/**
 * @param {import("better-sqlite3").Database} db
 * @returns {{ ok: boolean, durationMs: number, clusters: number, processes: number, centralityRows: number, error?: string }}
 */
export function refreshGraphDerivedState(db) {
  ensureGraphDerivedTables(db);
  const started = Date.now();
  db.exec("SAVEPOINT graph_derived_refresh");
  try {
    clearDerivedTables(db);
    const symbols = readSymbols(db);
    const edges = readResolvedEdges(db);
    const centralityRows = writeCentrality(db, symbols, edges);
    const clusters = writeClusters(db, symbols, edges);
    const processes = writeProcesses(db, symbols, edges);
    const durationMs = Date.now() - started;
    recordRun(db, "graph-derived", "ok", durationMs, { clusters, processes, centralityRows });
    db.exec("RELEASE graph_derived_refresh");
    return { ok: true, durationMs, clusters, processes, centralityRows };
  } catch (err) {
    rollbackSavepoint(db, "graph_derived_refresh");
    const durationMs = Date.now() - started;
    recordRun(db, "graph-derived", "error", durationMs, { error: err?.message || String(err) });
    return { ok: false, durationMs, clusters: 0, processes: 0, centralityRows: 0, error: err?.message || String(err) };
  }
}

/**
 * Hash only the inputs used by graph-derived tables. ViewBuilder can compare
 * this before and after incremental ledger applies to avoid rewriting derived
 * tables when symbols and resolved topology are unchanged.
 *
 * @param {import("better-sqlite3").Database} db
 * @returns {string | null}
 */
export function graphDerivedInputSignature(db) {
  try {
    const symbols = db.prepare(
      `SELECT content_hash AS contentHash, local_id AS localId, kind, name, repo_rel_path AS path
       FROM symbols
       ORDER BY content_hash, local_id, repo_rel_path`,
    ).all();
    const edges = db.prepare(
      `SELECT from_symbol.content_hash AS fromHash, from_symbol.local_id AS fromLocalId,
              to_symbol.content_hash AS toHash, to_symbol.local_id AS toLocalId,
              edges.kind
       FROM edges
       JOIN symbols AS from_symbol ON from_symbol.global_id = edges.from_global_id
       JOIN symbols AS to_symbol ON to_symbol.global_id = edges.to_global_id
       WHERE edges.to_global_id IS NOT NULL
       ORDER BY fromHash, fromLocalId, toHash, toLocalId, edges.kind`,
    ).all();
    return sha256Hex(JSON.stringify({ symbols, edges }));
  } catch {
    return null;
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {number} [limit]
 */
export function readGraphOverview(db, limit = 10) {
  if (!hasGraphDerivedTables(db)) {
    return {
      available: false,
      reason: "graph_derived_tables_missing",
      clusters: [],
      processes: [],
      centrality: [],
      latestRun: null,
    };
  }
  const clusters = db.prepare(
    `SELECT cluster_id AS clusterId, symbol_count AS symbolCount, file_count AS fileCount,
            dominant_path AS dominantPath, bridge_count AS bridgeCount, entry_symbol_ids_json AS entrySymbolIdsJson
     FROM cluster_summaries
     ORDER BY symbol_count DESC, cluster_id ASC
     LIMIT ?`,
  ).all(limit).map((row) => ({
    clusterId: row.clusterId,
    symbolCount: Number(row.symbolCount || 0),
    fileCount: Number(row.fileCount || 0),
    dominantPath: row.dominantPath || null,
    bridgeCount: Number(row.bridgeCount || 0),
    entrySymbolIds: parseJsonArray(row.entrySymbolIdsJson),
  }));
  const processes = db.prepare(
    `SELECT process_id AS processId, entry_global_id AS entryGlobalId, entry_name AS entryName,
            depth, symbol_count AS symbolCount, path_json AS pathJson
     FROM process_summaries
     ORDER BY depth DESC, symbol_count DESC, process_id ASC
     LIMIT ?`,
  ).all(limit).map((row) => ({
    processId: row.processId,
    entryGlobalId: Number(row.entryGlobalId),
    entryName: row.entryName,
    depth: Number(row.depth || 0),
    symbolCount: Number(row.symbolCount || 0),
    path: parseJsonArray(row.pathJson),
  }));
  const centrality = db.prepare(
    `SELECT s.global_id AS globalId, s.content_hash AS contentHash, s.local_id AS localId,
            s.name, s.kind, s.lang, s.repo_rel_path AS repoRelPath,
            c.fan_in AS fanIn, c.fan_out AS fanOut, c.call_fan_in AS callFanIn,
            c.call_fan_out AS callFanOut, c.score
     FROM symbol_centrality c
     JOIN symbols s ON s.global_id = c.symbol_global_id
     ORDER BY c.score DESC, s.global_id ASC
     LIMIT ?`,
  ).all(limit).map((row) => ({
    symbolId: `${row.contentHash}:${row.localId}`,
    name: row.name,
    kind: row.kind,
    lang: row.lang,
    repo_rel_path: row.repoRelPath,
    fanIn: Number(row.fanIn || 0),
    fanOut: Number(row.fanOut || 0),
    callFanIn: Number(row.callFanIn || 0),
    callFanOut: Number(row.callFanOut || 0),
    score: Number(row.score || 0),
  }));
  const latestRun = db.prepare(
    "SELECT built_at AS builtAt, status, duration_ms AS durationMs, details_json AS detailsJson FROM derived_state_runs WHERE kind = 'graph-derived' ORDER BY id DESC LIMIT 1",
  ).get();
  return {
    available: true,
    clusters,
    processes,
    centrality,
    latestRun: latestRun ? {
      builtAt: latestRun.builtAt,
      status: latestRun.status,
      durationMs: Number(latestRun.durationMs || 0),
      details: parseJsonObject(latestRun.detailsJson),
    } : null,
  };
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function hasGraphDerivedTables(db) {
  try {
    const rows = db.prepare(
      `SELECT name FROM sqlite_master
       WHERE type = 'table'
         AND name IN ('symbol_centrality', 'symbol_clusters', 'cluster_summaries', 'process_summaries', 'process_steps', 'derived_state_runs')`,
    ).all();
    return rows.length === 6;
  } catch {
    return false;
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function clearDerivedTables(db) {
  db.prepare("DELETE FROM process_steps").run();
  db.prepare("DELETE FROM process_summaries").run();
  db.prepare("DELETE FROM symbol_clusters").run();
  db.prepare("DELETE FROM cluster_summaries").run();
  db.prepare("DELETE FROM symbol_centrality").run();
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readSymbols(db) {
  return db.prepare(
    "SELECT global_id AS id, content_hash AS contentHash, local_id AS localId, name, kind, lang, repo_rel_path AS path FROM symbols ORDER BY global_id ASC",
  ).all();
}

/**
 * @param {import("better-sqlite3").Database} db
 */
function readResolvedEdges(db) {
  return db.prepare(
    `SELECT from_global_id AS fromId, to_global_id AS toId, kind
     FROM edges
     WHERE to_global_id IS NOT NULL`,
  ).all();
}

function writeCentrality(db, symbols, edges) {
  const metrics = new Map(symbols.map((symbol) => [Number(symbol.id), {
    fanIn: 0,
    fanOut: 0,
    callFanIn: 0,
    callFanOut: 0,
  }]));
  for (const edge of edges) {
    const from = metrics.get(Number(edge.fromId));
    const to = metrics.get(Number(edge.toId));
    if (from) from.fanOut += 1;
    if (to) to.fanIn += 1;
    if (edge.kind === "calls") {
      if (from) from.callFanOut += 1;
      if (to) to.callFanIn += 1;
    }
  }
  const insert = db.prepare(
    `INSERT INTO symbol_centrality
       (symbol_global_id, fan_in, fan_out, call_fan_in, call_fan_out, score)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  let count = 0;
  for (const [id, metric] of metrics) {
    const score = metric.fanIn * 2 + metric.fanOut + metric.callFanIn * 3 + metric.callFanOut * 1.5;
    insert.run(id, metric.fanIn, metric.fanOut, metric.callFanIn, metric.callFanOut, score);
    count += 1;
  }
  return count;
}

function writeClusters(db, symbols, edges) {
  const symbolById = new Map(symbols.map((symbol) => [Number(symbol.id), symbol]));
  const adjacency = new Map(symbols.map((symbol) => [Number(symbol.id), new Set()]));
  for (const edge of edges) {
    if (!GRAPH_EDGE_KINDS.has(String(edge.kind))) continue;
    const from = Number(edge.fromId);
    const to = Number(edge.toId);
    if (!adjacency.has(from) || !adjacency.has(to)) continue;
    adjacency.get(from).add(to);
    adjacency.get(to).add(from);
  }

  const clusterInsert = db.prepare(
    "INSERT INTO symbol_clusters(symbol_global_id, cluster_id, membership_score) VALUES (?, ?, ?)",
  );
  const summaryInsert = db.prepare(
    `INSERT INTO cluster_summaries
       (cluster_id, symbol_count, file_count, dominant_path, bridge_count, entry_symbol_ids_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const visited = new Set();
  let clusterIndex = 0;
  for (const symbol of symbols) {
    const start = Number(symbol.id);
    if (visited.has(start)) continue;
    const component = [];
    const queue = [start];
    visited.add(start);
    while (queue.length > 0) {
      const id = queue.shift();
      component.push(id);
      for (const next of adjacency.get(id) || []) {
        if (visited.has(next)) continue;
        visited.add(next);
        queue.push(next);
      }
    }
    if (component.length <= 1) continue;
    clusterIndex += 1;
    const clusterId = `cluster:${clusterIndex}`;
    for (const id of component) clusterInsert.run(id, clusterId, 1.0);
    const componentSymbols = component.map((id) => symbolById.get(id)).filter(Boolean);
    const files = new Set(componentSymbols.map((item) => item.path));
    const dominantPath = dominantDirectory(componentSymbols);
    const bridges = countClusterBridges(component, adjacency);
    const entryIds = componentSymbols.filter(isEntrySymbol).slice(0, 10).map((item) => `${item.contentHash}:${item.localId}`);
    summaryInsert.run(clusterId, component.length, files.size, dominantPath, bridges, JSON.stringify(entryIds));
  }
  return clusterIndex;
}

function writeProcesses(db, symbols, edges) {
  const symbolById = new Map(symbols.map((symbol) => [Number(symbol.id), symbol]));
  const calls = new Map(symbols.map((symbol) => [Number(symbol.id), []]));
  for (const edge of edges) {
    if (edge.kind !== "calls") continue;
    const from = Number(edge.fromId);
    const to = Number(edge.toId);
    if (!calls.has(from) || !calls.has(to)) continue;
    calls.get(from).push(to);
  }
  for (const list of calls.values()) list.sort((a, b) => a - b);

  const entries = symbols.filter(isEntrySymbol).slice(0, PROCESS_ENTRY_LIMIT);
  const summaryInsert = db.prepare(
    `INSERT INTO process_summaries(process_id, entry_global_id, entry_name, depth, symbol_count, path_json)
     VALUES (?, ?, ?, ?, ?, ?)`,
  );
  const stepInsert = db.prepare(
    `INSERT INTO process_steps(process_id, step_order, symbol_global_id, depth)
     VALUES (?, ?, ?, ?)`,
  );
  let count = 0;
  for (const entry of entries) {
    const pathIds = longestCallPath(Number(entry.id), calls, PROCESS_MAX_DEPTH);
    const processId = `process:${sha256Hex(`${entry.id}:${pathIds.join(">")}`).slice(0, 16)}`;
    const pathNames = pathIds.map((id) => {
      const symbol = symbolById.get(id);
      return symbol ? `${symbol.path}#${symbol.name}` : String(id);
    });
    summaryInsert.run(processId, Number(entry.id), entry.name, Math.max(0, pathIds.length - 1), pathIds.length, JSON.stringify(pathNames));
    pathIds.forEach((id, index) => stepInsert.run(processId, index, id, index));
    count += 1;
  }
  return count;
}

function longestCallPath(entryId, calls, maxDepth) {
  let best = [entryId];
  const bestPathByNode = new Map([[entryId, best]]);
  const queue = [entryId];
  for (let cursor = 0; cursor < queue.length; cursor += 1) {
    const id = queue[cursor];
    const path = bestPathByNode.get(id) || [id];
    if (path.length > best.length) best = path;
    if (path.length >= maxDepth) continue;
    for (const next of calls.get(id) || []) {
      if (path.includes(next)) continue;
      const nextPath = [...path, next];
      const previous = bestPathByNode.get(next);
      if (previous && previous.length >= nextPath.length) continue;
      bestPathByNode.set(next, nextPath);
      queue.push(next);
    }
  }
  return best;
}

function isEntrySymbol(symbol) {
  const name = String(symbol.name || "").toLowerCase();
  const file = String(symbol.path || "").split("/").pop() || "";
  const stem = file.replace(/\.[^.]+$/, "").toLowerCase();
  return PROCESS_ENTRY_NAMES.has(name)
    || PROCESS_ENTRY_NAMES.has(stem)
    || /(^|\/)(index|main|server|cli|app)\.[^.]+$/.test(String(symbol.path || ""));
}

function dominantDirectory(symbols) {
  const counts = new Map();
  for (const symbol of symbols) {
    const dir = directoryOf(String(symbol.path || ""));
    counts.set(dir, (counts.get(dir) || 0) + 1);
  }
  let best = ".";
  let bestCount = -1;
  for (const [dir, count] of counts) {
    if (count > bestCount || (count === bestCount && dir < best)) {
      best = dir;
      bestCount = count;
    }
  }
  return best;
}

function directoryOf(repoPath) {
  const idx = repoPath.lastIndexOf("/");
  return idx <= 0 ? "." : repoPath.slice(0, idx);
}

function countClusterBridges(component, adjacency) {
  const inside = new Set(component);
  let count = 0;
  for (const id of component) {
    for (const next of adjacency.get(id) || []) {
      if (!inside.has(next)) {
        count += 1;
        break;
      }
    }
  }
  return count;
}

function recordRun(db, kind, status, durationMs, details) {
  try {
    db.prepare(
      "INSERT INTO derived_state_runs(built_at, kind, status, duration_ms, details_json) VALUES (?, ?, ?, ?, ?)",
    ).run(new Date().toISOString(), kind, status, Math.max(0, Math.round(durationMs)), JSON.stringify(details || {}));
  } catch {
    // Derived-state run telemetry must never break retrieval.
  }
}

/**
 * @param {import("better-sqlite3").Database} db
 * @param {string} name
 */
function rollbackSavepoint(db, name) {
  try {
    db.exec(`ROLLBACK TO ${name}`);
  } catch {
    // The original writer failure is more useful than rollback noise.
  }
  try {
    db.exec(`RELEASE ${name}`);
  } catch {
    // Ignore cleanup failures; callers get the structured refresh error.
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
