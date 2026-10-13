import { atlasDescriptorSchemaForAction } from "../../../domains/atlas/functions/v2/contracts/tool-schemas.js";
import { SYMBOL_GET_BATCH_POLICY } from "../../../catalog/symbol-get-batch.js";
import { symbolMatchesRequestedIdentifier } from "../../../domains/atlas/functions/v2/retrieval/identifier-resolution.js";

/**
 * Clamp a count argument that exceeds its advertised ceiling instead of
 * rejecting the call. Asking for more of the same result is not an invalid
 * request: rejecting it costs the caller a whole retrieval call and returns
 * nothing, while maxTokens has always clamped. Selectors, identifiers, and
 * every non-numeric argument stay strict.
 *
 * @param {string} action
 * @param {Record<string, any>} toolArgs
 * @returns {{ args: Record<string, any>, clamps: Array<{field: string, requested: number, applied: number}> }}
 */
export function clampAtlasArgumentCeilings(action, toolArgs) {
  const clamps = [];
  const schema = action ? atlasDescriptorSchemaForAction(action) : null;
  const properties = schema?.properties;
  if (!properties || !toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
    return { args: toolArgs, clamps };
  }
  const nested = toolArgs.args && typeof toolArgs.args === "object" && !Array.isArray(toolArgs.args);
  const source = nested ? toolArgs.args : toolArgs;
  const clamped = { ...source };
  for (const [field, definition] of Object.entries(properties)) {
    const ceiling = definition?.maximum;
    const value = clamped[field];
    if (typeof ceiling !== "number" || typeof value !== "number" || !Number.isFinite(value)) continue;
    if (value <= ceiling) continue;
    clamped[field] = ceiling;
    clamps.push({ field, requested: value, applied: ceiling });
  }
  // A blank identifier ("" beside real names) failed the whole call as
  // invalid_params; it names nothing, so it is dropped instead.
  for (const field of IDENTIFIER_FILTER_FIELDS) {
    const value = clamped[field];
    if (!Array.isArray(value)) continue;
    const kept = value.filter((entry) => typeof entry !== "string" || entry.trim() !== "");
    if (kept.length === value.length) continue;
    if (kept.length > 0) clamped[field] = kept;
    else delete clamped[field];
    clamps.push({ field, dropped: value.length - kept.length });
  }
  if (clamps.length === 0) return { args: toolArgs, clamps };
  return { args: nested ? { ...toolArgs, args: clamped } : clamped, clamps };
}

export const __testClampAtlasArgumentCeilings = clampAtlasArgumentCeilings;

export const __testSameFileAmbiguityBatchItems = sameFileAmbiguityBatchItems;

export const __testEmptyIdentifierFilterRecovery = emptyIdentifierFilterRecovery;

/**
 * Batch items recovering an ambiguity whose bearers all live in the file the
 * caller named. Returns null when the error is a different one, when no file
 * was named, or when a bearer sits outside it.
 *
 * @param {any} result
 * @param {Record<string, any>} toolArgs
 * @returns {Array<{symbolId: string, file: string}> | null}
 */
export const IDENTIFIER_FILTER_FIELDS = ["identifiersToFind", "identifiers_to_find", "symbols"];

/**
 * Identifiers a narrowed outline or survey filtered everything away with.
 * Returns null when the result carried content, or when nothing was narrowed.
 *
 * @param {string} action
 * @param {any} result
 * @param {Record<string, any>} toolArgs
 * @returns {string[] | null}
 */
export function emptyIdentifierFilterRecovery(action, result, toolArgs) {
  if (!result || result.isError === true) return null;
  const requested = [];
  for (const field of IDENTIFIER_FILTER_FIELDS) {
    const value = toolArgs?.[field];
    if (Array.isArray(value)) requested.push(...value.map((entry) => String(entry || "").trim()).filter(Boolean));
    else if (typeof value === "string" && value.trim()) requested.push(value.trim());
  }
  if (requested.length === 0) return null;
  const first = Array.isArray(result.content) ? result.content[0] : null;
  if (!first || first.type !== "text" || typeof first.text !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(first.text.split("\n\n")[0]);
  } catch {
    return null;
  }
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  if (!data || typeof data !== "object") return null;
  if (action === "code.skeleton") {
    const rows = Array.isArray(result.content) && result.content.length > 1
      ? String(result.content[1]?.text || "")
      : String(data.content || "");
    return rows.trim() ? null : [...new Set(requested)];
  }
  const files = Array.isArray(data.files) ? data.files : null;
  if (files === null || files.length > 0) return null;
  return [...new Set(requested)];
}

export function sameFileAmbiguityBatchItems(result, toolArgs) {
  if (result?.isError !== true) return null;
  const error = result?.structuredContent?.error || result?._meta?.atlasError;
  if (String(error?.code || "") !== "ambiguous_symbol") return null;
  const requestedFile = String(
    toolArgs?.file || toolArgs?.path || toolArgs?.symbolRef?.file || toolArgs?.symbolRef?.path || "",
  ).trim();
  const candidates = error?.details?.candidates;
  if (!Array.isArray(candidates) || candidates.length < 2) return null;
  if (candidates.length > SYMBOL_GET_BATCH_POLICY.maxItems) return null;
  // An owner-qualified name whose owner matched nothing falls back to every
  // bearer of its bare member. Those are other owners' declarations, not the
  // one requested, so they stay a candidate list instead of returned bodies.
  const requestedName = String(toolArgs?.symbolRef?.name || toolArgs?.symbol_ref?.name || "").trim();
  if (/::|[.#]/u.test(requestedName) && candidates.some((candidate) => !symbolMatchesRequestedIdentifier(
    { name: candidate?.name, qualified_name: candidate?.name }, requestedName, { traitImplAlias: true },
  ))) return null;
  const items = [];
  const candidateFile = requestedFile || String(candidates[0]?.file || "").trim();
  if (!candidateFile) return null;
  for (const candidate of candidates) {
    const symbolId = String(candidate?.symbolId || candidate?.symbol_id || "").trim();
    if (!symbolId || String(candidate?.file || "") !== candidateFile) return null;
    items.push({ symbolId, file: candidateFile });
  }
  return items;
}

