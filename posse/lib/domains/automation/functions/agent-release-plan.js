// Pure release-reconciler decisions: release identity, desired-state keys,
// recorded state transitions, the fallback reconciler, smoke failure
// classes, crash-loop policy and pruning.

import crypto from "node:crypto";

import {
  AGENT_RELEASE_FALLBACK_RETRY_STAGES,
  AGENT_RELEASE_LIMITS,
  AGENT_RELEASE_MANIFEST_SCHEMA,
  AGENT_RELEASE_RESULTS,
  AGENT_RELEASE_SMOKE,
  AGENT_RELEASE_STATE_SCHEMA,
} from "../../../catalog/agent-release.js";

// A release directory: a 9-hex posse sha, then the native products it carries.
export const AGENT_RELEASE_ID_PATTERN = /^[0-9a-f]{9}(?:-[A-Za-z0-9._-]+)?$/;
export const AGENT_RELEASE_SHA_PATTERN = /^[0-9a-f]{40}$/;

/**
 * @typedef {{ product: string, version: string, arch: string, sha256: string }} ReleaseProduct
 * @typedef {{ sha: string, products: ReleaseProduct[] }} DesiredRelease
 */

/** @param {DesiredRelease} desired */
export function releaseIdFor(desired) {
  const products = desired.products.map(item => `${item.product}-${item.version}`);
  return [desired.sha.slice(0, 9), ...products].join("-");
}

/**
 * Everything that makes two releases the same: the posse commit and each
 * native binary's exact bytes.
 *
 * @param {DesiredRelease} desired
 */
export function desiredKey(desired) {
  const products = [...desired.products].sort((a, b) => a.product.localeCompare(b.product))
    .map(item => `${item.product}@${item.version}/${item.arch}#${item.sha256}`);
  return [desired.sha, ...products].join("+");
}

/**
 * The directory names `desired` may be staged under, in order: its release id,
 * then the id plus a short hash of its inputs. An existing release directory
 * is never replaced, so inputs that collide with another release's id (the
 * same version rebuilt with other bytes) take the second name.
 *
 * @param {DesiredRelease} desired
 */
export function releaseIdCandidates(desired) {
  const id = releaseIdFor(desired);
  return [id, `${id}-${crypto.createHash("sha256").update(desiredKey(desired)).digest("hex").slice(0, 8)}`];
}

/** @param {DesiredRelease} desired @param {{ lockSha256: string, stagedAt: string, nodeModules: string }} details */
export function releaseManifest(desired, { lockSha256, stagedAt, nodeModules }) {
  return {
    schema: AGENT_RELEASE_MANIFEST_SCHEMA,
    id: releaseIdFor(desired),
    sha: desired.sha,
    products: desired.products.map(({ product, version, arch, sha256 }) => ({ product, version, arch, sha256 })),
    package_lock_sha256: lockSha256,
    node_modules: nodeModules,
    staged_at: stagedAt,
  };
}

/** A manifest read back from disk, or null when it is not one of ours. */
export function parseReleaseManifest(text) {
  try {
    const manifest = JSON.parse(text);
    if (manifest?.schema !== AGENT_RELEASE_MANIFEST_SCHEMA || !AGENT_RELEASE_SHA_PATTERN.test(manifest.sha)
      || !Array.isArray(manifest.products)) return null;
    return manifest;
  } catch { return null; }
}

/** @param {any} manifest @param {DesiredRelease} desired */
export function sameInputs(manifest, desired) {
  return Boolean(manifest) && desiredKey(manifest) === desiredKey(desired);
}

