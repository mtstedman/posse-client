// lib/domains/worker/classes/roles/delegate.js
//
// Delegate role handler that assigns providers across queued jobs using
// deterministic routing and provider-capacity context.

import { extractJson } from "../../../../shared/format/functions/json.js";
import {
  applyDelegation,
  getJob,
  getDurationStats,
  getProviderStats,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { getAvailableProviders, getProviderMap } from "../../../providers/functions/provider.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { BaseRole } from "../BaseRole.js";
import {
  buildDeterministicDelegations as defaultBuildDeterministicDelegations,
  delegationRoleForJobType as defaultDelegationRoleForJobType,
  getDelegationMode as defaultGetDelegationMode,
} from "../../../providers/functions/delegation-routing.js";
import { currentExecutionProvider as defaultCurrentExecutionProvider } from "../../functions/helpers/diagnostics.js";
import {
  shortJobTitle as defaultShortJobTitle,
  unwrapAssignmentArray as defaultUnwrapAssignmentArray,
} from "../../../../shared/policies/functions/role-utils.js";
import {
  spawnFailureForRole,
  spawnSuccessForRole,
} from "../../../../shared/policies/functions/spawn-policy.js";

const DEFAULT_DEPS = {
  buildDeterministicDelegations: defaultBuildDeterministicDelegations,
  currentExecutionProvider: defaultCurrentExecutionProvider,
  delegationRoleForJobType: defaultDelegationRoleForJobType,
  getDelegationMode: defaultGetDelegationMode,
  loadNudges: () => "",
  shortJobTitle: defaultShortJobTitle,
  unwrapAssignmentArray: defaultUnwrapAssignmentArray,
};

function parsePayload(context, job) {
  if (typeof context?.parsePayload === "function") return context.parsePayload(job);
  return parseJobPayload(job);
}

function buildStatsSection() {
  let providerStats = { callStats: [], queueDepth: [] };
  let statsSection = "";

  try {
    const pStats = getProviderStats();
    providerStats = pStats;
    const dStats = getDurationStats();
    const { callStats = [], queueDepth = [] } = pStats;
    if (callStats.length > 0 || dStats.length > 0 || queueDepth.length > 0) {
      statsSection = [
        "",
        "PROVIDER PERFORMANCE DATA (from this session):",
        ...callStats.map((stat) => `  ${stat.provider}: ${stat.call_count} calls, ${stat.succeeded} succeeded, ${stat.failed} failed, avg ${Math.round(stat.avg_duration_ms)}ms`),
        "",
        "QUEUE DEPTH:",
        ...queueDepth.map((stat) => `  ${stat.provider} [${stat.status}]: ${stat.count}`),
        "",
        "DURATION BY ROLE/TIER/PROVIDER:",
        ...dStats.map((stat) => `  ${stat.role}/${stat.model_tier}/${stat.provider}: ${stat.sample_count} samples, avg ${stat.avg_ms}ms`),
      ].join("\n");
    }
  } catch {}

  return { providerStats, statsSection };
}

export class DelegateRole extends BaseRole {
  static role = "delegator";
  static spawnsOnSuccess = spawnSuccessForRole("delegator");
  static spawnsOnFailure = spawnFailureForRole("delegator");

  roleDeps() {
    return { ...DEFAULT_DEPS, ...this.deps };
  }

  async assembleContext(job, ctx) {
    const payload = parsePayload(this.context, job);
    const providerMap = payload.provider_map || getProviderMap();
    const pendingJobs = payload.pending_jobs || [];
    const { providerStats, statsSection } = buildStatsSection();
    Object.assign(ctx, { payload, providerMap, pendingJobs, statsSection });

    const { buildDeterministicDelegations, getDelegationMode } = this.roleDeps();
    if (getDelegationMode() === "js") {
      const deterministicAssignments = buildDeterministicDelegations(pendingJobs, {
        providerMap,
        callStats: providerStats.callStats || [],
      });
      if (Array.isArray(deterministicAssignments)) {
        ctx.providerResult = {
          output: JSON.stringify(deterministicAssignments, null, 2),
          skipPromptBuild: true,
          stats: {},
        };
      }
    }

    return [
      "AVAILABLE PROVIDERS PER ROLE:",
      ...Object.entries(ctx.providerMap || {}).map(([role, providers]) => `  ${role}: [${providers.join(", ")}]`),
      ctx.statsSection || "",
      "",
      "PENDING TASKS:",
      JSON.stringify(ctx.pendingJobs || [], null, 2),
    ].join("\n");
  }

  buildContract({ job } = {}) {
    const { loadNudges } = this.roleDeps();
    return [
      "You are a delegator. Assign the optimal provider and model tier to each task.",
      "",
      job ? loadNudges(job.id) : "",
      "IMPORTANT: You may ONLY assign providers from the list above for each role.",
      "Dev and fix jobs use the \"dev\" role providers. Assess jobs use \"assessor\" providers.",
      "",
      "ROUTING RULE: To maintain comparison data, route at least 15-20% of tasks to each",
      "available provider (not 100% to one). Without samples from both providers, there is",
      "no basis for knowing which performs better. Spread tasks - don't converge to one provider.",
    ].filter(Boolean).join("\n");
  }

  buildOpts(job, ctx) {
    const { shortJobTitle } = this.roleDeps();
    return {
      role: this.getRole(),
      allowWrite: false,
      modelTier: ctx.tier,
      reasoningEffort: job.reasoning_effort || "low",
      activity: `delegating: ${shortJobTitle(job).slice(0, 40)}`,
    };
  }

  buildMeta(job, ctx) {
    const { currentExecutionProvider } = this.roleDeps();
    return {
      ...super.buildMeta(job, ctx),
      cwd: this.context?.projectDir || null,
      jobProvider: currentExecutionProvider(job),
      jobModelName: job.model_name || null,
    };
  }

  async processOutput(output, _stats, job) {
    const { unwrapAssignmentArray } = this.roleDeps();
    let assignments = unwrapAssignmentArray(extractJson(output));
    if (!Array.isArray(assignments) && typeof this.context?.repairJson === "function") {
      assignments = unwrapAssignmentArray(await this.context.repairJson(output, "delegator", job));
    }

    if (Array.isArray(assignments)) {
      this.applyProviderAssignments(assignments, job);
    } else {
      this.emit(job.id, `${C.yellow}[delegator] WI#${job.work_item_id} could not parse assignments - delegations not applied, using defaults${C.reset}`);
    }

    return output;
  }

  applyDeterministicAssignments(assignments, job) {
    for (const assignment of assignments) {
      applyDelegation(assignment.job_id, {
        provider: assignment.provider || null,
        model: assignment.model || null,
        model_tier: assignment.model_tier || null,
        reasoning_effort: assignment.reasoning_effort || null,
        priority: assignment.priority || null,
      });

      this.emit(job.id, `${C.magenta}[delegator]${C.reset} job #${assignment.job_id}: ${assignment.provider || "default"}${assignment.model_tier ? `/${assignment.model_tier}` : ""} - ${(assignment.reason || "").slice(0, 60)}`);
    }
  }

  applyProviderAssignments(assignments, job) {
    const { delegationRoleForJobType } = this.roleDeps();
    const devProviders = new Set(getAvailableProviders("dev"));
    const assessProviders = new Set(getAvailableProviders("assessor"));
    const artificerProviders = new Set(getAvailableProviders("artificer"));

    for (const assignment of assignments) {
      if (!assignment.job_id) continue;
      const targetJob = getJob(assignment.job_id);
      if (!targetJob || targetJob.work_item_id !== job.work_item_id) continue;

      const role = delegationRoleForJobType(targetJob.job_type);
      const allowed = role === "assessor"
        ? assessProviders
        : role === "artificer"
          ? artificerProviders
          : devProviders;
      if (assignment.provider && !allowed.has(assignment.provider)) {
        this.emit(job.id, `${C.yellow}[delegator]${C.reset} rejected provider "${assignment.provider}" for job #${assignment.job_id} - not in ${role} providers [${[...allowed].join(",")}]`);
        assignment.provider = null;
      }

      applyDelegation(assignment.job_id, {
        provider: assignment.provider || null,
        model: assignment.model || null,
        model_tier: assignment.model_tier || null,
        reasoning_effort: assignment.reasoning_effort || null,
        priority: assignment.priority || null,
      });

      if (assignment.provider || assignment.model_tier) {
        this.emit(job.id, `${C.magenta}[delegator]${C.reset} job #${assignment.job_id}: ${assignment.provider || "default"}${assignment.model_tier ? `/${assignment.model_tier}` : ""} - ${(assignment.reason || "").slice(0, 60)}`);
      }
    }
  }

  emit(jobId, message) {
    if (typeof this.context?.emit === "function") {
      this.context.emit(jobId, message);
    }
  }
}
