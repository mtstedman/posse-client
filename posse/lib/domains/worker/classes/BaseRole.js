// lib/domains/worker/classes/BaseRole.js
//
// Base class for the incremental role OOP migration. It owns the shared
// provider-call template; role classes own context assembly and output handling.

import { log } from "../../../shared/telemetry/functions/logging/logger.js";

const SLOW_ROLE_PHASE_MS = 1000;
const SLOW_PROVIDER_CALL_MS = 45000;

function dispatchPacketFromContext(ctx = {}) {
  return ctx.packet
    || ctx.researcherPacket
    || ctx.plannerPacket
    || null;
}

function normalizedProviderName(value) {
  return String(value || "").trim().toLowerCase().replaceAll("_", "-");
}

export function projectPromptPacketForProvider(packet, providerName, modelProviderName) {
  const selectedProvider = normalizedProviderName(providerName);
  const sourceProvider = normalizedProviderName(modelProviderName);
  const keepModel = selectedProvider && selectedProvider === sourceProvider;
  if (!packet || typeof packet !== "object" || keepModel || packet.model_name == null) {
    return packet;
  }
  return { ...packet, model_name: null };
}

function providerPromptContext(ctx, providerName, modelProviderName) {
  return {
    ...ctx,
    providerName,
    packet: projectPromptPacketForProvider(ctx.packet, providerName, modelProviderName),
    researcherPacket: projectPromptPacketForProvider(ctx.researcherPacket, providerName, modelProviderName),
    plannerPacket: projectPromptPacketForProvider(ctx.plannerPacket, providerName, modelProviderName),
  };
}

async function timeRolePhase(role, label, job, fn, { warnMs = SLOW_ROLE_PHASE_MS } = {}) {
  const startedAt = Date.now();
  try {
    return await fn();
  } finally {
    const durationMs = Date.now() - startedAt;
    if (durationMs >= warnMs) {
      log.warn("worker", "Role phase was slow", {
        role,
        label,
        durationMs,
        job_id: job?.id ?? null,
        work_item_id: job?.work_item_id ?? null,
      });
    }
  }
}

export class BaseRole {
  static role = null;
  static spawnsOnSuccess = [];
  static spawnsOnFailure = [];

  constructor({ providerClient, context = null, deps = {} } = {}) {
    if (!providerClient || typeof providerClient.call !== "function") {
      throw new Error("BaseRole requires providerClient");
    }
    this.providerClient = providerClient;
    this.context = context;
    this.deps = deps;
  }

  getRole() {
    const role = this.constructor.role;
    if (!role) {
      throw new Error(`${this.constructor.name} must define static role or override getRole()`);
    }
    return role;
  }

  getProviderName(job, ctx = {}) {
    return ctx.providerName ?? job?._executionProvider ?? job?.provider ?? null;
  }

  hasCustomRun() {
    return this.run !== BaseRole.prototype.run;
  }

