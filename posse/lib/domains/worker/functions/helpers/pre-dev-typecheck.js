// Pre-development typecheck briefing. After a dev or fix job holds the write
// locks for its scope and its worktree is ready, run the repository's
// configured typecheck once and keep the diagnostics for the files the job may
// edit, so the agent sees the existing type errors going in and fixes them in
// the files it is already changing. This is separate from the frozen test
// baseline (which must never reach the agent): it is an editing aid, not
// verification evidence.

import fs from "node:fs";
import path from "node:path";

import { C } from "../../../../shared/format/functions/colors.js";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { DEFAULT_VERIFICATION_DEPENDENCY_NETWORK_POLICY } from "../../../../catalog/verification.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import {
  porcelainDeltaPaths,
  porcelainStatusEntries,
  restorePathsToTreeAsync,
} from "../../../git/functions/worktree-recovery.js";
import { recordObservation } from "../../../observability/functions/observations.js";
import { getSetting } from "../../../settings/functions/repository-settings.js";
import { repairVerificationPrerequisites } from "../../../verification/functions/prerequisite-adapters.js";
import { collectTypecheckDiagnosticsAsync } from "../../../../shared/tools/functions/toolkit/scoped-runners.js";

export const PRE_DEV_TYPECHECK_JOB_TYPES = Object.freeze(new Set(["dev", "fix"]));
const MAX_RENDERED_DIAGNOSTICS = 80;
const MAX_RENDERED_CHARS = 8000;

export function preDevTypecheckEnabled(projectDir) {
  const raw = String(getSetting(SETTING_KEYS.PRE_DEV_TYPECHECK, { projectDir }) ?? "").trim().toLowerCase();
  return !["false", "0", "off", "no"].includes(raw);
}

function normalizeScopePath(file) {
  return String(file || "").trim().replace(/\\/gu, "/").replace(/^\.\/+/u, "");
}

// Only files that already exist can carry pre-existing errors.
export function preDevTypecheckScopeFiles(payload = {}, cwd) {
  const files = [
    ...(Array.isArray(payload.files_to_modify) ? payload.files_to_modify : []),
    ...(Array.isArray(payload.files_to_create) ? payload.files_to_create : []),
  ].map(normalizeScopePath).filter(Boolean);
  return [...new Set(files)].filter((file) => {
    try {
      return fs.statSync(path.join(cwd, file)).isFile();
    } catch {
      return false;
    }
  });
}

async function porcelain(cwd) {
  try {
    return String(await gitExecAsync(
      ["status", "--porcelain=v1", "-z", "--untracked-files=all"],
      cwd,
      { trim: false },
    ) || "");
  } catch {
    return null;
  }
}

// Undo what the typecheck changed. Sibling jobs of the work item share this
// worktree, so when one owns a dirty path, only paths this run changed are
// put back, never the sibling's (WI 154, 2026-10-01: a sibling's pre-dev
// cleanup reset the worktree and deleted job 2028's placeholders). Paths that
// were already dirty before the run are left alone.
async function cleanupTypecheckSideEffects({ worker, job, wtPath, before, after, cleanupWorktree, siblingOwnedPaths, cleanupPaths }) {
  let siblingPaths = new Set();
  if (typeof siblingOwnedPaths === "function") {
    try {
      siblingPaths = new Set(await siblingOwnedPaths([...porcelainStatusEntries(after).keys()]));
    } catch {
      siblingPaths = new Set();
    }
  }
  if (siblingPaths.size === 0) {
    if (typeof cleanupWorktree === "function") await cleanupWorktree();
    return;
  }
  const prior = porcelainStatusEntries(before);
  const own = porcelainDeltaPaths(before, after).filter((file) => !siblingPaths.has(file) && !prior.has(file));
  if (own.length > 0) await cleanupPaths(wtPath, own);
  worker?.emit?.(job.id, `${C.dim}[typecheck] WI#${job.work_item_id} job #${job.id}: undid ${own.length} typecheck change(s); kept ${siblingPaths.size} sibling-owned path(s)${C.reset}`);
}

function countByFile(diagnostics) {
  const counts = {};
  for (const diagnostic of diagnostics) counts[diagnostic.file] = (counts[diagnostic.file] || 0) + 1;
  return counts;
}

