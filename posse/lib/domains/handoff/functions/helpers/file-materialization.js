import fs from "node:fs";
import path from "node:path";

import { getDb } from "../../../../shared/storage/functions/index.js";
import { log } from "../../../../shared/telemetry/functions/logging/logger.js";
import { gitExec } from "../../../git/functions/utils.js";
import {
  normalizeRepoRelativePath,
  validateMutableRepoPath,
} from "../../../runtime/functions/protected-paths.js";
import { resolvePathWithin } from "../../../../shared/scope/functions/path.js";

function uniquePaths(values = []) {
  return [...new Set((Array.isArray(values) ? values : [])
    .map(normalizeRepoRelativePath)
    .filter(Boolean))];
}

function materializationError(message, details = {}) {
  const error = new Error(message);
  error.code = "HANDOFF_FILE_MATERIALIZATION_FAILED";
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

function isIgnoredPath(cwd, relPath) {
  try {
    gitExec(
      ["check-ignore", "-q", "--no-index", "--", relPath],
      cwd,
      { timeoutMs: 10_000 },
    );
    return true;
  } catch (error) {
    if (error?.status === 1) return false;
    throw materializationError(
      `Could not verify repository ignore policy for ${relPath}: ${error?.message || String(error)}`,
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

function recordMaterialization(packet, generation, relPath, createdParentDirs) {
  const operationKey = `materialize:${Number(packet.job_id)}:${generation}:${relPath}`;
  getDb().prepare(`
    INSERT INTO file_materializations (
      job_id, work_item_id, generation, path, operation_key,
      created_parent_dirs_json
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(operation_key) DO NOTHING
  `).run(
    Number(packet.job_id),
    packet.work_item_id == null ? null : Number(packet.work_item_id),
    generation,
    relPath,
    operationKey,
    JSON.stringify(createdParentDirs),
  );
}

function createParentDirectories(cwd, absPath) {
  const created = [];
  const missing = [];
  let cursor = path.dirname(absPath);
  while (cursor !== cwd && cursor.startsWith(`${cwd}${path.sep}`) && !fs.existsSync(cursor)) {
    missing.push(cursor);
    cursor = path.dirname(cursor);
  }
  for (const dir of missing.reverse()) {
    fs.mkdirSync(dir);
    created.push(path.relative(cwd, dir).replace(/\\/g, "/"));
  }
  return created;
}

function rollbackCreated(cwd, files, dirs) {
  for (const file of [...files].reverse()) {
    try { fs.unlinkSync(file); } catch { /* best effort */ }
  }
  for (const relDir of [...dirs].reverse()) {
    try { fs.rmdirSync(path.resolve(cwd, relDir)); } catch { /* retain non-empty/operator-owned */ }
  }
}

function isWritingCodePacket(packet) {
  const taskMode = packet?.task_mode || packet?._raw_payload?.task_mode || "code";
  return packet?.recipient === "dev"
    && ["dev", "fix"].includes(packet?.job_type)
    && taskMode === "code";
}

/**
 * Consume planner-owned files_to_create before a writing provider sees the
 * packet. Missing files_to_modify targets are treated as exact creation scope
 * too. Exact files are materialized with exclusive creation, recorded in
 * private provenance, then exposed only as files_to_modify.
 */
export function materializeWritingScope(packet) {
  if (!isWritingCodePacket(packet)) return { applied: false, materialized: [] };
  const cwd = path.resolve(packet.cwd || process.cwd());
  const requestedModify = uniquePaths(packet.files_to_modify);
  const modify = [];
  const create = uniquePaths(packet.files_to_create);
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
      // A missing modify target is either a planner misclassification (should
      // have been files_to_create) or a typo'd path that will silently become
      // an empty file. Surface it so operators can tell the two apart.
      log.warn("handoff", "files_to_modify target missing; promoted to exact creation scope", {
        job_id: packet.job_id == null ? null : Number(packet.job_id),
        work_item_id: packet.work_item_id == null ? null : Number(packet.work_item_id),
        path: relPath,
      });
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
  const createdFiles = [];
  const createdDirs = [];
  const materialized = [];
  try {
    for (const relPath of create) {
      const absPath = assertSafeRelativePath(cwd, relPath, "files_to_create");
      assertNoSymlinkParents(cwd, absPath, relPath);
      if (isIgnoredPath(cwd, relPath)) {
        throw materializationError(
          `files_to_create target is ignored by repository policy: ${relPath}`,
          { path: relPath },
        );
      }
      const provenance = existingMaterialization(packet.job_id, generation, relPath);
      if (fs.existsSync(absPath)) {
        const stat = fs.lstatSync(absPath);
        if (stat.isSymbolicLink() || !stat.isFile()) {
          throw materializationError(`Creation target collision is not a regular file: ${relPath}`, {
            path: relPath,
          });
        }
        if (!provenance && !modify.includes(relPath)) {
          throw materializationError(
            `Creation target already exists without matching handoff provenance: ${relPath}`,
            { path: relPath },
          );
        }
        materialized.push(relPath);
        continue;
      }
      const parents = createParentDirectories(cwd, absPath);
      createdDirs.push(...parents);
      try {
        fs.writeFileSync(absPath, "", { flag: "wx", mode: 0o600 });
      } catch (error) {
        throw materializationError(
          `Could not exclusively materialize ${relPath}: ${error.message}`,
          { path: relPath, cause: error },
        );
      }
      createdFiles.push(absPath);
      recordMaterialization(packet, generation, relPath, parents);
      materialized.push(relPath);
    }
  } catch (error) {
    rollbackCreated(cwd, createdFiles, createdDirs);
    if (createdFiles.length > 0) {
      const rolledBackPaths = createdFiles.map((file) => (
        path.relative(cwd, file).replace(/\\/g, "/")
      ));
      const placeholders = rolledBackPaths.map(() => "?").join(",");
      getDb().prepare(`
        DELETE FROM file_materializations
        WHERE job_id = ? AND generation = ? AND path IN (${placeholders})
      `).run(Number(packet.job_id), generation, ...rolledBackPaths);
    }
    throw error;
  }

  const editable = uniquePaths([...modify, ...create]);
  packet.files_to_modify = editable;
  packet.files_to_create = [];
  packet.create_roots = [];
  packet.creatable_files = {};
  packet.materialized_files = materialized;
  packet._materialization_generation = generation;
  if (packet._raw_payload && typeof packet._raw_payload === "object") {
    packet._raw_payload = { ...packet._raw_payload, files_to_modify: editable };
    delete packet._raw_payload.files_to_create;
    delete packet._raw_payload.create_roots;
  }
  return { applied: true, materialized };
}
