// @ts-check
//
// Conductor-side retrieval dispatch: runs read-only ATLAS v2 tool calls in
// the conductor thread so the synchronous better-sqlite3 work (graph walks,
// tree scoring, skeleton assembly, slice hydration) never blocks the
// orchestrator event loop.
//
// View/Ledger handles are cached behind a writer-priority gate. Indexing
// writers ask this lane to begin a write hold before mutating view/ledger
// files; the hold waits for active reads, retires cached handles, then blocks
// new reads until the writer sends end-write. This keeps steady-state reads
// warm without the Windows EPERM footgun around view rebuilds.
//
// Embedding resources (ANN child process + encoder) are the opposite: opening
// them per request forks a process and initializes an encoder, so they are
// CACHED per (readRoot, provider/backend) and invalidated whenever this same
// thread runs an indexing op (warm/merge/ingest rewrite the ANN on disk).

import { View } from "../../../classes/v2/View.js";
import { Ledger } from "../../../classes/v2/Ledger.js";
import { dispatch, normalizeActionName } from "../retrieval/index.js";
import { openEmbeddingResources, retirePooledEmbeddingResources, semanticDispatchEnabled } from "../embeddings/resources.js";
import { getRetrievalCache } from "../../../classes/v2/RetrievalCache.js";
import { fallbackQueryPlan, planQuery } from "../retrieval/orchestrator/query-planner.js";
import { AsyncResourceGate } from "../../../../../shared/concurrency/classes/AsyncGate.js";
import fs from "node:fs";
import path from "node:path";
import { ledgerDbPath, mainViewPath, worktreeViewPath } from "../runtime-paths.js";
import { waitForCurrentView } from "../view-health.js";
import { ATLAS_TOOL_ACTIONS } from "../contracts/tool-params.js";
import { resolveTargetBranch } from "../../../../git/functions/target-branch.js";
import { invalidateStorageCacheNativeAsync } from "../native/storage.js";

/** @type {Map<string, any>} */
const RETRIEVE_RESOURCES = new Map();
/** @type {Map<string, { viewPath: string | null, ledgerPath: string | null, view: any, ledger: any }>} */
const RETRIEVE_DB_HANDLES = new Map();
/** @type {Map<string, { count: number, releasing: boolean, release: () => void, acquired: Promise<void>, result: Promise<any> }>} */
const RETRIEVE_WRITE_HOLDS = new Map();
/** @type {Map<string, { plan: import("../retrieval/orchestrator/query-planner-types.js").QueryPlan, expiresAt: number }>} */
const RETRIEVE_PLAN_CACHE = new Map();

const RETRIEVE_DB_GATE = new AsyncResourceGate({
  name: "ATLAS reader DB handles",
  policy: "writer-priority",
});
const PLAN_CACHE_MAX = 256;
const PLAN_CACHE_TTL_MS = 5 * 60 * 1000;

const conductorPlanQuery = createConductorPlanner({
  cache: RETRIEVE_PLAN_CACHE,
});

/**
 * @param {{
 *   planQueryImpl?: (input: string) => import("../retrieval/orchestrator/query-planner-types.js").QueryPlan | Promise<import("../retrieval/orchestrator/query-planner-types.js").QueryPlan>,
 *   fallbackPlan?: (input: string) => import("../retrieval/orchestrator/query-planner-types.js").QueryPlan,
 *   cache?: Map<string, { plan: import("../retrieval/orchestrator/query-planner-types.js").QueryPlan, expiresAt: number }>,
 *   now?: () => number,
 *   ttlMs?: number,
 *   capacity?: number,
 * }} options
 */
function createConductorPlanner({
  planQueryImpl = planQuery,
  fallbackPlan = fallbackQueryPlan,
  cache = new Map(),
  now = Date.now,
  ttlMs = PLAN_CACHE_TTL_MS,
  capacity = PLAN_CACHE_MAX,
} = {}) {
  return async function conductorPlanner(input) {
    const key = String(input || "").trim();
    const currentTime = now();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > currentTime) {
      return clonePlan(cached.plan);
    }

    let plan = null;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        plan = await planQueryImpl(key);
        break;
      } catch {
        plan = null;
      }
    }
    if (!plan) {
      plan = fallbackPlan(key);
    }
    cachePlan(cache, key, plan, currentTime + ttlMs, capacity);
    return clonePlan(plan);
  };
}

