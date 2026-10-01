import { storeArtifact } from "../../../queue/functions/index.js";
import { extractCheckpointFromOutput } from "../helpers/mutation-guards.js";

// When an attempt dies AFTER the agent finished (commit failure, output
// contract, hooks), the agent's reasoning is done and correct work may
// already sit in the tree. Persist a checkpoint unconditionally so the retry
// prompt inherits the prior approach instead of re-deriving it blind.
// remainingWork is a PARTIAL agent's full remaining_work list; the rendered
// result block in `output` keeps only its first 30 words.
export function storePostAgentFailureCheckpoint({ job, attemptId, output, failureNote, remainingWork = [] }) {
  try {
    const text = String(output || "");
    const remaining = (Array.isArray(remainingWork) ? remainingWork : [])
      .map((entry) => String(entry || "").trim())
      .filter(Boolean);
    const distilled = [
      extractCheckpointFromOutput(text) || text.slice(-2000).trim(),
      remaining.length > 0
        ? `REMAINING WORK REPORTED BY THE PREVIOUS ATTEMPT (status PARTIAL):\n${remaining.map((entry) => `  - ${entry}`).join("\n")}`
        : "",
    ].filter(Boolean).join("\n\n");
    if (!distilled) return;
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: attemptId,
      artifact_type: "log",
      content_long: [
        "checkpoint:POST-AGENT FAILURE NOTE: the previous attempt's agent run COMPLETED;",
        `the attempt failed afterwards (${String(failureNote || "post-agent step failed").slice(0, 300)}).`,
        "Its work may already be present in the worktree or branch — verify current state",
        "before redoing anything.",
        "",
        distilled,
      ].join("\n"),
    });
  } catch {
    // checkpoint is best-effort
  }
}
