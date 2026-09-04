import crypto from "node:crypto";

import { Worker } from "../../worker/classes/Worker.js";
import { runHumanInputJob } from "../../worker/functions/execution/human-input-job.js";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getHumanGate, getJob } from "../../queue/functions/index.js";
import { now } from "../../queue/functions/common.js";
import { jobHasLiveLeaseAt } from "../../queue/functions/lease-state.js";
import {
  answerWorkItemQuestionChoice,
  projectWorkItemInteractions,
} from "../../queue/functions/interaction-contract.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { isReviewGateJob } from "./review-decision.js";
import {
  exactHumanInputChoiceFromAnswer,
  humanInputChoiceFromAnswer,
  humanInputChoicesForPayload,
} from "../../../catalog/human-input.js";

const DEFAULT_BRIDGE_LEASE_SECONDS = 300;
const STRUCTURED_CHOICE_ALIASES = Object.freeze({
  retry_assessment: Object.freeze(["retry"]),
  retry_with_changes: Object.freeze(["retry"]),
  explicit_waiver: Object.freeze(["skip"]),
  deny: Object.freeze(["reject"]),
});

function normalizeAnswers(questions, args = {}) {
  if (Array.isArray(args.answers)) return args.answers;
  if (args.answers && typeof args.answers === "object") {
    return questions.map((question, index) => ({
      question,
      answer: String(args.answers[question] ?? args.answers[index] ?? args.answers[String(index)] ?? ""),
    }));
  }
  const answer = String(args.answer ?? args.response ?? "").trim();
  const metadata = args.answer_metadata && typeof args.answer_metadata === "object" && !Array.isArray(args.answer_metadata)
    ? args.answer_metadata
    : null;
  return questions.map((question) => ({
    question,
    answer,
    ...(metadata ? { metadata } : {}),
  }));
}

function leaseExpiry(seconds = DEFAULT_BRIDGE_LEASE_SECONDS) {
  return new Date(Date.now() + Math.max(1, Number(seconds) || DEFAULT_BRIDGE_LEASE_SECONDS) * 1000).toISOString();
}

function answerText(answer) {
  if (typeof answer === "string") return answer.trim();
  return String(answer?.answer ?? "").trim();
}

function latestAnswerText(answers = []) {
  for (let index = answers.length - 1; index >= 0; index--) {
    const text = answerText(answers[index]);
    if (text && text.toLowerCase() !== "(skipped)") return text;
  }
  return "";
}

/**
 * Undo a bridge claim that never reached a settled outcome. Guarded on our
 * own token and the still-parked status so the normal resolution paths
 * (which release the lease themselves with a terminal status) are never
 * clobbered. Without this, a throw between claim and resolution leaves the
 * gate lease held for the full 300s and every retry acks job_not_claimable.
 */
