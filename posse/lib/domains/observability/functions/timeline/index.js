// lib/timeline.js
//
// Builds a consolidated timeline for a work item: the research brief, the
// plan, every dev/fix/assess/etc. job with its attempts, the agent calls made
// per attempt, assessor verdicts, scope violations, and WI-level events. This
// is read-only: it queries the same tables already written by worker.js and
// the roles, and does not mutate state.
//
// Returned shape is stable-ish — callers include the CLI renderer and the
// admin TUI. Consumers wanting machine-readable output use `--json` which
// emits this structure verbatim.

import {
  getWorkItem,
  listJobsByWorkItem,
  getAttempts,
  getEventsByWorkItem,
  getAgentCallsByWorkItem,
  getDependencies,
} from "../../../queue/functions/index.js";
import { estimateCallCost } from "../../../billing/functions/pricing.js";

function safeJson(value, fallback = null) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

function parseIso(ts) {
  if (!ts) return null;
  const ms = Date.parse(String(ts));
  return Number.isFinite(ms) ? ms : null;
}

function durationMs(startTs, endTs) {
  const start = parseIso(startTs);
  const end = parseIso(endTs);
  if (start == null || end == null) return null;
  return Math.max(0, end - start);
}

function sumTokens(calls, field) {
  let total = 0;
  let seen = false;
  for (const call of calls) {
    const value = Number(call?.[field]);
    if (Number.isFinite(value) && value > 0) {
      total += value;
      seen = true;
    }
  }
  return seen ? total : null;
}

function indexBy(rows, keyField) {
  const out = new Map();
  for (const row of rows) {
    const key = row?.[keyField];
    if (key == null) continue;
    if (!out.has(key)) out.set(key, []);
    out.get(key).push(row);
  }
  return out;
}

function depsForJob(jobId) {
  // getDependencies returns the rows this job depends ON.
  return (getDependencies(jobId) || []).map((row) => ({
    jobId: Number(row.depends_on_job_id ?? row.job_id),
    kind: row.dependency_kind || "hard",
  }));
}

/**
 * Build a structured timeline for a work item.
 *
 * @param {number} wiId - work item id
 * @param {object} opts
 * @param {number|null} opts.eventLimit - cap on WI event rows (default 500; null = no cap)
 * @returns {object|null} timeline data, or null if the WI doesn't exist
 */