/**
 * @param {Map<string, { plan: import("../retrieval/orchestrator/query-planner-types.js").QueryPlan, expiresAt: number }>} cache
 * @param {string} key
 * @param {import("../retrieval/orchestrator/query-planner-types.js").QueryPlan} plan
 * @param {number} expiresAt
 * @param {number} capacity
 */
function cachePlan(cache, key, plan, expiresAt, capacity) {
  if (cache.has(key)) cache.delete(key);
  cache.set(key, { plan: clonePlan(plan), expiresAt });
  while (cache.size > capacity) {
    const oldest = cache.keys().next().value;
    if (oldest == null) break;
    cache.delete(oldest);
  }
}

/**
 * @param {import("../retrieval/orchestrator/query-planner-types.js").QueryPlan} plan
 */
function clonePlan(plan) {
  return JSON.parse(JSON.stringify(plan));
}

function resourcesKey(readRoot, config) {
  const root = resourcesKeyRoot(readRoot);
  const provider = String(config?.embeddingProvider || config?.atlasEmbeddingProvider || "");
  const backend = String(config?.vectorBackend || "");
  return `${root}\0${provider}\0${backend}`;
}

function resourcesKeyRoot(readRoot) {
  return String(readRoot || "").replace(/\\/g, "/");
}

function getRetrieveResources(readRoot, config) {
  const key = resourcesKey(readRoot, config);
  let resources = RETRIEVE_RESOURCES.get(key);
  if (!resources) {
    // The reader lane never ingests (on-demand fill is disabled here), so its
    // index opens read-only: no quarantine renames, no rebuild saves — a
    // mid-warm untrusted manifest rebuilds in memory instead of yanking the
    // live ANN out from under the writer's next checkpoint rename.
    resources = openEmbeddingResources({ repoRoot: readRoot, config: config || {}, readOnly: true });
    RETRIEVE_RESOURCES.set(key, resources);
  }
  return resources;
}

function dbHandleKey({ viewPath = null, ledgerPath = null, dbPath = null } = {}) {
  return [
    viewPath || dbPath || "",
    ledgerPath || "",
  ].map((entry) => String(entry || "").replace(/\\/g, "/").toLowerCase()).join("\0");
}

function getDbHandles({ viewPath = null, ledgerPath = null } = {}) {
  const key = dbHandleKey({ viewPath, ledgerPath });
  let entry = RETRIEVE_DB_HANDLES.get(key);
  if (!entry) {
    entry = { viewPath, ledgerPath, view: null, ledger: null };
    RETRIEVE_DB_HANDLES.set(key, entry);
  }
  if (viewPath && !entry.view) {
    entry.view = View.mount({ dbPath: viewPath, mode: "readonly" });
  }
  if (ledgerPath && !entry.ledger) {
    try {
      entry.ledger = Ledger.openReadOnly({ dbPath: ledgerPath });
    } catch {
      entry.ledger = null;
    }
  }
  return entry;
}

function closeDbHandleEntry(entry) {
  try { entry?.ledger?.close?.(); } catch { /* ignore */ }
  try { entry?.view?.close?.(); } catch { /* ignore */ }
  if (entry) {
    entry.ledger = null;
    entry.view = null;
  }
}

async function retireDbHandlesForKey(key) {
  const entry = RETRIEVE_DB_HANDLES.get(key);
  if (!entry) return;
  RETRIEVE_DB_HANDLES.delete(key);
  closeDbHandleEntry(entry);
  await invalidateStorageCacheNativeAsync([entry.viewPath, entry.ledgerPath]);
}

async function retireAllDbHandles() {
  const entries = [...RETRIEVE_DB_HANDLES.values()];
  RETRIEVE_DB_HANDLES.clear();
  for (const entry of entries) closeDbHandleEntry(entry);
  await invalidateStorageCacheNativeAsync(entries.flatMap((entry) => [entry.viewPath, entry.ledgerPath]));
}

// The embedding child is shared across ALL of a repo's views (keyed by readRoot,
// not the per-view dbHandleKey), so semantic reads register on this key and the
// cross-lane embedding writer holds it — draining every semantic reader of the
// index, not just readers of one view.
function embeddingsGateKey(readRoot) {
  return `emb\0${String(readRoot || "").replace(/\\/g, "/").toLowerCase()}`;
}

// Close + drop the cached embedding resources for this repo. Awaiting close()
// releases the child process's index.usearch handle — the confirmed close that
// lets the conductor rename the ANN without a Windows sharing violation.
async function retireEmbeddingResourcesForRoot(readRoot) {
  const root = resourcesKeyRoot(readRoot);
  const prefix = `${root}\0`;
  const retire = [];
  for (const [key, resources] of [...RETRIEVE_RESOURCES.entries()]) {
    if (key === root || key.startsWith(prefix)) {
      RETRIEVE_RESOURCES.delete(key);
      retire.push(resources);
    }
  }
  for (const resources of retire) {
    try { await resources?.close?.(); } catch { /* best effort */ }
  }
}

