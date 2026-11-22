import fs from "node:fs";
import path from "node:path";

import { getDb } from "../../../../shared/storage/functions/index.js";
import { gitExecAsync } from "../../../git/functions/utils.js";
import {
  isSensitiveEnvRepoPath,
  normalizeRepoRelativePath,
  validateMutableRepoPath,
} from "../../../runtime/functions/protected-paths.js";
import { resolvePathWithin } from "../../../../shared/scope/functions/path.js";
import { DIRTY_WORKTREE_RECOVERY_KEY, PRESERVED_WORK_RESUME_KEY } from "../../../../catalog/human-input.js";
import { DEV_ROLE_JOB_TYPES } from "../../../../catalog/job.js";

function uniquePaths(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeRepoRelativePath)
    .filter(Boolean))];
}

function materializationError(message, details = {}) {
  const error = new Error(message);
  error.code = "HANDOFF_FILE_MATERIALIZATION_FAILED";
  error.handoffNeedsReplan = true;
  error.assessmentRetryable = false;
  Object.assign(error, details);
  return error;
}

function assertSafeRelativePath(cwd, relPath, label) {
  if (
    !relPath
    || path.isAbsolute(relPath)
    || relPath === ".."
    || relPath.startsWith("../")
    || relPath.includes("\0")
  ) {
    throw materializationError(`${label} is not an exact repository-relative path: ${relPath}`);
  }
  const protectedReason = validateMutableRepoPath(relPath, label);
  if (protectedReason) throw materializationError(protectedReason, { path: relPath });
  const resolved = resolvePathWithin(cwd, relPath, { allowEqual: false });
  if (!resolved) {
    throw materializationError(`${label} escapes the worktree: ${relPath}`, { path: relPath });
  }
  return resolved;
}

function assertNoSymlinkParents(cwd, absPath, relPath) {
  const relativeParent = path.relative(cwd, path.dirname(absPath));
  let cursor = cwd;
  for (const segment of relativeParent.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, segment);
    if (!fs.existsSync(cursor)) continue;
    const stat = fs.lstatSync(cursor);
    if (stat.isSymbolicLink()) {
      throw materializationError(
        `Creation target has a symlinked parent: ${relPath}`,
        { path: relPath, symlink_parent: path.relative(cwd, cursor).replace(/\\/g, "/") },
      );
    }
    if (!stat.isDirectory()) {
      throw materializationError(
        `Creation target parent is not a directory: ${relPath}`,
        { path: relPath },
      );
    }
  }
}

async function isTrackedPath(cwd, relPath) {
  try {
    await gitExecAsync(
      ["ls-files", "--error-unmatch", "--", relPath],
      cwd,
      { timeoutMs: 10_000 },
    );
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw materializationError(
      `Could not verify repository tracking state for ${relPath}: ${error?.message || String(error)}`,
      { path: relPath, cause: error },
    );
  }
}

function existingMaterialization(jobId, generation, relPath) {
  return getDb().prepare(`
    SELECT *
    FROM file_materializations
    WHERE job_id = ? AND generation = ? AND path = ?
  `).get(jobId, generation, relPath);
}

// A planned new file is not written before the job runs: the job keeps exact
// creation authority and edit_file creates the file. So on a resumed attempt
// the job's own new file looks like a foreign untracked collision. It is this
// job's work when the job has already run an implementation attempt, or a
// resume/recovery receipt names the path.
function ownsDeferredCreate(packet, relPath) {
  const raw = packet?._raw_payload && typeof packet._raw_payload === "object" ? packet._raw_payload : {};
  for (const key of [PRESERVED_WORK_RESUME_KEY, DIRTY_WORKTREE_RECOVERY_KEY]) {
    if (uniquePaths(raw[key]?.paths).includes(relPath)) return true;
  }
  return Boolean(getDb().prepare(`
    SELECT 1
    FROM job_attempts
    WHERE job_id = ? AND worker_type <> 'assessor' AND status <> 'running'
    LIMIT 1
  `).get(Number(packet.job_id)));
}

