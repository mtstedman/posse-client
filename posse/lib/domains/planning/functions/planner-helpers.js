// lib/domains/planning/functions/planner-helpers.js
//
// Stateless helpers extracted from the PlannerRole class file. These build
// planner tasks/artifacts and sanitize researcher-provided context paths.
// Pure relocation from classes/roles/planner.js — no logic changes.

import fs from "fs";
import path from "path";
import { C } from "../../../shared/format/functions/colors.js";
import {
  getArtifactsByWorkItem,
  storeArtifact,
} from "../../queue/functions/index.js";
import {
  artifactsDir,
  wiScopeId,
} from "../../artifacts/functions/index.js";
import {
  normalizeResearcherCitationTriage,
  normalizeResearcherFilePriorities,
} from "../../handoff/functions/index.js";
import { resolvePathWithin } from "../../../shared/scope/functions/path.js";
import { isSensitiveEnvFilePath, safePath } from "../../../shared/tools/functions/toolkit/index.js";
import { readProjectDbConfig } from "../../../shared/tools/functions/toolkit/project-db/config.js";
import { normalizeHashRefHandoffPacket } from "../../handoff/functions/helpers/hash-ref-packet.js";

export function emit(worker, jobId, message) {
  if (typeof worker?.emit === "function") {
    worker.emit(jobId, message);
  }
}

// Conditional planner routing lines for the project database. Empty when the
// repo has no enabled project-db config — the block must never add noise to
// repos that haven't opted in. With a write-capable grant the planner is told
// how to emit db-only tasks (task_mode:"db", empty file scope); with a
// read-only grant it is told the tool exists for inspection but db tasks are
// not plannable.
export function buildProjectDbRoutingLines(projectDir) {
  let config = null;
  try {
    config = readProjectDbConfig({ projectDir });
  } catch {
    return [];
  }
  if (!config?.enabled || !config.dbType || config.permissions.length === 0) return [];
  const grants = config.permissions.join(", ");
  const label = `${config.dbType}${config.database ? ` "${config.database}"` : ""}`;
  const writeCapable = config.permissions.some((perm) => perm !== "read");
  if (!writeCapable) {
    return [
      `- Project database: ${label} is queryable read-only via project_db_query (grants: ${grants}). Use it to inspect data while planning, but do NOT emit task_mode "db" tasks — no write grant is configured.`,
    ];
  }
  return [
    `- Project database: ${label} is writable via project_db_query (grants: ${grants}).`,
    "- For work whose ENTIRE change is database rows/schema (within those grants), emit ONE dev task with task_mode \"db\" and EMPTY file scope (no files_to_modify/files_to_create/files_to_delete/create_roots). The dev's only write surface is project_db_query; state the intended statements/outcomes in task_spec and make success_criteria verifiable with SELECT.",
    "- db tasks cannot touch repo files. If work needs both repo edits and database changes, plan separate tasks (code task + db task).",
  ];
}

export function normalizePlannerRoleMode(value) {
  const raw = String(value || "normal").trim().toLowerCase();
  return ["normal", "primary", "redteam", "synth"].includes(raw) ? raw : "normal";
}

export function isQuestionOnlyBinding(explicitBindings = {}) {
  const desiredOutputs = Array.isArray(explicitBindings.desiredOutputs)
    ? explicitBindings.desiredOutputs
    : [];
  return explicitBindings.outputMode === "question_only"
    || explicitBindings.deliverableType === "answer"
    || desiredOutputs.includes("question_only");
}

export function buildQuestionAnswerTask({ workItem, job, projectDir, reason = "" } = {}) {
  const artifactDir = artifactsDir(wiScopeId(job.work_item_id), projectDir).replace(/\\/g, "/");
  return {
    title: `Answer: ${String(workItem?.title || job.title || "Question").replace(/^Plan:\s*/i, "")}`.slice(0, 120),
    job_type: "artificer",
    task_mode: "report",
    task_spec: [
      "Write a concise answer brief for the user's question.",
      "Use the researcher/planner context already staged for this work item as source material.",
      "Do not edit repository source files.",
      "Create answer.md in output_root so the final answer is visible as a user-facing artifact.",
      reason ? `Planner no-task reason to account for: ${reason}` : null,
      "",
      `Question/title: ${workItem?.title || ""}`,
      workItem?.description ? `Question/details: ${workItem.description}` : null,
    ].filter(Boolean).join("\n"),
    files_to_modify: [],
    files_to_create: ["answer.md"],
    files_to_delete: [],
    create_roots: [artifactDir],
    output_root: artifactDir,
    success_criteria: [
      "answer.md exists under output_root",
      "answer.md directly answers the user's question using available evidence",
    ],
    depends_on_index: [],
  };
}

