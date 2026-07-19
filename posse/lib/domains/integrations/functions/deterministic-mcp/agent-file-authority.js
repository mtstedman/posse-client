// @ts-check

import path from "node:path";
import { ACTIVE_LEASE_STATUSES } from "../../../../catalog/job.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../../../catalog/work-item.js";
import { isInsideRoot } from "../../../runtime/functions/fs-safety.js";
import { isArtifactMode } from "../../../artifacts/functions/index.js";
import {
  getAgentCallById,
  getJob,
  getWorkItem,
} from "../../../queue/functions/index.js";
import { parseJobPayload } from "../../../queue/functions/payload.js";

const ACTIVE_JOB_STATUS_SET = new Set(ACTIVE_LEASE_STATUSES);
const TERMINAL_WORK_ITEM_STATUS_SET = new Set(TERMINAL_WORK_ITEM_STATUSES);
const CODE_WORKTREE_JOB_TYPES = new Set(["dev", "fix"]);
const WI_RESOURCE_CATEGORIES = Object.freeze(["artifacts", "workspace", "inputs", "context"]);

function authorityError(code, message) {
  const error = /** @type {Error & { code: string }} */ (new Error(message));
  error.code = code;
  return error;
}

function requiredId(value, label) {
  const id = Number(value);
  if (!Number.isSafeInteger(id) || id <= 0) {
    throw authorityError("POSSE_AGENT_AUTHORITY_INVALID", `Agent attachment requires a valid ${label}`);
  }
  return id;
}

function idsMatch(expected, actual, label) {
  if (Number(expected) !== Number(actual)) {
    throw authorityError(
      "POSSE_AGENT_AUTHORITY_MISMATCH",
      `Agent attachment ${label} does not match its persisted ownership chain`,
    );
  }
}

function normalizedRole(value) {
  const role = String(value || "").trim().toLowerCase();
  return role === "developer" || role === "development" || role === "fix" ? "dev" : role;
}

function requiredPath(value, label) {
  const raw = String(value || "").trim();
  if (!raw || raw.includes("\0")) {
    throw authorityError("POSSE_AGENT_AUTHORITY_INVALID", `Agent contract requires a valid ${label}`);
  }
  return path.resolve(raw);
}

function samePath(left, right) {
  return isInsideRoot(left, right) && isInsideRoot(right, left);
}

function isInsideAny(target, roots) {
  return roots.some((root) => isInsideRoot(target, root));
}

function stringList(value, label) {
  if (value == null) return [];
  if (!Array.isArray(value)) {
    throw authorityError("POSSE_AGENT_AUTHORITY_INVALID", `Persisted Job ${label} must be an array`);
  }
  const out = [];
  for (const entry of value) {
    if (typeof entry !== "string" || !entry.trim() || entry.includes("\0")) {
      throw authorityError("POSSE_AGENT_AUTHORITY_INVALID", `Persisted Job ${label} contains an invalid path`);
    }
    const normalized = entry.trim();
    if (!out.includes(normalized)) out.push(normalized);
  }
  return out;
}

function authorityRoots({ projectRoot, resourcesRoot, workItemId }) {
  const worktreeRoot = path.join(projectRoot, ".posse-worktrees");
  const worktree = path.join(worktreeRoot, `wi-${workItemId}`);
  const wiResources = Object.freeze(Object.fromEntries(
    WI_RESOURCE_CATEGORIES.map((category) => [
      category,
      path.join(resourcesRoot, category, `wi-${workItemId}`),
    ]),
  ));
  return Object.freeze({
    projectRoot,
    resourcesRoot,
    worktreeRoot,
    worktree,
    wiResources,
    wiResourceRoots: Object.freeze(Object.values(wiResources)),
    wiWriteRoots: Object.freeze([wiResources.artifacts, wiResources.workspace]),
  });
}

function pathAllowedForWorkItem(target, roots) {
  if (isInsideAny(target, roots.wiResourceRoots)) return true;
  if (isInsideRoot(target, roots.resourcesRoot)) return false;
  if (isInsideRoot(target, roots.worktree)) return true;
  if (isInsideRoot(target, roots.worktreeRoot)) return false;
  return isInsideRoot(target, roots.projectRoot);
}