// rolling_back_to: a rollback swapped `current` but has not installed it yet.
// fallback: the release AGENT_RELEASE_PATHS.fallback points at.
// reconciler_runs: release id -> the last run of the reconciler shipped in
//   that release: { started_at, at, result, ok }. A run that started but never
//   finished (killed, or its final write failed) has only started_at.
// failed: desired-state key -> { at, by, stage, release, reason, ... }; `by` is
//   the release whose reconciler recorded the failure.
// drain_timeouts: consecutive runs that ended in a drain timeout.
export function emptyReleaseState() {
  return { schema: AGENT_RELEASE_STATE_SCHEMA, current: "", known_good: "", previous_known_good: "", rolling_back_to: "",
    fallback: "", swapped_at: "", restart_baseline: {}, failed: {}, reconciler_runs: {}, drain_timeouts: 0, last_result: null,
    last_failure: null };
}

/** A state file's parsed contents, normalized; anything unreadable starts fresh. */
export function normalizeReleaseState(value) {
  const state = emptyReleaseState();
  if (!value || typeof value !== "object" || value.schema !== AGENT_RELEASE_STATE_SCHEMA) return state;
  for (const key of ["current", "known_good", "previous_known_good", "rolling_back_to", "fallback", "swapped_at"]) {
    if (typeof value[key] === "string") state[key] = value[key];
  }
  if (Number.isSafeInteger(value.drain_timeouts) && value.drain_timeouts > 0) state.drain_timeouts = value.drain_timeouts;
  if (value.restart_baseline && typeof value.restart_baseline === "object") state.restart_baseline = { ...value.restart_baseline };
  if (value.failed && typeof value.failed === "object") state.failed = { ...value.failed };
  if (value.reconciler_runs && typeof value.reconciler_runs === "object") {
    state.reconciler_runs = Object.fromEntries(Object.entries(value.reconciler_runs)
      .filter(([id, run]) => AGENT_RELEASE_ID_PATTERN.test(id) && run && typeof run === "object")
      .map(([id, run]) => [id, normalizeReconcilerRun(run)]));
  }
  state.last_result = value.last_result ?? null;
  state.last_failure = value.last_failure ?? null;
  return state;
}

/**
 * Remember that a desired state failed, so it is not retried until the posse
 * sha or a native binary changes. Keeps the newest failures only.
 */
export function recordFailedInputs(state, key, failure, max = AGENT_RELEASE_LIMITS.maxRecordedFailures) {
  const failed = { ...state.failed, [key]: failure };
  const kept = Object.entries(failed).sort(([, a], [, b]) => String(b.at).localeCompare(String(a.at))).slice(0, max);
  return { ...state, failed: Object.fromEntries(kept) };
}

/**
 * Whether a recorded failure still keeps its inputs from being tried at
 * `nowMs`. A deterministic failure does until the inputs change (or
 * --retry). A transient smoke failure does only until `retryAfterMs` has
 * passed since it, and only while fewer than `attempts` smokes of those
 * inputs have failed that way; after that it is remembered like any other.
 *
 * A fallback run (`fallback`: the release whose reconciler runs it) is the
 * one exception: a failure another release's reconciler recorded at a stage
 * the fallback redoes in full (AGENT_RELEASE_FALLBACK_RETRY_STAGES) may be
 * that reconciler's own bug, so it does not block; the fallback tries the
 * inputs itself, and its own failure then blocks every run. A transient
 * failure still waiting for its retry time blocks a fallback run too.
 *
 * @param {any} failure a `failed` entry, or undefined
 * @param {number} nowMs
 * @param {{ fallback?: string, attempts?: number, retryAfterMs?: number }} [options]
 * @returns {{ blocks: boolean, retryAtMs: number | null, fallbackRetry: boolean }}
 *   retryAtMs: when a transient failure may be tried again; fallbackRetry: the
 *   inputs are tried only because this is a fallback run
 */
