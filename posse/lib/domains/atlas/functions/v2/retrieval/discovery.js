// @ts-check
//
// Native ATLAS v2 action discovery and compact manual surfaces. These are
// generated from the current v2 descriptor table so they cannot drift into
// old ATLAS sidecar behavior.

import { ATLAS_TOOL_ACTIONS } from "../contracts/tool-params.js";
import { ATLAS_TOOL_DEFS, TOOL_EXECUTION_SPECS, isAtlasActionSurfaced } from "../../../../integrations/functions/deterministic-mcp/tool-descriptors.js";
import { okEnvelope } from "./envelope.js";

const ACTION_SET = new Set(ATLAS_TOOL_ACTIONS);

/**
 * @param {{
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").ActionSearchParams,
 * }} args
 */
export function actionSearch({ versionId, params = {} }) {
  const query = String(params.query || "").trim();
  const namespace = String(params.namespace || "").trim();
  const limit = clampInt(params.limit, 1, 100, 20);
  const offset = clampInt(params.offset, 0, 10_000, 0);
  const matches = actionEntries()
    .filter((entry) => !namespace || entry.namespace === namespace)
    .map((entry) => ({ ...entry, score: scoreEntry(entry, query) }))
    .filter((entry) => !query || entry.score > 0)
    .sort((a, b) => b.score - a.score || a.action.localeCompare(b.action));
  const page = matches.slice(offset, offset + limit);
  return okEnvelope({
    action: "action.search",
    versionId,
    data: {
      query,
      namespace: namespace || null,
      total: matches.length,
      offset,
      limit,
      actions: page,
    },
  });
}

/**
 * @param {{
 *   versionId: string,
 *   params?: import("../contracts/tool-params.js").ManualParams,
 * }} args
 */
