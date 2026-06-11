// @ts-check
//
// Runtime parameter schemas for native ATLAS v2 tools.
//
// These schemas intentionally cover the dispatcher boundary instead of
// describing provider-tool wrappers. Handlers still retain their local
// defensive checks, but malformed calls should fail here before work begins.

import { ATLAS_TOOL_ACTIONS } from "./tool-params.js";
import { ATLAS_RUNTIME_INPUTS } from "./runtimes.js";

const ATLAS_SYMBOL_ID_PATTERN = "^[0-9a-f]{64}:[0-9]+$";
const TASK_TYPES = Object.freeze(["debug", "review", "implement", "explain"]);
export const MEMORY_TYPES = Object.freeze([
  "decision",
  "bugfix",
  "task_context",
  "pattern",
  "convention",
  "architecture",
  "performance",
  "security",
]);
const CARD_DETAILS = Object.freeze(["minimal", "signature", "deps", "compact", "full"]);
const WIRE_FORMATS = Object.freeze(["standard", "compact", "agent", "packed"]);
const CODE_GRANULARITIES = Object.freeze(["symbol", "block", "fileWindow"]);
const TREE_REF_TYPES = Object.freeze(["cluster", "process"]);
const PATTERN_CACHE = new Map();
const DELETE_NORMALIZED_FIELD = Symbol("delete-atlas-normalized-field");
const ENUM_VALUE_ALIASES = Object.freeze({
  "$.cardDetail": Object.freeze({
    brief: "minimal",
    short: "minimal",
    sig: "signature",
    signatures: "signature",
    dependency: "deps",
    dependencies: "deps",
    summary: "compact",
    summaries: "compact",
    concise: "compact",
    detailed: "full",
    complete: "full",
  }),
  "$.wireFormat": Object.freeze({
    default: "compact",
    summary: "compact",
    summaries: "compact",
    concise: "compact",
    columnar: "packed",
    columns: "packed",
  }),
});
const s = (opts = {}) => ({ type: "string", ...opts });
const b = (opts = {}) => ({ type: "boolean", ...opts });
const n = (opts = {}) => ({ type: "number", ...opts });
const i = (opts = {}) => ({ type: "integer", ...opts });
const a = (items, opts = {}) => ({ type: "array", items, ...opts });
const o = (properties = {}, required = [], opts = {}) => ({
  type: "object",
  properties,
  required,
  additionalProperties: false,
  ...opts,
});

const symbolId = () => s({ pattern: ATLAS_SYMBOL_ID_PATTERN });
const symbolIds = (maxItems = 100) => a(symbolId(), { maxItems });
const repoPaths = (maxItems = 100) => a(s({ minLength: 1 }), { maxItems });
const sliceBudget = () => o({
  maxCards: i({ minimum: 1, maximum: 500 }),
  maxEstimatedTokens: i({ minimum: 1, maximum: 200_000 }),
});
const symbolRef = () => o({
  name: s({ minLength: 1 }),
  file: s({ minLength: 1 }),
  kind: s({ minLength: 1 }),
  exportedOnly: b(),
}, ["name"]);
const looseSymbolRef = () => o({
  name: s({ minLength: 1 }),
  file: s({ minLength: 1 }),
  kind: s({ minLength: 1 }),
  exportedOnly: b(),
}, ["name"], { additionalProperties: true });
const identifierList = (opts = {}) => ({
  type: ["array", "string"],
  items: s({ minLength: 1, maxLength: 256 }),
  maxLength: 5000,
  ...opts,
});

// Gateway wrappers accept loose envelopes here because dispatch unwraps them
// and validates the resolved target action with that action's native schema.
const gatewaySchema = () => o({
  targetAction: s({ minLength: 1 }),
  gatewayAction: s({ minLength: 1 }),
  actionName: s({ minLength: 1 }),
}, [], { additionalProperties: true });

// Actions listed here intentionally appear under more than one gateway. Keep
// the expected gateway set explicit so tests can catch accidental removals in
// either direction.
export const ATLAS_MULTI_GATEWAY_ACTIONS = Object.freeze({
  "edit.plan": Object.freeze(["query", "code"]),
});

const QUERY_SHARED_ACTIONS = Object.freeze(
  Object.entries(ATLAS_MULTI_GATEWAY_ACTIONS)
    .filter(([, gateways]) => gateways.includes("query"))
    .map(([action]) => action),
);
const CODE_SHARED_ACTIONS = Object.freeze(
  Object.entries(ATLAS_MULTI_GATEWAY_ACTIONS)
    .filter(([, gateways]) => gateways.includes("code"))
    .map(([action]) => action),
);

