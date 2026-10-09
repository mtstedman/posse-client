// lib/domains/worker/functions/helpers/assessment-ignored-paths.js
//
// An assessor fail whose every cited path is one the repository ignores has no
// repair: git never commits an untracked ignored path, so a fix job told to
// edit, regenerate or commit it can only fail the same way again. Like a
// sibling-only fail, it gets one corrective reassessment and then the
// operator's assessment review gate, never an automatic fix.

import fs from "fs";
import path from "path";
import { logEvent } from "../../../queue/functions/index.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import { listIgnoredRepoPaths } from "../../../git/functions/ignored-paths.js";
import { EVENT_ACTORS, EVENT_TYPES } from "../../../../catalog/event.js";
import { assessmentVerdictPathTokens } from "./assessment-task-boundary.js";

const SCOPE_KEYS = Object.freeze(["files_to_modify", "files_to_create", "files_to_delete"]);
const CONTEXT_SCOPE_KEYS = Object.freeze(["allowed_files", "allowed_create_files", "allowed_delete_files"]);
const FILE_EXTENSION = /\.[A-Za-z0-9]{1,12}$/;
const LS_FILES_TIMEOUT_MS = 10_000;

function repoPath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/^(\.\/)+/, "").replace(/\/{2,}/g, "/").replace(/\/+$/, "");
  if (!normalized || normalized.includes("\0")) return null;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  if (normalized.split("/").includes("..")) return null;
  return normalized;
}

function pathList(values) {
  return (Array.isArray(values) ? values : []).map(repoPath).filter(Boolean);
}

function existsUnder(cwd, relPath) {
  const absolute = path.join(cwd, relPath);
  try {
    fs.lstatSync(absolute);
    return true;
  } catch {
    // An extensionless module specifier ("src/lib/api") names src/lib/api.ts.
    try {
      const prefix = `${path.basename(absolute)}.`;
      return fs.readdirSync(path.dirname(absolute)).some((name) => name.startsWith(prefix));
    } catch {
      return false;
    }
  }
}

async function trackedPaths(cwd, candidates, git) {
  if (candidates.length === 0) return [];
  try {
    const output = await git(["ls-files", "-z", "--", ...candidates.map((entry) => `:(literal)${entry}`)], cwd, {
      trim: false,
      timeoutMs: LS_FILES_TIMEOUT_MS,
    });
    return String(output || "").split("\0").filter(Boolean);
  } catch {
    return [];
  }
}

/**
 * The repository paths a fail verdict cites. A path-shaped token counts when it
 * is declared scope, names a file (has an extension), exists in the workspace,
 * or is tracked; prose such as "route/path/type" does not.
 */
export async function citedAssessmentPaths(verdict, { cwd, payload = {}, assessmentContext = null, git = gitExecAsync } = {}) {
  const declared = new Set([
    ...SCOPE_KEYS.flatMap((key) => pathList(payload?.[key])),
    ...CONTEXT_SCOPE_KEYS.flatMap((key) => pathList(assessmentContext?.[key])),
  ]);
  const explicit = (Array.isArray(verdict?.spawn_jobs) ? verdict.spawn_jobs : [])
    .flatMap((spec) => [...pathList(spec?.payload?.files_to_modify), ...pathList(spec?.payload?.files_to_create)]);
  const cited = new Set(explicit);
  const undecided = [];
  for (const token of new Set(pathList(assessmentVerdictPathTokens(verdict)))) {
    if (cited.has(token)) continue;
    if (declared.has(token) || FILE_EXTENSION.test(token.split("/").pop()) || existsUnder(cwd, token)) cited.add(token);
    else undecided.push(token);
  }
  const tracked = await trackedPaths(cwd, undecided, git);
  for (const token of undecided) {
    if (tracked.some((entry) => entry === token || entry.startsWith(`${token}/`))) cited.add(token);
  }
  return [...cited].sort();
}

/**
 * @returns {Promise<{ kind: "ignored_only_paths", cited_paths: string[], ignored: Array<{ path: string, source: string }> } | null>}
 */
export async function classifyIgnoredPathOnlyAssessmentFailure(verdict, { cwd, payload = {}, assessmentContext = null, git = gitExecAsync } = {}) {
  if (verdict?.verdict !== "fail" || !cwd) return null;
  const cited = await citedAssessmentPaths(verdict, { cwd, payload, assessmentContext, git });
  if (cited.length === 0) return null;
  const ignored = new Map((await listIgnoredRepoPaths(cwd, cited, { git })).map((entry) => [entry.path, entry]));
  if (!cited.every((entry) => ignored.has(entry))) return null;
  return {
    kind: "ignored_only_paths",
    cited_paths: cited,
    ignored: cited.map((entry) => ignored.get(entry)),
  };
}

function describeIgnored(classification) {
  return classification.ignored.map((entry) => `${entry.path} (${entry.source})`).join(", ");
}

/** The note a corrective reassessment receives with the prior findings. */
export function renderIgnoredPathCorrection(classification) {
  return [
    `IGNORED-PATH CORRECTION: The prior fail cited only path(s) the repository ignores: ${describeIgnored(classification)}.`,
    "Git never commits them; their workspace copies are local, uncommitted state, and generated ones are rebuilt by the project's build or typecheck.",
    "Reassess the committed change only. Do not require editing, regenerating or committing those paths.",
  ].join("\n");
}

/** The review verdict after a reassessment repeats an ignored-path-only fail. */
export function ignoredPathReviewVerdict(classification, raw) {
  return {
    verdict: "needs_review",
    confidence: "none",
    reasons: [
      `Assessor contract failure: two assessments failed this task only for path(s) the repository ignores: ${classification.cited_paths.join(", ")}. No fix was dispatched.`,
    ],
    spawn_jobs: [],
    human_questions: [],
    suggestions: [],
    raw,
    _disable_internal_retry: true,
    // No fix can commit an ignored path, but whether this task's own work
    // passes is a question the operator can answer.
    _assessment_ignored_path_review: true,
  };
}

export function recordAssessmentIgnoredPathEvent(job, classification, { repeated = false } = {}) {
  if (!job?.id || !classification) return;
  try {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: repeated
        ? EVENT_TYPES.JOB_ASSESSMENT_IGNORED_PATH_VIOLATION
        : EVENT_TYPES.JOB_ASSESSMENT_IGNORED_PATH_RETRY,
      actor_type: EVENT_ACTORS.SYSTEM,
      message: repeated
        ? `Assessor repeated a failure that cites only ignored path(s): ${describeIgnored(classification)}`
        : `Retrying assessment after a failure that cites only ignored path(s): ${describeIgnored(classification)}`,
      event_json: JSON.stringify(classification),
    });
  } catch {
    // Keep assessment usable in isolated tests and partial DB states.
  }
}
