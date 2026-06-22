import {
  addDependency,
  createJob,
  findStuckFanoutChildren,
  getSetting,
  logEvent,
  runInTransaction,
  storeArtifact,
  updateJobStatus,
} from "../../queue/functions/index.js";
import {
  defaultResearchModelTier,
  isResearchBudgetDeep,
  normalizeResearchBudget,
  researchBudgetToReasoningEffort,
} from "../../../shared/policies/functions/role-utils.js";
import {
  parseFanoutJobPayload,
} from "./fanout-payload.js";
import { countLineRefs, countUrlRefs } from "./line-refs.js";
import { RESEARCH_FANOUT_MODE_VALUES } from "../../settings/functions/catalog.js";
import { EVENT_TYPES, EVENT_ACTORS } from "../../../catalog/event.js";
export {
  isShadowFanoutJob,
  isShadowFanoutPayload,
  parseFanoutJobPayload,
  parseFanoutPayload,
} from "./fanout-payload.js";

const VALID_FANOUT_MODES = new Set(RESEARCH_FANOUT_MODE_VALUES);
const MAX_FANOUT_BRANCHES = 3;
const VALID_BRANCH_KINDS = new Set(["module", "web"]);

// Synthesis hard-deps on every child branch, so a single stuck child blocks
// the entire fanout → planner chain. We periodically expire children that
// have been sitting in `queued` status past the timeout: the child is marked
// succeeded with a synthetic response artifact noting the timeout, which
// satisfies the hard dep and lets synthesis run with the surviving branches.
// Synthesis prompt already covers handling missing/incomplete child briefs.
const DEFAULT_FANOUT_CHILD_TIMEOUT_SEC = 1200; // 20 minutes
const FANOUT_TIMEOUT_SWEEP_INTERVAL_MS = 60 * 1000; // 1 minute
let _lastFanoutTimeoutSweepAt = 0;

export function normalizeResearchFanoutMode(value) {
  const raw = String(value || "").trim().toLowerCase();
  return VALID_FANOUT_MODES.has(raw) ? raw : "off";
}

export function getResearchFanoutMode(_unused = null, { getSettingFn = getSetting } = {}) {
  try {
    return normalizeResearchFanoutMode(getSettingFn?.("research_fanout") || "off");
  } catch {
    return "off";
  }
}

export function normalizeFanoutBranches(branches, { limit = MAX_FANOUT_BRANCHES } = {}) {
  if (!Array.isArray(branches)) return [];
  const normalized = [];
  for (const branch of branches) {
    if (!branch || typeof branch !== "object") continue;
    const label = String(branch.label || "").trim().slice(0, 60);
    const kindRaw = String(branch.kind || "module").trim().toLowerCase();
    const kind = VALID_BRANCH_KINDS.has(kindRaw) ? kindRaw : "module";
    const scopeHints = Array.isArray(branch.scope_hints)
      ? branch.scope_hints
        .map((hint) => String(hint || "").trim().replace(/\\/g, "/"))
        .filter(Boolean)
        .slice(0, 8)
      : [];
    if (!label && scopeHints.length === 0) continue;
    normalized.push({
      label: label || `branch-${normalized.length + 1}`,
      kind,
      scope_hints: scopeHints,
    });
    if (normalized.length >= limit) break;
  }
  return normalized;
}

function createFanoutRunId() {
  return `fanout-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function shortWorkItemTitle(workItem, fallback = null) {
  return String(workItem?.title || fallback || `WI#${workItem?.id || "?"}`).slice(0, 60);
}

function fanoutPayload(base, budget) {
  return {
    ...base,
    deepthink_budget: budget,
    deepthink: isResearchBudgetDeep(budget),
  };
}

export function synthBudgetForResearchFanout(budget, branches = []) {
  const normalized = normalizeResearchBudget(budget, "normal");
  if (!Array.isArray(branches) || branches.length < 3) return normalized;
  if (normalized === "low") return "normal";
  if (normalized === "normal") return "high";
  return normalized;
}

function synthReasoningFallback(synthBudget) {
  return synthBudget === "normal" ? "medium" : "high";
}