const QUERY_GATEWAY_ACTIONS = Object.freeze([
  "symbol.search",
  "symbol.getCard",
  "symbol.getCards",
  "symbol.usages",
  "tree.overview",
  "tree.scope",
  "slice.build",
  "slice.refresh",
  "slice.spillover.get",
  ...QUERY_SHARED_ACTIONS,
  "context",
  "context.summary",
  "delta.get",
  "pr.risk.analyze",
  "pr.risk",
  "repo.status",
  "repo.quality",
  "memory.query",
]);
const CODE_GATEWAY_ACTIONS = Object.freeze([
  "code.getSkeleton",
  "code.getHotPath",
  "code.needWindow",
  ...CODE_SHARED_ACTIONS,
]);
const REPO_GATEWAY_ACTIONS = Object.freeze([
  "info",
  "action.search",
  "manual",
  "repo.register",
  "repo.status",
  "repo.quality",
  "index.refresh",
  "policy.get",
  "policy.set",
  "usage.stats",
  "runtime.execute",
  "runtime.queryOutput",
  "scip.ingest",
]);
const AGENT_GATEWAY_ACTIONS = Object.freeze([
  "context",
  "context.summary",
  "agent.feedback",
  "agent.feedback.query",
  "buffer.push",
  "buffer.checkpoint",
  "buffer.status",
  "memory.store",
  "memory.query",
  "memory.remove",
]);

export const ATLAS_GATEWAY_ACTIONS = Object.freeze({
  query: QUERY_GATEWAY_ACTIONS,
  code: CODE_GATEWAY_ACTIONS,
  repo: REPO_GATEWAY_ACTIONS,
  agent: AGENT_GATEWAY_ACTIONS,
});

const workflowStep = () => o({
  id: s({ minLength: 1, maxLength: 100 }),
  fn: s({ minLength: 1 }),
  action: s({ minLength: 1 }),
  args: o({}, [], { additionalProperties: true }),
  maxResponseTokens: i({ minimum: 1, maximum: 200_000 }),
});

const workflowBudget = () => o({
  maxTotalTokens: i({ minimum: 100, maximum: 500_000 }),
  maxSteps: i({ minimum: 1, maximum: 50 }),
  maxDurationMs: i({ minimum: 100, maximum: 300_000 }),
});

const workflowTrace = () => o({
  level: s({ enum: ["summary", "verbose"], default: "summary" }),
  includeResolvedArgs: b(),
  maxPreviewTokens: i({ minimum: 1, maximum: 50_000 }),
});

const cursorSchema = () => o({
  line: i({ minimum: 0, maximum: 10_000_000 }),
  column: i({ minimum: 0, maximum: 1_000_000 }),
});

const selectionSchema = () => o({
  startLine: i({ minimum: 0, maximum: 10_000_000 }),
  startColumn: i({ minimum: 0, maximum: 1_000_000 }),
  endLine: i({ minimum: 0, maximum: 10_000_000 }),
  endColumn: i({ minimum: 0, maximum: 1_000_000 }),
});

const sliceContextHint = () => o({
  taskText: s({ minLength: 1 }),
  stackTrace: s({ maxLength: 200_000 }),
  failingTestPath: s({ minLength: 1 }),
  editedFiles: repoPaths(100),
  entrySymbols: symbolIds(100),
  budget: sliceBudget(),
}, ["taskText"]);

const policyPatch = () => o({
  maxWindowLines: i({ minimum: 1, maximum: 20_000 }),
  maxWindowTokens: i({ minimum: 1, maximum: 500_000 }),
  requireIdentifiers: b(),
  allowBreakGlass: b(),
  defaultMinCallConfidence: n({ minimum: 0, maximum: 1 }),
  defaultDenyRaw: b(),
  memoryEnabled: b(),
  memoryStaleAfterDays: i({ minimum: 0, maximum: 3650 }),
  memoryMaxPerRepo: i({ minimum: 0, maximum: 100_000 }),
  runtimeEnabled: b(),
  budgetCaps: sliceBudget(),
}, [], { type: ["object", "array"] });

