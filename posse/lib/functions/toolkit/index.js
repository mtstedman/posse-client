import crypto from "crypto";
import fs from "fs";
import path from "path";
import { execSync, spawnSync } from "child_process";

import { recordToolInvocation } from "../../domains/observability/functions/observations.js";
import { isInsideRoot, realpathExistingPrefix } from "../../domains/runtime/functions/fs-safety.js";
import {
  isSensitiveEnvFileOrTargetPath,
  isSensitiveEnvFilePath,
} from "../../domains/runtime/functions/sensitive-paths.js";
import { createInspectFileExecutor } from "../../domains/worker/functions/helpers/file-inspector.js";
import { createGitHistoryExecutor } from "../../domains/git/functions/history.js";
import { createPullBriefExecutor } from "./brief.js";
import { createBashExecutor } from "./bash-executor.js";
import {
  convertImageToPng,
  convertImageToJpeg,
  decodePngToRgba,
  detectImageFormat,
  encodeRgbaToPng,
  PNG_SIGNATURE,
  readJpegDimensions,
  resizeRgbaNearest,
} from "./image-codec.js";
import {
  addAgentHiddenRipgrepGlobs,
  addRipgrepSkipGlobs,
  compactRipgrepStderr,
  formatRipgrepRequirementError,
  globToRegex,
  isWorkspaceRootIgnoredByGit,
  makeGitIgnoreChecker,
  normalizeRelPath,
  normalizedGlob,
  parseRipgrepJsonMatches,
  resolveRipgrepCommand,
} from "./ripgrep.js";
import {
  declaredScopeFiles,
  runScopedChecks,
} from "./scoped-runners.js";
import {
  createRegisteredTest,
  createRegisteredTestSuite,
  runRegisteredTest,
  runRegisteredTestSuite,
} from "./registered-tests.js";
import {
  TOOL_CREATE_TEST,
  TOOL_CREATE_TEST_SUITE,
  TOOL_CLEAN_IMAGE,
  TOOL_EDIT_FILE,
  TOOL_EXTRACT_IMAGE_TEXT,
  TOOL_HASH_FILE,
  TOOL_LIST_FILES,
  TOOL_OPTIMIZE_IMAGE,
  TOOL_PRUNE_ARTIFACT_OUTPUT,
  TOOL_READ_FILE,
  TOOL_READ_IMAGE_METADATA,
  TOOL_REENCODE_IMAGE,
  TOOL_RESIZE_IMAGE,
  TOOL_RUN_SCOPED_CHECKS,
  TOOL_RUN_TEST,
  TOOL_RUN_TEST_SUITE,
  TOOL_SEARCH_FILES,
  TOOL_VALIDATE_ARTIFACT_OUTPUT,
  TOOL_WRITE_FILE,
} from "../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import { createWorkspaceSkipDirs } from "../../domains/runtime/functions/workspace-skip.js";
import {
  buildManifest,
  getArtifactProtocol,
  validateManifestAgainstContract,
} from "../../domains/artifacts/functions/index.js";
import { normPath, resolvePathWithin } from "../../shared/scope/functions/path.js";
import { MutationPolicy, splitShellSubcommands as policySplitShellSubcommands } from "../../shared/scope/classes/MutationPolicy.js";
import { agentHiddenReadablePathReason } from "../../shared/scope/functions/agent-hidden-paths.js";

const READ_FILE_DEFAULT_LIMIT = 2000;
const READ_FILE_MAX_SIZE_BYTES = 5 * 1024 * 1024;
const READ_FILE_MAX_SEARCH_MATCHES = 100;
const READ_FILE_MAX_SEARCH_PATTERN_CHARS = 200;
const EDIT_FILE_MAX_PATTERN_CHARS = 500;
const EDIT_FILE_REPLACE_PATTERN_TIMEOUT_MS = 2000;
const EDIT_FILE_MAX_PATTERN_MATCHES = 10000;
const EDIT_FILE_MAX_JSON_PATH_CHARS = 200;
const EDIT_FILE_BLOCKED_JSON_PATH_SEGMENTS = new Set(["__proto__", "constructor", "prototype"]);
const REPLACE_PATTERN_WORKER_SCRIPT = `
const fs = require("fs");
try {
  const input = JSON.parse(fs.readFileSync(0, "utf8"));
  const flags = input.global ? "g" : "";
  const re = new RegExp(input.pattern, flags);
  const countRe = new RegExp(input.pattern, flags.includes("g") ? flags : flags + "g");
  let matchCount = 0;
  let match;
  while ((match = countRe.exec(input.content)) !== null) {
    matchCount += 1;
    if (match[0] === "") countRe.lastIndex += 1;
    if (matchCount > input.maxMatches) {
      process.stdout.write(JSON.stringify({ ok: false, code: "too_many_matches", matchCount }));
      process.exit(0);
    }
  }
  if (matchCount === 0) {
    process.stdout.write(JSON.stringify({ ok: true, matchCount, content: input.content }));
    process.exit(0);
  }
  if (!input.global && matchCount > 1) {
    process.stdout.write(JSON.stringify({ ok: true, matchCount, ambiguous: true, content: input.content }));
    process.exit(0);
  }
  const content = input.content.replace(re, String(input.replacement ?? ""));
  process.stdout.write(JSON.stringify({ ok: true, matchCount, content }));
} catch (err) {
  process.stdout.write(JSON.stringify({ ok: false, code: "worker_error", message: err?.message || String(err) }));
}
`;

function toPositiveInt(value, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function hasStructuredReadOptions(args = {}) {
  return args.maxBytes != null || args.search != null || args.jsonPath != null;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function looksReDosProne(pattern) {
  return /\([^)]*[+*][^)]*\)[+*{]/.test(pattern)
    || /(\.\*){3,}/.test(pattern)
    || /\[[^\]]+\][+*]\s*[+*{]/.test(pattern);
}

function compileReadSearchPattern(pattern) {
  const raw = String(pattern || "");
  if (raw.length > READ_FILE_MAX_SEARCH_PATTERN_CHARS) {
    return {
      ok: false,
      message: `search pattern exceeds ${READ_FILE_MAX_SEARCH_PATTERN_CHARS} characters`,
    };
  }
  const source = looksReDosProne(raw) ? escapeRegExp(raw) : raw;
  try {
    return { ok: true, re: new RegExp(source, "i") };
  } catch (err) {
    return { ok: false, message: `Invalid search regex: ${err?.message || String(err)}` };
  }
}

function extractJsonPath(root, jsonPath) {
  const segments = String(jsonPath || "").split(".").filter(Boolean);
  let cursor = root;
  for (const segment of segments) {
    if (cursor == null) return undefined;
    if (Array.isArray(cursor) && /^\d+$/.test(segment)) {
      cursor = cursor[Number(segment)];
    } else if (typeof cursor === "object" && Object.prototype.hasOwnProperty.call(cursor, segment)) {
      cursor = cursor[segment];
    } else {
      return undefined;
    }
  }
  return cursor;
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined);
}

function hasOwn(value, key) {
  return Object.prototype.hasOwnProperty.call(Object(value), key);
}

function parseEditJsonPath(jsonPath) {
  const raw = String(jsonPath || "").trim();
  if (!raw) return { ok: false, message: "jsonPath mode requires jsonPath." };
  if (raw.length > EDIT_FILE_MAX_JSON_PATH_CHARS) {
    return { ok: false, message: `jsonPath exceeds ${EDIT_FILE_MAX_JSON_PATH_CHARS} characters.` };
  }
  const segments = raw.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0) return { ok: false, message: "jsonPath mode requires at least one path segment." };
  const unsafe = segments.find((segment) => EDIT_FILE_BLOCKED_JSON_PATH_SEGMENTS.has(segment));
  if (unsafe) return { ok: false, message: `jsonPath contains unsafe segment: ${unsafe}` };
  return { ok: true, segments };
}

function setJsonPathValue(root, segments, value) {
  let cursor = root;
  for (let i = 0; i < segments.length - 1; i += 1) {
    const segment = segments[i];
    if (cursor == null || typeof cursor !== "object") {
      return { ok: false, message: `jsonPath segment does not resolve to an object: ${segment}` };
    }
    if (Array.isArray(cursor)) {
      if (!/^\d+$/.test(segment)) return { ok: false, message: `jsonPath array segment must be a non-negative integer: ${segment}` };
      const index = Number(segment);
      if (index < 0 || index >= cursor.length) return { ok: false, message: `jsonPath array index is out of range: ${segment}` };
      cursor = cursor[index];
    } else {
      if (!hasOwn(cursor, segment)) return { ok: false, message: `jsonPath segment was not found: ${segment}` };
      cursor = cursor[segment];
    }
  }

  const leaf = segments[segments.length - 1];
  if (cursor == null || typeof cursor !== "object") {
    return { ok: false, message: `jsonPath parent does not resolve to an object: ${leaf}` };
  }
  if (Array.isArray(cursor)) {
    if (!/^\d+$/.test(leaf)) return { ok: false, message: `jsonPath array leaf must be a non-negative integer: ${leaf}` };
    const index = Number(leaf);
    if (index < 0 || index >= cursor.length) return { ok: false, message: `jsonPath array index is out of range: ${leaf}` };
    cursor[index] = value;
    return { ok: true };
  }
  cursor[leaf] = value;
  return { ok: true };
}

function splitEditableLines(content) {
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalEol = content.endsWith("\n");
  const body = hadFinalEol ? content.replace(/\r?\n$/, "") : content;
  const lines = body.length > 0 ? body.split(/\r?\n/) : [];
  return { eol, hadFinalEol, lines };
}

function splitReplacementLines(value) {
  const normalized = String(value ?? "").replace(/\r\n/g, "\n");
  const body = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  return body.length > 0 ? body.split("\n") : [];
}

function joinEditableLines(lines, eol, hadFinalEol) {
  return lines.join(eol) + (hadFinalEol ? eol : "");
}

