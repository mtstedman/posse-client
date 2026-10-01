// Artifact-domain catalogue.
//
// Artifact types used by the `artifacts` table CHECK constraint and by the
// task-mode / work-item-mode configuration that decides which artifact
// directories a job needs and which task modes a WI permits.

const sqlList = (values) => values.map((v) => `'${v}'`).join(", ");

// Image generations one artificer Job may request. The deterministic MCP
// server enforces it (env override for tests); the planner sizes image Jobs
// by it so a larger set is split across Jobs instead of failing at the cap.
export const IMAGE_GENERATION_MAX_CALLS_PER_JOB = 12;

// One image generation request, and separately the download of its result,
// may each run this long.
export const IMAGE_GENERATION_TIMEOUT_MS = 600_000;

// One external image converter run (sharp, ImageMagick, ffmpeg) may take this
// long before the harness kills it.
export const IMAGE_CONVERTER_TIMEOUT_MS = 30_000;

// compose_sprite_sheet: the artificer packs scoped images into one PNG atlas
// plus a JSON frame map. Inputs are bounded before any decode: per-file bytes
// and header dimensions, and the atlas size before its pixel buffer is
// allocated. The call deadline stays inside the default MCP request watchdog.
export const SPRITE_SHEET_LIMITS = Object.freeze({
  maxInputs: 1024,
  maxInputBytes: 20 * 1024 * 1024,
  maxTotalInputBytes: 256 * 1024 * 1024,
  maxInputSide: 8192,
  maxInputPixels: 4096 * 4096,
  maxCellSide: 512,
  maxPadding: 64,
  maxAtlasSide: 8192,
  maxAtlasPixels: 4096 * 4096,
  maxPathChars: 1_024,
  converterConcurrency: 4,
  callTimeoutMs: 150_000,
});

// How each input fills its cell: contain keeps the aspect ratio and centers it
// over the background; cover keeps the aspect ratio and crops to fill; stretch
// scales each axis independently.
export const SPRITE_SHEET_FIT_MODES = Object.freeze(["contain", "cover", "stretch"]);

// Inputs must carry one of these file signatures before any decoder or
// converter sees them. No SVG or other scriptable formats.
export const SPRITE_SHEET_INPUT_FORMATS = Object.freeze(["png", "jpeg", "webp", "gif"]);

export const SPRITE_SHEET_MAP_VERSION = 1;
export const SPRITE_SHEET_OBSERVATION_TYPE = "artifact.sprite_sheet";

// Operator-provided text files under .posse/resources/inputs/wi-N become
// work-item hash refs, so dev/planner/assessor jobs read them through
// traverse_ref instead of a path their tools cannot reach.
export const WORK_ITEM_INPUT_OBJECT_TYPE = "work_item.input";
export const WORK_ITEM_INPUT_LIMITS = Object.freeze({
  maxFiles: 20,
  maxBytesPerFile: 1_000_000,
  maxDepth: 3,
});

// Replan planners/researchers read the WI branch from a per-job detached
// checkout at .posse/resources/context/wi-N/<this dir>/job-<id>. Their role
// teardown removes it; worktree GC sweeps ones left by finished jobs.
export const REPLAN_READONLY_WORKTREE_DIR = "replan-readonly";

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
  // DB-only work — the entire write surface is the project database via
  // project_db_query. No file scope, no file locks (see queue/file-locks.js
  // jobNeedsWriteLocks), no commit, no artifact dirs. The role runs without
  // file-write tools; the operator's project-db grant is the only mutation
  // channel.
  db: Object.freeze({ needsInputs: false, needsWorkspace: false, needsArtifacts: false }),
});

// Work-item-level intent that constrains the planner's task-mode choices.
export const WI_MODES = Object.freeze({
  build: Object.freeze({ allowedTaskModes: ["code", "image", "content", "db"], defaultTaskMode: "code" }),
  image: Object.freeze({ allowedTaskModes: ["image", "content"], defaultTaskMode: "image" }),
  report: Object.freeze({ allowedTaskModes: ["report", "content"], defaultTaskMode: "report" }),
});

// Task modes whose commits do not enforce scope on `git add` (artifact
// outputs go to dedicated dirs, not into the repo's tracked files). Used by
// git/commit-scope.js to short-circuit the scope check for these modes.
export const UNSCOPED_GIT_ADD_TASK_MODES = new Set([
  "report", "content", "image", "intake_processing",
]);
