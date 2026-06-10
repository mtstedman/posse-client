// @ts-check
//
// Predictive prefetch telemetry for Atlas hot reads. The actual warmed
// payloads live in RetrievalCache; this module records which warmed keys were
// predicted, later consumed, or expired without being used.

const DEFAULT_PREDICTION_TTL_MS = 5 * 60 * 1000;
const MAX_PREDICTIONS = 10_000;

/** @type {Map<string, { predictedAt: number, source: string, target: string | null, latencyEstimateMs: number }>} */
const PREDICTIONS = new Map();

const STATE = {
  completed: 0,
  cancelled: 0,
  cacheHits: 0,
  cacheMisses: 0,
  wastedPrefetch: 0,
  totalLatencyReductionMs: 0,
  highWaterMark: 0,
  lastRunAt: /** @type {string | null} */ (null),
};

/**
 * @param {{ kind: "card" | "slice", key: string, source: string, target?: string | null, latencyEstimateMs?: number }} args
 */
export function recordPrefetchPrediction(args) {
  pruneExpiredPredictions();
  const id = predictionId(args.kind, args.key);
  if (PREDICTIONS.has(id)) PREDICTIONS.delete(id);
  PREDICTIONS.set(id, {
    predictedAt: Date.now(),
    source: args.source,
    target: args.target || null,
    latencyEstimateMs: clampLatency(args.latencyEstimateMs),
  });
  prunePredictionCapacity();
  STATE.completed += 1;
  STATE.highWaterMark = Math.max(STATE.highWaterMark, PREDICTIONS.size);
  STATE.lastRunAt = new Date().toISOString();
}

/**
 * @param {{ kind: "card" | "slice", key: string, hit: boolean }} args
 */
export function recordPrefetchAccess(args) {
  const id = predictionId(args.kind, args.key);
  const predicted = PREDICTIONS.get(id);
  if (!predicted) return;
  PREDICTIONS.delete(id);
  if (args.hit) {
    STATE.cacheHits += 1;
    STATE.totalLatencyReductionMs += predicted.latencyEstimateMs;
  } else {
    STATE.cacheMisses += 1;
  }
}

/**
 * @param {{ enabled?: boolean, predictiveEnabled?: boolean, reason?: string | null }} [opts]
 */
export function getPrefetchStats(opts = {}) {
  pruneExpiredPredictions();
  const attempts = STATE.cacheHits + STATE.cacheMisses;
  const terminal = STATE.cacheHits + STATE.cacheMisses + STATE.wastedPrefetch;
  return {
    enabled: opts.enabled ?? true,
    predictiveEnabled: opts.predictiveEnabled ?? true,
    strategy: "predictive-card-cache",
    queueDepth: PREDICTIONS.size,
    highWaterMark: STATE.highWaterMark,
    running: 0,
    completed: STATE.completed,
    cancelled: STATE.cancelled,
    cacheHits: STATE.cacheHits,
    cacheMisses: STATE.cacheMisses,
    wastedPrefetch: STATE.wastedPrefetch,
    hitRate: attempts > 0 ? STATE.cacheHits / attempts : null,
    wasteRate: terminal > 0 ? STATE.wastedPrefetch / terminal : null,
    avgLatencyReductionMs: STATE.cacheHits > 0 ? STATE.totalLatencyReductionMs / STATE.cacheHits : null,
    lastRunAt: STATE.lastRunAt,
    reason: opts.reason ?? null,
  };
}

export function __resetPrefetchStatsForTests() {
  PREDICTIONS.clear();
  STATE.completed = 0;
  STATE.cancelled = 0;
  STATE.cacheHits = 0;
  STATE.cacheMisses = 0;
  STATE.wastedPrefetch = 0;
  STATE.totalLatencyReductionMs = 0;
  STATE.highWaterMark = 0;
  STATE.lastRunAt = null;
}

function pruneExpiredPredictions() {
  const now = Date.now();
  for (const [id, entry] of PREDICTIONS) {
    if (now - entry.predictedAt <= DEFAULT_PREDICTION_TTL_MS) continue;
    PREDICTIONS.delete(id);
    STATE.wastedPrefetch += 1;
  }
}

function prunePredictionCapacity() {
  while (PREDICTIONS.size > MAX_PREDICTIONS) {
    const oldest = PREDICTIONS.keys().next().value;
    if (oldest == null) break;
    PREDICTIONS.delete(String(oldest));
    STATE.cancelled += 1;
  }
}

/**
 * @param {"card" | "slice"} kind
 * @param {string} key
 */
function predictionId(kind, key) {
  return `${kind}:${key}`;
}

/**
 * @param {unknown} value
 */
function clampLatency(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 25;
  return Math.max(0, Math.min(10_000, n));
}
