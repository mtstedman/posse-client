import { REPAIR_PROTOCOL, REPAIR_REJECTIONS } from "../../../catalog/repair.js";
import { inspectOperatorRepair, applyOperatorRepair } from "../../queue/functions/operator-repair.js";
import { commonEnvelope, validateRepositoryBinding } from "./work-item-feed.js";
import { redactBridgeValue } from "./redaction.js";

function binding(args, context) {
  const repo = validateRepositoryBinding(args, context);
  if (!repo.ok) return repo;
  for (const key of ["work_item_id", "job_id"]) {
    if (!/^[1-9][0-9]*$/.test(String(args[key] ?? "")) || !Number.isSafeInteger(Number(args[key]))) return { ok: false, reason: "invalid_identity" };
  }
  return repo;
}
function invoke(args, context, apply) {
  const repo = binding(args, context);
  if (!repo.ok) return repo;
  try {
    const normalized = { ...args, work_item_id: Number(args.work_item_id), job_id: Number(args.job_id) };
    const result = apply ? applyOperatorRepair(normalized) : inspectOperatorRepair(normalized.work_item_id, normalized.job_id);
    if (result.ok === false) return result;
    return { ...commonEnvelope(REPAIR_PROTOCOL, repo.repoPath, context), ...boundedResult(result) };
  } catch (err) {
    return { ok: false, reason: REPAIR_REJECTIONS.includes(err.message) ? err.message : "internal" };
  }
}
export function inspectRepair(args, context = {}) { return invoke(args, context, false); }
export function applyRepair(args, context = {}) { return invoke(args, context, true); }

// Redact complete values before bounding cells; full errors remain available in scoped logs.
function boundedResult(result) {
  const value=redactBridgeValue(result);
  for (const job of [value.job,...(value.recovery_gates || [])]) {
    for (const key of ["last_error","assessment_last_error"]) {
      if (typeof job?.[key]==="string") job[key]=job[key].slice(0,2000);
    }
  }
  return value;
}