/**
 * Hold the reader-lane DB gate for an upcoming writer in another lane.
 * Returns only after active reads drain and cached handles for this asset are
 * closed; the hold stays active until endConductorRetrieveWrite() is called.
 *
 * @param {string} key
 * @param {() => void | Promise<void>} retire
 */
async function beginGateWriteHold(key, retire) {
  for (;;) {
    const existing = RETRIEVE_WRITE_HOLDS.get(key);
    if (!existing) break;
    if (!existing.releasing) {
      existing.count += 1;
      await existing.acquired;
      return { key, held: true, count: existing.count };
    }
    await existing.result.catch(() => {});
  }

  let release = () => {};
  let acquiredResolve = () => {};
  let acquiredReject = (_err) => {};
  let acquiredSettled = false;
  const releaseWait = new Promise((resolve) => { release = () => resolve(); });
  const acquired = new Promise((resolve, reject) => {
    acquiredResolve = () => {
      if (acquiredSettled) return;
      acquiredSettled = true;
      resolve();
    };
    acquiredReject = (err) => {
      if (acquiredSettled) return;
      acquiredSettled = true;
      reject(err);
    };
  });
  const result = RETRIEVE_DB_GATE.write(key, async () => {
    // Active reads on this key have drained (writer-priority); retire the cached
    // handles (await: an async retire confirms the close before the writer runs)
    // and block new reads until endGateWriteHold().
    await retire();
    acquiredResolve();
    await releaseWait;
    return { released: true };
  }, {
    label: "reader-db.write-hold",
    waitMs: 60_000,
  }).catch((err) => {
    acquiredReject(err);
    throw err;
  }).finally(() => {
    const current = RETRIEVE_WRITE_HOLDS.get(key);
    if (current?.result === result) RETRIEVE_WRITE_HOLDS.delete(key);
  });
  RETRIEVE_WRITE_HOLDS.set(key, { count: 1, releasing: false, release, acquired, result });
  await acquired;
  return { key, held: true, count: 1 };
}

async function endGateWriteHold(key) {
  const hold = RETRIEVE_WRITE_HOLDS.get(key);
  if (!hold) return { key, released: false };
  hold.count -= 1;
  if (hold.count > 0) return { key, released: false, count: hold.count };
  hold.releasing = true;
  hold.release();
  await hold.result.catch(() => {});
  return { key, released: true };
}

export async function beginConductorRetrieveWrite(payload = {}) {
  const key = dbHandleKey(payload);
  return beginGateWriteHold(key, async () => {
    await retireDbHandlesForKey(key);
    await invalidateStorageCacheNativeAsync([payload.viewPath || payload.dbPath, payload.ledgerPath]);
    // The upcoming write may rewrite views this thread has cached cards/
    // slices for — clear alongside the DB handles (same-version rewrites
    // don't change the cache's versionId key).
    try { getRetrievalCache().invalidateAll(); } catch { /* best effort */ }
  });
}

/**
 * @param {{ viewPath?: string | null, dbPath?: string | null, ledgerPath?: string | null }} payload
 */
export async function endConductorRetrieveWrite(payload = {}) {
  return endGateWriteHold(dbHandleKey(payload));
}

/**
 * Hold the embeddings gate for an upcoming ANN write in the conductor lane.
 * Drains active semantic reads of this repo's index, then closes the cached
 * embedding child (releasing its index.usearch handle) before returning, so the
 * conductor can rename the ANN without racing a live read handle. The hold stays
 * active until endConductorEmbeddingWrite().
 *
 * @param {string} readRoot
 */
export async function beginConductorEmbeddingWrite(readRoot) {
  return beginGateWriteHold(embeddingsGateKey(readRoot), () => retireEmbeddingResourcesForRoot(readRoot));
}

/** @param {string} readRoot */
export async function endConductorEmbeddingWrite(readRoot) {
  return endGateWriteHold(embeddingsGateKey(readRoot));
}

/**
 * Drop cached embedding resources. Called after every indexing op in this
 * thread: warm/merge/ingest rewrite the on-disk ANN, and the cached child
 * process holds the old index in memory.
 */
