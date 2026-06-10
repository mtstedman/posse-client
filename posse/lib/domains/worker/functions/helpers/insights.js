// lib/worker/helpers/insights.js
//
// Insight extraction helpers that summarize failed work items into reusable
// root-cause and kaizen records after terminal transitions.

import {
  getWorkItem,
  refreshWorkItemStatus,
  listJobsByWorkItem,
  getEventsByWorkItem,
  getAttempts,
  storeInsight,
} from "../../../queue/functions/index.js";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";
import { createEnrichmentCache, triggerInsightPromotion } from "./insight-promotion.js";

function _safeParseJson(str) {
  if (!str) return null;
  try { return JSON.parse(str); } catch { return null; }
}

function _rootCause(failedAttempts, assessorReasons) {
  if (assessorReasons.length > 0) return assessorReasons[0].slice(0, 80);
  if (failedAttempts.length > 0) {
    const lastErr = failedAttempts[failedAttempts.length - 1]?.error_text || "";
    return lastErr.split("\n")[0]?.slice(0, 80) || "unknown error";
  }
  return "unknown cause";
}

function _classifyInsight({ job, reasons = [], errors = [], structural = false }) {
  const evidenceHead = _evidenceLines([...reasons, ...errors], 1)[0] || job?.last_error || job?.title || "the recorded blocker";
  const text = [
    job?.title,
    job?.last_error,
    ...reasons,
    ...errors,
  ].filter(Boolean).join(" ").toLowerCase();

  if (/scope|out.of.scope|file_request|missing_context|adjacent|outside/.test(text)) {
    return {
      kind: "risk",
      action: `Before editing beyond declared scope, request exact missing paths; prior evidence: ${String(evidenceHead).slice(0, 180)}`,
      confidence: structural ? "high" : "medium",
    };
  }
  if (/test|assert|snapshot|fixture|aggregate|core\.test|quick/.test(text)) {
    return {
      kind: "test_coupling",
      action: "Before finishing changes touching these files, check for coupled tests, fixtures, or aggregate test copies that need matching updates.",
      confidence: "medium",
    };
  }
  if (/config|dependency|module not found|enoent|missing dependency|cannot find/.test(text)) {
    return {
      kind: "dependency",
      action: "Verify the expected dependency, config, or generated file exists before retrying; repeated identical failures usually need environment or scope correction.",
      confidence: structural ? "high" : "medium",
    };
  }
  return {
    kind: structural ? "risk" : "convention",
    action: structural
      ? `Investigate the repeated structural blocker before retrying; prior evidence: ${String(evidenceHead).slice(0, 180)}`
      : `Reuse only the concrete part of this prior path when the same scope appears; prior evidence: ${String(evidenceHead).slice(0, 180)}`,
    confidence: structural ? "high" : "low",
  };
}

function _evidenceLines(lines, max = 4) {
  return lines
    .filter(Boolean)
    .map((line) => String(line).replace(/\s+/g, " ").trim())
    .filter(Boolean)
    .slice(0, max);
}

function _hasCleanSuccessSignal(payload = {}, filePaths = []) {
  if (filePaths.length === 0) return false;
  const criteria = Array.isArray(payload?.success_criteria)
    ? payload.success_criteria.join(" ")
    : String(payload?.success_criteria || "");
  const task = [
    payload?.task_spec,
    payload?.instructions,
    payload?.test_command,
    criteria,
  ].filter(Boolean).join(" ");
  return /\b(test|verify|migration|schema|deterministic|boundary|integration|contract|symbol|scope|sequence|split)\b/i.test(task);
}

function _storeAndPromote(insight, { job, payload, attempts = [], verdicts = [], workItemStatus = null, enrichmentCache = null } = {}) {
  const id = storeInsight(insight);
  if (!id) return null;
  const row = { ...insight, id };
  triggerInsightPromotion({
    insight: row,
    job,
    payload,
    attempts,
    verdicts,
    workItemStatus,
    cwd: process.cwd(),
    enrichmentCache,
  });
  return id;
}

