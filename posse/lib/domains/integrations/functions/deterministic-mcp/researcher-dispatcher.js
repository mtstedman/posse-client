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
  traverse_ref: "requires traversal_ref; fields traversal_ref,limit,offset,search,search_mode,reaccessAuthorization",
  create_ref: "fields text or source_ref+lines/offset/limit or chunks, plus object_type,note,owner_scope",
  "symbol.search": "requires query; fields query,scope,limit,semantic",
  "symbol.card": "requires symbolId or symbolRef; fields symbolId,symbolRef",
  "symbol.overview": "requires symbolId; fields symbolId,kind,minConfidence,limit,includeUnresolved",
  "code.skeleton": "fields file or symbolId,identifiersToFind,exportedOnly,maxLines,maxTokens,surveyGap",
  "code.survey": "requires paths; fields paths,symbols,maxFiles",
  "code.structure": "requires paths; fields paths,edgeKinds,includeEdges,includeSymbols,maxFiles",
  "code.lens": "requires identifiersToFind and either symbolId or file; fields symbolId,file,identifiersToFind,contextLines",
  "code.window": "requires reason+symbolId or reason+file+identifiersToFind; fields symbolId,file,reason,identifiersToFind,granularity,maxTokens",
  "memory.feedback": "requires memoryId,verdict; fields memoryId,verdict,detail",
  "memory.surface": "fields domains,fileRelPaths,symbolIds",
  "memory.get": "fields domains,fileRelPaths,symbolIds",
});

// The typed dispatcher removes each direct tool's purpose description as well
// as its name. Restore that task-blind selection signal while keeping the one-
// tool, closed-argument surface and canonical execution path unchanged.
const TYPED_ACTION_CARDS = Object.freeze({
  traverse_ref: "requires traversal_ref; retrieve only content omitted behind an explicit traversal_ref or next_traversal_ref, batching every independently needed ref; fields traversal_ref,limit,offset,search,search_mode,reaccessAuthorization",
  "symbol.search": "requires query; discover an unresolved symbol or location, then reuse returned IDs instead of repeating discovery after the target is known; fields query,scope,limit,semantic",
  "symbol.card": "requires symbolId or symbolRef; get a compact relationship summary for one or several identified symbols; fields symbolId,symbolRef",
  "symbol.overview": "requires symbolId; inspect concrete call and reference sites when relationships are the missing fact; fields symbolId,kind,minConfidence,limit,includeUnresolved",
  "code.skeleton": "orient within one known file or symbol using a compact body-free outline before exact source; fields file or symbolId,identifiersToFind,exportedOnly,maxLines,maxTokens,surveyGap",
  "code.survey": "requires paths; use when the exact target is unknown or behavior spans files, returning a ranked multi-file symbol preview and call map; fields paths,symbols,maxFiles",
  "code.structure": "requires paths; inventory files, symbols, imports, and selected edges when relationships matter more than bodies; fields paths,edgeKinds,includeEdges,includeSymbols,maxFiles",
  "code.lens": "requires identifiersToFind and either symbolId or file; use when relevant identifiers or branches are scattered in one known target, batching all known same-target identifiers; fields symbolId,file,identifiersToFind,contextLines",
  "code.window": "requires symbolId or file+identifiersToFind; read exact source only for a known symbol or named anchored region, batching known same-file anchors rather than using windows for discovery or orientation; the facade supplies the invariant proof-of-need reason; fields symbolId,file,identifiersToFind,granularity,maxTokens",
  "memory.surface": "probe memory presence for exact file or symbol anchors without returning bodies; fields domains,fileRelPaths,symbolIds",
  "memory.get": "retrieve memory bodies for exact file or symbol anchors; fields domains,fileRelPaths,symbolIds",
});

// Keep the terse language arm terse, but state the one action boundary that
// repeatedly caused otherwise avoidable validation/retry turns. This remains
// prompt pressure: native validation still rejects every malformed window.
const TYPED_TERSE_ACTION_CARDS = Object.freeze({
  ...ACTION_CARDS,
  "code.window": "file alone is invalid; use code.skeleton for orientation; exact source requires symbolId or file+identifiersToFind; the facade supplies the invariant proof-of-need reason; fields symbolId,file,identifiersToFind,granularity,maxTokens",
});

const TYPED_READY_CALL_BATCHING =
  "Put every currently ready independent atlas.query call in the same model turn.";

const TYPED_DIRECT_SYMBOL_CARD =
  "requires symbolId or symbolRef; for one exact symbol name, use symbolRef and include file or kind when known to get a bounded exact-source excerpt plus caller/callee addresses without a separate symbol.search; use symbol.search for concepts or ambiguous names; fields symbolId,symbolRef";

