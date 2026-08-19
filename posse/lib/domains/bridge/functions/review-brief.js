// Bounded, source-safe review brief for phone/portal review gates: which
// files an implementation touched (paths and line counts only — never
// contents; the relay's source policy and the product's no-raw-code rule
// both forbid code through gates) plus the assessor's verdict and
// confidence. Attached at gate projection time so every creation site's
// payload stays untouched.

// adminGitExec, not gitExec: gate projection is an operator surface that
// must work whether or not the native git daemon's pulse token is warm.
import { adminGitExec } from "../../git/functions/admin-git.js";
import { resolveTargetBranchForAdmin } from "../../git/functions/target-branch.js";
import { getDb } from "../../../shared/storage/functions/index.js";

// The relay caps a serialized gate payload at 8k chars; two dozen paths plus
// the existing push/selector detail fits comfortably.
const MAX_BRIEF_FILES = 24;
const MAX_PATH_CHARS = 160;
const GIT_TIMEOUT_MS = 4_000;
const ASSESSED_VERDICTS = new Set(["pass", "fail"]);

// Diffs are re-projected on every snapshot/gates.list; memoize on the branch
// tip so repeated reconciles cost one rev-parse, not a numstat.
const diffCache = new Map();
const DIFF_CACHE_MAX = 64;

function latestAssessedJob(workItemId) {
  try {
    return getDb().prepare(`
      SELECT id, job_type, status, assessor_verdict, assessor_confidence
      FROM jobs
      WHERE work_item_id = ?
        AND assessor_verdict IN ('pass', 'fail')
      ORDER BY id DESC
      LIMIT 1
    `).get(workItemId) || null;
  } catch {
    return null;
  }
}

function workItemBranch(workItemId) {
  try {
    const row = getDb().prepare(
      "SELECT branch_name FROM work_items WHERE id = ?",
    ).get(workItemId);
    const branch = String(row?.branch_name || "").trim();
    return branch || null;
  } catch {
    return null;
  }
}

function parseNumstat(text) {
  const files = [];
  let additions = 0;
  let deletions = 0;
  const lines = String(text || "").split("\n").filter(Boolean);
  for (const line of lines) {
    const [a, d, ...pathParts] = line.split("\t");
    const path = pathParts.join("\t").trim();
    if (!path) continue;
    // Binary files report "-"; keep the row with null counts.
    const add = /^\d+$/.test(a) ? Number(a) : null;
    const del = /^\d+$/.test(d) ? Number(d) : null;
    additions += add || 0;
    deletions += del || 0;
    files.push({
      path: path.slice(0, MAX_PATH_CHARS),
      additions: add,
      deletions: del,
    });
  }
  return {
    files: files.slice(0, MAX_BRIEF_FILES),
    total_files: files.length,
    truncated: files.length > MAX_BRIEF_FILES,
    additions,
    deletions,
  };
}

function branchDiffSummary(projectDir, branch) {
  let tip;
  try {
    tip = String(adminGitExec(["rev-parse", branch], projectDir, { timeoutMs: GIT_TIMEOUT_MS }) || "").trim();
  } catch {
    return null; // branch already cleaned up or repo unavailable
  }
  if (!tip) return null;
  let targetName = "main";
  try {
    targetName = resolveTargetBranchForAdmin(projectDir) || "main";
  } catch { /* keep the default; the diff attempt below degrades safely */ }
  const cacheKey = `${branch}:${tip}:${targetName}`;
  if (diffCache.has(cacheKey)) return diffCache.get(cacheKey);
  let summary = null;
  try {
    const numstat = adminGitExec(
      ["diff", "--numstat", `${targetName}...${branch}`],
      projectDir,
      { timeoutMs: GIT_TIMEOUT_MS },
    );
    summary = parseNumstat(numstat);
  } catch {
    summary = null; // merge-base failure etc. — verdict-only brief below
  }
  if (diffCache.size >= DIFF_CACHE_MAX) {
    diffCache.delete(diffCache.keys().next().value);
  }
  diffCache.set(cacheKey, summary);
  return summary;
}

/** Test seam: the diff memo is module state and must not leak across tests. */
export function resetReviewBriefCache() {
  diffCache.clear();
}

/**
 * Build the review brief for a gate job, or null when nothing useful can be
 * said (no work item, and no assessed job). Never throws — a git or DB
 * hiccup degrades to a partial or absent brief, not a broken gate list.
 */
export function buildReviewBrief(job, { projectDir = process.cwd() } = {}) {
  const workItemId = job?.work_item_id == null ? null : Number(job.work_item_id);
  if (!Number.isInteger(workItemId) || workItemId <= 0) return null;
  const assessed = latestAssessedJob(workItemId);
  const branch = workItemBranch(workItemId);
  const diff = branch ? branchDiffSummary(projectDir, branch) : null;
  if (!assessed && !diff) return null;
  const brief = {};
  if (assessed) {
    if (ASSESSED_VERDICTS.has(assessed.assessor_verdict)) {
      brief.verdict = assessed.assessor_verdict;
    }
    const confidence = String(assessed.assessor_confidence || "").trim();
    if (confidence) brief.confidence = confidence.slice(0, 40);
    brief.assessed_job_id = Number(assessed.id);
  }
  if (diff) {
    brief.files = diff.files;
    brief.total_files = diff.total_files;
    brief.truncated = diff.truncated;
    brief.additions = diff.additions;
    brief.deletions = diff.deletions;
  }
  return Object.keys(brief).length > 0 ? brief : null;
}
