import { ensureBootDependenciesInWorker } from "../../../system/functions/dependency-sync.js";
import { C } from "../../../../shared/format/functions/colors.js";

export async function repairTestDependencies(worker, job, worktreePath, {
  signal = null,
  phase = "verification",
} = {}) {
  worker.emit(
    job.id,
    `${C.dim}[test-${phase}] WI#${job.work_item_id} job #${job.id}: repository test dependencies unavailable; repairing the isolated worktree once${C.reset}`,
  );
  return ensureBootDependenciesInWorker({
    projectDir: worktreePath,
    includeNode: true,
    includePython: false,
    includeComposer: true,
    includeGo: false,
    includeCargo: false,
    includeNativeBinaries: false,
    includeJinaModel: false,
    includeScip: false,
    includeTestTools: false,
    // Only the isolated repository decides this repair. A failure in Posse's
    // own package must not discard a successful target-repository install.
    includePosseRoot: false,
    adoptNodeInstall: true,
  }, {
    signal,
    onProgress: (message) => worker.emit(
      job.id,
      `${C.dim}[test-${phase}] ${message}${C.reset}`,
    ),
  });
}
