import path from "path";
import { recordToolInvocation } from "../../domains/observability/functions/observations.js";
import { ATLAS_TOOL_DEFS } from "../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import { optionalAtlasSymbolId, sanitizeAtlasSymbolIdList } from "../../domains/atlas/functions/v2/symbol-id.js";
import { coerceLooseAtlasSymbolArgs, validateAtlasPayloadSymbolIds } from "../../domains/atlas/functions/v2/signal-extraction.js";
import { ATLAS_TOOL_PARAM_SCHEMAS } from "../../domains/atlas/functions/v2/contracts/tool-schemas.js";

const ATLAS_MAX_QUERY_LENGTH = 512;
const ATLAS_MAX_LIMIT = 50;
const ATLAS_MAX_BUDGET_CARDS = 24;
const ATLAS_MAX_BUDGET_TOKENS = 16000;
const ATLAS_MAX_IDENTIFIERS = 8;
const DEFAULT_ATLAS_SCOPE_MAX_FILES = 40;
const ATLAS_MAX_FILE_BYTES = 512 * 1024;
const ATLAS_MAX_FILE_LINES = 5000;
const ATLAS_MAX_SEARCH_CONTEXT_LINES = 20;
const ATLAS_MAX_WRITE_CONTENT_CHARS = 512 * 1024;
const ATLAS_ACTION_ALIASES = Object.freeze({
  "agent.context": "context",
});
const ATLAS_FALLBACK_ONLY_ACTIONS = new Set(["file.read"]);


const ATLAS_TOOL_NAME_TO_ACTION = Object.freeze(
  {
    ...Object.fromEntries(Object.entries(ATLAS_TOOL_DEFS).map(([action, def]) => [def.name, action])),
    atlas_agent_context: "context",
  },
);

function clampInt(value, min, max, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(min, Math.min(max, parsed));
}

function sanitizeString(value, maxLen = 1024) {
  if (value == null) return "";
  return String(value).trim().slice(0, maxLen);
}

function isSafeRelativePath(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/");
  if (!normalized) return false;
  if (path.isAbsolute(normalized)) return false;
  const segments = normalized.split("/").filter(Boolean);
  if (segments.length === 0) return false;
  if (segments.some((segment) => segment === "." || segment === "..")) return false;
  return true;
}

function sanitizeRelativePathList(values = [], maxItems = 30) {
  const list = Array.isArray(values) ? values : [];
  const out = [];
  for (const raw of list) {
    const candidate = sanitizeString(raw, 512);
    if (!candidate) continue;
    if (!isSafeRelativePath(candidate)) continue;
    if (!out.includes(candidate)) out.push(candidate);
    if (out.length >= maxItems) break;
  }
  return out;
}