function detectJsonIndent(content) {
  const lines = String(content || "").split(/\r?\n/);
  for (const line of lines) {
    const match = /^([ \t]+)(?:"|[{[]|[-\dtnf])/.exec(line);
    if (match) return match[1].slice(0, 10);
  }
  return "  ";
}

function applyReplacePatternWithBudget({ content, pattern, replacement, global, spawnSyncImpl }) {
  const input = JSON.stringify({
    content,
    pattern,
    replacement,
    global: !!global,
    maxMatches: EDIT_FILE_MAX_PATTERN_MATCHES,
  });
  const contentBytes = Buffer.byteLength(content, "utf8");
  const result = spawnSyncImpl(process.execPath, ["-e", REPLACE_PATTERN_WORKER_SCRIPT], {
    input,
    encoding: "utf8",
    timeout: EDIT_FILE_REPLACE_PATTERN_TIMEOUT_MS,
    maxBuffer: Math.max(64 * 1024 * 1024, contentBytes * 4),
    windowsHide: true,
  });
  if (result.error?.code === "ETIMEDOUT" || result.signal) {
    return {
      ok: false,
      message: `replacePattern exceeded ${EDIT_FILE_REPLACE_PATTERN_TIMEOUT_MS}ms time budget.`,
    };
  }
  if (result.error) {
    return { ok: false, message: `replacePattern worker failed: ${result.error.message}` };
  }
  let payload;
  try {
    payload = JSON.parse(String(result.stdout || ""));
  } catch {
    return { ok: false, message: "replacePattern worker returned invalid output." };
  }
  if (!payload?.ok) {
    if (payload?.code === "too_many_matches") {
      return {
        ok: false,
        message: `replacePattern matched more than ${EDIT_FILE_MAX_PATTERN_MATCHES} times.`,
      };
    }
    return { ok: false, message: payload?.message || "replacePattern worker failed." };
  }
  return {
    ok: true,
    content: String(payload.content ?? ""),
    matchCount: Number(payload.matchCount) || 0,
    ambiguous: payload.ambiguous === true,
  };
}

function formatNumberedLines(lines, startLine) {
  return lines.map((line, i) => `${String(startLine + i).padStart(6)}\t${line}`).join("\n");
}

function buildStructuredReadResult({
  args,
  displayPath,
  content,
  selectedLines,
  startLine,
  totalBytes,
  totalLines,
  truncated,
}) {
  let returnedLines = selectedLines;
  let rawContent = selectedLines.join("\n");
  let clipped = false;
  const maxBytes = toPositiveInt(args.maxBytes, null);
  if (maxBytes != null) {
    const buf = Buffer.from(rawContent, "utf8");
    if (buf.length > maxBytes) {
      rawContent = buf.subarray(0, maxBytes).toString("utf8");
      returnedLines = rawContent.split("\n");
      clipped = true;
    }
  }

  const data = {
    ok: true,
    path: displayPath,
    totalBytes,
    totalLines,
    startLine,
    returnedLines: returnedLines.length,
    truncated: Boolean(truncated || clipped),
    content: rawContent,
    numberedContent: formatNumberedLines(returnedLines, startLine),
  };

  if (args.search != null) {
    const compiled = compileReadSearchPattern(args.search);
    if (!compiled.ok) return `Error: ${compiled.message}`;
    const ctxLines = toNonNegativeInt(args.searchContext, 2);
    const matches = [];
    for (let li = 0; li < selectedLines.length; li += 1) {
      compiled.re.lastIndex = 0;
      if (compiled.re.test(selectedLines[li])) {
        matches.push({
          line: startLine + li,
          text: selectedLines[li],
          context: {
            before: selectedLines.slice(Math.max(0, li - ctxLines), li),
            after: selectedLines.slice(li + 1, Math.min(selectedLines.length, li + 1 + ctxLines)),
          },
        });
        if (matches.length >= READ_FILE_MAX_SEARCH_MATCHES) {
          data.truncated = true;
          break;
        }
      }
    }
    data.matches = matches;
  }

  if (args.jsonPath != null) {
    try {
      const parsed = JSON.parse(content);
      const value = extractJsonPath(parsed, args.jsonPath);
      data.jsonPathValue = value;
      data.jsonPathMatched = value !== undefined;
    } catch (err) {
      data.jsonPathMatched = false;
      data.jsonPathError = `Invalid JSON: ${err?.message || String(err)}`;
    }
  }

  return JSON.stringify(data, null, 2);
}

export {
  TOOL_BASH,
  TOOL_CHAIN_READ,
  TOOL_CHAIN_VERDICT,
  TOOL_CLEAN_IMAGE,
  TOOL_COPY_FILE,
  TOOL_CREATE_TEST,
  TOOL_CREATE_TEST_SUITE,
  TOOL_EDIT_FILE,
  TOOL_EXTRACT_IMAGE_TEXT,
  TOOL_GENERATE_IMAGE,
  TOOL_GIT_HISTORY,
  TOOL_HASH_FILE,
  TOOL_INSPECT_FILE,
  TOOL_LIST_FILES,
  TOOL_MAKE_DIR,
  TOOL_MOVE_FILE,
  TOOL_OPTIMIZE_IMAGE,
  TOOL_PRUNE_ARTIFACT_OUTPUT,
  TOOL_PULL_BRIEF,
  TOOL_READ_FILE,
  TOOL_READ_IMAGE_METADATA,
  TOOL_REENCODE_IMAGE,
  TOOL_RESIZE_IMAGE,
  TOOL_RUN_SCOPED_CHECKS,
  TOOL_RUN_TEST,
  TOOL_RUN_TEST_SUITE,
  TOOL_SEARCH_FILES,
  TOOL_VALIDATE_ARTIFACT_OUTPUT,
  TOOL_WRITE_FILE,
} from "../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
export {
  getAtlasDeterministicToolDefinitions,
  prepareAtlasDeterministicPayload,
  resolveAtlasDeterministicAction,
  resolveAtlasDeterministicCliAction,
  executeAtlasDeterministicCommand,
} from "./atlas.js";
export { createBashExecutor } from "./bash-executor.js";
export { globToRegex, resolveRipgrepCommand } from "./ripgrep.js";


export const DEFAULT_SKIP_DIRS = createWorkspaceSkipDirs();
const SEARCH_MAX_FILE_BYTES = 5 * 1024 * 1024;
const SEARCH_BINARY_SNIFF_BYTES = 8 * 1024;
const SEARCH_DEFAULT_HEAD_LIMIT = 100;
const SEARCH_MAX_HEAD_LIMIT = 500;
const SEARCH_RIPGREP_MAX_BUFFER = 32 * 1024 * 1024;
const SEARCH_RIPGREP_TIMEOUT_MS = 30_000;
const PRIVATE_WORKSPACE_DOT_DIRS = new Set([".git", ".claude", ".codex", ".posse-worktrees", ".posse-test-suites"]);
const PRIVATE_POSSE_ROOTS = new Set([
  "agent-loaders",
  "db",
  "logs",
  "mcp",
  "research-state",
  "atlas",
]);



export function safePath(cwd, filePath, scopePredicates = null) {
  const resolved = path.resolve(cwd, filePath);
  const realCwd = realpathExistingPrefix(cwd);
  const realResolved = realpathExistingPrefix(resolved);
  const withinCwd = isInsideRoot(realResolved, realCwd, { followSymlinks: false });
  if (!withinCwd && !scopePredicates?.isWithinScopeRoot(realResolved)) {
    throw new Error(`Path escapes working directory: ${filePath}`);
  }
  if (withinCwd && isPrivateWorkspacePath(realCwd, realResolved)) {
    throw new Error(`Access to private workspace metadata is blocked: ${filePath}`);
  }
  return resolved;
}

function isPrivateWorkspacePath(realCwd, resolvedPath) {
  const rel = normalizeRelPath(path.relative(realCwd, resolvedPath));
  if (!rel || rel === ".") return false;
  const parts = rel.split("/").filter(Boolean);
  const first = parts[0];
  if (PRIVATE_WORKSPACE_DOT_DIRS.has(first)) return true;
  if (first === ".posse") {
    // Artifact/resources paths are explicit job outputs. Runtime metadata is not
    // part of the agent-visible workspace.
    if (parts[1] === "resources") return false;
    if (!parts[1] || PRIVATE_POSSE_ROOTS.has(parts[1])) return true;
    return true;
  }
  return false;
}

function agentHiddenPathReasonForAbsolute(cwd, resolvedPath) {
  const rel = normalizeRelPath(path.relative(cwd, resolvedPath));
  return agentHiddenReadablePathReason(rel);
}

function agentHiddenPathError(cwd, resolvedPath, displayPath) {
  const reason = agentHiddenPathReasonForAbsolute(cwd, resolvedPath);
  return reason ? `Access to hidden workspace path is blocked: ${displayPath} (${reason}).` : null;
}

export function buildScopePredicates(cwd, scope) {
  return MutationPolicy.fromScopeSpec(scope, { cwd }).toToolkitPredicates();
}

export function splitShellSubcommands(command) {
  return policySplitShellSubcommands(command);
}




export {
  isSensitiveEnvFileOrTargetPath,
  isSensitiveEnvFilePath,
};

function toNonNegativeInt(value, fallback = 0) {
  if (value === undefined || value === null || value === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(0, Math.floor(parsed));
}

function isSuccessfulToolResult(result) {
  const text = typeof result === "string" ? result : String(result ?? "");
  return !/^(?:Error:|AUDIT ERROR:)/i.test(text);
}



export function createDeterministicToolkit({
  safePath: safePathImpl = safePath,
  skipDirs = DEFAULT_SKIP_DIRS,
  skipObservationLogging = false,
  ripgrepCommand = resolveRipgrepCommand(),
  spawnSyncImpl = spawnSync,
  gitNativeParity = {},
} = {}) {
  if (typeof safePathImpl !== "function") {
    throw new Error("createDeterministicToolkit requires a safePath function");
  }
  if (typeof spawnSyncImpl !== "function") {
    throw new Error("createDeterministicToolkit requires a spawnSync function");
  }

  function wrapDeterministicExecutor(toolName, execFn) {
    if (skipObservationLogging) return execFn;
    return function wrappedDeterministicExecutor(args, cwd, scopePredicates, ...rest) {
      const result = execFn(args, cwd, scopePredicates, ...rest);
      if (result && typeof result.then === "function") {
        return result.then((resolved) => {
          if (isSuccessfulToolResult(resolved)) {
            recordToolInvocation({ tool: toolName, input: args, cwd });
          }
          return resolved;
        });
      }
      if (isSuccessfulToolResult(result)) {
        recordToolInvocation({ tool: toolName, input: args, cwd });
      }
      return result;
    };
  }

  function execReadFile(args, cwd, scopePredicates) {
    let filePath;
    try {
      filePath = safePathImpl(cwd, args.path, scopePredicates);
    } catch (err) {
      return `Error: ${err.message}`;
    }
    const hiddenErr = agentHiddenPathError(cwd, filePath, args.path);
    if (hiddenErr) return `Error: ${hiddenErr}`;
    if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
    if (isSensitiveEnvFileOrTargetPath(filePath)) {
      return "Error: Access to .env files is blocked. Use documented config examples or code paths instead.";
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) return `Error: Path is a directory, not a file: ${filePath}`;
    if (stat.size > READ_FILE_MAX_SIZE_BYTES) {
      return `Error: File too large (${(stat.size / 1024 / 1024).toFixed(1)} MB). Use offset/limit to read a portion.`;
    }

    const content = fs.readFileSync(filePath, "utf-8");
    const lines = content.split("\n");
    const offset = Math.max(0, toPositiveInt(args.offset, 1) - 1);
    const limit = toPositiveInt(args.limit, READ_FILE_DEFAULT_LIMIT);
    const selected = lines.slice(offset, offset + limit);
    if (selected.length === 0) {
      return `File has ${lines.length} lines. Requested offset ${offset + 1} is beyond end of file.`;
    }
    const remaining = lines.length - offset - limit;
    if (hasStructuredReadOptions(args)) {
      return buildStructuredReadResult({
        args,
        displayPath: args.path,
        content,
        selectedLines: selected,
        startLine: offset + 1,
        totalBytes: stat.size,
        totalLines: lines.length,
        truncated: remaining > 0,
      });
    }
    const numbered = formatNumberedLines(selected, offset + 1);
    return numbered + (remaining > 0 ? `\n... (${remaining} more lines)` : "");
  }

  function writeTextFileAtomic(filePath, content) {
    const tempPath = tempSiblingPath(filePath, "");
    try {
      const existing = fs.statSync(filePath, { throwIfNoEntry: false });
      fs.writeFileSync(tempPath, content, "utf-8");
      if (existing) fs.chmodSync(tempPath, existing.mode);
      fs.renameSync(tempPath, filePath);
    } catch {
      // Rename can fail when the target is open/locked (Windows); fall back
      // to the in-place write so the failure mode is no worse than before.
      removeFileBestEffort(tempPath);
      fs.writeFileSync(filePath, content, "utf-8");
    }
  }

  function execWriteFile(args, cwd, scopePredicates) {
    let filePath;
    try {
      filePath = safePathImpl(cwd, args.path, scopePredicates);
    } catch (err) {
      return `Error: ${err.message}`;
    }
    if (isSensitiveEnvFileOrTargetPath(filePath)) {
      return "Error: Writing .env files is blocked. Use documented config examples or code paths instead.";
    }
    const exists = fs.existsSync(filePath);
    if (exists && scopePredicates?.hasScope && !scopePredicates.canEdit(filePath)) {
      return `Error: write_file blocked - ${args.path} is outside the allowed edit scope.`;
    }
    if (!exists && scopePredicates?.hasScope && !scopePredicates.canCreate(filePath)) {
      return `Error: write_file blocked - ${args.path} is outside the allowed creation scope.`;
    }
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    writeTextFileAtomic(filePath, args.content);
    return `File written: ${filePath} (${args.content.length} chars)`;
  }

  function execEditFile(args, cwd, scopePredicates) {
    let filePath;
    try {
      filePath = safePathImpl(cwd, args.path, scopePredicates);
    } catch (err) {
      return `Error: ${err.message}`;
    }
    if (!fs.existsSync(filePath)) return `Error: File not found: ${filePath}`;
    if (isSensitiveEnvFileOrTargetPath(filePath)) {
      return "Error: Editing .env files is blocked. Use documented config examples or code paths instead.";
    }
    if (scopePredicates?.hasScope && !scopePredicates.canEdit(filePath)) {
      return `Error: edit_file blocked - ${args.path} is outside the allowed edit scope.`;
    }
    const originalContent = fs.readFileSync(filePath, "utf-8");
    let content = originalContent;

    const exactRequested = args.old_string !== undefined || args.new_string !== undefined;
    const replaceLines = firstDefined(args.replaceLines, args.replace_lines);
    const replacePattern = firstDefined(args.replacePattern, args.replace_pattern);
    const insertAt = firstDefined(args.insertAt, args.insert_at);
    const append = args.append;
    const jsonPath = firstDefined(args.jsonPath, args.json_path);
    const jsonValueProvided = hasOwn(args, "jsonValue") || hasOwn(args, "json_value");
    const modes = [
      exactRequested && "old_string/new_string",
      replaceLines !== undefined && "replaceLines",
      replacePattern !== undefined && "replacePattern",
      insertAt !== undefined && "insertAt",
      append !== undefined && "append",
      (jsonPath !== undefined || jsonValueProvided) && "jsonPath/jsonValue",
    ].filter(Boolean);
    if (modes.length === 0) {
      return "Error: edit_file requires exactly one edit mode: old_string/new_string, replaceLines, replacePattern, insertAt, append, or jsonPath/jsonValue.";
    }
    if (modes.length > 1) {
      return `Error: edit_file accepts only one edit mode per call; received ${modes.join(", ")}.`;
    }

    if (modes[0] === "replaceLines") {
      const source = replaceLines && typeof replaceLines === "object" && !Array.isArray(replaceLines) ? replaceLines : {};
      const start = Number(source.start);
      const end = Number(source.end);
      if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || end < start) {
        return "Error: replaceLines requires integer start/end with 0 <= start <= end.";
      }
      const { eol, hadFinalEol, lines } = splitEditableLines(content);
      if (start > lines.length || end > lines.length) {
        return `Error: replaceLines range ${start}:${end} is outside ${filePath} (${lines.length} lines).`;
      }
      lines.splice(start, end - start, ...splitReplacementLines(source.content));
      content = joinEditableLines(lines, eol, hadFinalEol);
      if (content === originalContent) return `Error: edit_file made no changes in ${filePath}.`;
      writeTextFileAtomic(filePath, content);
      return `File edited: ${filePath} (replaceLines ${start}:${end})`;
    }

    if (modes[0] === "replacePattern") {
      const source = replacePattern && typeof replacePattern === "object" && !Array.isArray(replacePattern) ? replacePattern : {};
      const pattern = String(source.pattern || "");
      if (!pattern) return "Error: replacePattern requires pattern.";
      if (pattern.length > EDIT_FILE_MAX_PATTERN_CHARS) {
        return `Error: replacePattern pattern exceeds ${EDIT_FILE_MAX_PATTERN_CHARS} characters.`;
      }
      if (looksReDosProne(pattern)) {
        return "Error: replacePattern contains an unsafe nested quantifier.";
      }
      try {
        new RegExp(pattern, source.global ? "g" : "");
      } catch (err) {
        return `Error: Invalid replacePattern regex: ${err?.message || String(err)}`;
      }
      const replaced = applyReplacePatternWithBudget({
        content,
        pattern,
        replacement: String(source.replacement ?? ""),
        global: source.global,
        spawnSyncImpl,
      });
      if (!replaced.ok) return `Error: ${replaced.message}`;
      const matchCount = replaced.matchCount;
      if (matchCount === 0) return `Error: replacePattern did not match ${filePath}.`;
      if (replaced.ambiguous) {
        return `Error: replacePattern matched ${matchCount} times in ${filePath}. Set global=true or make the pattern unique.`;
      }
      content = replaced.content;
      if (content === originalContent) return `Error: edit_file made no changes in ${filePath}.`;
      writeTextFileAtomic(filePath, content);
      return `File edited: ${filePath} (replacePattern ${matchCount} match${matchCount === 1 ? "" : "es"})`;
    }

    if (modes[0] === "insertAt") {
      const source = insertAt && typeof insertAt === "object" && !Array.isArray(insertAt) ? insertAt : {};
      const line = Number(source.line);
      if (!Number.isInteger(line) || line < 0) return "Error: insertAt requires a non-negative integer line.";
      const { eol, hadFinalEol, lines } = splitEditableLines(content);
      if (line > lines.length) return `Error: insertAt line ${line} is outside ${filePath} (${lines.length} lines).`;
      lines.splice(line, 0, ...splitReplacementLines(source.content));
      content = joinEditableLines(lines, eol, hadFinalEol);
      if (content === originalContent) return `Error: edit_file made no changes in ${filePath}.`;
      writeTextFileAtomic(filePath, content);
      return `File edited: ${filePath} (insertAt ${line})`;
    }

    if (modes[0] === "append") {
      content += String(append ?? "");
      if (content === originalContent) return `Error: edit_file made no changes in ${filePath}.`;
      writeTextFileAtomic(filePath, content);
      return `File edited: ${filePath} (append)`;
    }

    if (modes[0] === "jsonPath/jsonValue") {
      if (!jsonValueProvided) return "Error: jsonPath mode requires jsonValue.";
      const parsedPath = parseEditJsonPath(jsonPath);
      if (!parsedPath.ok) return `Error: ${parsedPath.message}`;
      let parsed;
      try {
        parsed = JSON.parse(content);
      } catch (err) {
        return `Error: jsonPath mode requires valid JSON: ${err?.message || String(err)}`;
      }
      const jsonValue = hasOwn(args, "jsonValue") ? args.jsonValue : args.json_value;
      const updated = setJsonPathValue(parsed, parsedPath.segments, jsonValue);
      if (!updated.ok) return `Error: ${updated.message}`;
      const eol = content.includes("\r\n") ? "\r\n" : "\n";
      const trailing = content.endsWith("\n") ? eol : "";
      content = JSON.stringify(parsed, null, detectJsonIndent(content)).replace(/\n/g, eol) + trailing;
      if (content === originalContent) return `Error: edit_file made no changes in ${filePath}.`;
      writeTextFileAtomic(filePath, content);
      return `File edited: ${filePath} (jsonPath ${String(jsonPath)})`;
    }

    if (typeof args.old_string !== "string" || typeof args.new_string !== "string") {
      return "Error: old_string/new_string mode requires both old_string and new_string.";
    }
    const exactCount = content.split(args.old_string).length - 1;
    if (exactCount > 1) {
      return `Error: old_string found ${exactCount} times in ${filePath}. It must be unique - provide more surrounding context.`;
    }
    if (exactCount === 1) {
      content = content.replace(args.old_string, args.new_string);
      if (content === originalContent) {
        return `Error: edit_file made no changes in ${filePath}. old_string/new_string resolved to identical content.`;
      }
      writeTextFileAtomic(filePath, content);
      return `File edited: ${filePath}`;
    }

    const fileEol = content.includes("\r\n") ? "\r\n" : "\n";
    const normalizeEol = (value) => String(value || "").replace(/\r\n/g, "\n");
    const oldWithFileEol = normalizeEol(args.old_string).replace(/\n/g, fileEol);
    const newWithFileEol = normalizeEol(args.new_string).replace(/\n/g, fileEol);
    const normalizedCount = content.split(oldWithFileEol).length - 1;
    if (normalizedCount === 0) {
      return `Error: old_string not found in ${filePath}. Make sure it matches exactly (including whitespace/indentation); line-ending mismatch may be the cause.`;
    }
    if (normalizedCount > 1) {
      return `Error: old_string found ${normalizedCount} times in ${filePath} after normalizing line endings. It must be unique - provide more surrounding context.`;
    }

    content = content.replace(oldWithFileEol, newWithFileEol);
    if (content === originalContent) {
      return `Error: edit_file made no changes in ${filePath}. old_string/new_string resolved to identical content after line-ending normalization.`;
    }
    writeTextFileAtomic(filePath, content);
    return `File edited: ${filePath}`;
  }

  function execListFiles(args, cwd, scopePredicates) {
    let dir;
    try {
      const requestedDir = args.path ?? args.directory;
      dir = requestedDir ? safePathImpl(cwd, requestedDir, scopePredicates) : cwd;
      const hiddenErr = agentHiddenPathError(cwd, dir, requestedDir || ".");
      if (hiddenErr) return `Error: ${hiddenErr}`;
    } catch (err) {
      return `Error: ${err.message}`;
    }
    if (!fs.existsSync(dir)) return `Error: Directory not found: ${dir}`;
    const recursive = args.recursive !== false;
    const pattern = args.pattern || null;
    const globRegex = pattern ? new RegExp("^" + pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*").replace(/\?/g, ".") + "$") : null;
    const results = [];
    const maxResults = 200;
    const isGitIgnored = makeGitIgnoreChecker(cwd);

    function walk(currentDir) {
      if (results.length >= maxResults) return;
      let entries;
      try { entries = fs.readdirSync(currentDir, { withFileTypes: true }); } catch { return; }
      for (const entry of entries) {
        if (results.length >= maxResults) return;
        if (skipDirs.has(entry.name)) continue;
        const full = path.join(currentDir, entry.name);
        if (agentHiddenPathReasonForAbsolute(cwd, full)) continue;
        if (isGitIgnored(full)) continue;
        if (entry.isDirectory()) {
          if (recursive) walk(full);
        } else if (entry.isFile() && (!globRegex || globRegex.test(entry.name))) {
          results.push(full);
        }
      }
    }

    try {
      if (recursive) {
        walk(dir);
      } else {
        const entries = fs.readdirSync(dir, { withFileTypes: true });
        for (const entry of entries) {
          if (results.length >= maxResults) break;
          if (skipDirs.has(entry.name)) continue;
          const full = path.join(dir, entry.name);
          if (agentHiddenPathReasonForAbsolute(cwd, full)) continue;
          if (isGitIgnored(full)) continue;
          if (entry.isFile() && (!globRegex || globRegex.test(entry.name))) {
            results.push(full);
          }
        }
      }
      return results.join("\n") || "No files found.";
    } catch (err) {
      return `Error listing files: ${err.message}`;
    }
  }

  function execSearchFiles(args, cwd, scopePredicates) {
    if (!args || typeof args.pattern !== "string") return "Error: pattern is required and must be a string.";

    const outputMode = typeof args.output_mode === "string" ? args.output_mode : "content";
    if (!["content", "files_with_matches", "count"].includes(outputMode)) {
      return `Error: Unsupported output_mode "${outputMode}".`;
    }

    const sharedContext = args.context != null ? toNonNegativeInt(args.context, 0) : null;
    let beforeContext = sharedContext != null ? sharedContext : 0;
    let afterContext = sharedContext != null ? sharedContext : 0;
    if (args.before_context != null) beforeContext = toNonNegativeInt(args.before_context, 0);
    if (args.after_context != null) afterContext = toNonNegativeInt(args.after_context, 0);

    const offset = toNonNegativeInt(args.offset, 0);
    const headLimit = Math.min(toNonNegativeInt(args.head_limit, SEARCH_DEFAULT_HEAD_LIMIT), SEARCH_MAX_HEAD_LIMIT);

    try {
      let searchPath;
      try {
        searchPath = args.path ? safePathImpl(cwd, args.path, scopePredicates) : cwd;
      } catch (err) {
        return `Error: ${err.message}`;
      }
      const hiddenErr = agentHiddenPathError(cwd, searchPath, args.path || ".");
      if (hiddenErr) return `Error: ${hiddenErr}`;
      if (!fs.existsSync(searchPath)) return "No matches found.";
      const isDir = fs.existsSync(searchPath) && fs.statSync(searchPath).isDirectory();
      if (!isDir && isSensitiveEnvFileOrTargetPath(searchPath)) {
        return "Error: Access to .env files is blocked. Use documented config examples or code paths instead.";
      }
      const rootPath = isDir ? searchPath : path.dirname(searchPath);
      const targetPath = isDir ? "." : path.basename(searchPath);

      const rgArgs = [
        "--json",
        "--line-number",
        "--with-filename",
        "--color=never",
        "--no-messages",
        "--hidden",
        "--sort",
        "path",
        "--max-filesize",
        String(SEARCH_MAX_FILE_BYTES),
      ];
      if (isWorkspaceRootIgnoredByGit(rootPath)) rgArgs.push("--no-ignore");
      addRipgrepSkipGlobs(rgArgs, skipDirs);
      addAgentHiddenRipgrepGlobs(rgArgs);
      if (args.include) rgArgs.push("--glob", normalizedGlob(args.include));
      if (args.literal) rgArgs.push("--fixed-strings");
      if (args.case_insensitive) rgArgs.push("--ignore-case");
      if (args.multiline) {
        rgArgs.push("--multiline");
        rgArgs.push("--multiline-dotall");
      }
      rgArgs.push("--regexp", args.pattern);
      rgArgs.push("--", targetPath);

      const result = spawnSyncImpl(ripgrepCommand, rgArgs, {
        cwd: rootPath,
        encoding: "utf-8",
        maxBuffer: SEARCH_RIPGREP_MAX_BUFFER,
        stdio: ["ignore", "pipe", "pipe"],
        timeout: SEARCH_RIPGREP_TIMEOUT_MS,
        windowsHide: true,
      });

      if (result.error) {
        if (result.error.code === "ETIMEDOUT") {
          return `Error: search_files timed out after ${SEARCH_RIPGREP_TIMEOUT_MS / 1000}s. Narrow the path or simplify the pattern.`;
        }
        if (["ENOENT", "EACCES", "EPERM"].includes(result.error.code)) {
          return formatRipgrepRequirementError(ripgrepCommand, result.error);
        }
        return `Error: search_files ripgrep failed - ${result.error.message}`;
      }

      if (result.status === 1) return "No matches found.";
      if (result.status !== 0) {
        const stderr = compactRipgrepStderr(result.stderr);
        if (/regex parse error|error parsing regex|PCRE2|invalid regex/i.test(stderr)) {
          return `Error: Invalid ripgrep pattern - ${stderr || "unknown parse error"}`;
        }
        return `Error: search_files ripgrep failed (${result.status ?? "unknown"}) - ${stderr || "unknown error"}`;
      }

      const { filesWithMatches, fileMatchCounts, contentRows } = parseRipgrepJsonMatches(
        result.stdout,
        rootPath,
        outputMode,
        beforeContext,
        afterContext,
        { isSensitivePath: (filePath) => isSensitiveEnvFileOrTargetPath(filePath) || !!agentHiddenPathReasonForAbsolute(cwd, filePath) },
      );

      if (outputMode === "files_with_matches") {
        const rows = [...filesWithMatches].sort((a, b) => a.localeCompare(b));
        const page = rows.slice(offset, offset + headLimit);
        return page.join("\n") || "No matches found.";
      }

      if (outputMode === "count") {
        const rows = [...fileMatchCounts.entries()]
          .sort((a, b) => a[0].localeCompare(b[0]))
          .map(([file, count]) => `${file}:${count}`);
        const page = rows.slice(offset, offset + headLimit);
        return page.join("\n") || "No matches found.";
      }

      const rows = contentRows.map((entry) => {
        const out = [`${entry.file}:${entry.line}:${entry.text}`];
        if (entry.before.length > 0 || entry.after.length > 0) {
          for (const before of entry.before) out.push(`${entry.file}:${before.line}-${before.text}`);
          for (const after of entry.after) out.push(`${entry.file}:${after.line}+${after.text}`);
          out.push("--");
        }
        return out.join("\n");
      });
      const page = rows.slice(offset, offset + headLimit);
      return page.join("\n") || "No matches found.";
    } catch (err) {
      return `Error: search_files failed - ${err.message}`;
    }
  }

  function execHashFile(args, cwd, scopePredicates) {
    try {
      const filePath = safePathImpl(cwd, args.path, scopePredicates);
      const hiddenErr = agentHiddenPathError(cwd, filePath, args.path);
      if (hiddenErr) {
        return JSON.stringify({
          path: filePath,
          exists: fs.existsSync(filePath),
          error: hiddenErr,
        }, null, 2);
      }
      if (isSensitiveEnvFileOrTargetPath(filePath)) {
        return JSON.stringify({
          path: filePath,
          exists: fs.existsSync(filePath),
          error: "Access to .env files is blocked. Use documented config examples or code paths instead.",
        }, null, 2);
      }
      if (!fs.existsSync(filePath)) {
        return JSON.stringify({ path: filePath, exists: false }, null, 2);
      }
      const stat = fs.statSync(filePath);
      if (!stat.isFile()) {
        return JSON.stringify({
          path: filePath,
          exists: true,
          isFile: false,
          isDirectory: stat.isDirectory(),
        }, null, 2);
      }
      const algorithm = args.algorithm || "sha256";
      const hash = crypto.createHash(algorithm).update(fs.readFileSync(filePath)).digest("hex");
      return JSON.stringify({
        path: filePath,
        exists: true,
        isFile: true,
        algorithm,
        size: stat.size,
        hash,
      }, null, 2);
    } catch (err) {
      return `Error: ${err.message}`;
    }
  }

  function normalizeArtifactExtension(value) {
    const raw = String(value || "").trim().toLowerCase();
    if (!raw) return "";
    return raw.startsWith(".") ? raw : `.${raw}`;
  }

  function artifactManifestPatternsFor(taskMode) {
    const protocol = getArtifactProtocol(taskMode) || {};
    return (protocol.allowed_manifest_files || []).map((entry) => {
      const str = String(entry || "");
      if (!str.includes("*")) return { kind: "exact", value: str };
      const escaped = str.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
      return { kind: "glob", value: new RegExp(`^${escaped}$`) };
    });
  }

  function isArtifactManifestFile(relPath, patterns) {
    const basename = String(relPath || "").split("/").pop();
    for (const pattern of patterns) {
      if (pattern.kind === "exact" ? pattern.value === basename : pattern.value.test(basename)) return true;
    }
    return false;
  }

  function resolveArtifactChild(rootPath, relPath) {
    const raw = String(relPath || "").trim();
    if (!raw) return null;
    return resolvePathWithin(rootPath, raw, { allowEqual: false });
  }

  function isWritableArtifactRoot(rootPath, scopePredicates) {
    if (!scopePredicates?.hasScope) return false;
    return scopePredicates.canCreate(rootPath)
      || scopePredicates.canEdit(rootPath)
      || scopePredicates.isWithinScopeRoot(rootPath);
  }

  function readImageFacts(filePath) {
    const buffer = fs.readFileSync(filePath);
    const format = detectImageFormat(buffer);
    let width = null;
    let height = null;
    let hasTransparency = null;
    if (format === "png") {
      try {
        const parsed = decodePngToRgba(buffer);
        width = parsed.width;
        height = parsed.height;
        hasTransparency = false;
        for (let i = 3; i < parsed.data.length; i += 4) {
          if (parsed.data[i] < 255) {
            hasTransparency = true;
            break;
          }
        }
      } catch {
        if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
          width = buffer.readUInt32BE(16);
          height = buffer.readUInt32BE(20);
        }
      }
    } else if (format === "jpeg") {
      const dims = readJpegDimensions(buffer);
      width = dims.width;
      height = dims.height;
      hasTransparency = false;
    }
    return {
      format,
      width,
      height,
      hasTransparency,
      bytes: buffer.length,
    };
  }

  function execValidateArtifactOutput(args, cwd, scopePredicates) {
    const rootArg = args.output_root || ".";
    const rootPath = safePathImpl(cwd, rootArg, scopePredicates);
    if (!fs.existsSync(rootPath)) return `Error: Artifact output root not found: ${rootPath}`;
    if (!fs.statSync(rootPath).isDirectory()) return `Error: Artifact output root is not a directory: ${rootPath}`;
    if (scopePredicates?.hasScope && !isWritableArtifactRoot(rootPath, scopePredicates)) {
      return `Error: validate_artifact_output blocked - ${rootArg} is outside the allowed artifact scope.`;
    }

    const taskMode = String(args.task_mode || "image").trim() || "image";
    const manifest = buildManifest(rootPath, rootPath);
    const protocolResult = validateManifestAgainstContract(manifest, taskMode);
    const violations = [...(protocolResult.violations || [])];
    const warnings = [...(protocolResult.warnings || [])];
    const manifestPatterns = artifactManifestPatternsFor(taskMode);
    const manifestFileSet = new Set(
      manifest.files
        .filter((file) => isArtifactManifestFile(file.path, manifestPatterns))
        .map((file) => file.path),
    );

    const allowedExtensions = Array.isArray(args.allowed_extensions) && args.allowed_extensions.length > 0
      ? new Set(args.allowed_extensions.map(normalizeArtifactExtension).filter(Boolean))
      : null;
    if (allowedExtensions) {
      const disallowed = manifest.files.filter((file) => !manifestFileSet.has(file.path) && !allowedExtensions.has(file.ext));
      if (disallowed.length > 0) {
        violations.push(`${disallowed.length} file(s) with disallowed formats: ${disallowed.slice(0, 8).map((file) => `${file.path} (${file.ext || "no extension"})`).join(", ")}`);
      }
    }

    if (Number.isInteger(Number(args.min_bytes)) && Number(args.min_bytes) >= 0) {
      const minBytes = Number(args.min_bytes);
      const undersized = manifest.files.filter((file) => !manifestFileSet.has(file.path) && file.size < minBytes);
      if (undersized.length > 0) {
        violations.push(`${undersized.length} file(s) below minimum size (${minBytes} bytes): ${undersized.slice(0, 8).map((file) => file.path).join(", ")}`);
      }
    }

    const byPath = new Map(manifest.files.map((file) => [file.path, file]));
    for (const expected of Array.isArray(args.expected_files) ? args.expected_files : []) {
      const rel = normPath(expected);
      if (!byPath.has(rel)) violations.push(`Missing expected file: ${rel}`);
    }

    const imageChecks = [];
    for (const spec of Array.isArray(args.expected_images) ? args.expected_images : []) {
      const rel = normPath(spec?.path || "");
      if (!rel) {
        violations.push("Expected image entry is missing path.");
        continue;
      }
      const imagePath = resolveArtifactChild(rootPath, rel);
      if (!imagePath) {
        violations.push(`Expected image path escapes output_root: ${rel}`);
        continue;
      }
      if (!fs.existsSync(imagePath)) {
        violations.push(`Missing expected image: ${rel}`);
        continue;
      }
      if (!fs.statSync(imagePath).isFile()) {
        violations.push(`Expected image is not a file: ${rel}`);
        continue;
      }
      let facts;
      try {
        facts = readImageFacts(imagePath);
      } catch (err) {
        violations.push(`Could not inspect expected image ${rel}: ${err.message}`);
        continue;
      }
      imageChecks.push({ path: rel, ...facts });
      if (spec.width != null && facts.width !== Number(spec.width)) {
        violations.push(`${rel} width ${facts.width} does not equal expected ${Number(spec.width)}`);
      }
      if (spec.height != null && facts.height !== Number(spec.height)) {
        violations.push(`${rel} height ${facts.height} does not equal expected ${Number(spec.height)}`);
      }
      if (spec.min_width != null && !(facts.width >= Number(spec.min_width))) {
        violations.push(`${rel} width ${facts.width} is below minimum ${Number(spec.min_width)}`);
      }
      if (spec.min_height != null && !(facts.height >= Number(spec.min_height))) {
        violations.push(`${rel} height ${facts.height} is below minimum ${Number(spec.min_height)}`);
      }
      if (spec.max_width != null && !(facts.width <= Number(spec.max_width))) {
        violations.push(`${rel} width ${facts.width} exceeds maximum ${Number(spec.max_width)}`);
      }
      if (spec.max_height != null && !(facts.height <= Number(spec.max_height))) {
        violations.push(`${rel} height ${facts.height} exceeds maximum ${Number(spec.max_height)}`);
      }
      if (typeof spec.transparent === "boolean" && facts.hasTransparency !== null && facts.hasTransparency !== spec.transparent) {
        violations.push(`${rel} transparency ${facts.hasTransparency} does not equal expected ${spec.transparent}`);
      }
    }

    return JSON.stringify({
      ok: violations.length === 0,
      output_root: rootPath,
      task_mode: taskMode,
      manifest,
      image_checks: imageChecks,
      violations,
      warnings,
    }, null, 2);
  }

  function execPruneArtifactOutput(args, cwd, scopePredicates) {
    const rootArg = args.output_root || ".";
    const rootPath = safePathImpl(cwd, rootArg, scopePredicates);
    if (!fs.existsSync(rootPath)) return `Error: Artifact output root not found: ${rootPath}`;
    if (!fs.statSync(rootPath).isDirectory()) return `Error: Artifact output root is not a directory: ${rootPath}`;
    if (!isWritableArtifactRoot(rootPath, scopePredicates)) {
      return `Error: prune_artifact_output blocked - ${rootArg} is outside the allowed artifact scope.`;
    }

    const taskMode = String(args.task_mode || "image").trim() || "image";
    const protocol = getArtifactProtocol(taskMode) || {};
    const allowedExtensions = new Set(
      (Array.isArray(args.allowed_extensions) && args.allowed_extensions.length > 0
        ? args.allowed_extensions
        : (protocol.allowed_formats || [".png", ".jpg", ".jpeg", ".webp"]))
        .map(normalizeArtifactExtension)
        .filter(Boolean),
    );
    const manifestPatterns = artifactManifestPatternsFor(taskMode);
    const keepPaths = new Set((Array.isArray(args.keep_paths) ? args.keep_paths : []).map(normPath).filter(Boolean));
    const dryRun = args.dry_run === true;
    const removeEmptyDirs = args.remove_empty_dirs !== false;
    const maxDeleteCount = Number.isInteger(Number(args.max_delete_count))
      ? Math.max(0, Number(args.max_delete_count))
      : 50;

    const candidates = [];
    const kept = [];
    const blocked = [];
    const dirs = [];
    function walk(dir) {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        const rel = normPath(path.relative(rootPath, full));
        if (entry.isDirectory()) {
          dirs.push(full);
          walk(full);
          continue;
        }
        if (!entry.isFile()) continue;
        const ext = path.extname(entry.name).toLowerCase();
        const keep = keepPaths.has(rel) || allowedExtensions.has(ext) || isArtifactManifestFile(rel, manifestPatterns);
        if (keep) {
          kept.push(rel);
          continue;
        }
        if (scopePredicates?.hasScope && !scopePredicates.canEdit(full) && !scopePredicates.canCreate(full)) {
          blocked.push(rel);
          continue;
        }
        candidates.push({ rel, full });
      }
    }

    try {
      walk(rootPath);
    } catch (err) {
      return `Error: prune_artifact_output scan failed - ${err.message}`;
    }
    if (blocked.length > 0) {
      return `Error: prune_artifact_output blocked ${blocked.length} out-of-scope file(s): ${blocked.slice(0, 8).join(", ")}`;
    }
    if (candidates.length > maxDeleteCount) {
      return `Error: prune_artifact_output matched ${candidates.length} file(s), exceeding max_delete_count=${maxDeleteCount}. Re-run with a higher cap if this is intentional.`;
    }

    const removedDirs = [];
    if (!dryRun) {
      for (const candidate of candidates) fs.rmSync(candidate.full, { force: true });
      if (removeEmptyDirs) {
        for (const dir of dirs.sort((a, b) => b.length - a.length)) {
          if (dir === rootPath) continue;
          try {
            if (fs.existsSync(dir) && fs.readdirSync(dir).length === 0) {
              fs.rmdirSync(dir);
              removedDirs.push(normPath(path.relative(rootPath, dir)));
            }
          } catch { /* best effort */ }
        }
      }
    }

    return JSON.stringify({
      ok: true,
      dry_run: dryRun,
      output_root: rootPath,
      task_mode: taskMode,
      allowed_extensions: [...allowedExtensions],
      kept_count: kept.length,
      kept: kept.slice(0, 50),
      [dryRun ? "would_delete" : "deleted"]: candidates.map((candidate) => candidate.rel),
      removed_empty_dirs: removedDirs,
    }, null, 2);
  }

  function normalizeImageOutputFormat(value, destPath = "") {
    const raw = String(value || "").trim().toLowerCase().replace(/^\./, "");
    if (raw === "jpg" || raw === "jpeg") return "jpeg";
    if (raw === "png") return "png";
    const ext = path.extname(String(destPath || "")).toLowerCase();
    if (ext === ".jpg" || ext === ".jpeg") return "jpeg";
    if (ext === ".png") return "png";
    return null;
  }

  function validateImageOutputExtension(toolName, outputFormat, destPath) {
    const ext = path.extname(destPath).toLowerCase();
    if (outputFormat === "png" && ext !== ".png") {
      return `Error: ${toolName} output_path must end in .png for output_format=png.`;
    }
    if (outputFormat === "jpeg" && ext !== ".jpg" && ext !== ".jpeg") {
      return `Error: ${toolName} output_path must end in .jpg or .jpeg for output_format=jpeg.`;
    }
    return null;
  }

  function jpegQuality(args = {}) {
    const n = Number(args.quality ?? args.jpeg_quality ?? args.jpegQuality ?? 90);
    if (!Number.isFinite(n)) return 90;
    return Math.max(1, Math.min(100, Math.round(n)));
  }

  function tempSiblingPath(destPath, ext) {
    return path.join(
      path.dirname(destPath),
      `.${path.basename(destPath)}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp${ext}`,
    );
  }

  function removeFileBestEffort(filePath) {
    try { fs.rmSync(filePath, { force: true }); } catch { /* best effort */ }
  }

  function replaceFileWithTemp(tempPath, destPath) {
    const backupPath = fs.existsSync(destPath) ? tempSiblingPath(destPath, ".bak") : null;
    try {
      if (backupPath) fs.renameSync(destPath, backupPath);
      fs.renameSync(tempPath, destPath);
      if (backupPath) removeFileBestEffort(backupPath);
    } catch (err) {
      if (backupPath && fs.existsSync(backupPath) && !fs.existsSync(destPath)) {
        try { fs.renameSync(backupPath, destPath); } catch { /* preserve backup for manual recovery */ }
      }
      throw err;
    }
  }

  function readValidatedJpegDimensions(filePath, toolName) {
    const outputBuffer = fs.readFileSync(filePath);
    if (detectImageFormat(outputBuffer) !== "jpeg") {
      throw new Error(`${toolName} converter produced a non-JPEG output.`);
    }
    return readJpegDimensions(outputBuffer);
  }

  function writeRgbaImage(destPath, width, height, rgba, outputFormat, args = {}) {
    if (outputFormat === "png") {
      fs.writeFileSync(destPath, encodeRgbaToPng(width, height, rgba));
      return { ok: true, converter: "native-png" };
    }
    if (outputFormat !== "jpeg") {
      return { ok: false, error: `Error: unsupported image output_format=${outputFormat}` };
    }
    const tempPath = path.join(
      path.dirname(destPath),
      `.${path.basename(destPath)}.${process.pid}.${Date.now()}.tmp.png`,
    );
    const tempJpegPath = tempSiblingPath(destPath, ".jpg");
    try {
      fs.writeFileSync(tempPath, encodeRgbaToPng(width, height, rgba));
      const converted = convertImageToJpeg(fs.readFileSync(tempPath), tempPath, tempJpegPath, { quality: jpegQuality(args) });
      if (!converted.ok) return converted;
      readValidatedJpegDimensions(tempJpegPath, "write_image");
      replaceFileWithTemp(tempJpegPath, destPath);
      return { ok: true, converter: converted.converter };
    } catch (err) {
      return { ok: false, error: `Error: JPEG write failed - ${err.message}` };
    } finally {
      removeFileBestEffort(tempPath);
      removeFileBestEffort(tempJpegPath);
    }
  }

  function execResizeImage(args, cwd, scopePredicates) {
    const srcPath = safePathImpl(cwd, args.path, scopePredicates);
    if (!fs.existsSync(srcPath)) return `Error: File not found: ${srcPath}`;
    const stat = fs.statSync(srcPath);
    if (!stat.isFile()) return `Error: Path is not a file: ${srcPath}`;
    if (path.extname(srcPath).toLowerCase() !== ".png") {
      return "Error: resize_image currently supports PNG files only.";
    }

    const width = Number(args.width);
    const height = Number(args.height);
    if (!Number.isInteger(width) || width <= 0) return "Error: width must be a positive integer.";
    if (!Number.isInteger(height) || height <= 0) return "Error: height must be a positive integer.";
    if (width > 8192 || height > 8192) return "Error: resize_image target dimensions must be <= 8192 px.";

    const destArg = args.output_path || args.path;
    const destPath = safePathImpl(cwd, destArg, scopePredicates);
    const outputFormat = normalizeImageOutputFormat(args.output_format, destPath) || "png";
    const extensionError = validateImageOutputExtension("resize_image", outputFormat, destPath);
    if (extensionError) return extensionError;
    const destExists = fs.existsSync(destPath);
    if (destExists && scopePredicates?.hasScope && !scopePredicates.canEdit(destPath)) {
      return `Error: resize_image blocked - ${destArg} is outside the allowed edit scope.`;
    }
    if (!destExists && scopePredicates?.hasScope && !scopePredicates.canCreate(destPath)) {
      return `Error: resize_image blocked - ${destArg} is outside the allowed creation scope.`;
    }

    try {
      const parsed = decodePngToRgba(fs.readFileSync(srcPath));
      const mode = args.mode || "fit";
      const resized = resizeRgbaNearest(parsed.width, parsed.height, parsed.data, width, height, mode);
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      const written = writeRgbaImage(destPath, width, height, resized, outputFormat, args);
      if (!written.ok) return written.error;
      return JSON.stringify({
        ok: true,
        input: srcPath,
        output: destPath,
        output_format: outputFormat,
        converter: written.converter || null,
        mode,
        original: { width: parsed.width, height: parsed.height },
        resized: { width, height },
      }, null, 2);
    } catch (err) {
      return `Error: resize_image failed - ${err.message}`;
    }
  }

  function execReadImageMetadata(args, cwd, scopePredicates) {
    const srcPath = safePathImpl(cwd, args.path, scopePredicates);
    if (!fs.existsSync(srcPath)) return `Error: File not found: ${srcPath}`;
    const stat = fs.statSync(srcPath);
    if (!stat.isFile()) return `Error: Path is not a file: ${srcPath}`;
    const buffer = fs.readFileSync(srcPath);
    const format = detectImageFormat(buffer);
    let width = null;
    let height = null;
    if (format === "png") {
      try {
        const parsed = decodePngToRgba(buffer);
        width = parsed.width;
        height = parsed.height;
      } catch {
        if (buffer.length >= 24 && buffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
          width = buffer.readUInt32BE(16);
          height = buffer.readUInt32BE(20);
        }
      }
    } else if (format === "jpeg") {
      const dims = readJpegDimensions(buffer);
      width = dims.width;
      height = dims.height;
    }
    return JSON.stringify({
      path: path.relative(cwd, srcPath).replace(/\\/g, "/"),
      format,
      width,
      height,
      bytes: stat.size,
      extension: path.extname(srcPath).toLowerCase().replace(/^\./, ""),
    }, null, 2);
  }

  function execOptimizeImage(args, cwd, scopePredicates) {
    const srcPath = safePathImpl(cwd, args.path, scopePredicates);
    if (!fs.existsSync(srcPath)) return `Error: File not found: ${srcPath}`;
    if (!fs.statSync(srcPath).isFile()) return `Error: Path is not a file: ${srcPath}`;
    if (path.extname(srcPath).toLowerCase() !== ".png") return "Error: optimize_image currently supports PNG files only.";

    const destArg = args.output_path || args.path;
    const destPath = safePathImpl(cwd, destArg, scopePredicates);
    const destExists = fs.existsSync(destPath);
    const overwrite = args.overwrite !== false;
    if (destExists && !overwrite && destPath !== srcPath) {
      return `Error: optimize_image output exists and overwrite=false: ${destArg}`;
    }
    if (destExists && scopePredicates?.hasScope && !scopePredicates.canEdit(destPath)) {
      return `Error: optimize_image blocked - ${destArg} is outside the allowed edit scope.`;
    }
    if (!destExists && scopePredicates?.hasScope && !scopePredicates.canCreate(destPath)) {
      return `Error: optimize_image blocked - ${destArg} is outside the allowed creation scope.`;
    }

    try {
      const parsed = decodePngToRgba(fs.readFileSync(srcPath));
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, encodeRgbaToPng(parsed.width, parsed.height, parsed.data));
      return JSON.stringify({
        ok: true,
        input: srcPath,
        output: destPath,
        format: "png",
        original: { width: parsed.width, height: parsed.height },
        reason: "reencoded_png_without_metadata",
      }, null, 2);
    } catch (err) {
      return `Error: optimize_image failed - ${err.message}`;
    }
  }

  function execReencodeImage(args, cwd, scopePredicates) {
    const srcPath = safePathImpl(cwd, args.path, scopePredicates);
    if (!fs.existsSync(srcPath)) return `Error: File not found: ${srcPath}`;
    const stat = fs.statSync(srcPath);
    if (!stat.isFile()) return `Error: Path is not a file: ${srcPath}`;
    if (stat.size > 50 * 1024 * 1024) {
      return `Error: reencode_image input too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max 50 MB).`;
    }

    const destArg = args.output_path || args.path;
    const destPath = safePathImpl(cwd, destArg, scopePredicates);
    const outputFormat = normalizeImageOutputFormat(args.output_format, destPath) || "png";
    if (!["png", "jpeg"].includes(outputFormat)) return "Error: reencode_image output_format must be png or jpeg.";
    const extensionError = validateImageOutputExtension("reencode_image", outputFormat, destPath);
    if (extensionError) return extensionError;
    const destExists = fs.existsSync(destPath);
    const overwrite = args.overwrite !== false;
    if (destExists && !overwrite && destPath !== srcPath) {
      return `Error: reencode_image output exists and overwrite=false: ${destArg}`;
    }
    if (destExists && scopePredicates?.hasScope && !scopePredicates.canEdit(destPath)) {
      return `Error: reencode_image blocked - ${destArg} is outside the allowed edit scope.`;
    }
    if (!destExists && scopePredicates?.hasScope && !scopePredicates.canCreate(destPath)) {
      return `Error: reencode_image blocked - ${destArg} is outside the allowed creation scope.`;
    }

    const inputBuffer = fs.readFileSync(srcPath);
    const inputFormat = detectImageFormat(inputBuffer);
    try {
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      if (outputFormat === "jpeg") {
        const tempJpegPath = tempSiblingPath(destPath, ".jpg");
        try {
          const converted = convertImageToJpeg(inputBuffer, srcPath, tempJpegPath, { quality: jpegQuality(args) });
          if (!converted.ok) return converted.error;
          const dimensions = readValidatedJpegDimensions(tempJpegPath, "reencode_image");
          replaceFileWithTemp(tempJpegPath, destPath);
          return JSON.stringify({
            ok: true,
            input: srcPath,
            output: destPath,
            input_format: inputFormat,
            output_format: "jpeg",
            converter: converted.converter,
            dimensions,
          }, null, 2);
        } finally {
          removeFileBestEffort(tempJpegPath);
        }
      }

      if (inputFormat === "png") {
        const parsed = decodePngToRgba(inputBuffer);
        fs.writeFileSync(destPath, encodeRgbaToPng(parsed.width, parsed.height, parsed.data));
        return JSON.stringify({
          ok: true,
          input: srcPath,
          output: destPath,
          input_format: inputFormat,
          output_format: "png",
          dimensions: { width: parsed.width, height: parsed.height },
        }, null, 2);
      }

      const converted = convertImageToPng(inputBuffer, srcPath, destPath);
      if (!converted.ok) return converted.error;
      const outputBuffer = fs.readFileSync(destPath);
      if (!outputBuffer.subarray(0, 8).equals(PNG_SIGNATURE)) {
        return "Error: reencode_image converter produced a non-PNG output.";
      }
      let dimensions = { width: null, height: null };
      try {
        const parsed = decodePngToRgba(outputBuffer);
        dimensions = { width: parsed.width, height: parsed.height };
      } catch {}
      return JSON.stringify({
        ok: true,
        input: srcPath,
        output: destPath,
        input_format: inputFormat,
        output_format: "png",
        converter: converted.converter,
        dimensions,
      }, null, 2);
    } catch (err) {
      return `Error: reencode_image failed - ${err.message}`;
    }
  }

  function execExtractImageText(args, cwd, scopePredicates) {
    const srcPath = safePathImpl(cwd, args.path, scopePredicates);
    if (!fs.existsSync(srcPath)) return `Error: File not found: ${srcPath}`;
    const stat = fs.statSync(srcPath);
    if (!stat.isFile()) return `Error: Path is not a file: ${srcPath}`;
    if (stat.size > 25 * 1024 * 1024) {
      return `Error: extract_image_text input too large (${(stat.size / 1024 / 1024).toFixed(1)} MB, max 25 MB).`;
    }

    const language = typeof args.language === "string" && args.language.trim()
      ? args.language.trim()
      : "eng";
    if (!/^[A-Za-z0-9_+-]+$/.test(language)) {
      return "Error: extract_image_text language must match [A-Za-z0-9_+-]+ (e.g. 'eng', 'eng+fra').";
    }

    const cliArgs = [srcPath, "stdout", "-l", language];
    if (args.psm != null) {
      const psm = Number(args.psm);
      if (!Number.isInteger(psm) || psm < 0 || psm > 13) {
        return "Error: extract_image_text psm must be an integer between 0 and 13.";
      }
      cliArgs.push("--psm", String(psm));
    }

    let result;
    try {
      result = spawnSync("tesseract", cliArgs, {
        cwd,
        encoding: "utf-8",
        maxBuffer: 16 * 1024 * 1024,
        timeout: 60_000,
        windowsHide: true,
      });
    } catch (err) {
      return `Error: extract_image_text failed - ${err.message}`;
    }

    if (result.error) {
      const code = result.error.code;
      if (code === "ENOENT") {
        return "Error: tesseract not found on PATH. Install Tesseract OCR (https://tesseract-ocr.github.io/tessdoc/Installation.html) so this tool can read image text.";
      }
      return `Error: extract_image_text failed - ${result.error.message}`;
    }

    if (result.status !== 0) {
      const stderr = String(result.stderr || "").trim();
      return `Error: tesseract exited ${result.status}${stderr ? ` - ${stderr.slice(0, 500)}` : ""}`;
    }

    const text = String(result.stdout || "").replace(/\r\n/g, "\n");
    const trimmed = text.replace(/\s+$/g, "");
    if (!trimmed) {
      return JSON.stringify({
        ok: true,
        path: srcPath,
        language,
        text: "",
        notice: "Tesseract returned no text. The image may not contain readable text or may need preprocessing.",
      }, null, 2);
    }
    return JSON.stringify({
      ok: true,
      path: srcPath,
      language,
      text: trimmed,
    }, null, 2);
  }

  function _parseToolJsonResult(text) {
    if (typeof text !== "string" || /^Error:/i.test(text)) return null;
    try { return JSON.parse(text); } catch { return null; }
  }

  function _replaceImageExtensionWithPng(inputPath) {
    const raw = String(inputPath || "");
    const ext = path.extname(raw);
    return ext ? `${raw.slice(0, -ext.length)}.png` : `${raw}.png`;
  }

  function _clampByte(value, fallback = 0) {
    const n = Number(value);
    if (!Number.isFinite(n)) return fallback;
    return Math.max(0, Math.min(255, Math.round(n)));
  }

  function _parseRgbColor(value) {
    if (value == null || value === "" || String(value).trim().toLowerCase() === "auto") return null;
    if (Array.isArray(value) && value.length >= 3) {
      return [_clampByte(value[0]), _clampByte(value[1]), _clampByte(value[2])];
    }
    if (typeof value === "object") {
      return [_clampByte(value.r ?? value.red), _clampByte(value.g ?? value.green), _clampByte(value.b ?? value.blue)];
    }
    const text = String(value).trim();
    const hex = text.match(/^#?([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      const raw = hex[1];
      const full = raw.length === 3 ? raw.split("").map((ch) => ch + ch).join("") : raw;
      return [
        parseInt(full.slice(0, 2), 16),
        parseInt(full.slice(2, 4), 16),
        parseInt(full.slice(4, 6), 16),
      ];
    }
    const nums = text.match(/\d+(?:\.\d+)?/g);
    if (nums && nums.length >= 3) return [_clampByte(nums[0]), _clampByte(nums[1]), _clampByte(nums[2])];
    throw new Error("target_color must be #RGB, #RRGGBB, rgb(r,g,b), an RGB array/object, or omitted for auto corner sampling.");
  }

  function _sampleBackgroundColor(parsed, sample = "corners", sampleSize = 3) {
    const width = parsed.width;
    const height = parsed.height;
    const size = Math.max(1, Math.min(50, Math.floor(Number(sampleSize) || 3)));
    const clampedSize = Math.min(size, width, height);
    const sampleName = String(sample || "corners").trim().toLowerCase();
    const cornerRects = {
      top_left: [[0, 0]],
      top_right: [[width - clampedSize, 0]],
      bottom_left: [[0, height - clampedSize]],
      bottom_right: [[width - clampedSize, height - clampedSize]],
      corners: [
        [0, 0],
        [width - clampedSize, 0],
        [0, height - clampedSize],
        [width - clampedSize, height - clampedSize],
      ],
    };
    const rects = cornerRects[sampleName] || cornerRects.corners;
    let r = 0;
    let g = 0;
    let b = 0;
    let count = 0;
    for (const [startX, startY] of rects) {
      for (let y = startY; y < startY + clampedSize; y++) {
        for (let x = startX; x < startX + clampedSize; x++) {
          if (x < 0 || y < 0 || x >= width || y >= height) continue;
          const idx = (y * width + x) * 4;
          if (parsed.data[idx + 3] === 0) continue;
          r += parsed.data[idx];
          g += parsed.data[idx + 1];
          b += parsed.data[idx + 2];
          count += 1;
        }
      }
    }
    if (count === 0) return [255, 255, 255];
    return [Math.round(r / count), Math.round(g / count), Math.round(b / count)];
  }

  function _pixelMatchesColor(data, offset, target, tolerance) {
    return data[offset + 3] > 0
      && Math.abs(data[offset] - target[0]) <= tolerance
      && Math.abs(data[offset + 1] - target[1]) <= tolerance
      && Math.abs(data[offset + 2] - target[2]) <= tolerance;
  }

  function _applyAlphaKey(parsed, { targetColor, tolerance, edgeOnly }) {
    const width = parsed.width;
    const height = parsed.height;
    const data = Buffer.from(parsed.data);
    const tol = Math.max(0, Math.min(255, Math.floor(Number(tolerance) || 0)));
    const edgeConnectedOnly = edgeOnly !== false;
    let transparentPixels = 0;

    if (!edgeConnectedOnly) {
      for (let offset = 0; offset < data.length; offset += 4) {
        if (_pixelMatchesColor(data, offset, targetColor, tol)) {
          if (data[offset + 3] !== 0) transparentPixels += 1;
          data[offset + 3] = 0;
        }
      }
      return { data, transparentPixels };
    }

    const pixelCount = width * height;
    const visited = new Uint8Array(pixelCount);
    const queue = new Int32Array(pixelCount);
    let head = 0;
    let tail = 0;

    const enqueueIfMatch = (idx) => {
      if (idx < 0 || idx >= pixelCount || visited[idx]) return;
      const offset = idx * 4;
      if (!_pixelMatchesColor(data, offset, targetColor, tol)) return;
      visited[idx] = 1;
      queue[tail++] = idx;
      data[offset + 3] = 0;
      transparentPixels += 1;
    };

    for (let x = 0; x < width; x++) {
      enqueueIfMatch(x);
      enqueueIfMatch((height - 1) * width + x);
    }
    for (let y = 1; y < height - 1; y++) {
      enqueueIfMatch(y * width);
      enqueueIfMatch(y * width + width - 1);
    }

    while (head < tail) {
      const idx = queue[head++];
      const x = idx % width;
      if (x > 0) enqueueIfMatch(idx - 1);
      if (x < width - 1) enqueueIfMatch(idx + 1);
      if (idx >= width) enqueueIfMatch(idx - width);
      if (idx < pixelCount - width) enqueueIfMatch(idx + width);
    }

    return { data, transparentPixels };
  }

  function execAlphaKeyImage(args, cwd, scopePredicates) {
    const srcPath = safePathImpl(cwd, args.path, scopePredicates);
    if (!fs.existsSync(srcPath)) return `Error: File not found: ${srcPath}`;
    const stat = fs.statSync(srcPath);
    if (!stat.isFile()) return `Error: Path is not a file: ${srcPath}`;

    const destArg = args.output_path || args.path;
    const destPath = safePathImpl(cwd, destArg, scopePredicates);
    if (path.extname(destPath).toLowerCase() !== ".png") {
      return "Error: clean_image alpha_key output_path must end in .png.";
    }
    const destExists = fs.existsSync(destPath);
    const overwrite = args.overwrite !== false;
    if (destExists && !overwrite && destPath !== srcPath) {
      return `Error: clean_image alpha_key output exists and overwrite=false: ${destArg}`;
    }
    if (destExists && scopePredicates?.hasScope && !scopePredicates.canEdit(destPath)) {
      return `Error: clean_image alpha_key blocked - ${destArg} is outside the allowed edit scope.`;
    }
    if (!destExists && scopePredicates?.hasScope && !scopePredicates.canCreate(destPath)) {
      return `Error: clean_image alpha_key blocked - ${destArg} is outside the allowed creation scope.`;
    }

    try {
      const parsed = decodePngToRgba(fs.readFileSync(srcPath));
      const targetColor = _parseRgbColor(args.target_color ?? args.targetColor)
        || _sampleBackgroundColor(parsed, args.sample || "corners", args.sample_size ?? args.sampleSize ?? 3);
      const tolerance = _clampByte(args.tolerance ?? 24, 24);
      const edgeOnly = args.edge_only ?? args.edgeOnly;
      const keyed = _applyAlphaKey(parsed, { targetColor, tolerance, edgeOnly });
      fs.mkdirSync(path.dirname(destPath), { recursive: true });
      fs.writeFileSync(destPath, encodeRgbaToPng(parsed.width, parsed.height, keyed.data));
      const metadata = readImageFacts(destPath);
      return JSON.stringify({
        ok: true,
        mode: "alpha_key",
        input: srcPath,
        output: destPath,
        target_color: { r: targetColor[0], g: targetColor[1], b: targetColor[2] },
        tolerance,
        edge_only: edgeOnly !== false,
        transparent_pixels: keyed.transparentPixels,
        metadata,
      }, null, 2);
    } catch (err) {
      return `Error: clean_image alpha_key failed - ${err.message}`;
    }
  }

  function execCleanImage(args, cwd, scopePredicates) {
    const mode = String(args.mode || "clean").trim().toLowerCase();
    if (!["metadata", "optimize", "reencode", "resize", "clean", "alpha_key"].includes(mode)) {
      return "Error: clean_image mode must be metadata, optimize, reencode, resize, clean, or alpha_key.";
    }
    if (mode === "metadata") {
      return execReadImageMetadata(args, cwd, scopePredicates);
    }
    if (mode === "optimize") {
      return execOptimizeImage(args, cwd, scopePredicates);
    }
    if (mode === "reencode") {
      return execReencodeImage(args, cwd, scopePredicates);
    }
    if (mode === "resize") {
      return execResizeImage({
        ...args,
        mode: args.resize_mode || args.resizeMode || "fit",
      }, cwd, scopePredicates);
    }
    if (mode === "alpha_key") {
      return execAlphaKeyImage(args, cwd, scopePredicates);
    }

    const srcPath = safePathImpl(cwd, args.path, scopePredicates);
    if (!fs.existsSync(srcPath)) return `Error: File not found: ${srcPath}`;
    const stat = fs.statSync(srcPath);
    if (!stat.isFile()) return `Error: Path is not a file: ${srcPath}`;

    const inputBuffer = fs.readFileSync(srcPath);
    const inputFormat = detectImageFormat(inputBuffer);
    const wantsResize = args.width != null || args.height != null;
    if (wantsResize) {
      const width = Number(args.width);
      const height = Number(args.height);
      if (!Number.isInteger(width) || width <= 0) return "Error: clean_image width must be a positive integer when resizing.";
      if (!Number.isInteger(height) || height <= 0) return "Error: clean_image height must be a positive integer when resizing.";
    }

    const destArg = args.output_path || (inputFormat !== "png" ? _replaceImageExtensionWithPng(args.path) : args.path);
    const destPath = safePathImpl(cwd, destArg, scopePredicates);
    const outputFormat = normalizeImageOutputFormat(args.output_format, destPath) || "png";
    const steps = [];
    let currentArg = args.path;

    if (outputFormat === "jpeg") {
      if (wantsResize) {
        if (inputFormat !== "png") {
          return "Error: clean_image resize to JPEG currently requires a PNG input. Re-encode to PNG first, then resize to JPEG.";
        }
        const resized = execResizeImage({
          path: currentArg,
          output_path: destArg,
          output_format: "jpeg",
          width: args.width,
          height: args.height,
          mode: args.resize_mode || args.resizeMode || "fit",
          overwrite: args.overwrite,
          quality: args.quality,
          jpeg_quality: args.jpeg_quality,
          jpegQuality: args.jpegQuality,
        }, cwd, scopePredicates);
        if (/^Error:/i.test(String(resized))) return resized;
        steps.push({ step: "resize", result: _parseToolJsonResult(resized) });
      } else {
        const reencoded = execReencodeImage({
          path: currentArg,
          output_path: destArg,
          output_format: "jpeg",
          overwrite: args.overwrite,
          quality: args.quality,
          jpeg_quality: args.jpeg_quality,
          jpegQuality: args.jpegQuality,
        }, cwd, scopePredicates);
        if (/^Error:/i.test(String(reencoded))) return reencoded;
        steps.push({ step: "reencode", result: _parseToolJsonResult(reencoded) });
      }
      const metadata = _parseToolJsonResult(execReadImageMetadata({ path: destArg }, cwd, scopePredicates));
      return JSON.stringify({
        ok: true,
        mode: "clean",
        input: srcPath,
        output: destPath,
        input_format: inputFormat,
        output_format: outputFormat,
        steps,
        metadata,
      }, null, 2);
    }

    if (inputFormat !== "png" || destArg !== args.path) {
      const reencoded = execReencodeImage({
        path: currentArg,
        output_path: destArg,
        output_format: "png",
        overwrite: args.overwrite,
      }, cwd, scopePredicates);
      if (/^Error:/i.test(String(reencoded))) return reencoded;
      steps.push({ step: "reencode", result: _parseToolJsonResult(reencoded) });
      currentArg = destArg;
    }

    if (wantsResize) {
      const resized = execResizeImage({
        path: currentArg,
        output_path: destArg,
        width: args.width,
        height: args.height,
        mode: args.resize_mode || args.resizeMode || "fit",
      }, cwd, scopePredicates);
      if (/^Error:/i.test(String(resized))) return resized;
      steps.push({ step: "resize", result: _parseToolJsonResult(resized) });
      currentArg = destArg;
    }

    const optimized = execOptimizeImage({
      path: currentArg,
      output_path: destArg,
      overwrite: true,
    }, cwd, scopePredicates);
    if (/^Error:/i.test(String(optimized))) return optimized;
    steps.push({ step: "optimize", result: _parseToolJsonResult(optimized) });

    const metadata = _parseToolJsonResult(execReadImageMetadata({ path: destArg }, cwd, scopePredicates));
    return JSON.stringify({
      ok: true,
      mode: "clean",
      input: srcPath,
      output: safePathImpl(cwd, destArg, scopePredicates),
      input_format: inputFormat,
      steps,
      metadata,
    }, null, 2);
  }

  function execRunScopedChecks(args, cwd, _scopePredicates, declaredScope = {}) {
    try {
      return JSON.stringify(runScopedChecks({ args: args || {}, cwd, declaredScope }), null, 2);
    } catch (err) {
      return `Error: run_scoped_checks failed - ${err?.message || String(err)}`;
    }
  }

  function actorFromOptions(options = {}) {
    return {
      role: options.role || null,
      jobId: options.jobId || null,
      workItemId: options.workItemId || null,
    };
  }

  function execCreateTestSuite(args, cwd, _scopePredicates, _declaredScope = {}, options = {}) {
    try {
      return JSON.stringify(createRegisteredTestSuite({
        args: args || {},
        cwd,
        actor: actorFromOptions(options),
      }), null, 2);
    } catch (err) {
      return `Error: create_test_suite failed - ${err?.message || String(err)}`;
    }
  }

  function execCreateTest(args, cwd, _scopePredicates, _declaredScope = {}, options = {}) {
    try {
      return JSON.stringify(createRegisteredTest({
        args: args || {},
        cwd,
        actor: actorFromOptions(options),
        scopeFiles: declaredScopeFiles(cwd, _declaredScope),
      }), null, 2);
    } catch (err) {
      return `Error: create_test failed - ${err?.message || String(err)}`;
    }
  }

  function execRunTest(args, cwd, _scopePredicates, _declaredScope = {}, options = {}) {
    try {
      return JSON.stringify(runRegisteredTest({
        args: args || {},
        cwd,
        actor: actorFromOptions(options),
        scopeFiles: declaredScopeFiles(cwd, _declaredScope),
      }), null, 2);
    } catch (err) {
      return `Error: run_test failed - ${err?.message || String(err)}`;
    }
  }

  function execRunTestSuite(args, cwd, _scopePredicates, _declaredScope = {}, options = {}) {
    try {
      return JSON.stringify(runRegisteredTestSuite({
        args: args || {},
        cwd,
        actor: actorFromOptions(options),
        scopeFiles: declaredScopeFiles(cwd, _declaredScope),
      }), null, 2);
    } catch (err) {
      return `Error: run_test_suite failed - ${err?.message || String(err)}`;
    }
  }

  return {
    execReadFile: wrapDeterministicExecutor("read_file", execReadFile),
    execWriteFile: wrapDeterministicExecutor("write_file", execWriteFile),
    execEditFile: wrapDeterministicExecutor("edit_file", execEditFile),
    execListFiles: wrapDeterministicExecutor("list_files", execListFiles),
    execSearchFiles: wrapDeterministicExecutor("search_files", execSearchFiles),
    execGitHistory: wrapDeterministicExecutor(
      "git_history",
      createGitHistoryExecutor(safePathImpl, { nativeParity: gitNativeParity }),
    ),
    execInspectFile: wrapDeterministicExecutor("inspect_file", createInspectFileExecutor(safePathImpl)),
    execHashFile: wrapDeterministicExecutor("hash_file", execHashFile),
    execValidateArtifactOutput: wrapDeterministicExecutor("validate_artifact_output", execValidateArtifactOutput),
    execPruneArtifactOutput: wrapDeterministicExecutor("prune_artifact_output", execPruneArtifactOutput),
    execResizeImage: wrapDeterministicExecutor("resize_image", execResizeImage),
    execReadImageMetadata: wrapDeterministicExecutor("read_image_metadata", execReadImageMetadata),
    execOptimizeImage: wrapDeterministicExecutor("optimize_image", execOptimizeImage),
    execReencodeImage: wrapDeterministicExecutor("reencode_image", execReencodeImage),
    execCleanImage: wrapDeterministicExecutor("clean_image", execCleanImage),
    execExtractImageText: wrapDeterministicExecutor("extract_image_text", execExtractImageText),
    execRunScopedChecks: wrapDeterministicExecutor("run_scoped_checks", execRunScopedChecks),
    execCreateTestSuite: wrapDeterministicExecutor("create_test_suite", execCreateTestSuite),
    execCreateTest: wrapDeterministicExecutor("create_test", execCreateTest),
    execRunTest: wrapDeterministicExecutor("run_test", execRunTest),
    execRunTestSuite: wrapDeterministicExecutor("run_test_suite", execRunTestSuite),
    execPullBrief: wrapDeterministicExecutor("pull_brief", createPullBriefExecutor(safePathImpl, { skipDirs })),
  };
}