export function logFanoutSkipped({
  workItem,
  job,
  routing = null,
  source = null,
  actorType = "system",
  actualBudget = null,
  preflightJobId = null,
} = {}) {
  if (!workItem?.id || !job?.id) return;
  const branches = normalizeFanoutBranches(routing?.branches || []);
  try {
    logEvent({
      work_item_id: workItem.id,
      job_id: job.id,
      event_type: EVENT_TYPES.RESEARCH_FANOUT_SKIPPED,
      actor_type: actorType,
      message: `Fanout candidate kept on single researcher: ${routing?.reason || "fanout deferred"}`,
      event_json: {
        version: 1,
        source,
        bucket: "fanout_clear",
        budget: normalizeResearchBudget(routing?.budget, "normal"),
        actual_budget: actualBudget || null,
        reason: routing?.reason || null,
        branches,
        branch_count: branches.length,
        execution: "single_researcher",
        preflight_job_id: preflightJobId || null,
      },
    });
  } catch {
    // Telemetry must not block job creation.
  }
}

export function createResearchFanoutJobs({
  workItem,
  parentJob = null,
  branches,
  budget = "normal",
  source = null,
  reason = null,
  mode = "shadow",
  soloJob = null,
  actorType = "system",
  preflightJobId = null,
  extraPayload = {},
} = {}) {
  const fanoutMode = normalizeResearchFanoutMode(mode);
  if (fanoutMode === "off") return null;

  const normalizedBranches = normalizeFanoutBranches(branches);
  if (!workItem?.id || normalizedBranches.length === 0) return null;

  const researchBudget = normalizeResearchBudget(budget, "normal");
  const synthBudget = synthBudgetForResearchFanout(researchBudget, normalizedBranches);
  const fanoutRunId = createFanoutRunId();
  const wiTitle = shortWorkItemTitle(workItem, parentJob?.title?.replace(/^Preflight:\s*/i, ""));
  const shadow = fanoutMode === "shadow";
  const inheritedPreflightJobId = preflightJobId || (parentJob?.job_type === "preflight" ? parentJob.id : null);

  const childJobs = normalizedBranches.map((branch, index) => createJob({
    work_item_id: workItem.id,
    job_type: "research",
    title: `Research (${branch.label}): ${wiTitle}`,
    parent_job_id: parentJob?.id || null,
    priority: shadow ? "low" : (workItem.priority || parentJob?.priority || "normal"),
    model_tier: defaultResearchModelTier(),
    reasoning_effort: researchBudgetToReasoningEffort(researchBudget, "medium"),
    payload_json: JSON.stringify(fanoutPayload({
      ...extraPayload,
      role_mode: "child",
      fanout_mode: fanoutMode,
      fanout_shadow: shadow,
      fanout_run_id: fanoutRunId,
      fanout_source: source,
      fanout_reason: reason || null,
      fanout_branch_index: index,
      fanout_branch: branch,
      fanout_scope_hints: branch.scope_hints,
      preflight_job_id: inheritedPreflightJobId,
      instructions: [
        `Fanout child branch: ${branch.label}`,
        `Branch kind: ${branch.kind}`,
        "",
        branch.kind === "web" ? "Domain/URL hints:" : "Scope hints:",
        ...(branch.scope_hints.length > 0 ? branch.scope_hints.map((hint) => `- ${hint}`) : ["- (none provided)"]),
        "",
        branch.kind === "web"
          ? "Investigate only this external-source branch unless a direct code connection is required to verify a claim."
          : "Investigate only this branch unless a direct dependency is required to verify a claim.",
        branch.kind === "web"
          ? "Emit exact URLs for external-source findings and path:line citations only when you connect the docs back to repository code."
          : "Emit exact file paths and line-number citations for important findings.",
        "Surface uncertainty and contradictions instead of filling gaps with guesses.",
      ].join("\n"),
    }, researchBudget)),
  }));

  const synthJob = createJob({
    work_item_id: workItem.id,
    job_type: "research",
    title: `Research synthesis: ${wiTitle}`,
    parent_job_id: parentJob?.id || null,
    priority: shadow ? "low" : (workItem.priority || parentJob?.priority || "normal"),
    model_tier: defaultResearchModelTier(),
    reasoning_effort: researchBudgetToReasoningEffort(synthBudget, synthReasoningFallback(synthBudget)),
    payload_json: JSON.stringify(fanoutPayload({
      ...extraPayload,
      role_mode: "synth",
      fanout_mode: fanoutMode,
      fanout_shadow: shadow,
      fanout_run_id: fanoutRunId,
      fanout_source: source,
      fanout_reason: reason || null,
      fanout_branches: normalizedBranches,
      child_job_ids: childJobs.map((job) => job.id),
      solo_job_id: soloJob?.id || null,
      preflight_job_id: inheritedPreflightJobId,
      instructions: [
        "Synthesize the child research briefs into one planner-ready research brief.",
        "Compare cited claims across children and preserve code citations and URL citations as distinct evidence classes.",
        "Re-read cited files/lines before relying on a disputed code claim; preserve exact URLs for external documentation claims.",
        "If child briefs contradict each other and the contradiction cannot be resolved, include needs_review with the conflicting evidence.",
      ].join("\n"),
    }, synthBudget)),
  });

  for (const childJob of childJobs) {
    // Fanout synthesis is intentionally all-or-nothing: every branch brief must
    // complete before the planner sees a merged research artifact.
    addDependency(synthJob.id, childJob.id, "hard");
  }

  logEvent({
    work_item_id: workItem.id,
    job_id: synthJob.id,
    event_type: shadow ? EVENT_TYPES.RESEARCH_FANOUT_SHADOWED : EVENT_TYPES.RESEARCH_FANOUT_STARTED,
    actor_type: actorType,
    message: `${shadow ? "Shadow" : "Active"} fanout created ${childJobs.length} child researcher(s) and synthesis #${synthJob.id}`,
    event_json: {
      version: 1,
      mode: fanoutMode,
      source,
      budget: researchBudget,
      synth_budget: synthBudget,
      reason: reason || null,
      fanout_run_id: fanoutRunId,
      branch_count: normalizedBranches.length,
      branches: normalizedBranches,
      child_job_ids: childJobs.map((job) => job.id),
      synth_job_id: synthJob.id,
      solo_job_id: soloJob?.id || null,
      preflight_job_id: inheritedPreflightJobId,
    },
  });

  return {
    mode: fanoutMode,
    shadow,
    fanoutRunId,
    branches: normalizedBranches,
    childJobs,
    synthJob,
    synthBudget,
  };
}

