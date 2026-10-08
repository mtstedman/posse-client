// @ts-check
import { camelToSnakeKey } from "../../../../catalog/field-case.js";
import { SYMBOL_GET_BATCH_POLICY } from "../../../../catalog/symbol-get-batch.js";
import { flattenSharedFileItems } from "../../../atlas/functions/v2/retrieval/symbol-get-batch.js";
import { COMPACT_STRUCTURE_DEFAULT_MAX_FILES } from "../../../atlas/functions/v2/retrieval/compact-presentation.js";
import { ATLAS_TOOL_DEFS_RAW } from "../../../../catalog/atlas-tools.js";

export function researcherAtlasBatchGuidance() {
  return `Run independent, already-needed Atlas tool calls in parallel in the same turn when all arguments are known. Pass each tool its own structured arguments; keep dependent reads sequential. Use a tool's multi-item form only within its declared shared output budget; each item reports its own success or error. After each result, reassess the unresolved evidence gaps. Continue only with a read that can resolve a specific remaining gap. Stop retrieving and hand off when the requested answer is supported; remaining capacity is a safety margin, not a target.`;
}
const EXCLUDED_ACTIONS = new Set([
  "query",
  "code",
  "repo",
  "agent",
  // Compatibility execution remains available, but the canonical traversal
  // route is the only one advertised by this experiment.
  "fetch_ref",
]);