export function queueQuestionAnswerTask(worker, job, ctx, { reason = "", output = "", storeResponse = false } = {}) {
  const answerTask = buildQuestionAnswerTask({
    workItem: ctx.workItem,
    job,
    projectDir: worker.projectDir,
    reason,
  });
  emit(worker, job.id, `${C.cyan}[planner]${C.reset} WI#${job.work_item_id}: queued visible answer brief`);
  if (storeResponse) {
    storeArtifact({
      work_item_id: job.work_item_id,
      job_id: job.id,
      attempt_id: ctx.attemptId,
      artifact_type: "response",
      content_long: output,
    });
  }
  storeArtifact({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: ctx.attemptId,
    artifact_type: "summary",
    content_long: `Planner: question-only answer brief required. ${reason}`,
  });
  worker.createJobsFromPlan(job, [answerTask]);
}

export function researcherPathFromValue(value) {
  if (typeof value === "string") return value;
  if (value && typeof value.path === "string") return value.path;
  return "";
}

export function sanitizeResearcherFileList(values, projectDir, field) {
  const files = [];
  const dropped = [];
  const seen = new Set();
  const list = Array.isArray(values) ? values : [];

  const drop = (value, reason) => {
    dropped.push({
      field,
      path: researcherPathFromValue(value) || String(value ?? ""),
      reason,
    });
  };

  for (const value of list) {
    const raw = researcherPathFromValue(value).trim();
    if (!raw) {
      drop(value, "empty");
      continue;
    }
    if (raw.includes("\0")) {
      drop(value, "nul_byte");
      continue;
    }

    const slashPath = raw.replace(/\\/g, "/");
    if (path.isAbsolute(raw) || path.posix.isAbsolute(slashPath) || /^[A-Za-z]:\//.test(slashPath)) {
      drop(value, "absolute_path");
      continue;
    }

    const normalized = path.posix.normalize(slashPath).replace(/^\.\//, "");
    if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) {
      drop(value, "path_traversal");
      continue;
    }
    if (isSensitiveEnvFilePath(normalized)) {
      drop(value, "sensitive_env");
      continue;
    }
    const parts = normalized.toLowerCase().split("/").filter(Boolean);
    if (parts.some((part) => part === ".git" || part === ".claude" || part === ".codex")) {
      drop(value, "private_workspace_metadata");
      continue;
    }
    if (parts[0] === ".posse" && parts[1] !== "resources") {
      drop(value, "private_workspace_metadata");
      continue;
    }

    const resolved = resolvePathWithin(projectDir, normalized, { allowEqual: false });
    if (!resolved) {
      drop(value, "outside_project_scope");
      continue;
    }
    try {
      safePath(projectDir, normalized);
    } catch {
      drop(value, "private_workspace_metadata");
      continue;
    }

    const rel = path.relative(projectDir, resolved).replace(/\\/g, "/");
    if (!rel || rel === "." || seen.has(rel)) continue;
    seen.add(rel);
    files.push(rel);
  }

  return { files, dropped };
}

export function sanitizeResearcherFilePriorities(parsed, projectDir) {
  const files = [];
  const dropped = [];
  const seen = new Set();
  const priorities = normalizeResearcherFilePriorities(parsed);

  for (const entry of priorities) {
    const sanitized = sanitizeResearcherFileList([entry.path], projectDir, "planner_file_priorities");
    dropped.push(...sanitized.dropped);
    const rel = sanitized.files[0];
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    files.push({
      ...entry,
      path: rel,
      rank: files.length + 1,
    });
  }

  return { files, dropped };
}

export function oneLine(value, max = 180) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isAtlasPlannerDevBrief(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (value.atlas === true || value.atlas_backed === true) return true;
  const source = String(value.source || value.evidence_source || value.brief_source || "")
    .trim()
    .toLowerCase();
  return source === "atlas" || source === "atlas_hash_refs" || source === "hash_ref_store";
}

function briefText(value, max = 1200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function sanitizePlannerDevBrief(value, projectDir) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { brief: null, droppedFiles: [], droppedHashRefs: [] };
  }
  if (!isAtlasPlannerDevBrief(value)) {
    return { brief: null, droppedFiles: [], droppedHashRefs: [] };
  }

  const keyFiles = sanitizeResearcherFileList(value.key_files, projectDir, "dev_brief.key_files");
  const relatedFiles = sanitizeResearcherFileList(value.related_files, projectDir, "dev_brief.related_files");
  const priorities = sanitizeResearcherFilePriorities(
    { planner_file_priorities: value.planner_file_priorities },
    projectDir,
  );
  const triage = normalizeResearcherCitationTriage({
    synthesis: value.synthesis || value.summary || "",
    proof: value.proof,
    support: value.support,
    decoy: value.decoy,
  }, {
    maxRefsPerLane: 16,
    maxWhyChars: 180,
  });

  const summary = briefText(value.summary || value.synthesis || value.task_summary || "");
  const brief = {
    source: "atlas",
  };
  if (summary) brief.summary = summary;
  if (keyFiles.files.length > 0) brief.key_files = keyFiles.files;
  if (relatedFiles.files.length > 0) brief.related_files = relatedFiles.files;
  if (priorities.files.length > 0) brief.planner_file_priorities = priorities.files;
  for (const lane of ["proof", "support", "decoy"]) {
    if (triage[lane]?.length > 0) brief[lane] = triage[lane];
  }
  const hashRefPacket = normalizeHashRefHandoffPacket({
    source: "atlas",
    destination: "handoff",
    synthesis: value.synthesis || value.summary || "",
    proof: triage.proof,
    support: triage.support,
    decoy: triage.decoy,
  });

  const hasSubstance = Object.keys(brief).some((key) => key !== "source");
  return {
    brief: hasSubstance ? brief : null,
    hashRefPacket: hashRefPacket.packet,
    droppedFiles: [
      ...keyFiles.dropped,
      ...relatedFiles.dropped,
      ...priorities.dropped,
    ],
    droppedHashRefs: [
      ...triage.dropped,
      ...hashRefPacket.dropped,
    ],
  };
}