export function failureHold(failure, nowMs, { fallback = "", attempts = AGENT_RELEASE_LIMITS.transientSmokeAttempts,
  retryAfterMs = AGENT_RELEASE_LIMITS.transientSmokeRetrySeconds * 1000 } = {}) {
  if (!failure) return { blocks: false, retryAtMs: null, fallbackRetry: false };
  if (failure.transient === true && Number(failure.attempts) < attempts) {
    const at = Date.parse(failure.at);
    const retryAtMs = Number.isFinite(at) ? at + retryAfterMs : nowMs;
    return { blocks: nowMs < retryAtMs, retryAtMs, fallbackRetry: false };
  }
  const fallbackRetry = Boolean(fallback) && failure.by !== fallback && AGENT_RELEASE_FALLBACK_RETRY_STAGES.includes(failure.stage);
  return { blocks: !fallbackRetry, retryAtMs: null, fallbackRetry };
}

/**
 * Classify a finished smoke from its structured result, the last JSON line it
 * printed, never from free text. Transient means the provider or the network
 * failed (AGENT_RELEASE_SMOKE.transientFailureClasses), not the release.
 *
 * @param {string} stdout
 * @returns {{ failureClass: string, transient: boolean }}
 */
export function classifySmokeOutput(stdout) {
  let last = null;
  try { last = JSON.parse(String(stdout || "").trim().split("\n").pop()); } catch { last = null; }
  const failureClass = last?.ok === false && typeof last.failure?.class === "string" ? last.failure.class : "";
  return { failureClass, transient: AGENT_RELEASE_SMOKE.transientFailureClasses.includes(failureClass) };
}

/** @typedef {{ started_at?: string, at?: string, result?: string, ok?: boolean }} ReconcilerRun */

/** @returns {ReconcilerRun} */
function normalizeReconcilerRun(run) {
  const kept = {};
  for (const key of ["started_at", "at", "result"]) if (typeof run[key] === "string" && run[key]) kept[key] = run[key];
  if (kept.at) kept.ok = run.ok === true;
  return kept;
}

/** Keep the reconcilers that ran most recently. */
function keepNewestRuns(runs, max) {
  const latest = run => Math.max(...[run.started_at, run.at].map(value => Date.parse(value ?? "")).filter(Number.isFinite), 0);
  return Object.fromEntries(Object.entries(runs).sort(([, a], [, b]) => latest(b) - latest(a)).slice(0, max));
}

/**
 * Remember that release `id`'s own reconciler started a run at `at`. Until
 * the run finishes, its record has no result, so a run that dies part way
 * reads as not ok.
 */
export function recordReconcilerStart(state, id, at, max = AGENT_RELEASE_LIMITS.maxRecordedReconcilers) {
  if (!id) return state;
  return { ...state, reconciler_runs: keepNewestRuns({ ...state.reconciler_runs, [id]: { started_at: at } }, max) };
}

/** Remember how release `id`'s own reconciler ended its run. */
export function recordReconcilerResult(state, id, { at, result, ok }, max = AGENT_RELEASE_LIMITS.maxRecordedReconcilers) {
  if (!id) return state;
  const started = state.reconciler_runs[id]?.started_at;
  const run = { ...(started ? { started_at: started } : {}), at, result, ok: ok === true };
  return { ...state, reconciler_runs: keepNewestRuns({ ...state.reconciler_runs, [id]: run }, max) };
}

/**
 * Where the fallback link moves after a run of the reconciler shipped in
 * release `self`: to `self` only when that run completed a real upgrade
 * (AGENT_RELEASE_RESULTS[result].proves, that is `installed`), so `self`'s
 * own code staged, gated, drained, swapped and installed a release. A noop, a
 * skip, a drain timeout or a repair proves nothing, and neither does
 * finishing the install of a swap an earlier run made (`resumed`). This
 * covers the bootstrap too: the hand-placed release's reconciler takes the
 * link when it installs the first managed release, and a failed bootstrap
 * leaves no link.
 *
 * @param {{ self: string, linked: string, result: string, resumed?: boolean }} run
 * @returns {string} the release the link should name now, or "" to leave it
 */
export function fallbackPromotion({ self, linked, result, resumed = false }) {
  if (!self || linked === self || resumed) return "";
  return AGENT_RELEASE_RESULTS[result]?.proves === true ? self : "";
}

