import { HashMinter } from "../../../shared/tools/classes/hash-store/HashMinter.js";
import { HashRefStore } from "../../../shared/tools/classes/hash-store/HashRefStore.js";
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

function markContextMismatch(out, field, expected, actual) {
  if (out.error) return;
  out.error = "hash_ref_context_mismatch";
  out.error_detail = `${field} expected ${expected ?? "null"} but got ${actual ?? "null"}`;
}

function acceptResolvedId(out, key, value, field) {
  const normalized = positiveInt(value);
  if (!normalized) return;
  if (out[key] && out[key] !== normalized) {
    markContextMismatch(out, field, out[key], normalized);
    return;
  }
  out[key] = normalized;
}

function jobAncestorRows(db, jobId, workItemId) {
  const rows = [];
  const seen = new Set();
  let currentId = positiveInt(jobId);
  let guard = 0;
  while (currentId && guard < 32 && !seen.has(currentId)) {
    guard += 1;
    seen.add(currentId);
    const row = db.prepare(`
      SELECT id, work_item_id, parent_job_id
      FROM jobs
      WHERE id = ?
    `).get(currentId);
    if (!row) break;
    const rowWorkItemId = positiveInt(row.work_item_id);
    if (workItemId && rowWorkItemId !== workItemId) break;
    rows.push({
      id: positiveInt(row.id),
      work_item_id: rowWorkItemId,
      parent_job_id: positiveInt(row.parent_job_id),
    });
    currentId = positiveInt(row.parent_job_id);
  }
  return rows;
}

function createJobStoreChain({
  db,
  minter,
  rows,
  fallbackWorkItemId,
  parent,
  currentAttemptId = null,
  currentAgentCallId = null,
  maxMaterializedRows = undefined,
  maxMaterializedBytes = undefined,
}) {
  if (!Array.isArray(rows) || rows.length === 0) return null;
  let nextParent = parent || null;
  const ordered = rows.slice().reverse();
  const currentJobId = rows[0]?.id || null;
  for (const row of ordered) {
    const isCurrentJob = row.id === currentJobId;
    nextParent = new HashRefStore({
      db,
      minter,
      ownerScope: "job",
      workItemId: row.work_item_id || fallbackWorkItemId,
      jobId: row.id,
      attemptId: isCurrentJob ? currentAttemptId : null,
      agentCallId: isCurrentJob ? currentAgentCallId : null,
      parent: nextParent,
      maxMaterializedRows,
      maxMaterializedBytes,
    });
  }
  return nextParent;
}

export function resolveHashRefContext(context = {}, db = getDb()) {
  const out = {
    workItemId: positiveInt(context.workItemId ?? context.work_item_id),
    jobId: positiveInt(context.jobId ?? context.job_id),
    attemptId: positiveInt(context.attemptId ?? context.attempt_id),
    agentCallId: positiveInt(context.agentCallId ?? context.agent_call_id),
  };

  if (out.agentCallId) {
    const call = db.prepare(`
      SELECT id, work_item_id, job_id, attempt_id
      FROM agent_calls
      WHERE id = ?
    `).get(out.agentCallId);
    if (!call) {
      out.error = "invalid_agent_call_id";
      return out;
    }
    acceptResolvedId(out, "workItemId", call.work_item_id, "work_item_id");
    acceptResolvedId(out, "jobId", call.job_id, "job_id");
    acceptResolvedId(out, "attemptId", call.attempt_id, "attempt_id");
    if (out.error) return out;
  }

  if (out.attemptId) {
    const attempt = db.prepare(`
      SELECT a.id, a.job_id, j.work_item_id
      FROM job_attempts a
      LEFT JOIN jobs j ON j.id = a.job_id
      WHERE a.id = ?
    `).get(out.attemptId);
    if (!attempt) {
      out.error = "invalid_attempt_id";
      return out;
    }
    acceptResolvedId(out, "jobId", attempt.job_id, "job_id");
    acceptResolvedId(out, "workItemId", attempt.work_item_id, "work_item_id");
    if (out.error) return out;
  }

  if (out.jobId) {
    const job = db.prepare(`SELECT id, work_item_id FROM jobs WHERE id = ?`).get(out.jobId);
    if (!job) {
      out.error = "invalid_job_id";
      return out;
    }
    acceptResolvedId(out, "workItemId", job.work_item_id, "work_item_id");
    if (out.error) return out;
  }

  if (out.workItemId) {
    const workItem = db.prepare(`SELECT id FROM work_items WHERE id = ?`).get(out.workItemId);
    if (!workItem) {
      out.error = "invalid_work_item_id";
      return out;
    }
  }

  return out;
}

function createHashRefStoreForResolvedContext(resolved, {
  db = getDb(),
  minter = null,
  ownerScope = null,
  maxMaterializedRows = undefined,
  maxMaterializedBytes = undefined,
} = {}) {
  if (!resolved || resolved.error) return null;
  const sharedMinter = minter || new HashMinter({ db });
  const workItemStore = resolved.workItemId
    ? new HashRefStore({
      db,
      minter: sharedMinter,
      ownerScope: "work_item",
      workItemId: resolved.workItemId,
      maxMaterializedRows,
      maxMaterializedBytes,
    })
    : null;
  const jobStore = resolved.jobId && resolved.workItemId
    ? createJobStoreChain({
      db,
      minter: sharedMinter,
      rows: jobAncestorRows(db, resolved.jobId, resolved.workItemId),
      fallbackWorkItemId: resolved.workItemId,
      parent: workItemStore,
      currentAttemptId: resolved.attemptId,
      currentAgentCallId: resolved.agentCallId,
      maxMaterializedRows,
      maxMaterializedBytes,
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
      maxMaterializedRows,
      maxMaterializedBytes,
    })
    : null;

  const explicit = normalizeScope(ownerScope);
  if (explicit === "agent_run") return agentRunStore;
  if (explicit === "job") return jobStore;
  if (explicit === "work_item") return workItemStore;
  return agentRunStore || jobStore || workItemStore;
}

export function createHashRefStoreForContext(context = {}, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  return createHashRefStoreForResolvedContext(resolved, { ...opts, db });
}

export function surfaceHashRefForContext(context = {}, entry = {}, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  if (resolved.error) {
    return { ok: false, error: resolved.error, detail: resolved.error_detail || null };
  }
  const store = createHashRefStoreForResolvedContext(resolved, { ...opts, db });
  if (!store) {
    return { ok: false, error: "missing_hash_ref_scope" };
  }
  const surfaced = store.surface(entry);
  return {
    ok: true,
    ...surfaced,
  };
}

export function fetchHashRefForContext(context = {}, ref, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  if (resolved.error) {
    return { ok: false, found: false, ref: String(ref || ""), error: resolved.error };
  }
  const store = createHashRefStoreForResolvedContext(resolved, { ...opts, db });
  if (!store) {
    return { ok: false, found: false, ref: String(ref || ""), error: "missing_hash_ref_scope" };
  }
  return store.fetch(ref);
}

export function giveHashRefToParentForContext(context = {}, ref, opts = {}) {
  const db = opts.db || getDb();
  const resolved = resolveHashRefContext(context, db);
  if (resolved.error) {
    return { ok: false, found: false, ref: String(ref || ""), error: resolved.error };
  }
  const store = createHashRefStoreForResolvedContext(resolved, { ...opts, db });
  if (!store) {
    return { ok: false, found: false, ref: String(ref || ""), error: "missing_hash_ref_scope" };
  }
  return store.giveHash(ref, opts);
}