export function renderPlannerFilePriorities(entries) {
  if (!Array.isArray(entries) || entries.length === 0) return "";
  return [
    "# Planner File Priorities",
    "",
    "Researcher-ranked files for planning order and scope. Use these as the first read targets, then fall back to the full brief when detail is missing.",
    "",
    ...entries.map((entry) => {
      const details = [
        entry.usefulness && entry.usefulness !== "unspecified" ? `usefulness=${oneLine(entry.usefulness, 60)}` : "",
        entry.evidence && entry.evidence !== "unspecified" ? `evidence=${oneLine(entry.evidence, 60)}` : "",
        entry.reason ? oneLine(entry.reason, 200) : "",
      ].filter(Boolean);
      return `${entry.rank}. ${entry.path}${details.length > 0 ? ` - ${details.join("; ")}` : ""}`;
    }),
    "",
  ].join("\n");
}

export function latestPlanArtifactText(workItemId, jobId, preferredTypes = []) {
  if (!jobId) return "";
  const artifacts = getArtifactsByWorkItem(workItemId)
    .filter((artifact) => Number(artifact.job_id) === Number(jobId));
  for (const type of preferredTypes) {
    const match = artifacts
      .filter((artifact) => artifact.artifact_type === type)
      .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
    if (match?.content_long) return match.content_long;
  }
  const fallback = artifacts
    .filter((artifact) => artifact.content_long)
    .sort((a, b) => Number(b.id || 0) - Number(a.id || 0))[0];
  return fallback?.content_long || "";
}

export function buildPlanSynthesisArtifact(ctx, output) {
  return [
    "# Red-Team Planning Synthesis",
    "",
    `work_item_id: ${ctx.workItem?.id ?? "unknown"}`,
    `primary_plan_job_id: ${ctx.payload?.primary_plan_job_id ?? "unknown"}`,
    `red_team_plan_job_id: ${ctx.payload?.red_team_plan_job_id ?? "unknown"}`,
    "",
    "## Primary Planner Output",
    ctx.primaryPlanText || "(missing)",
    "",
    "## Red-Team Planner Output",
    ctx.redTeamPlanText || "(missing)",
    "",
    "## Synthesized Write-Layer Plan",
    output || "(empty)",
  ].join("\n");
}

export function failPlannerContextPreflight(worker, job, attemptId, detail) {
  const message = `Planner handoff preflight failed: ${detail}`;
  emit(worker, job.id, `${C.red}[context]${C.reset} WI#${job.work_item_id}: ${message}`);
  storeArtifact({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId,
    artifact_type: "summary",
    content_long: message,
  });
  storeArtifact({
    work_item_id: job.work_item_id,
    job_id: job.id,
    attempt_id: attemptId,
    artifact_type: "response",
    content_long: `PLANNER_CONTEXT_ERROR: ${detail}`,
  });
  throw new Error(message);
}

export function validatePlannerContextPreflight(worker, job, attemptId, { fastDir, researchArtifacts }) {
  if (!Array.isArray(researchArtifacts) || researchArtifacts.length === 0) return;

  const briefPath = path.join(fastDir, "brief.md");
  let briefStat = null;
  try {
    briefStat = fs.statSync(briefPath);
  } catch (err) {
    const reason = err?.code === "ENOENT"
      ? "missing fast/brief.md"
      : `unable to stat fast/brief.md (${err?.code || "unknown"}: ${err?.message?.split("\n")[0]?.slice(0, 120) || "no detail"})`;
    failPlannerContextPreflight(worker, job, attemptId, reason);
  }
  if (!briefStat?.isFile()) {
    failPlannerContextPreflight(worker, job, attemptId, "fast/brief.md is not a regular file");
  }
  if (briefStat.size <= 0) {
    failPlannerContextPreflight(worker, job, attemptId, "fast/brief.md is empty");
  }

  let briefContent = "";
  try {
    briefContent = fs.readFileSync(briefPath, "utf-8");
  } catch (err) {
    const reason = `unable to read fast/brief.md (${err?.code || "unknown"}: ${err?.message?.split("\n")[0]?.slice(0, 120) || "no detail"})`;
    failPlannerContextPreflight(worker, job, attemptId, reason);
  }
  if (!String(briefContent || "").trim()) {
    failPlannerContextPreflight(worker, job, attemptId, "fast/brief.md is blank");
  }
}
