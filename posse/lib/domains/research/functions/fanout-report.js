import { getDb } from "../../../shared/storage/functions/index.js";
import { getResearchFanoutMode } from "./fanout.js";
import { EVENT_TYPES } from "../../../catalog/event.js";

const FANOUT_EVENT_TYPES = [
  EVENT_TYPES.RESEARCH_FANOUT_SKIPPED,
  EVENT_TYPES.RESEARCH_FANOUT_SHADOWED,
  EVENT_TYPES.RESEARCH_FANOUT_STARTED,
  EVENT_TYPES.RESEARCH_FANOUT_CHILD_COMPLETED,
  EVENT_TYPES.RESEARCH_FANOUT_SYNTH_COMPLETED,
];

function safeJson(value, fallback = {}) {
  if (value == null) return fallback;
  if (typeof value === "object") return value;
  try { return JSON.parse(String(value)); } catch { return fallback; }
}

function num(value, fallback = 0) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function pct(part, total) {
  return total > 0 ? part / total : null;
}

function uniqueNumbers(values) {
  return [...new Set((values || [])
    .map((value) => Number(value))
    .filter((value) => Number.isFinite(value) && value > 0))];
}

function normalizeSince(value, now = Date.now()) {
  if (value == null || value === "") return null;
  const raw = String(value).trim();
  const relative = raw.match(/^(\d+(?:\.\d+)?)([smhdw])$/i);
  if (relative) {
    const amount = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    const multipliers = { s: 1000, m: 60_000, h: 3_600_000, d: 86_400_000, w: 7 * 86_400_000 };
    return new Date(now - amount * multipliers[unit]).toISOString();
  }
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null;
}

function sumCallsForJobs(db, jobIds) {
  const ids = uniqueNumbers(jobIds);
  if (ids.length === 0) {
    return { jobIds: [], calls: 0, inputTokens: 0, outputTokens: 0, costUsd: 0, hasCost: false };
  }
  const placeholders = ids.map(() => "?").join(",");
  // Includes all attempt costs for these jobs, including retries and escalations.
  const row = db.prepare(`
    SELECT
      COUNT(*) AS calls,
      COALESCE(SUM(input_tokens), 0) AS input_tokens,
      COALESCE(SUM(output_tokens), 0) AS output_tokens,
      COALESCE(SUM(cost_estimate_usd), 0) AS cost_usd,
      SUM(CASE WHEN cost_estimate_usd IS NOT NULL THEN 1 ELSE 0 END) AS cost_rows
    FROM agent_calls
    WHERE job_id IN (${placeholders})
  `).get(...ids);
  return {
    jobIds: ids,
    calls: num(row?.calls),
    inputTokens: num(row?.input_tokens),
    outputTokens: num(row?.output_tokens),
    costUsd: num(row?.cost_usd),
    hasCost: num(row?.cost_rows) > 0,
  };
}

function emptyWebToolStats(jobIds = []) {
  return {
    jobIds: uniqueNumbers(jobIds),
    fetches: 0,
    searches: 0,
    total: 0,
    uniqueFetchedUrls: 0,
    fetchedUrls: [],
  };
}

function webToolStatsForJobs(db, jobIds) {
  const ids = uniqueNumbers(jobIds);
  if (ids.length === 0) return emptyWebToolStats();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`
    SELECT observation_type, detail_json
    FROM job_observations
    WHERE job_id IN (${placeholders})
      AND observation_type IN ('tool.web_fetch', 'tool.web_search')
  `).all(...ids);
  const urls = new Set();
  let fetches = 0;
  let searches = 0;
  for (const row of rows) {
    if (row.observation_type === "tool.web_fetch") {
      fetches += 1;
      const detail = safeJson(row.detail_json, {});
      const url = String(detail?.url || "").trim();
      if (url) urls.add(url);
    } else if (row.observation_type === "tool.web_search") {
      searches += 1;
    }
  }
  const fetchedUrls = [...urls].sort();
  return {
    jobIds: ids,
    fetches,
    searches,
    total: fetches + searches,
    uniqueFetchedUrls: fetchedUrls.length,
    fetchedUrls,
  };
}

function getJobsByIds(db, jobIds) {
  const ids = uniqueNumbers(jobIds);
  if (ids.length === 0) return new Map();
  const placeholders = ids.map(() => "?").join(",");
  const rows = db.prepare(`SELECT * FROM jobs WHERE id IN (${placeholders})`).all(...ids);
  return new Map(rows.map((row) => [Number(row.id), row]));
}