export async function invalidateConductorRetrieveResources() {
  const entries = [...RETRIEVE_RESOURCES.values()];
  RETRIEVE_RESOURCES.clear();
  for (const resources of entries) {
    try { await resources?.close?.(); } catch { /* best effort */ }
  }
  // Wrapper close above only refcounts pooled children; retire the pool
  // entries too so the next semantic retrieve forks a fresh child against the
  // rewritten ANN instead of resurrecting the stale in-memory index.
  try { retirePooledEmbeddingResources(); } catch { /* best effort */ }
  // RetrievalCache is a per-thread singleton: pipeline-event invalidation
  // fires in the writer/orchestrator threads and never reached this reader
  // thread, so a same-version view rewrite (repair/merge without a ledger-seq
  // bump) could serve stale cards/slices for up to the TTL.
  try { getRetrievalCache().invalidateAll(); } catch { /* best effort */ }
}

/** Full teardown for conductor close/dispose. */
export async function disposeConductorRetrieveResources() {
  for (const hold of [...RETRIEVE_WRITE_HOLDS.values()]) {
    try { hold.release(); } catch { /* best effort */ }
  }
  await Promise.all([...RETRIEVE_WRITE_HOLDS.values()].map((hold) => hold.result.catch(() => {})));
  RETRIEVE_WRITE_HOLDS.clear();
  await retireAllDbHandles();
  await invalidateConductorRetrieveResources();
  RETRIEVE_PLAN_CACHE.clear();
}

/**
 * @param {{
 *   call: Record<string, unknown>,
 *   viewPath?: string | null,
 *   ledgerPath?: string | null,
 *   versionId: string,
 *   readRoot?: string | null,
 *   repoId?: string | null,
 *   semantic?: boolean,
 *   taskText?: string | null,
 *   taskType?: string | null,
 *   config?: Record<string, unknown> | null,
 * }} payload
 */
export async function runConductorRetrieve(payload) {
  const viewPath = payload?.viewPath ? String(payload.viewPath) : null;
  const ledgerPath = payload?.ledgerPath ? String(payload.ledgerPath) : null;
  const readRoot = payload?.readRoot ? String(payload.readRoot) : null;
  const config = payload?.config && typeof payload.config === "object" ? payload.config : {};
  const gateKey = dbHandleKey({ viewPath, ledgerPath });
  let needsEmbeddings = payload.semantic === true && !!readRoot && semanticDispatchEnabled(config);
  return RETRIEVE_DB_GATE.read(gateKey, async () => {
    const handles = getDbHandles({ viewPath, ledgerPath });
    const view = handles.view;
    const ledger = handles.ledger;
    const runDispatch = async () => {
      let resources = null;
      if (needsEmbeddings) {
        try {
          resources = getRetrieveResources(readRoot, config);
        } catch {
          resources = null; // semantic degrades to lexical, same as in-process
        }
      }
      return Promise.resolve(dispatch(/** @type {any} */ (payload.call), {
        view,
        ledger,
        ledgerPath: ledgerPath || undefined,
        versionId: String(payload.versionId || ""),
        repoRoot: readRoot || undefined,
        repoId: payload.repoId ? String(payload.repoId) : null,
        // The reader lane is READ-ONLY w.r.t. embeddings: never encode-on-demand
        // here. On-demand fill writes + renames index.usearch, which races the
        // conductor's ANN writes across lanes (the cross-lane single-writer
        // violation). Missing symbols degrade to lexical on this read and are
        // encoded by the conductor's warm backlog instead.
        config: { ...config, onDemandEmbeddingFill: false },
        embeddingIndex: resources?.enabled ? resources.index : undefined,
        encoder: resources?.enabled ? resources.encoder : undefined,
        taskText: typeof payload.taskText === "string" ? payload.taskText : undefined,
        taskType: /** @type {import("../contracts/tool-params.js").TaskType | undefined} */ (
          typeof payload.taskType === "string" ? payload.taskType : undefined
        ),
        planner: conductorPlanQuery,
      }));
    };
    // Register the semantic read on the embeddings key (acquiring + using the
    // child INSIDE this hold so it can't be retired mid-read) so a cross-lane
    // embedding writer can drain it before retiring the child and renaming.
    // Warms hold this gate for their whole duration (minutes), so the wait is
    // SHORT and a timeout degrades the retrieve to lexical-only instead of
    // stalling 30s and erroring — cold embeddings must never block a read.
    let envelope;
    if (needsEmbeddings) {
      try {
        envelope = await RETRIEVE_DB_GATE.read(embeddingsGateKey(readRoot), runDispatch, {
          label: "reader-db.retrieve.embeddings",
          waitMs: 2000,
        });
      } catch (err) {
        if (/** @type {any} */ (err)?.code !== "ASYNC_GATE_TIMEOUT" && /** @type {any} */ (err)?.code !== "ASYNC_GATE_BUSY") throw err;
        needsEmbeddings = false;
        envelope = await runDispatch();
      }
    } else {
      envelope = await runDispatch();
    }
    // Envelopes are JSON-safe by contract; round-trip defensively so a stray
    // non-clonable never kills the daemon transport.
    return JSON.parse(JSON.stringify(envelope));
  }, {
    label: "reader-db.retrieve",
    waitMs: 60_000,
  });
}