/** @type {Readonly<Record<string, JsonSchema>>} */
export const ATLAS_TOOL_PARAM_SCHEMAS = Object.freeze({
  query: gatewaySchema(),
  code: gatewaySchema(),
  repo: gatewaySchema(),
  agent: gatewaySchema(),

  "action.search": o({
    query: s({ maxLength: 20_000 }),
    namespace: s({ maxLength: 80 }),
    limit: i({ minimum: 1, maximum: 100 }),
    offset: i({ minimum: 0, maximum: 10_000 }),
  }),
  manual: o({
    query: s({ maxLength: 20_000 }),
    actions: a(s({ enum: ATLAS_TOOL_ACTIONS }), { maxItems: 100 }),
    limit: i({ minimum: 1, maximum: 100 }),
    includeSchemas: b(),
    includeExamples: b(),
    format: s({ enum: ["text", "json"], default: "text" }),
  }),
  workflow: o({
    repoId: s({ maxLength: 256 }),
    steps: a(workflowStep(), { minItems: 1, maxItems: 50 }),
    budget: workflowBudget(),
    onError: s({ enum: ["continue", "stop"], default: "continue" }),
    defaultMaxResponseTokens: i({ minimum: 1, maximum: 200_000 }),
    onlyFinalResult: b(),
    trace: workflowTrace(),
    dryRun: b(),
  }, ["steps"]),
  info: o({
    repoId: s({ maxLength: 256 }),
    includePolicy: b(),
    includeCounts: b(),
  }),

  "repo.register": o({
    repoId: s({ maxLength: 256 }),
    repoRoot: s({ minLength: 1 }),
    branch: s({ minLength: 1, maxLength: 256 }),
    buildEmptyView: b(),
  }),
  "repo.status": o({
    detail: s({ enum: ["minimal", "standard", "full"], default: "standard" }),
    surfaceMemories: b(),
  }),
  "index.refresh": o({
    mode: s({ enum: ["smart", "full", "incremental"], default: "smart" }),
    paths: repoPaths(1000),
    branch: s({ minLength: 1, maxLength: 256 }),
    wait: b(),
    async: b(),
    includeDiagnostics: b(),
    operationId: s({ minLength: 1, maxLength: 128 }),
  }),
  "repo.overview": o({
    level: s({ enum: ["stats", "directories", "hotspots", "graph", "full"], default: "stats" }),
    includeHotspots: b(),
    directories: repoPaths(1000),
    maxDirectories: i({ minimum: 1, maximum: 500 }),
    maxExportsPerDirectory: i({ minimum: 1, maximum: 1000 }),
    ifNoneMatch: s({ maxLength: 512 }),
  }),
  "repo.quality": o({
    probeTreeSitter: b(),
    feedbackLimit: i({ minimum: 1, maximum: 10_000 }),
    halfLifeDays: n({ minimum: 0.1, maximum: 3650 }),
  }),

  "buffer.push": o({
    filePath: s({ minLength: 1 }),
    content: s({ maxLength: 10 * 1024 * 1024 }),
    sessionId: s({ maxLength: 256 }),
    version: i({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }),
    eventType: s({ enum: ["open", "change", "save", "close", "checkpoint"], default: "change" }),
    language: s({ maxLength: 80 }),
    dirty: b(),
    timestamp: s({ maxLength: 80 }),
    cursor: cursorSchema(),
    selections: a(selectionSchema(), { maxItems: 1000 }),
  }, ["filePath", "content"]),
  "buffer.checkpoint": o({
    filePath: s({ minLength: 1 }),
    sessionId: s({ maxLength: 256 }),
    writeToDisk: b(),
    clear: b(),
  }, ["filePath"]),
  "buffer.status": o({
    filePath: s({ minLength: 1 }),
    sessionId: s({ maxLength: 256 }),
  }),

  "symbol.search": o({
    query: s({ minLength: 1, maxLength: 20_000 }),
    limit: i({ minimum: 1, maximum: 500 }),
    semantic: b(),
    entities: a(s({ enum: ["symbols", "memories", "feedback"] }), { maxItems: 3 }),
    scope: s({ enum: ["name", "body", "either"], default: "either" }),
    sessionId: s({ maxLength: 256 }),
    taskText: s({ maxLength: 20_000 }),
    taskType: s({ enum: TASK_TYPES }),
  }, ["query"]),
  "symbol.getCard": o({
    symbolId: symbolId(),
    symbolRef: symbolRef(),
    ifNoneMatch: s({ maxLength: 512 }),
    minCallConfidence: n({ minimum: 0, maximum: 1 }),
    includeResolutionMetadata: b(),
    sessionId: s({ maxLength: 256 }),
  }),
  "symbol.getCards": o({
    symbolIds: symbolIds(100),
    symbolRefs: a(looseSymbolRef(), { maxItems: 100 }),
    cards: a(o({
      symbolId: symbolId(),
      symbolRef: looseSymbolRef(),
    }), { maxItems: 100 }),
    minCallConfidence: n({ minimum: 0, maximum: 1 }),
    includeResolutionMetadata: b(),
    sessionId: s({ maxLength: 256 }),
  }),
  "symbol.usages": o({
    symbolId: symbolId(),
    kind: a(s({ enum: ["calls", "references", "reads", "writes", "uses_type", "imports", "extends", "implements"] }), { maxItems: 20 }),
    limit: i({ minimum: 1, maximum: 500 }),
    minConfidence: n({ minimum: 0, maximum: 100 }),
    includeUnresolved: b(),
  }, ["symbolId"]),
  "tree.overview": o({
    nodeId: s({ minLength: 1, maxLength: 2000 }),
    path: s({ minLength: 1, maxLength: 4000 }),
    symbolId: symbolId(),
    refType: s({ enum: TREE_REF_TYPES }),
    refId: s({ minLength: 1, maxLength: 512 }),
    maxDepth: i({ minimum: 0, maximum: 8 }),
    limit: i({ minimum: 1, maximum: 500 }),
    offset: i({ minimum: 0, maximum: 100_000 }),
    includeAggregates: b(),
    includeTerms: b(),
    includeRefs: b(),
    includeLatestRun: b(),
  }),
  "tree.scope": o({
    taskText: s({ maxLength: 200_000 }),
    taskType: s({ enum: TASK_TYPES }),
    paths: repoPaths(100),
    editedFiles: repoPaths(100),
    path: s({ minLength: 1, maxLength: 4000 }),
    symbolIds: symbolIds(100),
    symbolId: symbolId(),
    nodeIds: a(s({ minLength: 1, maxLength: 2000 }), { maxItems: 100 }),
    refs: a(o({
      refType: s({ enum: TREE_REF_TYPES }),
      refId: s({ minLength: 1, maxLength: 512 }),
    }, ["refType", "refId"]), { maxItems: 20 }),
    refType: s({ enum: TREE_REF_TYPES }),
    refId: s({ minLength: 1, maxLength: 512 }),
    maxFiles: i({ minimum: 1, maximum: 500 }),
    maxBranches: i({ minimum: 1, maximum: 100 }),
    branchFileCap: i({ minimum: 1, maximum: 500 }),
    refMatchLimit: i({ minimum: 1, maximum: 500 }),
  }),

  "slice.build": o({
    taskText: s({ maxLength: 200_000 }),
    semantic: b(),
    taskType: s({ enum: TASK_TYPES }),
    stackTrace: s({ maxLength: 200_000 }),
    failingTestPath: s({ minLength: 1 }),
    editedFiles: repoPaths(100),
    entrySymbols: symbolIds(100),
    knownCardEtags: o({}, [], { additionalProperties: s({ maxLength: 512 }), maxProperties: 1000 }),
    ifNoneMatch: s({ maxLength: 512 }),
    cardDetail: s({
      enum: CARD_DETAILS,
      default: "compact",
      description: "ATLAS card detail level. Use compact for summary-sized cards.",
    }),
    adaptiveDetail: b(),
    wireFormat: s({
      enum: WIRE_FORMATS,
      default: "compact",
      description: "Response wire format. Use compact by default; packed is the most token-efficient columnar form.",
    }),
    wireFormatVersion: i({ minimum: 1, maximum: 3 }),
    budget: sliceBudget(),
    minConfidence: n({ minimum: 0, maximum: 1 }),
    minCallConfidence: n({ minimum: 0, maximum: 1 }),
    includeResolutionMetadata: b(),
  }),
  "slice.refresh": o({
    sliceHandle: s({ minLength: 1, maxLength: 512 }),
    knownVersion: s({ minLength: 1, maxLength: 512 }),
  }, ["sliceHandle", "knownVersion"]),
  "slice.spillover.get": o({
    spilloverHandle: s({ minLength: 1, maxLength: 512 }),
    cursor: s({ maxLength: 512 }),
    pageSize: i({ minimum: 1, maximum: 100 }),
  }, ["spilloverHandle"]),

  "edit.plan": o({
    taskText: s({ maxLength: 20_000 }),
    targetSymbols: symbolIds(100),
    targetFiles: repoPaths(100),
    search: s({ maxLength: 20_000 }),
    replace: s({ maxLength: 20_000 }),
    operation: s({ enum: ["replace", "insert", "delete", "inspect"], default: "inspect" }),
    maxEdits: i({ minimum: 1, maximum: 500 }),
  }),

  "code.getSkeleton": o({
    symbolId: symbolId(),
    file: s({ minLength: 1 }),
    exportedOnly: b(),
    maxLines: i({ minimum: 1, maximum: 5000 }),
    maxTokens: i({ minimum: 1, maximum: 200_000 }),
    identifiersToFind: identifierList({ maxItems: 50 }),
    ifNoneMatch: s({ maxLength: 512 }),
    sessionId: s({ maxLength: 256 }),
  }),
  "code.getHotPath": o({
    symbolId: symbolId(),
    file: s({ minLength: 1 }),
    identifiersToFind: identifierList({ minItems: 1, maxItems: 50 }),
    maxLines: i({ minimum: 1, maximum: 5000 }),
    maxTokens: i({ minimum: 1, maximum: 200_000 }),
    contextLines: i({ minimum: 0, maximum: 100 }),
    ifNoneMatch: s({ maxLength: 512 }),
    sessionId: s({ maxLength: 256 }),
  }, ["identifiersToFind"]),
  "code.needWindow": o({
    symbolId: symbolId(),
    file: s({ minLength: 1 }),
    reason: s({ maxLength: 20_000 }),
    expectedLines: { type: ["integer", "string"], minimum: 1, maximum: 20_000, maxLength: 20, pattern: "^[0-9]+$" },
    identifiersToFind: identifierList({ maxItems: 50 }),
    granularity: s({ enum: CODE_GRANULARITIES, default: "symbol" }),
    maxTokens: i({ minimum: 1, maximum: 200_000 }),
    sliceContext: sliceContextHint(),
    sessionId: s({ maxLength: 256 }),
  }, ["reason", "expectedLines", "identifiersToFind"]),

  context: o({
    taskText: s({ minLength: 1, maxLength: 200_000 }),
    taskType: s({ enum: TASK_TYPES }),
    contextMode: s({ enum: ["precise", "broad"], default: "broad" }),
    focusSymbols: symbolIds(100),
    focusPaths: repoPaths(100),
    maxTokens: i({ minimum: 1, maximum: 500_000 }),
    maxActions: i({ minimum: 1, maximum: 100 }),
  }, ["taskText"]),
  "context.summary": o({
    taskText: s({ minLength: 1, maxLength: 200_000 }),
    taskType: s({ enum: TASK_TYPES }),
    contextMode: s({ enum: ["precise", "broad"], default: "broad" }),
    focusSymbols: symbolIds(100),
    focusPaths: repoPaths(100),
    maxTokens: i({ minimum: 1, maximum: 500_000 }),
    maxActions: i({ minimum: 1, maximum: 100 }),
    maxEvidence: i({ minimum: 1, maximum: 100 }),
    includeCards: b(),
  }, ["taskText"]),
  "agent.feedback": o({
    sliceHandle: s({ minLength: 1, maxLength: 512 }),
    usefulSymbols: a(s({ minLength: 1, maxLength: 512 }), { maxItems: 1000 }),
    missingSymbols: a(s({ minLength: 1, maxLength: 512 }), { maxItems: 1000 }),
    taskType: s({ enum: TASK_TYPES }),
    taskText: s({ maxLength: 200_000 }),
    taskTags: a(s({ minLength: 1, maxLength: 256 }), { maxItems: 100 }),
  }, ["sliceHandle"]),
  "agent.feedback.query": o({
    since: s({ maxLength: 80 }),
    limit: i({ minimum: 1, maximum: 10_000 }),
    taskType: s({ enum: TASK_TYPES }),
    halfLifeDays: n({ minimum: 0.1, maximum: 3650 }),
  }),

  "delta.get": o({
    fromVersion: s({ minLength: 1, maxLength: 512 }),
    toVersion: s({ minLength: 1, maxLength: 512 }),
    maxCards: i({ minimum: 1, maximum: 500 }),
    maxTokens: i({ minimum: 1, maximum: 200_000 }),
  }, ["fromVersion", "toVersion"]),
  "pr.risk.analyze": o({
    fromVersion: s({ minLength: 1, maxLength: 512 }),
    toVersion: s({ minLength: 1, maxLength: 512 }),
    riskThreshold: n({ minimum: 0, maximum: 100 }),
  }, ["fromVersion", "toVersion"]),
  "pr.risk": o({
    fromVersion: s({ minLength: 1, maxLength: 512 }),
    toVersion: s({ minLength: 1, maxLength: 512 }),
    maxCards: i({ minimum: 1, maximum: 500 }),
    maxTokens: i({ minimum: 1, maximum: 200_000 }),
    riskThreshold: n({ minimum: 0, maximum: 100 }),
  }, ["fromVersion", "toVersion"]),

  "file.read": o({
    filePath: s({ minLength: 1 }),
    maxBytes: i({ minimum: 1, maximum: 2 * 1024 * 1024 }),
    offset: i({ minimum: 0, maximum: 10_000_000 }),
    limit: i({ minimum: 1, maximum: 1000 }),
    search: s({ minLength: 1, maxLength: 200 }),
    searchContext: i({ minimum: 0, maximum: 50 }),
    jsonPath: s({ minLength: 1, maxLength: 1000 }),
  }, ["filePath"]),

  "memory.store": o({
    repoId: s({ maxLength: 256 }),
    type: s({ enum: MEMORY_TYPES }),
    title: s({ minLength: 1, maxLength: 500 }),
    content: s({ minLength: 1, maxLength: 200_000 }),
    tags: a(s({ minLength: 1, maxLength: 256 }), { maxItems: 100 }),
    confidence: n({ minimum: 0, maximum: 1 }),
    symbolIds: symbolIds(1000),
    fileRelPaths: repoPaths(1000),
    memoryId: s({ maxLength: 256 }),
  }, ["type", "title", "content"]),
  "memory.query": o({
    repoId: s({ maxLength: 256 }),
    query: s({ maxLength: 20_000 }),
    types: a(s({ enum: MEMORY_TYPES }), { maxItems: MEMORY_TYPES.length }),
    tags: a(s({ minLength: 1, maxLength: 256 }), { maxItems: 100 }),
    symbolIds: symbolIds(1000),
    fileRelPaths: repoPaths(1000),
    staleOnly: b(),
    limit: i({ minimum: 1, maximum: 1000 }),
    offset: i({ minimum: 0, maximum: 100_000 }),
    sortBy: s({ enum: ["recency", "confidence", "score"] }),
  }),
  "memory.remove": o({
    repoId: s({ maxLength: 256 }),
    memoryId: s({ minLength: 1, maxLength: 256 }),
    deleteFile: b(),
  }, ["memoryId"]),
  "memory.surface": o({
    repoId: s({ maxLength: 256 }),
    symbolIds: symbolIds(1000),
    fileRelPaths: repoPaths(1000),
    taskType: s({ enum: MEMORY_TYPES }),
    types: a(s({ enum: MEMORY_TYPES }), { maxItems: MEMORY_TYPES.length }),
    limit: i({ minimum: 1, maximum: 1000 }),
  }),

  "policy.get": o({
    repoId: s({ maxLength: 256 }),
  }),
  "policy.set": o({
    repoId: s({ maxLength: 256 }),
    policyPatch: policyPatch(),
  }, ["policyPatch"]),
  "usage.stats": o({
    repoId: s({ maxLength: 256 }),
    scope: s({ enum: ["session", "history", "both"], default: "both" }),
    since: s({ maxLength: 80 }),
    limit: i({ minimum: 1, maximum: 10_000 }),
    aggregateLimit: i({ minimum: 1, maximum: 100_000 }),
    persist: b(),
  }),
  "runtime.execute": o({
    repoId: s({ maxLength: 256 }),
    runtime: s({ enum: ATLAS_RUNTIME_INPUTS }),
    executable: s({ minLength: 1, maxLength: 256 }),
    args: a(s({ maxLength: 20_000 }), { maxItems: 1000 }),
    code: s({ maxLength: 2 * 1024 * 1024 }),
    relativeCwd: s({ minLength: 1, maxLength: 2000 }),
    timeoutMs: i({ minimum: 100, maximum: 120_000 }),
    queryTerms: a(s({ minLength: 1, maxLength: 256 }), { maxItems: 100 }),
    maxResponseLines: i({ minimum: 10, maximum: 1000 }),
    persistOutput: b(),
    outputMode: s({ enum: ["minimal", "summary", "intent"], default: "minimal" }),
  }, ["runtime"]),
  "runtime.queryOutput": o({
    artifactHandle: s({ minLength: 1, maxLength: 256, pattern: "^[A-Za-z0-9_.-]+$" }),
    queryTerms: a(s({ minLength: 1, maxLength: 256 }), { minItems: 1, maxItems: 100 }),
    maxExcerpts: i({ minimum: 1, maximum: 50 }),
    contextLines: i({ minimum: 0, maximum: 10 }),
    stream: s({ enum: ["stdout", "stderr", "both"], default: "both" }),
  }, ["artifactHandle", "queryTerms"]),
  "scip.ingest": o({
    indexPath: s({ minLength: 1, maxLength: 4000 }),
    dryRun: b(),
    force: b(),
    branch: s({ minLength: 1, maxLength: 256 }),
  }, ["indexPath"]),
});