// A name-scope search for one exact identifier is a locator: the caller wants
// that declaration. Atlas538 PY_HTTPX_3 spent 7 of 28 calls on searches that
// returned one ~230-char location it then fetched with a second call, and 5
// on guessed test names that returned nothing.
const EXACT_NAME_QUERY = /^[A-Za-z_$][A-Za-z0-9_$.:#-]*$/u;

const NEAREST_NAME_LIMIT = 5;

export function exactNameSearchQuery(toolArgs) {
  if (String(toolArgs?.scope || "").trim().toLowerCase() !== "name") return null;
  if (toolArgs?.semantic === true) return null;
  const query = String(toolArgs?.query || "").trim();
  return EXACT_NAME_QUERY.test(query) ? query : null;
}

export function searchResultItems(result) {
  if (!result || result.isError === true) return null;
  const first = Array.isArray(result.content) ? result.content[0] : null;
  if (!first || first.type !== "text" || typeof first.text !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(first.text.split("\n\n")[0]);
  } catch {
    return null;
  }
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  return Array.isArray(data?.items) ? data.items : null;
}

// The unique-hit shortcut saves a call when the body is what the locator was
// looking for. A large declaration (a whole class, or a long function) is not:
// fetching it put 16-24k characters into context that every later turn re-read
// (ASK-30: HTTPAdapter 500 lines, Response, executeEndpoint). Above this span the
// search hit itself is returned so the caller reads only what it needs.
const EXACT_NAME_BODY_MAX_LINES = 120;

function searchItemLineSpan(item) {
  const compact = /:(\d+(?:-\d+)?)$/u.exec(String(item?.at || ""));
  const lines = item?.location?.lines ?? item?.lines ?? compact?.[1];
  const match = /^(\d+)(?:-(\d+))?$/u.exec(String(Array.isArray(lines) ? lines.join("-") : lines ?? "").trim());
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2] ?? match[1]);
  return end >= start ? { start, end, count: end - start + 1 } : null;
}

/**
 * The one declaration an exact name-scope search found, as a symbol.get item.
 * Returns null unless the search matched exactly one addressable symbol.
 */
export function exactNameSearchTarget(result, toolArgs) {
  if (!exactNameSearchQuery(toolArgs)) return null;
  const items = searchResultItems(result);
  if (!items || items.length !== 1) return null;
  const item = items[0] || {};
  const symbolId = String(item.symbolId || item.symbol_id || item.symbolHandle || "").trim();
  if (!symbolId) return null;
  const file = String(item.location?.path || item.path || item.file || item.repo_rel_path
    || String(item.at || "").replace(/:\d+(?:-\d+)?$/u, "") || "").trim();
  const span = searchItemLineSpan(item);
  if (span && span.count > EXACT_NAME_BODY_MAX_LINES) {
    return { oversized: true, kind: String(item.kind || "declaration"), span };
  }
  return { symbolId, ...(file ? { file } : {}) };
}

/** The directory a code.lens call named when it failed as not_a_file, else null. */
export function lensDirectoryTarget(result, toolArgs) {
  if (!result || result.isError !== true) return null;
  const file = String(toolArgs?.file || toolArgs?.path || "").trim().replace(/\/+$/u, "");
  if (!file) return null;
  const text = (Array.isArray(result.content) ? result.content : [])
    .map((part) => (typeof part?.text === "string" ? part.text : "")).join("\n");
  // Native lens words it "the path is not a regular file"; in a repository that
  // is a directory, and a survey that fails keeps the original error anyway.
  return /"code"\s*:\s*"not_a_file"|\bnot_a_file\b/u.test(text) ? file : null;
}

export const __testLensDirectoryTarget = lensDirectoryTarget;

/** Arguments for a near-name search after an exact name matched nothing. */
export function nearestNameSearchArgs(result, toolArgs) {
  const query = exactNameSearchQuery(toolArgs);
  if (!query) return null;
  const items = searchResultItems(result);
  if (!items || items.length !== 0) return null;
  return { query, scope: "either", semantic: true, limit: NEAREST_NAME_LIMIT };
}

// A wrapper call may name its nested action under any key nestedAtlasAction
// reads; rewrite every key present so the first one read agrees.
export function withNestedAtlasAction(toolArgs, action) {
  const keys = ["gatewayAction", "targetAction", "actionName", "action"].filter((key) => toolArgs?.[key] != null);
  const next = { ...toolArgs };
  for (const key of keys.length > 0 ? keys : ["action"]) next[key] = action;
  return next;
}

export const __testExactNameSearchTarget = exactNameSearchTarget;

export const __testNearestNameSearchArgs = nearestNameSearchArgs;
