import { clampParsedInteger as clampInt } from "../../../format/functions/parse-integer.js";
import { COMPACT_RELATIONSHIP_PROJECTION } from "../../../../catalog/atlas-presentation.js";
import path from "path";
import { recordToolInvocation } from "../../../../domains/observability/functions/observations.js";
import {
  ATLAS_TOOL_DEFS,
  projectAtlasToolDefinitionForRuntime,
} from "../../../../domains/integrations/functions/deterministic-mcp/tool-descriptors.js";
import { ATLAS_CODE_WINDOW_SAFETY_MAXIMUMS, normalizeAtlasCodeWindowPolicy } from "../../../../catalog/atlas-tools.js";
import { optionalAtlasSymbolId, sanitizeAtlasSymbolIdList } from "../../../../domains/atlas/functions/v2/symbol-id.js";
import { coerceLooseAtlasSymbolArgs, validateAtlasPayloadSymbolIds } from "../../../../domains/atlas/functions/v2/signal-extraction.js";
import { ATLAS_ENUM_VALUE_ALIASES, ATLAS_TOOL_PARAM_SCHEMAS } from "../../../../domains/atlas/functions/v2/contracts/tool-schemas.js";
import { foldAtlasUnifiedSelectors } from "../../../../domains/atlas/functions/v2/contracts/unified-selectors.js";
import { withDescriptiveSearchSemantic } from "../../../../domains/atlas/functions/v2/contracts/search-defaults.js";
import { normalizeAtlasIdentifierList } from "../../../../domains/atlas/functions/v2/contracts/identifiers.js";
import { ATLAS_CALLER_MODES, ATLAS_CONTEXT_MODES, ATLAS_OVERVIEW_LEVELS, ATLAS_REPO_STATUS_DETAILS, ATLAS_TASK_TYPES, ATLAS_TREE_REF_TYPES, ATLAS_WIRE_FORMATS } from "../../../../catalog/atlas-params.js";

const DEFAULT_ATLAS_SCOPE_MAX_FILES = 40;
// file.write only: the runtime schema leaves write ranges unbounded.
const ATLAS_MAX_FILE_LINES = 5000;
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

function sanitizeString(value, maxLen = 1024) {
  if (value == null) return "";
  return String(value).trim().slice(0, maxLen);
}

// The dispatcher validates every prepared payload against
// ATLAS_TOOL_PARAM_SCHEMAS, and the agent is shown the same bounds. Clamps,
// caps and length limits read them from that schema, so a value the agent was
// offered is neither rejected after preparation nor silently narrowed.
function atlasParamSchema(action, path) {
  let schema = ATLAS_TOOL_PARAM_SCHEMAS[action];
  for (const key of path.split(".")) schema = schema?.properties?.[key];
  if (!schema) throw new Error(`ATLAS ${action} has no ${path} parameter schema`);
  return schema;
}

function atlasParamLimit(action, path, keyword) {
  const limit = atlasParamSchema(action, path)[keyword];
  if (!Number.isFinite(limit)) throw new Error(`ATLAS ${action}.${path} schema has no ${keyword}`);
  return limit;
}

function clampAtlasParam(value, action, path, fallback) {
  const schema = atlasParamSchema(action, path);
  const parsed = schema.type === "number" ? Number.parseFloat(String(value ?? "")) : Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.max(schema.minimum ?? -Infinity, Math.min(schema.maximum ?? Infinity, parsed));
}

const atlasTextLimit = (action, path) => atlasParamLimit(action, path, "maxLength");
const atlasItemLimit = (action, path) => atlasParamLimit(action, path, "maxItems");

