// lib/domains/worker/classes/roles/researcher.js
//
// Researcher role handler that gathers repo/project context into a structured
// brief for planning without mutating repo state.

import fs from "fs";
import path from "path";
import { C } from "../../../../shared/format/functions/colors.js";
import { promptLiteral } from "../../../../shared/format/functions/prompt-literals.js";
import { BaseRole } from "../BaseRole.js";
import { getDb } from "../../../../shared/storage/functions/index.js";
import {
  getArtifacts,
  getArtifactsByWorkItem,
  getAttempts,
  getJob,
  getWorkItem,
  storeArtifact,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";
import { persistResearcherMemories } from "../../functions/helpers/research-memories.js";
import {
  contextDir,
  describeArtifactRoutingForPrompt,
  getConfiguredImageProviders,
  getResolvedImageProtocol,
  wiScopeId,
} from "../../../artifacts/functions/index.js";
import {
  ensureDetachedReadOnlyWorktreeAsync,
} from "../../../git/functions/worktree.js";
import {
  buildDiffNarrativeAsync,
  formatDiffNarrative,
} from "../../../git/functions/diff-narrator.js";
import {
  buildResearchIntakePreload,
  getWorkItemIntakeHints,
  getWorkItemWorkflowConfig,
  buildWorkflowModeBlock,
} from "../../../intake/functions/hints.js";
import { currentExecutionProvider, extractResearchRetryContext } from "../../functions/helpers/diagnostics.js";
import { getProviderName, isProviderReady } from "../../../providers/functions/provider.js";
import { getDefaultImageModel } from "../../../providers/functions/model-catalog.js";
import { collectAtlasCoveredFiles, composePromptRemoteAware, handoff, parseResearcherStructuredOutput, renderAtlasHandoffSections } from "../../../handoff/functions/index.js";
import {
  getResearchBudget as defaultGetResearchBudget,
  isDeepthinkTask as defaultIsDeepthinkTask,
  isResearchBudgetDeep as defaultIsResearchBudgetDeep,
  researchBudgetFromDeepthink,
  researchBudgetPromptBlock as defaultResearchBudgetPromptBlock,
  researchBudgetToMaxTurnsOverride as defaultResearchBudgetToMaxTurnsOverride,
  researchBudgetToReasoningEffort as defaultResearchBudgetToReasoningEffort,
  shortJobTitle as defaultShortJobTitle,
} from "../../../../shared/policies/functions/role-utils.js";
import {
  spawnFailureForRole,
  spawnSuccessForRole,
} from "../../../../shared/policies/functions/spawn-policy.js";
import { hasLineRef } from "../../../research/functions/line-refs.js";
import { buildWebFetchCachePreload, cacheResearchWebFetches } from "../../../research/functions/web-cache.js";

const CHILD_BRIEF_SYNTH_CHAR_LIMIT = 12000;
const CHILD_BRIEF_EXCERPT_CHAR_LIMIT = 3000;
const CHILD_BRIEF_JSON_CHAR_LIMIT = 6000;
const CHILD_BRIEF_CITATION_LINE_LIMIT = 60;
const RETRY_SALVAGE_OBSERVATION_LIMIT = 80;
const RETRY_SALVAGE_RESPONSE_CHAR_LIMIT = 9000;
const RETRY_SALVAGE_LINE_LIMIT = 140;
const RETRY_SYNTHESIS_MAX_TURNS = 10;

const DEFAULT_DEPS = {
  getResearchBudget: defaultGetResearchBudget,
  isDeepthinkTask: defaultIsDeepthinkTask,
  isResearchBudgetDeep: defaultIsResearchBudgetDeep,
  loadNudges: () => "",
  researchBudgetPromptBlock: defaultResearchBudgetPromptBlock,
  researchBudgetToMaxTurnsOverride: defaultResearchBudgetToMaxTurnsOverride,
  researchBudgetToReasoningEffort: defaultResearchBudgetToReasoningEffort,
  shortJobTitle: defaultShortJobTitle,
};

function parsePayload(worker, job) {
  if (typeof worker?.parsePayload === "function") return worker.parsePayload(job);
  return parseJobPayload(job);
}

function normalizeResearchRoleMode(value) {
  const raw = String(value || "solo").trim().toLowerCase();
  return ["solo", "child", "synth"].includes(raw) ? raw : "solo";
}

function parseChildJobIds(payload) {
  return Array.isArray(payload?.child_job_ids)
    ? payload.child_job_ids.map((id) => Number(id)).filter((id) => Number.isFinite(id) && id > 0)
    : [];
}

function buildWebOnlyAnswerBlock(payload) {
  const hints = Array.isArray(payload?.web_scope_hints) ? payload.web_scope_hints : [];
  return [
    "WEB-ONLY ANSWER MODE:",
    "- This work item is an external lookup with no repository scope. Use web evidence and keep the answer compact.",
    "- Prefer WebSearch for discovery; use WebFetch only for exact wording, API behavior, version data, or examples from a known URL.",
    hints.length > 0 ? `- Web scope hints:\n${hints.map((hint) => `  - ${hint}`).join("\n")}` : "- Web scope hints: (none provided)",
    "",
  ].join("\n");
}

function buildFanoutChildBlock(payload) {
  const branch = payload?.fanout_branch && typeof payload.fanout_branch === "object"
    ? payload.fanout_branch
    : {};
  const label = String(branch.label || payload?.fanout_branch_index || "branch").trim();
  const kind = String(branch.kind || "module").trim().toLowerCase() === "web" ? "web" : "module";
  const scopeHints = Array.isArray(branch.scope_hints)
    ? branch.scope_hints
    : Array.isArray(payload?.fanout_scope_hints)
      ? payload.fanout_scope_hints
      : [];
  const focusLines = kind === "web"
    ? [
        "- Branch kind: web. Treat scope hints as domains, URLs, or vendor documentation surfaces.",
        "- Use WebSearch/WebFetch for this branch; do not inspect repository code unless needed to connect an external claim back to the work item.",
        "- Emit exact URLs for documentation claims. Include path:line citations only for repository-specific claims.",
      ]
    : [
        "- Branch kind: module. Treat scope hints as repository paths or module aliases.",
        "- Focus on this branch only. Follow direct dependencies only when needed to verify a claim.",
        "- Emit exact file paths and line-number citations for findings the synthesizer should rely on.",
      ];

  return [
    "RESEARCH FANOUT CHILD MODE:",
    `- Branch: ${label}`,
    `- Fanout run: ${payload?.fanout_run_id || "(unknown)"}`,
    ...focusLines,
    "- If you find a contradiction or uncertainty, name it plainly instead of resolving it by assumption.",
    "- If web tools are available, use WebSearch for discovery first. Keep WebSearch to at most 2 queries and WebFetch to at most 3 URLs; if you exceed either cap, include a brief justification naming the prior query or URL that lacked enough evidence.",
    scopeHints.length > 0
      ? `- ${kind === "web" ? "Domain/URL hints" : "Scope hints"}:\n${scopeHints.map((hint) => `  - ${hint}`).join("\n")}`
      : `- ${kind === "web" ? "Domain/URL hints" : "Scope hints"}: (none provided)`,
    "",
  ].join("\n");
}

function buildFanoutSynthBlock(payload, childBriefs) {
  const shadowText = payload?.fanout_shadow === true
    ? "- Shadow mode: this synthesis is for offline comparison and must not assume it is the planner source."
    : "- Active mode: this synthesis is the research brief the planner will consume.";
  return [
    "RESEARCH FANOUT SYNTHESIS MODE:",
    `- Fanout run: ${payload?.fanout_run_id || "(unknown)"}`,
    shadowText,
    "- Compare the child briefs and preserve exact path:line citations for code claims and exact URLs for external documentation claims.",
    "- Treat code citations and URL citations as distinct evidence classes; do not convert one into the other.",
    "- Re-read cited files/lines before relying on a disputed code claim.",
    "- If child briefs contradict each other and you cannot resolve the contradiction, include needs_review with the conflicting evidence.",
    "- Produce one planner-ready research brief, not separate summaries.",
    "",
    childBriefs ? `CHILD RESEARCH BRIEFS:\n${childBriefs}\n` : "CHILD RESEARCH BRIEFS: none found. State this limitation in the output.\n",
  ].join("\n");
}

function collectReplanScopedFiles(payload = {}) {
  const files = Array.isArray(payload?.original_scoped_files) ? payload.original_scoped_files : [];
  return [...new Set(files.map((file) => String(file || "").replace(/\\/g, "/").trim()).filter(Boolean))];
}

function isAssessmentReplanPayload(payload = {}) {
  const originalJobType = String(payload?.original_job_type || "").trim();
  return payload?._assessment_replan === true
    && Number.isInteger(Number(payload?.original_job_id))
    && ["dev", "fix", "promote", "artificer"].includes(originalJobType);
}

function buildAssessmentReplanEvidenceBlock(payload, { researchCwd = "", diffBlock = "", cwdError = "" } = {}) {
  if (!isAssessmentReplanPayload(payload)) return "";
  const scopedFiles = collectReplanScopedFiles(payload);
  const lines = [
    "ASSESSMENT REPLAN EVIDENCE:",
    "- This replan was triggered by assessor failure after a mutating job, so inspect the current work-item branch state before proposing replacement work.",
    `- Original job: #${payload.original_job_id} (${payload.original_job_type}${payload.original_task_mode ? `/${payload.original_task_mode}` : ""}) ${payload.original_title || ""}`.trim(),
    `- Work-item branch: ${payload.wi_branch_name || "(not recorded)"}`,
    `- Original commit: ${payload.original_commit_hash || "(not recorded)"}`,
    payload.wi_merge_base_hash ? `- Merge base: ${payload.wi_merge_base_hash}` : "",
    researchCwd ? `- Research cwd: ${researchCwd}` : "",
    cwdError ? `- Branch worktree note: ${cwdError}` : "",
    scopedFiles.length > 0 ? `- Original scoped files:\n${scopedFiles.map((file) => `  - ${file}`).join("\n")}` : "- Original scoped files: (not recorded)",
    payload.replan_reason ? `\nAssessor reasons:\n${payload.replan_reason}` : "",
    diffBlock ? `\n${diffBlock}` : "",
    "",
  ];
  return lines.filter(Boolean).join("\n");
}

async function resolveAssessmentReplanCwd(baseProjectDir, job, payload, { signal = null } = {}) {
  if (!isAssessmentReplanPayload(payload)) {
    return { cwd: baseProjectDir, error: "" };
  }
  const targetRef = payload.wi_branch_name || payload.original_commit_hash || "";
  if (!targetRef) {
    return { cwd: baseProjectDir, error: "no branch or commit was recorded; using base project checkout" };
  }
  try {
    const readonlyDir = path.join(
      contextDir(wiScopeId(job.work_item_id), baseProjectDir),
      "replan-readonly",
      `job-${job.id}`,
    );
    const cwd = await ensureDetachedReadOnlyWorktreeAsync(baseProjectDir, {
      targetRef,
      worktreeDir: readonlyDir,
      signal,
    });
    return { cwd, error: "" };
  } catch (err) {
    return {
      cwd: baseProjectDir,
      error: `could not create detached worktree for ${targetRef}: ${err?.message || String(err)}`,
    };
  }
}

async function buildAssessmentReplanDiffBlock(payload, researchCwd) {
  const commitHash = String(payload?.original_commit_hash || "").trim();
  const scopedFiles = collectReplanScopedFiles(payload);
  if (!commitHash || scopedFiles.length === 0 || !researchCwd || !fs.existsSync(researchCwd)) return "";
  const narrative = await buildDiffNarrativeAsync({
    cwd: researchCwd,
    commitHash,
    paths: scopedFiles,
  });
  if (narrative?.ok) return formatDiffNarrative(narrative);
  return narrative?.reason ? `DIFF NARRATIVE: unavailable (${narrative.reason})` : "";
}

function truncateWithNote(value, maxChars, note) {
  const text = String(value || "");
  if (text.length <= maxChars) return text;
  return `${text.slice(0, Math.max(0, maxChars)).trimEnd()}\n... (${note})`;
}

function extractCitationLines(content) {
  const seen = new Set();
  const lines = [];
  for (const rawLine of String(content || "").split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || !hasLineRef(line) || seen.has(line)) continue;
    seen.add(line);
    lines.push(line);
    if (lines.length >= CHILD_BRIEF_CITATION_LINE_LIMIT) break;
  }
  return lines;
}

