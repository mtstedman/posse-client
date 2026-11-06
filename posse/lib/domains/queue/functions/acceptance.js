import { adminGitExec } from "../../git/functions/admin-git-exec.js";
import { normalizeProjectDir } from "../../runtime/functions/paths.js";
import { ACCEPTANCE_ACTIONS, ACCEPTANCE_DEFERRED } from "../../../catalog/acceptance.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getWorkItem, listJobsByWorkItem, updateWorkItemMetadata } from "./index.js";
import { runImmediateTransaction } from "./common.js";
import { latestImplementationCommit, postChangeReceiptsAtCommit } from "./verification-receipts.js";
import { projectAcceptance } from "../../assessment/functions/acceptance.js";
import { requiresTestVerification } from "../../settings/functions/test-strictness.js";

function currentCandidate(workItemId) {
  const wi = getWorkItem(workItemId);
  if (!wi?.branch_name || wi.merge_state === "merged") return latestImplementationCommit(workItemId);
  try { return adminGitExec(["rev-parse", "--verify", `refs/heads/${wi.branch_name}^{commit}`], normalizeProjectDir(), { timeoutMs: 5000 }); }
  catch { return null; }
}

export function readAcceptance(workItemId, { candidateCommit = currentCandidate(workItemId) } = {}) {
  const workItem = getWorkItem(workItemId);
  if (!workItem) throw new Error(`Unknown work item ${workItemId}`);
  const metadata = JSON.parse(workItem.metadata_json || "{}");
  return projectAcceptance({ jobs: listJobsByWorkItem(workItemId), receipts: postChangeReceiptsAtCommit(workItemId, candidateCommit),
    decisions: metadata.acceptance_decisions || [], candidateCommit });
}

/** Operator-only API; no agent tool can waive or declare acceptance. */
export function recordAcceptanceDecision(workItemId, { action, key, artifactId = null, reason = "" } = {}) {
  if (!ACCEPTANCE_ACTIONS.includes(action)) throw new Error("Expected require, bind or waive");
  if (action !== "require" && !String(reason).trim()) throw new Error("Evidence mappings and waivers need a reason");
  return runImmediateTransaction(getDb(), () => {
    const current = readAcceptance(workItemId);
    const requirement = current.requirements.find(row => row.key === key);
    if (!requirement) throw new Error("Unknown requirement key; inspect posse acceptance show first");
    if (action !== "require" && !current.candidate_commit) throw new Error("No candidate commit to bind");
    if (action === "bind") {
      const receipt = postChangeReceiptsAtCommit(workItemId, current.candidate_commit).find(r => r.artifact_id === Number(artifactId));
      if (!receipt || !requirement.job_ids.includes(receipt.job_id)) throw new Error("Receipt must belong to this requirement's job lineage and current candidate");
      const projected = projectAcceptance({ jobs: listJobsByWorkItem(workItemId), receipts: [receipt], candidateCommit: current.candidate_commit,
        decisions: [{ action, key, artifact_id: Number(artifactId), commit: current.candidate_commit }] });
      if (!projected.requirements.find(r => r.key === key)?.evidence) throw new Error("Receipt does not establish executed passing coverage");
    }
    const wi = getWorkItem(workItemId);
    const metadata = JSON.parse(wi.metadata_json || "{}");
    const entry = { action, key, contract_digest: requirement.contract_digest, requirement_id: requirement.id, requirement_text: requirement.text,
      artifact_id: action === "bind" ? Number(artifactId) : null, reason: String(reason).trim(), commit: current.candidate_commit,
      actor: "operator", at: new Date().toISOString() };
    updateWorkItemMetadata(workItemId, { ...metadata, acceptance_decisions: [...(metadata.acceptance_decisions || []), entry] });
    return readAcceptance(workItemId);
  });
}

export function acceptanceMergeDeferral(workItemId, { candidateCommit, projectDir, strict = requiresTestVerification({ projectDir }) } = {}) {
  if (!strict) return null;
  const acceptance = readAcceptance(workItemId, { candidateCommit });
  if (!acceptance.unmet_required.length) return null;
  return { ok: false, deferred: true, reason: ACCEPTANCE_DEFERRED, acceptance,
    message: `Merge deferred: ${acceptance.unmet_required.length} explicitly required outcome(s) lack current evidence. Candidate retained. Inspect posse acceptance show ${workItemId}; bind evidence or record an explicit waiver.` };
}
