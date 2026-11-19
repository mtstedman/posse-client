import { addDependency, getDependencies } from "../../queue/functions/dependencies.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { logEvent } from "../../queue/functions/events.js";
import { TERMINAL_JOB_STATUSES } from "../../queue/functions/common.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { normPath } from "../../../shared/scope/functions/path.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

function payloadScopePaths(job) {
  const payload = parseJobPayload(job);
  return new Set([...payload.files_to_modify || [], ...payload.files_to_create || [],
    ...payload.files_to_delete || []].map(normPath));
}

// Run after normalization/splitting, on the exact scopes the scheduler locks.
// `focusJobId` limits serialization to the pairs that include that job, which
// is compared on `focusPaths` (its newly added paths) when they are given.
export function serializePlanScopeOverlaps(jobs, { focusJobId = null, focusPaths = null } = {}) {
  const writers = jobs.filter((job) => ["dev", "fix"].includes(job.job_type));
  const graph = new Map(jobs.map((job) => [job.id, getDependencies(job.id)]));
  const reaches = (from, to, hardOnly = false, seen = new Set()) => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (graph.get(from) || []).some((edge) => (!hardOnly || edge.dependency_kind === "hard")
      && reaches(edge.depends_on_job_id, to, hardOnly, seen));
  };
  const scopes = new Map(writers.map((job) => [job.id, focusPaths && job.id === focusJobId
    ? new Set(focusPaths.map(normPath))
    : payloadScopePaths(job)]));
  const overlaps = [];
  for (let later = 1; later < writers.length; later++) {
    for (let earlier = 0; earlier < later; earlier++) {
      const a = writers[earlier], b = writers[later];
      if (focusJobId != null && a.id !== focusJobId && b.id !== focusJobId) continue;
      const paths = [...scopes.get(a.id)].filter((file) => scopes.get(b.id).has(file));
      if (!paths.length || reaches(a.id, b.id, true) || reaches(b.id, a.id, true)) continue;
      // Preserve an existing (possibly soft) topological order, including
      // producers appearing later in the planner array. Never create a cycle.
      const [upstream, downstream] = reaches(a.id, b.id) ? [b, a] : [a, b];
      if (!addDependency(downstream.id, upstream.id, "hard")) {
        // A widened scope leaves the tie to the lock layer (job age) instead.
        if (focusJobId != null) continue;
        throw new Error(`Cannot serialize overlapping plan jobs ${upstream.id} and ${downstream.id}`);
      }
      graph.set(downstream.id, getDependencies(downstream.id));
      const detail = { job_ids: [upstream.id, downstream.id], upstream_job_id: upstream.id,
        downstream_job_id: downstream.id, paths, dependency_kind: "hard" };
      overlaps.push(detail);
      logEvent({ work_item_id: downstream.work_item_id, job_id: downstream.id,
        event_type: EVENT_TYPES.PLAN_SCOPE_OVERLAP, actor_type: EVENT_ACTORS.SYSTEM,
        message: `Serialized overlapping scope for jobs #${upstream.id} and #${downstream.id}: ${paths.join(", ")}`,
        event_json: JSON.stringify(detail) });
    }
  }
  return overlaps;
}

/**
 * Give a job whose scope was widened after planning (an operator-approved fix
 * scope, files the assessor added to a fix) the ordering edge planning adds
 * for overlapping scopes (K1): each path it has beyond its parent's scope is
 * serialized against the other live jobs of its work item, older ones first.
 * An edge that would close a cycle is left out; the lock layer still lets the
 * older of two queued jobs lease first. Returns the overlaps serialized.
 */
export function serializeWidenedScopeOverlaps(job) {
  const db = getDb();
  const fresh = job?.id ? db.prepare("SELECT * FROM jobs WHERE id = ?").get(Number(job.id)) : null;
  if (!fresh || !["dev", "fix"].includes(fresh.job_type)) return [];
  const parent = fresh.parent_job_id
    ? db.prepare("SELECT * FROM jobs WHERE id = ?").get(Number(fresh.parent_job_id))
    : null;
  const inherited = parent ? payloadScopePaths(parent) : new Set();
  const widened = [...payloadScopePaths(fresh)].filter((path) => !inherited.has(path));
  if (widened.length === 0) return [];
  const jobs = db.prepare(`
    SELECT * FROM jobs
    WHERE work_item_id = ?
      AND status NOT IN (${TERMINAL_JOB_STATUSES.map(() => "?").join(",")})
    ORDER BY id
  `).all(Number(fresh.work_item_id), ...TERMINAL_JOB_STATUSES);
  return serializePlanScopeOverlaps(jobs, { focusJobId: fresh.id, focusPaths: widened });
}