// Task-blind language-specific experimental levers. Keep every language in
// one table so a treatment can be tuned by ecosystem rather than repository,
// question, answer, or grader feedback. Marker priority selects the primary
// language for telemetry; all detected languages contribute enabled booleans.
export const RESEARCHER_TYPED_LANGUAGE_LEVERS = Object.freeze({
  typeorm: Object.freeze({
    markers: Object.freeze(["ormconfig.sample.json"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: true,
  }),
  php: Object.freeze({
    markers: Object.freeze(["composer.json"]),
    purposeGuidance: true,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: false,
  }),
  typescript: Object.freeze({
    markers: Object.freeze(["tsconfig.json"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: false,
  }),
  javascript: Object.freeze({
    markers: Object.freeze(["package.json"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: false,
  }),
  python: Object.freeze({
    markers: Object.freeze(["pyproject.toml", "setup.py", "requirements.txt"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: false,
  }),
  rust: Object.freeze({
    markers: Object.freeze(["cargo.toml"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: false,
  }),
  go: Object.freeze({
    markers: Object.freeze(["go.mod"]),
    purposeGuidance: false,
    symbolCardGuidance: false,
    readyCallBatching: false,
    anchoredFileWindowMaxTokens: null,
    resultCompaction: false,
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
  "code.skeleton",
  "code.survey",
  "code.structure",
  "code.lens",
  "code.window",
  "memory.surface",
  "memory.get",
]);

const WORKFLOW_ARG_FIELDS = new Set([
  "contextLines",
  "domains",
  "edgeKinds",
  "exportedOnly",
  "file",
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
  "offset",
  "paths",
  "query",
  "reaccessAuthorization",
  "reason",
  "scope",
  "search",
  "search_mode",
  "semantic",
  "surveyGap",
  "symbolId",
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
    symbolIds: { ...stringArray, items: symbolId },
    symbolRef: symbolRefItem,
    kind: { type: "array", items: { type: "string", enum: ["calls", "references", "reads", "writes", "uses_type", "imports", "extends", "implements"] }, maxItems: 20 },
    minConfidence: { type: "number", minimum: 0, maximum: 100 },
    minCallConfidence: { type: "number", minimum: 0, maximum: 1 },
    includeUnresolved: { type: "boolean" },
    includeResolutionMetadata: { type: "boolean" },
    file: { type: "string", minLength: 1 },
    paths: { type: ["string", "array"], minLength: 1, items: { type: "string", minLength: 1 }, maxItems: 128 },
    identifiersToFind: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 50 },
    symbols: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 16 },
    reason: { type: "string", minLength: 1 },
    granularity: { type: "string", enum: ["symbol", "block", "fileWindow"] },
    contextLines: { type: "integer", minimum: 0, maximum: 8 },
    maxFiles: { type: "integer", minimum: 1, maximum: 128 },
    maxLines: { type: "integer", minimum: 1, maximum: 5000 },
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
    search_mode: { type: "string", enum: ["auto", "literal", "regex"] },
    reaccessAuthorization: { type: "string", minLength: 16 },
    domains: { type: "array", items: { type: "string", enum: ["general", "ux", "schema", "security", "performance"] }, maxItems: 5 },
    fileRelPaths: stringArray,
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
 * @param {{ allowSymbolHandles?: boolean, includeWindowReason?: boolean }} [options]
 */
function researcherReadActionArgsSchema(options = {}) {
  const includeWindowReason = options.includeWindowReason !== false;
  const actionArgs = researcherActionArgsSchema({
    allowSymbolHandles: options.allowSymbolHandles === true,
  });
  const readProperties = Object.fromEntries(Object.entries(actionArgs.properties)
    .filter(([name]) => WORKFLOW_ARG_FIELDS.has(name) && (includeWindowReason || name !== "reason")));
  return {
    type: "object",
    properties: readProperties,
    additionalProperties: false,
  };
}

function researcherWorkflowStepSchema(workflowActions = []) {
  const actionArgs = researcherReadActionArgsSchema();
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
 * @returns {{ ok: true, args: { steps: Array<{ id?: string, action: string, args: Record<string, any> }>, onError?: "stop" } } | { ok: false, error: string }}
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
    steps.push({
      ...(id != null ? { id } : {}),
      action,
      args,
    });
  }
  return {
    ok: true,
    args: {
      steps,
      ...(toolArgs.onError != null ? { onError: toolArgs.onError } : {}),
    },
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
    description: `Run one canonical Atlas repository read. Put only the selected action's fields in args. Batch independent atlas.query calls; reuse exact returned values for dependent reads. symbolId accepts an exact returned symbolHandle. Source is unavailable through MCP resources. Runtime validates the action and arguments. ${cards}`,
    inputSchema: {
      type: "object",
      properties: {
        action: { type: "string", enum: actions },
        args: researcherReadActionArgsSchema({
          allowSymbolHandles: true,
          includeWindowReason: false,
        }),
      },
      required: ["action", "args"],
      additionalProperties: false,
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
