// lib/domains/worker/classes/roles/researcher.js
//
// Researcher role handler that gathers repo/project context into a structured
// brief for planning without mutating repo state.

import fs from "fs";
import path from "path";
import { C } from "../../../../shared/format/functions/colors.js";
import { promptLiteral } from "../../../../shared/format/functions/prompt-literals.js";
import { atlasMemoryEnabled } from "../../../../shared/policies/functions/memory-mode.js";
import { getAccountSetting } from "../../../settings/functions/account-settings.js";
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
import { collectAtlasCoveredFiles, composePromptRemoteAware, handoff, parseResearcherStructuredOutput, renderAtlasHandoffSections, sanitizeResearcherStructuredOutput } from "../../../handoff/functions/index.js";
import {
  getResearchBudget as defaultGetResearchBudget,
  isDeepthinkTask as defaultIsDeepthinkTask,
  isResearchBudgetDeep as defaultIsResearchBudgetDeep,
  researchBudgetFromDeepthink,
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
const FANOUT_CHILD_DESCRIPTION_CHAR_LIMIT = 1200;
const FANOUT_CHILD_EVIDENCE_TOKEN_TARGET = 900;
const FANOUT_SYNTHESIS_TOKEN_TARGET = 1800;

const DEFAULT_DEPS = {
  getResearchBudget: defaultGetResearchBudget,
  isDeepthinkTask: defaultIsDeepthinkTask,
  isResearchBudgetDeep: defaultIsResearchBudgetDeep,
  loadNudges: () => "",
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

function fanoutBranchFromPayload(payload = {}) {
  return payload?.fanout_branch && typeof payload.fanout_branch === "object"
    ? payload.fanout_branch
    : {};
}

function fanoutBranchScopeHints(payload = {}) {
  const branch = fanoutBranchFromPayload(payload);
  return Array.isArray(branch.scope_hints)
    ? branch.scope_hints
    : Array.isArray(payload?.fanout_scope_hints)
      ? payload.fanout_scope_hints
      : [];
}

function fanoutBranchKind(payload = {}) {
  const kind = String(fanoutBranchFromPayload(payload).kind || "module").trim().toLowerCase();
  return kind === "web" ? "web" : "module";
}

function researchPromptProfile(roleMode, { reportMode = false } = {}) {
  if (roleMode === "child") return "researcher_fanout_child";
  if (roleMode === "synth") return "researcher_fanout_synthesis";
  if (reportMode) return tightAnswerContractEnabled() ? "researcher_report_tight" : "researcher_report";
  return "researcher";
}

// L2 (TOKEN-LEVERS-PLAN): tight researcher answer contract, default OFF.
// Selects the researcher_report_tight remote prompt profile for report/
// question research jobs. The remote must ship the tight profile before this
// is flipped on — an unknown profile falls back to the base researcher role
// prompt on old remotes, which is the wrong contract for report jobs.
function tightAnswerContractEnabled() {
  try {
    const value = String(getAccountSetting("atlas_answer_contract_tight") || "off").trim().toLowerCase();
    return value === "on" || value === "true" || value === "1" || value === "yes";
  } catch {
    return false;
  }
}

function isResearchReportMode(workItem, payload, intakeHints) {
  const mode = String(payload?.task_mode || workItem?.mode || "").trim().toLowerCase();
  return mode === "report"
    || mode === "question"
    || intakeHints?.output_mode === "question_only"
    || intakeHints?.deliverable_type === "answer";
}

function truncateForPrompt(value, maxChars, label) {
  const text = String(value || "");
  if (!Number.isFinite(maxChars) || maxChars <= 0 || text.length <= maxChars) return text;
  return `${text.slice(0, maxChars).trimEnd()}\n... (${label} truncated to ${maxChars} chars)`;
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
  const branch = fanoutBranchFromPayload(payload);
  const label = String(branch.label || payload?.fanout_branch_index || "branch").trim();
  const kind = fanoutBranchKind(payload);
  const scopeHints = fanoutBranchScopeHints(payload);
  const focusLines = kind === "web"
    ? [
        "- Kind: web",
        "- Evidence: exact URLs for documentation claims; path:line citations only for repository connections.",
      ]
    : [
        "- Kind: module",
        "- Evidence: exact file paths and line-number citations for claims the synthesizer should rely on.",
      ];

  return [
    "RESEARCH FANOUT CHILD ROUTE:",
    "- Prompt profile: researcher_fanout_child",
    `- Branch: ${label}`,
    `- Fanout run: ${payload?.fanout_run_id || "(unknown)"}`,
    ...focusLines,
    `- Output target: branch evidence packet, <= ${FANOUT_CHILD_EVIDENCE_TOKEN_TARGET} tokens.`,
    "- Preserve uncertainty/contradictions; synthesis owns the planner-ready brief.",
    "- Web budget: at most 2 searches and 3 fetches unless evidence is insufficient.",
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
    "RESEARCH FANOUT SYNTHESIS ROUTE:",
    "- Prompt profile: researcher_fanout_synthesis",
    `- Fanout run: ${payload?.fanout_run_id || "(unknown)"}`,
    shadowText,
    `- Output target: one planner-ready brief, <= ${FANOUT_SYNTHESIS_TOKEN_TARGET} tokens unless critical evidence needs more space.`,
    "- Preserve code citations and URL citations as distinct evidence classes.",
    "- Re-read disputed cited files/lines before relying on them.",
    "- If contradictions remain unresolved, include needs_review with conflicting evidence.",
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
    const fanoutScopeHints = fanoutBranchScopeHints(payload);
    const focusedFanoutChild = roleMode === "child" && fanoutScopeHints.length > 0;
    const researchBudget = this.deps?.isDeepthinkTask && !this.deps?.getResearchBudget
      ? researchBudgetFromDeepthink(isDeepthinkTask(workItem, payload))
      : getResearchBudget(workItem, payload);
    const deepthink = isResearchBudgetDeep(researchBudget);
    const intakeHints = getWorkItemIntakeHints(workItem, workItem?.mode || "build");
    const reportMode = roleMode === "solo" && isResearchReportMode(workItem, payload, intakeHints);
    const promptProfile = researchPromptProfile(roleMode, { reportMode });
    const workflowModeBlock = buildWorkflowModeBlock(getWorkItemWorkflowConfig(workItem), this.getRole());
    const webFetchCachePreload = buildWebFetchCachePreload(job.work_item_id);

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
    const shouldRenderAtlasHandoff = (roleMode !== "synth" && !webOnlyAnswer && !focusedFanoutChild) || synthNeedsVerificationHandoff;
    const researcherExecProvider = ctx.providerName || currentExecutionProvider(job);
    const researcherAttempts = getAttempts(job.id);
    const packetFields = {
      job_type: job.job_type,
      work_item_id: job.work_item_id,
      job_id: job.id,
      title: job.title,
      model_tier: ctx.tier || job.model_tier || "standard",
      reasoning_effort: job.reasoning_effort || "medium",
      prompt_profile: promptProfile,
      research_role_mode: roleMode,
      research_budget: researchBudget,
      memory_mode: atlasMemoryEnabled() ? "on" : "off",
      fanout_context: roleMode === "child" || roleMode === "synth"
        ? {
            run_id: fanoutRunId,
            mode: payload.fanout_mode || null,
            shadow: payload.fanout_shadow === true,
            role_mode: roleMode,
            branch: roleMode === "child" ? fanoutBranchFromPayload(payload) : null,
            branches: roleMode === "synth" && Array.isArray(payload.fanout_branches) ? payload.fanout_branches : [],
            child_job_ids: childJobIds,
            prompt_tax_policy: roleMode === "child" ? "branch_evidence_packet" : "planner_ready_synthesis",
            output_token_target: roleMode === "child" ? FANOUT_CHILD_EVIDENCE_TOKEN_TARGET : FANOUT_SYNTHESIS_TOKEN_TARGET,
          }
        : null,
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
    const projectContextLimit = roleMode === "child" ? FANOUT_CHILD_DESCRIPTION_CHAR_LIMIT : 4000;
    const projectContext = truncateForPrompt(payload.task_spec || workItem.description || "", projectContextLimit, "fanout child context");
    if (shouldRenderAtlasHandoff) {
      researcherPacket = await handoff({
        recipient: this.getRole(),
        data: {
          // Prefetch runs inside handoff. Supply machine identity before that
          // work begins so materialized Atlas evidence can be owned by this
          // job and exposed as durable fetch_ref cursor pages. The remote
          // request compiler keeps these fields out of researcher prompts.
          ...packetFields,
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
        context_hints: {
          disableAtlas: true,
          ...(focusedFanoutChild ? { focusedFanoutChild: true } : {}),
        },
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
    const includeResearchPreload = roleMode !== "synth" && !focusedFanoutChild;
    const hintedPreload = includeResearchPreload
      ? buildResearchIntakePreload(projectDir, intakeHints, {
          atlasCoveredFiles: collectAtlasCoveredFiles(researcherPacket),
        })
      : "";

    Object.assign(ctx, {
      deepthink,
      childJobIds,
      fanoutRunId,
      payload,
      projectDir,
      promptProfile,
      researchBudget,
      researchReportMode: reportMode,
      researchRetrySynthesisMode: retrySynthesisMode,
      researchRoleMode: roleMode,
      researcherPacket,
      workItem,
    });

    const descriptionText = roleMode === "child"
      ? truncateForPrompt(workItem.description || "(none)", FANOUT_CHILD_DESCRIPTION_CHAR_LIMIT, "description")
      : workItem.description || "(none)";
    const researchRequest = payload.instructions || payload.task_spec || job.title;
    const requestDuplicatesDescription = roleMode !== "child"
      && String(researchRequest || "").trim() === String(workItem.description || "").trim();

    return [
      reportMode
        ? "Research the assigned task and return a thorough, concise report. Cover every requested aspect and support material claims with evidence."
        : "Research the following topic for a development work item.",
      "",
      promptLiteral("WORK ITEM", workItem.title),
      promptLiteral("DESCRIPTION", descriptionText),
      roleMode === "child" ? "" : workflowModeBlock,
      includeResearchPreload && hintedPreload ? `${hintedPreload}\n` : "",
      roleMode !== "synth" && !focusedFanoutChild && webFetchCachePreload ? `${webFetchCachePreload}\n` : "",
      webOnlyAnswer ? buildWebOnlyAnswerBlock(payload) : "",
      roleMode === "child" ? buildFanoutChildBlock(payload) : "",
      roleMode === "synth" ? buildFanoutSynthBlock(payload, childBriefs) : "",
      assessmentReplanEvidenceBlock,
      atlasHandoffBlock || null,
      retrySynthesisMode ? buildResearchRetryShapeBlock({ atlasActive: !!researcherPacket?.atlas?.active }) : "",
      payloadRetrySynthesisMode
        ? reportMode
          ? "TURN-BUDGET RETRY MODE:\nPrevious research exceeded a deterministic turn/tool budget. Produce the concise finished report now from available context and salvage; make only a targeted verification read if essential to an assigned goal. Do not produce a planner brief or structured appendix.\n"
          : "TURN-BUDGET RETRY MODE:\nPrevious research exceeded a deterministic turn/tool budget. Produce a partial planner-ready brief from available context and salvage; only make targeted verification reads if absolutely necessary.\n"
        : "",
      priorResearch ? `${reportMode ? "PRIOR RESEARCH REPORT" : "PRIOR RESEARCH BRIEF"}:\n${priorResearch}\n` : "",
      humanAnswers ? `HUMAN ANSWERS (to your previous questions):\n${humanAnswers}\n` : "",
      priorAttemptLogs ? `PRIOR ATTEMPT (ran out of turns - do NOT repeat these reads, summarize your findings promptly):\n${priorAttemptLogs}\n` : "",
      retrySalvageBlock ? `${retrySalvageBlock}\n` : "",
      loadNudges(job.id, { attemptId: ctx.attemptId }),
      requestDuplicatesDescription ? "" : promptLiteral("RESEARCH REQUEST", researchRequest),
    ].filter(Boolean).join("\n");
  }

  buildContract() {
    // All researcher prompt text is remote-owned: the role prompt
    // (prompts/roles/researcher.md), the researcher-output contract
    // (prompts/contracts/researcher-output.md), and the ATLAS tools contract
    // are compiled into the system prompt by the remote prompt compiler.
    // Retrieval/coverage directives live once on the relay's ATLAS contract;
    // investigation discipline + the scope_estimate appendix field moved to the
    // role prompt/contract. This role carries no local directive text (matches
    // the artificer pattern).
    return "";
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
      promptProfile: ctx.promptProfile || researchPromptProfile(roleMode, { reportMode: !!ctx.researchReportMode }),
      allowWrite: false,
      modelTier: ctx.tier,
      reasoningEffort: researchBudgetToReasoningEffort(researchBudget, job.reasoning_effort || "medium"),
      deepthink: isResearchBudgetDeep(researchBudget),
      ...(effectiveMaxTurns ? { maxTurns: effectiveMaxTurns } : {}),
      activity: `${activityPrefix}: ${shortJobTitle(job).replace(/^Research(?:\s*\((?:self-resolve|follow-up|[^)]*)\))?:\s*/i, "").slice(0, 40)}`,
      stableContext: ctx.researcherPacket?.stable_context || null,
      remoteSystemPrompt: ctx.researcherPacket?.remote_system_prompt || null,
      atlasPrefetchStatus: ctx.researcherPacket?.atlas?.prefetchStatus || null,
      sessionPacket: ctx.researcherPacket || null,
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
    output = sanitizeResearcherStructuredOutput(output);
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
    if (output && !isChildBranch && atlasMemoryEnabled()) {
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