const CONDUCTOR_TOOL_VIEW_OPTIONAL_ACTIONS = new Set([
  "query",
  "code",
  "repo",
  "agent",
  "action.search",
  "manual",
  "info",
  "repo.status",
  "repo.overview",
  "repo.quality",
  "memory.get",
  "memory.feedback",
  "memory.surface",
  "memory.query",
  "policy.get",
  "runtime.queryOutput",
  "usage.stats",
]);

const CONDUCTOR_TOOL_GATEWAY_ACTIONS = new Set(["query", "code", "repo", "agent"]);
// NOTE: memory.feedback is deliberately absent — it writes only memory.db
// (WAL + busy_timeout), which is lane-safe by design and tested on the reader
// lane. This set gates LEDGER-mutating actions off the read-only lane. Every
// entry must be a registered action (pinned by the parity suite): a phantom
// entry gates nothing and reads as if the action exists.
export const CONDUCTOR_TOOL_MUTATION_ACTIONS = new Set([
  "repo.register",
  "index.refresh",
  "scip.ingest",
  "workflow",
  "buffer.push",
  "buffer.checkpoint",
  "agent.feedback",
  "memory.store",
  "policy.set",
  "runtime.execute",
]);

function resolveToolAction(toolName = "") {
  let action = String(toolName || "").trim();
  if (action.startsWith("atlas.")) action = action.slice("atlas.".length);
  else if (action.startsWith("atlas_")) action = action.slice("atlas_".length).replace(/_/g, ".");
  if (ATLAS_TOOL_ACTIONS.includes(/** @type {any} */ (action))) return action;
  const lowered = action.toLowerCase();
  for (const candidate of ATLAS_TOOL_ACTIONS) {
    if (String(candidate).toLowerCase() === lowered) return candidate;
  }
  return null;
}

function gatewayToolAction(action, args = {}) {
  if (!CONDUCTOR_TOOL_GATEWAY_ACTIONS.has(action)) return action;
  const target = String(
    args?.gatewayAction
    || args?.targetAction
    || args?.actionName
    || args?.action
    || "",
  ).trim();
  // Normalize alias spellings (agent_feedback, atlas.memory.store, case
  // variants) so the mutation gate below classifies the SAME action dispatch
  // will execute — a raw-string check lets a variant spelling route a
  // mutation onto the read-only reader lane.
  return target ? normalizeActionName(target) : action;
}

function conductorErrorPayload(message, error = null) {
  const structured = error && typeof error === "object"
    ? {
        code: error.code ? String(error.code) : "error",
        message: error.message ? String(error.message) : String(message || "ATLAS error"),
        ...(error.details === undefined ? {} : { details: error.details }),
      }
    : null;
  return {
    content: [{ type: "text", text: `Error: ${message}` }],
    isError: true,
    ...(structured ? { structuredContent: { error: structured }, _meta: { atlasError: structured } } : {}),
  };
}

function conductorEnvelopeToMcp(envelope) {
  if (!envelope || typeof envelope !== "object") {
    return { result: conductorErrorPayload("v2 dispatch returned no envelope"), ok: false, errorMsg: "v2 dispatch returned no envelope" };
  }
  if (envelope.ok === false || envelope.error) {
    const message = envelope.error?.message || envelope.error?.code || "v2 backend error";
    return {
      result: conductorErrorPayload(`ATLAS v2 ${envelope.action || ""}: ${message}`, envelope.error),
      ok: false,
      errorMsg: String(message),
    };
  }
  const data = envelope.data === undefined ? {} : envelope.data;
  const payload = envelope.meta && data && typeof data === "object" && !Array.isArray(data)
    ? { ...data, _meta: envelope.meta }
    : data;
  const text = (() => {
    try { return JSON.stringify(payload, null, 2); }
    catch { return String(payload); }
  })();
  return {
    result: { content: [{ type: "text", text }], isError: false },
    ok: true,
    errorMsg: null,
  };
}

