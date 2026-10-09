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
import { listIgnoredRepoPaths } from "../../git/functions/ignored-paths.js";
import { unifiedLineDiff } from "../../../shared/format/functions/line-diff.js";
import {
  FINAL_REVIEW_DELTA_INLINE_MAX_CHARS,
  FINAL_REVIEW_DIFF_INLINE_MAX_CHARS,
  FINAL_REVIEW_TEST_OUTPUT_MAX_CHARS,
} from "../../../catalog/final-review.js";
import { renderChangedFileChecks } from "./final-review-checks.js";

const SCOPE_FIELDS = Object.freeze(["files_to_modify", "files_to_create", "files_to_delete"]);
const MAX_UNTRACKED_FILE_CHARS = 20_000;
const MAX_SNAPSHOT_FILE_CHARS = 400_000;

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
    const moved = code.includes("R") || code.includes("C");
    const previousPath = moved ? normalizeRepoPath(tokens[++index]) : null;
    if (entryPath) entries.push({ code, path: entryPath, previousPath, untracked: code === "??" });
  }
  return entries;
}

function readUntrackedFile(cwd, repoPath, maxChars = MAX_UNTRACKED_FILE_CHARS) {
  let fd = null;
  try {
    const absolute = path.resolve(cwd, repoPath);
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return { text: fs.readlinkSync(absolute), mode: "120000", stat: "new symlink" };
    if (!stat.isFile()) return null;
    const relative = path.relative(fs.realpathSync(cwd), fs.realpathSync(absolute));
    if (!relative || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) return null;
    // The file can change after lstat. O_NOFOLLOW prevents a last-component
    // symlink swap from redirecting this read outside the repository.
    fd = fs.openSync(absolute, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    if (!fs.fstatSync(fd).isFile()) return null;
    const text = fs.readFileSync(fd, "utf8");
    if (text.includes("\0")) return { text: "(binary file)", mode: null, stat: null, truncated: true };
    return { text: text.slice(0, maxChars), mode: null, stat: null, truncated: text.length > maxChars };
  } catch {
    return null;
  } finally {
    if (fd != null) fs.closeSync(fd);
  }
}

/** The job's scoped change on the current workspace: files, stats, and diff text. */
export async function collectScopedChange(cwd, payload = {}, { git = gitExecAsync } = {}) {
  const scope = finalReviewScope(payload);
  const status = await git(["status", "--porcelain=v1", "-z", "--untracked-files=all"], cwd, { trim: false });
  const entries = parsePorcelainZ(status).filter((entry) => inScope(entry.path, scope)
    || (entry.code.includes("R") && entry.previousPath && inScope(entry.previousPath, scope)));
  const renames = entries.filter((entry) => entry.code.includes("R") && entry.previousPath)
    .map((entry) => ({ from: entry.previousPath, to: entry.path,
      outsideScope: scope.declared && (!inScope(entry.previousPath, scope) || !inScope(entry.path, scope)) }));
  const tracked = [...new Set(entries.filter((entry) => !entry.untracked)
    .flatMap((entry) => [entry.path, ...(entry.code.includes("R") && entry.previousPath ? [entry.previousPath] : [])])
    .filter((file) => inScope(file, scope)))];
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
    const lines = content.text.split("\n");
    stats.set(file, content.stat || `new, ${lines.length} lines`);
    diff += `${diff ? "\n" : ""}diff --git a/${file} b/${file}\n${content.mode ? `new file mode ${content.mode}` : "new file"}\n--- /dev/null\n+++ b/${file}\n${lines.map((line) => `+${line}`).join("\n")}\n`;
  }
  const files = [...new Set([...tracked, ...untracked])].sort();
  return {
    files: files.map((file) => ({ path: file, stat: stats.get(file) || (untracked.includes(file) ? "new" : "changed") })),
    renames,
    // Declared paths git never commits; status never lists them.
    ignored: await listIgnoredRepoPaths(cwd, [...scope.files], { git }),
    diff,
    digest: createHash("sha256").update(diff).digest("hex"),
    scopeDeclared: scope.declared,
  };
}

/**
 * The reviewed state of the job's scoped files, kept in memory with the parked
 * reviewer so its next turn sees only what changed since it reported. Read in
 * process with the same in-repository guards as the snapshot diff; the
 * reviewer is sandboxed, so nothing here runs a subprocess on its behalf.
 *
 * @returns {Map<string, { text: string, truncated: boolean } | null>} null: absent
 */