// symbol.search forwards its arguments whole; clamp every bounded numeric one.
function clampAtlasNumericParams(action, payload) {
  const out = { ...payload };
  for (const [field, schema] of Object.entries(ATLAS_TOOL_PARAM_SCHEMAS[action]?.properties || {})) {
    if (out[field] == null || (schema.type !== "integer" && schema.type !== "number")) continue;
    if (schema.minimum == null && schema.maximum == null) continue;
    const clamped = clampAtlasParam(out[field], action, field, undefined);
    if (clamped === undefined) continue;
    out[field] = clamped;
  }
  return out;
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

function sanitizeSymbolRef(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  return {
    name: sanitizeString(value.name, 256),
    ...(value.file && isSafeRelativePath(value.file)
      ? { file: sanitizeString(value.file, 512) }
      : {}),
    ...(value.kind ? { kind: sanitizeString(value.kind, 64) } : {}),
    ...(value.exportedOnly == null ? {} : { exportedOnly: !!value.exportedOnly }),
  };
}

function boundedBatchSymbolRefs(values, maxItems = 100) {
  return Array.isArray(values) ? values.slice(0, maxItems) : [];
}

function normalizeAtlasWireFormat(value) {
  if (value == null) return undefined;
  const text = sanitizeString(value, 32);
  const canonical = ATLAS_ENUM_VALUE_ALIASES["$.wireFormat"]?.[text] || text;
  return ATLAS_WIRE_FORMATS.includes(canonical) ? canonical : undefined;
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
    const rawStart = Number(source.start);
    const rawEnd = Number(source.end);
    if (!Number.isInteger(rawStart) || !Number.isInteger(rawEnd) || rawStart < 1 || rawEnd < 1) {
      throw new Error("ATLAS file.write replaceLines requires 1-based positive integer start/end values. Use insertAt or append when adding content outside an existing range.");
    }
    if (rawStart > ATLAS_MAX_FILE_LINES || rawEnd > ATLAS_MAX_FILE_LINES) {
      throw new Error(`ATLAS file.write replaceLines range exceeds the ${ATLAS_MAX_FILE_LINES}-line safety limit. Use insertAt or append when adding content outside an existing range.`);
    }
    if (rawEnd < rawStart) {
      throw new Error("ATLAS file.write replaceLines end must be >= start. Use insertAt or append when adding content outside an existing range.");
    }
    return {
      replaceLines: {
        start: rawStart,
        end: rawEnd,
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
  const rawLine = Number(source.line);
  if (!Number.isInteger(rawLine) || rawLine < 1) {
    throw new Error("ATLAS file.write insertAt requires a positive 1-based integer line.");
  }
  return {
    insertAt: {
      line: clampInt(rawLine, 1, ATLAS_MAX_FILE_LINES + 1, 1),
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

export function getAtlasDeterministicToolDefinitions(toolNames = [], {
  codeWindowPolicy = null,
  role = null,
} = {}) {
  return (toolNames || [])
    .map((toolName) => {
      const schema = ATLAS_TOOL_DEFS[toolName];
      return schema
        ? projectAtlasToolDefinitionForRuntime(schema, { action: toolName, codeWindowPolicy, role })
        : null;
    })
    .filter(Boolean);
}

export function resolveAtlasDeterministicAction(toolName) {
  return ATLAS_TOOL_NAME_TO_ACTION[toolName] || null;
}

export function prepareAtlasDeterministicPayload(action, args = {}, {
  repoId = null,
  codeWindowPolicy = null,
} = {}) {
  const normalizedAction = normalizeAction(action);
  const unified = foldAtlasUnifiedSelectors(normalizedAction, { ...(args || {}) });
  if (unified.error) throw new Error(`ATLAS ${unified.error}`);
  const payload = unified.args;
  const fallbackOnlyNested = nestedFallbackOnlyAction(payload);
  if (ATLAS_FALLBACK_ONLY_ACTIONS.has(normalizedAction) || fallbackOnlyNested) {
    throw new Error("ATLAS file.read is intentionally not exposed. Use code.window in file mode, its continuation handle, or code.lens for indexed source. Use the issued deterministic read_file/chain_read tool for exact file content.");
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
    const detail = sanitizeString(payload.detail || "", 16).toLowerCase();
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
        ...(ATLAS_REPO_STATUS_DETAILS.includes(detail) ? { detail } : {}),
        ...(payload.surfaceMemories == null ? {} : { surfaceMemories: !!payload.surfaceMemories }),
      },
    };
  }

  if (normalizedAction === "repo.overview") {
    const levelRaw = sanitizeString(payload.level || "", 16).toLowerCase();
    const directories = sanitizeRelativePathList(payload.directories, atlasItemLimit("repo.overview", "directories"));
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        level: ATLAS_OVERVIEW_LEVELS.includes(levelRaw) ? levelRaw : "stats",
        ...(payload.includeHotspots == null ? {} : { includeHotspots: !!payload.includeHotspots }),
        ...(directories.length > 0 ? { directories } : {}),
        ...(payload.maxDirectories == null ? {} : { maxDirectories: clampAtlasParam(payload.maxDirectories, "repo.overview", "maxDirectories", 25) }),
        ...(payload.maxExportsPerDirectory == null ? {} : { maxExportsPerDirectory: clampAtlasParam(payload.maxExportsPerDirectory, "repo.overview", "maxExportsPerDirectory", 10) }),
        ...(payload.ifNoneMatch ? { ifNoneMatch: sanitizeString(payload.ifNoneMatch, atlasTextLimit("repo.overview", "ifNoneMatch")) } : {}),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "symbol.search") {
    const query = sanitizeString(payload.query, atlasTextLimit("symbol.search", "query"));
    if (!query) throw new Error("ATLAS symbol.search requires a non-empty query.");
    // Unset on a query worded as a description means on; see search-defaults.
    const searchPayload = withDescriptiveSearchSemantic({ ...payload, query });
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...clampAtlasNumericParams("symbol.search", searchPayload),
        query,
        limit: clampAtlasParam(payload.limit, "symbol.search", "limit", 10),
        semantic: searchPayload.semantic === true,
      },
    };
  }

  if (normalizedAction === "tree.scope") {
    const rawPaths = [
      ...sanitizeRelativePathList(payload.paths, atlasItemLimit("tree.scope", "paths")),
      ...sanitizeRelativePathList(payload.editedFiles, atlasItemLimit("tree.scope", "editedFiles")),
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
        .filter((ref) => ATLAS_TREE_REF_TYPES.includes(ref.refType) && ref.refId)
        .slice(0, atlasItemLimit("tree.scope", "refs"))
      : [];
    const refType = sanitizeString(payload.refType, 32);
    const refId = sanitizeString(payload.refId, 512);
    if (ATLAS_TREE_REF_TYPES.includes(refType) && refId) refs.push({ refType, refId });
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        taskText: payload.taskText != null ? sanitizeString(payload.taskText, atlasTextLimit("tree.scope", "taskText")) : undefined,
        taskType: payload.taskType != null ? sanitizeString(payload.taskType, 64) : undefined,
        paths: [...new Set(rawPaths)].slice(0, atlasItemLimit("tree.scope", "paths")),
        symbolIds: sanitizeAtlasSymbolIdList(payload.symbolIds || (payload.symbolId ? [payload.symbolId] : []), atlasItemLimit("tree.scope", "symbolIds"), "tree.scope symbolIds"),
        nodeIds: sanitizeShortStringList(payload.nodeIds, atlasItemLimit("tree.scope", "nodeIds"), 2000),
        refs,
        ...(payload.maxFiles == null ? {} : { maxFiles: clampAtlasParam(payload.maxFiles, "tree.scope", "maxFiles", DEFAULT_ATLAS_SCOPE_MAX_FILES) }),
        ...(payload.maxBranches == null ? {} : { maxBranches: clampAtlasParam(payload.maxBranches, "tree.scope", "maxBranches", 12) }),
        ...(payload.branchFileCap == null ? {} : { branchFileCap: clampAtlasParam(payload.branchFileCap, "tree.scope", "branchFileCap", 40) }),
        ...(payload.refMatchLimit == null ? {} : { refMatchLimit: clampAtlasParam(payload.refMatchLimit, "tree.scope", "refMatchLimit", 50) }),
        ...(payload.siblingNumericFamilyCap == null ? {} : { siblingNumericFamilyCap: clampAtlasParam(payload.siblingNumericFamilyCap, "tree.scope", "siblingNumericFamilyCap", 100) }),
      },
    };
  }

  if (normalizedAction === "tree.expand") {
    const rawPaths = [
      ...sanitizeRelativePathList(payload.paths, atlasItemLimit("tree.expand", "paths")),
      ...sanitizeRelativePathList(payload.editedFiles, atlasItemLimit("tree.expand", "editedFiles")),
    ];
    if (payload.path != null) rawPaths.push(requireSafeRelativePath(payload.path, "tree.expand path"));
    assertNoUnsafeRelativePaths(payload.paths, "tree.expand paths");
    assertNoUnsafeRelativePaths(payload.editedFiles, "tree.expand editedFiles");
    const refs = Array.isArray(payload.refs)
      ? payload.refs
        .map((ref) => ({
          refType: sanitizeString(ref?.refType, 32),
          refId: sanitizeString(ref?.refId, 512),
        }))
        .filter((ref) => ATLAS_TREE_REF_TYPES.includes(ref.refType) && ref.refId)
        .slice(0, atlasItemLimit("tree.expand", "refs"))
      : [];
    const refType = sanitizeString(payload.refType, 32);
    const refId = sanitizeString(payload.refId, 512);
    if (ATLAS_TREE_REF_TYPES.includes(refType) && refId) refs.push({ refType, refId });
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        paths: [...new Set(rawPaths)].slice(0, atlasItemLimit("tree.expand", "paths")),
        symbolIds: sanitizeAtlasSymbolIdList(payload.symbolIds || (payload.symbolId ? [payload.symbolId] : []), atlasItemLimit("tree.expand", "symbolIds"), "tree.expand symbolIds"),
        nodeIds: sanitizeShortStringList(payload.nodeIds, atlasItemLimit("tree.expand", "nodeIds"), 2000),
        refs,
        ...(payload.maxFiles == null ? {} : { maxFiles: clampAtlasParam(payload.maxFiles, "tree.expand", "maxFiles", DEFAULT_ATLAS_SCOPE_MAX_FILES) }),
        ...(payload.maxBranches == null ? {} : { maxBranches: clampAtlasParam(payload.maxBranches, "tree.expand", "maxBranches", 12) }),
        ...(payload.branchFileCap == null ? {} : { branchFileCap: clampAtlasParam(payload.branchFileCap, "tree.expand", "branchFileCap", 40) }),
        ...(payload.refMatchLimit == null ? {} : { refMatchLimit: clampAtlasParam(payload.refMatchLimit, "tree.expand", "refMatchLimit", 50) }),
      },
    };
  }

  if (normalizedAction === "context") {
    const rawFocusPaths = payload.focusPaths || payload.editedFiles || payload.options?.focusPaths;
    assertNoUnsafeRelativePaths(rawFocusPaths, "focusPaths");
    const taskText = sanitizeString(
      payload.taskText || payload.task || payload.description || payload.query || "",
      atlasTextLimit("context", "taskText"),
    );
    if (!taskText) throw new Error("ATLAS context requires taskText.");
    const taskTypeRaw = sanitizeString(payload.taskType || "explain", 64);
    const taskType = ATLAS_TASK_TYPES.includes(taskTypeRaw)
      ? taskTypeRaw
      : "explain";
    const contextModeRaw = sanitizeString(payload.contextMode || payload.options?.contextMode || "", 16).toLowerCase();
    const entrySymbols = sanitizeAtlasSymbolIdList(payload.focusSymbols || payload.entrySymbols || payload.options?.focusSymbols, atlasItemLimit("context", "focusSymbols"), "context focusSymbols");
    const editedFiles = sanitizeRelativePathList(rawFocusPaths, atlasItemLimit("context", "focusPaths"));
    const options = {
      ...(ATLAS_CONTEXT_MODES.includes(contextModeRaw) ? { contextMode: contextModeRaw } : {}),
      ...(entrySymbols.length > 0 ? { focusSymbols: entrySymbols } : {}),
      ...(editedFiles.length > 0 ? { focusPaths: editedFiles } : {}),
    };
    const maxTokens = clampAtlasParam(payload.maxTokens ?? payload.budget?.maxTokens, "context", "maxTokens", 1600);
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        taskText,
        taskType,
        ...(options.contextMode ? { contextMode: options.contextMode } : {}),
        ...(options.focusSymbols ? { focusSymbols: options.focusSymbols } : {}),
        ...(options.focusPaths ? { focusPaths: options.focusPaths } : {}),
        maxTokens,
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
        taskText: payload.taskText != null ? sanitizeString(payload.taskText, atlasTextLimit("slice.build", "taskText")) : undefined,
        semantic: payload.semantic == null ? undefined : !!payload.semantic,
        taskType: payload.taskType != null ? sanitizeString(payload.taskType, 64) : undefined,
        entrySymbols: sanitizeAtlasSymbolIdList(payload.entrySymbols, atlasItemLimit("slice.build", "entrySymbols"), "slice.build entrySymbols"),
        editedFiles: sanitizeRelativePathList(payload.editedFiles, atlasItemLimit("slice.build", "editedFiles")),
        stackTrace: payload.stackTrace != null ? sanitizeString(payload.stackTrace, atlasTextLimit("slice.build", "stackTrace")) : undefined,
        failingTestPath: payload.failingTestPath && isSafeRelativePath(payload.failingTestPath)
          ? sanitizeString(payload.failingTestPath, 512)
          : undefined,
        cardDetail: payload.cardDetail != null ? sanitizeString(payload.cardDetail, 64) : undefined,
        ifNoneMatch: payload.ifNoneMatch != null ? sanitizeString(payload.ifNoneMatch, atlasTextLimit("slice.build", "ifNoneMatch")) : undefined,
        wireFormat: normalizeAtlasWireFormat(payload.wireFormat),
        wireFormatVersion: payload.wireFormatVersion == null ? undefined : clampAtlasParam(payload.wireFormatVersion, "slice.build", "wireFormatVersion", 2),
        budget: {
          maxCards: clampAtlasParam(payload.maxCards, "slice.build", "budget.maxCards", 12),
          maxEstimatedTokens: clampAtlasParam(payload.maxTokens, "slice.build", "budget.maxEstimatedTokens", 2000),
        },
        ...(knownCardEtags ? { knownCardEtags } : {}),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "slice.spillover.get") {
    const spilloverHandle = sanitizeString(payload.spilloverHandle || payload.spillover_handle || payload.handle || "", atlasTextLimit("slice.spillover.get", "spilloverHandle"));
    if (!spilloverHandle) throw new Error("ATLAS slice.spillover.get requires spilloverHandle.");
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        spilloverHandle,
        ...(payload.cursor ? { cursor: sanitizeString(payload.cursor, atlasTextLimit("slice.spillover.get", "cursor")) } : {}),
        ...(payload.pageSize == null ? {} : { pageSize: clampAtlasParam(payload.pageSize, "slice.spillover.get", "pageSize", 20) }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "review.delta") {
    if (!payload.fromVersion || !payload.toVersion) {
      throw new Error("ATLAS review.delta requires fromVersion and toVersion.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        fromVersion: sanitizeString(payload.fromVersion, atlasTextLimit("review.delta", "fromVersion")),
        toVersion: sanitizeString(payload.toVersion, atlasTextLimit("review.delta", "toVersion")),
        _budgetMaxCards: clampAtlasParam(payload.maxCards, "review.delta", "maxCards", 12),
        _budgetMaxTokens: clampAtlasParam(payload.maxTokens, "review.delta", "maxTokens", 2000),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "symbol.card") {
    const symbolId = optionalAtlasSymbolId(payload.symbolId, "symbol.card symbolId");
    const symbolRef = sanitizeSymbolRef(payload.symbolRef);
    const symbolIds = sanitizeAtlasSymbolIdList(payload.symbolIds, atlasItemLimit("symbol.card", "symbolIds"), "symbol.card symbolIds");
    const symbolRefs = boundedBatchSymbolRefs(payload.symbolRefs, atlasItemLimit("symbol.card", "symbolRefs"));
    if (!symbolId && !symbolRef?.name && symbolIds.length === 0 && symbolRefs.length === 0) {
      throw new Error("ATLAS symbol.card requires symbolId, symbolRef, symbolIds, or symbolRefs.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(symbolId ? { symbolId } : {}),
        ...(symbolRef?.name ? { symbolRef } : {}),
        ...(symbolIds.length > 0 ? { symbolIds } : {}),
        ...(symbolRefs.length > 0 ? { symbolRefs } : {}),
        ...(payload.ifNoneMatch ? { ifNoneMatch: sanitizeString(payload.ifNoneMatch, atlasTextLimit("symbol.card", "ifNoneMatch")) } : {}),
        ...(payload.minCallConfidence == null ? {} : { minCallConfidence: Number(payload.minCallConfidence) }),
        ...(payload.includeResolutionMetadata == null ? {} : { includeResolutionMetadata: !!payload.includeResolutionMetadata }),
        ...(payload.sessionId ? { sessionId: sanitizeString(payload.sessionId, atlasTextLimit("symbol.card", "sessionId")) } : {}),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "symbol.callers") {
    const symbolId = optionalAtlasSymbolId(payload.symbolId, "symbol.callers symbolId");
    const mode = sanitizeString(payload.mode || "caller", 16).toLowerCase();
    if (!symbolId) throw new Error("ATLAS symbol.callers requires symbols.");
    if (!ATLAS_CALLER_MODES.includes(mode)) {
      throw new Error(`ATLAS symbol.callers mode must be one of: ${ATLAS_CALLER_MODES.join(", ")}.`);
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        symbolId,
        mode,
        limit: clampAtlasParam(payload.limit, "symbol.callers", "limit", 20),
        offset: clampAtlasParam(payload.offset, "symbol.callers", "offset", 0),
        ...(payload.minConfidence == null ? {} : { minConfidence: Number(payload.minConfidence) }),
        projection: COMPACT_RELATIONSHIP_PROJECTION,
      },
    };
  }

  if (normalizedAction === "symbol.get") {
    const symbolId = optionalAtlasSymbolId(payload.symbolId, "symbol.get symbolId");
    const symbolRef = sanitizeSymbolRef(payload.symbolRef);
    if (!symbolId && !symbolRef?.name) {
      throw new Error("ATLAS symbol.get requires names or symbols.");
    }
    if (payload.file != null && !isSafeRelativePath(payload.file)) {
      throw new Error("ATLAS symbol.get file must be a safe relative path.");
    }
    if (payload.symbolRef?.file != null && !isSafeRelativePath(payload.symbolRef.file)) {
      throw new Error("ATLAS symbol.get symbolRef.file must be a safe relative path.");
    }
    const identifiersToFind = normalizeAtlasIdentifierList(payload.identifiersToFind, atlasItemLimit("symbol.get", "identifiersToFind"));
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(symbolId ? { symbolId } : { symbolRef }),
        ...(payload.file ? { file: sanitizeString(payload.file, atlasTextLimit("symbol.get", "file")) } : {}),
        ...(identifiersToFind.length > 0 ? { identifiersToFind } : {}),
        ...(payload.maxTokens == null ? {} : {
          maxTokens: clampInt(
            payload.maxTokens,
            1,
            codeWindowPolicy
              ? normalizeAtlasCodeWindowPolicy(codeWindowPolicy).maxWindowTokens
              : ATLAS_CODE_WINDOW_SAFETY_MAXIMUMS.maxWindowTokens,
            1200,
          ),
        }),
      },
    };
  }

  if (normalizedAction === "code.skeleton") {
    if (payload.file != null && !isSafeRelativePath(payload.file)) {
      throw new Error("ATLAS code.skeleton file must be a safe relative path.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(payload.symbolId ? { symbolId: optionalAtlasSymbolId(payload.symbolId, "code.skeleton symbolId") } : {}),
        ...(payload.file ? { file: sanitizeString(payload.file, 512) } : {}),
        ...(payload.exportedOnly == null ? {} : { exportedOnly: !!payload.exportedOnly }),
        ...(payload.surveyGap ? { surveyGap: sanitizeString(payload.surveyGap, 1000) } : {}),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "code.lens") {
    const symbolId = optionalAtlasSymbolId(payload.symbolId, "code.lens symbolId");
    const file = payload.file && isSafeRelativePath(payload.file)
      ? sanitizeString(payload.file, 512)
      : null;
    if (!symbolId && !file) throw new Error("ATLAS code.lens requires file or symbols.");
    const identifiersToFind = normalizeAtlasIdentifierList(payload.identifiersToFind || payload.identifiers, atlasItemLimit("code.lens", "identifiersToFind"));
    if (identifiersToFind.length === 0) {
      throw new Error("ATLAS code.lens requires names.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(symbolId ? { symbolId } : { file }),
        identifiersToFind,
        ...(payload.contextLines == null ? {} : { contextLines: clampAtlasParam(payload.contextLines, "code.lens", "contextLines", 3) }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "code.window") {
    if (Array.isArray(payload.items)) {
      throw new Error("ATLAS code.window multi-selection is disabled; issue independent scalar calls together.");
    }
    const reason = sanitizeString(payload.reason || payload.justification || "", atlasTextLimit("code.window", "reason"));
    const symbolId = optionalAtlasSymbolId(payload.symbolId, "code.window symbolId");
    const file = payload.file && isSafeRelativePath(payload.file)
      ? sanitizeString(payload.file, 512)
      : null;
    if (!symbolId && !file) throw new Error("ATLAS code.window requires file or symbols.");
    if (!reason) throw new Error("ATLAS code.window requires reason.");
    const identifiersToFind = normalizeAtlasIdentifierList(payload.identifiersToFind, atlasItemLimit("code.window", "identifiersToFind"));
    if (file && identifiersToFind.length === 0) {
      throw new Error("ATLAS code.window file mode requires names.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        ...(symbolId ? { symbolId } : { file }),
        reason,
        identifiersToFind,
        expectedLines: clampAtlasParam(payload.expectedLines, "code.window", "expectedLines", 120),
        ...(payload.maxTokens == null ? {} : {
          maxTokens: clampInt(
            payload.maxTokens,
            1,
            codeWindowPolicy
              ? normalizeAtlasCodeWindowPolicy(codeWindowPolicy).maxWindowTokens
              : ATLAS_CODE_WINDOW_SAFETY_MAXIMUMS.maxWindowTokens,
            1200,
          ),
        }),
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
        usefulSymbols: sanitizeAtlasSymbolIdList(payload.usefulSymbols, atlasItemLimit("agent.feedback", "usefulSymbols"), "agent.feedback usefulSymbols"),
        missingSymbols: sanitizeAtlasSymbolIdList(payload.missingSymbols, atlasItemLimit("agent.feedback", "missingSymbols"), "agent.feedback missingSymbols"),
        ...(payload.taskType ? { taskType: sanitizeString(payload.taskType, 64) } : {}),
        ...(payload.taskText ? { taskText: sanitizeString(payload.taskText, atlasTextLimit("agent.feedback", "taskText")) } : {}),
        ...(Array.isArray(payload.taskTags) ? { taskTags: sanitizeShortStringList(payload.taskTags, atlasItemLimit("agent.feedback", "taskTags"), atlasParamSchema("agent.feedback", "taskTags").items.maxLength) } : {}),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "review.analyze") {
    if (!payload.fromVersion || !payload.toVersion) {
      throw new Error("ATLAS review.analyze requires fromVersion and toVersion.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        fromVersion: sanitizeString(payload.fromVersion, atlasTextLimit("review.analyze", "fromVersion")),
        toVersion: sanitizeString(payload.toVersion, atlasTextLimit("review.analyze", "toVersion")),
        ...(payload.riskThreshold == null ? {} : { riskThreshold: clampAtlasParam(payload.riskThreshold, "review.analyze", "riskThreshold", 50) }),
        ...(payload.repoId ? { repoId: payload.repoId } : {}),
      },
    };
  }

  if (normalizedAction === "review.risk") {
    if (!payload.fromVersion || !payload.toVersion) {
      throw new Error("ATLAS review.risk requires fromVersion and toVersion.");
    }
    return {
      action: normalizedAction,
      cliAction: resolveAtlasDeterministicCliAction(normalizedAction),
      payload: {
        fromVersion: sanitizeString(payload.fromVersion, atlasTextLimit("review.risk", "fromVersion")),
        toVersion: sanitizeString(payload.toVersion, atlasTextLimit("review.risk", "toVersion")),
        _budgetMaxCards: clampAtlasParam(payload.maxCards, "review.risk", "maxCards", 12),
        _budgetMaxTokens: clampAtlasParam(payload.maxTokens, "review.risk", "maxTokens", 2000),
        ...(payload.riskThreshold == null ? {} : { riskThreshold: clampAtlasParam(payload.riskThreshold, "review.risk", "riskThreshold", 50) }),
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
        ...(payload.maxBytes == null ? {} : { maxBytes: clampAtlasParam(payload.maxBytes, "file.read", "maxBytes", 512 * 1024) }),
        ...(payload.offset == null ? {} : { offset: clampAtlasParam(payload.offset, "file.read", "offset", 0) }),
        ...(payload.limit == null ? {} : { limit: clampAtlasParam(payload.limit, "file.read", "limit", 200) }),
        ...(payload.search ? { search: sanitizeString(payload.search, atlasTextLimit("file.read", "search")) } : {}),
        ...(payload.searchContext == null ? {} : { searchContext: clampAtlasParam(payload.searchContext, "file.read", "searchContext", 2) }),
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
  codeWindowPolicy = null,
  executor,
} = {}) {
  if (typeof executor !== "function") {
    throw new Error("executeAtlasDeterministicCommand requires an executor callback.");
  }
  const prepared = prepareAtlasDeterministicPayload(action, args, { repoId, codeWindowPolicy });
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