  async run(job, attemptCtx = {}) {
    const ctx = {
      ...attemptCtx,
      role: attemptCtx.role || this.getRole(),
    };
    ctx.providerName = this.getProviderName(job, ctx);
    const modelProviderName = ctx.providerName;

    let preparedAgent = null;
    try {
      const role = ctx.role || this.getRole();
      const contextText = await timeRolePhase(role, "assembleContext", job, () => this.assembleContext(job, ctx));
      if (typeof job?.setContext === "function") {
        await timeRolePhase(role, "setContext", job, () => job.setContext(contextText));
      }
      if (ctx.providerResult) {
        const { output = "", stats = {} } = ctx.providerResult;
        return await this.processOutput(output, stats, job, ctx);
      }
      const buildPromptForProvider = async (providerName) => {
        const providerCtx = providerPromptContext(ctx, providerName, modelProviderName);
        const contract = await timeRolePhase(role, "buildContract", job, () => this.buildContract({ providerName, job, ctx: providerCtx }));
        return await timeRolePhase(role, "composePrompt", job, () => this.composePrompt({ contextText, contract, job, ctx: providerCtx }));
      };
      let prompt = null;
      const dispatcher = this.context?.agentDispatcher;
      if (dispatcher && typeof dispatcher.createAgent === "function") {
        const packet = dispatchPacketFromContext(ctx);
        const attemptIdentity = ctx.attemptId ?? job?.attempt_id ?? job?.attempt_count ?? "pending";
        const agentKey = `job:${job?.id ?? "none"}:attempt:${attemptIdentity}:role:${role}`;
        preparedAgent = dispatcher.createAgent({
          key: agentKey,
          logicalKey: agentKey,
          role,
          providerName: ctx.providerName,
          reusable: true,
          agentHandoff: packet?.agent_coordination?.agent_handoff_v1 === true,
          subAgent: packet?.agent_coordination?.sub_agent_v1 === true,
          handoffRequest: packet || {
            job_id: job?.id ?? null,
            work_item_id: job?.work_item_id ?? null,
            role,
          },
          handoffFactory: ({ providerName }) => buildPromptForProvider(providerName),
        });
        await preparedAgent.whenReady();
        ctx.providerName = preparedAgent.providerName;
        prompt = preparedAgent.handoff;
      } else {
        prompt = await buildPromptForProvider(ctx.providerName);
      }
      const providerOpts = {
        ...this.buildOpts(job, ctx),
        ...(preparedAgent ? { _preparedAgent: preparedAgent } : {}),
      };
      if (
        providerOpts?.role === "dev"
        && ((providerOpts.createFiles?.length || 0) > 0 || (providerOpts.createRoots?.length || 0) > 0)
      ) {
        throw new Error(
          "Writing-provider contract rejected creation authority: handoff must materialize exact files and pass them as scopedFiles.",
        );
      }
      const { output, stats = {} } = await timeRolePhase(
        role,
        "providerClient.call",
        job,
        () => this.providerClient.call(
          prompt,
          {
            ...providerOpts,
            buildFallbackPrompt: ({ providerName }) => buildPromptForProvider(providerName),
          },
          {
            ...this.buildMeta(job, ctx),
            ...(preparedAgent ? { jobProvider: preparedAgent.providerName } : {}),
          },
        ),
        { warnMs: SLOW_PROVIDER_CALL_MS },
      );
      return await this.processOutput(output, stats, job, ctx);
    } finally {
      try {
        await this.teardown(job, ctx);
      } finally {
        if (preparedAgent && this.context?.agentDispatcher) {
          await this.context.agentDispatcher.destroyAgent(preparedAgent, {
            reason: "role_launch_complete",
          });
        }
      }
    }
  }

  async assembleContext() {
    return "";
  }

  buildContract() {
    throw new Error(`${this.constructor.name}.buildContract() must be implemented by subclasses`);
  }

  composePrompt({ contextText, contract } = {}) {
    const prompt = [contract, contextText]
      .filter((part) => part != null && String(part) !== "")
      .join("\n\n");
    if (!prompt) {
      throw new Error(`${this.constructor.name} produced empty prompt`);
    }
    return prompt;
  }

  buildOpts(job, ctx = {}) {
    return {
      role: this.getRole(),
      modelTier: ctx.tier || job?.model_tier || "standard",
    };
  }

  buildMeta(job, ctx = {}) {
    return {
      job_id: job?.id ?? null,
      work_item_id: job?.work_item_id ?? null,
      cwd: ctx.cwd || this.context?.projectDir || null,
      jobProvider: ctx.providerName ?? null,
      jobModelName: job?.model_name || null,
    };
  }

  async processOutput(output, stats) {
    return { output, stats };
  }

  async teardown() {}

  canSpawn(jobType, outcome) {
    if (outcome !== "succeeded" && outcome !== "failed") {
      throw new Error(`${this.constructor.name}.canSpawn outcome must be "succeeded" or "failed", got ${outcome}`);
    }
    const pool = outcome === "succeeded"
      ? this.constructor.spawnsOnSuccess
      : this.constructor.spawnsOnFailure;
    return Array.isArray(pool) && pool.includes(jobType);
  }
}