function sanitizeIdentifierList(values = [], maxItems = ATLAS_MAX_IDENTIFIERS) {
  const list = normalizeStringListInput(values);
  const out = [];
  for (const raw of list) {
    const candidate = sanitizeString(raw, 128);
    if (!candidate) continue;
    if (!/^[A-Za-z0-9_$.:/#-]+$/u.test(candidate)) continue;
    if (!out.includes(candidate)) out.push(candidate);
    if (out.length >= maxItems) break;
  }
  return out;
}

function normalizeStringListInput(values) {
  if (Array.isArray(values)) return values;
  if (typeof values !== "string") return [];
  const text = values.trim();
  if (!text) return [];
  if (text.startsWith("[")) {
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Fall through to lightweight splitting.
    }
  }
  return text.split(/[\s,;]+/u).filter(Boolean);
}

function sanitizeShortStringList(values = [], maxItems = 12, maxLen = 64) {
  const list = Array.isArray(values) ? values : [];
  const out = [];
  for (const raw of list) {
    const candidate = sanitizeString(raw, maxLen);
    if (!candidate) continue;
    if (!out.includes(candidate)) out.push(candidate);
    if (out.length >= maxItems) break;
  }
  return out;
}

function assertNoUnsafeRelativePaths(values = [], fieldName = "paths") {
  const list = Array.isArray(values) ? values : [];
  for (const raw of list) {
    const candidate = sanitizeString(raw, 512);
    if (!candidate) continue;
    if (!isSafeRelativePath(candidate)) {
      throw new Error(`ATLAS ${fieldName} must use safe relative paths only.`);
    }
  }
}

function pickRelativePath(payload = {}) {
  return sanitizeString(payload.filePath || payload.path || payload.file || "", 512);
}

function requireSafeRelativePath(value, fieldName) {
  const candidate = sanitizeString(value, 512);
  if (!candidate || !isSafeRelativePath(candidate)) {
    throw new Error(`ATLAS ${fieldName} must be a safe relative path.`);
  }
  return candidate;
}

function assertSafeJsonPath(value, fieldName = "jsonPath") {
  if (value == null || String(value).trim() === "") return null;
  const candidate = sanitizeString(value, 200);
  const segments = candidate.split(".").map((segment) => segment.trim()).filter(Boolean);
  if (segments.length === 0 || segments.some((segment) => ["__proto__", "constructor", "prototype"].includes(segment))) {
    throw new Error(`ATLAS ${fieldName} contains an unsafe path segment.`);
  }
  return candidate;
}

function sanitizeKnownCardEtags(value, maxItems = 1000) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const out = {};
  for (const [rawSymbolId, rawEtag] of Object.entries(value)) {
    const symbolId = optionalAtlasSymbolId(rawSymbolId, "slice.build knownCardEtags key");
    const etag = sanitizeString(rawEtag, 256);
    if (!etag) continue;
    out[symbolId] = etag;
    if (Object.keys(out).length >= maxItems) break;
  }
  return Object.keys(out).length > 0 ? out : null;
}

function normalizeAtlasWireFormat(value) {
  if (value == null) return undefined;
  const text = sanitizeString(value, 32);
  return ["standard", "compact", "agent", "packed"].includes(text) ? text : undefined;
}

function truncateWriteContent(value) {
  return String(value ?? "").slice(0, ATLAS_MAX_WRITE_CONTENT_CHARS);
}

function prepareWriteMode(payload = {}) {
  const modes = [
    payload.content !== undefined,
    payload.replaceLines !== undefined,
    payload.replacePattern !== undefined,
    payload.jsonPath !== undefined,
    payload.insertAt !== undefined,
    payload.append !== undefined,
  ].filter(Boolean);
  if (modes.length === 0) {
    throw new Error("ATLAS file.write requires exactly one write mode.");
  }
  if (modes.length > 1) {
    throw new Error("ATLAS file.write accepts only one write mode per call.");
  }

  if (payload.content !== undefined) {
    return { content: truncateWriteContent(payload.content) };
  }
  if (payload.append !== undefined) {
    return { append: truncateWriteContent(payload.append) };
  }
  if (payload.replaceLines !== undefined) {
    const source = payload.replaceLines && typeof payload.replaceLines === "object" ? payload.replaceLines : {};
    const start = clampInt(source.start, 0, ATLAS_MAX_FILE_LINES, 0);
    const end = clampInt(source.end, 0, ATLAS_MAX_FILE_LINES, start);
    if (end < start) throw new Error("ATLAS file.write replaceLines end must be >= start.");
    return {
      replaceLines: {
        start,
        end,
        content: truncateWriteContent(source.content),
      },
    };
  }
  if (payload.replacePattern !== undefined) {
    const source = payload.replacePattern && typeof payload.replacePattern === "object" ? payload.replacePattern : {};
    const pattern = sanitizeString(source.pattern, 500);
    if (!pattern) throw new Error("ATLAS file.write replacePattern requires pattern.");
    if (/\([^)]*[+*][^)]*\)[+*?]/.test(pattern)) {
      throw new Error("ATLAS file.write replacePattern contains an unsafe nested quantifier.");
    }
    return {
      replacePattern: {
        pattern,
        replacement: truncateWriteContent(source.replacement),
        ...(source.global == null ? {} : { global: !!source.global }),
      },
    };
  }
  if (payload.jsonPath !== undefined) {
    const jsonPath = assertSafeJsonPath(payload.jsonPath, "jsonPath");
    if (!jsonPath) throw new Error("ATLAS file.write jsonPath mode requires jsonPath.");
    if (payload.jsonValue === undefined) {
      throw new Error("ATLAS file.write jsonPath mode requires jsonValue.");
    }
    return { jsonPath, jsonValue: payload.jsonValue };
  }
  const source = payload.insertAt && typeof payload.insertAt === "object" ? payload.insertAt : {};
  return {
    insertAt: {
      line: clampInt(source.line, 0, ATLAS_MAX_FILE_LINES, 0),
      content: truncateWriteContent(source.content),
    },
  };
}

