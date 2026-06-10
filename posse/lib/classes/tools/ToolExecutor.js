import fs from "fs";
import path from "path";
import {
  buildScopePredicates,
  createBashExecutor,
  createDeterministicToolkit,
  isSensitiveEnvFilePath,
  safePath,
} from "../../functions/toolkit/index.js";
import { protectedMutablePathReason, relativePathFromCwd } from "../../domains/runtime/functions/protected-paths.js";
import { agentHiddenReadablePathReason } from "../../shared/scope/functions/agent-hidden-paths.js";

function normalizeScope(scope = {}) {
  return {
    modifyFiles: Array.isArray(scope.modifyFiles) ? [...scope.modifyFiles] : [],
    createFiles: Array.isArray(scope.createFiles) ? [...scope.createFiles] : [],
    createRoots: Array.isArray(scope.createRoots) ? [...scope.createRoots] : [],
    deleteFiles: Array.isArray(scope.deleteFiles) ? [...scope.deleteFiles] : [],
  };
}

export class ToolExecutor {
  constructor({
    cwd = process.cwd(),
    scope = {},
    allowWrite = false,
    jobId = null,
    gate = null,
    safePathImpl = safePath,
    createToolkit = createDeterministicToolkit,
    createBash = createBashExecutor,
  } = {}) {
    this.cwd = cwd;
    this.scope = normalizeScope(scope);
    this.allowWrite = !!allowWrite;
    this.jobId = jobId;
    this.gate = gate || null;
    this._safePath = safePathImpl;
    this._bash = createBash();
    this._toolkit = createToolkit({ safePath: safePathImpl });
    this._scopePredicates = buildScopePredicates(this.cwd, this.scope);
  }

  setScope(scope = {}) {
    this.scope = normalizeScope(scope);
    this._scopePredicates = buildScopePredicates(this.cwd, this.scope);
  }

  execute(toolName, args = {}) {
    const name = String(toolName || "").trim();
    const handlers = this.handlers();
    const fn = handlers[name];
    if (typeof fn !== "function") return `Error: Unknown tool "${name}"`;
    try {
      return fn(args || {});
    } catch (err) {
      return `Error executing ${name}: ${err?.message || String(err)}`;
    }
  }

  handlers() {
    const ctx = {
      cwd: this.cwd,
      allowWrite: this.allowWrite,
      scopePredicates: this._scopePredicates,
    };
    const toolkit = this._toolkit;
    return {
      read_file: (args) => toolkit.execReadFile(args, ctx.cwd, ctx.scopePredicates),
      write_file: (args) => this._writeFile(args, toolkit, ctx),
      edit_file: (args) => this._editFile(args, toolkit, ctx),
      list_files: (args) => toolkit.execListFiles(args, ctx.cwd, ctx.scopePredicates),
      search_files: (args) => toolkit.execSearchFiles(args, ctx.cwd, ctx.scopePredicates),
      git_history: (args) => toolkit.execGitHistory(args, ctx.cwd, ctx.scopePredicates),
      inspect_file: (args) => toolkit.execInspectFile(args, ctx.cwd, ctx.scopePredicates),
      hash_file: (args) => toolkit.execHashFile(args, ctx.cwd, ctx.scopePredicates),
      pull_brief: (args) => toolkit.execPullBrief(args, ctx.cwd, ctx.scopePredicates),
      validate_artifact_output: (args) => this._invokeOptional(toolkit.execValidateArtifactOutput, "validate_artifact_output", args, ctx),
      prune_artifact_output: (args) => this._invokeOptional(toolkit.execPruneArtifactOutput, "prune_artifact_output", args, ctx),
      resize_image: (args) => this._imageWrite("resize_image", args, toolkit.execResizeImage, ctx),
      read_image_metadata: (args) => this._invokeOptional(toolkit.execReadImageMetadata, "read_image_metadata", args, ctx),
      optimize_image: (args) => this._imageWrite("optimize_image", args, toolkit.execOptimizeImage, ctx),
      reencode_image: (args) => this._imageWrite("reencode_image", args, toolkit.execReencodeImage, ctx),
      clean_image: (args) => this._cleanImage(args, toolkit, ctx),
      extract_image_text: (args) => this._invokeOptional(toolkit.execExtractImageText, "extract_image_text", args, ctx),
      move_file: (args) => this._moveFile(args, ctx),
      copy_file: (args) => this._copyFile(args, ctx),
      make_dir: (args) => this._makeDir(args, ctx),
      bash: (args) => this._bash(args, ctx.cwd, ctx.allowWrite, ctx.scopePredicates.hasScope ? true : null),
    };
  }

