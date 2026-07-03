import fs from "fs";
import path from "path";
import { C } from "../../../shared/format/functions/colors.js";
import {
  getAgentCallsByWorkItem,
  getArtifacts,
  getJob,
  listJobs,
  listJobsByWorkItem,
  listWorkItems,
} from "../../queue/functions/index.js";
import { getObservationsByJob } from "../../observability/functions/observations.js";
import { dirSizeBytes, worktreeRoot } from "../../git/functions/worktree.js";
import { gitExec } from "../../git/functions/utils.js";
import { ACTIVE_LEASE_STATUSES, COMPLETED_OUTCOME_JOB_STATUSES } from "../../../catalog/job.js";

const AUDIT_RECENT_JOB_STATUSES = new Set([
  ...COMPLETED_OUTCOME_JOB_STATUSES,
  ...ACTIVE_LEASE_STATUSES,
]);

function truncateAudit(text, max = 180) {
  const value = String(text || "").replace(/\s+/g, " ").trim();
  if (!value) return "";
  return value.length > max ? `${value.slice(0, max - 3)}...` : value;
}

function safeJson(value, fallback = null) {
  try { return value ? JSON.parse(value) : fallback; } catch { return fallback; }
}

function parseAuditArg(value) {
  const raw = String(value || "").trim();
  if (!raw) return { kind: "recent", id: null };
  if (/^wi[:#-]?\d+$/i.test(raw)) return { kind: "wi", id: parseInt(raw.replace(/\D+/g, ""), 10) };
  if (/^job[:#-]?\d+$/i.test(raw)) return { kind: "job", id: parseInt(raw.replace(/\D+/g, ""), 10) };
  if (/^\d+$/.test(raw)) return { kind: "job", id: parseInt(raw, 10) };
  return { kind: "recent", id: null };
}

function auditJobsForSelection(selector) {
  const parsed = parseAuditArg(selector);
  if (parsed.kind === "job") {
    const job = getJob(parsed.id);
    return job ? [job] : [];
  }
  if (parsed.kind === "wi") {
    return listJobsByWorkItem(parsed.id);
  }
  return listJobs()
    .filter((job) => AUDIT_RECENT_JOB_STATUSES.has(job.status))
    .slice(-8);
}

function runWorktreeAudit({ projectDir, targetBranch }) {
  const wis = new Map(listWorkItems().map((wi) => [wi.id, wi]));
  const wtRoot = worktreeRoot(projectDir);
  if (!fs.existsSync(wtRoot)) {
    console.log(`\n  ${C.dim}No worktrees found under ${wtRoot}.${C.reset}\n`);
    return;
  }

  const entries = fs.readdirSync(wtRoot, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const toMB = (bytes) => `${(Number(bytes || 0) / (1024 * 1024)).toFixed(1)}MB`;
  console.log(`\n  ${C.bold}Worktree Audit${C.reset}\n`);
  for (const entry of entries) {
    const wtPath = path.join(wtRoot, entry.name);
    const wiMatch = entry.name.match(/^wi-(\d+)(?:-|$)/);
    const wiId = wiMatch ? Number(wiMatch[1]) : null;
    const wi = wiId != null ? wis.get(wiId) : null;
    let branch = "?";
    let dirty = false;
    let mergeInProgress = false;
    let aheadBehind = null;
    try {
      branch = gitExec(["branch", "--show-current"], wtPath).trim() || "?";
      dirty = gitExec(["status", "--porcelain"], wtPath).trim().length > 0;
      mergeInProgress = gitExec(["rev-parse", "--verify", "MERGE_HEAD"], wtPath).trim().length > 0;
    } catch {
      // best effort
    }
    try {
      const counts = gitExec(["rev-list", "--left-right", "--count", `${targetBranch}...HEAD`], wtPath).trim();
      aheadBehind = counts.replace(/\s+/, "/");
    } catch {
      // best effort
    }
    const health = wi == null
      ? "orphaned"
      : mergeInProgress
        ? "merge-in-progress"
        : dirty
          ? "dirty"
          : "clean";
    const expected = wi?.branch_name || "?";
    const status = wi?.status || "no-wi";
    console.log(`  ${C.bold}${entry.name}${C.reset}  ${C.dim}[${health}]${C.reset}`);
    console.log(`    wi=${wiId ?? "?"} status=${status} branch=${branch} expected=${expected}`);
    if (aheadBehind) console.log(`    target-delta (behind/ahead vs ${targetBranch}): ${aheadBehind}`);
    console.log(`    size=${toMB(dirSizeBytes(wtPath))} path=${wtPath}`);
  }
  console.log("");
}

export function runAuditCommand(args = [], { projectDir = process.cwd(), targetBranch = "main" } = {}) {
  const auditArgs = args.filter(Boolean).map((arg) => String(arg).toLowerCase());
  if (auditArgs[0] === "worktrees") {
    runWorktreeAudit({ projectDir, targetBranch });
    return;
  }

  const jobs = auditJobsForSelection(args[0]);
  if (jobs.length === 0) {
    console.log(`\n  No matching jobs for audit.\n`);
    if (args[0]) process.exitCode = 2;
    return;
  }

  const workItemCalls = new Map();
  for (const job of jobs) {
    if (!workItemCalls.has(job.work_item_id)) {
      workItemCalls.set(job.work_item_id, getAgentCallsByWorkItem(job.work_item_id));
    }
  }

  console.log(`\n  ${C.bold}Runtime Audit${C.reset}\n`);
  for (const job of jobs) {
    const payload = safeJson(job.payload_json, {});
    const observations = getObservationsByJob(job.id, 20).reverse();
    const artifacts = getArtifacts(job.id).slice(-6);
    const calls = (workItemCalls.get(job.work_item_id) || []).filter((call) => call.job_id === job.id).slice(-6);

    console.log(`  ${C.bold}Job #${job.id}${C.reset} WI#${job.work_item_id} ${job.job_type} ${C.dim}(${job.status})${C.reset}`);
    console.log(`    ${C.dim}${truncateAudit(job.title, 120)}${C.reset}`);
    if (payload.task_mode || payload.output_root || payload.needs_image_generation) {
      const flags = [
        payload.task_mode ? `mode=${payload.task_mode}` : null,
        payload.needs_image_generation ? "needs_image_generation=true" : null,
        payload.output_root ? `output_root=${truncateAudit(payload.output_root, 80)}` : null,
      ].filter(Boolean);
      if (flags.length > 0) console.log(`    contract: ${flags.join(" | ")}`);
    }
    if ((payload.files_to_modify || []).length > 0) console.log(`    files_to_modify: ${JSON.stringify(payload.files_to_modify)}`);
    if ((payload.files_to_create || []).length > 0) console.log(`    files_to_create: ${JSON.stringify(payload.files_to_create)}`);

    const contractObservations = observations.filter((obs) => !String(obs.observation_type || "").startsWith("tool."));
    const toolObservations = observations.filter((obs) => String(obs.observation_type || "").startsWith("tool."));

    if (contractObservations.length > 0) {
      console.log(`    ${C.bold}Observations${C.reset}`);
      for (const obs of contractObservations) {
        const detail = safeJson(obs.detail_json, null);
        const extra = detail?.provider_pool ? ` pool=${JSON.stringify(detail.provider_pool)}` : "";
        console.log(`      ${obs.observation_type}: ${truncateAudit(obs.summary, 120)}${extra}`);
      }
    }

    if (toolObservations.length > 0) {
      console.log(`    ${C.bold}Tools${C.reset}`);
      for (const obs of toolObservations) {
        console.log(`      ${obs.observation_type}: ${truncateAudit(obs.summary, 120)}`);
      }
    }

    if (calls.length > 0) {
      console.log(`    ${C.bold}Agent Calls${C.reset}`);
      for (const call of calls) {
        const dur = call.duration_ms ? `${(call.duration_ms / 1000).toFixed(1)}s` : "...";
        console.log(`      ${call.role} ${call.provider}/${call.model_name || call.model_tier} ${call.status} ${dur}`);
      }
    }

    if (artifacts.length > 0) {
      console.log(`    ${C.bold}Artifacts${C.reset}`);
      for (const artifact of artifacts) {
        console.log(`      ${artifact.artifact_type}: ${truncateAudit(artifact.content_long || artifact.content_json || "", 160)}`);
      }
    }

    console.log();
  }
}
