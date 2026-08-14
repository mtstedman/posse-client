import { ASSESSABLE_JOB_TYPES, TERMINAL_JOB_STATUSES } from "../../../../catalog/job.js";
import {
  getDependencies,
  getJob,
  listJobsByWorkItem,
  logEvent,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";

const SCOPE_KEYS = Object.freeze([
  "files_to_modify",
  "files_to_create",
  "files_to_delete",
]);
const TERMINAL_STATUSES = new Set(TERMINAL_JOB_STATUSES);

function normalizePath(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/{2,}/g, "/");
  if (!normalized || normalized === "." || normalized === "..") return null;
  if (normalized.startsWith("../") || normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  return normalized;
}

function uniquePaths(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizePath)
    .filter(Boolean))];
}

function scopeForPayload(payload = {}) {
  const scope = {};
  for (const key of SCOPE_KEYS) scope[key] = uniquePaths(payload?.[key]);
  return scope;
}

function flatScope(scope = {}) {
  return uniquePaths(SCOPE_KEYS.flatMap((key) => scope?.[key] || []));
}

function mergeScopes(...scopes) {
  const merged = {};
  for (const key of SCOPE_KEYS) {
    merged[key] = uniquePaths(scopes.flatMap((scope) => scope?.[key] || []));
  }
  return merged;
}

function taskRootAndPlan(job) {
  let cursor = job || null;
  const seen = new Set();
  while (cursor?.parent_job_id && !seen.has(cursor.id)) {
    seen.add(cursor.id);
    const parent = getJob(cursor.parent_job_id);
    if (!parent) break;
    if (parent.job_type === "plan") return { taskRoot: cursor, planJob: parent };
    cursor = parent;
  }
  return { taskRoot: job || null, planJob: null };
}

function taskText(job, payload = parseJobPayload(job)) {
  return [
    job?.title,
    payload?.task_spec,
    payload?.instructions,
    ...(Array.isArray(payload?.success_criteria) ? payload.success_criteria : []),
  ].filter(Boolean).join("\n");
}

function pathMentioned(text, filePath) {
  const haystack = String(text || "").replace(/\\/g, "/").toLowerCase();
  const needle = String(filePath || "").toLowerCase();
  if (!needle) return false;
  let from = 0;
  while (from <= haystack.length) {
    const index = haystack.indexOf(needle, from);
    if (index < 0) return false;
    const before = index === 0 ? "" : haystack[index - 1];
    const afterIndex = index + needle.length;
    const after = afterIndex >= haystack.length ? "" : haystack[afterIndex];
    const pathChar = /[a-z0-9_.@()+-]/;
    if ((!before || !pathChar.test(before)) && (!after || !pathChar.test(after))) return true;
    from = index + needle.length;
  }
  return false;
}