  snapshot() {
    return {
      cwd: this.cwd,
      allowWrite: this.allowWrite,
      hasScope: !!this?._scopePredicates?.hasScope,
      jobId: this.jobId,
    };
  }

  _invokeOptional(fn, toolName, args, ctx) {
    if (typeof fn !== "function") {
      return `Error: ${toolName} is not wired into this runtime.`;
    }
    return fn(args, ctx.cwd, ctx.scopePredicates);
  }

  _cleanImage(args, toolkit, ctx) {
    if (String(args?.mode || "clean").trim().toLowerCase() === "metadata") {
      return this._invokeOptional(toolkit.execCleanImage, "clean_image", args, ctx);
    }
    return this._imageWrite("clean_image", args, toolkit.execCleanImage, ctx);
  }

  _protectedMutationError(toolName, displayPath, absolutePath, ctx) {
    const relPath = relativePathFromCwd(ctx.cwd, absolutePath);
    const reason = protectedMutablePathReason(relPath);
    return reason ? `Error: ${toolName} blocked - ${displayPath} is protected: ${reason}.` : null;
  }

  _hiddenReadError(toolName, displayPath, absolutePath, ctx) {
    const relPath = relativePathFromCwd(ctx.cwd, absolutePath);
    const reason = agentHiddenReadablePathReason(relPath);
    return reason ? `Error: ${toolName} blocked - ${displayPath} is hidden from agent file tools: ${reason}.` : null;
  }

  _lstatIfExists(filePath) {
    try {
      return fs.lstatSync(filePath);
    } catch (err) {
      if (err?.code === "ENOENT") return null;
      throw err;
    }
  }

  _symlinkMutationError(toolName, displayPath, stat) {
    return stat?.isSymbolicLink()
      ? `Error: ${toolName} blocked - ${displayPath} is a symbolic link.`
      : null;
  }

  _imageWrite(toolName, args, fn, ctx) {
    if (typeof fn !== "function") {
      return `Error: ${toolName} is not wired into this runtime.`;
    }
    if (!ctx.allowWrite) return "Error: Write access is not granted for this role.";
    const source = String(args?.path || "").trim();
    if (!source) return `Error: ${toolName} requires path.`;
    const sourcePath = this._safePath(ctx.cwd, source, ctx.scopePredicates);
    const sourceStat = this._lstatIfExists(sourcePath);
    if (!sourceStat) return `Error: File not found: ${source}`;
    const sourceSymlinkErr = this._symlinkMutationError(toolName, source, sourceStat);
    if (sourceSymlinkErr) return sourceSymlinkErr;

    for (const destination of this._imageWriteDestinations(toolName, args, source)) {
      const destinationPath = this._safePath(ctx.cwd, destination, ctx.scopePredicates);
      const protectedErr = this._protectedMutationError(toolName, destination, destinationPath, ctx);
      if (protectedErr) return protectedErr;
      const destinationStat = this._lstatIfExists(destinationPath);
      const destinationSymlinkErr = this._symlinkMutationError(toolName, destination, destinationStat);
      if (destinationSymlinkErr) return destinationSymlinkErr;
    }

    return fn(args, ctx.cwd, ctx.scopePredicates);
  }

  _imageWriteDestinations(toolName, args, source) {
    if (toolName === "clean_image") {
      const mode = String(args?.mode || "clean").trim().toLowerCase();
      if (["optimize", "reencode", "resize", "alpha_key"].includes(mode)) {
        return [String(args?.output_path || source)];
      }
      if (args?.output_path) return [String(args.output_path)];
      const ext = path.extname(source);
      return [ext ? source.slice(0, -ext.length) + ".png" : `${source}.png`];
    }
    return [String(args?.output_path || source)];
  }