function normalizeAction(action) {
  const trimmed = String(action || "").trim();
  const canonical = ATLAS_ACTION_ALIASES[trimmed] || trimmed;
  if (!ATLAS_TOOL_DEFS[canonical]) {
    throw new Error(`Unsupported ATLAS action: ${trimmed || "(empty)"}`);
  }
  return canonical;
}

function normalizeNestedAtlasAction(value) {
  const raw = String(value || "").trim();
  if (!raw) return "";
  return raw
    .replace(/^atlas[._]/, "")
    .replace(/_/g, ".")
    .toLowerCase();
}

function nestedFallbackOnlyAction(payload = {}) {
  const nested = payload?.gatewayAction
    || payload?.targetAction
    || payload?.actionName
    || payload?.action
    || "";
  const normalized = normalizeNestedAtlasAction(nested);
  return ATLAS_FALLBACK_ONLY_ACTIONS.has(normalized) ? normalized : "";
}

export function resolveAtlasDeterministicCliAction(action) {
  return normalizeAction(action);
}

export function getAtlasDeterministicToolDefinitions(toolNames = []) {
  return (toolNames || []).map((toolName) => ATLAS_TOOL_DEFS[toolName]).filter(Boolean);
}

export function resolveAtlasDeterministicAction(toolName) {
  return ATLAS_TOOL_NAME_TO_ACTION[toolName] || null;
}