/**
 * @typedef {Object} JsonSchema
 * @property {string | string[]} [type]
 * @property {Record<string, JsonSchema>} [properties]
 * @property {string[]} [required]
 * @property {boolean | JsonSchema} [additionalProperties]
 * @property {JsonSchema} [items]
 * @property {unknown[]} [enum]
 * @property {string} [pattern]
 * @property {number} [minimum]
 * @property {number} [maximum]
 * @property {number} [minLength]
 * @property {number} [maxLength]
 * @property {number} [minItems]
 * @property {number} [maxItems]
 * @property {number} [maxProperties]
 * @property {unknown} [default]
 */

/**
 * @typedef {Object} ValidationError
 * @property {string} path
 * @property {string} code
 * @property {string} message
 */

/**
 * @param {import("./tool-params.js").ToolCall} call
 * @returns {{ ok: true } | { ok: false, errors: ValidationError[] }}
 */
export function validateAtlasToolCall(call) {
  if (!call || typeof call !== "object" || Array.isArray(call)) {
    return {
      ok: false,
      errors: [{ path: "$", code: "type", message: "Tool call must be an object" }],
    };
  }
  const action = String(/** @type {any} */ (call).action || "");
  const schema = ATLAS_TOOL_PARAM_SCHEMAS[action];
  if (!schema) return { ok: true };
  const params = { .../** @type {Record<string, unknown>} */ (call) };
  delete params.action;
  /** @type {ValidationError[]} */
  const errors = [];
  validateValue(params, schema, "$", errors);
  return errors.length === 0 ? { ok: true } : { ok: false, errors };
}

