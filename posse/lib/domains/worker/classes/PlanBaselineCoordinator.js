import { getJob, listJobsByWorkItem } from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { TERMINAL_JOB_STATUSES } from "../../../catalog/job.js";
import { withBaselineCheckout } from "../../verification/functions/baseline-checkout.js";
import { environmentFilesFingerprint, repositoryFingerprint } from "../../verification/functions/receipt-fingerprint.js";
import { describeToolchain, toolchainFingerprint } from "../../settings/functions/verification-policy.js";
import { effectiveVerificationPolicy } from "../functions/helpers/frozen-test-execution.js";
import { executeReceipt, findFrozenTestBaseline, resolveFrozenTestPlan, retryAfterDependencyRepair } from "../functions/helpers/test-execution-receipt.js";
import { PlanBaselineChecks } from "./PlanBaselineChecks.js";

export class PlanBaselineCoordinator {
  #pending = new Map();

  async ensure({ job, cwd, signal = null, repairDependencies = null, onProgress = () => {} }) {
    const planId = job.job_type === "plan" ? job.id : parseJobPayload(job)._plan_baseline_job_id;
    if (!planId || !cwd) return;
    const parent = getJob(planId);
    const manifest = parseJobPayload(parent)._development_baseline;
    if (!parent || !manifest?.groups?.length) return;
    // Submission may require human approval. In that case the first admitted
    // child performs the same durable plan batch after the approval resolves.
    if (job.job_type === "plan" && listJobsByWorkItem(job.work_item_id).some((child) =>
      child.parent_job_id === planId && child.job_type === "human_input"
      && !TERMINAL_JOB_STATUSES.includes(child.status))) return;
    const policy = effectiveVerificationPolicy({ cwd });
    const key = JSON.stringify([await repositoryFingerprint(cwd), planId, manifest,
      policy.fingerprint, toolchainFingerprint(describeToolchain({ projectDir: cwd })), environmentFilesFingerprint(cwd)]);
    // Every child waits for the whole starting-point batch, including a child
    // whose individual receipt was written before an interrupted plan resumed.
    for (;;) {
      signal?.throwIfAborted();
      let pending = this.#pending.get(key);
      if (!pending) {
        pending = this.#capture({ parent, manifest, cwd, policy, signal, repairDependencies, onProgress });
        this.#pending.set(key, pending);
        pending.finally(() => {
          if (this.#pending.get(key) === pending) this.#pending.delete(key);
        }).catch(() => {});
      }
      try {
        await waitForBatch(pending, signal);
        return;
      } catch (error) {
        signal?.throwIfAborted();
        // A canceled owner cannot cancel another admitted consumer. Resume
        // from persisted receipts with the surviving consumer's cancellation.
        if (error?.name !== "AbortError") throw error;
      }
    }
  }

  async #capture({ parent, manifest, cwd, policy, signal, repairDependencies, onProgress }) {
    for (const group of manifest.groups) {
      signal?.throwIfAborted();
      const jobs = group.job_ids.map((id) => getJob(id)).filter((job) => job
        && !TERMINAL_JOB_STATUSES.includes(job.status)
        && parseJobPayload(job)._plan_baseline_job_id === parent.id);
      if (!jobs.length) continue;
      onProgress(`Plan #${parent.id}: collecting shared baseline at ${group.commit.slice(0, 12)} for ${jobs.length} job(s)`);
      await withBaselineCheckout({ cwd, commit: group.commit, run: async (executionCwd, cleanup) => {
        const checks = new PlanBaselineChecks();
        for (const job of jobs) {
          signal?.throwIfAborted();
          // A downstream check may be supplied by an earlier task. Resolve it
          // on the starting tree without pruning the submitted job's contract.
          const payload = parseJobPayload(job);
          const resolved = resolveFrozenTestPlan(job, payload, { cwd: executionCwd });
          if (!resolved || resolved.source === "operator_approved_operation") continue;
          // Normalize singleton and registry plans onto the same check path.
          // The stored receipt freezes this representation for post-change comparison.
          const selectedChecks = resolved.execution_checks?.length
            ? resolved.execution_checks : [{ ...resolved, id: resolved.check_id }];
          const plan = { ...resolved, execution_checks: selectedChecks.flatMap((check) =>
            check.unit_test_paths?.length > 1 ? check.unit_test_paths.map((file) => ({ ...check,
              id: `${check.id || check.check_id}:${file}`, unit_test_paths: [file], covered_unit_test_paths: [file],
            })) : [check]) };
          const existing = findFrozenTestBaseline(job.id, { policy, projectDir: executionCwd, planId: plan.plan_id });
          if (existing?.commit_hash === group.commit) continue;
          const run = (dependencyRepair = null) => executeReceipt({ job, plan, phase: "baseline",
            cwd: executionCwd, commitHash: group.commit, policy, signal, baselineChecks: checks,
            cleanupWorktree: cleanup, dependencyRepair, baselinePlanJobId: parent.id });
          const receipt = await retryAfterDependencyRepair(await run(),
            repairDependencies ? (unavailable) => repairDependencies(job, unavailable, executionCwd) : null, run);
          onProgress(`Plan #${parent.id}: baseline for job #${job.id} ${receipt.status}`);
        }
      } });
    }
  }
}

function waitForBatch(pending, signal) {
  if (!signal) return pending;
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => reject(signal.reason);
    signal.addEventListener("abort", abort, { once: true });
    pending.then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

const coordinator = new PlanBaselineCoordinator();
export const ensurePlanBaseline = (options) => coordinator.ensure(options);