// Marker priority selects the primary language for telemetry. Tool descriptions
// use the same compact contract across languages to keep provider schemas stable.
// Result compaction is transport-only and preserves source, symbol handles,
// warnings, pagination, and non-default diagnostics, so it is language-neutral.
export const RESEARCHER_TYPED_LANGUAGE_LEVERS = Object.freeze({
  php: Object.freeze({
    markers: Object.freeze(["composer.json"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: true,
  }),
  typescript: Object.freeze({
    markers: Object.freeze(["tsconfig.json"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: true,
  }),
  javascript: Object.freeze({
    markers: Object.freeze(["package.json"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: true,
  }),
  python: Object.freeze({
    markers: Object.freeze(["pyproject.toml", "setup.py", "requirements.txt"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: true,
  }),
  rust: Object.freeze({
    markers: Object.freeze(["cargo.toml"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: true,
  }),
  go: Object.freeze({
    markers: Object.freeze(["go.mod"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: true,
  }),
});

export function researcherTypedLanguageLeversForRootEntries(entries = []) {
  const rootEntries = new Set((Array.isArray(entries) ? entries : [])
    .map((entry) => String(entry || "").trim().toLowerCase())
    .filter(Boolean));
  const detectedLanguages = Object.entries(RESEARCHER_TYPED_LANGUAGE_LEVERS)
    .filter(([, levers]) => levers.markers.some((marker) => rootEntries.has(marker)))
    .map(([language]) => language);
  return Object.freeze({
    primaryLanguage: detectedLanguages[0] || "unknown",
    detectedLanguages: Object.freeze(detectedLanguages),
    purposeGuidance: detectedLanguages.some((language) => (
      RESEARCHER_TYPED_LANGUAGE_LEVERS[language].purposeGuidance === true
    )),
    symbolCardGuidance: detectedLanguages.some((language) => (
      RESEARCHER_TYPED_LANGUAGE_LEVERS[language].symbolCardGuidance === true
    )),
    readyCallBatching: detectedLanguages.some((language) => (
      RESEARCHER_TYPED_LANGUAGE_LEVERS[language].readyCallBatching === true
    )),
    resultCompaction: detectedLanguages.some((language) => (
      RESEARCHER_TYPED_LANGUAGE_LEVERS[language].resultCompaction === true
    )),
    anchoredFileWindowMaxTokens: detectedLanguages
      .map((language) => RESEARCHER_TYPED_LANGUAGE_LEVERS[language].anchoredFileWindowMaxTokens)
      .filter((value) => Number.isInteger(value) && value > 0)
      .reduce((minimum, value) => (minimum == null ? value : Math.min(minimum, value)), null),
  });
}

const WORKFLOW_ACTIONS = Object.freeze([
  "traverse_ref",
  "symbol.search",
  "symbol.card",
  "symbol.overview",
  "symbol.callers",
  "symbol.get",
  "code.skeleton",
  "code.survey",
  "code.structure",
  "code.lens",
  "code.window",
  "memory.surface",
  "memory.get",
]);

// Keep the compact union of all typed fields for provider ergonomics, then
// discriminate required selectors at the top level. The owner still performs
// canonical per-action validation, but these branches prevent empty,
// reason-only, and cross-action argument objects from being generated as
// schema-valid atlas.query calls.
const TYPED_ACTION_ARG_REQUIREMENTS = Object.freeze({
  traverse_ref: Object.freeze({ required: Object.freeze(["traversal_ref"]) }),
  "symbol.search": Object.freeze({
    required: Object.freeze(["query"]),
    properties: Object.freeze({ limit: Object.freeze({ maximum: 500 }) }),
  }),
  "symbol.card": Object.freeze({
    anyOf: Object.freeze([
      Object.freeze({ required: Object.freeze(["symbolId"]) }),
      Object.freeze({ required: Object.freeze(["symbolHandle"]) }),
      Object.freeze({ required: Object.freeze(["symbolRef"]) }),
    ]),
  }),
  "symbol.overview": Object.freeze({
    properties: Object.freeze({ limit: Object.freeze({ maximum: 500 }) }),
    anyOf: Object.freeze([
      Object.freeze({ required: Object.freeze(["symbolId"]) }),
      Object.freeze({ required: Object.freeze(["symbolHandle"]) }),
    ]),
  }),
  "symbol.callers": Object.freeze({
    properties: Object.freeze({ limit: Object.freeze({ maximum: 100 }) }),
    anyOf: Object.freeze([
      Object.freeze({ required: Object.freeze(["symbolId"]) }),
      Object.freeze({ required: Object.freeze(["symbolHandle"]) }),
    ]),
  }),
  "symbol.get": Object.freeze({
    anyOf: Object.freeze([
      Object.freeze({ required: Object.freeze(["file", "symbols"]) }),
      Object.freeze({ required: Object.freeze(["items"]) }),
      Object.freeze({ required: Object.freeze(["symbolId"]) }),
      Object.freeze({ required: Object.freeze(["symbolHandle"]) }),
      Object.freeze({ required: Object.freeze(["symbolRef"]) }),
    ]),
  }),
  "code.skeleton": Object.freeze({
    properties: Object.freeze({ limit: Object.freeze({ maximum: 5000 }) }),
    anyOf: Object.freeze([
      Object.freeze({ required: Object.freeze(["symbolId"]) }),
      Object.freeze({ required: Object.freeze(["symbolHandle"]) }),
      Object.freeze({ required: Object.freeze(["file"]) }),
      Object.freeze({ required: Object.freeze(["path"]) }),
    ]),
  }),
  "code.survey": Object.freeze({
    required: Object.freeze(["paths"]),
    properties: Object.freeze({
      limit: Object.freeze({ maximum: 64 }),
      identifiersToFind: Object.freeze({ maxItems: 16 }),
      paths: Object.freeze({ maxItems: 64 }),
    }),
  }),
  "code.structure": Object.freeze({
    required: Object.freeze(["paths"]),
    properties: Object.freeze({ limit: Object.freeze({ maximum: 128,
      description: `Maximum files to inventory; default ${COMPACT_STRUCTURE_DEFAULT_MAX_FILES}.`,
    }) }),
  }),
  "code.lens": Object.freeze({
    required: Object.freeze(["identifiersToFind"]),
    anyOf: Object.freeze([
      Object.freeze({ required: Object.freeze(["symbolId"]) }),
      Object.freeze({ required: Object.freeze(["symbolHandle"]) }),
      Object.freeze({ required: Object.freeze(["file"]) }),
      Object.freeze({ required: Object.freeze(["path"]) }),
    ]),
  }),
  "code.window": Object.freeze({
    required: Object.freeze(["identifiersToFind"]),
    anyOf: Object.freeze([
      Object.freeze({ required: Object.freeze(["file"]) }),
      Object.freeze({ required: Object.freeze(["path"]) }),
    ]),
  }),
  "memory.surface": Object.freeze({}),
  "memory.get": Object.freeze({}),
});

const WORKFLOW_ARG_FIELDS = new Set([
  "autoFill",
  "contextLines",
  "domains",
  "edgeKinds",
  "exportedOnly",
  "file",
  "path",
  "fileRelPaths",
  "granularity",
  "identifiersToFind",
  "includeEdges",
  "includeSymbols",
  "includeUnresolved",
  "kind",
  "limit",
  "maxFiles",
  "maxLines",
  "maxTokens",
  "minConfidence",
  "mode",
  "offset",
  "paths",
  "query",
  "reaccessAuthorization",
  "reason",
  "scope",
  "search",
  "searchMode",
  "search_mode",
  "semantic",
  "surveyGap",
  "symbolId",
  "symbolHandle",
  "symbolIds",
  "items",
  "symbolRef",
  "symbols",
  "traversal_ref",
]);

function researcherActionArgsSchema({ allowSymbolHandles = false } = {}) {
  const symbolId = {
    type: "string",
    pattern: allowSymbolHandles
      ? "^(?:[0-9a-f]{64}:[0-9]+|s[1-9][0-9]{0,5})$"
      : "^[0-9a-f]{64}:[0-9]+$",
  };
  const stringArray = { type: "array", items: { type: "string" }, maxItems: 100 };
  const symbolRefItem = {
    type: "object",
    properties: {
      name: { type: "string", minLength: 1 },
      file: { type: "string", minLength: 1 },
      path: { type: "string", minLength: 1 },
      kind: { type: "string", minLength: 1 },
      exportedOnly: { type: "boolean" },
    },
    required: ["name"],
    additionalProperties: false,
  };
  const properties = {
    symbols: { type: "array", minItems: 1, maxItems: SYMBOL_GET_BATCH_POLICY.maxItems,
      items: { type: "string", minLength: 1 },
      description: "Exact names or qualified names sharing file for symbol.get." },
    items: {type: "array", minItems: 1, maxItems: SYMBOL_GET_BATCH_POLICY.maxItems,
      items: {type: "object", properties: {
        symbolId, symbolRef: symbolRefItem, file: {type: "string"}, path: {type: "string"},
        identifiersToFind: {type: "array", items: {type: "string"}, maxItems: 50},
        maxTokens: {type: "integer", minimum: 1, maximum: SYMBOL_GET_BATCH_POLICY.maxTokensPerSymbol},
      }, anyOf: [{required: ["symbolId"]}, {required: ["symbolRef"]}], additionalProperties: false}},
    query: { type: "string", minLength: 1 },
    scope: { type: "string", enum: ["name", "body", "either"] },
    limit: { type: "integer", minimum: 1, maximum: 20000 },
    offset: { type: "integer", minimum: 0 },
    semantic: { type: "boolean" },
    symbolId,
    symbolHandle: {
      type: "string",
      pattern: "^s[1-9][0-9]{0,5}$",
      description: "Compatibility alias for a returned short symbolId; prefer symbolId.",
    },
    symbolIds: { ...stringArray, items: symbolId },
    symbolRef: symbolRefItem,
    kind: { type: "array", items: { type: "string", enum: ["calls", "references", "reads", "writes", "uses_type", "imports", "extends", "implements"] }, maxItems: 20 },
    minConfidence: { type: "number", minimum: 0, maximum: 100 },
    mode: { type: "string", enum: ["caller", "reference", "all"] },
    minCallConfidence: { type: "number", minimum: 0, maximum: 1 },
    includeUnresolved: { type: "boolean" },
    includeResolutionMetadata: { type: "boolean" },
    file: { type: "string", minLength: 1, description: "Existing repository-relative path already surfaced by Atlas; never guess a dependency file." },
    path: { type: "string", minLength: 1, description: "Alias for file, as surfaced in Atlas results." },
    paths: { type: ["string", "array"], minLength: 1, items: { type: "string", minLength: 1 }, maxItems: 128 },
    identifiersToFind: {
      type: "array",
      minItems: 1,
      items: { type: "string", minLength: 1 },
      maxItems: 50,
      description: "One or more non-empty exact identifiers in the selected file. Omit an unanchored read instead of inserting an empty string.",
    },
    reason: { type: "string", minLength: 1 },
    autoFill: { type: "boolean", description: "Keep partially new code.window excerpts contiguous across dedupe gaps. Default true; false keeps sparse output. Does not expand the selection." },
    granularity: {
      type: "string",
      enum: ["symbol", "block", "fileWindow"],
      description: "symbol selects declaration bodies, block selects enclosing control flow, and fileWindow returns a coherent source region in the file.",
    },
    contextLines: { type: "integer", minimum: 0, maximum: 200000, description: "Requested surrounding lines; values above 8 are clamped to 8." },
    maxTokens: { type: "integer", minimum: 1, maximum: 200000 },
    exportedOnly: { type: "boolean" },
    surveyGap: { type: "string", minLength: 3 },
    edgeKinds: { type: "array", items: { type: "string", enum: ["imports", "calls", "references", "extends", "implements", "uses_type"] }, maxItems: 6 },
    includeEdges: { type: "boolean" },
    includeSymbols: { type: "boolean" },
    traversal_ref: { type: ["string", "array"], items: { type: "string" }, maxItems: 100 },
    traversal_refs: stringArray,
    ref: { type: ["string", "array"], items: { type: "string" }, maxItems: 100 },
    refs: stringArray,
    hashes: stringArray,
    search: { type: "string" },
    searchMode: { type: "string", enum: ["auto", "literal", "regex"] },
    reaccessAuthorization: { type: "string", minLength: 16 },
    domains: { type: "array", items: { type: "string", enum: ["general", "ux", "schema", "security", "performance"] }, maxItems: 5 },
    memoryId: { type: "string", minLength: 1 },
    verdict: { type: "string", enum: ["used", "stale", "wrong", "duplicate"] },
    detail: { type: "string" },
    text: { type: "string", minLength: 1 },
    source_ref: { type: "string" },
    lines: { type: "string" },
    note: { type: "string" },
    object_type: { type: "string" },
    owner_scope: { type: "string", enum: ["work_item", "job"] },
  };
  return {
    type: "object",
    properties,
    additionalProperties: false,
  };
}

/**
 * @param {{ allowSymbolHandles?: boolean, includeWindowReason?: boolean, actions?: string[] }} [options]
 */
function researcherReadActionArgsSchema(options = {}) {
  const includeWindowReason = options.includeWindowReason !== false;
  const includeLegacyRelationshipConfidence = Array.isArray(options.actions)
    && options.actions.includes("symbol.overview");
  const actionArgs = researcherActionArgsSchema({
    allowSymbolHandles: options.allowSymbolHandles === true,
  });
  const readProperties = Object.fromEntries(Object.entries(actionArgs.properties)
    .filter(([name]) => WORKFLOW_ARG_FIELDS.has(name)
      && (includeWindowReason || name !== "reason")
      && (includeLegacyRelationshipConfidence || name !== "minConfidence")));
  return {
    type: "object",
    properties: readProperties,
    additionalProperties: false,
  };
}

// One mapping drives both the advertised direct fields and execution on either
// surface. Native names remain compatibility inputs, not a second agent API.
// The agent surface advertises snake_case argument names, matching the result
// keys it reads back. Execution keeps the native contract, so every advertised
// name maps home here and the camelCase spelling stays accepted.
function advertisedArgName(name) {
  return camelToSnakeKey(name);
}

// Nested selectors (symbol_ref, symbol.get items) advertise the same way.
function advertisedNestedSchema(definition) {
  if (!definition || typeof definition !== "object" || Array.isArray(definition)) return definition;
  const nested = { ...definition };
  if (nested.properties && typeof nested.properties === "object") {
    nested.properties = Object.fromEntries(Object.entries(nested.properties)
      .map(([name, child]) => [advertisedArgName(name), advertisedNestedSchema(child)]));
  }
  if (Array.isArray(nested.required)) nested.required = nested.required.map(advertisedArgName);
  if (Array.isArray(nested.anyOf)) {
    nested.anyOf = nested.anyOf.map((entry) => (entry?.required
      ? { ...entry, required: entry.required.map(advertisedArgName) }
      : advertisedNestedSchema(entry)));
  }
  if (nested.items) nested.items = advertisedNestedSchema(nested.items);
  return nested;
}

export function advertisedArgNameMap() {
  const properties = researcherActionArgsSchema().properties;
  const map = new Map();
  for (const name of Object.keys(properties)) {
    const advertised = advertisedArgName(name);
    // A field whose snake spelling is already an accepted argument name
    // (searchMode beside the native search_mode) keeps both names: renaming
    // would erase the native one and hide a conflict between the spellings.
    if (advertised === name || Object.hasOwn(properties, advertised)
      || WORKFLOW_ARG_FIELDS.has(advertised)) continue;
    map.set(advertised, name);
  }
  return map;
}

function advertisedSchema(schema = {}) {
  const source = schema.properties || {};
  const properties = Object.fromEntries(Object.entries(source)
    .map(([name, definition]) => [
      Object.hasOwn(source, advertisedArgName(name)) ? name : advertisedArgName(name),
      advertisedNestedSchema(definition),
    ]));
  const mapNames = (names) => (Array.isArray(names) ? names.map(advertisedArgName) : names);
  return {
    ...schema,
    properties,
    ...(schema.required ? { required: mapNames(schema.required) } : {}),
    ...(Array.isArray(schema.anyOf)
      ? { anyOf: schema.anyOf.map((entry) => (entry?.required ? { ...entry, required: mapNames(entry.required) } : entry)) }
      : {}),
  };
}

// Advertised snake_case names resolve to the native contract before anything
// else runs; a native name that is already snake (traversal_ref) is untouched
// because it never appears in the map.
const ADVERTISED_TO_NATIVE = advertisedArgNameMap();
const ADVERTISED_TEXT_PAIRS = [...ADVERTISED_TO_NATIVE]
  .sort(([, left], [, right]) => right.length - left.length);

// Cards name arguments the way the schema advertises them, so the prose and
// the callable fields never disagree.
export function advertiseCardText(text) {
  let rendered = String(text || "");
  for (const [advertised, native] of ADVERTISED_TEXT_PAIRS) {
    rendered = rendered.replace(new RegExp(`\\b${native}\\b`, "g"), advertised);
  }
  return rendered;
}
function nativeArgNames(value) {
  if (Array.isArray(value)) return value.map(nativeArgNames);
  if (!value || typeof value !== "object") return value;
  const out = {};
  for (const [key, child] of Object.entries(value)) {
    out[ADVERTISED_TO_NATIVE.get(key) || key] = nativeArgNames(child);
  }
  return out;
}

function researcherActionFieldAliases(action) {
  if (action === "traverse_ref") return { searchMode: "search_mode" };
  if (action === "code.survey") return { identifiersToFind: "symbols", limit: "maxFiles" };
  if (action === "code.structure") return { limit: "maxFiles" };
  if (action === "code.skeleton") return { limit: "maxLines" };
  if (["memory.surface", "memory.get"].includes(action)) return { paths: "fileRelPaths" };
  return {};
}

/**
 * Translate the typed facade's canonical field names to the version-coupled
 * native action contract. Legacy facade names remain accepted for one release,
 * but only canonical names are advertised by the typed schema and cards.
 *
 * @param {string} action
 * @param {Record<string, any>} args
 * @returns {{ args: Record<string, any>, aliases: Array<{from: string, to: string, requested?: number, applied?: number, normalization?: string}>, error?: string }}
 */
export function normalizeResearcherTypedActionArgs(action, args = {}) {
  const normalized = nativeArgNames({ ...args });
  const aliases = [];
  if (action === "symbol.get" && Array.isArray(normalized.items)) {
    normalized.items = flattenSharedFileItems(normalized.items);
    const selected = normalized.items.slice(0, SYMBOL_GET_BATCH_POLICY.maxItems);
    if (selected.some(item => !item || typeof item !== "object" || item.items != null || item.symbols != null)) {
      return {args: normalized, aliases, error: "symbol.get batch items must be scalar selectors"};
    }
    const children = selected.map(item => normalizeResearcherTypedActionArgs(action, item));
    const invalid = children.find(child => child.error);
    if (invalid) return {args: normalized, aliases, error: invalid.error};
    // Preserve the excluded tail for the batch result notice, without resolving it.
    normalized.items = [...children.map(child => child.args), ...normalized.items.slice(SYMBOL_GET_BATCH_POLICY.maxItems)];
  }
  const move = (from, to) => {
    if (!Object.prototype.hasOwnProperty.call(normalized, from)) return null;
    if (Object.prototype.hasOwnProperty.call(normalized, to)) {
      if (JSON.stringify(normalized[from]) !== JSON.stringify(normalized[to])) {
        return `Typed Atlas fields ${from} and ${to} conflict`;
      }
      delete normalized[from];
      aliases.push({ from, to });
      return null;
    }
    normalized[to] = normalized[from];
    delete normalized[from];
    aliases.push({ from, to });
    return null;
  };
  let error = move("symbolHandle", "symbolId");
  if (!error) error = move("path", "file");
  if (!error && normalized.symbolRef && typeof normalized.symbolRef === "object"
    && !Array.isArray(normalized.symbolRef) && Object.hasOwn(normalized.symbolRef, "path")) {
    const { path, ...selector } = normalized.symbolRef;
    if (Object.hasOwn(selector, "file") && selector.file !== path) {
      error = "Typed Atlas fields symbolRef.path and symbolRef.file conflict";
    } else {
      normalized.symbolRef = { ...selector, file: path };
      aliases.push({ from: "symbolRef.path", to: "symbolRef.file" });
    }
  }
  for (const [from, to] of Object.entries(researcherActionFieldAliases(action))) {
    if (!error) error = move(from, to);
  }
  if (!error && ["memory.surface", "memory.get"].includes(action)
    && typeof normalized.fileRelPaths === "string") normalized.fileRelPaths = [normalized.fileRelPaths];
  if (!error && action === "code.lens" && Number.isInteger(normalized.contextLines) && normalized.contextLines > 8) {
    const requested = normalized.contextLines;
    normalized.contextLines = 8;
    aliases.push({ from: "contextLines", to: "contextLines", requested, applied: 8, normalization: "clamp" });
  }
  return { args: normalized, aliases, ...(error ? { error } : {}) };
}

function atlasActionName(name = "") {
  const raw = String(name || "").trim();
  return raw.startsWith("atlas.") ? raw.slice("atlas.".length) : raw;
}

function dispatcherActions(atlasTools = []) {
  const actions = [];
  for (const tool of Array.isArray(atlasTools) ? atlasTools : []) {
    const action = atlasActionName(tool?.name);
    if (!action || EXCLUDED_ACTIONS.has(action) || !WORKFLOW_ACTIONS.includes(action)) continue;
    if (!actions.includes(action)) actions.push(action);
  }
  return actions;
}

// Direct tools share canonical descriptions, parameter definitions, selector
// requirements and normalization with the researcher argument repair.
export function buildResearcherDirectTools(atlasTools = [], _options = {}) {
  const surfaced = dispatcherActions(atlasTools);
  const actions = WORKFLOW_ACTIONS.filter(action => surfaced.includes(action));
  const shared = researcherReadActionArgsSchema({ allowSymbolHandles: true, includeWindowReason: false, actions });
  return actions.map(action => {
    const canonicalFields = Object.keys(ATLAS_TOOL_DEFS_RAW[action]?.parameters?.properties || {});
    const advertisedNames = Object.fromEntries(Object.entries(researcherActionFieldAliases(action))
      .map(([advertised, native]) => [native, advertised]));
    const fields = new Set(canonicalFields.map(field => advertisedNames[field] || field));
    if (fields.has("symbolId")) fields.add("symbolHandle");
    if (fields.has("file")) fields.add("path");
    const requirements = TYPED_ACTION_ARG_REQUIREMENTS[action] || {};
    const fieldAliases = researcherActionFieldAliases(action);
    const describe = (text) => {
      let result = String(text || "");
      for (const [native, advertised] of Object.entries(advertisedNames)) {
        result = result.replace(new RegExp(`\\b${native}\\b`, "g"), advertised);
      }
      return advertiseCardText(result);
    };
    const properties = Object.fromEntries(Object.entries(shared.properties)
      .filter(([field]) => fields.has(field))
      .map(([field, definition]) => {
        const canonical = ATLAS_TOOL_DEFS_RAW[action]?.parameters?.properties?.[fieldAliases[field] || field];
        const description = requirements.properties?.[field]?.description || canonical?.description || ("description" in definition ? definition.description : undefined);
        return [field, { ...definition, ...requirements.properties?.[field],
          ...(description ? { description: describe(description) } : {}),
        }];
      }));
    const original = atlasTools.find(tool => atlasActionName(tool?.name) === action);
    return {
      ...original,
      name: `atlas.${action}`,
      description: describe(ATLAS_TOOL_DEFS_RAW[action].description),
      inputSchema: advertisedSchema({ ...shared, ...requirements, properties }),
    };
  });
}

/**
 * The action enum the dispatcher tool advertises for a given allowlist, using
 * the same filters as the tool builders. Used by the owner's nested-action
 * error boundary so a rejection only ever suggests actions the model was
 * actually issued.
 *
 * @param {Iterable<string>} actionNames
 * @param {{ typed?: boolean }} [options]
 */
export function researcherDispatcherIssuedActions(actionNames, { typed = false } = {}) {
  const surfaced = dispatcherActions([...actionNames].map((name) => ({ name: `atlas.${String(name || "")}` })));
  return typed
    ? WORKFLOW_ACTIONS.filter((action) => surfaced.includes(action))
    : surfaced;
}

export function researcherWorkflowActions() {
  return [...WORKFLOW_ACTIONS];
}

const TYPED_SEARCH_DISCOVERY_FIELDS = Object.freeze([
  "pattern",
  "path",
  "include",
  "case_insensitive",
  "literal",
  "output_mode",
  "context",
  "head_limit",
  "offset",
]);

export function applyResearcherTypedNativeToolShape(tool = {}, { direct = false } = {}) {
  if (String(tool?.name || "") !== "tools.search_files") return tool;
  const inputSchema = tool?.inputSchema && typeof tool.inputSchema === "object"
    && !Array.isArray(tool.inputSchema)
    ? tool.inputSchema
    : {};
  const sourceProperties = inputSchema?.properties && typeof inputSchema.properties === "object"
    && !Array.isArray(inputSchema.properties)
    ? inputSchema.properties
    : {};
  const properties = Object.fromEntries(TYPED_SEARCH_DISCOVERY_FIELDS
    .filter((field) => Object.prototype.hasOwnProperty.call(sourceProperties, field))
    .map((field) => [field, { ...sourceProperties[field] }]));
  if (properties.context) {
    properties.context.maximum = 1;
    properties.context.description = "Return at most one neighboring line before and after each matching line.";
  }
  if (properties.head_limit) properties.head_limit.maximum = 500;
  return {
    ...tool,
    description:
      `Locate bounded matching lines, files, or counts with ripgrep. Content mode returns the matching line plus at most one neighboring line; use ${direct ? "atlas.code.window" : "atlas.query action code.window"} for the exact body of an identified implementation target.`,
    inputSchema: {
      ...inputSchema,
      type: "object",
      properties,
      required: ["pattern"],
      additionalProperties: false,
    },
  };
}