function planStatsForJob(db, jobId) {
  if (!jobId) return { planCount: 0, firstPlanStatus: null, firstPassPlan: false };
  const plans = db.prepare(`
    SELECT id, status
    FROM jobs
    WHERE parent_job_id = ? AND job_type = 'plan'
    ORDER BY id ASC
  `).all(jobId);
  return {
    planCount: plans.length,
    firstPlanStatus: plans[0]?.status || null,
    firstPassPlan: plans.length > 0 && plans[0].status === "succeeded",
  };
}

function downstreamFixCount(db, workItemId) {
  if (!workItemId) return 0;
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM jobs
    WHERE work_item_id = ? AND job_type = 'fix'
  `).get(workItemId);
  return num(row?.count);
}

function createRun(seed = {}) {
  return {
    fanoutRunId: seed.fanoutRunId || null,
    mode: seed.mode || null,
    source: seed.source || null,
    workItemId: seed.workItemId || null,
    workItemTitle: seed.workItemTitle || null,
    startedAt: seed.startedAt || null,
    completedAt: null,
    status: "pending",
    budget: seed.budget || null,
    synthBudget: seed.synthBudget || null,
    reason: seed.reason || null,
    branches: [],
    childJobIds: [],
    synthJobId: null,
    soloJobId: null,
    childCompleted: 0,
    synthCompleted: false,
    lineRefCount: 0,
    urlCitationCount: 0,
    contradictionSignalCount: 0,
    needsReview: false,
    outputChars: 0,
    liveJobId: null,
    firstPassPlan: false,
    planCount: 0,
    firstPlanStatus: null,
    downstreamFixCount: 0,
    soloCost: null,
    childCost: null,
    synthCost: null,
    fanoutCost: null,
    soloWebTools: null,
    childWebTools: null,
    synthWebTools: null,
    fanoutWebTools: null,
    costRatioVsSolo: null,
  };
}

function mergeRunEvent(run, event, json) {
  run.workItemId ??= event.work_item_id || null;
  run.workItemTitle ??= event.work_item_title || null;
  run.source ??= json.source || null;
  run.mode ??= json.mode || null;
  run.budget ??= json.budget || null;
  run.synthBudget ??= json.synth_budget || null;
  run.reason ??= json.reason || null;
  run.startedAt ??= event.created_at || null;
  if (Array.isArray(json.branches) && json.branches.length > 0) run.branches = json.branches;
  run.childJobIds = uniqueNumbers([...run.childJobIds, ...(json.child_job_ids || [])]);
  run.synthJobId ||= Number(json.synth_job_id) || (event.event_type === "research.fanout_synth_completed" ? event.job_id : null);
  run.soloJobId ||= Number(json.solo_job_id) || null;

  if (event.event_type === "research.fanout_child_completed") {
    run.childCompleted += 1;
  }
  if (event.event_type === "research.fanout_synth_completed") {
    run.synthCompleted = true;
    run.completedAt = event.created_at || run.completedAt;
    run.status = "completed";
    run.lineRefCount = num(json.line_ref_count);
    run.urlCitationCount = num(json.url_citation_count);
    run.contradictionSignalCount = num(json.contradiction_signal_count);
    run.needsReview = json.needs_review === true;
    run.outputChars = num(json.output_chars);
  }
}

export function buildResearchFanoutReport({
  limit = 20,
  minShadowRuns = 5,
  maxNeedsReviewRate = 0.2,
  firstPassPlanSampleMin = 5,
  since = null,
} = {}) {
  const db = getDb();
  const placeholders = FANOUT_EVENT_TYPES.map(() => "?").join(",");
  const sinceIso = normalizeSince(since);
  const where = [`e.event_type IN (${placeholders})`];
  const params = [...FANOUT_EVENT_TYPES];
  if (sinceIso) {
    where.push("e.created_at >= ?");
    params.push(sinceIso);
  }
  const events = db.prepare(`
    SELECT e.*, wi.title AS work_item_title
    FROM events e
    LEFT JOIN work_items wi ON wi.id = e.work_item_id
    WHERE ${where.join(" AND ")}
    ORDER BY e.created_at ASC, e.id ASC
  `).all(...params);

  const skipped = [];
  const runs = new Map();

  for (const event of events) {
    const json = safeJson(event.event_json, {});
    if (event.event_type === "research.fanout_skipped") {
      skipped.push({
        eventId: event.id,
        workItemId: event.work_item_id || null,
        workItemTitle: event.work_item_title || null,
        jobId: event.job_id || null,
        source: json.source || null,
        budget: json.budget || null,
        actualBudget: json.actual_budget || null,
        reason: json.reason || null,
        branchCount: num(json.branch_count, Array.isArray(json.branches) ? json.branches.length : 0),
        createdAt: event.created_at,
      });
      continue;
    }

    const fanoutRunId = json.fanout_run_id || null;
    if (!fanoutRunId) continue;
    if (!runs.has(fanoutRunId)) {
      runs.set(fanoutRunId, createRun({
        fanoutRunId,
        mode: json.mode || null,
        source: json.source || null,
        workItemId: event.work_item_id || null,
        workItemTitle: event.work_item_title || null,
        startedAt: event.created_at || null,
        budget: json.budget || null,
        synthBudget: json.synth_budget || null,
        reason: json.reason || null,
      }));
    }
    mergeRunEvent(runs.get(fanoutRunId), event, json);
  }

  const runRows = [...runs.values()];
  for (const run of runRows) {
    const jobsById = getJobsByIds(db, [run.soloJobId, run.synthJobId, ...run.childJobIds]);
    if (!run.soloJobId) {
      for (const [id, job] of jobsById) {
        const payload = safeJson(job.payload_json, {});
        if (payload?.solo_job_id) run.soloJobId = Number(payload.solo_job_id) || run.soloJobId;
        if (payload?.role_mode === "synth") run.synthJobId = id;
      }
    }
    run.liveJobId = run.mode === "on" ? run.synthJobId : run.soloJobId;
    const planStats = planStatsForJob(db, run.liveJobId);
    run.planCount = planStats.planCount;
    run.firstPlanStatus = planStats.firstPlanStatus;
    run.firstPassPlan = planStats.firstPassPlan;
    run.downstreamFixCount = downstreamFixCount(db, run.workItemId);
    run.soloCost = sumCallsForJobs(db, [run.soloJobId]);
    run.childCost = sumCallsForJobs(db, run.childJobIds);
    run.synthCost = sumCallsForJobs(db, [run.synthJobId]);
    run.fanoutCost = sumCallsForJobs(db, [...run.childJobIds, run.synthJobId]);
    run.soloWebTools = webToolStatsForJobs(db, [run.soloJobId]);
    run.childWebTools = webToolStatsForJobs(db, run.childJobIds);
    run.synthWebTools = webToolStatsForJobs(db, [run.synthJobId]);
    run.fanoutWebTools = webToolStatsForJobs(db, [...run.childJobIds, run.synthJobId]);
    if (run.soloCost.hasCost && run.fanoutCost.hasCost && run.soloCost.costUsd > 0) {
      run.costRatioVsSolo = run.fanoutCost.costUsd / run.soloCost.costUsd;
    }
  }

  const completedRuns = runRows.filter((run) => run.synthCompleted);
  const shadowRuns = runRows.filter((run) => run.mode === "shadow");
  const activeRuns = runRows.filter((run) => run.mode === "on");
  const completedShadowRuns = shadowRuns.filter((run) => run.synthCompleted);
  const needsReviewRuns = completedRuns.filter((run) => run.needsReview);
  const contradictionRuns = completedRuns.filter((run) => run.contradictionSignalCount > 0);
  const lineRefRuns = completedRuns.filter((run) => run.lineRefCount > 0);
  const urlCitationRuns = completedRuns.filter((run) => run.urlCitationCount > 0);
  const comparableShadowRuns = completedShadowRuns.filter((run) => run.costRatioVsSolo != null);
  const soloCostUsd = comparableShadowRuns.reduce((sum, run) => sum + run.soloCost.costUsd, 0);
  const fanoutCostUsd = comparableShadowRuns.reduce((sum, run) => sum + run.fanoutCost.costUsd, 0);
  const childCostUsd = comparableShadowRuns.reduce((sum, run) => sum + run.childCost.costUsd, 0);
  const synthCostUsd = comparableShadowRuns.reduce((sum, run) => sum + run.synthCost.costUsd, 0);
  const fanoutFetchedUrls = new Set();
  let fanoutDuplicateFetchedUrlsWithinRuns = 0;
  for (const run of runRows) {
    for (const url of run.fanoutWebTools?.fetchedUrls || []) fanoutFetchedUrls.add(url);
    const fetches = run.fanoutWebTools?.fetches || 0;
    const uniqueFetchedUrls = run.fanoutWebTools?.uniqueFetchedUrls || 0;
    fanoutDuplicateFetchedUrlsWithinRuns += Math.max(0, fetches - uniqueFetchedUrls);
  }
  const firstPassPlanSample = runRows.filter((run) => run.liveJobId);
  const firstPassPlanRateRaw = pct(firstPassPlanSample.filter((run) => run.firstPassPlan).length, firstPassPlanSample.length);

  const readinessBlockers = [];
  if (completedShadowRuns.length < minShadowRuns) {
    readinessBlockers.push(`need ${minShadowRuns - completedShadowRuns.length} more completed shadow synthesis run(s)`);
  }
  const needsReviewRate = pct(needsReviewRuns.length, completedRuns.length);
  if (needsReviewRate != null && needsReviewRate > maxNeedsReviewRate) {
    readinessBlockers.push(`needs_review rate ${Math.round(needsReviewRate * 100)}% exceeds ${Math.round(maxNeedsReviewRate * 100)}%`);
  }
  if (completedRuns.length > 0 && lineRefRuns.length === 0) {
    readinessBlockers.push("no completed synthesis has line-reference citations yet");
  }

  return {
    generatedAt: new Date().toISOString(),
    currentMode: getResearchFanoutMode(),
    thresholds: {
      minShadowRuns,
      maxNeedsReviewRate,
      firstPassPlanSampleMin,
    },
    since: sinceIso,
    totals: {
      skippedCandidates: skipped.length,
      fanoutRuns: runRows.length,
      shadowRuns: shadowRuns.length,
      activeRuns: activeRuns.length,
      completedSynthRuns: completedRuns.length,
      completedShadowRuns: completedShadowRuns.length,
      childCompleted: runRows.reduce((sum, run) => sum + run.childCompleted, 0),
      needsReviewRuns: needsReviewRuns.length,
      contradictionSignalRuns: contradictionRuns.length,
      lineRefRuns: lineRefRuns.length,
      urlCitationRuns: urlCitationRuns.length,
      lineRefCount: completedRuns.reduce((sum, run) => sum + run.lineRefCount, 0),
      urlCitationCount: completedRuns.reduce((sum, run) => sum + run.urlCitationCount, 0),
      fanoutWebFetchCalls: runRows.reduce((sum, run) => sum + (run.fanoutWebTools?.fetches || 0), 0),
      fanoutWebSearchCalls: runRows.reduce((sum, run) => sum + (run.fanoutWebTools?.searches || 0), 0),
      fanoutWebToolCalls: runRows.reduce((sum, run) => sum + (run.fanoutWebTools?.total || 0), 0),
      fanoutDuplicateFetchedUrlsWithinRuns,
      fanoutUniqueFetchedUrls: fanoutFetchedUrls.size,
      fanoutUniqueFetchedUrlsAcrossRuns: fanoutFetchedUrls.size,
    },
    rates: {
      needsReviewRate,
      contradictionSignalRate: pct(contradictionRuns.length, completedRuns.length),
      lineRefCoverageRate: pct(lineRefRuns.length, completedRuns.length),
      urlCitationCoverageRate: pct(urlCitationRuns.length, completedRuns.length),
      firstPassPlanRate: firstPassPlanSample.length >= firstPassPlanSampleMin ? firstPassPlanRateRaw : null,
      firstPassPlanRateRaw,
      firstPassPlanSampleSize: firstPassPlanSample.length,
      firstPassPlanSampleMin,
    },
    cost: {
      comparableShadowRuns: comparableShadowRuns.length,
      soloCostUsd,
      fanoutCostUsd,
      childCostUsd,
      synthCostUsd,
      ratioVsSolo: soloCostUsd > 0 ? fanoutCostUsd / soloCostUsd : null,
    },
    readiness: {
      defaultOnReady: readinessBlockers.length === 0 && completedRuns.length > 0,
      blockers: readinessBlockers,
    },
    runs: runRows
      .sort((a, b) => String(b.startedAt || "").localeCompare(String(a.startedAt || "")))
      .slice(0, Math.max(1, Number(limit) || 20)),
    skipped: skipped
      .sort((a, b) => String(b.createdAt || "").localeCompare(String(a.createdAt || "")))
      .slice(0, Math.max(1, Number(limit) || 20)),
  };
}
