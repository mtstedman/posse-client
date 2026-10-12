// @ts-check



export const DEDUPE_SORTED_ARRAY_KEYS = new Set([
  "create_roots",
  "depends_on_index",
  "files_to_create",
  "files_to_delete",
  "files_to_modify",
  "input_roots",
  "mappings",
  "success_criteria",
]);

export function stableDedupeValue(value, key = null) {
  if (Array.isArray(value)) {
    const normalized = value.map((entry) => stableDedupeValue(entry));
    if (!DEDUPE_SORTED_ARRAY_KEYS.has(key)) return normalized;
    return normalized.sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  }
  if (value && typeof value === "object") {
    const out = {};
    for (const childKey of Object.keys(value).sort()) {
      out[childKey] = stableDedupeValue(value[childKey], childKey);
    }
    return out;
  }
  return value;
}

export function normalizedTaskTitleForDedupe(value) {
  return String(value || "").trim().replace(/\s+/g, " ").toLowerCase();
}

export function parsePayloadForDedupe(payloadJson) {
  if (!payloadJson) return null;
  if (typeof payloadJson === "object") return payloadJson;
  try {
    return JSON.parse(payloadJson);
  } catch {
    return payloadJson;
  }
}

/** @param {Record<string, unknown>} task
 * @param {{finalJobType?: string, taskMode?: string, provider?: string, modelTier?: string, reasoningEffort?: string, payloadJson?: unknown, promoteFollowUp?: Record<string, unknown>}} options
 */
export function plannedTaskDedupeKey(task, {
  finalJobType,
  taskMode,
  provider = null,
  modelTier = null,
  reasoningEffort = null,
  payloadJson = null,
  promoteFollowUp = null,
} = {}) {
  if (!task || !finalJobType || finalJobType === "promote") return null;
  return JSON.stringify(stableDedupeValue({
    job_type: finalJobType,
    title: normalizedTaskTitleForDedupe(task.title),
    task_mode: taskMode || null,
    provider: provider || null,
    model_tier: modelTier || null,
    reasoning_effort: reasoningEffort || null,
    depends_on_index: Array.isArray(task.depends_on_index) ? task.depends_on_index : [],
    payload: parsePayloadForDedupe(payloadJson),
    promote_follow_up: promoteFollowUp ? {
      title: promoteFollowUp.title || null,
      mappings: Array.isArray(promoteFollowUp.mappings) ? promoteFollowUp.mappings : [],
      files_to_create: Array.isArray(promoteFollowUp.files_to_create) ? promoteFollowUp.files_to_create : [],
      create_roots: Array.isArray(promoteFollowUp.create_roots) ? promoteFollowUp.create_roots : [],
    } : null,
  }));
}