export function manual({ versionId, params = {} }) {
  const query = String(params.query || "").trim();
  const requested = Array.isArray(params.actions)
    ? params.actions
      .map((action) => String(action || "").trim())
      .filter((action) => ACTION_SET.has(/** @type {any} */ (action)) && isAtlasActionSurfaced(action))
    : [];
  const includeSchemas = params.includeSchemas === true;
  const includeExamples = params.includeExamples === true;
  const format = params.format === "json" ? "json" : "text";
  let entries = actionEntries();
  if (requested.length > 0) {
    const requestedSet = new Set(requested);
    entries = entries.filter((entry) => requestedSet.has(entry.action));
  }
  if (query) {
    entries = entries
      .map((entry) => ({ ...entry, score: scoreEntry(entry, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || a.action.localeCompare(b.action));
  }
  const actions = entries
    .slice(0, clampInt(params.limit, 1, 100, 50))
    .map((entry) => manualEntry(entry, { includeSchemas, includeExamples }));
  const manualText = format === "json"
    ? JSON.stringify({ query, actions }, null, 2)
    : renderManual(actions, includeExamples);
  return okEnvelope({
    action: "manual",
    versionId,
    data: {
      query,
      format,
      actions,
      manual: manualText,
      tokenEstimate: Math.ceil(manualText.length / 4),
    },
  });
}

function actionEntries() {
  return ATLAS_TOOL_ACTIONS.filter(isAtlasActionSurfaced).map((action) => {
    const def = /** @type {any} */ (ATLAS_TOOL_DEFS[action] || {});
    const schema = def.parameters || {};
    const spec = /** @type {any} */ (TOOL_EXECUTION_SPECS[action] || {});
    return {
      action,
      toolName: def.name || `atlas_${action.replace(/\./g, "_")}`,
      namespace: namespaceOf(action),
      description: String(def.description || spec.summary || ""),
      summary: String(spec.summary || def.description || ""),
      required: Array.isArray(schema.required) ? schema.required : [],
      parameters: parameterSummary(schema),
      tags: actionTags(action),
      examples: examplesFor(action),
      prerequisites: prerequisitesFor(action),
      recommendedNextActions: nextActionsFor(action),
    };
  });
}

function manualEntry(entry, { includeSchemas, includeExamples }) {
  const def = ATLAS_TOOL_DEFS[entry.action] || {};
  return {
    action: entry.action,
    toolName: entry.toolName,
    namespace: entry.namespace,
    description: entry.description,
    required: entry.required,
    parameters: entry.parameters,
    tags: entry.tags,
    prerequisites: entry.prerequisites,
    recommendedNextActions: entry.recommendedNextActions,
    ...(includeExamples ? { examples: entry.examples } : {}),
    ...(includeSchemas ? { schema: def.parameters || null } : {}),
  };
}

function renderManual(actions, includeExamples) {
  return actions.map((entry) => {
    const params = entry.parameters
      .map((param) => renderParamLabel(param, entry.required.includes(param.name)))
      .join(", ");
    const prereqs = entry.prerequisites?.length ? ` Prereqs: ${entry.prerequisites.join("; ")}.` : "";
    const next = entry.recommendedNextActions?.length ? ` Next: ${entry.recommendedNextActions.join(", ")}.` : "";
    const examples = includeExamples && entry.examples?.length
      ? ` Examples: ${entry.examples.map((example) => JSON.stringify(example)).join(" ")}`
      : "";
    return `- ${entry.action}: ${entry.description}${params ? ` Params: ${params}.` : ""}${prereqs}${next}${examples}`;
  }).join("\n");
}

function renderParamLabel(param, required) {
  const enumValues = Array.isArray(param.enumValues) && param.enumValues.length > 0
    ? `[${param.enumValues.map(String).join("|")}]`
    : "";
  const defaultValue = Object.prototype.hasOwnProperty.call(param, "default")
    ? `=${String(param.default)}`
    : "";
  return `${param.name}${required ? "*" : ""}${enumValues}${defaultValue}`;
}

function parameterSummary(schema) {
  const properties = schema && typeof schema === "object" && schema.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  return Object.entries(properties).map(([name, detail]) => ({
    name,
    type: Array.isArray(/** @type {any} */ (detail).type)
      ? /** @type {any} */ (detail).type.join("|")
      : String(/** @type {any} */ (detail).type || (/** @type {any} */ (detail).enum ? "enum" : "object")),
    description: String(/** @type {any} */ (detail).description || ""),
    ...(Object.prototype.hasOwnProperty.call(/** @type {any} */ (detail), "default")
      ? { default: /** @type {any} */ (detail).default }
      : {}),
    ...(Array.isArray(/** @type {any} */ (detail).enum)
      ? { enumValues: /** @type {any} */ (detail).enum }
      : {}),
  }));
}

function scoreEntry(entry, query) {
  if (!query) return 1;
  const needles = query.toLowerCase().split(/[^a-z0-9_.-]+/).filter(Boolean);
  if (needles.length === 0) return 1;
  const haystacks = [
    entry.action,
    entry.toolName,
    entry.namespace,
    entry.description,
    entry.summary,
    entry.parameters.map((p) => `${p.name} ${p.description}`).join(" "),
  ].map((text) => String(text || "").toLowerCase());
  let score = 0;
  for (const needle of needles) {
    for (const haystack of haystacks) {
      if (haystack === needle) score += 8;
      else if (haystack.includes(needle)) score += 2;
    }
  }
  return score;
}

function namespaceOf(action) {
  const text = String(action || "");
  const idx = text.indexOf(".");
  return idx === -1 ? text : text.slice(0, idx);
}

function actionTags(action) {
  const ns = namespaceOf(action);
  const tags = new Set([ns]);
  if (["symbol.search", "symbol.card", "symbol.overview", "tree.overview", "tree.branch", "tree.scope", "tree.expand", "slice.build", "edit.plan", "context"].includes(action)) tags.add("query");
  if (["buffer.push", "buffer.checkpoint", "memory.store", "policy.set", "agent.feedback", "index.refresh", "scip.ingest"].includes(action)) tags.add("mutates");
  if (action === "workflow" || action.startsWith("runtime.")) tags.add("orchestration");
  return [...tags].filter(Boolean);
}

function examplesFor(action) {
  const examples = {
    "symbol.search": [{ action, query: "auth middleware", limit: 5 }],
    "symbol.card": [{ action, symbolId: "<symbolId>", includeResolutionMetadata: true }],
    "symbol.overview": [{ action, symbolId: "<symbolId>", kind: ["calls", "references"], limit: 25 }],
    "tree.overview": [{ action, maxDepth: 2, limit: 50 }],
    "tree.branch": [{ action, path: "lib/domains/atlas", maxDepth: 2, limit: 50 }],
    "tree.scope": [{ action, taskText: "fix auth middleware regression", maxFiles: 40, branchFileCap: 20 }],
    "tree.expand": [{ action, paths: ["lib/auth/middleware.ts"], maxFiles: 40, branchFileCap: 20 }],
    "slice.build": [{ action, taskText: "debug auth middleware", budget: { maxCards: 8 } }],
    "edit.plan": [{ action, targetSymbols: ["<symbolId>"], search: "oldName", replace: "newName" }],
    "code.window": [{ action, symbolId: "<symbolId>", reason: "Need implementation details after card/skeleton", identifiersToFind: ["handler"], expectedLines: 80 }],
    "repo.overview": [{ action, level: "full", includeHotspots: true }],
    "workflow": [{ action, steps: [{ id: "search", action: "symbol.search", args: { query: "Greeter", limit: 1 } }] }],
    "memory.store": [{ action, title: "Why", content: "Decision details", symbolIds: ["<symbolId>"] }],
  };
  return examples[action] || [{ action }];
}

function prerequisitesFor(action) {
  if (action === "repo.register") return ["A repoRoot must be available in params or dispatch context."];
  if (action === "index.refresh") return ["The repo should be registered or have a writable ATLAS ledger path."];
  if (action === "symbol.card" || action === "symbol.overview") return ["Use symbol.search first when you do not already have a symbolId."];
  if (action === "tree.overview" || action === "tree.branch") return ["Run index.refresh first if tree-derived state is missing or stale."];
  if (action === "tree.scope") return ["Prefetch-only: the handoff runs this with the full task text. Agents should use tree.expand with validated seeds instead."];
  if (action === "tree.expand") return ["Seed with files/areas already validated (from the brief, tree.branch, or symbol.overview locations)."];
  if (action.startsWith("slice.") || action === "context") return ["Start from symbol.search, symbol.card, or taskText."];
  if (action === "edit.plan") return ["Resolve target symbols with symbol.search or target files with file.read/search first."];
  if (action.startsWith("runtime.")) return ["Runtime execution must be enabled by ATLAS policy."];
  if (action.startsWith("memory.")) return ["Memory policy must be enabled for the repo."];
  return [];
}

function nextActionsFor(action) {
  const next = {
    "symbol.search": ["symbol.card", "symbol.overview", "slice.build", "code.skeleton"],
    "symbol.card": ["symbol.overview", "tree.branch", "tree.scope", "slice.build", "code.window", "agent.feedback"],
    "symbol.overview": ["symbol.card", "tree.branch", "tree.scope", "slice.build", "code.window"],
    "tree.overview": ["tree.branch", "tree.scope", "symbol.card", "slice.build", "code.skeleton"],
    "tree.branch": ["tree.expand", "symbol.card", "slice.build", "code.skeleton"],
    "tree.scope": ["slice.build", "context", "code.skeleton", "review.analyze"],
    "tree.expand": ["tree.branch", "code.skeleton", "symbol.search", "slice.build"],
    "slice.build": ["slice.refresh", "agent.feedback", "context"],
    "edit.plan": ["code.skeleton", "code.lens", "file.read"],
    "repo.register": ["index.refresh", "repo.status"],
    "index.refresh": ["repo.status", "symbol.search"],
    "buffer.push": ["symbol.search", "buffer.checkpoint", "buffer.status"],
    "memory.store": ["memory.surface", "memory.get"],
    "runtime.execute": ["runtime.queryOutput"],
  };
  return next[action] || [];
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
