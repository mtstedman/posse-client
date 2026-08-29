// lib/domains/worker/classes/roles/summary.js
//
// Summary role that condenses prior work-item outputs into a single summary
// artifact for later planning or review.

import { BaseRole } from "../BaseRole.js";
import { getArtifactsByWorkItem, storeArtifact } from "../../../queue/functions/index.js";
import { currentExecutionProvider as defaultCurrentExecutionProvider } from "../../functions/helpers/diagnostics.js";
import { shortJobTitle as defaultShortJobTitle } from "../../../../shared/policies/functions/role-utils.js";
import {
  spawnFailureForRole,
  spawnSuccessForRole,
} from "../../../../shared/policies/functions/spawn-policy.js";
import { getPromptBundleRolePrompt } from "../../../remote/functions/prompt-bundle.js";

const DEFAULT_DEPS = {
  currentExecutionProvider: defaultCurrentExecutionProvider,
  loadNudges: () => "",
  shortJobTitle: defaultShortJobTitle,
};

const SUMMARY_OUTPUT_MAX_CHARS = 4000;
const SUMMARY_TRUNCATION_NOTICE = "\n\n[Summary truncated at 4000 characters.]";

function boundedSummaryOutput(output) {
  const text = String(output || "").trim();
  if (text.length <= SUMMARY_OUTPUT_MAX_CHARS) return text;
  return `${text.slice(0, SUMMARY_OUTPUT_MAX_CHARS - SUMMARY_TRUNCATION_NOTICE.length).trimEnd()}${SUMMARY_TRUNCATION_NOTICE}`;
}

export class SummaryRole extends BaseRole {
  // Summary jobs reuse planner provider settings because they are read-only
  // synthesis calls rather than a separately configured runtime role.
  static role = "planner";
  static spawnsOnSuccess = spawnSuccessForRole("summary");
  static spawnsOnFailure = spawnFailureForRole("summary");

  roleDeps() {
    return { ...DEFAULT_DEPS, ...this.deps };
  }

  async assembleContext(job) {
    const artifacts = getArtifactsByWorkItem(job.work_item_id, "response");
    const allOutputs = artifacts.map((artifact) => artifact.content_long).join("\n\n---\n\n");

    return `OUTPUTS:\n${allOutputs.slice(0, 10000)}`;
  }

  buildContract({ job, ctx } = {}) {
    const { loadNudges } = this.roleDeps();
    return [
      getPromptBundleRolePrompt("summary").trim(),
      job ? loadNudges(job.id, { attemptId: ctx?.attemptId }) : "",
    ].filter(Boolean).join("\n");
  }

  buildOpts(job, ctx) {
    const { shortJobTitle } = this.roleDeps();
    return {
      role: this.getRole(),
      allowWrite: false,
      modelTier: ctx.tier,
      reasoningEffort: "low",
      activity: `summarizing: ${shortJobTitle(job).slice(0, 40)}`,
      skipRolePrompt: true,
    };
  }

  buildMeta(job, ctx) {
    const { currentExecutionProvider } = this.roleDeps();
    return {
      ...super.buildMeta(job, ctx),
      cwd: this.context?.projectDir || null,
      jobProvider: currentExecutionProvider(job),
    };
  }

  async processOutput(output, _stats, job, ctx) {
    const summary = boundedSummaryOutput(output);
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: ctx.attemptId,
      artifact_type: "summary",
      content_long: summary,
    });

    return summary;
  }
}