function structuredAppendixBlock(content) {
  const parsed = parseResearcherStructuredOutput(content);
  if (!parsed) return "";
  const rendered = JSON.stringify(parsed, null, 2);
  return [
    "STRUCTURED JSON APPENDIX:",
    "```json",
    truncateWithNote(rendered, CHILD_BRIEF_JSON_CHAR_LIMIT, "structured appendix truncated for synthesis"),
    "```",
  ].join("\n");
}

function formatChildBriefForSynth({ label, content }) {
  const raw = String(content || "");
  const heading = `## ${label}`;
  if (raw.length <= CHILD_BRIEF_SYNTH_CHAR_LIMIT) {
    return `${heading}\n${raw}`;
  }

  const citationLines = extractCitationLines(raw);
  const structuredBlock = structuredAppendixBlock(raw);
  const sections = [
    heading,
    `BRIEF EXCERPT (compacted from ${raw.length} chars):`,
    truncateWithNote(raw, CHILD_BRIEF_EXCERPT_CHAR_LIMIT, "child brief excerpt truncated for synthesis"),
    citationLines.length > 0
      ? `CITATION LINES PRESERVED:\n${citationLines.map((line) => `- ${line}`).join("\n")}`
      : "",
    structuredBlock,
    "Full child artifact was compacted for synthesis; re-read cited files/lines before relying on disputed claims.",
  ];
  // Citation and JSON caps are independent, so unusually long citation lines can
  // still push the assembled block over the per-child synth budget.
  return truncateWithNote(
    sections.filter(Boolean).join("\n\n"),
    CHILD_BRIEF_SYNTH_CHAR_LIMIT,
    "compacted child brief truncated for synthesis",
  );
}

