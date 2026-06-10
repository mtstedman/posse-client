import fs from "fs";
import path from "path";
import { getDb } from "../../../shared/storage/functions/index.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import { stripAnsi } from "../../../shared/format/functions/ansi.js";
import {
  getAgentCallsByWorkItem,
  getArtifactsByWorkItem,
  getEventsByWorkItem,
  getInsightsByWorkItem,
  listJobsByWorkItem,
  listWorkItems,
} from "../../queue/functions/index.js";
import { parseJobPayload } from "../../queue/functions/payload.js";
import { workItemCost } from "../../billing/functions/cost.js";
import { jobIsBackgroundIndex, jobIsDisplayFailure, jobIsWriteStep, reviewVisibleJobs } from "../../ui/functions/display/helpers/job-status.js";
import { FAILED_JOB_STATUSES } from "../../../catalog/job.js";

export { stripAnsi };

function parseJsonMaybe(value) {
  if (value == null) return null;
  if (typeof value === "object") return value;
  try { return JSON.parse(value); } catch { return null; }
}

function collectSurfacedInsights(events = []) {
  const out = [];
  const seen = new Set();
  for (const event of events) {
    if (event?.event_type !== "kaizen.insights_surfaced") continue;
    const meta = parseJsonMaybe(event.event_json) || {};
    const role = meta.role || null;
    for (const item of Array.isArray(meta.insights) ? meta.insights : []) {
      const key = item.memory_id ? `memory:${item.memory_id}` : `insight:${item.id || item.summary || out.length}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        id: item.id || null,
        memoryId: item.memory_id || null,
        type: item.type || null,
        kind: item.kind || null,
        confidence: item.confidence || null,
        source: item.source || null,
        summary: item.summary || null,
        action: item.action || null,
        whySurfaced: item.why_surface || null,
        stale: !!item.stale,
        usedBy: role ? [role] : [],
        suggestedActions: ["note", "suppress", "correct"],
      });
    }
  }
  return out;
}

function collectProposedMemories(workItemId) {
  try {
    return getInsightsByWorkItem(workItemId, 100)
      .filter((row) => row.memory_type || row.promotion_status || row.promoted_memory_id || row.rejection_reason)
      .map((row) => ({
        insightId: row.id,
        memoryId: row.promoted_memory_id || null,
        type: row.memory_type || null,
        promotionStatus: row.promotion_status || null,
        promotionReason: row.promotion_reason || null,
        rejectionReason: row.rejection_reason || null,
        summary: row.summary,
        action: row.action,
        confidence: row.confidence || null,
        source: row.source || null,
      }));
  } catch {
    return [];
  }
}

function dirtyTreeReview(worktreeStatus = null) {
  if (!worktreeStatus) {
    return {
      status: "unknown",
      blocker: false,
      message: "Dirty tree was not checked for this review.",
      ambiguousFiles: [],
    };
  }
  const targetFiles = Array.isArray(worktreeStatus.targetFiles) ? worktreeStatus.targetFiles : [];
  const wtFiles = Array.isArray(worktreeStatus.wtFiles) ? worktreeStatus.wtFiles : [];
  const ambiguousFiles = [
    ...targetFiles.map((entry) => ({ ...entry, location: "target", reason: "target branch dirty" })),
    ...wtFiles.map((entry) => ({
      ...entry,
      location: "worktree",
      reason: entry.inScope ? "uncommitted in-scope WI work" : entry.untracked ? "untracked WI worktree file" : "out-of-scope WI worktree change",
    })),
  ];
  if (ambiguousFiles.length > 0 || worktreeStatus.targetDirty) {
    return {
      status: "needs_user_resolution",
      blocker: true,
      message: "Working tree has unresolved dirty or untracked files; user direction is required before final approval.",
      ambiguousFiles,
    };
  }
  return {
    status: "clean",
    blocker: false,
    message: "No dirty or untracked files require review.",
    ambiguousFiles: [],
  };
}

export function finalAssessmentFor({ wi, jobs = [], worktreeStatus = null, memoriesSurfaced = [] } = {}) {
  const dirtyTree = dirtyTreeReview(worktreeStatus);
  if (dirtyTree.blocker) {
    return {
      status: "BLOCKED",
      reason: dirtyTree.message,
      dirtyTree,
    };
  }
  const visibleJobs = reviewVisibleJobs(jobs || []);
  const failedJobs = visibleJobs.filter((job) => jobIsDisplayFailure(job, visibleJobs));
  const rawFailedJobs = visibleJobs.filter((job) => FAILED_JOB_STATUSES.includes(job.status));
  if (failedJobs.length > 0 || (wi?.status === "failed" && rawFailedJobs.length === 0)) {
    return {
      status: "FAIL",
      reason: failedJobs.length > 0
        ? `${failedJobs.length} review-visible job(s) failed.`
        : "Work item is marked failed.",
      dirtyTree,
    };
  }
  return {
    status: "PASS",
    reason: "No failed jobs or dirty-tree blockers were detected.",
    dirtyTree,
  };
}

function summarizeJobWriteObservation(row = {}) {
  const detail = parseJsonMaybe(row.detail_json) || {};
  const rawFiles = Array.isArray(detail.files_committed)
    ? detail.files_committed
    : Array.isArray(detail.files)
      ? detail.files
      : Array.isArray(detail.paths)
        ? detail.paths
        : [];
  return {
    summary: row.summary || "",
    commitHash: detail.commit_hash || detail.commitHash || null,
    files: rawFiles.map((file) => String(file || "").replace(/\\/g, "/")).filter(Boolean),
    createdAt: row.created_at || null,
  };
}

function collectWriteObservationsByJob(workItemIds = []) {
  const byJob = new Map();
  const ids = workItemIds.filter((id) => Number.isInteger(id));
  if (ids.length === 0) return byJob;
  try {
    const placeholders = ids.map(() => "?").join(",");
    const rows = getDb().prepare(`
      SELECT job_id, summary, detail_json, created_at
      FROM job_observations
      WHERE work_item_id IN (${placeholders})
        AND observation_type = 'git.commit'
      ORDER BY created_at ASC, id ASC
    `).all(...ids);
    for (const row of rows) {
      const jobId = Number(row.job_id);
      if (!Number.isInteger(jobId)) continue;
      const summary = summarizeJobWriteObservation(row);
      if (!byJob.has(jobId)) {
        byJob.set(jobId, { files: new Set(), commitHashes: [], observations: [] });
      }
      const entry = byJob.get(jobId);
      for (const file of summary.files) entry.files.add(file);
      if (summary.commitHash) entry.commitHashes.push(summary.commitHash);
      entry.observations.push(summary);
    }
  } catch {
    // best effort only
  }
  return byJob;
}

function plainWriteDetail(detail = null) {
  if (!detail) return { files: [], commitHashes: [], observations: [] };
  return {
    files: [...(detail.files || [])],
    commitHashes: [...(detail.commitHashes || [])],
    observations: [...(detail.observations || [])],
  };
}

function summarizeJobStep(job, writeObservationsByJob = new Map()) {
  return {
    id: job.id,
    type: job.job_type,
    title: job.title,
    status: job.status,
    tier: job.model_tier,
    verdict: job.assessor_verdict,
    attempts: job.attempt_count,
    startedAt: job.started_at,
    finishedAt: job.finished_at,
    writes: plainWriteDetail(writeObservationsByJob.get(Number(job.id))),
  };
}

export function saveReport(reportData, { projectDir = process.cwd() } = {}) {
  try {
    const dbPath = getRuntimeDbPath(projectDir);
    const reportsDir = path.resolve(path.dirname(dbPath), "reports");
    if (!fs.existsSync(reportsDir)) fs.mkdirSync(reportsDir, { recursive: true });

    const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
    const reportFile = path.join(reportsDir, `report-${timestamp}.json`);

    const serializable = reportData.map((d) => {
      const visibleJobs = reviewVisibleJobs(d.jobs || []);
      const writeSteps = Array.isArray(d.writeSteps)
        ? d.writeSteps
        : visibleJobs.filter(jobIsWriteStep).map((job) => summarizeJobStep(job));
      const researchSteps = Array.isArray(d.researchSteps)
        ? d.researchSteps
        : visibleJobs.filter((job) => !jobIsWriteStep(job)).map((job) => summarizeJobStep(job));
      return {
        workItem: {
          id: d.wi.id,
          title: d.wi.title,
          status: d.wi.status,
          priority: d.wi.priority,
          branch: d.wi.branch_name,
          mergeState: d.wi.merge_state,
          createdAt: d.wi.created_at,
          completedAt: d.wi.completed_at,
        },
        decision: d._decision || null,
        mergeResult: d._mergeResult ? stripAnsi(d._mergeResult) : null,
        writeSteps,
        researchSteps,
        jobs: visibleJobs.map((j) => ({
          id: j.id,
          type: j.job_type,
          title: j.title,
          status: j.status,
          tier: j.model_tier,
          verdict: j.assessor_verdict,
          attempts: j.attempt_count,
          startedAt: j.started_at,
          finishedAt: j.finished_at,
        })),
        agentCalls: (d.agentCalls || []).map((c) => ({
          role: c.role,
          model: c.model_name || c.model_tier,
          tier: c.model_tier,
          status: c.status,
          durationMs: c.duration_ms,
          inputTokens: c.input_tokens,
          outputTokens: c.output_tokens,
          effort: c.reasoning_effort,
          provider: c.provider,
          costUsd: c.cost_estimate_usd ?? null,
        })),
        totals: {
          durationMs: d.totalDuration,
          inputTokens: d.totalInputTokens,
          outputTokens: d.totalOutputTokens,
          promptChars: d.totalPrompt,
          outputChars: d.totalOutput,
          costUsd: d.totalCostUsd || 0,
          toolCalls: d.totalToolCalls || 0,
        },
        toolUsageSummary: Array.isArray(d.toolUsageSummary) ? d.toolUsageSummary : [],
        finalAssessment: d.finalAssessment || null,
        memoriesSurfaced: d.memoriesSurfaced || [],
        memoriesProposed: d.memoriesProposed || [],
        filesToModify: d.filesToModify || [],
        plannedWriteFiles: d.plannedWriteFiles || [],
        filesActuallyWritten: d.filesActuallyWritten || [],
        gitDiff: (d.gitDiff || []).map((line) => (typeof line === "string" ? stripAnsi(line) : line)),
        researchSummary: d.researchSummary || "",
        worktreeStatus: d.worktreeStatus
          ? {
            wtDir: d.worktreeStatus.wtDir,
            wtExists: d.worktreeStatus.wtExists,
            wtFiles: d.worktreeStatus.wtFiles || [],
            wtStashes: d.worktreeStatus.wtStashes || 0,
            sourceBranch: d.worktreeStatus.sourceBranch || null,
            sourceDir: d.worktreeStatus.sourceDir || null,
            workItemId: d.worktreeStatus.workItemId ?? null,
            targetDir: d.worktreeStatus.targetDir || null,
            targetBranch: d.worktreeStatus.targetBranch,
            targetDirty: d.worktreeStatus.targetDirty,
            targetFiles: d.worktreeStatus.targetFiles || [],
          }
          : null,
      };
    });

    fs.writeFileSync(reportFile, JSON.stringify(serializable, null, 2), "utf-8");
  } catch {
    // Report persistence is best effort and should not block the review flow.
  }
}

export function listReviewableWorkItemsForApproval(isReviewableWorkItem) {
  const predicate = typeof isReviewableWorkItem === "function" ? isReviewableWorkItem : () => true;
  return listWorkItems(["complete", "failed"]).filter(predicate);
}

export function buildReviewReportData(reviewable, {
  projectDir = process.cwd(),
  gitDiffStat = null,
  targetBranch = null,
  worktreeStatusFn = null,
} = {}) {
  const toolUsageByWorkItem = new Map();
  const workItemIds = reviewable.map((wi) => wi.id).filter((id) => Number.isInteger(id));
  const writeObservationsByJob = collectWriteObservationsByJob(workItemIds);
  try {
    if (workItemIds.length > 0) {
      const placeholders = workItemIds.map(() => "?").join(",");
      const rows = getDb().prepare(`
        SELECT work_item_id, observation_type, COUNT(*) as count
        FROM job_observations
        WHERE work_item_id IN (${placeholders})
          AND observation_type LIKE 'tool.%'
        GROUP BY work_item_id, observation_type
        ORDER BY work_item_id ASC, count DESC, observation_type ASC
      `).all(...workItemIds);
      for (const row of rows) {
        const wiId = Number(row.work_item_id);
        if (!toolUsageByWorkItem.has(wiId)) toolUsageByWorkItem.set(wiId, []);
        toolUsageByWorkItem.get(wiId).push({
          type: String(row.observation_type || "tool.unknown").replace(/^tool\./, ""),
          count: Number(row.count) || 0,
        });
      }
    }
  } catch {
    // best effort only
  }

  return reviewable.map((wi) => {
    const jobs = listJobsByWorkItem(wi.id);
    const visibleJobs = jobs.filter((job) => !jobIsBackgroundIndex(job));
    const agentCalls = getAgentCallsByWorkItem(wi.id);
    const totalDuration = agentCalls.reduce((sum, call) => sum + (call.duration_ms || 0), 0);
    const totalPrompt = agentCalls.reduce((sum, call) => sum + (call.prompt_chars || 0), 0);
    const totalOutput = agentCalls.reduce((sum, call) => sum + (call.output_chars || 0), 0);
    const totalInputTokens = agentCalls.reduce((sum, call) => sum + (call.input_tokens || 0), 0);
    const totalOutputTokens = agentCalls.reduce((sum, call) => sum + (call.output_tokens || 0), 0);
    const wiCost = workItemCost(wi.id);
    const totalCostUsd = Number(wiCost?.totalCostUsd ?? 0)
      || agentCalls.reduce((sum, call) => sum + (Number(call.cost_estimate_usd) || 0), 0);
    const toolUsageSummary = toolUsageByWorkItem.get(wi.id) || [];
    const totalToolCalls = toolUsageSummary.reduce((sum, item) => sum + (item.count || 0), 0);

    let gitDiff = [];
    if (wi.branch_name && wi.merge_base_hash && typeof gitDiffStat === "function") {
      gitDiff = gitDiffStat(wi.merge_base_hash, wi.branch_name, projectDir);
    }

    let researchSummary = "";
    try {
      const summaryArtifacts = getArtifactsByWorkItem(wi.id, "summary");
      if (summaryArtifacts.length > 0) {
        researchSummary = summaryArtifacts.map((artifact) => artifact.content_long || "").filter(Boolean).join("\n\n---\n\n");
      }
    } catch {
      // ignore optional summary failures
    }

    let events = [];
    try { events = getEventsByWorkItem(wi.id); } catch { /* ignore */ }

    let reviewArtifacts = [];
    try { reviewArtifacts = getArtifactsByWorkItem(wi.id, "review"); } catch { /* ignore */ }
    let humanAnswers = [];
    try { humanAnswers = getArtifactsByWorkItem(wi.id, "human_answer"); } catch { /* ignore */ }

    const filesToModify = new Set();
    const plannedWriteFiles = new Set();
    const filesActuallyWritten = new Set();
    for (const job of visibleJobs) {
      const payload = parseJobPayload(job);
      if (Array.isArray(payload.files_to_modify)) {
        for (const file of payload.files_to_modify) filesToModify.add(file);
      }
      if (jobIsWriteStep(job)) {
        for (const file of payload.files_to_modify || []) plannedWriteFiles.add(file);
        for (const file of payload.files_to_create || []) plannedWriteFiles.add(file);
        for (const file of payload.files_to_delete || []) plannedWriteFiles.add(file);
        const writeDetail = writeObservationsByJob.get(Number(job.id));
        if (writeDetail) {
          for (const file of writeDetail.files || []) filesActuallyWritten.add(file);
        }
      }
    }
    const writeSteps = visibleJobs
      .filter(jobIsWriteStep)
      .map((job) => summarizeJobStep(job, writeObservationsByJob));
    const researchSteps = visibleJobs
      .filter((job) => !jobIsWriteStep(job))
      .map((job) => summarizeJobStep(job, writeObservationsByJob));

    let worktreeStatus = null;
    if (typeof worktreeStatusFn === "function") {
      try {
        worktreeStatus = worktreeStatusFn({ wi, jobs, projectDir, targetBranch });
      } catch {
        worktreeStatus = null;
      }
    }
    const memoriesSurfaced = collectSurfacedInsights(events);
    const memoriesProposed = collectProposedMemories(wi.id);
    const finalAssessment = finalAssessmentFor({ wi, jobs, worktreeStatus, memoriesSurfaced });

    return {
      wi,
      jobs,
      writeSteps,
      researchSteps,
      agentCalls,
      gitDiff,
      totalDuration,
      totalPrompt,
      totalOutput,
      totalInputTokens,
      totalOutputTokens,
      totalCostUsd,
      toolUsageSummary,
      totalToolCalls,
      researchSummary,
      events,
      reviewArtifacts,
      humanAnswers,
      finalAssessment,
      memoriesSurfaced,
      memoriesProposed,
      filesToModify: [...filesToModify],
      plannedWriteFiles: [...plannedWriteFiles],
      filesActuallyWritten: [...filesActuallyWritten],
      worktreeStatus,
    };
  });
}
