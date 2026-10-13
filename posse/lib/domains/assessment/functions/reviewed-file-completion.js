import { normPath } from "../../../shared/scope/functions/path.js";
import { createHash } from "node:crypto";
import { finalReviewIdentityEvidence, latestFinalReview, authoritativeFinalReview } from "./final-review-authority.js";
import { finalReviewScope } from "./final-review-snapshot.js";
import { gitExecAsync } from "../../git/functions/utils.js";
import { exactReviewedPath, reviewedFileObject, sameReviewedObject } from "../../git/functions/reviewed-file-objects.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { workItemBranchGeneration, reviewedAuthorityFingerprint } from "../../queue/functions/reviewed-handoff-records.js";
import { isLeaseValid } from "../../queue/functions/attempts.js";
import { REVIEWED_COMPLETION_KEY, REVIEWED_HANDOFF_VERSION, REVIEWED_HANDOFF_REF_PREFIX } from "../../../catalog/reviewed-handoffs.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
import { logDurableEvent } from "../../queue/functions/events.js";

// Compute under the worker's assessment barrier, after all post-commit checks.
// The synchronous publication below rechecks the database facts in closeout's
// transaction. A review pass on its own never publishes a receipt.
export async function prepareReviewedFileCompletion(job, cwd, {
  committedHash, commitBaseHash, filesCommitted = [], verifiedNoChange = false,
} = {}) {
  const payload = parseJobPayload(job);
  const scope = finalReviewScope(payload);
  if (!["dev", "fix"].includes(job.job_type) || ![undefined, "code"].includes(payload.task_mode)
      || !scope.declared || scope.roots.length || ![...scope.files].every(exactReviewedPath)
      || (!committedHash && !verifiedNoChange)) return null;
  if (new Set([...scope.files].map(normPath)).size !== scope.files.size) return null;
  const review = latestFinalReview(job.id);
  if (review?.outcome !== "pass" || !review.review_identity || !review.agent_call_id || !review.attempt_id) return null;
  if ((await authoritativeFinalReview(job, payload, cwd))?.verdict !== "pass") return null;
  const evidence = await finalReviewIdentityEvidence(cwd, payload, { jobId: job.id });
  if (evidence.identity !== review.review_identity) return null;
  // Ignored/non-file inputs cannot be represented by a pinned Git object.
  if (evidence.scoped.length !== scope.files.size
      || evidence.readPaths.some((file) => !exactReviewedPath(file))
      || evidence.states.some((state) => state[1] === "non_file")) return null;
  const db = getDb();
  const wi = db.prepare("SELECT * FROM work_items WHERE id = ?").get(job.work_item_id);
  const fresh = db.prepare("SELECT * FROM jobs WHERE id = ?").get(job.id);
  const attempt = db.prepare("SELECT * FROM job_attempts WHERE id = ? AND job_id = ?").get(review.attempt_id, job.id);
  if (!wi?.branch_name || !fresh || !attempt) return null;
  const branch = String(await gitExecAsync(["branch", "--show-current"], cwd)).trim();
  if (branch !== wi.branch_name) return null;
  const head = String(await gitExecAsync(["rev-parse", "HEAD"], cwd)).trim();
  const revision = committedHash || head;
  const base = commitBaseHash || attempt.commit_base_hash || (verifiedNoChange ? revision : null);
  if (!base) return null;
  const prefix = String(await gitExecAsync(["rev-parse", "--show-prefix"], cwd));
  const paths = [...new Set([...scope.files, ...evidence.readPaths])];
  if (String(await gitExecAsync(["status", "--porcelain=v1", "--untracked-files=all", "--", ...paths.map((p) => `:(literal)${p}`)], cwd))) return null;
  const entries = [];
  const inputs = [];
  for (const file of paths) {
    const repoPath = `${prefix}${file}`;
    const object = await reviewedFileObject(cwd, revision, repoPath);
    if (object?.mode === "120000" || (object == null && evidence.states.find((state) => state[0] === file)?.[1] != null)) return null;
    // A sibling may have committed elsewhere since closeout's commit. Only
    // the bound paths must still match; never substitute its mutable HEAD.
    if (!sameReviewedObject(object, await reviewedFileObject(cwd, head, repoPath))) return null;
    if (scope.files.has(file)) {
      const before = await reviewedFileObject(cwd, base, repoPath);
      entries.push({ path: file, repo_path: repoPath, base: before, object,
        change_kind: sameReviewedObject(before, object) ? "unchanged" : object == null ? "deleted" : before == null ? "created" : "modified" });
    } else inputs.push({ path: file, repo_path: repoPath, object });
  }
  const admitted = new Set(filesCommitted.map(normPath));
  if (entries.some((entry) => entry.change_kind !== "unchanged" && !admitted.has(normPath(entry.path)))) return null;
  const receipt = {
    version: REVIEWED_HANDOFF_VERSION, source_work_item_id: wi.id, source_job_id: job.id,
    implementation_attempt_id: review.attempt_id, attempt_count: fresh.attempt_count,
    developer_call_id: review.agent_call_id, review_identity: review.review_identity,
    authority_fingerprint: reviewedAuthorityFingerprint(payload),
    source_branch: branch, source_generation: workItemBranchGeneration(wi),
    base_commit: base, source_commit: revision, files: entries, read_inputs: inputs,
  };
  const receiptId = createHash("sha256").update(JSON.stringify(receipt)).digest("hex");
  // Retain before publishing. A crash may leave an unused ref, which is safe;
  // the reverse order could leave a live receipt pointing at collected data.
  await gitExecAsync(["update-ref", `${REVIEWED_HANDOFF_REF_PREFIX}${receiptId}`, revision], cwd);
  return { ...receipt, receipt_id: receiptId, completed_at: new Date().toISOString() };
}

export function persistReviewedFileCompletion(jobId, receipt, leaseToken) {
  if (!receipt || !leaseToken) return false;
  const db = getDb();
  if (!db.inTransaction) throw new Error("Reviewed closeout requires the success transaction");
  const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(jobId);
  const wi = db.prepare("SELECT * FROM work_items WHERE id = ?").get(job?.work_item_id);
  const review = latestFinalReview(jobId, db);
  if (!job || job.lease_token !== leaseToken || !isLeaseValid(jobId, leaseToken) || job.attempt_count !== receipt.attempt_count
      || receipt.authority_fingerprint !== reviewedAuthorityFingerprint(parseJobPayload(job))
      || workItemBranchGeneration(wi) !== receipt.source_generation
      || review?.outcome !== "pass" || review.review_identity !== receipt.review_identity
      || review.agent_call_id !== receipt.developer_call_id || review.attempt_id !== receipt.implementation_attempt_id) return false;
  const payload = parseJobPayload(job);
  payload[REVIEWED_COMPLETION_KEY] = receipt;
  db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?").run(JSON.stringify(payload), jobId);
  logDurableEvent({ work_item_id: wi.id, job_id: jobId,
    event_type: EVENT_TYPES.JOB_REVIEWED_FILE_COMPLETION, actor_type: EVENT_ACTORS.WORKER,
    message: "Published verified final-review file completion",
    event_json: JSON.stringify({ receipt_id: receipt.receipt_id, source_commit: receipt.source_commit,
      source_generation: receipt.source_generation, paths: receipt.files.map((entry) => entry.path) }) });
  return true;
}