function safeJsonParse(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(String(value));
  } catch {
    return fallback;
  }
}

function compactObservationLine(row) {
  const type = String(row?.observation_type || "observation").trim();
  const summary = String(row?.summary || "").replace(/\s+/g, " ").trim();
  const detail = safeJsonParse(row?.detail_json, null);
  const pathHint = detail?.path || detail?.file_path || detail?.url || detail?.command || detail?.action || null;
  const suffix = pathHint && !summary.includes(String(pathHint))
    ? ` (${String(pathHint).slice(0, 160)})`
    : "";
  return `- ${type}: ${summary || "(no summary)"}${suffix}`.slice(0, 260);
}

function readPriorAttemptObservations(jobId, currentAttemptId = null) {
  try {
    const rows = getDb().prepare(`
      SELECT id, attempt_id, observation_type, summary, detail_json
      FROM job_observations
      WHERE job_id = ?
        AND (? IS NULL OR attempt_id IS NULL OR attempt_id != ?)
        AND (
          observation_type LIKE 'tool.%'
          OR observation_type IN ('attempt.failed', 'provider.fallback', 'atlas.fallback.rebind')
        )
      ORDER BY id ASC
      LIMIT ?
    `).all(jobId, currentAttemptId, currentAttemptId, RETRY_SALVAGE_OBSERVATION_LIMIT);
    return Array.isArray(rows) ? rows : [];
  } catch {
    return [];
  }
}

