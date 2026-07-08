import { HashMinter } from "../../../classes/hash-store/HashMinter.js";
import { HashRefStore } from "../../../classes/hash-store/HashRefStore.js";
import {
  HASH_REF_OWNER_SCOPE_SET,
} from "../../../catalog/hash-store.js";
import { getDb } from "../../../shared/storage/functions/index.js";

function positiveInt(value) {
  if (value == null || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

function normalizeScope(scope) {
  const normalized = String(scope || "").trim();
  return HASH_REF_OWNER_SCOPE_SET.has(normalized) ? normalized : null;
}

export function resolveHashRefContext(context = {}, db = getDb()) {
  const out = {
    workItemId: positiveInt(context.workItemId ?? context.work_item_id),
    jobId: positiveInt(context.jobId ?? context.job_id),
    attemptId: positiveInt(context.attemptId ?? context.attempt_id),
    agentCallId: positiveInt(context.agentCallId ?? context.agent_call_id),
  };

  if (out.attemptId && (!out.jobId || !out.workItemId)) {
    const attempt = db.prepare(`SELECT id, job_id FROM job_attempts WHERE id = ?`).get(out.attemptId);
    if (attempt?.job_id) out.jobId = out.jobId || positiveInt(attempt.job_id);
  }
  if (out.agentCallId && (!out.jobId || !out.workItemId || !out.attemptId)) {
    const call = db.prepare(`
      SELECT id, work_item_id, job_id, attempt_id
      FROM agent_calls
      WHERE id = ?
    `).get(out.agentCallId);
    if (call) {
      out.workItemId = out.workItemId || positiveInt(call.work_item_id);
      out.jobId = out.jobId || positiveInt(call.job_id);
      out.attemptId = out.attemptId || positiveInt(call.attempt_id);
    }
  }
  if (out.jobId && !out.workItemId) {
    const job = db.prepare(`SELECT id, work_item_id FROM jobs WHERE id = ?`).get(out.jobId);
    if (job?.work_item_id) out.workItemId = positiveInt(job.work_item_id);
  }

  return out;
}

export function createHashRefStoreForContext(context = {}, {
  db = getDb(),
  minter = null,
  ownerScope = null,
} = {}) {
  const resolved = resolveHashRefContext(context, db);
  const sharedMinter = minter || new HashMinter({ db });
  const workItemStore = resolved.workItemId
    ? new HashRefStore({
      db,
      minter: sharedMinter,
      ownerScope: "work_item",
      workItemId: resolved.workItemId,
    })
    : null;
  const jobStore = resolved.jobId && resolved.workItemId
    ? new HashRefStore({
      db,
      minter: sharedMinter,
      ownerScope: "job",
      workItemId: resolved.workItemId,
      jobId: resolved.jobId,
      parent: workItemStore,
    })
    : null;
  const agentRunStore = resolved.attemptId
    ? new HashRefStore({
      db,
      minter: sharedMinter,
      ownerScope: "agent_run",
      workItemId: resolved.workItemId,
      jobId: resolved.jobId,
      attemptId: resolved.attemptId,
      agentCallId: resolved.agentCallId,
      parent: jobStore || workItemStore,
    })
    : null;

  const explicit = normalizeScope(ownerScope);
  if (explicit === "agent_run") return agentRunStore;
  if (explicit === "job") return jobStore;
  if (explicit === "work_item") return workItemStore;
  return agentRunStore || jobStore || workItemStore;
}

export function surfaceHashRefForContext(context = {}, entry = {}, opts = {}) {
  const store = createHashRefStoreForContext(context, opts);
  if (!store) {
    return { ok: false, error: "missing_hash_ref_scope" };
  }
  const surfaced = store.surface(entry);
  return {
    ok: true,
    owner_scope: store.ownerScope,
    owner_id: store.ownerId,
    ...surfaced,
  };
}

export function fetchHashRefForContext(context = {}, ref, opts = {}) {
  const store = createHashRefStoreForContext(context, opts);
  if (!store) {
    return { ok: false, found: false, ref: String(ref || ""), error: "missing_hash_ref_scope" };
  }
  return store.fetch(ref);
}