/**
 * Normalize provider-supplied ATLAS params before validation. The boundary
 * stays strict for required params and unsupported keys, but optional enum
 * mistakes are coerced to the nearest canonical value or omitted so handler
 * defaults can do their normal work.
 *
 * @param {import("./tool-params.js").ToolCall} call
 * @returns {import("./tool-params.js").ToolCall}
 */
export function normalizeAtlasToolCall(call) {
  if (!call || typeof call !== "object" || Array.isArray(call)) return call;
  const action = String(/** @type {any} */ (call).action || "");
  const schema = ATLAS_TOOL_PARAM_SCHEMAS[action];
  if (!schema) return call;
  const params = { .../** @type {Record<string, unknown>} */ (call) };
  delete params.action;
  const normalized = normalizeObjectParams(params, schema, "$");
  return /** @type {import("./tool-params.js").ToolCall} */ ({
    action: /** @type {any} */ (call).action,
    ...normalized,
  });
}

/**
 * Return the provider-facing parameter schema for an ATLAS action. Gateway
 * tools expose `action` as their routed target field, while direct native
 * actions use their dispatcher schema unchanged.
 *
 * @param {string} action
 * @returns {JsonSchema | null}
 */
export function atlasDescriptorSchemaForAction(action) {
  const gatewayActions = /** @type {Record<string, readonly string[]>} */ (ATLAS_GATEWAY_ACTIONS)[action];
  if (gatewayActions) {
    return o({
      action: s({ enum: [...gatewayActions] }),
    }, ["action"], { additionalProperties: true });
  }
  const schema = ATLAS_TOOL_PARAM_SCHEMAS[action];
  return schema ? cloneJsonSchema(schema) : null;
}