export function snapshotReviewedFiles(cwd, payload = {}, change = {}, { alsoPaths = [] } = {}) {
  const scope = finalReviewScope(payload);
  const paths = new Set([
    ...scope.files,
    ...(Array.isArray(change?.files) ? change.files.map((file) => file.path) : []),
    ...alsoPaths,
  ].map(normalizeRepoPath).filter(Boolean));
  const files = new Map();
  for (const repoPath of [...paths].sort()) {
    const content = readUntrackedFile(cwd, repoPath, MAX_SNAPSHOT_FILE_CHARS);
    files.set(repoPath, content == null ? null : { text: content.text, truncated: content.truncated === true });
  }
  return files;
}

function fileDiffSection(diff, repoPath) {
  const sections = String(diff || "").split(/^(?=diff --git )/m);
  return sections.find((section) => section.startsWith("diff --git ")
    && section.split("\n", 1)[0].endsWith(` b/${repoPath}`)) || null;
}

/**
 * What changed in the scoped files between the reviewer's last report and now:
 * the diff of the diff. A file the reviewer saw unchanged from the base has no
 * earlier snapshot, so its change since the report is its diff from the base.
 */
export function diffSinceReview(previous, current, change = {}) {
  const changed = [];
  const sections = [];
  const paths = new Set([...previous.keys(), ...current.keys()]);
  for (const repoPath of [...paths].sort()) {
    const after = current.get(repoPath) ?? null;
    if (!previous.has(repoPath)) {
      const section = fileDiffSection(change.diff, repoPath);
      if (section) {
        changed.push({ path: repoPath, status: "first changed since your report" });
        sections.push(section.endsWith("\n") ? section : `${section}\n`);
      }
      continue;
    }
    const before = previous.get(repoPath) ?? null;
    if ((before?.text ?? null) === (after?.text ?? null)) continue;
    const status = before == null ? "created" : after == null ? "deleted" : "modified";
    if (before?.truncated || after?.truncated) {
      changed.push({ path: repoPath, status: `${status}; too large to diff inline, read it` });
      continue;
    }
    const diff = unifiedLineDiff(before?.text ?? null, after?.text ?? null, { path: repoPath });
    if (diff == null) {
      changed.push({ path: repoPath, status: `${status}; rewritten, read it` });
      continue;
    }
    changed.push({ path: repoPath, status });
    sections.push(diff);
  }
  return { changed, diff: sections.join("") };
}

function tail(text, max) {
  const value = String(text || "").trim();
  return value.length <= max ? value : `…${value.slice(-max)}`;
}