function assertRuntimeCwd({ cwd, job, payload, role, roots }) {
  const taskMode = String(payload.task_mode || "code").trim().toLowerCase();
  const artifactMode = job.job_type === "artificer" || isArtifactMode(taskMode);
  const outputRoot = payload.output_root
    ? path.resolve(roots.projectRoot, String(payload.output_root))
    : null;

  if (CODE_WORKTREE_JOB_TYPES.has(String(job.job_type || "")) && taskMode === "code") {
    if (!samePath(cwd, roots.worktree)) {
      throw authorityError(
        "POSSE_AGENT_AUTHORITY_ROOT_MISMATCH",
        `Job #${job.id} must execute in Work Item #${job.work_item_id}'s worktree`,
      );
    }
    return { artifactMode, outputRoot };
  }

  if (artifactMode && outputRoot) {
    if (!isInsideAny(outputRoot, roots.wiWriteRoots)) {
      throw authorityError(
        "POSSE_AGENT_AUTHORITY_SCOPE_ESCAPE",
        `Job #${job.id} output_root escapes Work Item #${job.work_item_id}'s artifact boundary`,
      );
    }
    const mustUseOutputRoot = job.job_type === "artificer" || role === "assessor";
    if (mustUseOutputRoot && !samePath(cwd, outputRoot)) {
      throw authorityError(
        "POSSE_AGENT_AUTHORITY_ROOT_MISMATCH",
        `Job #${job.id} must execute in its persisted output_root`,
      );
    }
    if (CODE_WORKTREE_JOB_TYPES.has(String(job.job_type || "")) && role === "dev" && !samePath(cwd, roots.projectRoot)) {
      throw authorityError(
        "POSSE_AGENT_AUTHORITY_ROOT_MISMATCH",
        `Artifact Job #${job.id} must execute from its project root`,
      );
    }
    if (!pathAllowedForWorkItem(cwd, roots)) {
      throw authorityError("POSSE_AGENT_AUTHORITY_SCOPE_ESCAPE", "Agent runtime cwd escapes its Work Item boundary");
    }
    return { artifactMode, outputRoot };
  }

  if (artifactMode && (job.job_type === "artificer" || role === "assessor")) {
    throw authorityError(
      "POSSE_AGENT_AUTHORITY_INVALID",
      `Artifact Job #${job.id} has no persisted output_root`,
    );
  }
  if (!pathAllowedForWorkItem(cwd, roots)) {
    throw authorityError("POSSE_AGENT_AUTHORITY_SCOPE_ESCAPE", "Agent runtime cwd escapes its Work Item boundary");
  }
  return { artifactMode, outputRoot };
}

function assertPathsWithin(paths, { cwd, allowedRoots, label, rejectBroadRoot = false }) {
  for (const entry of paths) {
    const normalized = entry.replace(/\\/g, "/");
    if (rejectBroadRoot && ["*", ".", "./"].includes(normalized)) {
      throw authorityError(
        "POSSE_AGENT_AUTHORITY_SCOPE_ESCAPE",
        `Persisted Job ${label} cannot grant its entire runtime root`,
      );
    }
    const target = path.resolve(cwd, entry);
    if (!isInsideAny(target, allowedRoots)) {
      throw authorityError(
        "POSSE_AGENT_AUTHORITY_SCOPE_ESCAPE",
        `Persisted Job ${label} escapes its Work Item boundary`,
      );
    }
  }
}

/**
 * Resolve file authority at the tool boundary by walking the persisted
 * ownership chain Agent call -> Job -> Work Item. The dispatcher attachment
 * supplies identities only; file paths always come from the live Job row.
 */
