import { C } from "../../../../shared/format/functions/colors.js";
import { getSetting } from "../../../settings/functions/repository-settings.js";
import { repairVerificationPrerequisites } from "../../../verification/functions/prerequisite-adapters.js";

export async function repairTestDependencies(worker, job, worktreePath, {
  signal = null,
  phase = "verification",
  receipt = null,
} = {}) {
  worker.emit(
    job.id,
    `${C.dim}[test-${phase}] WI#${job.work_item_id} job #${job.id}: repository test dependencies unavailable; repairing the isolated worktree once${C.reset}`,
  );
  const networkPolicy = String(getSetting("verification_dependency_network_policy", {
    projectDir: worktreePath,
  }) || "cache_only");
  return repairVerificationPrerequisites({
    projectDir: worktreePath,
    command: receipt?.execution_command || receipt?.command || "",
    receipt,
    networkPolicy,
    signal,
    onProgress: (message) => worker.emit(
      job.id,
      `${C.dim}[test-${phase}] ${message}${C.reset}`,
    ),
  });
}