function renderTestRun(testRun, label = "DECLARED TESTS") {
  if (!testRun || testRun.status === "skipped") return `${label}: none declared for this task.`;
  if (testRun.status === "invalid_test_plan") {
    return `${label}: \`${testRun.command || "(unknown)"}\` could not run (${testRun.reason || "invalid plan"}).`;
  }
  const counts = testRun.test_counts && Number.isFinite(testRun.test_counts.total)
    ? `, ${testRun.test_counts.total} test(s)`
    : "";
  const exit = testRun.code ?? testRun.exit_code;
  return [
    `${label}: \`${testRun.command}\` ran on the current workspace: ${String(testRun.status || "unknown").toUpperCase()}${exit != null ? ` (exit ${exit})` : ""}${counts}${testRun.reason ? `, ${testRun.reason}` : ""}.`,
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
export function renderFinalReviewEvidence({ job, workItem, payload = {}, change, testRun, changedTestRun = null, checks = null }) {
  const diff = String(change?.diff || "");
  const inline = diff.length <= FINAL_REVIEW_DIFF_INLINE_MAX_CHARS
    ? diff
    : diff.slice(0, FINAL_REVIEW_DIFF_INLINE_MAX_CHARS);
  const files = Array.isArray(change?.files) ? change.files : [];
  const renames = Array.isArray(change?.renames) ? change.renames : [];
  const ignored = Array.isArray(change?.ignored) ? change.ignored : [];
  return [
    "═══ FINAL REVIEW SNAPSHOT ═══",
    "TASK CONTRACT:",
    `Work item: ${workItem?.title || "(untitled)"}`,
    workItem?.description ? `Work item description: ${workItem.description}` : null,
    `Task: ${job?.title || "(untitled)"}`,
    (payload.root_task_spec || payload.original_task_spec || payload.task_spec || payload.instructions)
      ? `Task specification:\n${payload.root_task_spec || payload.original_task_spec || payload.task_spec || payload.instructions}` : null,
    payload.fix_instructions ? `Required repair (the original contract still applies):\n${payload.fix_instructions}` : null,
    list("Success criteria", payload.success_criteria),
    list("Declared scope", [...SCOPE_FIELDS.flatMap((field) => payload[field] || []), ...(payload.create_roots || []).map((root) => `${root}/**`)]),
    "",
    renderTestRun(testRun),
    changedTestRun ? renderTestRun(changedTestRun, "CHANGED TEST FILES") : null,
    renderChangedFileChecks(checks),
    "",
    files.length === 0
      ? "CHANGED FILES: none in the declared scope."
      : `CHANGED FILES (${files.length}, complete list):\n${files.map((file) => `- ${file.path} (${file.stat})`).join("\n")}`,
    renames.length === 0 ? null : `RENAMES TOUCHING DECLARED SCOPE:\n${renames.map((entry) => `- ${entry.from} -> ${entry.to}${entry.outsideScope ? " (one path outside declared scope)" : ""}`).join("\n")}`,
    ignored.length === 0 ? null : [
      "IGNORED BY REPOSITORY POLICY (declared in scope, but the repository's ignore rules exclude them: git never commits them, so they never appear in CHANGED FILES; their workspace copies are local, uncommitted state, and a generated file may be stale until the project's build or typecheck regenerates it. Judge the tracked sources instead, and do not report a finding whose only fix is editing, regenerating or committing one of these files):",
      ...ignored.map((entry) => `- ${entry.path} (${entry.source})`),
    ].join("\n"),
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
    "Use the declared test, changed test file and changed-file check results as evidence: a failure located in a changed file is a defect in this change.",
    "Check every success criterion before you report, and report every concrete defect at once, most severe first: each finding names the criterion it misses and locates it with hash refs, paths or symbols.",
    "Report by calling final_review with your verdict (pass when the change meets the contract; fail with your findings; needs_review only when the contract itself cannot be judged). The call then waits while the developer works.",
    "When it returns a revision, check your findings against the diff since your report, review only what changed, and call final_review again. When it returns status done, end with your terminal handoff carrying your latest verdict.",
  ].join("\n");
}

/**
 * The parked reviewer's next turn after the developer revises: the declared
 * test result and only what changed since its report, never the whole change
 * again.
 */
export function renderFinalReviewRevision({ revision, testRun, delta, changedTestRun = null, checks = null }) {
  const changed = Array.isArray(delta?.changed) ? delta.changed : [];
  const diff = String(delta?.diff || "");
  const inline = diff.length <= FINAL_REVIEW_DELTA_INLINE_MAX_CHARS ? diff : diff.slice(0, FINAL_REVIEW_DELTA_INLINE_MAX_CHARS);
  return [
    `═══ FINAL REVIEW: REVISION ${revision} ═══`,
    "The developer revised the change after your report.",
    renderTestRun(testRun),
    changedTestRun ? renderTestRun(changedTestRun, "CHANGED TEST FILES") : null,
    renderChangedFileChecks(checks),
    "",
    changed.length === 0
      ? "CHANGED SINCE YOUR REPORT: nothing in the declared scope."
      : `CHANGED SINCE YOUR REPORT (${changed.length}):\n${changed.map((entry) => `- ${entry.path} (${entry.status})`).join("\n")}`,
    diff.length === 0 ? null : (diff.length <= FINAL_REVIEW_DELTA_INLINE_MAX_CHARS
      ? "DIFF SINCE YOUR REPORT:"
      : `DIFF SINCE YOUR REPORT (first ${FINAL_REVIEW_DELTA_INLINE_MAX_CHARS} of ${diff.length} characters; read the rest with your read tools):`),
    diff.length === 0 ? null : `\`\`\`diff\n${inline}\n\`\`\``,
    "",
    "Check that each of your findings is fixed and review only these changes, then call final_review again with your verdict and every defect that remains or that the revision introduced.",
  ].filter((line) => line != null).join("\n");
}
