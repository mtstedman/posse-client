// Artifact-domain catalogue.
//
// Artifact types used by the `artifacts` table CHECK constraint and by the
// task-mode / work-item-mode configuration that decides which artifact
// directories a job needs and which task modes a WI permits.

const sqlList = (values) => values.map((v) => `'${v}'`).join(", ");

export const ARTIFACT_TYPES = Object.freeze([
  "prompt",
  "response",
  "task_spec",
  "review",
  "summary",
  "diff",
  "log",
  "human_answer",
  "report",
  "nudge",
  "plan_primary",
  "plan_redteam",
  "plan_synthesis",
  "web_fetch_cache",
  "other",
]);
export const ARTIFACT_TYPE_LIST_SQL = sqlList(ARTIFACT_TYPES);

// Supported task modes and the directories each one needs provisioned.
export const TASK_MODES = Object.freeze({
  // Normal code editing — strict file scope, no artifact dirs needed.
  code: Object.freeze({ needsInputs: false, needsWorkspace: false, needsArtifacts: false }),
  // Reports, summaries, data exports — outputs to artifacts dir.
  report: Object.freeze({ needsInputs: false, needsWorkspace: false, needsArtifacts: true }),
  // Images, generated assets, creative content — outputs to artifacts dir.
  content: Object.freeze({ needsInputs: false, needsWorkspace: false, needsArtifacts: true }),
  // Generated images (PNG, JPG, WebP) — outputs to artifacts dir.
  image: Object.freeze({ needsInputs: false, needsWorkspace: false, needsArtifacts: true }),
  // Process uploaded files — inputs read-only, workspace mutable, outputs to artifacts.
  intake_processing: Object.freeze({ needsInputs: true, needsWorkspace: true, needsArtifacts: true }),
});

// Work-item-level intent that constrains the planner's task-mode choices.
export const WI_MODES = Object.freeze({
  build: Object.freeze({ allowedTaskModes: ["code", "image", "content"], defaultTaskMode: "code" }),
  image: Object.freeze({ allowedTaskModes: ["image", "content"], defaultTaskMode: "image" }),
  report: Object.freeze({ allowedTaskModes: ["report", "content"], defaultTaskMode: "report" }),
});

// Task modes whose commits do not enforce scope on `git add` (artifact
// outputs go to dedicated dirs, not into the repo's tracked files). Used by
// git/commit-scope.js to short-circuit the scope check for these modes.
export const UNSCOPED_GIT_ADD_TASK_MODES = new Set([
  "report", "content", "image", "intake_processing",
]);