export function buildTimeline(wiId, { eventLimit = 500 } = {}) {
  const wi = getWorkItem(wiId);
  if (!wi) return null;

  const jobs = listJobsByWorkItem(wiId) || [];
  const allEvents = getEventsByWorkItem(wiId, eventLimit == null ? 100000 : eventLimit) || [];
  const allAgentCalls = getAgentCallsByWorkItem(wiId) || [];

  const eventsByJob = indexBy(allEvents, "job_id");
  const agentCallsByAttempt = indexBy(allAgentCalls, "attempt_id");
  const agentCallsByJob = indexBy(allAgentCalls, "job_id");

  // Build a dependents index by reading each job's own dependency rows once;
  // avoids a separate SELECT across the whole table.
  const dependentsByJob = new Map();
  const depsByJob = new Map();
  for (const job of jobs) {
    const rows = depsForJob(job.id);
    depsByJob.set(job.id, rows);
    for (const dep of rows) {
      if (!dependentsByJob.has(dep.jobId)) dependentsByJob.set(dep.jobId, []);
      dependentsByJob.get(dep.jobId).push({ jobId: job.id, kind: dep.kind });
    }
  }

  const jobNodes = [];
  let totalInput = 0;
  let totalOutput = 0;
  let totalCost = 0;
  let totalAttempts = 0;
  const statusCounts = {};

  for (const job of jobs) {
    statusCounts[job.status] = (statusCounts[job.status] || 0) + 1;

    const attempts = getAttempts(job.id) || [];
    totalAttempts += attempts.length;

    const attemptNodes = attempts.map((attempt) => {
      const calls = agentCallsByAttempt.get(attempt.id) || [];
      const attemptInput = sumTokens(calls, "input_tokens") || 0;
      const attemptOutput = sumTokens(calls, "output_tokens") || 0;
      let attemptCost = 0;
      let sawCost = false;
      // Use the provider-reported cost when present; otherwise estimate from
      // tokens × pricing. This way callers that never got a cost_estimate_usd
      // written (older rows, providers that don't report) still see cost.
      for (const call of calls) {
        const est = estimateCallCost({
          provider: call.provider,
          modelName: call.model_name,
          modelTier: call.model_tier,
          inputTokens: call.input_tokens,
          outputTokens: call.output_tokens,
          cachedInputTokens: call.cached_input_tokens,
          cacheCreationInputTokens: call.cache_creation_input_tokens,
          knownCostUsd: call.cost_estimate_usd,
        });
        if (Number.isFinite(est.costUsd) && est.costUsd > 0) {
          attemptCost += est.costUsd;
          sawCost = true;
          call._resolvedCostUsd = est.costUsd;
          call._costSource = est.source;
        }
      }
      totalInput += attemptInput;
      totalOutput += attemptOutput;
      if (sawCost) totalCost += attemptCost;

      return {
        id: attempt.id,
        attemptNumber: attempt.attempt_number,
        workerType: attempt.worker_type,
        modelName: attempt.model_name,
        status: attempt.status,
        startedAt: attempt.started_at,
        finishedAt: attempt.finished_at,
        durationMs: attempt.duration_ms ?? durationMs(attempt.started_at, attempt.finished_at),
        promptChars: attempt.prompt_chars,
        outputChars: attempt.output_chars,
        inputTokens: attemptInput || null,
        outputTokens: attemptOutput || null,
        costUsd: sawCost ? attemptCost : null,
        commitHash: attempt.commit_hash,
        errorText: attempt.error_text,
        notes: attempt.notes,
        agentCalls: calls.map((call) => ({
          id: call.id,
          role: call.role,
          provider: call.provider,
          modelTier: call.model_tier,
          modelName: call.model_name,
          activity: call.activity,
          status: call.status,
          exitCode: call.exit_code,
          durationMs: call.duration_ms,
          inputTokens: call.input_tokens,
          outputTokens: call.output_tokens,
          // costUsd reflects whatever was known at query time: either the
          // provider-reported cost_estimate_usd or the tokens × rate estimate.
          costUsd: call._resolvedCostUsd ?? call.cost_estimate_usd ?? null,
          costSource: call._costSource || (call.cost_estimate_usd != null ? "known" : null),
          atlasMethod: call.atlas_method,
          errorText: call.error_text,
          startedAt: call.started_at,
          finishedAt: call.finished_at,
        })),
      };
    });

    // Events with job_id set — scoped to this job.
    const jobEvents = (eventsByJob.get(job.id) || []).map((ev) => ({
      id: ev.id,
      eventType: ev.event_type,
      actorType: ev.actor_type,
      message: ev.message,
      eventJson: safeJson(ev.event_json, null),
      createdAt: ev.created_at,
    }));

    // Agent calls whose attempt_id is null (in practice this is the common
    // case — the provider adapters don't always stamp attempt_id on the row)
    // or stale (no matching attempt row for this job, e.g. pruned attempts)
    // should still show up under their parent job and contribute to totals.
    // Checking against agentCallsByAttempt here would be a self-lookup that
    // is always true, silently dropping stale-attempt calls from cost totals.
    const jobAttemptIds = new Set(attempts.map((attempt) => attempt.id));
    const orphanCalls = (agentCallsByJob.get(job.id) || [])
      .filter((call) => call.attempt_id == null || !jobAttemptIds.has(call.attempt_id));
    for (const call of orphanCalls) {
      const est = estimateCallCost({
        provider: call.provider,
        modelName: call.model_name,
        modelTier: call.model_tier,
        inputTokens: call.input_tokens,
        outputTokens: call.output_tokens,
        cachedInputTokens: call.cached_input_tokens,
        cacheCreationInputTokens: call.cache_creation_input_tokens,
        knownCostUsd: call.cost_estimate_usd,
      });
      totalInput += Number(call.input_tokens) || 0;
      totalOutput += Number(call.output_tokens) || 0;
      if (Number.isFinite(est.costUsd) && est.costUsd > 0) {
        totalCost += est.costUsd;
        call._resolvedCostUsd = est.costUsd;
        call._costSource = est.source;
      }
    }

    jobNodes.push({
      id: job.id,
      jobType: job.job_type,
      title: job.title,
      status: job.status,
      parentJobId: job.parent_job_id,
      provider: job.provider,
      modelTier: job.model_tier,
      modelName: job.model_name,
      priority: job.priority,
      assessorVerdict: job.assessor_verdict,
      assessorConfidence: job.assessor_confidence,
      attemptCount: job.attempt_count,
      maxAttempts: job.max_attempts,
      queuedAt: job.queued_at,
      startedAt: job.started_at,
      finishedAt: job.finished_at,
      durationMs: durationMs(job.started_at, job.finished_at),
      lastError: job.last_error,
      resultJson: safeJson(job.result_json, null),
      dependsOn: depsByJob.get(job.id) || [],
      dependents: dependentsByJob.get(job.id) || [],
      attempts: attemptNodes,
      events: jobEvents,
      orphanAgentCalls: orphanCalls.map((call) => ({
        id: call.id,
        role: call.role,
        provider: call.provider,
        modelTier: call.model_tier,
        modelName: call.model_name,
        status: call.status,
        durationMs: call.duration_ms,
        inputTokens: call.input_tokens,
        outputTokens: call.output_tokens,
        costUsd: call._resolvedCostUsd ?? call.cost_estimate_usd ?? null,
        costSource: call._costSource || (call.cost_estimate_usd != null ? "known" : null),
        atlasMethod: call.atlas_method,
        errorText: call.error_text,
        createdAt: call.created_at,
      })),
    });
  }

  // WI-level events (no job_id) — covers things like merges, WI status flips,
  // scheduler-level lease reconciliation for this WI.
  const wiEvents = allEvents
    .filter((ev) => ev.job_id == null)
    .map((ev) => ({
      id: ev.id,
      eventType: ev.event_type,
      actorType: ev.actor_type,
      message: ev.message,
      eventJson: safeJson(ev.event_json, null),
      createdAt: ev.created_at,
    }));

  return {
    workItem: {
      id: wi.id,
      title: wi.title,
      description: wi.description,
      status: wi.status,
      mode: wi.mode,
      priority: wi.priority,
      governanceTier: wi.governance_tier,
      branchName: wi.branch_name,
      mergeState: wi.merge_state,
      createdAt: wi.created_at,
      startedAt: wi.started_at,
      completedAt: wi.completed_at,
      durationMs: durationMs(wi.started_at || wi.created_at, wi.completed_at),
    },
    summary: {
      jobCount: jobs.length,
      attemptCount: totalAttempts,
      agentCallCount: allAgentCalls.length,
      eventCount: allEvents.length,
      totalInputTokens: totalInput || null,
      totalOutputTokens: totalOutput || null,
      totalCostUsd: totalCost || null,
      statusCounts,
    },
    jobs: jobNodes,
    wiEvents,
  };
}
