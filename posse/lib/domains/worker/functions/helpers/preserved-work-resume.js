import path from "node:path";
import { PRESERVED_WORK_RESUME_KEY } from "../../../../catalog/human-input.js";
import { finalReviewIdentityEvidence } from "../../../assessment/functions/final-review-authority.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import { getAttempts, getJob, updateJobPayload } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { payloadExplicitlyClaimsPath, unfinishedSiblingDirtyLocks } from "./worktree-dirty-classification.js";

// A paused candidate is not arbitrary dirt. Bind only its owned bytes, not
// the mutable task contract (a scope approval intentionally expands that).
function ownedScope(payload) {
  return Object.fromEntries(["files_to_modify", "files_to_create", "files_to_delete", "must_modify", "create_roots"]
    .map(key => [key, payload[key] || []]));
}

async function indexIdentity(cwd, paths) {
  if (!paths.length) return "";
  return String(await gitExecAsync(["ls-files", "--stage", "-z", "--", ...paths.map(file => `:(literal)${file}`)], cwd, { trim: false }));
}

export async function preserveWorkForResume(job, attemptId, cwd) {
  const current = getJob(job.id) || job;
  const payload = parseJobPayload(current);
  const scope = ownedScope(payload);
  if (!Object.values(scope).some(files => files.length)) return;
  const evidence = await finalReviewIdentityEvidence(cwd, scope, { jobId: job.id });
  const branch = String(await gitExecAsync(["branch", "--show-current"], cwd)).trim();
  if (!branch) throw new Error("Cannot preserve an unnamed worktree branch");
  const index = await indexIdentity(cwd, evidence.scoped);
  // Reload after the asynchronous reads so live scope decisions are retained.
  const latest = parseJobPayload(getJob(job.id) || current);
  latest[PRESERVED_WORK_RESUME_KEY] = { attempt_id: attemptId, cwd: path.resolve(cwd), branch,
    scope, identity: evidence.identity, paths: evidence.scoped, index };
  updateJobPayload(job.id, JSON.stringify(latest));
}

export async function preservedResumePaths(job, cwd) {
  const payload = parseJobPayload(getJob(job.id) || job);
  const receipt = payload[PRESERVED_WORK_RESUME_KEY];
  if (!receipt || receipt.cwd !== path.resolve(cwd) || !Array.isArray(receipt.paths)) return [];
  const attempts = getAttempts(job.id).filter(attempt => attempt.worker_type !== "assessor");
  // A later implementation attempt invalidates the old receipt, even if its
  // failure happened before producing a new candidate.
  if (attempts.at(-1)?.id !== receipt.attempt_id || !attempts.at(-1)?.finished_at) return [];
  try {
    if (String(await gitExecAsync(["branch", "--show-current"], cwd)).trim() !== receipt.branch) return [];
    const evidence = await finalReviewIdentityEvidence(cwd, receipt.scope, { jobId: job.id });
    if (evidence.identity !== receipt.identity || await indexIdentity(cwd, receipt.paths) !== receipt.index) return [];
  } catch { return []; } // Unreadable or replaced paths require ordinary recovery.
  const paths = receipt.paths.filter(file => payloadExplicitlyClaimsPath(payload, file));
  const overlapping = new Set(unfinishedSiblingDirtyLocks(job, paths, { includeCurrentScope: true }).map(lock => lock.path));
  return paths.filter(file => !overlapping.has(file));
}