  _writeFile(args, toolkit, ctx) {
    if (!ctx.allowWrite) return "Error: Write access is not granted for this role.";
    const writePath = this._safePath(ctx.cwd, args.path, ctx.scopePredicates);
    const protectedErr = this._protectedMutationError("write_file", args.path, writePath, ctx);
    if (protectedErr) return protectedErr;
    const writeStat = this._lstatIfExists(writePath);
    const writeSymlinkErr = this._symlinkMutationError("write_file", args.path, writeStat);
    if (writeSymlinkErr) return writeSymlinkErr;
    if (!ctx.scopePredicates.canCreate(writePath)) {
      return `Error: write_file blocked - ${args.path} is outside the allowed creation scope (not in files_to_create or create_roots).`;
    }
    return toolkit.execWriteFile(args, ctx.cwd, ctx.scopePredicates);
  }

  _editFile(args, toolkit, ctx) {
    if (!ctx.allowWrite) return "Error: Write access is not granted for this role.";
    const editPath = this._safePath(ctx.cwd, args.path, ctx.scopePredicates);
    const protectedErr = this._protectedMutationError("edit_file", args.path, editPath, ctx);
    if (protectedErr) return protectedErr;
    const editStat = this._lstatIfExists(editPath);
    const editSymlinkErr = this._symlinkMutationError("edit_file", args.path, editStat);
    if (editSymlinkErr) return editSymlinkErr;
    if (!ctx.scopePredicates.canEdit(editPath)) {
      return `Error: edit_file blocked - ${args.path} is outside the allowed edit scope (not in files_to_modify or create_roots).`;
    }
    return toolkit.execEditFile(args, ctx.cwd, ctx.scopePredicates);
  }

  _moveFile(args, ctx) {
    if (!ctx.allowWrite) return "Error: move_file is not available for this role.";
    const source = String(args?.source || "").trim();
    const destination = String(args?.destination || "").trim();
    if (!source || !destination) return "Error: move_file requires source and destination.";

    const sourcePath = this._safePath(ctx.cwd, source, ctx.scopePredicates);
    const destinationPath = this._safePath(ctx.cwd, destination, ctx.scopePredicates);
    const hiddenSourceErr = this._hiddenReadError("move_file", source, sourcePath, ctx);
    if (hiddenSourceErr) return hiddenSourceErr;
    const protectedSourceErr = this._protectedMutationError("move_file", source, sourcePath, ctx);
    if (protectedSourceErr) return protectedSourceErr;
    const protectedDestinationErr = this._protectedMutationError("move_file", destination, destinationPath, ctx);
    if (protectedDestinationErr) return protectedDestinationErr;
    const sourceStat = this._lstatIfExists(sourcePath);
    if (!sourceStat) return `Error: Source file not found: ${source}`;
    const sourceSymlinkErr = this._symlinkMutationError("move_file", source, sourceStat);
    if (sourceSymlinkErr) return sourceSymlinkErr;
    if (sourceStat.isDirectory()) return `Error: move_file source is a directory: ${source}`;
    if (isSensitiveEnvFilePath(sourcePath)) {
      return "Error: move_file blocked - reading .env files is blocked.";
    }
    if (isSensitiveEnvFilePath(destinationPath)) {
      return "Error: move_file blocked - writing .env files is blocked.";
    }
    if (!ctx.scopePredicates.canEdit(sourcePath)) {
      return `Error: move_file blocked - ${source} is outside the allowed edit scope.`;
    }

    if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
      return `Error: move_file source and destination are the same path: ${destination}`;
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    const destinationStat = this._lstatIfExists(destinationPath);
    if (destinationStat) {
      if (!ctx.scopePredicates.canEdit(destinationPath)) {
        return `Error: move_file blocked - ${destination} is outside the allowed edit scope.`;
      }
      if (args?.overwrite !== true) {
        return `Error: move_file destination exists and overwrite is false: ${destination}`;
      }
      const destinationSymlinkErr = this._symlinkMutationError("move_file", destination, destinationStat);
      if (destinationSymlinkErr) return destinationSymlinkErr;
      if (destinationStat.isDirectory()) return `Error: move_file destination is a directory: ${destination}`;
      fs.rmSync(destinationPath, { force: true });
    } else if (!ctx.scopePredicates.canCreate(destinationPath)) {
      return `Error: move_file blocked - ${destination} is outside the allowed creation scope.`;
    }

    try {
      fs.renameSync(sourcePath, destinationPath);
    } catch (err) {
      if (String(err?.code) !== "EXDEV") {
        return `Error: move_file failed - ${err?.message || String(err)}`;
      }
      fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);
      fs.rmSync(sourcePath, { force: true });
    }