function buildResearchRetrySalvageBlock(job, ctx = {}) {
  const attempts = getAttempts(job.id).filter((attempt) => {
    if (ctx.attemptId != null && Number(attempt.id) === Number(ctx.attemptId)) return false;
    return ["failed", "interrupted"].includes(String(attempt.status || ""));
  });
  const sameJobResponses = getArtifacts(job.id, "response")
    .filter((artifact) => ctx.attemptId == null || Number(artifact.attempt_id) !== Number(ctx.attemptId))
    .map((artifact) => String(artifact.content_long || "").trim())
    .filter(Boolean);
  const observations = readPriorAttemptObservations(job.id, ctx.attemptId);
  if (attempts.length === 0 && sameJobResponses.length === 0 && observations.length === 0) return "";

  const sections = [
    "RESEARCH RETRY SALVAGE:",
    "- A previous attempt did useful discovery before failing or exhausting its turn/tool budget.",
    "- Reuse this context. Do not repeat broad exploration unless a cited path, URL, or claim must be revalidated.",
    "- Make at most 3 targeted verification reads before final synthesis unless a required cited file/source is missing.",
  ];

  if (attempts.length > 0) {
    sections.push(
      "",
      "Prior attempt outcomes:",
      ...attempts.slice(-5).map((attempt) => {
        const error = String(attempt.error_text || "").split(/\r?\n/).find(Boolean) || "no error text";
        return `- attempt ${attempt.attempt_number}: ${attempt.status}${error ? ` - ${error.slice(0, 180)}` : ""}`;
      }),
    );
  }

  if (observations.length > 0) {
    const lines = observations.map(compactObservationLine).filter(Boolean);
    sections.push(
      "",
      "Already-discovered tool context:",
      ...lines.slice(-RETRY_SALVAGE_LINE_LIMIT),
    );
  }

  if (sameJobResponses.length > 0) {
    const responseText = truncateWithNote(
      sameJobResponses.join("\n\n---\n\n"),
      RETRY_SALVAGE_RESPONSE_CHAR_LIMIT,
      "prior partial researcher output truncated for retry salvage",
    );
    sections.push("", promptLiteral("PRIOR PARTIAL RESEARCH OUTPUT", responseText));
  }

  return sections.join("\n");
}