function extractedPathTokens(text) {
  const normalized = String(text || "").replace(/\\/g, "/");
  const out = new Set();
  const add = (value) => {
    const token = normalizePath(String(value || "").replace(/^[`'"([{]+|[`'"\])},;:.]+$/g, ""));
    if (token) out.add(token);
  };
  for (const match of normalized.matchAll(/`([^`]+)`/g)) add(match[1]);
  for (const match of normalized.matchAll(/(?:^|\s|[('"\[])((?:\.?[A-Za-z0-9_@()+-]+\/)+[A-Za-z0-9_@()+.-]+)(?=$|\s|[)'"\]},;:])/g)) {
    add(match[1]);
  }
  return [...out];
}

function dependencyIds(job) {
  try {
    return getDependencies(job.id)
      .map((edge) => Number(edge.depends_on_job_id))
      .filter((id) => Number.isInteger(id) && id > 0);
  } catch {
    return [];
  }
}

export function buildAssessmentTaskBoundary(job) {
  if (!job?.id || !job?.work_item_id) return null;
  const { taskRoot, planJob } = taskRootAndPlan(job);
  const currentPayload = parseJobPayload(job);
  const rootPayload = taskRoot?.id === job.id ? currentPayload : parseJobPayload(taskRoot);
  const currentScope = mergeScopes(scopeForPayload(rootPayload), scopeForPayload(currentPayload));
  const directTasks = planJob
    ? listJobsByWorkItem(job.work_item_id)
      .filter((candidate) => Number(candidate.parent_job_id) === Number(planJob.id))
      .filter((candidate) => ASSESSABLE_JOB_TYPES.has(candidate.job_type) || candidate.job_type === "promote")
    : [];
  const orderedTaskIds = directTasks.map((candidate) => Number(candidate.id));
  const siblings = directTasks
    .filter((candidate) => Number(candidate.id) !== Number(taskRoot?.id))
    .map((candidate) => {
      const payload = parseJobPayload(candidate);
      return {
        job_id: candidate.id,
        task_index: orderedTaskIds.indexOf(Number(candidate.id)),
        title: candidate.title,
        status: candidate.status,
        dependency_job_ids: dependencyIds(candidate),
        scope: scopeForPayload(payload),
        task_text: taskText(candidate, payload),
      };
    });

  return {
    schema_version: 1,
    plan_job_id: planJob?.id || null,
    current: {
      job_id: job.id,
      root_job_id: taskRoot?.id || job.id,
      task_index: orderedTaskIds.indexOf(Number(taskRoot?.id)),
      title: taskRoot?.title || job.title,
      status: job.status,
      scope: currentScope,
      task_text: [taskText(taskRoot, rootPayload), taskText(job, currentPayload)]
        .filter(Boolean)
        .join("\n"),
    },
    siblings,
  };
}

export function renderAssessmentTaskBoundary(boundary) {
  const siblingRows = (boundary?.siblings || []).map((sibling) => ({
    job_id: sibling.job_id,
    task_index: sibling.task_index,
    title: sibling.title,
    status: sibling.status,
    dependency_job_ids: sibling.dependency_job_ids,
    scope: sibling.scope,
  }));
  return [
    "ASSESSMENT TASK OWNERSHIP (machine-derived; exact paths):",
    JSON.stringify({
      schema_version: boundary?.schema_version || 1,
      plan_job_id: boundary?.plan_job_id || null,
      current: boundary?.current || null,
      siblings: siblingRows,
    }, null, 2),
  ].join("\n");
}

export function classifySiblingOnlyAssessmentFailure(verdict, boundary) {
  if (verdict?.verdict !== "fail" || !boundary?.current) return null;
  const reasons = (Array.isArray(verdict.reasons) ? verdict.reasons : [])
    .map((reason) => String(reason || "").trim())
    .filter(Boolean);
  if (reasons.length === 0) return null;

  const currentPaths = new Set(flatScope(boundary.current.scope));
  const pendingSiblings = (boundary.siblings || [])
    .filter((sibling) => !TERMINAL_STATUSES.has(String(sibling.status || "")));
  const allKnownPaths = new Set(currentPaths);
  const siblingOwners = new Map();
  for (const sibling of boundary.siblings || []) {
    for (const filePath of flatScope(sibling.scope)) allKnownPaths.add(filePath);
  }
  for (const sibling of pendingSiblings) {
    for (const filePath of flatScope(sibling.scope)) {
      if (currentPaths.has(filePath)) continue;
      if (pathMentioned(boundary.current.task_text, filePath)) continue;
      if (!siblingOwners.has(filePath)) siblingOwners.set(filePath, []);
      siblingOwners.get(filePath).push(sibling.job_id);
    }
  }
  if (siblingOwners.size === 0) return null;

  const knownPaths = [...allKnownPaths];
  const citedPaths = new Set();
  for (const reason of reasons) {
    const currentMentions = [...currentPaths].filter((filePath) => pathMentioned(reason, filePath));
    if (currentMentions.length > 0) return null;
    const siblingMentions = [...siblingOwners.keys()].filter((filePath) => pathMentioned(reason, filePath));
    if (siblingMentions.length === 0) return null;
    const unknownTokens = extractedPathTokens(reason)
      .filter((token) => !knownPaths.some((known) => token === known || pathMentioned(token, known)));
    if (unknownTokens.length > 0) return null;
    for (const filePath of siblingMentions) citedPaths.add(filePath);
  }

  return {
    kind: "pending_sibling_only_paths",
    cited_paths: [...citedPaths].sort(),
    sibling_job_ids: [...new Set([...citedPaths]
      .flatMap((filePath) => siblingOwners.get(filePath) || []))].sort((left, right) => left - right),
  };
}

export function recordAssessmentBoundaryEvent(job, classification, { repeated = false } = {}) {
  if (!job?.id || !classification) return;
  try {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: repeated
        ? EVENT_TYPES.JOB_ASSESSMENT_TASK_BOUNDARY_VIOLATION
        : EVENT_TYPES.JOB_ASSESSMENT_TASK_BOUNDARY_RETRY,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: repeated
        ? `Assessor repeated an out-of-task failure for pending sibling path(s): ${classification.cited_paths.join(", ")}`
        : `Retrying assessment after an out-of-task failure for pending sibling path(s): ${classification.cited_paths.join(", ")}`,
      event_json: JSON.stringify(classification),
    });
  } catch {
    // Keep assessment usable in isolated tests and partial DB states.
  }
}

export function __testExtractedAssessmentPathTokens(text) {
  return extractedPathTokens(text);
}