export function materializedPathsForJob(jobId, generation = 1) {
  const numericJobId = Number(jobId);
  const numericGeneration = Number(generation);
  if (!Number.isInteger(numericJobId) || numericJobId <= 0) return [];
  if (!Number.isInteger(numericGeneration) || numericGeneration <= 0) return [];
  return getDb().prepare(`
    SELECT path
    FROM file_materializations
    WHERE job_id = ? AND generation = ?
    ORDER BY path
  `).all(numericJobId, numericGeneration)
    .map((row) => normalizeRepoRelativePath(row.path))
    .filter(Boolean);
}

async function rollbackStagedGreenfieldFiles(cwd, relPaths) {
  if (relPaths.length === 0) return;
  try {
    await gitExecAsync(
      ["rm", "--cached", "--force", "--ignore-unmatch", "--", ...relPaths],
      cwd,
      { timeoutMs: 10_000 },
    );
  } catch {
    // best effort; the original materialization error remains authoritative
  }
}

async function stageGreenfieldFiles(cwd, relPaths) {
  if (relPaths.length === 0) return;
  try {
    // An untracked empty placeholder is invisible to ordinary `git diff`.
    // Staging the empty blob gives the provider a baseline, so its subsequent
    // write appears as an unstaged diff instead of looking like "no changes".
    await gitExecAsync(["add", "--force", "--", ...relPaths], cwd, { timeoutMs: 10_000 });
  } catch (error) {
    throw materializationError(
      `Could not stage materialized greenfield files: ${error?.message || String(error)}`,
      { paths: relPaths, cause: error },
    );
  }
}

function isWritingCodePacket(packet) {
  const taskMode = packet?.task_mode || packet?._raw_payload?.task_mode || "code";
  return packet?.recipient === "dev"
    && DEV_ROLE_JOB_TYPES.has(packet?.job_type)
    && taskMode === "code";
}

const MUTABLE_SCOPE_FIELDS = Object.freeze([
  "files_to_modify",
  "files_to_create",
  "files_to_delete",
  "create_roots",
  "must_modify",
]);