function buildResearchRetryShapeBlock({ atlasActive = false } = {}) {
  const atlasLine = atlasActive
    ? "- Retry shape: use ATLAS symbol.search/tree.branch first, then tree.expand from files you validated, then slice.build or context.summary, then final synthesis."
    : "- Retry shape: ATLAS is not active; make only targeted search/chain_read checks needed to validate prior evidence, then final synthesis.";
  return [
    "RESEARCH RETRY SHAPE BREAKER:",
    "- This retry is bounded synthesis, not a fresh open-ended research pass.",
    atlasLine,
    "- Do not repeat broad directory walks, repo-wide searches, or the same read sequence from the failed attempt.",
    "- If evidence is incomplete, return a partial brief with explicit unknowns and stop_reason instead of exhausting turns.",
  ].join("\n");
}

export class ResearcherRole extends BaseRole {
  static role = "researcher";
  static spawnsOnSuccess = spawnSuccessForRole("researcher");
  static spawnsOnFailure = spawnFailureForRole("researcher");

  roleDeps() {
    return { ...DEFAULT_DEPS, ...this.deps };
  }

  async assembleContext(job, ctx) {
    const worker = this.context;
    const baseProjectDir = worker?.projectDir || process.cwd();
    let projectDir = baseProjectDir;
    const {
      getResearchBudget,
      isDeepthinkTask,
      isResearchBudgetDeep,
      loadNudges,
      researchBudgetPromptBlock,
    } = this.roleDeps();

    const workItem = getWorkItem(job.work_item_id);
    const payload = parsePayload(worker, job);
    const replanCwd = await resolveAssessmentReplanCwd(baseProjectDir, job, payload, { signal: ctx.abortSignal || null });
    projectDir = replanCwd.cwd;
    const assessmentReplanDiffBlock = await buildAssessmentReplanDiffBlock(payload, projectDir);
    const assessmentReplanEvidenceBlock = buildAssessmentReplanEvidenceBlock(payload, {
      researchCwd: projectDir,
      diffBlock: assessmentReplanDiffBlock,
      cwdError: replanCwd.error,
    });
    const roleMode = normalizeResearchRoleMode(payload.role_mode);
    const webOnlyAnswer = payload.web_only_answer === true;
    const fanoutRunId = payload.fanout_run_id || null;
    const childJobIds = parseChildJobIds(payload);
    const researchBudget = this.deps?.isDeepthinkTask && !this.deps?.getResearchBudget
      ? researchBudgetFromDeepthink(isDeepthinkTask(workItem, payload))
      : getResearchBudget(workItem, payload);
    const deepthink = isResearchBudgetDeep(researchBudget);
    const intakeHints = getWorkItemIntakeHints(workItem, workItem?.mode || "build");
    const workflowModeBlock = buildWorkflowModeBlock(getWorkItemWorkflowConfig(workItem), this.getRole());
    const webFetchCachePreload = buildWebFetchCachePreload(job.work_item_id);
    const imageRoutingSummary = describeArtifactRoutingForPrompt("image");
    const imageProviders = getConfiguredImageProviders();
    const imageProtocol = getResolvedImageProtocol();
    const imageReadinessSummary = imageProviders
      .map((provider) => {
        const readiness = isProviderReady(provider, "images");
        return `${provider}:${readiness.ready ? "available" : `unavailable (${readiness.reason || "unknown reason"})`}`;
      })
      .join(", ");
    const roleProviders = {
      [this.getRole()]: job.provider || getProviderName(this.getRole()),
      planner: getProviderName("planner"),
      artificer: getProviderName("artificer"),
    };
    const routingContext = [
      "PIPELINE ROUTING CONTEXT (treat this as source-of-truth project configuration):",
      "- Image deliverables belong to the ARTIFICER role, not ad hoc repo scripts, unless explicit task output binding says otherwise.",
      `- ${imageRoutingSummary}`,
      `- Image providers: available=${imageProviders.join(", ")}, selected=${imageProtocol.provider}, model=${imageProtocol.model || getDefaultImageModel(imageProtocol.provider)}`,
      `- Image provider readiness: ${imageReadinessSummary}`,
      `- Admin-backed provider selections: researcher=${roleProviders.researcher}, planner=${roleProviders.planner}, artificer=${roleProviders.artificer}`,
      "- Do not claim the project has no image generation path when this routing context says image artifact routing is available.",
      "",
    ].join("\n");

    const priorResearch = roleMode === "synth" ? "" : getArtifactsByWorkItem(job.work_item_id, "response")
      .filter((artifact) => {
        const relatedJob = getJob(artifact.job_id);
        if (!relatedJob || relatedJob.job_type !== "research" || relatedJob.id === job.id) return false;
        if (fanoutRunId) {
          const relatedPayload = parsePayload(null, relatedJob);
          if (relatedPayload?.fanout_run_id === fanoutRunId) return false;
        }
        return true;
      })
      .map((artifact) => artifact.content_long)
      .join("\n\n---\n\n");

    const childBriefs = roleMode === "synth"
      ? getArtifactsByWorkItem(job.work_item_id, "response")
        .filter((artifact) => childJobIds.includes(Number(artifact.job_id)))
        .map((artifact) => {
          const relatedJob = getJob(artifact.job_id);
          const relatedPayload = relatedJob ? parsePayload(null, relatedJob) : {};
          const label = relatedPayload?.fanout_branch?.label || relatedJob?.title || `child #${artifact.job_id}`;
          return formatChildBriefForSynth({ label, content: artifact.content_long });
        })
        .join("\n\n---\n\n")
      : "";

    const humanAnswers = getArtifactsByWorkItem(job.work_item_id, "response")
      .filter((artifact) => {
        const relatedJob = getJob(artifact.job_id);
        return relatedJob && relatedJob.job_type === "human_input";
      })
      .map((artifact) => artifact.content_long)
      .join("\n\n---\n\n");

    const priorAttemptLogs = extractResearchRetryContext(getArtifacts(job.id, "log"));
    const retrySalvageBlock = buildResearchRetrySalvageBlock(job, ctx);
    const payloadRetrySynthesisMode = payload._research_retry_synthesis === true || payload._retry_synthesis === true;
    const retrySynthesisMode = !!(payloadRetrySynthesisMode || priorAttemptLogs || retrySalvageBlock);

    let researcherPacket = null;
    let atlasHandoffBlock = "";
    const synthNeedsVerificationHandoff = roleMode === "synth"
      && payload.verify_child_citations === true;
    const shouldRenderAtlasHandoff = (roleMode !== "synth" && !webOnlyAnswer) || synthNeedsVerificationHandoff;
    const researcherExecProvider = ctx.providerName || currentExecutionProvider(job);
    const researcherAttempts = getAttempts(job.id);
    const packetFields = {
      job_type: job.job_type,
      work_item_id: job.work_item_id,
      job_id: job.id,
      title: job.title,
      model_tier: ctx.tier || job.model_tier || "standard",
      reasoning_effort: job.reasoning_effort || "medium",
      governance_tier: workItem?.governance_tier || "mvp",
      execution_provider: researcherExecProvider,
      attempt: {
        count: researcherAttempts.length + 1,
        max: job.max_attempts || 3,
        last_error: job.last_error || researcherAttempts.at(-1)?.error_text || null,
        escalated: ctx.tier && ctx.tier !== job.model_tier,
      },
      success_criteria: Array.isArray(payload.success_criteria) ? payload.success_criteria : [],
      test_command: payload.test_command || null,
    };
    const projectContext = (payload.task_spec || workItem.description || "").slice(0, 4000);
    if (shouldRenderAtlasHandoff) {
      researcherPacket = await handoff({
        recipient: this.getRole(),
        data: {
          cwd: projectDir,
          execution_provider: researcherExecProvider,
          title: workItem.title || "",
          project_context: projectContext,
          files_to_modify: [],
        },
      });
    } else {
      researcherPacket = {
        recipient: this.getRole(),
        cwd: projectDir,
        project_context: projectContext,
        files_to_modify: [],
        files_to_create: [],
        files_to_delete: [],
        create_roots: [],
        related_files: [],
        related_files_content: {},
        requested_skills: [],
        skills: [],
        risk: { mutating: false, assessable: false },
        tool_policy: { allow_read: true, allow_write: false, allow_shell: false },
        budgets: { fallback_reads_remaining: 0 },
        atlas: null,
        context_hints: { disableAtlas: true },
      };
    }
    Object.assign(researcherPacket, packetFields);
    if (shouldRenderAtlasHandoff) {
      // Resolve ATLAS handoff state so ATLAS CONTEXT / ATLAS SLICE PRUNING sections are
      // injected when the researcher may need fresh code discovery.
      atlasHandoffBlock = renderAtlasHandoffSections(researcherPacket);
    }
    // Built after the ATLAS handoff state resolves so hinted files the ATLAS
    // prefetch already covered render as pointers instead of body previews.
    const hintedPreload = buildResearchIntakePreload(projectDir, intakeHints, {
      atlasCoveredFiles: collectAtlasCoveredFiles(researcherPacket),
    });

    Object.assign(ctx, {
      deepthink,
      childJobIds,
      fanoutRunId,
      payload,
      projectDir,
      researchBudget,
      researchRetrySynthesisMode: retrySynthesisMode,
      researchRoleMode: roleMode,
      researcherPacket,
      workItem,
    });

    return [
      "Research the following topic for a development work item.",
      "",
      promptLiteral("WORK ITEM", workItem.title),
      promptLiteral("DESCRIPTION", workItem.description || "(none)"),
      researchBudgetPromptBlock(researchBudget, "researcher"),
      "",
      workflowModeBlock,
      roleMode !== "synth" && hintedPreload ? `${hintedPreload}\n` : "",
      roleMode !== "synth" && webFetchCachePreload ? `${webFetchCachePreload}\n` : "",
      roleMode !== "synth" && !webOnlyAnswer ? routingContext : "",
      webOnlyAnswer ? buildWebOnlyAnswerBlock(payload) : "",
      roleMode === "child" ? buildFanoutChildBlock(payload) : "",
      roleMode === "synth" ? buildFanoutSynthBlock(payload, childBriefs) : "",
      assessmentReplanEvidenceBlock,
      atlasHandoffBlock || null,
      retrySynthesisMode ? buildResearchRetryShapeBlock({ atlasActive: !!researcherPacket?.atlas?.active }) : "",
      payloadRetrySynthesisMode ? "TURN-BUDGET RETRY MODE:\nPrevious research exceeded a deterministic turn/tool budget. Produce a partial planner-ready brief from available context and salvage; only make targeted verification reads if absolutely necessary.\n" : "",
      priorResearch ? `PRIOR RESEARCH BRIEF:\n${priorResearch}\n` : "",
      humanAnswers ? `HUMAN ANSWERS (to your previous questions):\n${humanAnswers}\n` : "",
      priorAttemptLogs ? `PRIOR ATTEMPT (ran out of turns - do NOT repeat these reads, summarize your findings promptly):\n${priorAttemptLogs}\n` : "",
      retrySalvageBlock ? `${retrySalvageBlock}\n` : "",
      loadNudges(job.id, { attemptId: ctx.attemptId }),
      promptLiteral("RESEARCH REQUEST", payload.instructions || payload.task_spec || job.title),
    ].filter(Boolean).join("\n");
  }

