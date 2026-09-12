// @ts-check

const DISPATCHER_TOOL_NAME = "atlas.query";
// Three transformed direct results remain below the Codex MCP client's 48K
// result clip under the existing per-action paging caps. A larger workflow can
// be token-cheaper yet silently discard evidence at the client boundary.
const WORKFLOW_MAX_STEPS = 3;
const EXCLUDED_ACTIONS = new Set([
  "query",
  "code",
  "repo",
  "agent",
  // Compatibility execution remains available, but the canonical traversal
  // route is the only one advertised by this experiment.
  "fetch_ref",
]);

const ACTION_CARDS = Object.freeze({
  traverse_ref: "requires traversal_ref; reaccessAuthorization is valid only with one scalar traversal_ref; fields traversal_ref,limit,offset,search,searchMode,reaccessAuthorization",
  create_ref: "fields text or source_ref+lines/offset/limit or chunks, plus object_type,note,owner_scope",
  "symbol.search": "requires query; for a known exact name call symbol.get with symbolRef{name,file?,kind?} directly; search only an unknown, ambiguous, or missed target, using scope=name, semantic=false, and limit at most 10 for an exact name; never repeat case or scope variants after a usable hit; a hit is an address, not a source body; batch independent searches and reuse returned IDs; fields query,scope,limit,semantic",
  "symbol.card": "requires symbolId or symbolRef; fields symbolId,symbolRef",
  "symbol.callers": "requires symbolId; list compact incoming caller or reference symbols grouped by file; fields symbolId,mode,limit,offset",
  "symbol.get": "requires symbolId or symbolRef; use symbolRef{name,file?,kind?} directly for a known exact name without symbol.search; search only if unknown or ambiguous; fields symbolId,symbolHandle,symbolRef,file,identifiersToFind,maxTokens",
  "symbol.overview": "requires symbolId; fields symbolId,kind,minConfidence,limit,includeUnresolved",
  "code.skeleton": "fields file or symbolId,identifiersToFind,exportedOnly,limit,maxTokens,surveyGap",
  "code.survey": "requires paths; fields paths,identifiersToFind,limit",
  "code.structure": "requires paths; exact inventory of one small directory or file set (default 12 files) with stable symbol handles, or an explicit relationship query when edgeKinds such as implements, extends, calls, or imports are supplied; imports is the default edge kind; use code.survey for a ranked preview across a wider file set; fields paths,edgeKinds,includeEdges,includeSymbols,limit",
  "code.lens": "requires identifiersToFind and either symbolId or file; fields symbolId,file,identifiersToFind,contextLines",
  "code.window": "requires reason+symbolId or reason+file+identifiersToFind; prefer symbol granularity for a declared implementation anchor; use fileWindow only for surrounding same-file control flow; fields symbolId,file,reason,identifiersToFind,granularity,maxTokens",
  "memory.feedback": "requires memoryId,verdict; fields memoryId,verdict,detail",
  "memory.surface": "fields domains,paths,symbolIds",
  "memory.get": "fields domains,paths,symbolIds",
});

