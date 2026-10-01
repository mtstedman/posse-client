import { TERMINAL_WORK_ITEM_STATUSES } from "../../../catalog/work-item.js";
import {
  RUNTIME_STATUS_KEYS,
  clearRuntimeStatus,
  readRuntimeStatus,
  updateRuntimeStatus,
} from "./runtime-status.js";
import { getWorkItem } from "./queue-store.js";

const TERMINAL = new Set(TERMINAL_WORK_ITEM_STATUSES);

function ids(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(Number)
    .filter((id) => Number.isSafeInteger(id) && id > 0))]
    .sort((a, b) => a - b);
}

function hasOpenWork(workItemIds) {
  return workItemIds.some((id) => {
    try {
      const item = getWorkItem(id);
      return item && !TERMINAL.has(item.status);
    } catch {
      return false;
    }
  });
}

export function readRunCohort() {
  const value = readRuntimeStatus(RUNTIME_STATUS_KEYS.RUN_COHORT);
  if (!value || typeof value !== "object") return null;
  return { ...value, work_item_ids: ids(value.work_item_ids) };
}

export function beginRunCohort(workItemIds, {
  resetIfDisjoint = false,
  nowIso = new Date().toISOString(),
} = {}) {
  const incoming = ids(workItemIds);
  const current = readRunCohort();
  const currentIds = ids(current?.work_item_ids);
  const incomingSet = new Set(incoming);
  const overlaps = currentIds.some((id) => incomingSet.has(id));
  const resume = currentIds.length > 0
    && (overlaps || (!resetIfDisjoint && hasOpenWork(currentIds)));
  const nextIds = resume ? ids([...currentIds, ...incoming]) : incoming;
  const next = {
    started_at: resume && current?.started_at ? current.started_at : nowIso,
    updated_at: nowIso,
    work_item_ids: nextIds,
  };
  updateRuntimeStatus(RUNTIME_STATUS_KEYS.RUN_COHORT, () => next);
  return next;
}

export function extendRunCohort(workItemIds, { nowIso = new Date().toISOString() } = {}) {
  const incoming = ids(workItemIds);
  const result = updateRuntimeStatus(RUNTIME_STATUS_KEYS.RUN_COHORT, (current) => ({
    started_at: current?.started_at || nowIso,
    updated_at: nowIso,
    work_item_ids: ids([...(current?.work_item_ids || []), ...incoming]),
  }));
  return result.value || readRunCohort();
}

export function completeRunCohort() {
  return clearRuntimeStatus(RUNTIME_STATUS_KEYS.RUN_COHORT);
}