export async function runPreDevTypecheck({
  worker,
  job,
  payload,
  wtPath,
  signal = null,
  cleanupWorktree = null,
  siblingOwnedPaths = null,
  cleanupPaths = (cwd, paths) => restorePathsToTreeAsync(cwd, paths, "HEAD", { signal }),
  collect = collectTypecheckDiagnosticsAsync,
  repair = repairVerificationPrerequisites,
  gitStatus = porcelain,
  isEnabled = preDevTypecheckEnabled,
} = {}) {
  if (!wtPath || !job || !PRE_DEV_TYPECHECK_JOB_TYPES.has(job.job_type)) return null;
  if ((payload?.task_mode || "code") !== "code") return null;
  if (!isEnabled(worker?.projectDir || wtPath)) return null;
  const files = preDevTypecheckScopeFiles(payload, wtPath);
  if (files.length === 0) return null;
  const label = `WI#${job.work_item_id} job #${job.id}`;
  try {
    const before = await gitStatus(wtPath);
    let result = await collect({ cwd: wtPath, files, signal });
    // No typecheck configured for these files: nothing to brief.
    if (!result || result.status === "not_applicable") return null;
    let dependencyRepair = null;
    if (result.status === "unavailable" && result.dependency_unavailable === true) {
      const networkPolicy = String(getSetting("verification_dependency_network_policy", { projectDir: wtPath })
        || DEFAULT_VERIFICATION_DEPENDENCY_NETWORK_POLICY);
      if (networkPolicy !== "disabled") {
        worker?.emit?.(job.id, `${C.dim}[typecheck] ${label}: typecheck dependencies missing; repairing the worktree once${C.reset}`);
        try {
          dependencyRepair = await repair({
            projectDir: wtPath,
            command: result.command || "npm",
            receipt: { execution_command: result.command || null, stdout: result.reason || "" },
            networkPolicy,
            signal,
            onProgress: (message) => worker?.emit?.(job.id, `${C.dim}[typecheck] ${message}${C.reset}`),
          });
        } catch (error) {
          dependencyRepair = { ok: false, status: "failed", reason: error?.code || error?.message || "dependency_repair_failed" };
        }
        if (dependencyRepair?.ok === true) result = await collect({ cwd: wtPath, files, signal });
      }
    }
    const after = await gitStatus(wtPath);
    if (before !== null && after !== null && before !== after) {
      await cleanupTypecheckSideEffects({ worker, job, wtPath, before, after, cleanupWorktree, siblingOwnedPaths, cleanupPaths });
    }
    const inScope = new Set(files);
    const projectDiagnostics = Array.isArray(result.diagnostics) ? result.diagnostics : [];
    const diagnostics = projectDiagnostics.filter((diagnostic) => inScope.has(diagnostic.file));
    const byFile = countByFile(diagnostics);
    const summary = {
      schema_version: 1,
      status: result.status,
      command: result.command || null,
      reason: result.reason || null,
      scoped_files: files,
      project_diagnostic_count: projectDiagnostics.length,
      diagnostics,
      dependency_repair: dependencyRepair
        ? { ok: dependencyRepair.ok === true, status: dependencyRepair.status || null, reason: dependencyRepair.reason || null }
        : null,
      duration_ms: result.durationMs ?? null,
      created_at: new Date().toISOString(),
    };
    job._preDevTypecheck = summary;
    const fileCount = Object.keys(byFile).length;
    const headline = result.status === "unavailable"
      ? `typecheck unavailable (${result.reason || "unknown"}); no briefing`
      : `${diagnostics.length} existing type error(s) in ${fileCount} of ${files.length} scoped file(s); ${projectDiagnostics.length} project-wide`;
    worker?.emit?.(job.id, `${diagnostics.length > 0 ? C.yellow : C.dim}[typecheck] ${label}: ${headline}${C.reset}`);
    recordObservation({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: null,
      observation_type: "verification.pre_dev_typecheck",
      summary: `Pre-dev typecheck: ${headline}`,
      detail: {
        status: summary.status,
        command: summary.command,
        reason: summary.reason,
        scoped_file_count: files.length,
        scoped_diagnostic_count: diagnostics.length,
        project_diagnostic_count: projectDiagnostics.length,
        by_file: byFile,
        dependency_repair: summary.dependency_repair,
        duration_ms: summary.duration_ms,
      },
    });
    return summary;
  } catch (error) {
    // A briefing must never cost the job.
    worker?.emit?.(job.id, `${C.yellow}[typecheck] ${label}: pre-dev typecheck skipped (${error?.message || error})${C.reset}`);
    return null;
  }
}

// Render the briefing for the agent, limited to the files it may edit now
// (handoff can change scope after the typecheck ran).
export function renderPreDevTypecheckContext(summary, editableFiles = null) {
  if (!summary || !Array.isArray(summary.diagnostics) || summary.diagnostics.length === 0) return null;
  const editable = Array.isArray(editableFiles) && editableFiles.length > 0
    ? new Set(editableFiles.map(normalizeScopePath))
    : null;
  const diagnostics = editable
    ? summary.diagnostics.filter((diagnostic) => editable.has(diagnostic.file))
    : summary.diagnostics;
  if (diagnostics.length === 0) return null;
  const byFile = new Map();
  for (const diagnostic of diagnostics) {
    if (!byFile.has(diagnostic.file)) byFile.set(diagnostic.file, []);
    byFile.get(diagnostic.file).push(diagnostic);
  }
  const command = summary.command || "the repository typecheck";
  const lines = [
    `EXISTING TYPE ERRORS IN YOUR FILES (\`${command}\`, run before this job started):`,
    "These errors are already in files this task lets you edit. Fix them in those files while you make your change.",
    "Use type annotations, JSDoc types and casts, or declarations, and keep runtime behavior the same; if an error turns out to be a real bug, fix it and say so in your result.",
    "Do not weaken the type checker configuration, exclude files, or add @ts-ignore, @ts-expect-error or @ts-nocheck.",
  ];
  let rendered = 0;
  let chars = lines.join("\n").length;
  let truncated = false;
  for (const [file, entries] of byFile) {
    const header = `${file} (${entries.length}):`;
    if (rendered >= MAX_RENDERED_DIAGNOSTICS || chars + header.length > MAX_RENDERED_CHARS) {
      truncated = true;
      break;
    }
    lines.push(header);
    chars += header.length + 1;
    for (const entry of [...entries].sort((left, right) => left.line - right.line || left.column - right.column)) {
      const line = `  ${entry.line}:${entry.column} ${entry.code} ${entry.message}`;
      if (rendered >= MAX_RENDERED_DIAGNOSTICS || chars + line.length > MAX_RENDERED_CHARS) {
        truncated = true;
        break;
      }
      lines.push(line);
      chars += line.length + 1;
      rendered += 1;
    }
    if (truncated) break;
  }
  if (truncated) {
    lines.push(`(${diagnostics.length - rendered} more not shown; run \`${command}\` for the full list)`);
  }
  return lines.join("\n");
}