/**
 * @param {Record<string, unknown>} params
 * @param {JsonSchema} schema
 * @param {string} path
 * @returns {Record<string, unknown>}
 */
function normalizeObjectParams(params, schema, path) {
  if (!params || typeof params !== "object" || Array.isArray(params)) return params;
  const props = schema.properties || {};
  const required = new Set(schema.required || []);
  const out = { ...params };
  for (const [key, childSchema] of Object.entries(props)) {
    if (!Object.prototype.hasOwnProperty.call(out, key)) continue;
    const normalized = normalizeSchemaValue(out[key], childSchema, `${path}.${key}`, required.has(key));
    if (normalized === DELETE_NORMALIZED_FIELD) delete out[key];
    else out[key] = normalized;
  }
  return out;
}

/**
 * @param {unknown} value
 * @param {JsonSchema} schema
 * @param {string} path
 * @param {boolean} required
 * @returns {unknown | typeof DELETE_NORMALIZED_FIELD}
 */
function normalizeSchemaValue(value, schema, path, required) {
  if (!schema) return value;

  if (schema.enum) {
    return normalizeEnumValue(value, schema, path, required);
  }

  if (arrayTypeAllowed(schema.type)) {
    const arrayValue = Array.isArray(value)
      ? value
      : (typeof value === "string" && schema.items?.enum ? [value] : null);
    if (!arrayValue) return value;
    if (!schema.items) return arrayValue;
    const out = [];
    for (let idx = 0; idx < arrayValue.length; idx += 1) {
      const normalized = normalizeSchemaValue(arrayValue[idx], schema.items, `${path}[${idx}]`, false);
      if (normalized !== DELETE_NORMALIZED_FIELD) out.push(normalized);
    }
    return out.length > 0 || required ? out : DELETE_NORMALIZED_FIELD;
  }

  if (isPlainObject(value) && schema.properties) {
    return normalizeObjectParams(/** @type {Record<string, unknown>} */ (value), schema, path);
  }

  return value;
}

