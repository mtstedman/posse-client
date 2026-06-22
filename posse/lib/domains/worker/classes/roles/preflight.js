// lib/domains/worker/classes/roles/preflight.js
//
// Cheap routing-only role for ambiguous research requests. It receives the
// deterministic project map and intake context, then returns strict JSON that
// the worker turns into the next research job.

import { BaseRole } from "../BaseRole.js";
import { promptLiteral } from "../../../../shared/format/functions/prompt-literals.js";
import { getWorkItem } from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { currentExecutionProvider } from "../../functions/helpers/diagnostics.js";
import { getWorkItemIntakeHints } from "../../../intake/functions/hints.js";
import { ensureProjectMap, getCachedProjectMap } from "../../../project/functions/map.js";
import { normalizeResearchBudget } from "../../../../shared/policies/functions/role-utils.js";
import {
  spawnFailureForRole,
  spawnSuccessForRole,
} from "../../../../shared/policies/functions/spawn-policy.js";
import { getProviderName } from "../../../providers/functions/provider.js";
import { getPromptBundleRolePrompt } from "../../../remote/functions/prompt-bundle.js";

function parsePayload(context, job) {
  if (typeof context?.parsePayload === "function") return context.parsePayload(job);
  return parseJobPayload(job);
}

function parseMetadata(workItem) {
  try {
    return workItem?.metadata_json ? JSON.parse(workItem.metadata_json) : {};
  } catch {
    return {};
  }
}

function loadProjectMap(projectDir) {
  try {
    return getCachedProjectMap(projectDir) || ensureProjectMap(projectDir);
  } catch {
    return null;
  }
}

function truncateJson(value, maxChars = 16000) {
  const rendered = JSON.stringify(value ?? null, null, 2);
  if (rendered.length <= maxChars) return rendered;
  return `${rendered.slice(0, maxChars)}\n... truncated ...`;
}

export class PreflightRole extends BaseRole {
  static role = "preflight";
  static spawnsOnSuccess = spawnSuccessForRole("preflight");
  static spawnsOnFailure = spawnFailureForRole("preflight");

  async assembleContext(job) {
    const projectDir = this.context?.projectDir || process.cwd();
    const workItem = getWorkItem(job.work_item_id);
    const metadata = parseMetadata(workItem);
    const payload = parsePayload(this.context, job);
    const mode = payload.mode || workItem?.mode || metadata.mode || "build";
    const intakeHints = payload.intake_hints || metadata.intake_hints || getWorkItemIntakeHints(workItem, mode);
    const fallbackBudget = normalizeResearchBudget(payload.fallback_budget || payload.deepthink_budget || metadata.deepthink_budget, "normal");
    const projectMap = payload.project_map || loadProjectMap(projectDir);

    return [
      "PRE-FLIGHT ROUTING CONTEXT",
      "",
      `Work item: #${workItem?.id || job.work_item_id}`,
      `Mode: ${mode}`,
      promptLiteral("TITLE", workItem?.title || job.title || ""),
      promptLiteral("DESCRIPTION", workItem?.description || ""),
      "",
      `Fallback budget: ${fallbackBudget}`,
      "",
      "Deterministic routing result:",
      truncateJson(payload.routing || {}),
      "",
      "Intake hints:",
      truncateJson(intakeHints || {}),
      "",
      "Project map:",
      truncateJson(projectMap || { unavailable: true }),
    ].join("\n");
  }

  buildContract() {
    return getPromptBundleRolePrompt("preflight").trim();
  }

  buildOpts(job, ctx) {
    return {
      role: this.getRole(),
      allowWrite: false,
      modelTier: ctx.tier || job.model_tier || "cheap",
      reasoningEffort: "low",
      activity: `routing: ${(job.title || "").replace(/^Preflight:\s*/i, "").slice(0, 40)}`,
      skipRolePrompt: true,
      maxTurns: 2,
    };
  }

  buildMeta(job, ctx) {
    return {
      ...super.buildMeta(job, ctx),
      cwd: this.context?.projectDir || null,
      jobProvider: ctx.providerName || currentExecutionProvider(job) || getProviderName(this.getRole()),
    };
  }

  async processOutput(output) {
    return output;
  }
}
