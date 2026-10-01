import fs from "fs";
import path from "path";
import { contextDir, wiScopeId } from "../../artifacts/functions/index.js";
import { ensureDetachedReadOnlyWorktreeAsync, removeDetachedReadOnlyWorktreeAsync } from "../../git/functions/worktree.js";
import { buildDiffNarrativeAsync, formatDiffNarrative } from "../../git/functions/diff-narrator.js";
import { promptLiteral } from "../../../shared/format/functions/prompt-literals.js";
import { REPLAN_TRIGGERS } from "../../../catalog/job.js";
import { REPLAN_READONLY_WORKTREE_DIR } from "../../../catalog/artifact.js";

// Shared preparation for direct planner loopbacks and already-queued legacy
// research loopbacks. Repository inspection stays on the work-item branch.
function collectReplanScopedFiles(payload = {}) {
  const files = Array.isArray(payload?.original_scoped_files) ? payload.original_scoped_files : [];
  return [...new Set(files.map((file) => String(file || "").replace(/\\/g, "/").trim()).filter(Boolean))];
}

// The replan's framing follows what asked for it. An operator replan after a
// blocked job carries the block reason and no assessor findings, so calling it
// an assessor failure sends the planner hunting for a defect that never existed.
const REPLAN_FRAMES = Object.freeze({
  [REPLAN_TRIGGERS.ASSESSOR]: {
    heading: "ASSESSOR-REQUESTED REPLAN:",
    intro: "Use the original work-item objective and the assessor's failure context to revise the remaining plan.",
    cause: "This replan was triggered by assessor failure after a mutating job, so inspect the current work-item branch state before proposing replacement work.",
    reasons: "ASSESSOR REASONS",
  },
  [REPLAN_TRIGGERS.OPERATOR_BLOCKED_RECOVERY]: {
    heading: "OPERATOR-REQUESTED REPLAN (after a blocked job):",
    intro: "The original job reported BLOCKED and the operator chose to replan. Revise the remaining plan so the blocker is resolved or routed around; no assessor ran on this job.",
    cause: "This replan was requested by the operator after the original job was blocked. Inspect the current work-item branch state and the block reason before proposing replacement work.",
    reasons: "BLOCK AND OPERATOR REASONS",
  },
  [REPLAN_TRIGGERS.OPERATOR_REVIEW]: {
    heading: "OPERATOR-REQUESTED REPLAN:",
    intro: "The operator chose to replan from review. Use the original work-item objective and the review context to revise the remaining plan.",
    cause: "This replan was requested by the operator during review, so inspect the current work-item branch state before proposing replacement work.",
    reasons: "OPERATOR REASONS",
  },
  [REPLAN_TRIGGERS.FIX_CHAIN_EXHAUSTED]: {
    heading: "AUTOMATIC REPLAN (fix chain exhausted):",
    intro: "Repeated fixes did not satisfy the assessor. Use the original work-item objective and the failure context to revise the remaining plan with a different approach.",
    cause: "This replan was triggered after the fix chain was exhausted, so inspect the current work-item branch state before proposing replacement work.",
    reasons: "FAILURE REASONS",
  },
  [REPLAN_TRIGGERS.BLOCKED_RECOVERY_RETRY_FAILED]: {
    heading: "AUTOMATIC REPLAN (blocked job retry failed):",
    intro: "A blocked job was retried and blocked again. Revise the remaining plan so the blocker is resolved or routed around.",
    cause: "This replan was triggered after a retried blocked job blocked again, so inspect the current work-item branch state and the block reason before proposing replacement work.",
    reasons: "BLOCK REASONS",
  },
});