  buildContract() {
    // The researcher role prompt and the researcher-output contract are supplied
    // by the remote prompt compiler as the system prompt. This block carries only
    // the task-framing directive that rides in the user instructions, matching the
    // dev/planner/assessor pattern (no local role-prompt/contract re-assembly).
    return [
      "Return your findings in the required researcher output format.",
      "Gather evidence with the available tools before answering; do not invent file paths, symbols, or sources.",
      "Do not spend the whole turn budget on discovery. After enough evidence to answer, stop reading and synthesize.",
      "As a guide, synthesize after 8-12 meaningful repo tool calls, 4 child/web calls, repeated paths/sources, or any point where additional reads are unlikely to change the brief.",
      "On retries with prior context or salvage, reuse it and make only a few targeted verification reads before producing the final answer.",
      "A partial but evidence-backed brief is better than exhausting turns without a final response.",
      "When stopping early or retrying, include files/symbols consulted, why each mattered, unknowns, and stop_reason so the planner can decide whether escalation is worth the cost.",
      "When you identify a mechanism (enforcement, routing, dispatch, config read), enumerate its parallel lanes before concluding: same-named symbols elsewhere, sibling constant sets, and second-layer enforcement. List each lane with evidence, or state explicitly that you searched for parallels and found none.",
      "In the structured researcher appendix, include scope_estimate when repo scope is relevant: { confidence: \"high\" | \"medium\" | \"low\", likely_touch_count: number, unknowns: string[], scope_reasons: string[] }. This is scope evidence only; do not choose downstream models or budgets.",
    ].join("\n");
  }

