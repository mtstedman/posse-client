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
  // The main compiler repairs common planner mistakes such as an artificer
  // task carrying concrete PHP/HTML/source scope. Count that repairable raw
  // shape here so the modality guard does not preempt normalization.
  return hasRepoFileScope(task);
}

export function evaluatePlanModality({ workItem = null, intakeHints = {}, tasks = [] } = {}) {
  const requiredOutputs = requiredWorkItemOutputs(workItem, intakeHints);
  const repoExecutionRequired = requiresRepositoryExecution(workItem, intakeHints);
  const taskList = Array.isArray(tasks) ? tasks.filter(Boolean) : [];
  const hasRepoOutputTask = taskList.some(plannerTaskProducesRepoOutput);
  const observedOutputs = [];
  if (hasRepoOutputTask) observedOutputs.push("repo");
  if (taskList.some((task) => normalizedTaskShape(task).jobType === "artificer")) observedOutputs.push("artifact");

  const missingOutputs = requiredOutputs.filter((output) => {
    if (output === "repo") return repoExecutionRequired && !hasRepoOutputTask;
    return false;
  });
  return {
    ok: missingOutputs.length === 0,
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
