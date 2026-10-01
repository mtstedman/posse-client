// lib/domains/worker/functions/helpers/baseline-test-debt.js
//
// A planner-declared test command whose frozen baseline already fails as a
// product failure (baseline debt) cannot verify the work item: the before/after
// comparison can only report "persistent" or "fixed". Say so once per work
// item with a warning event, keep the facts on the job payload for the
// assessor, and carry them into any replan so the planner does not keep
// relying on that command. Executing declared commands at plan time is a
// separate, deferred change; this only reports what the baseline showed.

import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import { BASELINE_TEST_DEBT_PAYLOAD_KEY } from "../../../../catalog/verification.js";
import { listJobsByWorkItem, logEvent, updateJobPayload } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { verificationOutcome } from "./verification-outcome.js";

export { BASELINE_TEST_DEBT_PAYLOAD_KEY };
const MAX_REPLAN_DEBTS = 8;

function debtKey(debt = {}) {
  return [debt.command || "", debt.cwd_relative || "", debt.failure_fingerprint || ""].join("\0");
}

/**
 * The debt record for a planner baseline that failed as a product failure,
 * or null for anything else (passed, infrastructure, other command sources).
 */
export function baselineTestDebtFromReceipt(receipt) {
  if (!receipt || receipt.phase !== "baseline" || receipt.source !== "planner") return null;
  const outcome = receipt.verification_outcome || verificationOutcome(receipt);
  if (outcome?.type !== "baseline_debt") return null;
  return {
    schema_version: 1,
    command: receipt.command || null,
    cwd_relative: receipt.cwd_relative || null,
    commit_hash: receipt.commit_hash || null,
    exit_code: receipt.exit_code ?? null,
    test_counts: receipt.test_counts || null,
    failure_fingerprint: receipt.failure_fingerprint || null,
    detected_at: receipt.created_at || new Date().toISOString(),
  };
}

/**
 * Store the debt on the job payload and emit one warning event per work item
 * and failing command. Best effort: never throws.
 */
export function recordBaselineTestDebt(worker, job, receipt, {
  listJobs = listJobsByWorkItem,
  emitEvent = logEvent,
  savePayload = updateJobPayload,
} = {}) {
  try {
    const debt = baselineTestDebtFromReceipt(receipt);
    if (!debt || !job) return null;
    const payload = worker?.parsePayload ? worker.parsePayload(job) : parseJobPayload(job);
    const existing = payload[BASELINE_TEST_DEBT_PAYLOAD_KEY];
    if (existing && debtKey(existing) === debtKey(debt)) return existing;
    payload[BASELINE_TEST_DEBT_PAYLOAD_KEY] = { ...debt, job_id: job.id };
    job.payload_json = JSON.stringify(payload);
    savePayload(job.id, job.payload_json);

    const alreadyWarned = (listJobs(job.work_item_id) || []).some((sibling) => (
      sibling?.id !== job.id
      && debtKey(parseJobPayload(sibling)?.[BASELINE_TEST_DEBT_PAYLOAD_KEY] || {}) === debtKey(debt)
    ));
    const message = `Planner test command \`${debt.command}\` already fails before any change (exit ${debt.exit_code ?? "unknown"}); it cannot verify this work item`;
    if (!alreadyWarned) {
      emitEvent({
        work_item_id: job.work_item_id,
        job_id: job.id,
        event_type: EVENT_TYPES.WORK_ITEM_TEST_BASELINE_FAILING,
        actor_type: EVENT_ACTORS.WORKER,
        message,
        event_json: JSON.stringify(payload[BASELINE_TEST_DEBT_PAYLOAD_KEY]),
      });
    }
    worker?.emit?.(job.id, `[test-intake] WI#${job.work_item_id} job #${job.id}: warning: ${message}`);
    return payload[BASELINE_TEST_DEBT_PAYLOAD_KEY];
  } catch {
    return null;
  }
}

function countsText(debt) {
  const counts = debt?.test_counts;
  if (counts?.total == null || !Number.isFinite(Number(counts.total))) return "";
  return `; ${counts.total} test(s) reported`;
}

// Assessor prompt block for a stored debt, or null.
export function renderBaselineTestDebt(payload = {}) {
  const debt = payload?.[BASELINE_TEST_DEBT_PAYLOAD_KEY];
  if (!debt?.command) return null;
  return [
    "PLANNER TEST COMMAND ALREADY FAILING (baseline debt):",
    `  \`${debt.command}\` failed at ${String(debt.commit_hash || "the pre-change commit").slice(0, 12)} before this job changed anything (exit ${debt.exit_code ?? "unknown"}${countsText(debt)}).`,
    "  Its result cannot show that this task works: a persistent failure is not a regression, and it is not passing evidence either.",
    "  Judge the success criteria from the diff and other deterministic evidence, and say in your reasons that the declared suite was already red.",
    "",
  ].join("\n");
}

/** Distinct debts recorded on a work item's jobs, for the replan payload. */
export function collectBaselineTestDebt(jobs = []) {
  const byKey = new Map();
  for (const job of jobs || []) {
    const debt = parseJobPayload(job)?.[BASELINE_TEST_DEBT_PAYLOAD_KEY];
    if (!debt?.command || byKey.has(debtKey(debt))) continue;
    byKey.set(debtKey(debt), {
      command: debt.command,
      cwd_relative: debt.cwd_relative || null,
      commit_hash: debt.commit_hash || null,
      exit_code: debt.exit_code ?? null,
      job_id: debt.job_id ?? job?.id ?? null,
    });
    if (byKey.size >= MAX_REPLAN_DEBTS) break;
  }
  return [...byKey.values()];
}