  async composePrompt({ contextText, contract, ctx } = {}) {
    const remoteInstructions = [contract, contextText]
      .filter((part) => part != null && String(part) !== "")
      .join("\n\n");
    if (!remoteInstructions) {
      throw new Error(`${this.constructor.name} produced empty prompt`);
    }
    return await composePromptRemoteAware(ctx.researcherPacket, remoteInstructions, {
      ...(this.deps?.remoteComposer ? { composer: this.deps.remoteComposer } : {}),
    });
  }

  buildOpts(job, ctx) {
    const {
      isResearchBudgetDeep,
      researchBudgetToMaxTurnsOverride,
      researchBudgetToReasoningEffort,
      shortJobTitle,
    } = this.roleDeps();
    const researchBudget = ctx.researchBudget || "normal";
    const roleMode = ctx.researchRoleMode || "solo";
    const maxTurns = researchBudgetToMaxTurnsOverride(researchBudget, "researcher", { roleMode });
    const retryMaxTurns = ctx.researchRetrySynthesisMode
      ? Math.min(maxTurns || RETRY_SYNTHESIS_MAX_TURNS, RETRY_SYNTHESIS_MAX_TURNS)
      : null;
    const webOnlyMaxTurns = ctx.payload?.web_only_answer === true
      ? Math.min(maxTurns || 8, 8)
      : null;
    const effectiveMaxTurns = webOnlyMaxTurns || retryMaxTurns || maxTurns;
    const activityPrefix = roleMode === "synth"
      ? "synthesizing research"
      : roleMode === "child"
        ? "researching branch"
        : "researching";
    return {
      role: this.getRole(),
      roleMode,
      allowWrite: false,
      modelTier: ctx.tier,
      reasoningEffort: researchBudgetToReasoningEffort(researchBudget, job.reasoning_effort || "medium"),
      deepthink: isResearchBudgetDeep(researchBudget),
      ...(effectiveMaxTurns ? { maxTurns: effectiveMaxTurns } : {}),
      activity: `${activityPrefix}: ${shortJobTitle(job).replace(/^Research(?:\s*\((?:self-resolve|follow-up|[^)]*)\))?:\s*/i, "").slice(0, 40)}`,
      stableContext: ctx.researcherPacket?.stable_context || null,
      remoteSystemPrompt: ctx.researcherPacket?.remote_system_prompt || null,
      atlasPrefetchStatus: ctx.researcherPacket?.atlas?.prefetchStatus || null,
      skipRolePrompt: true,
    };
  }

