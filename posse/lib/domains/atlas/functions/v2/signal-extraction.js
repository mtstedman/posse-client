// @ts-check

import { isAtlasSymbolId, optionalAtlasSymbolId, sanitizeAtlasSymbolIdList } from "./symbol-id.js";
import { atlasSymbolCardField } from "./contracts/tool-results.js";

const RESULT_SYMBOL_LIMIT = 200;
const FILE_EXT_RE = /\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}$/u;
const SYMBOL_NAME_RE = /^[A-Za-z_$][A-Za-z0-9_$.:#-]{0,255}$/u;

export function normalizeAtlasActionName(value = "") {
  const raw = String(value || "").trim();
  if (!raw) return "";
  let action = raw;
  if (action.startsWith("atlas.")) action = action.slice("atlas.".length);
  if (action.startsWith("atlas_")) action = action.slice("atlas_".length);
  action = action.replace(/_/g, ".");
  const aliases = {
    "symbol.get.card": "symbol.getCard",
    "slice.spillover.get": "slice.spillover.get",
    "code.get.skeleton": "code.getSkeleton",
    "code.get.hot.path": "code.getHotPath",
    "code.need.window": "code.needWindow",
    "agent.feedback": "agent.feedback",
    "agent.feedback.query": "agent.feedback.query",
    "repo.status": "repo.status",
    "repo.overview": "repo.overview",
    "pr.risk": "pr.risk",
    "pr.risk.analyze": "pr.risk.analyze",
  };
  return aliases[action] || action;
}

export function validateAtlasPayloadSymbolIds(action, payload = {}) {
  const normalized = normalizeAtlasActionName(action);
  const input = /** @type {Record<string, any>} */ (payload && typeof payload === "object" ? payload : {});

  if (normalized === "symbol.getCard" && input.symbolId != null) {
    optionalAtlasSymbolId(input.symbolId, "symbol.getCard symbolId");
  }
  if (normalized === "context") {
    sanitizeAtlasSymbolIdList(input.focusSymbols, 100, "context focusSymbols");
  }
  if (normalized === "slice.build") {
    sanitizeAtlasSymbolIdList(input.entrySymbols, 100, "slice.build entrySymbols");
  }
  if (normalized === "code.getSkeleton" && input.symbolId != null) {
    optionalAtlasSymbolId(input.symbolId, "code.getSkeleton symbolId");
  }
  if (normalized === "code.getHotPath" && input.symbolId != null) {
    optionalAtlasSymbolId(input.symbolId, "code.getHotPath symbolId");
  }
  if (normalized === "code.needWindow" && input.symbolId != null) {
    optionalAtlasSymbolId(input.symbolId, "code.needWindow symbolId");
  }
  if (normalized === "agent.feedback") {
    sanitizeAtlasSymbolIdList(input.usefulSymbols, 40, "agent.feedback usefulSymbols");
    sanitizeAtlasSymbolIdList(input.missingSymbols, 40, "agent.feedback missingSymbols");
  }
  if (normalized === "memory.store" || normalized === "memory.query" || normalized === "memory.surface") {
    sanitizeAtlasSymbolIdList(input.symbolIds, 500, `${normalized} symbolIds`);
  }
}

export function coerceLooseAtlasSymbolArgs(action, payload = {}) {
  const normalized = normalizeAtlasActionName(action);
  const input = /** @type {Record<string, any>} */ (payload && typeof payload === "object" ? payload : {});

  if (normalized === "symbol.getCard") {
    coerceSymbolIdToSymbolRef(input);
  } else if (normalized === "code.getSkeleton") {
    coerceSymbolIdToFile(input);
  } else if (normalized === "code.getHotPath") {
    coerceSymbolIdToFile(input);
  } else if (normalized === "code.needWindow") {
    coerceSymbolIdToFile(input);
  } else if (normalized === "slice.build") {
    coerceSymbolListPaths(input, "entrySymbols", "editedFiles");
  } else if (normalized === "context") {
    coerceSymbolListPaths(input, "focusSymbols", "focusPaths");
    coerceSymbolListPaths(input, "entrySymbols", "focusPaths");
    if (input.options && typeof input.options === "object") {
      coerceSymbolListPaths(input.options, "focusSymbols", "focusPaths");
    }
  }

  return input;
}

export function extractAtlasResultArtifacts(value, { action = null, args = {} } = {}) {
  const parsed = /** @type {Record<string, any> | null} */ (parseMaybeJsonResult(value));
  if (!parsed || typeof parsed !== "object") return null;
  const inputArgs = /** @type {Record<string, any>} */ (args && typeof args === "object" ? args : {});

  /** @type {{ versionId: string | null, sliceHandle: string | null, symbols: Array<{ symbolId: string, filePath: string | null }> }} */
  const artifacts = {
    versionId: typeof parsed.versionId === "string" ? parsed.versionId : null,
    sliceHandle: null,
    symbols: [],
  };

  const data = /** @type {Record<string, any>} */ (parsed.data && typeof parsed.data === "object" ? parsed.data : parsed);
  if (typeof data.sliceHandle === "string") artifacts.sliceHandle = data.sliceHandle;
  if (!artifacts.versionId && typeof data.knownVersion === "string") artifacts.versionId = data.knownVersion;
  if (!artifacts.versionId && typeof inputArgs.versionId === "string") artifacts.versionId = inputArgs.versionId;
  if (!artifacts.sliceHandle && typeof inputArgs.sliceHandle === "string") artifacts.sliceHandle = inputArgs.sliceHandle;

  collectSymbols(data, artifacts.symbols, new Set());

  const directId = typeof inputArgs.symbolId === "string" && isAtlasSymbolId(inputArgs.symbolId)
    ? inputArgs.symbolId
    : null;
  if (directId) addSymbol(artifacts.symbols, directId, null, new Set(artifacts.symbols.map((s) => s.symbolId)));

  if (!artifacts.versionId && !artifacts.sliceHandle && artifacts.symbols.length === 0) return null;
  return {
    action: normalizeAtlasActionName(action || parsed.action || ""),
    versionId: artifacts.versionId,
    sliceHandle: artifacts.sliceHandle,
    symbols: artifacts.symbols.slice(0, RESULT_SYMBOL_LIMIT),
  };
}

export function extractAtlasResponseTelemetry(value) {
  const parsed = /** @type {Record<string, any> | null} */ (parseMaybeJsonResult(value));
  if (!parsed || typeof parsed !== "object") return null;
  const data = /** @type {Record<string, any>} */ (parsed.data && typeof parsed.data === "object" ? parsed.data : parsed);
  const budget = data.budgetUsage && typeof data.budgetUsage === "object" ? data.budgetUsage : null;
  const out = {};
  const estimatedTokens = finiteTelemetryNumber(data.estimatedTokens ?? budget?.estimatedTokens);
  if (estimatedTokens != null) out.estimated_tokens = estimatedTokens;
  const cardsReturned = finiteTelemetryNumber(budget?.cardsReturned) ?? arrayLength(data.cards);
  if (cardsReturned != null) out.cards_returned = cardsReturned;
  const cardsAvailable = finiteTelemetryNumber(budget?.cardsAvailable);
  if (cardsAvailable != null) out.cards_available = cardsAvailable;
  const memoriesReturned = finiteTelemetryNumber(budget?.memoriesReturned) ?? arrayLength(data.memories);
  if (memoriesReturned != null) out.memories_returned = memoriesReturned;
  const memoriesAvailable = finiteTelemetryNumber(budget?.memoriesAvailable);
  if (memoriesAvailable != null) out.memories_available = memoriesAvailable;
  const evidenceReturned = arrayLength(data.finalEvidence);
  if (evidenceReturned != null) out.evidence_returned = evidenceReturned;
  if (data.truncated != null) out.truncated = data.truncated === true;
  else if (
    (cardsAvailable != null && cardsReturned != null && cardsReturned < cardsAvailable)
    || (memoriesAvailable != null && memoriesReturned != null && memoriesReturned < memoriesAvailable)
  ) {
    out.truncated = true;
  }
  return Object.keys(out).length > 0 ? out : null;
}

/**
 * @returns {any}
 */
function parseMaybeJsonResult(value) {
  if (!value) return null;
  if (typeof value === "object") {
    const content = Array.isArray(value.content) ? value.content : null;
    if (content) {
      const text = content.map((entry) => typeof entry?.text === "string" ? entry.text : "").join("");
      return parseMaybeJsonResult(text);
    }
    return value;
  }
  const text = String(value || "").trim();
  if (!text || /^Error:/i.test(text)) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

function finiteTelemetryNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function arrayLength(value) {
  return Array.isArray(value) ? value.length : null;
}

function coerceSymbolIdToSymbolRef(input) {
  if (input.symbolRef || input.symbolId == null || isAtlasSymbolId(input.symbolId)) return;
  const ref = looseSymbolRefFromValue(input.symbolId);
  if (!ref?.name) return;
  input.symbolRef = ref;
  delete input.symbolId;
}

function coerceSymbolIdToFile(input) {
  if (input.file || input.symbolId == null || isAtlasSymbolId(input.symbolId)) return;
  const ref = looseSymbolRefFromValue(input.symbolId);
  if (!ref?.file) return;
  input.file = ref.file;
  delete input.symbolId;
}

function coerceSymbolListPaths(input, symbolKey, pathKey) {
  const raw = Array.isArray(input?.[symbolKey]) ? input[symbolKey] : [];
  if (raw.length === 0) return;

  const symbols = [];
  const paths = Array.isArray(input[pathKey]) ? [...input[pathKey]] : [];
  let changed = false;
  for (const value of raw) {
    if (isAtlasSymbolId(value)) {
      symbols.push(String(value).trim());
      continue;
    }
    const ref = looseSymbolRefFromValue(value);
    if (ref?.file) {
      if (!paths.includes(ref.file)) paths.push(ref.file);
      changed = true;
      continue;
    }
    symbols.push(value);
  }

  if (!changed) return;
  input[symbolKey] = symbols;
  input[pathKey] = paths;
}

/**
 * @param {unknown} value
 * @returns {{ name?: string | null, file?: string | null } | null}
 */
function looseSymbolRefFromValue(value) {
  const text = stripLooseWrapper(value);
  if (!text || isAtlasSymbolId(text)) return null;

  const composite = looseCompositeSymbolRef(text);
  if (composite) return composite;

  const file = looseRepoPathFromText(text);
  if (file) {
    const name = symbolNameFromPath(file);
    return name ? { name, file } : { file };
  }

  const name = cleanLooseSymbolName(text);
  return name ? { name } : null;
}

function looseCompositeSymbolRef(text) {
  const doubleColon = text.lastIndexOf("::");
  if (doubleColon > 0) {
    const left = text.slice(0, doubleColon);
    const right = text.slice(doubleColon + 2);
    const file = looseRepoPathFromText(left);
    const name = cleanLooseSymbolName(right) || (file ? symbolNameFromPath(file) : null);
    if (!name) return null;
    return { name, ...(file ? { file } : {}) };
  }

  const fileSymbol = text.match(/^(.+\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}):([A-Za-z_$][A-Za-z0-9_$.-]{0,255})$/u);
  if (fileSymbol) {
    const file = normalizeRepoPathCandidate(fileSymbol[1]);
    const name = cleanLooseSymbolName(fileSymbol[2]);
    if (file && name) return { name, file };
  }

  return null;
}

function looseRepoPathFromText(value) {
  const text = stripLooseWrapper(value);
  if (!text) return null;

  const direct = normalizeRepoPathCandidate(text);
  if (direct) return direct;

  const lineSuffix = text.match(/^(.+\.[A-Za-z0-9][A-Za-z0-9._-]{0,15}):\d+(?::\d+)?$/u);
  if (lineSuffix) {
    const withoutLine = normalizeRepoPathCandidate(lineSuffix[1]);
    if (withoutLine) return withoutLine;
  }

  const colon = text.lastIndexOf(":");
  if (colon >= 0 && colon < text.length - 1) {
    const tail = normalizeRepoPathCandidate(text.slice(colon + 1));
    if (tail) return tail;
  }

  return null;
}

function normalizeRepoPathCandidate(value) {
  const text = stripLooseWrapper(value).replace(/\\/g, "/").replace(/^\.\/+/, "").replace(/\/+/g, "/");
  if (!isSafeRepoPath(text) || !looksPathLike(text)) return null;
  return text;
}

function stripLooseWrapper(value) {
  let text = String(value ?? "").trim();
  if (!text) return "";
  if ((text.startsWith("`") && text.endsWith("`"))
    || (text.startsWith('"') && text.endsWith('"'))
    || (text.startsWith("'") && text.endsWith("'"))) {
    text = text.slice(1, -1).trim();
  }
  return text;
}

function isSafeRepoPath(value) {
  const text = String(value || "");
  if (!text || text.includes("\0")) return false;
  if (text.includes(":")) return false;
  if (text.startsWith("/") || /^[A-Za-z]:\//u.test(text)) return false;
  const parts = text.split("/");
  if (parts.length === 0) return false;
  return parts.every((part) => part && part !== "." && part !== "..");
}

function looksPathLike(value) {
  const text = String(value || "");
  const base = text.split("/").pop() || "";
  return text.includes("/") || FILE_EXT_RE.test(base);
}

function symbolNameFromPath(filePath) {
  const base = String(filePath || "").split("/").pop() || "";
  const withoutExt = base.replace(/\.[^.]+$/u, "");
  return cleanLooseSymbolName(withoutExt);
}

function cleanLooseSymbolName(value) {
  const text = String(value || "").trim();
  if (!SYMBOL_NAME_RE.test(text)) return null;
  return text;
}

function collectSymbols(value, out, seen) {
  if (!value || out.length >= RESULT_SYMBOL_LIMIT) return;
  if (Array.isArray(value)) {
    for (const item of value) collectSymbols(item, out, seen);
    return;
  }
  if (typeof value !== "object") return;

  const id = typeof value.symbolId === "string" && isAtlasSymbolId(value.symbolId)
    ? value.symbolId
    : null;
  if (id) addSymbol(out, id, symbolFilePath(value), seen);

  for (const child of Object.values(value)) {
    collectSymbols(child, out, seen);
  }
}

function addSymbol(out, symbolId, filePath, seen) {
  if (!isAtlasSymbolId(symbolId) || seen.has(symbolId)) return;
  seen.add(symbolId);
  out.push({
    symbolId,
    filePath: normalizeRepoPath(filePath),
  });
}

function symbolFilePath(value) {
  const catalogPath = atlasSymbolCardField(value, "filePath");
  if (typeof catalogPath === "string" && catalogPath.trim()) return catalogPath;
  const location = value?.location && typeof value.location === "object" ? value.location : null;
  return location?.repo_rel_path || location?.filePath || value?.filePath || value?.file || null;
}

function normalizeRepoPath(value) {
  const text = String(value || "").trim().replace(/\\/g, "/");
  return text || null;
}
