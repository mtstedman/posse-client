// A final review authorizes only the scoped bytes and task contract it saw.
// Persist this identity before review; committing those bytes does not change it.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gitExecAsync } from "../../git/functions/utils.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { FINAL_REVIEW_OBSERVATIONS } from "../../../catalog/final-review.js";
import { finalReviewScope } from "./final-review-snapshot.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");

export async function finalReviewIdentity(cwd, payload) {
  const scope = finalReviewScope(payload);
  const listed = String(await gitExecAsync(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd, { trim: false })).split("\0").filter(Boolean);
  const files = [...new Set([...listed.filter((file) => !scope.declared || scope.files.has(file)
    || scope.roots.some((root) => file === root || file.startsWith(`${root}/`))), ...scope.files])].sort();
  const root = fs.realpathSync(cwd);
  const states = files.map((file) => {
    const absolute = path.resolve(cwd, file);
    if (!absolute.startsWith(`${path.resolve(cwd)}${path.sep}`)) throw new Error("Review path escapes workspace");
    if (!fs.existsSync(absolute) && !fs.lstatSync(absolute, { throwIfNoEntry: false })) return [file, null];
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return [file, "symlink", digest(fs.readlinkSync(absolute))];
    if (!fs.realpathSync(absolute).startsWith(`${root}${path.sep}`) || !stat.isFile()) throw new Error("Review path is not a workspace file");
    return [file, stat.mode & 0o111, digest(fs.readFileSync(absolute))];
  });
  const contract = Object.fromEntries([
    "task_spec", "instructions", "root_task_spec", "original_task_spec", "fix_instructions",
    "success_criteria", "root_success_criteria", "constraints", "test_command", "tests_to_run", "verification_contract",
    "files_to_modify", "files_to_create", "files_to_delete", "create_roots",
  ].map((key) => [key, payload?.[key] ?? null]));
  return digest(JSON.stringify({ contract, states }));
}

export function latestFinalReview(jobId, db = getDb()) {
  const issued = db.prepare("SELECT detail_json FROM job_observations WHERE job_id = ? AND observation_type = ? ORDER BY id DESC LIMIT 1")
    .get(jobId, FINAL_REVIEW_OBSERVATIONS.ISSUED);
  if (!issued) return null;
  const callId = JSON.parse(issued.detail_json).agent_call_id;
  const result = db.prepare("SELECT detail_json FROM job_observations WHERE job_id = ? AND observation_type = ? AND json_extract(detail_json, '$.agent_call_id') = ? ORDER BY id DESC LIMIT 1")
    .get(jobId, FINAL_REVIEW_OBSERVATIONS.RESULT, callId);
  return result ? JSON.parse(result.detail_json) : {};
}

export async function authoritativeFinalReview(job, payload, cwd) {
  const review = latestFinalReview(job.id);
  if (!review) return null; // Jobs never issued final_review retain their existing route.
  const unresolved = (reason) => ({ verdict: "needs_review", confidence: "none", reasons: [reason],
    spawn_jobs: [], human_questions: [], _disable_internal_retry: true, _assessment_infrastructure_review: true, _verification_blocked: true });
  if (review.outcome !== "pass" || !review.review_identity) {
    return unresolved(review.reason || "Final review is missing, blocked, or has unresolved findings; no second assessor will be dispatched.");
  }
  let identity;
  try { identity = await finalReviewIdentity(cwd, payload); } catch { return unresolved("Cannot verify the final-reviewed workspace identity."); }
  if (identity !== review.review_identity) return unresolved("The task contract or scoped files changed after final review; the change requires review again.");
  return { verdict: "pass", confidence: "high", reasons: [review.summary || "Final review passed for the exact committed change and task contract."],
    spawn_jobs: [], human_questions: [], _final_reviewer_agent_call_id: review.reviewer_agent_call_id };
}
