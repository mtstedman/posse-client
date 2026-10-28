import { addDependency, getDependencies } from "../../queue/functions/dependencies.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { logEvent } from "../../queue/functions/events.js";
import { normPath } from "../../../shared/scope/functions/path.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";

// Run after normalization/splitting, on the exact scopes the scheduler locks.
export function serializePlanScopeOverlaps(jobs) {
  const writers = jobs.filter((job) => ["dev", "fix"].includes(job.job_type));
  const graph = new Map(jobs.map((job) => [job.id, getDependencies(job.id)]));
  const reaches = (from, to, hardOnly = false, seen = new Set()) => {
    if (from === to) return true;
    if (seen.has(from)) return false;
    seen.add(from);
    return (graph.get(from) || []).some((edge) => (!hardOnly || edge.dependency_kind === "hard")
      && reaches(edge.depends_on_job_id, to, hardOnly, seen));
  };
  const scopes = new Map(writers.map((job) => {
    const payload = parseJobPayload(job);
    return [job.id, new Set([...payload.files_to_modify || [], ...payload.files_to_create || [],
      ...payload.files_to_delete || []].map(normPath))];
  }));
  const overlaps = [];
  for (let later = 1; later < writers.length; later++) {
    for (let earlier = 0; earlier < later; earlier++) {
      const a = writers[earlier], b = writers[later];
      const paths = [...scopes.get(a.id)].filter((file) => scopes.get(b.id).has(file));
      if (!paths.length || reaches(a.id, b.id, true) || reaches(b.id, a.id, true)) continue;
      // Preserve an existing (possibly soft) topological order, including
      // producers appearing later in the planner array. Never create a cycle.
      const [upstream, downstream] = reaches(a.id, b.id) ? [b, a] : [a, b];
      if (!addDependency(downstream.id, upstream.id, "hard")) {
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