// The typed dispatcher removes each direct tool's purpose description as well
// as its name. Restore that task-blind selection signal while keeping the one-
// tool, closed-argument surface and canonical execution path unchanged.
const TYPED_ACTION_CARDS = Object.freeze({
  traverse_ref: "requires traversal_ref; retrieve only content omitted behind an explicit traversal_ref or nextTraversalRef, batching every independently needed ref; reaccessAuthorization is valid only with one scalar traversal_ref; fields traversal_ref,limit,offset,search,searchMode,reaccessAuthorization",
  "symbol.search": "requires query; for a known exact name call symbol.get with symbolRef{name,file?,kind?} directly; search only an unknown, ambiguous, or missed target, using scope=name, semantic=false, and limit at most 10 for an exact name; never repeat case or scope variants after a usable hit; a hit is an address, not a source body; batch independent searches, then reuse returned IDs; fields query,scope,limit,semantic",
  "symbol.card": "requires symbolId or symbolRef; get a compact relationship summary for one or several identified symbols; fields symbolId,symbolRef",
  "symbol.callers": "requires symbolId; list compact incoming resolved callers, references, or both by file, then use symbol.get on a returned ID; fields symbolId,mode,limit,offset",
  "symbol.get": "requires symbolId or symbolRef; use symbolRef{name,file?,kind?} directly for a known exact name without symbol.search; search only if unknown or ambiguous; fields symbolId,symbolHandle,symbolRef,file,identifiersToFind,maxTokens",
  "symbol.overview": "requires symbolId; inspect concrete call and reference sites when relationships are the missing fact; fields symbolId,kind,minConfidence,limit,includeUnresolved",
  "code.skeleton": "orient within one known file or symbol using a compact body-free outline before exact source; fields file or symbolId,identifiersToFind,exportedOnly,limit,maxTokens,surveyGap",
  "code.survey": "requires paths; use when the exact target is unknown or behavior spans files, returning a ranked multi-file symbol preview and call map; fields paths,identifiersToFind,limit",
  "code.structure": "requires paths; read the exact inventory of one small directory or file set (default 12 files, paged beyond that) with stable symbol handles, or answer who-implements, who-extends, who-calls, or who-imports inside it in one call by naming edgeKinds explicitly (imports is the default; without edges it is a symbol list, not a relationship proof); use code.survey for a ranked preview across a wider file set; fields paths,edgeKinds,includeEdges,includeSymbols,limit",
  "code.lens": "requires identifiersToFind and either symbolId or file; use when relevant identifiers or branches are scattered in one known target, batching all known same-target identifiers; fields symbolId,file,identifiersToFind,contextLines",
  "code.window": "requires file+identifiersToFind; prefer symbol granularity for a declared implementation anchor; use fileWindow only for surrounding same-file control flow; the facade supplies reason; fields file,identifiersToFind,granularity,maxTokens",
  "memory.surface": "probe memory presence for exact file or symbol anchors without returning bodies; fields domains,paths,symbolIds",
  "memory.get": "retrieve memory bodies for exact file or symbol anchors; fields domains,paths,symbolIds",
});

// Keep the terse language arm terse, but state the one action boundary that
// repeatedly caused otherwise avoidable validation/retry turns. This remains
// prompt pressure: native validation still rejects every malformed window.
const TYPED_TERSE_ACTION_CARDS = Object.freeze({
  ...ACTION_CARDS,
  "symbol.get": "requires symbolId or symbolRef; use symbolRef{name,file?,kind?} directly for a known exact name without symbol.search; search only if unknown or ambiguous; fields symbolId,symbolHandle,symbolRef,file,identifiersToFind,maxTokens",
  "code.window": "requires file+identifiersToFind; prefer symbol granularity for a declared implementation anchor; use fileWindow only for surrounding same-file control flow; fields file,identifiersToFind,granularity,maxTokens",
});

const TYPED_READY_CALL_BATCHING =
  "Put every currently ready independent atlas.query call in the same model turn.";

const TYPED_DIRECT_SYMBOL_CARD =
  "requires symbolId or symbolRef; for one exact symbol name, use symbolRef and include file or kind when known to get a bounded exact-source excerpt plus caller/callee addresses without a separate symbol.search; use symbol.search for concepts or ambiguous names; fields symbolId,symbolRef";