function analyzeMcpResult(result) {
  const contentArr = Array.isArray(result?.content) ? result.content : [];
  const text = contentArr.map((entry) => (entry && typeof entry.text === "string") ? entry.text : "").join("");
  const resultChars = text.length;
  return {
    empty: !text || text.trim().length === 0,
    resultChars,
    errorMsg: result?.isError ? (text.length > 500 ? `${text.slice(0, 500)}...` : text) : null,
  };
}

function existingFilePath(value) {
  if (!value || typeof value !== "string") return null;
  try {
    return fs.existsSync(value) ? value : null;
  } catch {
    return null;
  }
}

function uniqueExistingFilePaths(candidates = []) {
  const out = [];
  const seen = new Set();
  for (const candidate of candidates) {
    const found = existingFilePath(candidate);
    if (!found) continue;
    const key = path.resolve(found).replace(/\\/g, "/").toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(found);
  }
  return out;
}

function resolveRepoRootForTool(payload = {}, config = {}) {
  const boot = payload.session?.bootConfig || payload.session || {};
  const candidates = [
    config.repoRoot,
    config.requestedRepoPath,
    config.cwd,
    boot?.atlas?.repoPath,
    boot?.cwd,
    payload.args?.repoRoot,
    payload.args?.cwd,
    process.cwd(),
  ];
  for (const candidate of candidates) {
    if (typeof candidate === "string" && candidate.trim()) return candidate;
  }
  return process.cwd();
}

function resolveToolConfig(payload = {}) {
  const boot = payload.session?.bootConfig || payload.session || {};
  const atlas = boot?.atlas || {};
  const config = payload.config && typeof payload.config === "object" ? payload.config : {};
  const cwd = config.cwd || boot.cwd || atlas.repoPath || process.cwd();
  const repoRoot = config.repoRoot || config.requestedRepoPath || atlas.repoPath || boot.cwd || process.cwd();
  return {
    ...atlas,
    ...config,
    cwd,
    repoRoot,
    repoId: config.repoId || config.requestedRepoId || atlas.repoId || deriveRepoIdFromPath(repoRoot),
    ledgerDbPath: config.ledgerDbPath
      || config.atlasV2LedgerDbPath
      || atlas.ledgerDbPath
      || atlas.atlasV2LedgerDbPath
      || null,
    viewDbPath: config.viewDbPath || config.atlasV2ViewDbPath || null,
    semanticEnabled: config.semanticEnabled === true || atlas.semanticEnabled === true,
    vectorBackend: config.vectorBackend || atlas.vectorBackend || "auto",
    embeddingProvider: config.embeddingProvider || config.atlasEmbeddingProvider || atlas.embeddingProvider || "",
    atlasEmbeddingProvider: config.atlasEmbeddingProvider || config.embeddingProvider || atlas.embeddingProvider || "",
    embeddingEndpoint: config.embeddingEndpoint || atlas.embeddingEndpoint || "",
    embeddingModel: config.embeddingModel || atlas.embeddingModel || "",
    embeddingDim: config.embeddingDim ?? atlas.embeddingDim ?? null,
    embeddingModelVersion: config.embeddingModelVersion || atlas.embeddingModelVersion || "",
    embeddingTimeoutMs: config.embeddingTimeoutMs ?? atlas.embeddingTimeoutMs ?? null,
    embeddingHeaders: config.embeddingHeaders || atlas.embeddingHeaders || null,
    embeddingSendDimensions: config.embeddingSendDimensions ?? atlas.embeddingSendDimensions ?? null,
    remoteEncoderMode: config.remoteEncoderMode || atlas.remoteEncoderMode || "off",
    remoteEncoderUrl: config.remoteEncoderUrl || atlas.remoteEncoderUrl || "",
    remoteEncoderModel: config.remoteEncoderModel || atlas.remoteEncoderModel || "",
    remoteEncoderDim: config.remoteEncoderDim ?? atlas.remoteEncoderDim ?? null,
    remoteEncoderModelVersion: config.remoteEncoderModelVersion || atlas.remoteEncoderModelVersion || "",
    remoteEncoderTimeoutMs: config.remoteEncoderTimeoutMs ?? atlas.remoteEncoderTimeoutMs ?? null,
    viewWaitMs: config.viewWaitMs ?? atlas.viewWaitMs ?? null,
  };
}

function deriveRepoIdFromPath(value) {
  if (!value || typeof value !== "string") return null;
  const base = path.basename(path.resolve(value)).trim();
  return base || null;
}