function fanoutOutputMetrics(output) {
  const text = String(output || "");
  const contradictionSignals = (text.match(/\b(contradict|conflict|discrepan|disagree|inconsistent)\w*/gi) || []).length;
  return {
    output_chars: text.length,
    line_ref_count: countLineRefs(text),
    url_citation_count: countUrlRefs(text),
    contradiction_signal_count: contradictionSignals,
    needs_review: /\bneeds[_\s-]?review\b/i.test(text),
  };
}

export function logFanoutChildCompleted(job, output, payload = parseFanoutJobPayload(job)) {
  try {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.RESEARCH_FANOUT_CHILD_COMPLETED,
      actor_type: EVENT_ACTORS.RESEARCHER,
      message: `Fanout child completed: ${payload?.fanout_branch?.label || `branch-${payload?.fanout_branch_index ?? "?"}`}`,
      event_json: {
        version: 1,
        mode: payload?.fanout_mode || null,
        shadow: payload?.fanout_shadow === true,
        fanout_run_id: payload?.fanout_run_id || null,
        branch: payload?.fanout_branch || null,
        ...fanoutOutputMetrics(output),
      },
    });
  } catch {
    // Best-effort metrics only.
  }
}

export function getFanoutChildTimeoutSec({ getSettingFn = getSetting } = {}) {
  try {
    const raw = getSettingFn?.("posse_fanout_child_timeout_sec");
    if (raw != null && String(raw).trim() !== "") {
      const parsed = Number.parseInt(String(raw).trim(), 10);
      if (Number.isFinite(parsed) && parsed > 0) return parsed;
    }
  } catch {
    // Settings unavailable; fall through to default.
  }
  return DEFAULT_FANOUT_CHILD_TIMEOUT_SEC;
}

