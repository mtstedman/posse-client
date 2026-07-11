// @ts-check
//
// Query planner. Turns a natural-language task string into a structured
// retrieval plan: identifiers, path/file hints, stack frames, language
// hints, a coarse symptom label, and a deduped keyword list.
//
// The plan is the v2 substitute for "throw the whole task at FTS and pray".
// Backends consume specific facets:
//   - FTS probes identifiers first (exact-name match), then file/path
//     terms, then keyword token combinations.
//   - Vector search can still use the raw text, but the plan gives it
//     better seed terms when the encoder degrades.
//   - Task-query ranking favors symbols whose names overlap identifiers
//     more than they overlap stop-word soup.
//
// Plan construction (facet extraction, symptom classification, stop-word
// handling) is owned by the native posse-atlas binary — the only
// implementation path. Every call routes through the warmed native worker.

import { runAtlasNativeOperationAsync } from "../../native/invoke.js";

/** @typedef {import("./query-planner-types.js").StackFrame} StackFrame */
/** @typedef {import("./query-planner-types.js").QueryPlan} QueryPlan */

/** @type {Map<string, QueryPlan>} */
const SYNC_PLAN_CACHE = new Map();
const SYNC_PLAN_CACHE_MAX = 256;
let _syncPlanCacheHits = 0;
let _syncPlanCacheMisses = 0;

/**
 * Produce a QueryPlan for a raw task/query string through the warmed native
 * worker.
 *
 * Always returns a plan, even for empty/garbage input — callers can treat
 * `plan.raw === ""` as the "nothing to plan" signal without null checks.
 *
 * @param {string | undefined | null} input
 * @returns {Promise<QueryPlan>}
 */
export async function planQuery(input) {
  const key = String(input ?? "");
  const cached = SYNC_PLAN_CACHE.get(key);
  if (cached) {
    _syncPlanCacheHits += 1;
    SYNC_PLAN_CACHE.delete(key);
    SYNC_PLAN_CACHE.set(key, cached);
    return clonePlan(cached);
  }
  _syncPlanCacheMisses += 1;
  // Cache the resolved plan value, not the promise: a native failure throws
  // before we reach cacheSyncPlan, so nothing is memoized and the next call
  // retries the daemon rather than replaying a rejected promise.
  const plan = normalizeNativePlan(/** @type {any} */ (await runAtlasNativeOperationAsync({ op: "plan_query", input })));
  cacheSyncPlan(key, plan);
  return clonePlan(plan);
}

/**
 * Lexical, JS-only safety net used after conductor-local native planner
 * retries are exhausted. It is deliberately conservative: enough structure
 * for FTS probes, no attempt to duplicate native classification quality.
 *
 * @param {string | undefined | null} input
 * @returns {QueryPlan}
 */
export function fallbackQueryPlan(input) {
  const raw = String(input || "").trim();
  const paths = unique([...raw.matchAll(PATH_RE)].map((match) => normalizePath(match[0])));
  const fileNames = unique(paths.map((entry) => entry.split("/").pop()).filter(Boolean));
  const pathIdentifierParts = new Set(paths.flatMap(pathIdentifierTokens).map((entry) => entry.toLowerCase()));
  const identifiers = unique([...raw.matchAll(IDENTIFIER_RE)]
    .map((match) => match[0])
    .filter((entry) => !STOP_WORDS.has(entry.toLowerCase()))
    .filter((entry) => !pathIdentifierParts.has(entry.toLowerCase()))
    .filter((entry) => !looksLikeFileExtension(entry)));
  const languageHints = unique([
    ...paths.map(languageHintForPath).filter(Boolean),
    ...languageHintsFromText(raw),
  ]);
  const keywords = unique([...raw.matchAll(WORD_RE)]
    .map((match) => match[0].toLowerCase())
    .filter((entry) => entry.length >= 3 && !STOP_WORDS.has(entry))
    .filter((entry) => !fileNames.some((name) => String(name).toLowerCase() === entry)))
    .slice(0, 24);
  return {
    raw,
    identifiers,
    paths,
    fileNames,
    stackFrames: [],
    languageHints,
    symptom: null,
    keywords,
    identifierLike: identifiers.length === 1 && keywords.length <= 1 && !/\s/.test(raw),
  };
}

/**
 * @param {any} plan
 * @returns {QueryPlan}
 */