function candidateViewPaths({ repoRoot, config }) {
  const preferred = uniqueExistingFilePaths([
    config.viewDbPath,
    config.cwd ? worktreeViewPath(config.cwd) : null,
  ]);
  if (preferred.length > 0) return preferred;
  return uniqueExistingFilePaths([
    config.viewDbPath,
    config.cwd ? worktreeViewPath(config.cwd) : null,
    repoRoot ? worktreeViewPath(repoRoot) : null,
    repoRoot ? mainViewPath(repoRoot) : null,
  ]);
}

function candidateLedgerPaths({ repoRoot, config, viewMeta }) {
  return uniqueExistingFilePaths([
    config.ledgerDbPath,
    viewMeta?.repo_root ? ledgerDbPath(viewMeta.repo_root) : null,
    repoRoot ? ledgerDbPath(repoRoot) : null,
  ]);
}

async function openReadOnlyLedger(dbPath) {
  try {
    return Ledger.openReadOnly({ dbPath });
  } catch {
    // Rare recovery path: a hot WAL makes the read-only open fail until a
    // readwrite open replays it. Ledger.open ensures the schema through the
    // persistent worker (async), so this branch awaits.
    return Ledger.open({ dbPath });
  }
}

function ledgerSupportsViewMeta(ledger, viewMeta) {
  const branch = typeof viewMeta?.branch === "string" && viewMeta.branch ? viewMeta.branch : null;
  if (!ledger || !branch || typeof ledger.getBranch !== "function") return true;
  try {
    return !!ledger.getBranch(branch);
  } catch {
    return false;
  }
}

function baselineBranchForRepo(repoRoot) {
  try {
    return resolveTargetBranch(repoRoot || process.cwd());
  } catch {
    return "main";
  }
}

function isMainViewPath(candidate, repoRoot) {
  if (!candidate || !repoRoot) return false;
  return path.resolve(candidate) === path.resolve(mainViewPath(repoRoot));
}

function mainViewBranchMismatch({ viewPath, meta, repoRoot }) {
  if (!isMainViewPath(viewPath, repoRoot)) return null;
  const baselineBranch = baselineBranchForRepo(repoRoot);
  const viewBranch = typeof meta?.branch === "string" && meta.branch ? meta.branch : null;
  if (!baselineBranch || !viewBranch || viewBranch === baselineBranch) return null;
  return `main view branch '${viewBranch}' does not match target branch '${baselineBranch}'`;
}

function viewWaitMs(config = {}) {
  const raw = config.viewWaitMs;
  if (raw == null || String(raw).trim() === "") return 2500;
  const n = Number(raw);
  if (Number.isFinite(n) && n >= 0) return Math.min(n, 30000);
  return 2500;
}

function viewNotReadyResult({ toolName, probe, waitMs }) {
  const pathText = probe?.dbPath ? ` (${probe.dbPath})` : "";
  const reason = probe?.error?.message || "view is not ready";
  const message = `ATLAS v2 ${toolName} view is not current after ${waitMs}ms${pathText}: ${reason}`;
  const result = conductorErrorPayload(message);
  return {
    result,
    ok: false,
    empty: true,
    resultChars: 0,
    errorMsg: message,
    tokenUsage: null,
    responseTelemetry: null,
  };
}

function resolveReadRoot({ config, repoRoot, viewMeta, viewPath }) {
  const cwd = config.cwd;
  if (cwd && viewPath && path.resolve(viewPath) === path.resolve(worktreeViewPath(cwd))) return cwd;
  return cwd || viewMeta?.repo_root || repoRoot || process.cwd();
}

/**
 * Resolve and execute an ATLAS tool in the reader lane. This is the conductor
 * side of AtlasToolExecutor; it owns view/ledger resolution and keeps DB/native
 * resources out of the MCP gateway process.
 *
 * @param {Record<string, any>} payload
 */
