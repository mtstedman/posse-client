import { markScopeGrantUsed } from "../../../queue/functions/scope-grant-usage.js";
import fs from "node:fs";
import path from "node:path";
import process from "node:process";
import { editScopeRequestReason } from "../../../../shared/tools/functions/edit-scope-preview.js";
import { isSensitiveEnvFileOrTargetPath, safePath } from "../../../../shared/tools/functions/toolkit/index.js";
import { realMutationTarget } from "../../../../shared/tools/functions/toolkit/path-policy.js";
import { getJob, updateJobPayload, runInTransaction, grantApprovedScopeEntries, requestJobScopeExpansion } from "../../../queue/functions/index.js";
import { guardToolWriteLock } from "../../../queue/functions/write-lock-guard.js";
import { protectedMutablePathReason, relativePathFromCwd } from "../../../runtime/functions/protected-paths.js";
import { toRepoRelativePath } from "../../../../shared/format/functions/display-paths.js";

// The executable supplies live boot/session fields through getters. This owner
// keeps the scope decision, path guard, and mutation transaction together.
export function createScopedMutationTools(ctx) {
  // Both the spelling and the symlink-resolved landing path must be mutable.
  function protectedMutationError(toolName, displayPath, absolutePath, targetPath = absolutePath) {
    for (const candidate of new Set([absolutePath, targetPath])) {
      const reason = protectedMutablePathReason(relativePathFromCwd(ctx.workspaceCwd, candidate));
      if (reason) return `Error: ${toolName} blocked - ${displayPath} is protected: ${reason}.`;
    }
    return null;
  }

  // `target` is where the write lands; scope is judged there (decision E1).
  function resolveMutationPath(toolName, displayPath) {
    try {
      const resolved = safePath(ctx.workspaceCwd, displayPath, ctx.effectiveScopePredicates);
      return { path: resolved, target: realMutationTarget(ctx.workspaceCwd, resolved, ctx.effectiveScopePredicates) };
    } catch (err) {
      return { error: `Error: ${toolName} blocked - ${err?.message || String(err)}` };
    }
  }

  // Rename, copy and mkdir act on the entry itself, so only its parent is resolved.
  function entryTarget(absolutePath, { followFinalLink = false } = {}) {
    return realMutationTarget(ctx.workspaceCwd, absolutePath, ctx.effectiveScopePredicates, { followFinalLink });
  }

  function recordMutationPaths(files) {
    if (!ctx.mcpJobId) return;
    runInTransaction(() => {
      for (const file of files) {
        const relative = path.relative(ctx.workspaceCwd, path.resolve(ctx.workspaceCwd, file)).replace(/\\/g, "/");
        markScopeGrantUsed(getJob(ctx.mcpJobId), relative, updateJobPayload);
      }
    });
  }

  async function recordMutationUse(result, file) {
    const resolved = await result;
    if (typeof resolved === "string" && !resolved.startsWith("Error:")) recordMutationPaths([file]);
    return resolved;
  }

  const LIVE_SCOPE_WAIT = Symbol("posse.mcp-live-scope-wait");

  function isPendingLiveScopeResult(result) {
    return result?.live === true
      && ["scope_approval_pending", "scope_approval_batched"].includes(result?.code);
  }

  async function requestScopeExpansionWithinJob(args = {}) {
    const requestedEntries = Array.isArray(args?.requests) && args.requests.length > 0
      ? args.requests
      : [args || {}];
    const entries = requestedEntries.slice(0, 24);
    let pendingResult = null;
    let lastResult = null;
    for (const entry of entries) {
      const result = requestJobScopeExpansion({
        jobId: ctx.mcpJobId,
        workspaceCwd: ctx.workspaceCwd,
        workItemId: ctx.mcpWorkItemId,
        attemptId: ctx.mcpAttemptId,
        agentCallId: ctx.mcpAgentCallId,
        path: entry.path,
        access: entry.access,
        operation: entry.operation,
        reason: entry.reason,
        source: String(entry.source || (entries.length > 1
          ? "deterministic_mcp_scope_batch_tool"
          : "deterministic_mcp_internal_tool")),
        liveWait: true,
      });
      lastResult = result;
      if (result?.approved === true) {
        // Widen the subprocess-local predicates so this same MCP invocation can
        // finish the blocked operation. The queue already persisted the grant.
        grantApprovedScopeEntries(result, ctx.effectiveScopePredicates);
      }
      if (isPendingLiveScopeResult(result)) pendingResult = result;
    }
    const result = pendingResult || lastResult;
    if (requestedEntries.length > entries.length && result && typeof result === "object") {
      return {
        ...result,
        repair_note: `Only the first ${entries.length} scope requests were processed; submit the remaining ${requestedEntries.length - entries.length} exact path(s) in another request_scope call.`,
        requests_processed: entries.length,
        requests_remaining: requestedEntries.length - entries.length,
      };
    }
    return result;
  }

  async function requestScopeWithinJob(args = {}) {
    const result = await requestScopeExpansionWithinJob(args);
    if (isPendingLiveScopeResult(result)) {
      return { [LIVE_SCOPE_WAIT]: true, request: result, operation: "request_scope", args };
    }
    return JSON.stringify(result, null, 2);
  }

  async function writeFileWithinScope(args = {}) {
    if (!ctx.writeEnabled) return "Error: Write access is not granted for this role.";
    const resolved = resolveMutationPath("write_file", args.path);
    if (resolved.error) return resolved.error;
    const protectedErr = protectedMutationError("write_file", args.path, resolved.path, resolved.target);
    if (protectedErr) return protectedErr;
    const exists = fs.existsSync(resolved.path);
    const allowed = exists
      ? ctx.effectiveScopePredicates.canEdit(resolved.target)
      : ctx.effectiveScopePredicates.canCreate(resolved.target);
    if (!allowed) {
      if (!ctx.mcpJobId) {
        return `Error: write_file blocked - ${args.path} is outside the allowed ${exists ? "edit" : "creation"} scope.`;
      }
      const scopeResult = await requestScopeExpansionWithinJob({
        path: toRepoRelativePath(ctx.workspaceCwd, resolved.target) ?? "",
        access: exists ? "modify" : "create",
        operation: "write_file",
        reason: `write_file requires this ${exists ? "existing" : "new"} file to complete the active job`,
        source: "deterministic_mcp_write_boundary",
      });
      if (isPendingLiveScopeResult(scopeResult)) {
        return { [LIVE_SCOPE_WAIT]: true, request: scopeResult, operation: "write_file", args };
      }
      if (scopeResult?.approved !== true) {
        return JSON.stringify(scopeResult, null, 2);
      }
      // Approved: complete the original write in the same call.
    }
    return recordMutationUse(ctx.execWriteFile(args || {}, ctx.workspaceCwd, ctx.effectiveScopePredicates), resolved.target);
  }

  async function editFileWithinScope(args = {}) {
    if (!ctx.writeEnabled) return "Error: Write access is not granted for this role.";
    const resolved = resolveMutationPath("edit_file", args.path);
    if (resolved.error) return resolved.error;
    const protectedErr = protectedMutationError("edit_file", args.path, resolved.path, resolved.target);
    if (protectedErr) return protectedErr;
    const missing = !fs.existsSync(resolved.path);
    const emptyCreate = !missing && args.find === "" && fs.statSync(resolved.path).isFile() && fs.statSync(resolved.path).size === 0;
    if (missing || emptyCreate) {
      // edit_file is also how a file is created: an empty find and the whole
      // content as the replacement. Code roles carry no write_file tool.
      if (args.find !== "" || typeof args.replace !== "string") {
        return `Error: ${args.path} does not exist. To create it, call edit_file with find "" and the whole file content as replace.`;
      }
      if (Object.keys(args).some((key) => !["path", "find", "replace"].includes(key))) {
        return "Error: Creating a file with edit_file accepts only path, find and replace.";
      }
      if (!ctx.effectiveScopePredicates.canCreate(resolved.target)) {
        if (!ctx.mcpJobId) return `Error: edit_file blocked - ${args.path} is outside the allowed creation scope.`;
        const scopeResult = await requestScopeExpansionWithinJob({
          path: toRepoRelativePath(ctx.workspaceCwd, resolved.target) ?? "",
          access: "create",
          operation: "edit_file",
          reason: "edit_file requires this new file to complete the active job",
          source: "deterministic_mcp_write_boundary",
        });
        if (isPendingLiveScopeResult(scopeResult)) {
          return { [LIVE_SCOPE_WAIT]: true, request: scopeResult, operation: "edit_file", args };
        }
        if (scopeResult?.approved !== true) return JSON.stringify(scopeResult, null, 2);
        // Approved: create the file in the same call.
      }
      return recordMutationUse(ctx.execWriteFile({ path: args.path, content: args.replace }, ctx.workspaceCwd, ctx.effectiveScopePredicates), resolved.target);
    }
    if (!ctx.effectiveScopePredicates.canEdit(resolved.target)) {
      if (!ctx.mcpJobId) {
        return `Error: edit_file blocked - ${args.path} is outside the allowed edit scope.`;
      }
      const scopeResult = await requestScopeExpansionWithinJob({
        path: toRepoRelativePath(ctx.workspaceCwd, resolved.target) ?? "",
        access: "modify",
        operation: "edit_file",
        reason: editScopeRequestReason(args),
        source: "deterministic_mcp_write_boundary",
      });
      if (isPendingLiveScopeResult(scopeResult)) {
        return { [LIVE_SCOPE_WAIT]: true, request: scopeResult, operation: "edit_file", args };
      }
      if (scopeResult?.approved !== true) {
        return JSON.stringify(scopeResult, null, 2);
      }
      // Approved: complete the original edit in the same call.
    }
    return recordMutationUse(ctx.execEditFile(args || {}, ctx.workspaceCwd, ctx.effectiveScopePredicates), resolved.target);
  }

  function pathsReferToSameExistingFile(a, b) {
    try {
      const aStat = fs.statSync(a);
      const bStat = fs.statSync(b);
      if (aStat.dev === bStat.dev && aStat.ino !== 0 && aStat.ino === bStat.ino) return true;
    } catch {
      return false;
    }
    try {
      const realA = fs.realpathSync.native ? fs.realpathSync.native(a) : fs.realpathSync(a);
      const realB = fs.realpathSync.native ? fs.realpathSync.native(b) : fs.realpathSync(b);
      return process.platform === "win32"
        ? realA.toLowerCase() === realB.toLowerCase()
        : realA === realB;
    } catch {
      return false;
    }
  }

  function moveFileWithinScope(args = {}) {
    if (!ctx.writeEnabled) return "Error: move_file is not available for this role.";
    const sourcePath = safePath(ctx.workspaceCwd, args.source, ctx.effectiveScopePredicates);
    const destinationPath = safePath(ctx.workspaceCwd, args.destination, ctx.effectiveScopePredicates);
    const sourceTarget = entryTarget(sourcePath);
    const destinationTarget = entryTarget(destinationPath);
    const protectedSourceErr = protectedMutationError("move_file", args.source, sourcePath, sourceTarget);
    if (protectedSourceErr) return protectedSourceErr;
    const protectedDestinationErr = protectedMutationError("move_file", args.destination, destinationPath, destinationTarget);
    if (protectedDestinationErr) return protectedDestinationErr;
    if (isSensitiveEnvFileOrTargetPath(sourcePath)) {
      return "Error: move_file blocked - reading .env files is blocked.";
    }
    if (isSensitiveEnvFileOrTargetPath(destinationPath)) {
      return "Error: move_file blocked - writing .env files is blocked.";
    }
    if (!fs.existsSync(sourcePath)) return `Error: Source file not found: ${args.source}`;
    const sourceStat = fs.statSync(sourcePath);
    if (!sourceStat.isFile()) return `Error: Source path is not a file: ${args.source}`;
    if (!ctx.effectiveScopePredicates.canEdit(sourceTarget)) {
      return `Error: move_file blocked - ${args.source} is outside the allowed edit scope.`;
    }

    const overwrite = args.overwrite === true;
    const destinationExists = fs.existsSync(destinationPath);
    const destinationIsSource = destinationExists && pathsReferToSameExistingFile(sourcePath, destinationPath);
    // The replace step renames the destination aside before moving the file
    // in, so a directory there would be displaced first and the move then fail.
    if (destinationExists && !destinationIsSource && fs.statSync(destinationPath).isDirectory()) {
      return `Error: move_file destination is a directory: ${args.destination}. Name the destination file path, for example ${path.posix.join(String(args.destination).replace(/\\/g, "/"), path.basename(sourcePath))}.`;
    }
    if (destinationExists && !destinationIsSource && !overwrite) {
      return `Error: Destination already exists: ${args.destination} (set overwrite=true to replace).`;
    }
    if (destinationExists && !ctx.effectiveScopePredicates.canEdit(destinationTarget)) {
      return `Error: move_file blocked - ${args.destination} is outside the allowed edit scope.`;
    }
    if (!destinationExists && !ctx.effectiveScopePredicates.canCreate(destinationTarget)) {
      return `Error: move_file blocked - ${args.destination} is outside the allowed creation scope.`;
    }
    const sourceLockErr = guardToolWriteLock("move_file", args.source, ctx.workspaceCwd);
    if (sourceLockErr) return sourceLockErr;
    const destinationLockErr = guardToolWriteLock("move_file", args.destination, ctx.workspaceCwd);
    if (destinationLockErr) return destinationLockErr;

    const destinationDir = path.dirname(destinationPath);
    const replacementTempPath = () => path.join(destinationDir, `.posse-move-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}.tmp`);
    const replaceDestination = (fromPath) => {
      if (!destinationExists) {
        fs.renameSync(fromPath, destinationPath);
        return;
      }
      const backupPath = replacementTempPath();
      let backupCreated = false;
      try {
        fs.renameSync(destinationPath, backupPath);
        backupCreated = true;
        fs.renameSync(fromPath, destinationPath);
        fs.rmSync(backupPath, { force: true });
      } catch (err) {
        if (backupCreated && !fs.existsSync(destinationPath) && fs.existsSync(backupPath)) {
          try { fs.renameSync(backupPath, destinationPath); } catch { /* preserve error below */ }
        }
        throw err;
      }
    };

    try {
      fs.mkdirSync(destinationDir, { recursive: true });
      if (destinationIsSource) {
        if (path.normalize(sourcePath) !== path.normalize(destinationPath)) {
          const tempPath = replacementTempPath();
          fs.renameSync(sourcePath, tempPath);
          fs.renameSync(tempPath, destinationPath);
        }
      } else {
        replaceDestination(sourcePath);
      }
    } catch (err) {
      if (err?.code !== "EXDEV") {
        const reason = err?.code ? ` (${err.code})` : "";
        return `Error: move_file failed for ${args.source} -> ${args.destination}${reason}.`;
      }
      const tempPath = replacementTempPath();
      try {
        fs.copyFileSync(sourcePath, tempPath);
        replaceDestination(tempPath);
        fs.rmSync(sourcePath, { force: true });
      } catch (copyErr) {
        try { if (fs.existsSync(tempPath)) fs.rmSync(tempPath, { force: true }); } catch { /* best-effort */ }
        const reason = copyErr?.code ? ` (${copyErr.code})` : "";
        return `Error: move_file failed for ${args.source} -> ${args.destination}${reason}.`;
      }
    }

    recordMutationPaths([sourceTarget, destinationTarget]);
    return JSON.stringify({
      ok: true,
      source: path.relative(ctx.workspaceCwd, sourcePath).replace(/\\/g, "/"),
      destination: path.relative(ctx.workspaceCwd, destinationPath).replace(/\\/g, "/"),
      overwritten: destinationExists && overwrite && !destinationIsSource,
    }, null, 2);
  }

  function copyFileWithinScope(args = {}) {
    if (!ctx.writeEnabled) return "Error: copy_file is not available for this role.";
    const sourcePath = safePath(ctx.workspaceCwd, args.source, ctx.effectiveScopePredicates);
    const destinationPath = safePath(ctx.workspaceCwd, args.destination, ctx.effectiveScopePredicates);
    const destinationTarget = entryTarget(destinationPath);
    const protectedSourceErr = protectedMutationError("copy_file", args.source, sourcePath, entryTarget(sourcePath, { followFinalLink: true }));
    if (protectedSourceErr) return protectedSourceErr;
    const protectedDestinationErr = protectedMutationError("copy_file", args.destination, destinationPath, destinationTarget);
    if (protectedDestinationErr) return protectedDestinationErr;
    if (isSensitiveEnvFileOrTargetPath(sourcePath)) {
      return "Error: copy_file blocked - reading .env files is blocked.";
    }
    if (isSensitiveEnvFileOrTargetPath(destinationPath)) {
      return "Error: copy_file blocked - writing .env files is blocked.";
    }
    if (!fs.existsSync(sourcePath)) return `Error: Source file not found: ${args.source}`;
    const sourceStat = fs.statSync(sourcePath);
    if (!sourceStat.isFile()) return `Error: Source path is not a file: ${args.source}`;

    const overwrite = args.overwrite === true;
    const destinationExists = fs.existsSync(destinationPath);
    if (destinationExists && !overwrite) {
      return `Error: Destination already exists: ${args.destination} (set overwrite=true to replace).`;
    }
    // Replacing the destination removes it first; when it is the source (the
    // same path spelled twice, or a primary-checkout alias) that deletes the file.
    if (destinationExists && pathsReferToSameExistingFile(sourcePath, destinationPath)) {
      return `Error: copy_file source and destination are the same file: ${args.destination}.`;
    }
    if (destinationExists && !ctx.effectiveScopePredicates.canEdit(destinationTarget)) {
      return `Error: copy_file blocked - ${args.destination} is outside the allowed edit scope.`;
    }
    if (!destinationExists && !ctx.effectiveScopePredicates.canCreate(destinationTarget)) {
      return `Error: copy_file blocked - ${args.destination} is outside the allowed creation scope.`;
    }
    // copyFileSync writes through a dangling link to a target the scope
    // check above never saw.
    if (!destinationExists && fs.lstatSync(destinationPath, { throwIfNoEntry: false })?.isSymbolicLink()) {
      return `Error: copy_file blocked - ${args.destination} is a symbolic link to a missing target.`;
    }
    const destinationLockErr = guardToolWriteLock("copy_file", args.destination, ctx.workspaceCwd);
    if (destinationLockErr) return destinationLockErr;

    try {
      fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
      if (destinationExists && overwrite) fs.rmSync(destinationPath, { force: true });
      fs.copyFileSync(sourcePath, destinationPath);
    } catch (err) {
      const reason = err?.code ? ` (${err.code})` : "";
      return `Error: copy_file failed for ${args.source} -> ${args.destination}${reason}.`;
    }
    recordMutationPaths([destinationTarget]);
    return JSON.stringify({
      ok: true,
      source: path.relative(ctx.workspaceCwd, sourcePath).replace(/\\/g, "/"),
      destination: path.relative(ctx.workspaceCwd, destinationPath).replace(/\\/g, "/"),
      overwritten: destinationExists && overwrite,
    }, null, 2);
  }

  function makeDirWithinScope(args = {}) {
    if (!ctx.writeEnabled) return "Error: make_dir is not available for this role.";
    if (!args.path || typeof args.path !== "string") return "Error: path is required.";
    const dirPath = safePath(ctx.workspaceCwd, args.path, ctx.effectiveScopePredicates);
    const dirTarget = entryTarget(dirPath, { followFinalLink: true });
    const protectedErr = protectedMutationError("make_dir", args.path, dirPath, dirTarget);
    if (protectedErr) return protectedErr;
    if (fs.existsSync(dirPath)) {
      if (!fs.statSync(dirPath).isDirectory()) {
        return `Error: Path exists and is not a directory: ${args.path}`;
      }
      return JSON.stringify({
        ok: true,
        path: path.relative(ctx.workspaceCwd, dirPath).replace(/\\/g, "/"),
        created: false,
      }, null, 2);
    }
    if (!ctx.effectiveScopePredicates.canCreate(dirTarget)) {
      return `Error: make_dir blocked - ${args.path} is outside the allowed creation scope.`;
    }
    try {
      fs.mkdirSync(dirPath, { recursive: true });
    } catch (err) {
      const reason = err?.code ? ` (${err.code})` : "";
      return `Error: make_dir failed for ${args.path}${reason}.`;
    }
    return JSON.stringify({
      ok: true,
      path: path.relative(ctx.workspaceCwd, dirPath).replace(/\\/g, "/"),
      created: true,
    }, null, 2);
  }

  return {
    LIVE_SCOPE_WAIT,
    requestScopeWithinJob,
    writeFileWithinScope,
    editFileWithinScope,
    moveFileWithinScope,
    copyFileWithinScope,
    makeDirWithinScope,
  };
}