export function extractWorkItemInsights(workItemId) {
  try {
    const workItemStatus = getWorkItem(workItemId)?.status || null;
    const enrichmentCache = createEnrichmentCache();
    const jobs = listJobsByWorkItem(workItemId);
    const assessEvents = getEventsByWorkItem(workItemId, 500)
      .filter((e) => e.event_type === "job.assessed");
    const verdictsByJob = new Map();
    for (const ev of assessEvents) {
      const parsed = _safeParseJson(ev.event_json);
      if (parsed) {
        if (!verdictsByJob.has(ev.job_id)) verdictsByJob.set(ev.job_id, []);
        verdictsByJob.get(ev.job_id).push(parsed);
      }
    }

    for (const job of jobs) {
      const payload = _safeParseJson(job.payload_json);
      const filePaths = [
        ...(payload?.files_to_modify || []),
        ...(payload?.files_to_create || []),
      ];
      const fps = filePaths.length > 0 ? filePaths : null;
      const verdicts = verdictsByJob.get(job.id) || [];
      const failReasons = verdicts
        .filter((v) => v.verdict === "fail")
        .flatMap((v) => v.reasons || []);

      if (job.status === "succeeded" && job.attempt_count <= 1 && _hasCleanSuccessSignal(payload, filePaths)) {
        const criteria = Array.isArray(payload?.success_criteria)
          ? payload.success_criteria.slice(0, 3).join("; ")
          : String(payload?.success_criteria || "").slice(0, 300);
        const testCommand = payload?.test_command ? `Test command: ${payload.test_command}` : null;
        const detail = [
          testCommand,
          criteria ? `Success criteria: ${criteria}` : null,
          `Scope: ${filePaths.slice(0, 8).join(", ")}`,
        ].filter(Boolean).join("\n");

        _storeAndPromote({
          work_item_id: workItemId,
          job_id: job.id,
          insight_type: "pattern",
          summary: `"${job.title}" completed cleanly with reusable verification or scope signal`,
          detail: detail.slice(0, 1000),
          insight_kind: "success_pattern",
          action: payload?.test_command
            ? `When changing this scope, use the recorded verification path: ${String(payload.test_command).slice(0, 180)}`
            : `When changing this scope, preserve the implementation boundary and verification criteria recorded for this successful WI.`,
          confidence: "medium",
          source: "clean_success",
          evidence: _evidenceLines([testCommand, criteria, `files: ${filePaths.join(", ")}`]),
          file_paths: fps,
        }, { job, payload, attempts: [], verdicts, workItemStatus, enrichmentCache });
      }

      if (job.status === "succeeded" && job.assessor_verdict === "pass" && failReasons.length > 0 && filePaths.length > 0) {
        const concrete = failReasons.find((reason) => /\b(expected|actual|missing|regression|violat|because|must|should|contract|schema|deterministic|dirty|scope)\b/i.test(reason));
        if (concrete) {
          _storeAndPromote({
            work_item_id: workItemId,
            job_id: job.id,
            insight_type: "scope_issue",
            summary: `Assessor concern resolved for "${job.title}" — ${concrete.slice(0, 100)}`,
            detail: `Assessor reason was later resolved: ${failReasons.slice(0, 3).join("; ")}`,
            insight_kind: "assessment_enforcement",
            action: `When touching this scope, verify the assessor concern stays resolved: ${concrete.slice(0, 220)}`,
            confidence: "medium",
            source: "assessor_resolution",
            evidence: _evidenceLines(failReasons),
            file_paths: fps,
          }, { job, payload, attempts: getAttempts(job.id), verdicts, workItemStatus, enrichmentCache });
        }
      }

      if (job.status === "succeeded" && job.attempt_count > 1) {
        const attempts = getAttempts(job.id);
        const failed = attempts.filter((a) => a.status === "failed");
        const succeeded = attempts.find((a) => a.status === "succeeded");
        const errorChain = failed
          .map((a) => `attempt ${a.attempt_number}: ${(a.error_text || "unknown error").split("\n")[0].slice(0, 150)}`)
          .slice(-3);

        let detail = `Error progression:\n${errorChain.join("\n")}`;
        if (failReasons.length > 0) {
          detail += `\nAssessor complaints: ${failReasons.slice(0, 3).join("; ")}`;
        }
        if (succeeded && failed.length > 0) {
          const lastFail = failed[failed.length - 1];
          if (succeeded.model_name !== lastFail.model_name) {
            detail += `\nResolved by escalating from ${lastFail.model_name} to ${succeeded.model_name}`;
          }
        }

        const classified = _classifyInsight({
          job,
          reasons: failReasons,
          errors: errorChain,
          structural: false,
        });

        _storeAndPromote({
          work_item_id: workItemId,
          job_id: job.id,
          insight_type: "pattern",
          summary: `"${job.title}" failed ${failed.length}x before succeeding — ${_rootCause(failed, failReasons)}`,
          detail: detail.slice(0, 1000),
          insight_kind: classified.kind,
          action: classified.action,
          confidence: classified.confidence,
          source: "kaizen",
          evidence: _evidenceLines(errorChain),
          file_paths: fps,
        }, { job, payload, attempts, verdicts, workItemStatus, enrichmentCache });
      }

      if (job.status === "dead_letter") {
        const attempts = getAttempts(job.id);
        const failed = attempts.filter((a) => a.status === "failed");
        const errorChain = failed
          .map((a) => `attempt ${a.attempt_number} (${a.model_name || "default"}): ${(a.error_text || "unknown").split("\n")[0].slice(0, 150)}`)
          .slice(-4);
        const uniqueErrors = new Set(failed.map((a) => (a.error_text || "").split("\n")[0]?.slice(0, 100)));
        const wasStructural = uniqueErrors.size === 1 && failed.length > 1;

        let detail = `Error history:\n${errorChain.join("\n")}`;
        if (failReasons.length > 0) {
          detail += `\nAssessor reasons: ${failReasons.slice(0, 3).join("; ")}`;
        }
        if (wasStructural) {
          detail += `\nAll ${failed.length} attempts hit the same error — this is a structural issue (scope, missing dependency, or config), not a model capability problem.`;
        }

        const classified = _classifyInsight({
          job,
          reasons: failReasons,
          errors: errorChain,
          structural: wasStructural,
        });

        _storeAndPromote({
          work_item_id: workItemId,
          job_id: job.id,
          insight_type: "failure",
          summary: `"${job.title}" dead-lettered — ${wasStructural ? "structural blocker (same error repeated)" : `${uniqueErrors.size} distinct errors across ${failed.length} attempts`}`,
          detail: detail.slice(0, 1000),
          insight_kind: classified.kind,
          action: classified.action,
          confidence: classified.confidence,
          source: wasStructural ? "loopback" : "kaizen",
          evidence: _evidenceLines(errorChain),
          file_paths: fps,
        }, { job, payload, attempts, verdicts, workItemStatus, enrichmentCache });
      }

      if (job.assessor_verdict === "fail" && job.status === "failed") {
        const reasons = failReasons.length > 0
          ? failReasons.slice(0, 5).join("; ")
          : (job.last_error || "no reason recorded").slice(0, 300);

        _storeAndPromote({
          work_item_id: workItemId,
          job_id: job.id,
          insight_type: "scope_issue",
          summary: `Assessor rejected "${job.title}" — ${failReasons[0]?.slice(0, 100) || "see detail"}`,
          detail: `Assessor reasons: ${reasons}`,
          insight_kind: "risk",
          action: `When touching this scope, resolve the concrete assessor concern before retrying: ${reasons.slice(0, 220)}`,
          confidence: "high",
          source: "postmortem",
          evidence: _evidenceLines(failReasons.length > 0 ? failReasons : [job.last_error]),
          file_paths: fps,
        }, { job, payload, attempts: getAttempts(job.id), verdicts, workItemStatus, enrichmentCache });
      }

      if (job.job_type === "human_input" && job.status === "succeeded") {
        const result = _safeParseJson(job.result_json);
        const answers = result?.answers || (result?.answer ? [result.answer] : null);
        if (answers && answers.length > 0) {
          const questions = payload?.questions || [];
          const pairs = questions.map((q, i) =>
            `Q: ${q.slice(0, 200)}\nA: ${(typeof answers[i] === "string" ? answers[i] : JSON.stringify(answers[i] || "")).slice(0, 300)}`
          ).join("\n---\n");

          _storeAndPromote({
            work_item_id: workItemId,
            job_id: job.id,
            insight_type: "human_override",
            summary: `Human guidance on "${job.title}"`,
            detail: (pairs || JSON.stringify(answers).slice(0, 500)).slice(0, 1000),
            insight_kind: "user_preference",
            action: "Follow this human guidance when it applies to the current task or files.",
            confidence: "high",
            source: "human",
            evidence: _evidenceLines([pairs || JSON.stringify(answers).slice(0, 500)]),
            file_paths: fps,
          }, { job, payload, attempts: getAttempts(job.id), verdicts, workItemStatus, enrichmentCache });
        }
      }
    }
  } catch (err) {
    log.warn(`[kaizen] Failed to extract insights for WI#${workItemId}: ${err.message}`);
  }
}

export function refreshAndExtractInsights(workItemId) {
  const previousStatus = getWorkItem(workItemId)?.status || null;
  const refreshedStatus = refreshWorkItemStatus(workItemId);
  const currentStatus = refreshedStatus || getWorkItem(workItemId)?.status || null;
  if ((currentStatus === "complete" || currentStatus === "failed") && currentStatus !== previousStatus) {
    extractWorkItemInsights(workItemId);
  }
}