function normalizeNativePlan(plan) {
  // Boundary normalization, not a fallback: the binary's wire shape names the
  // frame function `fnName` and leaves `file` OS-separated, while the QueryPlan
  // contract (and consumers like the FTS backend) read `fn` and repo-style
  // forward slashes. Map here until the binary emits the contract shape.
  if (Array.isArray(plan?.stackFrames)) {
    plan.stackFrames = plan.stackFrames.map((frame) => ({
      fn: String(frame?.fn ?? frame?.fnName ?? ""),
      ...(frame?.file != null ? { file: String(frame.file).replace(/\\/g, "/") } : {}),
      ...(frame?.line != null ? { line: frame.line } : {}),
    }));
  }
  return /** @type {QueryPlan} */ (plan);
}

/**
 * @param {string} key
 * @param {QueryPlan} plan
 */
function cacheSyncPlan(key, plan) {
  if (SYNC_PLAN_CACHE.has(key)) SYNC_PLAN_CACHE.delete(key);
  SYNC_PLAN_CACHE.set(key, clonePlan(plan));
  while (SYNC_PLAN_CACHE.size > SYNC_PLAN_CACHE_MAX) {
    const oldest = SYNC_PLAN_CACHE.keys().next().value;
    if (oldest == null) break;
    SYNC_PLAN_CACHE.delete(oldest);
  }
}

/**
 * @param {QueryPlan} plan
 * @returns {QueryPlan}
 */
function clonePlan(plan) {
  return JSON.parse(JSON.stringify(plan));
}

/**
 * @param {string} value
 */
function normalizePath(value) {
  return value.replace(/\\/g, "/").replace(/^['"`(]+|[,'"`).:;]+$/g, "");
}

/**
 * @param {string} value
 */
function looksLikeFileExtension(value) {
  return value.length <= 5 && value.startsWith(".");
}

/**
 * @template T
 * @param {Array<T | null | undefined | false | "">} values
 * @returns {T[]}
 */
function unique(values) {
  const out = [];
  const seen = new Set();
  for (const value of values) {
    if (!value) continue;
    const key = String(value);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(/** @type {T} */ (value));
  }
  return out;
}

/**
 * @param {string} path
 */
function languageHintForPath(path) {
  const ext = String(path.split(".").pop() || "").toLowerCase();
  return EXT_LANGUAGE_HINTS.get(ext) || null;
}

/**
 * @param {string} text
 */
function languageHintsFromText(text) {
  const lower = text.toLowerCase();
  const out = [];
  for (const [needle, language] of LANGUAGE_WORD_HINTS) {
    if (lower.includes(needle)) out.push(language);
  }
  return out;
}

/**
 * @param {string} filePath
 */
function pathIdentifierTokens(filePath) {
  return filePath
    .split(/[\\/.-]+/g)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

const PATH_RE = /(?:[A-Za-z0-9_.-]+[\\/])+(?:[A-Za-z0-9_.-]+)(?:\.[A-Za-z0-9]+)?/g;
const IDENTIFIER_RE = /[A-Za-z_$][A-Za-z0-9_$]*(?:(?:\.|::|#)[A-Za-z_$][A-Za-z0-9_$]*)*/g;
const WORD_RE = /[A-Za-z][A-Za-z0-9_'-]*/g;

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "but", "by", "can", "could",
  "debug", "fix", "for", "from", "how", "in", "into", "is", "it", "its",
  "not", "of", "on", "or", "our", "please", "regression", "the", "this",
  "to", "when", "where", "while", "with",
]);

const EXT_LANGUAGE_HINTS = new Map([
  ["c", "c"],
  ["cc", "cpp"],
  ["cpp", "cpp"],
  ["cs", "cs"],
  ["go", "go"],
  ["java", "java"],
  ["js", "js"],
  ["jsx", "js"],
  ["mjs", "js"],
  ["py", "py"],
  ["rs", "rs"],
  ["ts", "ts"],
  ["tsx", "ts"],
]);

const LANGUAGE_WORD_HINTS = [
  ["c#", "cs"],
  ["csharp", "cs"],
  ["c++", "cpp"],
  ["cpp", "cpp"],
  ["golang", "go"],
  ["javascript", "js"],
  ["python", "py"],
  ["rust", "rs"],
  ["typescript", "ts"],
];

export function __testResetQueryPlanCache() {
  SYNC_PLAN_CACHE.clear();
  _syncPlanCacheHits = 0;
  _syncPlanCacheMisses = 0;
}

export function __testQueryPlanCacheState() {
  return {
    size: SYNC_PLAN_CACHE.size,
    hits: _syncPlanCacheHits,
    misses: _syncPlanCacheMisses,
    keys: [...SYNC_PLAN_CACHE.keys()],
  };
}
