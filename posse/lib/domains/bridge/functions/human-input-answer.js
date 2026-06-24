import crypto from "node:crypto";

import { Worker } from "../../worker/classes/Worker.js";
import { runHumanInputJob } from "../../worker/functions/execution/human-input-job.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getJob } from "../../queue/functions/index.js";
import { now } from "../../queue/functions/common.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { isReviewGateJob } from "./review-decision.js";

const DEFAULT_BRIDGE_LEASE_SECONDS = 300;

function normalizeAnswers(questions, args = {}) {
  if (Array.isArray(args.answers)) return args.answers;
  if (args.answers && typeof args.answers === "object") {
    return questions.map((question, index) => ({
      question,
      answer: String(args.answers[question] ?? args.answers[index] ?? args.answers[String(index)] ?? ""),
    }));
  }
  const answer = String(args.answer ?? args.response ?? "").trim();
  return questions.map((question) => ({ question, answer }));
}

function leaseExpiry(seconds = DEFAULT_BRIDGE_LEASE_SECONDS) {
  return new Date(Date.now() + Math.max(1, Number(seconds) || DEFAULT_BRIDGE_LEASE_SECONDS) * 1000).toISOString();
}

function claimHumanInputJob(jobId, { leaseSeconds = DEFAULT_BRIDGE_LEASE_SECONDS } = {}) {
  const db = getDb();
  const leaseToken = crypto.randomUUID();
  const owner = `bridge:${process.pid}`;
  const ts = now();
  const expires = leaseExpiry(leaseSeconds);
  const result = db.prepare(`
    UPDATE jobs
    SET status = 'waiting_on_human',
        lease_owner = ?,
        lease_token = ?,
        lease_expires_at = ?,
        updated_at = ?
    WHERE id = ?
      AND job_type = 'human_input'
      AND status IN ('queued', 'waiting_on_human')
      AND (lease_token IS NULL OR lease_expires_at IS NULL OR lease_expires_at < ?)
  `).run(owner, leaseToken, expires, ts, jobId, ts);
  if (result.changes === 0) return null;
  return { leaseToken, job: getJob(jobId) };
}

export async function answerHumanInput(jobId, args = {}, { projectDir = process.cwd(), allowReviewGateAnswer = false } = {}) {
  const id = Number(jobId ?? args.job_id ?? args.jobId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: "invalid_job_id" };

  const current = getJob(id);
  if (!current) return { ok: false, reason: "no_such_job" };
  if (current.job_type !== "human_input") return { ok: false, reason: "not_human_input" };

  const payload = parseJobPayload(current);
  if (payload?.subtype === "plan_approval") {
    return { ok: false, reason: "use_plan_approve_or_reject" };
  }
  if (payload?.subtype === "push_offer") {
    return { ok: false, reason: "use_git_push" };
  }
  if (!allowReviewGateAnswer && isReviewGateJob(current, payload)) {
    return { ok: false, reason: "use_review_approve_or_reject" };
  }
  const questions = Array.isArray(payload?.questions) && payload.questions.length > 0
    ? payload.questions
    : [`Human input needed for: ${current.title}`];
  const answers = normalizeAnswers(questions, args);
  if (answers.length === 0 || answers.every((answer) => String(answer?.answer ?? answer ?? "").trim() === "")) {
    return { ok: false, reason: "empty_answer" };
  }

  const claim = claimHumanInputJob(id, { leaseSeconds: args.lease_seconds });
  if (!claim) return { ok: false, reason: "job_not_claimable" };

  const display = {
    askQuestions: async () => answers,
    workerLine: () => {},
    addEvent: () => {},
    requestRender: () => {},
    setRunPhase: () => {},
  };
  const worker = new Worker({
    projectDir,
    display,
    silent: true,
    autoApprove: false,
  });
  await runHumanInputJob(worker, claim.job, { leaseToken: claim.leaseToken });

  const fresh = getJob(id);
  return {
    ok: true,
    job_id: id,
    status: fresh?.status || "unknown",
    work_item_id: fresh?.work_item_id || current.work_item_id,
  };
}