/**
 * @param {unknown} value
 * @param {JsonSchema} schema
 * @param {string} path
 * @param {boolean} required
 * @returns {unknown | typeof DELETE_NORMALIZED_FIELD}
 */
function normalizeEnumValue(value, schema, path, required) {
  if (!schema.enum) return value;
  if (schema.enum.includes(value)) return value;
  const canonical = canonicalEnumValue(value, schema.enum, path);
  if (canonical !== undefined) return canonical;
  if (Object.prototype.hasOwnProperty.call(schema, "default")) return schema.default;
  return required ? value : DELETE_NORMALIZED_FIELD;
}

/**
 * @param {unknown} value
 * @param {unknown[]} enumValues
 * @param {string} path
 * @returns {unknown | undefined}
 */
function canonicalEnumValue(value, enumValues, path) {
  const key = enumKey(value);
  if (!key) return undefined;
  for (const enumValue of enumValues) {
    if (enumKey(enumValue) === key) return enumValue;
  }
  const aliases = /** @type {Record<string, unknown> | undefined} */ (
    Object.prototype.hasOwnProperty.call(ENUM_VALUE_ALIASES, path)
      ? /** @type {Record<string, unknown>} */ (ENUM_VALUE_ALIASES)[path]
      : undefined
  );
  if (aliases && Object.prototype.hasOwnProperty.call(aliases, key)) return aliases[key];
  return undefined;
}

