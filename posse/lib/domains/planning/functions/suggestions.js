import {
  addDependency,
  createJob,
  createWorkItem,
  getWorkItem,
  refreshWorkItemStatus,
} from "../../queue/functions/index.js";
import { validateCreateRootPath, validateScopedPath } from "../../../shared/scope/functions/validation.js";

function asArray(value) {
  return Array.isArray(value) ? value : [];
}

function cleanText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function trimForTitle(value, max = 80) {
  const text = cleanText(value);
  return text.length > max ? `${text.slice(0, Math.max(0, max - 1))}...` : text;
}

function normalizeSuggestionIndex(value) {
  const n = Number(value);
  return Number.isInteger(n) && n >= 0 ? n : null;
}

function normalizeValidatedScopePath(value, { root = false } = {}) {
  let normalized = String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
  if (root) normalized = normalized.replace(/\/+$/, "");
  return normalized;
}

function collectValidatedScope(values, label, validator, { root = false } = {}) {
  const kept = [];
  const dropped = [];
  const seen = new Set();
  for (const [idx, value] of asArray(values).entries()) {
    const itemLabel = `${label}[${idx}]`;
    const err = validator(value, itemLabel);
    if (err) {
      dropped.push({ label: itemLabel, value, reason: err });
      continue;
    }
    const normalized = normalizeValidatedScopePath(value, { root });
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    kept.push(normalized);
  }
  return { kept, dropped };
}

function sanitizeSuggestionScope({
  filesToModify = [],
  filesToCreate = [],
  createRoots = [],
} = {}) {
  const modify = collectValidatedScope(filesToModify, "files_to_modify", validateScopedPath);
  const create = collectValidatedScope(filesToCreate, "files_to_create", validateScopedPath);
  const roots = collectValidatedScope(createRoots, "create_roots", validateCreateRootPath, { root: true });
  return {
    filesToModify: modify.kept,
    filesToCreate: create.kept,
    createRoots: roots.kept,
    dropped: [...modify.dropped, ...create.dropped, ...roots.dropped],
  };
}

export function isClarificationOnlySuggestion(suggestion) {
  const text = String(suggestion || "").trim().toLowerCase();
  if (!text) return true;
  if (/^let me know\b/.test(text)) return true;
  if (/\bif\b.*\b(in the future|needed|required)\b.*\b(request|ask|clarif)/.test(text)) return true;
  if (/\b(request|ask)\b.*\b(scope|clarif|human|user)\b/.test(text)) return true;
  if (/\bclarify scope\b/.test(text) && /\b(request|ask|future)\b/.test(text)) return true;
  return false;
}

export function suggestionDevJobDecision({
  suggestion,
  filesToModify = [],
  filesToCreate = [],
  createRoots = [],
} = {}) {
  if (isClarificationOnlySuggestion(suggestion)) {
    return { ok: false, reason: "clarification-only suggestion" };
  }

  const scope = sanitizeSuggestionScope({ filesToModify, filesToCreate, createRoots });
  const safeScopeCount = scope.filesToModify.length + scope.filesToCreate.length + scope.createRoots.length;
  if (safeScopeCount === 0) {
    return { ok: false, reason: scope.dropped.length > 0 ? "no safe repo file scope" : "no repo file scope" };
  }

  return { ok: true, reason: null };
}

export function suggestionReviewKey({
  artifactId = null,
  suggestionIndex = null,
  suggestion = "",
} = {}) {
  const idx = normalizeSuggestionIndex(suggestionIndex);
  if (artifactId != null && idx != null) return `artifact:${artifactId}:suggestion:${idx}`;
  return `suggestion:${cleanText(suggestion).slice(0, 240)}`;
}

export function suggestionDecisionEventJson({
  artifactId = null,
  suggestionIndex = null,
  suggestion = "",
  decision,
  reason = null,
  targetWorkItemId = null,
  targetJobId = null,
} = {}) {
  return {
    artifact_id: artifactId ?? null,
    suggestion_index: normalizeSuggestionIndex(suggestionIndex),
    suggestion_key: suggestionReviewKey({ artifactId, suggestionIndex, suggestion }),
    decision: decision || null,
    reason,
    target_work_item_id: targetWorkItemId ?? null,
    target_job_id: targetJobId ?? null,
    suggestion: cleanText(suggestion).slice(0, 500),
  };
}