export function prepareAtlasDeterministicPayload(action, args = {}, { repoId = null } = {}) {
  const normalizedAction = normalizeAction(action);
  const payload = { ...(args || {}) };
  const fallbackOnlyNested = nestedFallbackOnlyAction(payload);
  if (ATLAS_FALLBACK_ONLY_ACTIONS.has(normalizedAction) || fallbackOnlyNested) {
    throw new Error("ATLAS file.read is intentionally not exposed. Use deterministic read_file/chain_read as the raw-read fallback after ATLAS discovery, or when ATLAS is unavailable or insufficient.");
  }
  if (payload.repo_id && !payload.repoId) payload.repoId = String(payload.repo_id);
  if (atlasActionSupportsRepoId(normalizedAction)) {
    if (repoId && !payload.repoId) payload.repoId = repoId;
  } else {
    delete payload.repoId;
  }
  delete payload.repo_id;
  coerceLooseAtlasSymbolArgs(normalizedAction, payload);
  validateAtlasPayloadSymbolIds(normalizedAction, payload);

  if (normalizedAction === "repo.status") {
    const allowedDetail = new Set(["minimal", "standard", "full"]);
    const detail = sanitizeString(payload.detail || "", 16).toLowerCase();
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
        ...(allowedDetail.has(detail) ? { detail } : {}),
        ...(payload.surfaceMemories == null ? {} : { surfaceMemories: !!payload.surfaceMemories }),
      },
    };
  }

  if (normalizedAction === "repo.overview") {
    const allowedLevels = new Set(["stats", "directories", "full"]);
    const levelRaw = sanitizeString(payload.level || "", 16).toLowerCase();
    const directories = sanitizeRelativePathList(payload.directories, 30);
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        level: allowedLevels.has(levelRaw) ? levelRaw : "stats",
        ...(payload.includeHotspots == null ? {} : { includeHotspots: !!payload.includeHotspots }),
        ...(directories.length > 0 ? { directories } : {}),
        ...(payload.maxDirectories == null ? {} : { maxDirectories: clampInt(payload.maxDirectories, 1, 200, 25) }),
        ...(payload.maxExportsPerDirectory == null ? {} : { maxExportsPerDirectory: clampInt(payload.maxExportsPerDirectory, 1, 50, 10) }),
        ...(payload.ifNoneMatch ? { ifNoneMatch: sanitizeString(payload.ifNoneMatch, 256) } : {}),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "symbol.search") {
    const query = sanitizeString(payload.query, ATLAS_MAX_QUERY_LENGTH);
    if (!query) throw new Error("ATLAS symbol.search requires a non-empty query.");
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...payload,
        query,
        limit: clampInt(payload.limit, 1, ATLAS_MAX_LIMIT, 10),
        semantic: !!payload.semantic,
      },
    };
  }

  if (normalizedAction === "tree.scope") {
    const rawPaths = [
      ...sanitizeRelativePathList(payload.paths, 100),
      ...sanitizeRelativePathList(payload.editedFiles, 100),
    ];
    if (payload.path != null) rawPaths.push(requireSafeRelativePath(payload.path, "tree.scope path"));
    assertNoUnsafeRelativePaths(payload.paths, "tree.scope paths");
    assertNoUnsafeRelativePaths(payload.editedFiles, "tree.scope editedFiles");
    const refs = Array.isArray(payload.refs)
      ? payload.refs
        .map((ref) => ({
          refType: sanitizeString(ref?.refType, 32),
          refId: sanitizeString(ref?.refId, 512),
        }))
        .filter((ref) => ["cluster", "process"].includes(ref.refType) && ref.refId)
        .slice(0, 20)
      : [];
    const refType = sanitizeString(payload.refType, 32);
    const refId = sanitizeString(payload.refId, 512);
    if (["cluster", "process"].includes(refType) && refId) refs.push({ refType, refId });
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        taskText: payload.taskText != null ? sanitizeString(payload.taskText, ATLAS_MAX_QUERY_LENGTH) : undefined,
        taskType: payload.taskType != null ? sanitizeString(payload.taskType, 64) : undefined,
        paths: [...new Set(rawPaths)].slice(0, 100),
        symbolIds: sanitizeAtlasSymbolIdList(payload.symbolIds || (payload.symbolId ? [payload.symbolId] : []), 100, "tree.scope symbolIds"),
        nodeIds: sanitizeShortStringList(payload.nodeIds, 100, 2000),
        refs,
        ...(payload.maxFiles == null ? {} : { maxFiles: clampInt(payload.maxFiles, 1, 500, DEFAULT_ATLAS_SCOPE_MAX_FILES) }),
        ...(payload.maxBranches == null ? {} : { maxBranches: clampInt(payload.maxBranches, 1, 100, 12) }),
        ...(payload.branchFileCap == null ? {} : { branchFileCap: clampInt(payload.branchFileCap, 1, 500, 40) }),
        ...(payload.refMatchLimit == null ? {} : { refMatchLimit: clampInt(payload.refMatchLimit, 1, 500, 50) }),
      },
    };
  }

  if (normalizedAction === "tree.grow") {
    const rawPaths = [
      ...sanitizeRelativePathList(payload.paths, 100),
      ...sanitizeRelativePathList(payload.editedFiles, 100),
    ];
    if (payload.path != null) rawPaths.push(requireSafeRelativePath(payload.path, "tree.grow path"));
    assertNoUnsafeRelativePaths(payload.paths, "tree.grow paths");
    assertNoUnsafeRelativePaths(payload.editedFiles, "tree.grow editedFiles");
    const refs = Array.isArray(payload.refs)
      ? payload.refs
        .map((ref) => ({
          refType: sanitizeString(ref?.refType, 32),
          refId: sanitizeString(ref?.refId, 512),
        }))
        .filter((ref) => ["cluster", "process"].includes(ref.refType) && ref.refId)
        .slice(0, 20)
      : [];
    const refType = sanitizeString(payload.refType, 32);
    const refId = sanitizeString(payload.refId, 512);
    if (["cluster", "process"].includes(refType) && refId) refs.push({ refType, refId });
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        paths: [...new Set(rawPaths)].slice(0, 100),
        symbolIds: sanitizeAtlasSymbolIdList(payload.symbolIds || (payload.symbolId ? [payload.symbolId] : []), 100, "tree.grow symbolIds"),
        nodeIds: sanitizeShortStringList(payload.nodeIds, 100, 2000),
        refs,
        ...(payload.maxFiles == null ? {} : { maxFiles: clampInt(payload.maxFiles, 1, 500, DEFAULT_ATLAS_SCOPE_MAX_FILES) }),
        ...(payload.maxBranches == null ? {} : { maxBranches: clampInt(payload.maxBranches, 1, 100, 12) }),
        ...(payload.branchFileCap == null ? {} : { branchFileCap: clampInt(payload.branchFileCap, 1, 500, 40) }),
        ...(payload.refMatchLimit == null ? {} : { refMatchLimit: clampInt(payload.refMatchLimit, 1, 500, 50) }),
      },
    };
  }

  if (normalizedAction === "context") {
    const rawFocusPaths = payload.focusPaths || payload.editedFiles || payload.options?.focusPaths;
    assertNoUnsafeRelativePaths(rawFocusPaths, "focusPaths");
    const taskText = sanitizeString(
      payload.taskText || payload.task || payload.description || payload.query || "",
      ATLAS_MAX_QUERY_LENGTH,
    );
    if (!taskText) throw new Error("ATLAS context requires taskText.");
    const taskTypeRaw = sanitizeString(payload.taskType || "explain", 64);
    const taskType = new Set(["debug", "review", "implement", "explain"]).has(taskTypeRaw)
      ? taskTypeRaw
      : "explain";
    const contextModeRaw = sanitizeString(payload.contextMode || payload.options?.contextMode || "", 16).toLowerCase();
    const entrySymbols = sanitizeAtlasSymbolIdList(payload.focusSymbols || payload.entrySymbols || payload.options?.focusSymbols, 100, "context focusSymbols");
    const editedFiles = sanitizeRelativePathList(rawFocusPaths);
    const options = {
      ...(contextModeRaw === "precise" || contextModeRaw === "broad" ? { contextMode: contextModeRaw } : {}),
      ...(entrySymbols.length > 0 ? { focusSymbols: entrySymbols } : {}),
      ...(editedFiles.length > 0 ? { focusPaths: editedFiles } : {}),
    };
    const maxTokens = clampInt(payload.maxTokens ?? payload.budget?.maxTokens, 128, ATLAS_MAX_BUDGET_TOKENS, 1600);
    const maxActions = payload.maxActions ?? payload.budget?.maxActions;
    const budget = {
      maxTokens,
      ...(maxActions == null ? {} : { maxActions: clampInt(maxActions, 1, 20, 6) }),
    };
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        taskText,
        taskType,
        ...(options.contextMode ? { contextMode: options.contextMode } : {}),
        ...(options.focusSymbols ? { focusSymbols: options.focusSymbols } : {}),
        ...(options.focusPaths ? { focusPaths: options.focusPaths } : {}),
        maxTokens: budget.maxTokens,
        ...(budget.maxActions == null ? {} : { maxActions: budget.maxActions }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "slice.build") {
    assertNoUnsafeRelativePaths(payload.editedFiles, "editedFiles");
    if (payload.failingTestPath != null && !isSafeRelativePath(payload.failingTestPath)) {
      throw new Error("ATLAS failingTestPath must be a safe relative path.");
    }
    const knownCardEtags = sanitizeKnownCardEtags(payload.knownCardEtags);
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        taskText: payload.taskText != null ? sanitizeString(payload.taskText, ATLAS_MAX_QUERY_LENGTH) : undefined,
        semantic: payload.semantic == null ? undefined : !!payload.semantic,
        taskType: payload.taskType != null ? sanitizeString(payload.taskType, 64) : undefined,
        entrySymbols: sanitizeAtlasSymbolIdList(payload.entrySymbols, 100, "slice.build entrySymbols"),
        editedFiles: sanitizeRelativePathList(payload.editedFiles),
        stackTrace: payload.stackTrace != null ? sanitizeString(payload.stackTrace, 8192) : undefined,
        failingTestPath: payload.failingTestPath && isSafeRelativePath(payload.failingTestPath)
          ? sanitizeString(payload.failingTestPath, 512)
          : undefined,
        cardDetail: payload.cardDetail != null ? sanitizeString(payload.cardDetail, 64) : undefined,
        adaptiveDetail: payload.adaptiveDetail == null ? undefined : !!payload.adaptiveDetail,
        ifNoneMatch: payload.ifNoneMatch != null ? sanitizeString(payload.ifNoneMatch, 512) : undefined,
        wireFormat: normalizeAtlasWireFormat(payload.wireFormat),
        wireFormatVersion: payload.wireFormatVersion == null ? undefined : clampInt(payload.wireFormatVersion, 1, 3, 2),
        budget: {
          maxCards: clampInt(payload.maxCards, 1, ATLAS_MAX_BUDGET_CARDS, 12),
          maxEstimatedTokens: clampInt(payload.maxTokens, 128, ATLAS_MAX_BUDGET_TOKENS, 2000),
        },
        ...(knownCardEtags ? { knownCardEtags } : {}),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "slice.spillover.get") {
    const spilloverHandle = sanitizeString(payload.spilloverHandle || payload.spillover_handle || payload.handle || "", 256);
    if (!spilloverHandle) throw new Error("ATLAS slice.spillover.get requires spilloverHandle.");
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        spilloverHandle,
        ...(payload.cursor ? { cursor: sanitizeString(payload.cursor, 256) } : {}),
        ...(payload.pageSize == null ? {} : { pageSize: clampInt(payload.pageSize, 1, 100, 20) }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "delta.get") {
    if (!payload.fromVersion || !payload.toVersion) {
      throw new Error("ATLAS delta.get requires fromVersion and toVersion.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        fromVersion: sanitizeString(payload.fromVersion, 128),
        toVersion: sanitizeString(payload.toVersion, 128),
        _budgetMaxCards: clampInt(payload.maxCards, 1, ATLAS_MAX_BUDGET_CARDS, 12),
        _budgetMaxTokens: clampInt(payload.maxTokens, 128, ATLAS_MAX_BUDGET_TOKENS, 2000),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "symbol.getCard") {
    const symbolId = optionalAtlasSymbolId(payload.symbolId, "symbol.getCard symbolId");
    const symbolRef = payload.symbolRef && typeof payload.symbolRef === "object"
      ? {
        name: sanitizeString(payload.symbolRef.name, 256),
        ...(payload.symbolRef.file && isSafeRelativePath(payload.symbolRef.file)
          ? { file: sanitizeString(payload.symbolRef.file, 512) }
          : {}),
        ...(payload.symbolRef.kind ? { kind: sanitizeString(payload.symbolRef.kind, 64) } : {}),
        ...(payload.symbolRef.exportedOnly == null ? {} : { exportedOnly: !!payload.symbolRef.exportedOnly }),
      }
      : null;
    // Batch mode: symbolIds answers in the symbol.getCards shape. One tool,
    // single or batch by input.
    const batchSymbolIds = sanitizeAtlasSymbolIdList(payload.symbolIds, 100, "symbol.getCard symbolIds");
    if (batchSymbolIds.length > 0 || (Array.isArray(payload.symbolRefs) && payload.symbolRefs.length > 0)) {
      return {
        action: normalizedAction,
        cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
        payload: {
          ...(batchSymbolIds.length > 0 ? { symbolIds: batchSymbolIds } : {}),
          ...(Array.isArray(payload.symbolRefs) && payload.symbolRefs.length > 0 ? { symbolRefs: payload.symbolRefs.slice(0, 100) } : {}),
          ...(payload.minCallConfidence == null ? {} : { minCallConfidence: Number(payload.minCallConfidence) }),
          ...(payload.includeResolutionMetadata == null ? {} : { includeResolutionMetadata: !!payload.includeResolutionMetadata }),
          ...(payload.repoId ? { repoId: payload.repoId } : {}),
        },
      };
    }
    if (!symbolId && !symbolRef?.name) {
      throw new Error("ATLAS symbol.getCard requires symbolId, symbolIds, or symbolRef.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(symbolId ? { symbolId } : { symbolRef }),
        ...(payload.ifNoneMatch ? { ifNoneMatch: sanitizeString(payload.ifNoneMatch, 256) } : {}),
        ...(payload.minCallConfidence == null ? {} : { minCallConfidence: Number(payload.minCallConfidence) }),
        ...(payload.includeResolutionMetadata == null ? {} : { includeResolutionMetadata: !!payload.includeResolutionMetadata }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "code.getSkeleton") {
    if (payload.file != null && !isSafeRelativePath(payload.file)) {
      throw new Error("ATLAS code.getSkeleton file must be a safe relative path.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(payload.symbolId ? { symbolId: optionalAtlasSymbolId(payload.symbolId, "code.getSkeleton symbolId") } : {}),
        ...(payload.file ? { file: sanitizeString(payload.file, 512) } : {}),
        ...(payload.exportedOnly == null ? {} : { exportedOnly: !!payload.exportedOnly }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "code.getHotPath") {
    const symbolId = optionalAtlasSymbolId(payload.symbolId, "code.getHotPath symbolId");
    const file = payload.file && isSafeRelativePath(payload.file)
      ? sanitizeString(payload.file, 512)
      : null;
    if (!symbolId && !file) throw new Error("ATLAS code.getHotPath requires symbolId or file.");
    const identifiersToFind = sanitizeIdentifierList(payload.identifiersToFind || payload.identifiers);
    if (identifiersToFind.length === 0) {
      throw new Error("ATLAS code.getHotPath requires identifiersToFind.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(symbolId ? { symbolId } : { file }),
        identifiersToFind,
        ...(payload.contextLines == null ? {} : { contextLines: clampInt(payload.contextLines, 0, 30, 3) }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "code.needWindow") {
    const reason = sanitizeString(payload.reason || payload.justification || "", ATLAS_MAX_QUERY_LENGTH);
    const symbolId = optionalAtlasSymbolId(payload.symbolId, "code.needWindow symbolId");
    const file = payload.file && isSafeRelativePath(payload.file)
      ? sanitizeString(payload.file, 512)
      : null;
    if (!symbolId && !file) throw new Error("ATLAS code.needWindow requires symbolId or file.");
    if (!reason) throw new Error("ATLAS code.needWindow requires reason.");
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(symbolId ? { symbolId } : { file }),
        reason,
        identifiersToFind: sanitizeIdentifierList(payload.identifiersToFind),
        expectedLines: clampInt(payload.expectedLines, 1, 2000, 120),
        ...(payload.maxTokens == null ? {} : { maxTokens: clampInt(payload.maxTokens, 64, ATLAS_MAX_BUDGET_TOKENS, 1200) }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "agent.feedback") {
    // sliceHandle is optional: tree-first retrieval surfaces symbols without
    // ever building a slice, and the ledger stores feedback per symbol with a
    // nullable slice_handle — feedback must not require a slice to exist.
    const sliceHandle = sanitizeString(payload.sliceHandle, 128);
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(sliceHandle ? { sliceHandle } : {}),
        usefulSymbols: sanitizeAtlasSymbolIdList(payload.usefulSymbols, 40, "agent.feedback usefulSymbols"),
        missingSymbols: sanitizeAtlasSymbolIdList(payload.missingSymbols, 40, "agent.feedback missingSymbols"),
        ...(payload.taskType ? { taskType: sanitizeString(payload.taskType, 64) } : {}),
        ...(payload.taskText ? { taskText: sanitizeString(payload.taskText, ATLAS_MAX_QUERY_LENGTH) } : {}),
        ...(Array.isArray(payload.taskTags) ? { taskTags: sanitizeShortStringList(payload.taskTags, 12, 64) } : {}),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "pr.risk.analyze") {
    if (!payload.fromVersion || !payload.toVersion) {
      throw new Error("ATLAS pr.risk.analyze requires fromVersion and toVersion.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        fromVersion: sanitizeString(payload.fromVersion, 128),
        toVersion: sanitizeString(payload.toVersion, 128),
        ...(payload.riskThreshold == null ? {} : { riskThreshold: clampInt(payload.riskThreshold, 0, 100, 50) }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "pr.risk") {
    if (!payload.fromVersion || !payload.toVersion) {
      throw new Error("ATLAS pr.risk requires fromVersion and toVersion.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        fromVersion: sanitizeString(payload.fromVersion, 128),
        toVersion: sanitizeString(payload.toVersion, 128),
        _budgetMaxCards: clampInt(payload.maxCards, 1, ATLAS_MAX_BUDGET_CARDS, 12),
        _budgetMaxTokens: clampInt(payload.maxTokens, 128, ATLAS_MAX_BUDGET_TOKENS, 2000),
        ...(payload.riskThreshold == null ? {} : { riskThreshold: clampInt(payload.riskThreshold, 0, 100, 50) }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "file.read") {
    const filePath = requireSafeRelativePath(pickRelativePath(payload), "file.read filePath");
    const jsonPath = assertSafeJsonPath(payload.jsonPath, "jsonPath");
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        filePath,
        ...(payload.maxBytes == null ? {} : { maxBytes: clampInt(payload.maxBytes, 1, ATLAS_MAX_FILE_BYTES, ATLAS_MAX_FILE_BYTES) }),
        ...(payload.offset == null ? {} : { offset: clampInt(payload.offset, 0, Number.MAX_SAFE_INTEGER, 0) }),
        ...(payload.limit == null ? {} : { limit: clampInt(payload.limit, 1, ATLAS_MAX_FILE_LINES, 200) }),
        ...(payload.search ? { search: sanitizeString(payload.search, 500) } : {}),
        ...(payload.searchContext == null ? {} : { searchContext: clampInt(payload.searchContext, 0, ATLAS_MAX_SEARCH_CONTEXT_LINES, 2) }),
        ...(jsonPath ? { jsonPath } : {}),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "file.write") {
    const filePath = requireSafeRelativePath(pickRelativePath(payload), "file.write filePath");
    const writeMode = prepareWriteMode(payload);
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        filePath,
        ...writeMode,
        ...(payload.createBackup == null ? {} : { createBackup: !!payload.createBackup }),
        ...(payload.createIfMissing == null ? {} : { createIfMissing: !!payload.createIfMissing }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  return {
    action: normalizedAction,
    cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
    payload,
  };
}

function atlasActionSupportsRepoId(action) {
  const schema = ATLAS_TOOL_PARAM_SCHEMAS[action];
  return !!(schema?.properties && Object.prototype.hasOwnProperty.call(schema.properties, "repoId"));
}

export function executeAtlasDeterministicCommand(action, args = {}, {
  cwd = process.cwd(),
  repoId = null,
  executor,
} = {}) {
  if (typeof executor !== "function") {
    throw new Error("executeAtlasDeterministicCommand requires an executor callback.");
  }
  const prepared = prepareAtlasDeterministicPayload(action, args, { repoId });
  recordToolInvocation({
    tool: prepared.action,
    input: prepared.payload,
    cwd,
  });
  return executor(prepared);
}

export function __testIsSafeRelativePath(value) {
  return isSafeRelativePath(value);
}