/**
 * @param {unknown} value
 */
function enumKey(value) {
  return String(value == null ? "" : value).trim().toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * @param {string | string[] | undefined} type
 */
function arrayTypeAllowed(type) {
  return Array.isArray(type) ? type.includes("array") : type === "array";
}

/**
 * @param {unknown} value
 */
function isPlainObject(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/**
 * @param {unknown} value
 * @param {JsonSchema} schema
 * @param {string} path
 * @param {ValidationError[]} errors
 */
function validateValue(value, schema, path, errors) {
  if (!schema || errors.length >= 10) return;
  if (value === undefined) return;

  if (schema.type && !matchesType(value, schema.type)) {
    errors.push({
      path,
      code: "type",
      message: `${path} must be ${Array.isArray(schema.type) ? schema.type.join(" or ") : schema.type}`,
    });
    return;
  }

  if (schema.enum && !schema.enum.includes(value)) {
    errors.push({
      path,
      code: "enum",
      message: `${path} must be one of: ${schema.enum.map(String).join(", ")}`,
    });
    return;
  }

  if (typeof value === "string") {
    if (schema.minLength != null && value.length < schema.minLength) {
      errors.push({ path, code: "minLength", message: `${path} must not be empty` });
    }
    if (schema.maxLength != null && value.length > schema.maxLength) {
      errors.push({ path, code: "maxLength", message: `${path} exceeds ${schema.maxLength} characters` });
    }
    if (schema.pattern && !cachedPatternRegExp(schema.pattern).test(value)) {
      errors.push({ path, code: "pattern", message: `${path} does not match required pattern` });
    }
  }

  if (typeof value === "number") {
    if (schema.minimum != null && value < schema.minimum) {
      errors.push({ path, code: "minimum", message: `${path} must be >= ${schema.minimum}` });
    }
    if (schema.maximum != null && value > schema.maximum) {
      errors.push({ path, code: "maximum", message: `${path} must be <= ${schema.maximum}` });
    }
  }

  if (Array.isArray(value)) {
    if (schema.minItems != null && value.length < schema.minItems) {
      errors.push({ path, code: "minItems", message: `${path} must contain at least ${schema.minItems} item(s)` });
    }
    if (schema.maxItems != null && value.length > schema.maxItems) {
      errors.push({ path, code: "maxItems", message: `${path} must contain at most ${schema.maxItems} item(s)` });
    }
    if (schema.items) {
      for (let idx = 0; idx < value.length && errors.length < 10; idx += 1) {
        validateValue(value[idx], schema.items, `${path}[${idx}]`, errors);
      }
    }
    return;
  }

  if (value && typeof value === "object") {
    const record = /** @type {Record<string, unknown>} */ (value);
    if (schema.maxProperties != null && Object.keys(record).length > schema.maxProperties) {
      errors.push({ path, code: "maxProperties", message: `${path} must contain at most ${schema.maxProperties} properties` });
    }
    for (const required of schema.required || []) {
      if (record[required] === undefined) {
        errors.push({ path: `${path}.${required}`, code: "required", message: `${path}.${required} is required` });
      }
    }
    const props = schema.properties || {};
    for (const [key, childValue] of Object.entries(record)) {
      if (Object.prototype.hasOwnProperty.call(props, key)) {
        validateValue(childValue, props[key], `${path}.${key}`, errors);
        continue;
      }
      if (schema.additionalProperties === false) {
        errors.push({ path: `${path}.${key}`, code: "additionalProperties", message: `${path}.${key} is not a supported parameter` });
        continue;
      }
      if (schema.additionalProperties && typeof schema.additionalProperties === "object") {
        validateValue(childValue, schema.additionalProperties, `${path}.${key}`, errors);
      }
    }
  }
}

function cachedPatternRegExp(pattern) {
  let re = PATTERN_CACHE.get(pattern);
  if (!re) {
    re = new RegExp(pattern);
    PATTERN_CACHE.set(pattern, re);
  }
  return re;
}

/**
 * @param {unknown} value
 * @param {string | string[]} type
 */
function matchesType(value, type) {
  const types = Array.isArray(type) ? type : [type];
  return types.some((candidate) => {
    switch (candidate) {
      case "array":
        return Array.isArray(value);
      case "object":
        return value !== null && typeof value === "object" && !Array.isArray(value);
      case "integer":
        return Number.isInteger(value);
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "string":
      case "boolean":
        return typeof value === candidate;
      default:
        return true;
    }
  });
}

/**
 * @param {JsonSchema} schema
 * @returns {JsonSchema}
 */
function cloneJsonSchema(schema) {
  return /** @type {JsonSchema} */ (JSON.parse(JSON.stringify(schema)));
}
