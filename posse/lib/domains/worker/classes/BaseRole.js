// lib/worker/base-role.js
//
// Base class for the incremental role OOP migration. It owns the shared
// provider-call template; role classes own context assembly and output handling.

import { log } from "../../../shared/telemetry/functions/logging/logger.js";

const SLOW_ROLE_PHASE_MS = 1000;
const SLOW_PROVIDER_CALL_MS = 45000;

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
        const providerCtx = { ...ctx, providerName };
        const contract = await timeRolePhase(role, "buildContract", job, () => this.buildContract({ providerName, job, ctx: providerCtx }));
        return await timeRolePhase(role, "composePrompt", job, () => this.composePrompt({ contextText, contract, job, ctx: providerCtx }));
      };
      const prompt = await buildPromptForProvider(ctx.providerName);
      const { output, stats = {} } = await timeRolePhase(
        role,
        "providerClient.call",
        job,
        () => this.providerClient.call(
          prompt,
          {
            ...this.buildOpts(job, ctx),
            buildFallbackPrompt: ({ providerName }) => buildPromptForProvider(providerName),
          },
          this.buildMeta(job, ctx),
        ),
        { warnMs: SLOW_PROVIDER_CALL_MS },
      );
      return await this.processOutput(output, stats, job, ctx);
    } finally {
      await this.teardown(job, ctx);
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