function normalizedProtectedScopeOmissions(values = []) {
  const seen = new Set();
  const normalized = [];
  for (const entry of Array.isArray(values) ? values : []) {
    const path = normalizeRepoRelativePath(entry?.path);
    const field = MUTABLE_SCOPE_FIELDS.includes(entry?.field) ? entry.field : null;
    if (!path || !field || !isSensitiveEnvRepoPath(path)) continue;
    const key = `${field}\0${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    normalized.push({ path, field, reason: "sensitive_env_path" });
  }
  return normalized;
}

/** Remove secret-bearing env paths before any mutation or provider context step. */
export function stripSensitiveEnvMutationScope(packet) {
  if (!packet || typeof packet !== "object") return [];
  const raw = packet._raw_payload && typeof packet._raw_payload === "object"
    ? packet._raw_payload
    : null;
  const omissions = normalizedProtectedScopeOmissions([
    ...(packet.protected_scope_omissions || []),
    ...(raw?.protected_scope_omissions || []),
  ]);
  const seen = new Set(omissions.map((entry) => `${entry.field}\0${entry.path}`));

  for (const field of MUTABLE_SCOPE_FIELDS) {
    const source = Array.isArray(packet[field])
      ? packet[field]
      : (Array.isArray(raw?.[field]) ? raw[field] : []);
    const kept = [];
    for (const value of source) {
      const normalized = normalizeRepoRelativePath(value);
      if (!normalized) continue;
      if (!isSensitiveEnvRepoPath(normalized)) {
        if (!kept.includes(normalized)) kept.push(normalized);
        continue;
      }
      const key = `${field}\0${normalized}`;
      if (!seen.has(key)) {
        seen.add(key);
        omissions.push({ path: normalized, field, reason: "sensitive_env_path" });
      }
    }
    packet[field] = kept;
    if (raw) raw[field] = [...kept];
  }

  packet.protected_scope_omissions = omissions;
  if (raw) raw.protected_scope_omissions = omissions.map((entry) => ({ ...entry }));
  return omissions;
}

/**
 * Consume planner-owned files_to_create before a writing provider sees the
 * packet. Exact files are materialized with exclusive creation, recorded in
 * private provenance, then exposed only as files_to_modify. A modify target
 * that does not exist yet is treated exactly like a declared creation: the
 * deterministic harness materializes it (empty, staged, with provenance)
 * instead of rejecting the handoff, because the distinction between "modify"
 * and "create" is a planner classification, not a safety boundary. The same
 * path rules apply: it must be inside the worktree, not a symlink parent,
 * and authorized as an exact file. Ignore rules do not revoke that authority.
 */
export async function materializeWritingScope(packet) {
  stripSensitiveEnvMutationScope(packet);
  if (!isWritingCodePacket(packet)) return { applied: false, materialized: [] };
  const cwd = path.resolve(packet.cwd || process.cwd());
  const requestedModify = uniquePaths(packet.files_to_modify);
  const modify = [];
  const create = uniquePaths(packet.files_to_create);
  const promotedToCreate = [];
  const createRoots = uniquePaths(packet.create_roots);
  if (createRoots.length > 0) {
    throw materializationError(
      `Writing handoff cannot grant generic creation roots (${createRoots.join(", ")}); planners must declare exact files_to_create.`,
      { create_roots: createRoots },
    );
  }
  for (const relPath of requestedModify) {
    const outsideWorktree = (
      path.isAbsolute(relPath)
      || relPath === ".."
      || relPath.startsWith("../")
      || relPath.includes("\0")
      || !resolvePathWithin(cwd, relPath, { allowEqual: false })
    );
    if (outsideWorktree) {
      packet.editable_files = packet.editable_files || {};
      packet.editable_file_metadata = packet.editable_file_metadata || {};
      packet.dropped_files = Array.isArray(packet.dropped_files) ? packet.dropped_files : [];
      packet.editable_files[relPath] = null;
      packet.editable_file_metadata[relPath] = {
        exists: false,
        size: 0,
        contentPreloaded: false,
        reason: "outside_project_scope",
      };
      packet.dropped_files.push(`${relPath} (outside project scope)`);
      continue;
    }
    const absPath = assertSafeRelativePath(cwd, relPath, "files_to_modify");
    let stat;
    try { stat = fs.lstatSync(absPath); } catch { stat = null; }
    if (!stat) {
      // Not on disk yet: materialize it the way a declared creation would be.
      promotedToCreate.push(relPath);
      if (!create.includes(relPath)) create.push(relPath);
      continue;
    }
    if (!stat.isFile() || stat.isSymbolicLink()) {
      throw materializationError(
        `files_to_modify target must already be a regular file: ${relPath}`,
        { path: relPath },
      );
    }
    modify.push(relPath);
  }
  if (create.length === 0) {
    packet.files_to_modify = modify;
    packet.files_to_create = [];
    packet.create_roots = [];
    if (packet._raw_payload && typeof packet._raw_payload === "object") {
      packet._raw_payload = { ...packet._raw_payload, files_to_modify: modify };
      delete packet._raw_payload.files_to_create;
      delete packet._raw_payload.create_roots;
    }
    return { applied: true, materialized: [] };
  }
  if (!Number.isInteger(Number(packet.job_id)) || Number(packet.job_id) <= 0) {
    throw materializationError("Writing handoff requires a durable job_id before file materialization.");
  }

  const rawGeneration = Number(
    packet?._raw_payload?.scope_generation ?? packet?.scope_generation ?? 1,
  );
  const generation =
    Number.isFinite(rawGeneration) && rawGeneration >= 1
      ? Math.floor(rawGeneration)
      : 1;
  const materialized = [];
  const greenfieldFiles = [];
  const convertedToModify = [];
  const deferredCreates = [];
  try {
    for (const relPath of create) {
      const absPath = assertSafeRelativePath(cwd, relPath, "files_to_create");
      assertNoSymlinkParents(cwd, absPath, relPath);
      const provenance = existingMaterialization(packet.job_id, generation, relPath);
      if (fs.existsSync(absPath)) {
        const stat = fs.lstatSync(absPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw materializationError(`Creation target collision is not a regular file: ${relPath}`, {
            path: relPath,
          });
        }
        if (!provenance && !modify.includes(relPath)) {
          // A tracked collision means the file was committed on this branch
          // by an earlier job (a sibling, a prior plan wave, or a salvaged
          // predecessor WI) while the planner compiled against a root that
          // predates it. That is WI-authored content, so editing it is what
          // the planner would have scoped had it seen the branch; reclassify
          // to modify instead of failing the attempt. Untracked collisions
          // stay hard errors — they may hold unsaved content this job's
          // scoped commit could silently swallow — except this job's own
          // new file, which a resumed attempt must keep editing.
          if (await isTrackedPath(cwd, relPath) || ownsDeferredCreate(packet, relPath)) {
            convertedToModify.push(relPath);
            modify.push(relPath);
            continue;
          }
          throw materializationError(
            `Creation target already exists without matching handoff provenance: ${relPath}`,
            { path: relPath },
          );
        }
        if (provenance && stat.size === 0 && !(await isTrackedPath(cwd, relPath))) {
          greenfieldFiles.push(relPath);
        }
        materialized.push(relPath);
        continue;
      }
      // Nothing is written for a planned new file. An empty placeholder is a
      // committed file the job did not write: it fails a discoverable test
      // suite, trips content checks, and stays behind when the job never
      // fills it. The job keeps exact creation authority and edit_file
      // creates the file with its first content.
      deferredCreates.push(relPath);
    }
    await stageGreenfieldFiles(cwd, greenfieldFiles);
  } catch (error) {
    await rollbackStagedGreenfieldFiles(cwd, greenfieldFiles);
    throw error;
  }

  const editable = uniquePaths([...modify, ...create.filter((file) => !deferredCreates.includes(file))]);
  packet.files_to_modify = editable;
  packet.files_to_create = deferredCreates;
  packet.create_roots = [];
  packet.creatable_files = {};
  packet.materialized_files = materialized;
  packet.promoted_modify_targets = promotedToCreate;
  packet._materialization_generation = generation;
  if (packet._raw_payload && typeof packet._raw_payload === "object") {
    packet._raw_payload = { ...packet._raw_payload, files_to_modify: editable, files_to_create: deferredCreates };
    // Only files that do not exist yet keep creation authority; with none, the
    // key is absent exactly as in the no-creation branch above.
    if (deferredCreates.length === 0) delete packet._raw_payload.files_to_create;
    delete packet._raw_payload.create_roots;
  }
  return { applied: true, materialized, convertedToModify, promotedToCreate };
}

/** Only private-provenance placeholders with no bytes in HEAD, index or worktree. */
export async function emptyMaterializedPathsForJob(jobId, generation, cwd) {
  const empty = [];
  for (const relPath of materializedPathsForJob(jobId, generation)) {
    const absolute = assertSafeRelativePath(cwd, relPath, "materialized path");
    assertNoSymlinkParents(cwd, absolute, relPath);
    const stat = fs.lstatSync(absolute, { throwIfNoEntry: false });
    if (!stat?.isFile() || stat.size !== 0) continue;
    try {
      if (String(await gitExecAsync(["ls-tree", "HEAD", "--", relPath], cwd)).trim()) continue;
      // Materialization stages an empty blob. Never discard agent-staged bytes.
      if (String(await gitExecAsync(["cat-file", "-s", `:${relPath}`], cwd)).trim() !== "0") continue;
    } catch { continue; }
    empty.push(relPath);
  }
  return empty;
}

export async function dropEmptyMaterializationsForJob(jobId, generation, cwd) {
  const paths = await emptyMaterializedPathsForJob(jobId, generation, cwd);
  for (const relPath of paths) {
    await gitExecAsync(["rm", "--cached", "--", relPath], cwd);
    fs.unlinkSync(path.join(cwd, relPath));
  }
  return paths;
}