function releaseBridgeClaim(jobId, leaseToken) {
  try {
    getDb().prepare(`
      UPDATE jobs
      SET lease_owner = NULL,
          lease_token = NULL,
          lease_expires_at = NULL,
          updated_at = ?,
          state_version = state_version + 1
      WHERE id = ?
        AND lease_token = ?
        AND status = 'waiting_on_human'
    `).run(now(), jobId, leaseToken);
  } catch {
    // Best-effort: the lease self-expires in 300s either way.
  }
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
        updated_at = ?,
        state_version = state_version + 1
    WHERE id = ?
      AND job_type = 'human_input'
      AND status IN ('queued', 'waiting_on_human')
      AND (
        lease_token IS NULL
        OR lease_expires_at IS NULL
        OR julianday(lease_expires_at) IS NULL
        OR julianday(lease_expires_at) < julianday(?)
      )
      AND EXISTS (
        SELECT 1 FROM human_gates hg
        WHERE hg.gate_job_id = jobs.id AND hg.gate_state = 'open'
      )
  `).run(owner, leaseToken, expires, ts, jobId, ts);
  if (result.changes === 0) return null;
  return { leaseToken, job: getJob(jobId) };
}

export async function answerHumanInput(jobId, args = {}, {
  projectDir = process.cwd(),
  allowReviewGateAnswer = false,
  allowChoiceFeedback = false,
} = {}) {
  const id = Number(jobId ?? args.job_id ?? args.jobId);
  if (!Number.isInteger(id) || id <= 0) return { ok: false, reason: "invalid_job_id" };

  const current = getJob(id);
  if (!current) return { ok: false, reason: "no_such_job" };
  if (current.job_type !== "human_input") return { ok: false, reason: "not_human_input" };

  const payload = parseJobPayload(current);
  const contract = getHumanGate(id);
  if (contract?.gate_state === "resolved") {
    return {
      ok: false,
      reason: "gate_already_resolved",
      job_id: id,
      status: current.status,
      gate_state: contract.gate_state,
      work_item_id: current.work_item_id,
    };
  }
  if (contract?.gate_state === "superseded") {
    return {
      ok: false,
      reason: "gate_no_longer_applicable",
      job_id: id,
      status: current.status,
      gate_state: contract.gate_state,
      work_item_id: current.work_item_id,
    };
  }
  if (
    args.gate_generation != null
    && Number(args.gate_generation) !== Number(contract?.generation || 1)
  ) {
    return { ok: false, reason: "stale_gate_generation" };
  }
  if (
    args.original_job_id != null
    && Number(args.original_job_id) !== Number(contract?.original_job_id)
  ) {
    return { ok: false, reason: "original_job_mismatch" };
  }
  if (payload?.subtype === "plan_approval") {
    return { ok: false, reason: "use_plan_approve_or_reject" };
  }
  if (payload?.subtype === "push_offer") {
    return { ok: false, reason: "use_git_push" };
  }
  const choices = humanInputChoicesForPayload(payload);
  if (!allowReviewGateAnswer && isReviewGateJob(current, payload) && choices.length === 0) {
    return { ok: false, reason: "use_review_approve_or_reject" };
  }
  const questions = Array.isArray(payload?.questions) && payload.questions.length > 0
    ? payload.questions
    : [`Human input needed for: ${current.title}`];
  const answers = normalizeAnswers(questions, args);
  if (answers.length === 0 || answers.every((answer) => String(answer?.answer ?? answer ?? "").trim() === "")) {
    return { ok: false, reason: "empty_answer" };
  }
  const selectedChoice = allowChoiceFeedback
    ? humanInputChoiceFromAnswer(latestAnswerText(answers), choices)
    : exactHumanInputChoiceFromAnswer(latestAnswerText(answers), choices);
  if (choices.length > 0 && !selectedChoice) {
    return {
      ok: false,
      reason: "invalid_choice",
      choices,
      message: `Answer must select one of: ${choices.join(", ")}`,
    };
  }

  const claim = claimHumanInputJob(id, { leaseSeconds: args.lease_seconds });
  if (!claim) {
    const fresh = getJob(id);
    const freshContract = getHumanGate(id);
    if (fresh?.status === "waiting_on_human" && jobHasLiveLeaseAt(fresh, now())) {
      const generation = String(freshContract?.generation || 1);
      const projected = projectWorkItemInteractions({ work_item_id: fresh.work_item_id || current.work_item_id });
      const question = projected.questions.find((entry) => entry.question_id === `gate:${id}:0`);
      const structuredChoices = new Set((question?.choices || []).map((choice) => choice.choice_id));
      const requestedChoice = selectedChoice || latestAnswerText(answers);
      const choiceId = structuredChoices.has(requestedChoice)
        ? requestedChoice
        : (STRUCTURED_CHOICE_ALIASES[requestedChoice] || []).find((choice) => structuredChoices.has(choice))
          || requestedChoice;
      const actionId = String(args.action_id || `gate-answer:${crypto.createHash("sha256")
        .update(`${id}:${generation}:${choiceId}`)
        .digest("hex")}`);
      const reserved = await answerWorkItemQuestionChoice({
        action_id: actionId,
        work_item_id: String(fresh.work_item_id || current.work_item_id),
        job_id: String(id),
        question_id: `gate:${id}:0`,
        question_generation: generation,
        choice_id: choiceId,
        source: args.source || "terminal",
        author: args.author || "operator",
      }, {
        // The live-owner branch returns before executing this callback. If the
        // lease disappears during validation, fail closed instead of claiming
        // or resolving from the secondary process.
        executeTransition: async () => ({ ok: false, reason: "owner_lease_changed" }),
      });
      if (reserved.outcome === "pending" || reserved.outcome === "accepted") {
        return {
          ok: true,
          pending: reserved.outcome === "pending",
          reason: reserved.safe_reason || null,
          message: reserved.outcome === "pending"
            ? "Answer reserved for the active run; the owning worker will apply it."
            : "The owning run already applied this answer.",
          retryable: reserved.retryable === true,
          action_id: actionId,
          job_id: id,
          status: fresh.status,
          gate_state: freshContract?.gate_state || "unknown",
          work_item_id: fresh.work_item_id || current.work_item_id,
        };
      }
      return {
        ok: false,
        reason: reserved.safe_reason || reserved.outcome || "answer_reservation_failed",
        message: "The active run could not reserve this answer.",
        retryable: reserved.outcome === "stale_generation",
        job_id: id,
        status: fresh.status,
        gate_state: freshContract?.gate_state || "unknown",
        work_item_id: fresh.work_item_id || current.work_item_id,
      };
    }
    return {
      ok: false,
      reason: "job_not_claimable",
      job_id: id,
      status: fresh?.status || "unknown",
      gate_state: freshContract?.gate_state || "unknown",
      work_item_id: fresh?.work_item_id || current.work_item_id,
    };
  }

  const display = {
    askQuestions: async () => answers,
    workerLine: () => {},
    addEvent: () => {},
    requestRender: () => {},
    setRunPhase: () => {},
  };
  try {
    const worker = new Worker({
      projectDir,
      display,
      silent: true,
      autoApprove: false,
    });
    await runHumanInputJob(worker, claim.job, { leaseToken: claim.leaseToken });
  } catch (err) {
    releaseBridgeClaim(id, claim.leaseToken);
    throw err;
  }

  const fresh = getJob(id);
  const freshContract = getHumanGate(id);
  const resolved = fresh?.status === "succeeded" && freshContract?.gate_state === "resolved";
  if (!resolved) {
    // If the job is still parked with our claim (attempt refused, answer not
    // applied), free the lease so the operator's retry isn't locked out for
    // the remaining lease window.
    releaseBridgeClaim(id, claim.leaseToken);
    const status = fresh?.status || "unknown";
    const reason = status === "canceled"
      ? "gate_no_longer_applicable"
      : status === "failed" || status === "dead_letter"
        ? "resolution_failed"
        : "answer_not_applied";
    return {
      ok: false,
      reason,
      job_id: id,
      status,
      gate_state: freshContract?.gate_state || "unknown",
      work_item_id: fresh?.work_item_id || current.work_item_id,
    };
  }
  return {
    ok: true,
    job_id: id,
    status: fresh?.status || "unknown",
    work_item_id: fresh?.work_item_id || current.work_item_id,
  };
}