export async function runConductorToolExecution(payload = {}) {
  const toolName = String(payload.toolName || "").trim();
  const args = payload.args && typeof payload.args === "object" ? payload.args : {};
  const action = resolveToolAction(payload.action || toolName);
  if (!toolName || !action) {
    const result = conductorErrorPayload(`Unknown ATLAS tool: ${toolName || "(empty)"}`);
    const analysis = analyzeMcpResult(result);
    return { result, ok: false, ...analysis, tokenUsage: null, responseTelemetry: null };
  }
  const effectiveAction = gatewayToolAction(action, args);
  if (CONDUCTOR_TOOL_MUTATION_ACTIONS.has(effectiveAction)) {
    const result = conductorErrorPayload(`ATLAS ${effectiveAction} is not executable on the reader lane`);
    const analysis = analyzeMcpResult(result);
    return { result, ok: false, ...analysis, tokenUsage: null, responseTelemetry: null };
  }

  const config = resolveToolConfig(payload);
  const repoRoot = resolveRepoRootForTool(payload, config);
  const optionalView = CONDUCTOR_TOOL_VIEW_OPTIONAL_ACTIONS.has(effectiveAction);
  const viewCandidates = candidateViewPaths({ repoRoot, config });
  if (viewCandidates.length === 0 && !optionalView) return null;

  /** @type {any} */
  let ledger = null;
  /** @type {string | null} */
  let ledgerPath = null;
  /** @type {string | null} */
  let viewPath = null;
  let meta = null;
  try {
    const initialLedgerPath = existingFilePath(config.ledgerDbPath);
    if (initialLedgerPath) {
      ledgerPath = initialLedgerPath;
      ledger = await openReadOnlyLedger(initialLedgerPath);
    }
    if (viewCandidates.length > 0) {
      const waitMs = viewWaitMs(config);
      const probe = await waitForCurrentView({
        viewPaths: viewCandidates,
        ViewClass: View,
        ledger,
        timeoutMs: waitMs,
      });
      if (!probe.ok) {
        if (!optionalView) return viewNotReadyResult({ toolName, probe, waitMs });
      } else {
        viewPath = probe.dbPath;
        meta = probe.meta;
        try { probe.view?.close?.(); } catch { /* ignore */ }
        const mismatch = mainViewBranchMismatch({ viewPath, meta, repoRoot });
        if (mismatch && !optionalView) {
          return viewNotReadyResult({
            toolName,
            waitMs,
            probe: {
              ...probe,
              error: new Error(mismatch),
            },
          });
        }
      }
    }
    if (ledger && meta && !ledgerSupportsViewMeta(ledger, meta)) {
      try { ledger.close?.(); } catch { /* ignore */ }
      ledger = null;
      ledgerPath = null;
    }
    if (!ledgerPath) ledgerPath = candidateLedgerPaths({ repoRoot, config, viewMeta: meta })[0] || null;
    if (!ledgerPath && !optionalView) return null;

    const baselineBranch = baselineBranchForRepo(repoRoot);
    const readRoot = resolveReadRoot({ config, repoRoot, viewMeta: meta, viewPath });
    const versionId = meta ? `${meta.branch}@${meta.ledger_seq}` : `${baselineBranch}@0`;
    const call = {
      ...(CONDUCTOR_TOOL_GATEWAY_ACTIONS.has(action)
        ? { ...args, action, gatewayAction: typeof args.action === "string" ? args.action : args.gatewayAction }
        : { action, ...args }),
    };
    const wantsSemantic = (action === "symbol.search" && call.semantic)
      || (action === "slice.build" && call.taskText && call.semantic !== false)
      || ((action === "context" || action === "context.summary") && call.taskText);
    const envelope = await runConductorRetrieve({
      call,
      viewPath,
      ledgerPath,
      versionId,
      readRoot,
      repoId: config.repoId || call.repoId || null,
      semantic: wantsSemantic,
      taskText: typeof call.taskText === "string" ? call.taskText : undefined,
      taskType: typeof call.taskType === "string" ? call.taskType : undefined,
      config,
    });
    const mapped = conductorEnvelopeToMcp(envelope);
    const analysis = analyzeMcpResult(mapped.result);
    return {
      result: mapped.result,
      ok: mapped.ok && !mapped.result?.isError,
      empty: analysis.empty,
      resultChars: analysis.resultChars,
      errorMsg: mapped.errorMsg || analysis.errorMsg,
      tokenUsage: null,
      responseTelemetry: null,
    };
  } finally {
    try { ledger?.close?.(); } catch { /* ignore */ }
  }
}

/**
 * Test-only factory for conductor planner retry/cache behavior.
 *
 * @param {Parameters<typeof createConductorPlanner>[0]} options
 */
export function __testCreateConductorPlanner(options = {}) {
  return createConductorPlanner(options);
}

export function __testSeedRetrieveResources(readRoot, config, resources) {
  const key = resourcesKey(readRoot, config || {});
  RETRIEVE_RESOURCES.set(key, resources);
  return key;
}

export function __testRetrieveResourcesSize() {
  return RETRIEVE_RESOURCES.size;
}