// Task-blind language-specific experimental levers. Keep every language in
// one table so a treatment can be tuned by ecosystem rather than repository,
// question, answer, or grader feedback. Marker priority selects the primary
// language for telemetry; all detected languages contribute enabled booleans.
// Result compaction is transport-only and preserves source, symbol handles,
// warnings, pagination, and non-default diagnostics, so it is language-neutral.
export const RESEARCHER_TYPED_LANGUAGE_LEVERS = Object.freeze({
  php: Object.freeze({
    markers: Object.freeze(["composer.json"]),
    purposeGuidance: true,
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

export function buildResearcherTypedReadyCallBatchingText() {
  return `ATLAS BATCHING: ${TYPED_READY_CALL_BATCHING}`;
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
    properties: Object.freeze({ limit: Object.freeze({ maximum: 128 }) }),
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

function researcherTypedActionRequirementSchema(action) {
  return {
    properties: {
      action: { type: "string", enum: [action] },
      args: TYPED_ACTION_ARG_REQUIREMENTS[action] || {},
    },
  };
}

const WORKFLOW_ARG_FIELDS = new Set([
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
    granularity: {
      type: "string",
      enum: ["symbol", "block", "fileWindow"],
      description: "Prefer symbol for a declared implementation anchor; use fileWindow only for surrounding same-file control flow; block selects the enclosing control-flow block.",
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
  const normalized = { ...args };
  const aliases = [];
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
  if (!error && action === "traverse_ref") error = move("searchMode", "search_mode");
  if (!error && action === "code.survey") error = move("identifiersToFind", "symbols");
  if (!error && ["code.survey", "code.structure"].includes(action)) error = move("limit", "maxFiles");
  if (!error && action === "code.skeleton") error = move("limit", "maxLines");
  if (!error && ["memory.surface", "memory.get"].includes(action)) error = move("paths", "fileRelPaths");
  if (!error && ["memory.surface", "memory.get"].includes(action)
    && typeof normalized.fileRelPaths === "string") normalized.fileRelPaths = [normalized.fileRelPaths];
  if (!error && action === "code.lens" && Number.isInteger(normalized.contextLines) && normalized.contextLines > 8) {
    const requested = normalized.contextLines;
    normalized.contextLines = 8;
    aliases.push({ from: "contextLines", to: "contextLines", requested, applied: 8, normalization: "clamp" });
  }
  return { args: normalized, aliases, ...(error ? { error } : {}) };
}

function researcherWorkflowStepSchema(workflowActions = []) {
  const actionArgs = researcherReadActionArgsSchema({ actions: workflowActions });
  return {
    type: "object",
    properties: {
      id: { type: "string", minLength: 1, maxLength: 100 },
      action: { type: "string", enum: workflowActions },
      ...actionArgs.properties,
    },
    required: ["action"],
    additionalProperties: false,
  };
}

/**
 * Convert the provider-visible fixed workflow slots to the canonical native
 * workflow shape. Codex currently preserves one nested object level in MCP
 * namespace parameters, but drops the object schema inside array items. Fixed
 * slots keep every step argument typed in the actual provider request.
 *
 * @param {Record<string, any>} toolArgs
 * @returns {{ ok: true, args: { steps: Array<{ id?: string, action: string, args: Record<string, any> }>, onError?: "stop" }, aliases: Array<{step: number, from: string, to: string}> } | { ok: false, error: string }}
 */
export function normalizeResearcherWorkflowFacadeArgs(toolArgs = {}) {
  if (!toolArgs || typeof toolArgs !== "object" || Array.isArray(toolArgs)) {
    return { ok: false, error: "workflow input must be an object" };
  }
  const allowedOuter = new Set(["action", "args", "step1", "step2", "step3", "onError"]);
  const unknownOuter = Object.keys(toolArgs).find((key) => !allowedOuter.has(key));
  if (unknownOuter) return { ok: false, error: `workflow field is not allowed: ${unknownOuter}` };
  if (!toolArgs.args || typeof toolArgs.args !== "object" || Array.isArray(toolArgs.args)) {
    return { ok: false, error: "workflow args must be an empty object" };
  }
  if (Object.keys(toolArgs.args).length > 0) {
    return { ok: false, error: "workflow args must be empty; put action fields directly in each step" };
  }
  if (toolArgs.onError != null && toolArgs.onError !== "stop") {
    return { ok: false, error: "workflow onError must be stop" };
  }
  const steps = [];
  const aliases = [];
  for (let index = 1; index <= WORKFLOW_MAX_STEPS; index += 1) {
    const key = `step${index}`;
    const step = toolArgs[key];
    if (step == null) {
      if (index <= 2) return { ok: false, error: `workflow ${key} is required` };
      continue;
    }
    if (!step || typeof step !== "object" || Array.isArray(step)) {
      return { ok: false, error: `workflow ${key} must be an object` };
    }
    const unknownStep = Object.keys(step).find((field) => (
      field !== "id" && field !== "action" && !WORKFLOW_ARG_FIELDS.has(field)
    ));
    if (unknownStep) return { ok: false, error: `workflow ${key} field is not allowed: ${unknownStep}` };
    const action = String(step.action || "").trim();
    if (!action) return { ok: false, error: `workflow ${key} action is required` };
    const { id, action: _action, ...args } = step;
    const normalized = normalizeResearcherTypedActionArgs(action, args);
    if (normalized.error) return { ok: false, error: `workflow ${key}: ${normalized.error}` };
    aliases.push(...normalized.aliases.map((alias) => ({ step: index, ...alias })));
    steps.push({
      ...(id != null ? { id } : {}),
      action,
      args: normalized.args,
    });
  }
  return {
    ok: true,
    args: {
      steps,
      ...(toolArgs.onError != null ? { onError: toolArgs.onError } : {}),
    },
    aliases,
  };
}

function atlasActionName(name = "") {
  const raw = String(name || "").trim();
  return raw.startsWith("atlas.") ? raw.slice("atlas.".length) : raw;
}

function dispatcherActions(atlasTools = []) {
  const actions = [];
  for (const tool of Array.isArray(atlasTools) ? atlasTools : []) {
    const action = atlasActionName(tool?.name);
    if (!action || EXCLUDED_ACTIONS.has(action) || !ACTION_CARDS[action]) continue;
    if (!actions.includes(action)) actions.push(action);
  }
  return actions;
}

export function buildResearcherDispatcherTool(atlasTools = []) {
  const actions = dispatcherActions(atlasTools);
  if (actions.length === 0) return null;
  const cards = actions.map((action) => `${action}: ${ACTION_CARDS[action]}.`).join(" ");
  return {
    name: DISPATCHER_TOOL_NAME,
    description: `Route one canonical Atlas repository read. Set action and put only its listed fields in args; do not invent fields. Runtime validates the selected action exactly. ${cards}`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions },
        args: { type: "object", additionalProperties: true },
      },
      required: ["action", "args"],
      additionalProperties: false,
    },
  };
}

export function buildResearcherTypedDispatcherTool(atlasTools = [], {
  purposeGuidance = false,
  symbolCardGuidance = false,
} = {}) {
  const surfacedActions = dispatcherActions(atlasTools);
  const actions = WORKFLOW_ACTIONS.filter((action) => surfacedActions.includes(action));
  if (actions.length === 0) return null;
  const actionCards = {
    ...(purposeGuidance ? TYPED_ACTION_CARDS : TYPED_TERSE_ACTION_CARDS),
    ...(symbolCardGuidance ? { "symbol.card": TYPED_DIRECT_SYMBOL_CARD } : {}),
  };
  const cards = actions.map((action) => `${action}: ${actionCards[action]}.`).join(" ");
  return {
    name: DISPATCHER_TOOL_NAME,
    description: `Run one canonical Atlas repository read. Put only the selected action's fields in args. Batch independent atlas.query calls; reuse returned symbolId values for dependent reads. symbolHandle is a compatibility input alias. Source is unavailable through MCP resources. Runtime validates the action and arguments. ${cards}`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions },
        args: researcherReadActionArgsSchema({
          allowSymbolHandles: true,
          includeWindowReason: false,
          actions,
        }),
      },
      required: ["action", "args"],
      additionalProperties: false,
      oneOf: actions.map(researcherTypedActionRequirementSchema),
    },
  };
}

export function buildResearcherWorkflowTool(atlasTools = []) {
  const actions = dispatcherActions(atlasTools);
  if (actions.length === 0) return null;
  const workflowActions = WORKFLOW_ACTIONS.filter((action) => actions.includes(action));
  const advertisedActions = workflowActions.length > 0 ? [...actions, "workflow"] : actions;
  const cards = actions.map((action) => `${action}: ${ACTION_CARDS[action]}.`).join(" ");
  const workflowStep = researcherWorkflowStepSchema(workflowActions);
  return {
    name: DISPATCHER_TOOL_NAME,
    description: `Run one typed Atlas read with action+args, or action workflow with args:{} plus step1+step2 and optional step3. Each step puts id/action and its action fields directly in the step object. Use exact refs such as $search.items[0].symbolId or $window.traversal_ref.ref; traverse_ref accepts an array to fetch several refs together. Prefer one action when reads are independent. Runtime validates every action against its signed allowlist. ${cards}`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: advertisedActions },
        args: researcherActionArgsSchema(),
        step1: workflowStep,
        step2: workflowStep,
        step3: workflowStep,
        onError: { type: "string", enum: ["stop"] },
      },
      required: ["action", "args"],
      additionalProperties: false,
    },
  };
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

export function researcherWorkflowMaxSteps() {
  return WORKFLOW_MAX_STEPS;
}

export function researcherWorkflowActions() {
  return [...WORKFLOW_ACTIONS];
}

export function applyResearcherDispatcherNativeGuidance(tool = {}) {
  if (String(tool?.name || "") !== "tools.read_file") return tool;
  return {
    ...tool,
    description: String(tool?.description || "")
      .replaceAll("code.window", "atlas.query action code.window")
      .replaceAll("code.lens", "atlas.query action code.lens"),
  };
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

export function applyResearcherTypedNativeToolShape(tool = {}) {
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
      "Locate bounded matching lines, files, or counts with ripgrep. Content mode returns the matching line plus at most one neighboring line; use atlas.query action code.window for the exact body of an identified implementation target.",
    inputSchema: {
      ...inputSchema,
      type: "object",
      properties,
      required: ["pattern"],
      additionalProperties: false,
    },
  };
}
