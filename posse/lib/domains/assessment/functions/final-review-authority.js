import { emptyMaterializedPathsForJob } from "../../handoff/functions/helpers/file-materialization.js";
import { getTestStrictness } from "../../settings/functions/test-strictness.js";
// A final review authorizes the scoped bytes, named read dependencies, and
// task contract it saw.
// Persist this identity before review; committing those bytes does not change it.
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { gitExecAsync } from "../../git/functions/utils.js";
import { listIgnoredRepoPaths } from "../../git/functions/ignored-paths.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { FINAL_REVIEW_CONTRACT_FIELDS, FINAL_REVIEW_OBSERVATIONS, FINAL_REVIEW_REVIEW_MODES } from "../../../catalog/final-review.js";
import { finalReviewScope } from "./final-review-snapshot.js";
import { finalReviewFindingCorrection } from "./final-review-boundaries.js";

const digest = (value) => createHash("sha256").update(value).digest("hex");
// In-process authority cannot be manufactured by a model's JSON response.
// Recovered jobs obtain a fresh authorization by verifying the durable review.
const acceptedPasses = new WeakMap();
export function isAuthoritativeFinalReviewPass(job, verdict) {
  return verdict?.verdict === "pass" && acceptedPasses.get(verdict) === job.id;
}

function reviewContract(payload) {
  return Object.fromEntries(FINAL_REVIEW_CONTRACT_FIELDS.map((key) => [key, payload?.[key] ?? null]));
}

export function finalReviewContractIdentity(cwd, payload) {
  return digest(JSON.stringify({ contract: reviewContract(payload), test_strictness: getTestStrictness({ projectDir: cwd }) }));
}

export async function finalReviewIdentity(cwd, payload, { jobId = null } = {}) {
  return (await finalReviewIdentityEvidence(cwd, payload, { jobId })).identity;
}

export async function finalReviewIdentityEvidence(cwd, payload, { jobId = null } = {}) {
  const placeholders = new Set(await emptyMaterializedPathsForJob(jobId, payload?.scope_generation ?? payload?._materialization_generation ?? 1, cwd));
  const scope = finalReviewScope(payload);
  const readPaths = (Array.isArray(payload?.dev_brief?.key_files) ? payload.dev_brief.key_files : [])
    .slice(0, 64)
    .map((value) => String(value || "").trim().replace(/\\/g, "/"))
    .filter((value) => value && !path.posix.isAbsolute(value)
      && !value.split("/").some((part) => !part || part === "." || part === ".."));
  const listed = String(await gitExecAsync(["ls-files", "-z", "--cached", "--others", "--exclude-standard"], cwd, { trim: false })).split("\0").filter(Boolean);
  const ignored = new Set((await listIgnoredRepoPaths(cwd, [...scope.files])).map((entry) => entry.path));
  const scoped = new Set([...listed.filter((file) => !scope.declared || scope.files.has(file)
    || scope.roots.some((root) => file === root || file.startsWith(`${root}/`))),
  ...[...scope.files].filter((file) => !ignored.has(file))]);
  // Ignored outputs cannot be committed. Explicit read dependencies still bind
  // their bytes, even when ignored, because they are inputs to the contract.
  const files = [...new Set([...scoped, ...readPaths])].sort();
  const root = fs.realpathSync(cwd);
  const states = files.map((file) => {
    if (placeholders.has(file)) return [file, null];
    const absolute = path.resolve(cwd, file);
    if (!absolute.startsWith(`${path.resolve(cwd)}${path.sep}`)) throw new Error("Review path escapes workspace");
    if (!fs.existsSync(absolute) && !fs.lstatSync(absolute, { throwIfNoEntry: false })) return [file, null];
    const stat = fs.lstatSync(absolute);
    if (stat.isSymbolicLink()) return [file, "symlink", digest(fs.readlinkSync(absolute))];
    // A planner's read dependency may name a directory; it binds no bytes,
    // and must never make every review and its authority unavailable.
    if (!scoped.has(file) && !stat.isFile()) return [file, "non_file"];
    if (!fs.realpathSync(absolute).startsWith(`${root}${path.sep}`) || !stat.isFile()) throw new Error("Review path is not a workspace file");
    return [file, stat.mode & 0o111, digest(fs.readFileSync(absolute))];
  });
  const contract = reviewContract(payload);
  return { identity: digest(JSON.stringify({ contract, states, test_strictness: getTestStrictness({ projectDir: cwd }) })),
    states, readPaths, scoped: [...scoped] };
}

// Completion requires the reviewed files to be committed, not an idle shared
// worktree. Unrelated siblings retain their own leases and uncommitted work.
export async function finalReviewedFilesCommitted(job, payload, cwd) {
  const evidence = await finalReviewIdentityEvidence(cwd, payload, { jobId: job.id });
  const paths = evidence.states.filter((state) => state[1] !== "non_file").map((state) => state[0]);
  if (paths.length === 0) return true;
  return !String(await gitExecAsync(["status", "--porcelain=v1", "-z", "--untracked-files=all", "--",
    ...paths.map((file) => `:(literal)${file}`)], cwd, { trim: false }));
}