/**
 * What a run started by the fallback unit does. That unit starts only when
 * the reconcile service in `current` failed; `self` is the fallback release.
 * - "idle": `self` is `current` (running again would repeat the failed run),
 *   or `current`'s reconciler ran since its swap and its last run was ok (the
 *   service failed before that reconciler got going, on something this run
 *   shares, such as release.env).
 * - "replace": `current`'s reconciler has not run at all since its swap: it
 *   crashes on import, so it can neither update nor repair. Roll the owner
 *   back to `self`, a proven reconciler. Only when state names `current` as
 *   the release the reconcilers swapped in (so the failure is attributed to
 *   it from state) and `self` ran as a known-good owner before it; a
 *   hand-placed bootstrap release never ran as one, so after a bootstrap the
 *   fallback reconciles on `current`'s behalf instead.
 * - "reconcile": otherwise, notably when `current`'s last run was not ok or
 *   never finished: a whole pass from here on `current`'s behalf.
 * replace and reconcile both finish an interrupted swap or rollback first.
 *
 * @param {{ self: string, current: string, state: ReturnType<typeof emptyReleaseState> }} run
 * @returns {"idle" | "replace" | "reconcile"}
 */
export function fallbackRunAction({ self, current, state }) {
  if (!self || !current) return "reconcile";
  if (self === current) return "idle";
  const run = state.reconciler_runs[current];
  const lastStart = Date.parse(run?.started_at || run?.at || "");
  // A hand swap leaves no swap time for `current`: any recorded run counts.
  const swappedAt = state.current === current ? Date.parse(state.swapped_at) : Number.NaN;
  if (!Number.isFinite(lastStart) || lastStart < swappedAt) {
    const provenOwner = self === state.known_good || self === state.previous_known_good;
    return state.current === current && provenOwner ? "replace" : "reconcile";
  }
  return run.ok === true && run.at ? "idle" : "reconcile";
}

/** Record a run's outcome; a non-ok result also becomes the last failure. */
export function recordRunResult(state, outcome) {
  const next = { ...state, last_result: outcome };
  if (!AGENT_RELEASE_RESULTS[outcome.result]?.ok) next.last_failure = outcome;
  return next;
}

/**
 * Decide what an unhealthy or restart-looping owner needs. A loop soon after
 * a swap rolls back to the release before it; otherwise the current release
 * is reinstalled.
 *
 * @param {{ healthy: boolean, restarts: Record<string, number>, baseline?: Record<string, number>,
 *   swappedAtMs?: number, nowMs: number, currentId: string, rollbackId?: string,
 *   threshold?: number, recentMs?: number }} input
 * @returns {"ok" | "rollback" | "reinstall"}
 */
export function crashLoopAction({ healthy, restarts, baseline = {}, swappedAtMs, nowMs, currentId, rollbackId = "",
  threshold = AGENT_RELEASE_LIMITS.crashLoopRestarts, recentMs = AGENT_RELEASE_LIMITS.recentSwapSeconds * 1000 }) {
  const since = name => {
    const count = Number(restarts[name]) || 0, base = Number(baseline[name]) || 0;
    // systemd resets NRestarts on a manual start; a smaller count is all new.
    return count >= base ? count - base : count;
  };
  const looping = Object.keys(restarts).some(name => since(name) >= threshold);
  if (healthy && !looping) return "ok";
  const recent = Number.isFinite(swappedAtMs) && nowMs - swappedAtMs <= recentMs;
  return recent && rollbackId && rollbackId !== currentId ? "rollback" : "reinstall";
}

/**
 * Release directories to delete: everything but the protected releases and
 * the newest `keep` others.
 *
 * @param {{ name: string, mtimeMs: number }[]} entries
 * @param {Set<string>} protect
 * @param {number} keep
 */
export function selectPrunable(entries, protect, keep) {
  return entries.filter(entry => AGENT_RELEASE_ID_PATTERN.test(entry.name) && !protect.has(entry.name))
    .sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name))
    .slice(keep).map(entry => entry.name);
}