function replanFrame(payload = {}) {
  return REPLAN_FRAMES[String(payload?.replan_trigger || "")] || REPLAN_FRAMES[REPLAN_TRIGGERS.ASSESSOR];
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
  const frame = replanFrame(payload);
  const lines = [
    "ASSESSMENT REPLAN EVIDENCE:",
    `- ${frame.cause}`,
    `- Original job: #${payload.original_job_id} (${payload.original_job_type}${payload.original_task_mode ? `/${payload.original_task_mode}` : ""}) ${payload.original_title || ""}`.trim(),
    `- Work-item branch: ${payload.wi_branch_name || "(not recorded)"}`,
    `- Original commit: ${payload.original_commit_hash || "(not recorded)"}`,
    payload.wi_merge_base_hash ? `- Merge base: ${payload.wi_merge_base_hash}` : "",
    researchCwd ? `- ${readerLabel} cwd: ${researchCwd}` : "",
    cwdError ? `- Branch worktree note: ${cwdError}` : "",
    scopedFiles.length > 0 ? `- Original scoped files:\n${scopedFiles.map((file) => `  - ${file}`).join("\n")}` : "- Original scoped files: (not recorded)",
    payload.replan_reason ? `\n${frame.reasons}:\n${payload.replan_reason}` : "",
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
      REPLAN_READONLY_WORKTREE_DIR,
      `job-${job.id}`,
    );
    const cwd = await ensureDetachedReadOnlyWorktreeAsync(baseProjectDir, {
      targetRef,
      worktreeDir: readonlyDir,
      signal,
    });
    return { cwd, error: "", readonlyWorktree: cwd };
  } catch (err) {
    return {
      cwd: baseProjectDir,
      error: `could not create detached worktree for ${targetRef}: ${err?.message || String(err)}`,
    };
  }
}

// Job-scoped teardown for resolveAssessmentReplanCwd: unregister and delete the
// detached checkout. Failures are left to worktree GC.
export async function releaseAssessmentReplanCwd(baseProjectDir, replanCwd) {
  const wtPath = replanCwd?.readonlyWorktree;
  if (!wtPath) return { removed: false };
  try {
    return { removed: await removeDetachedReadOnlyWorktreeAsync(baseProjectDir, wtPath) };
  } catch (err) {
    return { removed: false, error: err?.message || String(err) };
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
  const frame = replanFrame(payload);
  return [
    frame.heading,
    frame.intro,
    "Inspect the affected files in the current read root. Prior research and staged source files are historical context and may predate the failed implementation; check current source before relying on them.",
    "Preserve completed work and work awaiting assessment. Do not repeat it unless the reported defect requires a change there. Keep all remaining original requirements covered.",
    payload.planner_dispatch === true
      ? "Use the planner's read-only tools and terminal plan output. Earlier research is listed under WORK ITEM RESEARCH REFS when present; when a plan-blocking fact is still missing and dispatch_agent is issued to you, research children remain available."
      : "Use the standard planner's read-only tools and terminal plan output. No researcher dispatch is available on this loopback.",
    buildAssessmentReplanEvidenceBlock(payload, { researchCwd: readRoot, diffBlock, cwdError, readerLabel: "Planner" }),
    Array.isArray(payload.assessment_evidence_selectors) && payload.assessment_evidence_selectors.length > 0
      ? "ASSESSOR EVIDENCE: the assessor's cited selectors are issued to you as traversal refs in the ref map; open them with traverse_ref before re-scoping the affected region."
      : "",
    promptLiteral(frame.reasons, payload.replan_reason || "(not recorded)"),
    payload.block_context ? promptLiteral("BLOCK CONTEXT (the blocked job's recovery gate)", payload.block_context) : "",
    promptLiteral("FAILED TASK", payload.original_task_spec || "(not recorded)"),
    promptLiteral("FAILED TASK SUCCESS CRITERIA", JSON.stringify(payload.original_success_criteria || [])),
    Array.isArray(payload.compiler_rewrites) && payload.compiler_rewrites.length > 0
      ? promptLiteral("COMPILER REWRITES (the failed task is the compiled job, not the task as planned)", payload.compiler_rewrites.join("\n"))
      : "",
    payload.test_command ? promptLiteral("EXISTING VERIFICATION COMMAND", payload.test_command) : "",
    Array.isArray(payload.baseline_test_debt) && payload.baseline_test_debt.length > 0
      ? [
        promptLiteral("TEST COMMANDS ALREADY FAILING BEFORE ANY CHANGE (baseline debt)", JSON.stringify(payload.baseline_test_debt)),
        "Each of these failed at its frozen baseline, before any job changed code, so it cannot verify revised tasks as written. Declare a command that passes on the current branch, or make fixing the pre-existing failure an explicit task.",
      ].join("\n")
      : "",
    promptLiteral("RETAINED WORK", JSON.stringify(payload.retained_work || [])),
    Array.isArray(payload.superseded_work) && payload.superseded_work.length > 0
      ? promptLiteral("SUPERSEDED WORK (canceled by this replan, not done; keep its scope and verification covered)", JSON.stringify(payload.superseded_work))
      : "",
  ].filter(Boolean).join("\n\n");
}
