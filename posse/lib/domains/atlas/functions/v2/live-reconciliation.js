// @ts-check
//
// Lightweight live-index reconciliation telemetry. The current Atlas live path
// is buffer-overlay based; this records the same operational signals a future
// watcher/debounce worker will own, without changing write semantics.

import path from "path";

/** @type {Map<string, LiveState>} */
const STATES = new Map();
const LIVE_STATE_LIMIT = 1000;
const LIVE_STATE_TTL_MS = 60 * 60 * 1000;
const FRONTIER_FILE_LIMIT = 500;

/**
 * @typedef {Object} LiveState
 * @property {number} eventsReceived
 * @property {number} eventsProcessed
 * @property {number} errors
 * @property {number} restartCount
 * @property {number} checkpoints
 * @property {number} successfulCheckpoints
 * @property {string | null} lastEventAt
 * @property {string | null} lastProcessedAt
 * @property {string | null} lastSuccessfulReindexAt
 * @property {Set<string>} frontierFiles
 * @property {number} updatedAtMs
 */

/**
 * @param {{ repoRoot?: string, filePath: string, eventType?: string, parsed?: boolean, dirty?: boolean, updatedAt?: string }} args
 */
export function recordLiveBufferEvent(args) {
  const state = stateFor(args.repoRoot);
  const at = args.updatedAt || new Date().toISOString();
  state.eventsReceived += 1;
  state.eventsProcessed += 1;
  state.lastEventAt = at;
  state.lastProcessedAt = at;
  if (args.dirty !== false) addFrontierFile(state, args.filePath);
  else state.frontierFiles.delete(args.filePath);
  state.updatedAtMs = Date.now();
  if (args.parsed === false) state.errors += 1;
}

/**
 * @param {{ repoRoot?: string, filePath: string, cleared?: boolean, wroteToDisk?: boolean, diskMatches?: boolean }} args
 */
export function recordLiveCheckpoint(args) {
  const state = stateFor(args.repoRoot);
  const at = new Date().toISOString();
  state.checkpoints += 1;
  state.lastProcessedAt = at;
  if (args.cleared) state.frontierFiles.delete(args.filePath);
  if (args.wroteToDisk || args.diskMatches) {
    state.successfulCheckpoints += 1;
    state.lastSuccessfulReindexAt = at;
  }
  state.updatedAtMs = Date.now();
}

/**
 * @param {{
 *   repoRoot?: string,
 *   buffers?: number,
 *   dirtyBuffers?: number,
 *   parsedBuffers?: number,
 *   parseFailureCount?: number,
 *   lastBufferAt?: string | null,
 * }} args
 */
export function liveReconciliationStatus(args = {}) {
  const state = stateFor(args.repoRoot);
  const dirtyBuffers = Number(args.dirtyBuffers || 0);
  const parsedBuffers = Number(args.parsedBuffers || 0);
  const parseFailureCount = Number(args.parseFailureCount || 0);
  const frontier = Array.from(state.frontierFiles).sort().slice(0, 50);
  return {
    enabled: true,
    mode: "buffer-reconciliation",
    running: true,
    debounceMs: 250,
    idle: dirtyBuffers === 0,
    stale: parseFailureCount > 0,
    queueDepth: dirtyBuffers,
    eventsReceived: state.eventsReceived,
    eventsProcessed: state.eventsProcessed,
    errors: state.errors,
    restartCount: state.restartCount,
    lastEventAt: state.lastEventAt || args.lastBufferAt || null,
    lastProcessedAt: state.lastProcessedAt || args.lastBufferAt || null,
    lastSuccessfulReindexAt: state.lastSuccessfulReindexAt,
    dependencyFrontier: {
      fileCount: Math.max(dirtyBuffers, state.frontierFiles.size),
      files: frontier,
    },
    overlayEmbeddingCache: {
      entries: parsedBuffers,
      misses: parseFailureCount,
    },
    checkpoints: {
      attempted: state.checkpoints,
      successful: state.successfulCheckpoints,
    },
  };
}

export function __resetLiveReconciliationForTests() {
  STATES.clear();
}

/**
 * @param {string | undefined} repoRoot
 */
function stateFor(repoRoot) {
  pruneStates();
  const key = path.resolve(repoRoot || ".");
  let state = STATES.get(key);
  if (!state) {
    state = {
      eventsReceived: 0,
      eventsProcessed: 0,
      errors: 0,
      restartCount: 0,
      checkpoints: 0,
      successfulCheckpoints: 0,
      lastEventAt: null,
      lastProcessedAt: null,
      lastSuccessfulReindexAt: null,
      frontierFiles: new Set(),
      updatedAtMs: Date.now(),
    };
    STATES.set(key, state);
  }
  state.updatedAtMs = Date.now();
  return state;
}

/**
 * @param {LiveState} state
 * @param {string} filePath
 */
function addFrontierFile(state, filePath) {
  state.frontierFiles.delete(filePath);
  state.frontierFiles.add(filePath);
  while (state.frontierFiles.size > FRONTIER_FILE_LIMIT) {
    const oldest = state.frontierFiles.values().next().value;
    if (oldest == null) break;
    state.frontierFiles.delete(String(oldest));
  }
}

function pruneStates() {
  const now = Date.now();
  for (const [key, state] of STATES) {
    if (now - state.updatedAtMs <= LIVE_STATE_TTL_MS) continue;
    STATES.delete(key);
  }
  while (STATES.size > LIVE_STATE_LIMIT) {
    const oldest = STATES.keys().next().value;
    if (oldest == null) break;
    STATES.delete(String(oldest));
  }
}
