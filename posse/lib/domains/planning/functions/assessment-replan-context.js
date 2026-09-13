import fs from "fs";
import path from "path";
import { contextDir, wiScopeId } from "../../artifacts/functions/index.js";
import { ensureDetachedReadOnlyWorktreeAsync } from "../../git/functions/worktree.js";
import { buildDiffNarrativeAsync, formatDiffNarrative } from "../../git/functions/diff-narrator.js";
import { promptLiteral } from "../../../shared/format/functions/prompt-literals.js";

// Shared preparation for direct planner loopbacks and already-queued legacy
// research loopbacks. Repository inspection stays on the work-item branch.
function collectReplanScopedFiles(payload = {}) {
  const files = Array.isArray(payload?.original_scoped_files) ? payload.original_scoped_files : [];
  return [...new Set(files.map((file) => String(file || "").replace(/\\/g, "/").trim()).filter(Boolean))];
}

export function isAssessmentReplanPayload(payload = {}) {
  const originalJobType = String(payload?.original_job_type || "").trim();
  return payload?._assessment_replan === true
    && Number.isInteger(Number(payload?.original_job_id))
    && ["dev", "fix", "promote", "artificer"].includes(originalJobType);
}

export function buildAssessmentReplanEvidenceBlock(payload, { researchCwd = "", diffBlock = "", cwdError = "", readerLabel = "Research" } = {}) {
  if (!isAssessmentReplanPayload(payload)) return "";
  const scopedFiles = collectReplanScopedFiles(payload);
  const lines = [
    "ASSESSMENT REPLAN EVIDENCE:",
    "- This replan was triggered by assessor failure after a mutating job, so inspect the current work-item branch state before proposing replacement work.",
    `- Original job: #${payload.original_job_id} (${payload.original_job_type}${payload.original_task_mode ? `/${payload.original_task_mode}` : ""}) ${payload.original_title || ""}`.trim(),
    `- Work-item branch: ${payload.wi_branch_name || "(not recorded)"}`,
    `- Original commit: ${payload.original_commit_hash || "(not recorded)"}`,
    payload.wi_merge_base_hash ? `- Merge base: ${payload.wi_merge_base_hash}` : "",
    researchCwd ? `- ${readerLabel} cwd: ${researchCwd}` : "",
    cwdError ? `- Branch worktree note: ${cwdError}` : "",
    scopedFiles.length > 0 ? `- Original scoped files:\n${scopedFiles.map((file) => `  - ${file}`).join("\n")}` : "- Original scoped files: (not recorded)",
    payload.replan_reason ? `\nAssessor reasons:\n${payload.replan_reason}` : "",
    diffBlock ? `\n${diffBlock}` : "",
    "",
  ];
  return lines.filter(Boolean).join("\n");
}

export async function resolveAssessmentReplanCwd(baseProjectDir, job, payload, { signal = null } = {}) {
  if (!isAssessmentReplanPayload(payload)) {
    return { cwd: baseProjectDir, error: "" };
  }
  const targetRef = payload.wi_branch_name || payload.original_commit_hash || "";
  if (!targetRef) {
    return { cwd: baseProjectDir, error: "no branch or commit was recorded; using base project checkout" };
  }
  try {
    const readonlyDir = path.join(
      contextDir(wiScopeId(job.work_item_id), baseProjectDir),
      "replan-readonly",
      `job-${job.id}`,
    );
    const cwd = await ensureDetachedReadOnlyWorktreeAsync(baseProjectDir, {
      targetRef,
      worktreeDir: readonlyDir,
      signal,
    });
    return { cwd, error: "" };
  } catch (err) {
    return {
      cwd: baseProjectDir,
      error: `could not create detached worktree for ${targetRef}: ${err?.message || String(err)}`,
    };
  }
}

export async function buildAssessmentReplanDiffBlock(payload, researchCwd) {
  const commitHash = String(payload?.original_commit_hash || "").trim();
  const scopedFiles = collectReplanScopedFiles(payload);
  if (!commitHash || scopedFiles.length === 0 || !researchCwd || !fs.existsSync(researchCwd)) return "";
  const narrative = await buildDiffNarrativeAsync({
    cwd: researchCwd,
    commitHash,
    paths: scopedFiles,
  });
  if (narrative?.ok) return formatDiffNarrative(narrative);
  return narrative?.reason ? `DIFF NARRATIVE: unavailable (${narrative.reason})` : "";
}

export function buildPlannerAssessmentReplanContext(payload, { readRoot = "", diffBlock = "", cwdError = "" } = {}) {
  if (payload?._assessment_replan !== true) return "";
  return [
    "ASSESSOR-REQUESTED REPLAN:",
    "Use the original work-item objective and the assessor's failure context to revise the remaining plan.",
    "Inspect the affected files in the current read root. Prior research and staged source files are historical context and may predate the failed implementation; check current source before relying on them.",
    "Preserve completed work and work awaiting assessment. Do not repeat it unless the reported defect requires a change there. Keep all remaining original requirements covered.",
    "Use the standard planner's read-only tools and terminal plan output. No researcher dispatch is available on this loopback.",
    buildAssessmentReplanEvidenceBlock(payload, { researchCwd: readRoot, diffBlock, cwdError, readerLabel: "Planner" }),
    promptLiteral("ASSESSOR REASONS", payload.replan_reason || "(not recorded)"),
    promptLiteral("FAILED TASK", payload.original_task_spec || "(not recorded)"),
    promptLiteral("FAILED TASK SUCCESS CRITERIA", JSON.stringify(payload.original_success_criteria || [])),
    payload.test_command ? promptLiteral("EXISTING VERIFICATION COMMAND", payload.test_command) : "",
    promptLiteral("RETAINED WORK", JSON.stringify(payload.retained_work || [])),
  ].filter(Boolean).join("\n\n");
}