export function latestFinalReview(jobId, db = getDb()) {
  const issued = db.prepare("SELECT attempt_id, detail_json FROM final_review_records WHERE job_id = ? AND observation_type = ? ORDER BY id DESC LIMIT 1")
    .get(jobId, FINAL_REVIEW_OBSERVATIONS.ISSUED);
  if (!issued) return null;
  const payload = JSON.parse(db.prepare("SELECT payload_json FROM jobs WHERE id = ?").get(jobId)?.payload_json || "{}");
  if (issued.attempt_id != null && Number(issued.attempt_id) <= Number(payload._final_review_invalidated_attempt_id || 0)) return null;
  const attempt = issued.attempt_id == null ? null : db.prepare("SELECT status, error_text FROM job_attempts WHERE id = ?").get(issued.attempt_id);
  // Failed implementation attempts cannot authorize a later retry, even when
  // their bytes still match the review. Interrupted recovery remains eligible.
  if (attempt && (attempt.status === "failed" || attempt.error_text && attempt.status !== "running" && attempt.status !== "interrupted")) return null;
  const callId = JSON.parse(issued.detail_json).agent_call_id;
  const result = db.prepare("SELECT detail_json FROM final_review_records WHERE job_id = ? AND observation_type = ? AND agent_call_id = ? ORDER BY id DESC LIMIT 1")
    .get(jobId, FINAL_REVIEW_OBSERVATIONS.RESULT, callId);
  if (result) return JSON.parse(result.detail_json);
  // Provider fallback can replace the developer within an attempt. Its retry
  // budgets survive, so unresolved evidence must survive too. Never borrow a
  // pass or cross an attempt boundary: a new call needs its own acceptance.
  const inherited = issued.attempt_id == null ? null : db.prepare(
    "SELECT detail_json FROM final_review_records WHERE job_id = ? AND attempt_id = ? AND observation_type = ? ORDER BY id DESC LIMIT 1",
  ).get(jobId, issued.attempt_id, FINAL_REVIEW_OBSERVATIONS.RESULT);
  const review = inherited ? JSON.parse(inherited.detail_json) : null;
  return review && review.outcome !== "pass" ? review : {};
}

export async function authoritativeFinalReview(job, payload, cwd) {
  const review = latestFinalReview(job.id);
  if (!review) return null; // Jobs never issued final_review retain their existing route.
  // The latest review obtained no reviewer verdict (provider error, a
  // reviewer that ended without reporting, its wall): nothing to authorize or
  // gate, so the ordinary assessment verifies the change with its own
  // bounded recovery.
  if (review.review_mode === FINAL_REVIEW_REVIEW_MODES.INFRASTRUCTURE) return null;
  const unresolved = (reason) => ({ verdict: "needs_review", confidence: "none", reasons: [reason],
    spawn_jobs: [], human_questions: [], _disable_internal_retry: true, _assessment_infrastructure_review: true, _verification_blocked: true });
  let identity;
  try { identity = await finalReviewIdentity(cwd, payload, { jobId: job.id }); } catch { return unresolved("Cannot verify the final-reviewed workspace identity."); }
  // A repair after the last semantic review needs fresh verification. Let the
  // ordinary assessment run on that candidate; the old result stays in the
  // durable review ledger as historical context, not an approval or a gate.
  if (review.review_identity && identity !== review.review_identity) return null;
  if (!["pass", "findings"].includes(review.outcome) || !review.review_identity) {
    return unresolved(review.reason || "Final review is missing, blocked, or has unresolved findings; no second assessor will be dispatched.");
  }
  if (review.outcome === "findings") {
    const correction = await finalReviewFindingCorrection(review, { job, payload, cwd });
    if (correction) return unresolved(correction);
    const reasons = (review.findings || []).map((finding) => [finding.criterion,
      ...(finding.paths || []), ...(finding.refs || []), finding.evidence,
      finding.suggested_verification].filter(Boolean).join(" — "));
    if (!reasons.length) return unresolved("Final review reported findings without their details; an operator must resolve the review.");
    const diagnostics = [review.declared_tests, review.changed_tests].filter(Boolean)
      .map((run) => [run.command, run.status, run.failure_summary, run.stdout, run.stderr].filter(Boolean).join("\n"));
    return { verdict: "fail", confidence: "high", reasons, human_questions: [],
      spawn_jobs: [{ job_type: "fix", title: "Fix final review findings", payload: {
        instructions: [...reasons, review.repair, ...diagnostics].filter(Boolean).join("\n\n"),
      } }], _final_reviewer_agent_call_id: review.reviewer_agent_call_id };
  }
  const verdict = { verdict: "pass", confidence: "high", reasons: [review.summary || "Final review passed for the exact committed change and task contract."],
    spawn_jobs: [], human_questions: [], _final_reviewer_agent_call_id: review.reviewer_agent_call_id };
  acceptedPasses.set(verdict, job.id);
  return verdict;
}
