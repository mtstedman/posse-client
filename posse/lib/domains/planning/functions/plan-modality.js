import {
  requiredWorkItemOutputs,
  requiresRepositoryExecution,
} from "../../intake/functions/objective-contract.js";

const REPO_FILE_EXTENSION_RE =
  /\.(?:c|cc|cpp|cs|css|go|h|hpp|html?|java|js|jsx|json|mjs|cjs|php|py|rb|rs|scss|sh|sql|svelte|ts|tsx|vue|xml|ya?ml)$/iu;

function normalizedPathList(value) {
  return (Array.isArray(value) ? value : [])
    .map((entry) => String(entry || "").replace(/\\/gu, "/").trim())
    .filter(Boolean);
}

function hasRepoFileScope(task = {}, { allowAnyCreatedFile = false } = {}) {
  const modified = [
    ...normalizedPathList(task.files_to_modify),
    ...normalizedPathList(task.files_to_delete),
  ];
  if (modified.some((filePath) => !filePath.includes(".posse/resources/artifacts/"))) return true;
  const createRoots = normalizedPathList(task.create_roots);
  if (createRoots.some((rootPath) => !rootPath.includes(".posse/resources/artifacts/"))) return true;
  return normalizedPathList(task.files_to_create).some((filePath) => (
    !filePath.includes(".posse/resources/artifacts/")
    && (allowAnyCreatedFile || REPO_FILE_EXTENSION_RE.test(filePath))
  ));
}

function normalizedTaskShape(task = {}) {
  let jobType = String(task.job_type || "dev").trim().toLowerCase();
  let taskMode = String(task.task_mode || "code").trim().toLowerCase();
  if (jobType === "code") jobType = "dev";
  if (taskMode === "dev") taskMode = "code";
  if (["content", "image", "report", "intake_processing"].includes(jobType)) {
    if (!task.task_mode || taskMode === "code") taskMode = jobType;
    jobType = "artificer";
  }
  return { jobType, taskMode };
}

export function plannerTaskProducesRepoOutput(task = {}) {
  const { jobType, taskMode } = normalizedTaskShape(task);
  if (jobType === "promote") return true;
  if ((jobType === "dev" || jobType === "fix") && taskMode === "db") return true;
  if ((jobType === "dev" || jobType === "fix") && taskMode === "code") {
    // A declared dev/fix task is repository execution even when its output is
    // documentation, configuration, or an extensionless file such as a
    // Dockerfile. The path boundary, not a source-extension allowlist, is the
    // relevant output contract here.
    return hasRepoFileScope(task, { allowAnyCreatedFile: true });
  }
  // The file-kind split promotes generated images named at repo paths (with a
  // directory component; bare names stay artifacts) into the repository.
  if (taskMode === "image" || task.needs_image_generation === true) {
    const promotedImage = normalizedPathList(task.files_to_create).some((filePath) => (
      filePath.includes("/") && !filePath.includes(".posse/resources/artifacts/")
    ));
    if (promotedImage) return true;
  }
  // The main compiler repairs common planner mistakes such as an artificer
  // task carrying concrete PHP/HTML/source scope. Count that repairable raw
  // shape here so the modality guard does not preempt normalization.
  return hasRepoFileScope(task);
}

// Every planner-issued clarification queues a follow-up plan behind its gate,
// including plans that also schedule independent executable work.
// Bound the chain so a planner that keeps stopping at human input reaches the
// modality-mismatch failure path instead of gating forever.
export const MAX_CONSECUTIVE_HUMAN_INPUT_DEFERRALS = 2;

export function evaluatePlanModality({
  workItem = null,
  intakeHints = {},
  tasks = [],
  humanInputDeferrals = 0,
} = {}) {
  const requiredOutputs = requiredWorkItemOutputs(workItem, intakeHints);
  const repoExecutionRequired = requiresRepositoryExecution(workItem, intakeHints);
  const taskList = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const hasHumanInput = taskList.some((task) => normalizedTaskShape(task).jobType === "human_input");
  const deferredByHumanInput = taskList.length > 0
    && taskList.every((task) => normalizedTaskShape(task).jobType === "human_input");
  const hasRepoOutputTask = taskList.some(plannerTaskProducesRepoOutput);
  const observedOutputs = [];
  if (hasRepoOutputTask) observedOutputs.push("repo");
  if (taskList.some((task) => normalizedTaskShape(task).jobType === "artificer")) observedOutputs.push("artifact");
  if (hasHumanInput) observedOutputs.push("human_input");

  const missingOutputs = requiredOutputs.filter((output) => {
    if (output === "repo") return repoExecutionRequired && !hasRepoOutputTask;
    return false;
  });
  const deferralAvailable = (Number(humanInputDeferrals) || 0) < MAX_CONSECUTIVE_HUMAN_INPUT_DEFERRALS;
  const defersMissingOutput = deferredByHumanInput && missingOutputs.length > 0;
  const acceptedByHumanInputDeferral = defersMissingOutput && deferralAvailable;
  return {
    // A planner that cannot access a required input is allowed to stop at a
    // human gate. The repository deliverable remains required after the gate;
    // rejecting this coordination-only plan merely pays for another planner
    // call that still lacks the input. The compiler owes a follow-up plan.
    ok: (missingOutputs.length === 0 || acceptedByHumanInputDeferral) && (!hasHumanInput || deferralAvailable),
    deferredByHumanInput,
    acceptedByHumanInputDeferral,
    requiresHumanInputContinuation: hasHumanInput && deferralAvailable,
    humanInputDeferralExhausted: hasHumanInput && !deferralAvailable,
    requiredOutputs,
    repoExecutionRequired,
    observedOutputs,
    missingOutputs,
    taskShapes: taskList.map((task) => ({
      title: String(task.title || "").slice(0, 120),
      ...normalizedTaskShape(task),
    })),
  };
}
