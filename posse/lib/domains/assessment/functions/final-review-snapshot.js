// The immutable snapshot a final review judges: the task contract from the job
// row (never from the agent's arguments), the declared tests' result on the
// current workspace, and the job's own uncommitted change. A work item's
// worktree is shared by sibling jobs, so the change is limited to this job's
// declared scope. The diff is inlined up to a size limit; the changed-file list
// is always complete, and the reviewer reads what the inline diff omits.

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { gitExecAsync } from "../../git/functions/utils.js";
import {
  FINAL_REVIEW_DIFF_INLINE_MAX_CHARS,
  FINAL_REVIEW_TEST_OUTPUT_MAX_CHARS,
} from "../../../catalog/final-review.js";

const SCOPE_FIELDS = Object.freeze(["files_to_modify", "files_to_create", "files_to_delete"]);
const MAX_UNTRACKED_FILE_CHARS = 20_000;

function normalizeRepoPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

export function finalReviewScope(payload = {}) {
  const files = new Set();
  for (const field of SCOPE_FIELDS) {
    for (const entry of Array.isArray(payload?.[field]) ? payload[field] : []) {
      const normalized = normalizeRepoPath(entry);
      if (normalized) files.add(normalized);
    }
  }
  const roots = (Array.isArray(payload?.create_roots) ? payload.create_roots : [])
    .map(normalizeRepoPath)
    .filter(Boolean);
  return { files, roots, declared: files.size > 0 || roots.length > 0 };
}

function inScope(repoPath, scope) {
  if (!scope.declared) return true;
  if (scope.files.has(repoPath)) return true;
  return scope.roots.some((root) => repoPath === root || repoPath.startsWith(`${root}/`));
}

// `git status --porcelain=v1 -z`: "XY path\0", with the original path in a
// second field for renames and copies.
export function parsePorcelainZ(output) {
  const tokens = String(output || "").split("\0").filter(Boolean);
  const entries = [];
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    const code = token.slice(0, 2);
    const entryPath = normalizeRepoPath(token.slice(3));
    if (code[0] === "R" || code[0] === "C") index += 1;
    if (entryPath) entries.push({ code, path: entryPath, untracked: code === "??" });
  }
  return entries;
}

function readUntrackedFile(cwd, repoPath) {
  try {
    const absolute = path.resolve(cwd, repoPath);
    const stat = fs.statSync(absolute);
    if (!stat.isFile()) return null;
    const text = fs.readFileSync(absolute, "utf8");
    return text.includes("\0") ? "(binary file)" : text.slice(0, MAX_UNTRACKED_FILE_CHARS);
  } catch {
    return null;
  }
}

/** The job's scoped change on the current workspace: files, stats, and diff text. */
export async function collectScopedChange(cwd, payload = {}, { git = gitExecAsync } = {}) {
  const scope = finalReviewScope(payload);
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, { trim: false });
  const entries = parsePorcelainZ(status).filter((entry) => inScope(entry.path, scope));
  const tracked = entries.filter((entry) => !entry.untracked).map((entry) => entry.path);
  const untracked = entries.filter((entry) => entry.untracked).map((entry) => entry.path);
  let diff = "";
  const stats = new Map();
  if (tracked.length > 0) {
    diff = String(await git(["diff", "HEAD", "--no-color", "--no-ext-diff", "--", ...tracked], cwd, { trim: false }) || "");
    const numstat = String(await git(["diff", "HEAD", "--numstat", "--", ...tracked], cwd, { trim: false }) || "");
    for (const line of numstat.split("\n")) {
      const [added, removed, ...rest] = line.split("\t");
      const file = normalizeRepoPath(rest.join("\t"));
      if (file) stats.set(file, `+${added} -${removed}`);
    }
  }
  for (const file of untracked) {
    const content = readUntrackedFile(cwd, file);
    if (content == null) continue;
    const lines = content.split("\n");
    stats.set(file, `new, ${lines.length} lines`);
    diff += `${diff ? "\n" : ""}diff --git a/${file} b/${file}\nnew file\n--- /dev/null\n+++ b/${file}\n${lines.map((line) => `+${line}`).join("\n")}\n`;
  }
  const files = [...new Set([...tracked, ...untracked])].sort();
  return {
    files: files.map((file) => ({ path: file, stat: stats.get(file) || (untracked.includes(file) ? "new" : "changed") })),
    diff,
    digest: createHash("sha256").update(diff).digest("hex"),
    scopeDeclared: scope.declared,
  };
}