export function resolveAgentFileAuthority(attachment = {}, deps = {}) {
  const readAgentCall = deps.getAgentCallById || getAgentCallById;
  const readJob = deps.getJob || getJob;
  const readWorkItem = deps.getWorkItem || getWorkItem;
  const agentCallId = requiredId(attachment.agentCallId, "agentCallId");
  const attachedJobId = requiredId(attachment.jobId, "jobId");
  const attachedWorkItemId = requiredId(attachment.workItemId, "workItemId");
  const call = readAgentCall(agentCallId);
  if (!call) {
    throw authorityError("POSSE_AGENT_AUTHORITY_NOT_FOUND", `Agent call #${agentCallId} no longer exists`);
  }
  if (String(call.status || "") !== "running") {
    throw authorityError(
      "POSSE_AGENT_AUTHORITY_INACTIVE",
      `Agent call #${agentCallId} is not running`,
    );
  }
  idsMatch(attachedJobId, call.job_id, "jobId");
  idsMatch(attachedWorkItemId, call.work_item_id, "workItemId");
  if (attachment.attemptId != null && call.attempt_id != null) {
    idsMatch(attachment.attemptId, call.attempt_id, "attemptId");
  }
  const attachedRole = normalizedRole(attachment.role);
  const callRole = normalizedRole(call.role);
  if (!attachedRole || !callRole || attachedRole !== callRole) {
    throw authorityError(
      "POSSE_AGENT_AUTHORITY_MISMATCH",
      "Agent attachment role does not match its persisted Agent call",
    );
  }

  const job = readJob(attachedJobId);
  if (!job) {
    throw authorityError("POSSE_AGENT_AUTHORITY_NOT_FOUND", `Job #${attachedJobId} no longer exists`);
  }
  idsMatch(attachedWorkItemId, job.work_item_id, "Job workItemId");
  if (!ACTIVE_JOB_STATUS_SET.has(String(job.status || ""))) {
    throw authorityError(
      "POSSE_AGENT_AUTHORITY_INACTIVE",
      `Job #${attachedJobId} no longer owns an active lease`,
    );
  }

  const workItem = readWorkItem(attachedWorkItemId);
  if (!workItem) {
    throw authorityError(
      "POSSE_AGENT_AUTHORITY_NOT_FOUND",
      `Work item #${attachedWorkItemId} no longer exists`,
    );
  }
  if (TERMINAL_WORK_ITEM_STATUS_SET.has(String(workItem.status || ""))) {
    throw authorityError(
      "POSSE_AGENT_AUTHORITY_INACTIVE",
      `Work item #${attachedWorkItemId} is terminal`,
    );
  }

  const payload = parseJobPayload(job);
  const projectRoot = requiredPath(attachment.projectRoot, "projectRoot");
  const resourcesRoot = requiredPath(attachment.resourcesRoot, "resourcesRoot");
  const cwd = requiredPath(attachment.cwd, "runtime cwd");
  const roots = authorityRoots({ projectRoot, resourcesRoot, workItemId: attachedWorkItemId });
  const runtime = assertRuntimeCwd({ cwd, job, payload, role: attachedRole, roots });
  const allowFileWrites = attachment.allowWrite === true;
  const scopedFiles = allowFileWrites ? stringList(payload.files_to_modify, "files_to_modify") : [];
  const createFiles = allowFileWrites ? stringList(payload.files_to_create, "files_to_create") : [];
  const deleteFiles = allowFileWrites ? stringList(payload.files_to_delete, "files_to_delete") : [];
  const createRoots = allowFileWrites ? stringList(payload.create_roots, "create_roots") : [];
  const readRoots = [
    ...stringList(payload.read_roots, "read_roots"),
    ...stringList(payload.input_roots, "input_roots"),
  ];

  const writeRoots = runtime.artifactMode ? roots.wiWriteRoots : [roots.worktree];
  assertPathsWithin(scopedFiles, { cwd, allowedRoots: writeRoots, label: "files_to_modify" });
  assertPathsWithin(createFiles, { cwd, allowedRoots: writeRoots, label: "files_to_create" });
  assertPathsWithin(deleteFiles, { cwd, allowedRoots: writeRoots, label: "files_to_delete" });
  assertPathsWithin(createRoots, {
    cwd,
    allowedRoots: writeRoots,
    label: "create_roots",
    rejectBroadRoot: true,
  });
  for (const entry of readRoots) {
    const target = path.resolve(cwd, entry);
    if (!pathAllowedForWorkItem(target, roots)) {
      throw authorityError(
        "POSSE_AGENT_AUTHORITY_SCOPE_ESCAPE",
        "Persisted Job read scope escapes its Work Item boundary",
      );
    }
  }

  return Object.freeze({
    agentCall: call,
    job,
    workItem,
    scope: Object.freeze({
      scopedFiles: Object.freeze(scopedFiles),
      createFiles: Object.freeze(createFiles),
      deleteFiles: Object.freeze(deleteFiles),
      createRoots: Object.freeze(createRoots),
      readRoots: Object.freeze([...new Set(readRoots)]),
    }),
  });
}