  buildMeta(job, ctx) {
    return {
      ...super.buildMeta(job, ctx),
      cwd: ctx.projectDir || this.context?.projectDir || null,
      jobProvider: ctx.providerName || currentExecutionProvider(job),
    };
  }

  async processOutput(output, _stats, job, ctx) {
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: ctx.attemptId,
      artifact_type: "summary",
      content_long: output,
    });

    // Durable findings ride the structured appendix (memories field) — the
    // pipeline persists them here, capped per round, instead of the agent
    // spending tool calls on memory.store. Fan-out children skip: only the
    // primary/synthesis output represents the round.
    const memoryPayload = ctx.payload || parseJobPayload(job) || {};
    const isChildBranch = memoryPayload.role_mode === "child" || memoryPayload.fanout_shadow === true;
    if (output && !isChildBranch) {
      try {
        const persisted = await persistResearcherMemories({
          output,
          cwd: ctx.projectDir || this.context?.projectDir || process.cwd(),
          workItemId: job.work_item_id,
          jobId: job.id,
        });
        if (persisted.stored > 0 || persisted.failed > 0) {
          this.context?.emit?.(job.id, `${C.magenta}[researcher]${C.reset} ${C.dim}memories: ${persisted.stored} stored${persisted.duplicates ? `, ${persisted.duplicates} duplicate` : ""}${persisted.failed ? `, ${persisted.failed} failed` : ""} (cap 5/round)${C.reset}`);
        }
      } catch { /* memory persistence must never fail research output handling */ }
    }

    if (output) {
      const firstLines = output.split("\n").filter((line) => line.trim()).slice(0, 3).join(" ").slice(0, 200);
      if (firstLines) {
        this.context?.emit?.(job.id, `${C.magenta}[researcher]${C.reset} ${C.dim}${firstLines}${firstLines.length >= 200 ? "..." : ""}${C.reset}`);
      }
    }

    cacheResearchWebFetches({
      workItemId: job.work_item_id,
      jobId: job.id,
      attemptId: ctx.attemptId,
      output,
    });

    return output;
  }
}