export function expireStuckFanoutChildren({ timeoutSec, nowMs = Date.now() } = {}) {
  const effectiveTimeout = Number.isFinite(timeoutSec) && timeoutSec > 0
    ? timeoutSec
    : getFanoutChildTimeoutSec();
  const cutoffIso = new Date(nowMs - effectiveTimeout * 1000).toISOString();
  const stuck = findStuckFanoutChildren(cutoffIso);
  if (stuck.length === 0) return { expired: 0, ids: [] };

  const expired = [];
  for (const row of stuck) {
    const payload = parseFanoutJobPayload(row) || {};
    const label = payload?.fanout_branch?.label
      || (payload?.fanout_branch_index != null ? `branch-${payload.fanout_branch_index}` : "branch");
    const fanoutRunId = payload?.fanout_run_id || null;
    try {
      runInTransaction(() => {
        storeArtifact({
          work_item_id: row.work_item_id,
          job_id: row.id,
          artifact_type: "response",
          content_long: `[Fanout child branch "${label}" timed out after ${effectiveTimeout}s before producing any findings. Synthesis is proceeding without this branch.]`,
        });
        updateJobStatus(row.id, "succeeded");
        logEvent({
          work_item_id: row.work_item_id,
          job_id: row.id,
          event_type: EVENT_TYPES.RESEARCH_FANOUT_CHILD_TIMED_OUT,
          actor_type: EVENT_ACTORS.SCHEDULER,
          message: `Fanout child "${label}" timed out after ${effectiveTimeout}s; marked succeeded so synthesis can proceed`,
          event_json: {
            version: 1,
            fanout_run_id: fanoutRunId,
            branch: payload?.fanout_branch || null,
            branch_index: payload?.fanout_branch_index ?? null,
            timeout_sec: effectiveTimeout,
          },
        });
      });
      expired.push(row.id);
    } catch {
      // Best-effort: a single child failure should not abort the sweep.
    }
  }
  return { expired: expired.length, ids: expired };
}

export function maybeExpireStuckFanoutChildren({
  nowMs = Date.now(),
  intervalMs = FANOUT_TIMEOUT_SWEEP_INTERVAL_MS,
  force = false,
} = {}) {
  if (!force && _lastFanoutTimeoutSweepAt > 0 && nowMs - _lastFanoutTimeoutSweepAt < intervalMs) {
    return { attempted: false, skipped: "interval" };
  }
  _lastFanoutTimeoutSweepAt = nowMs;
  try {
    const result = expireStuckFanoutChildren({ nowMs });
    return { attempted: true, ok: true, ...result };
  } catch (err) {
    return { attempted: true, ok: false, error: String(err?.message || err || "fanout sweep failed") };
  }
}

export function __resetFanoutTimeoutSweepForTests() {
  _lastFanoutTimeoutSweepAt = 0;
}

export function logFanoutSynthesisCompleted(job, output, payload = parseFanoutJobPayload(job)) {
  try {
    logEvent({
      work_item_id: job.work_item_id,
      job_id: job.id,
      event_type: EVENT_TYPES.RESEARCH_FANOUT_SYNTH_COMPLETED,
      actor_type: EVENT_ACTORS.RESEARCHER,
      message: `${payload?.fanout_shadow === true ? "Shadow" : "Active"} fanout synthesis completed`,
      event_json: {
        version: 1,
        mode: payload?.fanout_mode || null,
        shadow: payload?.fanout_shadow === true,
        fanout_run_id: payload?.fanout_run_id || null,
        child_job_ids: Array.isArray(payload?.child_job_ids) ? payload.child_job_ids : [],
        solo_job_id: payload?.solo_job_id || null,
        ...fanoutOutputMetrics(output),
      },
    });
  } catch {
    // Best-effort metrics only.
  }
}