export function collectHandledSuggestionKeys(events = []) {
  const handled = new Set();
  for (const event of asArray(events)) {
    if (!["job.suggestion_approved", "job.suggestion_skipped"].includes(event?.event_type)) continue;
    try {
      const parsed = event.event_json ? JSON.parse(event.event_json) : null;
      if (parsed?.suggestion_key) {
        handled.add(parsed.suggestion_key);
        continue;
      }
      if (parsed?.artifact_id != null) {
        handled.add(suggestionReviewKey({
          artifactId: parsed.artifact_id,
          suggestionIndex: parsed.suggestion_index,
          suggestion: parsed.suggestion,
        }));
      }
    } catch {
      // Legacy suggestion events did not have structured decision metadata.
    }
  }
  return handled;
}

export function createApprovedSuggestionFollowUp({
  sourceWorkItem,
  sourceJobId = null,
  artifactId = null,
  suggestionIndex = null,
  suggestion,
  taskSpec,
  filesToModify = [],
  filesToCreate = [],
  createRoots = [],
  priority = "low",
} = {}) {
  if (!sourceWorkItem?.id) throw new Error("sourceWorkItem is required");
  const suggestionText = cleanText(suggestion);
  if (!suggestionText) throw new Error("suggestion is required");
  const scope = sanitizeSuggestionScope({ filesToModify, filesToCreate, createRoots });
  if (scope.filesToModify.length + scope.filesToCreate.length + scope.createRoots.length === 0) {
    const reasons = scope.dropped.map((entry) => entry.reason).filter(Boolean);
    const suffix = reasons.length > 0 ? `: ${[...new Set(reasons)].slice(0, 3).join("; ")}` : "";
    throw new Error(`approved suggestion follow-up requires at least one safe repo file scope${suffix}`);
  }

  const sourceTitle = cleanText(sourceWorkItem.title) || `WI#${sourceWorkItem.id}`;
  const suggestionKey = suggestionReviewKey({ artifactId, suggestionIndex, suggestion: suggestionText });
  const origin = {
    work_item_id: sourceWorkItem.id,
    job_id: sourceJobId ?? null,
    artifact_id: artifactId ?? null,
    suggestion_index: normalizeSuggestionIndex(suggestionIndex),
    suggestion_key: suggestionKey,
  };

  const followUp = createWorkItem(
    `Improvement: ${trimForTitle(sourceTitle, 90)}`,
    [
      `Approved assessor suggestion from WI#${sourceWorkItem.id}.`,
      sourceJobId ? `Source job: #${sourceJobId}.` : null,
      "",
      "Suggestion:",
      suggestionText,
    ].filter((line) => line != null).join("\n"),
    priority,
    {
      source: "assessor_suggestion",
      requested_by: "human",
      mode: "build",
      governance_tier: sourceWorkItem.governance_tier || "mvp",
      metadata: {
        from_suggestion: true,
        suggestion_origin: origin,
      },
    },
  );

  const payload = {
    original_job_id: sourceJobId ?? null,
    origin_work_item_id: sourceWorkItem.id,
    origin_artifact_id: artifactId ?? null,
    origin_suggestion_index: normalizeSuggestionIndex(suggestionIndex),
    origin_suggestion_key: suggestionKey,
    task_spec: taskSpec || `## Improvement Required\n${suggestionText}`,
    files_to_modify: scope.filesToModify,
    files_to_create: scope.filesToCreate,
    create_roots: scope.createRoots,
    success_criteria: [suggestionText],
    from_suggestion: true,
  };

  const job = createJob({
    work_item_id: followUp.id,
    job_type: "dev",
    title: `Improvement: ${trimForTitle(suggestionText, 80)}`,
    parent_job_id: sourceJobId,
    priority: "low",
    model_tier: "standard",
    reasoning_effort: "medium",
    payload_json: JSON.stringify(payload),
  });
  if (sourceJobId != null) addDependency(job.id, sourceJobId, "hard");
  refreshWorkItemStatus(followUp.id);

  return {
    workItem: getWorkItem(followUp.id) || followUp,
    job,
    payload,
    suggestionKey,
  };
}