function tail(text, max) {
  const value = String(text || "").trim();
  return value.length <= max ? value : `…${value.slice(-max)}`;
}

function renderTestRun(testRun) {
  if (!testRun || testRun.status === "skipped") return "DECLARED TESTS: none declared for this task.";
  if (testRun.status === "invalid_test_plan") {
    return `DECLARED TESTS: \`${testRun.command || "(unknown)"}\` could not run (${testRun.reason || "invalid plan"}).`;
  }
  const counts = testRun.test_counts && Number.isFinite(testRun.test_counts.total)
    ? `, ${testRun.test_counts.total} test(s)`
    : "";
  const exit = testRun.code ?? testRun.exit_code;
  return [
    `DECLARED TESTS: \`${testRun.command}\` ran on the current workspace: ${String(testRun.status || "unknown").toUpperCase()}${exit != null ? ` (exit ${exit})` : ""}${counts}${testRun.reason ? `, ${testRun.reason}` : ""}.`,
    testRun.status === "passed" ? null : "```text",
    testRun.status === "passed" ? null : tail([testRun.stdout, testRun.stderr].filter(Boolean).join("\n"), FINAL_REVIEW_TEST_OUTPUT_MAX_CHARS),
    testRun.status === "passed" ? null : "```",
  ].filter((line) => line != null).join("\n");
}

function list(label, values) {
  const entries = (Array.isArray(values) ? values : values ? [values] : []).map(String).filter(Boolean);
  return entries.length > 0 ? `${label}:\n${entries.map((entry) => `- ${entry}`).join("\n")}` : null;
}

/**
 * The reviewer's local evidence block: contract, test result, change. Appended
 * after the remotely composed reviewer prompt, never sent to the remote.
 */
export function renderFinalReviewEvidence({ job, workItem, payload = {}, change, testRun }) {
  const diff = String(change?.diff || "");
  const inline = diff.length <= FINAL_REVIEW_DIFF_INLINE_MAX_CHARS
    ? diff
    : diff.slice(0, FINAL_REVIEW_DIFF_INLINE_MAX_CHARS);
  const files = Array.isArray(change?.files) ? change.files : [];
  return [
    "═══ FINAL REVIEW SNAPSHOT ═══",
    "TASK CONTRACT:",
    `Work item: ${workItem?.title || "(untitled)"}`,
    workItem?.description ? `Work item description: ${workItem.description}` : null,
    `Task: ${job?.title || "(untitled)"}`,
    payload.task_spec ? `Task specification:\n${payload.task_spec}` : null,
    list("Success criteria", payload.success_criteria),
    list("Declared scope", [...SCOPE_FIELDS.flatMap((field) => payload[field] || []), ...(payload.create_roots || []).map((root) => `${root}/**`)]),
    "",
    renderTestRun(testRun),
    "",
    files.length === 0
      ? "CHANGED FILES: none in the declared scope."
      : `CHANGED FILES (${files.length}, complete list):\n${files.map((file) => `- ${file.path} (${file.stat})`).join("\n")}`,
    files.length === 0 ? null : (diff.length <= FINAL_REVIEW_DIFF_INLINE_MAX_CHARS
      ? "DIFF (complete):"
      : `DIFF (first ${FINAL_REVIEW_DIFF_INLINE_MAX_CHARS} of ${diff.length} characters; read the remaining changed files with your read tools):`),
    files.length === 0 ? null : `\`\`\`diff\n${inline}\n\`\`\``,
  ].filter((line) => line != null).join("\n");
}

/** Task instructions sent through remote composition (no repository content). */
export function finalReviewInstructions() {
  return [
    "FINAL REVIEW: the developer finished this task and requests an independent review before handing it off.",
    "Judge the current workspace change, which is not committed yet, against the task contract in the attached snapshot.",
    "Check the actual files: the snapshot lists every changed file and inlines the diff up to its size limit; read any changed file it does not show.",
    "Use the declared test result as evidence.",
    "Return the standard verdict: pass when the change meets the contract; fail with one reason per concrete defect the developer must fix, naming the file and the criterion it misses; needs_review only when the contract itself cannot be judged.",
  ].join("\n");
}
