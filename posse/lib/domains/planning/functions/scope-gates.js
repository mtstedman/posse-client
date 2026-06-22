import { PLANNER_UNDER_SCOPED_BROAD_GATE_VALUES } from "../../settings/functions/catalog.js";

const BROAD_SCOPE_TASK_RE = /\b(review|audit|ux|ui|flow|forms?|pages?|sitewide|cross[- ]page|all|every|overall|polish|glow[- ]?up|high value|edge cases?)\b/i;
const BROAD_GATE_MODES = new Set(PLANNER_UNDER_SCOPED_BROAD_GATE_VALUES);

export function parseUnderScopedBroadGateMode(rawValue) {
  const value = String(rawValue || "warn").trim().toLowerCase();
  if (BROAD_GATE_MODES.has(value)) return value;
  return "warn";
}

export function isBroadNarrowScopedCodeTask(task = {}) {
  const filesToModify = Array.isArray(task.files_to_modify) ? task.files_to_modify : [];
  const filesToCreate = Array.isArray(task.files_to_create) ? task.files_to_create : [];
  const createRoots = Array.isArray(task.create_roots) ? task.create_roots : [];
  const scopeCount = filesToModify.length + filesToCreate.length + createRoots.length;
  if (scopeCount === 0 || scopeCount > 2 || createRoots.includes(".")) return false;

  const text = [
    task.title || "",
    task.task_spec || "",
    task.instructions || "",
    ...(Array.isArray(task.success_criteria) ? task.success_criteria : [task.success_criteria || ""]),
  ].join("\n");
  return BROAD_SCOPE_TASK_RE.test(String(text || ""));
}