    return JSON.stringify({
      ok: true,
      source: path.relative(ctx.cwd, sourcePath).replace(/\\/g, "/"),
      destination: path.relative(ctx.cwd, destinationPath).replace(/\\/g, "/"),
    }, null, 2);
  }

  _copyFile(args, ctx) {
    if (!ctx.allowWrite) return "Error: copy_file is not available for this role.";
    const source = String(args?.source || "").trim();
    const destination = String(args?.destination || "").trim();
    if (!source || !destination) return "Error: copy_file requires source and destination.";

    const sourcePath = this._safePath(ctx.cwd, source, ctx.scopePredicates);
    const destinationPath = this._safePath(ctx.cwd, destination, ctx.scopePredicates);
    const hiddenSourceErr = this._hiddenReadError("copy_file", source, sourcePath, ctx);
    if (hiddenSourceErr) return hiddenSourceErr;
    const protectedSourceErr = this._protectedMutationError("copy_file", source, sourcePath, ctx);
    if (protectedSourceErr) return protectedSourceErr;
    const protectedDestinationErr = this._protectedMutationError("copy_file", destination, destinationPath, ctx);
    if (protectedDestinationErr) return protectedDestinationErr;
    const sourceStat = this._lstatIfExists(sourcePath);
    if (!sourceStat) return `Error: Source file not found: ${source}`;
    const sourceSymlinkErr = this._symlinkMutationError("copy_file", source, sourceStat);
    if (sourceSymlinkErr) return sourceSymlinkErr;
    if (sourceStat.isDirectory()) return `Error: copy_file source is a directory: ${source}`;
    if (isSensitiveEnvFilePath(sourcePath)) {
      return "Error: copy_file blocked - reading .env files is blocked.";
    }
    if (isSensitiveEnvFilePath(destinationPath)) {
      return "Error: copy_file blocked - writing .env files is blocked.";
    }
    if (path.resolve(sourcePath) === path.resolve(destinationPath)) {
      return `Error: copy_file source and destination are the same path: ${destination}`;
    }

    fs.mkdirSync(path.dirname(destinationPath), { recursive: true });
    const destinationStat = this._lstatIfExists(destinationPath);
    if (destinationStat) {
      if (!ctx.scopePredicates.canEdit(destinationPath)) {
        return `Error: copy_file blocked - ${destination} is outside the allowed edit scope.`;
      }
      if (args?.overwrite !== true) {
        return `Error: copy_file destination exists and overwrite is false: ${destination}`;
      }
      const destinationSymlinkErr = this._symlinkMutationError("copy_file", destination, destinationStat);
      if (destinationSymlinkErr) return destinationSymlinkErr;
      if (destinationStat.isDirectory()) return `Error: copy_file destination is a directory: ${destination}`;
      fs.rmSync(destinationPath, { force: true });
    } else if (!ctx.scopePredicates.canCreate(destinationPath)) {
      return `Error: copy_file blocked - ${destination} is outside the allowed creation scope.`;
    }

    fs.copyFileSync(sourcePath, destinationPath, fs.constants.COPYFILE_EXCL);

    return JSON.stringify({
      ok: true,
      source: path.relative(ctx.cwd, sourcePath).replace(/\\/g, "/"),
      destination: path.relative(ctx.cwd, destinationPath).replace(/\\/g, "/"),
    }, null, 2);
  }

  _makeDir(args, ctx) {
    if (!ctx.allowWrite) return "Error: make_dir is not available for this role.";
    const target = String(args?.path || "").trim();
    if (!target) return "Error: make_dir requires path.";

    const destinationPath = this._safePath(ctx.cwd, target, ctx.scopePredicates);
    const protectedErr = this._protectedMutationError("make_dir", target, destinationPath, ctx);
    if (protectedErr) return protectedErr;
    if (!ctx.scopePredicates.canCreate(destinationPath)) {
      return `Error: make_dir blocked - ${target} is outside the allowed creation scope.`;
    }
    fs.mkdirSync(destinationPath, { recursive: true });
    return JSON.stringify({
      ok: true,
      path: path.relative(ctx.cwd, destinationPath).replace(/\\/g, "/"),
    }, null, 2);
  }
}
