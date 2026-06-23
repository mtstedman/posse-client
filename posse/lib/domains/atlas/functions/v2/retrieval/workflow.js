// @ts-check
//
// Native ATLAS v2 workflow runner. This is a small in-process orchestrator
// for ATLAS actions and deterministic data transforms. It deliberately routes
// through native v2 dispatch callbacks instead of reintroducing atlas-mcp.

import { ATLAS_TOOL_ACTIONS } from "../contracts/tool-params.js";
import { okEnvelope, errorEnvelope } from "./envelope.js";

/** @typedef {import("../contracts/tool-params.js").ToolCall} ToolCall */
/** @typedef {import("../contracts/tool-params.js").WorkflowParams} WorkflowParams */
/** @typedef {import("../contracts/tool-results.js").AnyToolResult} AnyToolResult */

const ACTION_SET = new Set(ATLAS_TOOL_ACTIONS);
const TRANSFORM_SET = new Set(["dataPick", "dataMap", "dataFilter", "dataSort", "dataTemplate"]);
const DEFAULT_MAX_STEPS = 25;
const DEFAULT_MAX_TOKENS = 100_000;
const DEFAULT_MAX_DURATION_MS = 120_000;
const REF_PATTERN = /\$([A-Za-z_][\w-]*|\d+)((?:(?:\??\.[A-Za-z_][\w-]*)|(?:\??\[\d+\]))*)/g;
const REF_PATTERN_SINGLE = new RegExp(`^${REF_PATTERN.source}$`);
const BLOCKED_PATH_PROPS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * @param {{
 *   versionId: string,
 *   params: WorkflowParams,
 *   runAction: (call: ToolCall) => AnyToolResult | Promise<AnyToolResult>,
 * }} args
 */
export async function workflowExecute({ versionId, params, runAction }) {
  const startedAt = Date.now();
  const steps = Array.isArray(params.steps) ? params.steps : [];
  if (steps.length === 0) {
    return errorEnvelope({
      action: "workflow",
      versionId,
      code: "invalid_workflow",
      message: "workflow requires at least one step",
    });
  }

  const limits = workflowLimits(params);
  const validation = validateWorkflow(steps);
  if (params.dryRun === true) {
    return okEnvelope({
      action: "workflow",
      versionId,
      data: {
        results: [],
        totalTokens: 0,
        durationMs: Date.now() - startedAt,
        truncated: false,
        dryRun: {
          valid: validation.every((entry) => entry.valid),
          validation,
          stepCount: steps.length,
          budgetLimits: limits,
        },
      },
    });
  }

  /** @type {unknown[]} */
  const priorResults = [];
  /** @type {Map<string, unknown>} */
  const priorById = new Map();
  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  /** @type {Array<Record<string, unknown>>} */
  const traceSteps = [];
  let totalTokens = 0;
  let truncated = false;

  for (let i = 0; i < steps.length; i += 1) {
    const step = normalizeStep(steps[i], i);
    if (i >= limits.maxSteps) {
      truncated = true;
      pushSkippedForBudget({ results, steps, fromIndex: i, reason: `maxSteps ${limits.maxSteps} exceeded` });
      break;
    }
    if (Date.now() - startedAt > limits.maxDurationMs) {
      truncated = true;
      pushSkippedForBudget({ results, steps, fromIndex: i, reason: `maxDurationMs ${limits.maxDurationMs} exceeded` });
      break;
    }
    if (totalTokens >= limits.maxTotalTokens) {
      truncated = true;
      pushSkippedForBudget({ results, steps, fromIndex: i, reason: `maxTotalTokens ${limits.maxTotalTokens} exceeded` });
      break;
    }

    const stepStartedAt = Date.now();
    let resolvedArgs;
    try {
      resolvedArgs = resolveRefs(step.args, priorResults, priorById);
    } catch (err) {
      const entry = errorStep({
        step,
        durationMs: Date.now() - stepStartedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      results.push(entry);
      priorResults.push(null);
      if (step.id) priorById.set(step.id, null);
      traceSteps.push(traceStep({ step, entry, resolvedArgs: null, trace: params.trace }));
      if ((params.onError || "continue") === "stop") {
        pushSkippedAfterError({ results, steps, fromIndex: i + 1 });
        break;
      }
      continue;
    }

    try {
      const executed = step.transform
        ? executeTransform(step.fn, resolvedArgs)
        : await executeActionStep({ step, resolvedArgs, params, runAction });
      const tokens = estimateTokens(executed);
      const stepResult = maybeTruncateStep({
        step,
        result: executed,
        tokens,
        defaultMaxResponseTokens: params.defaultMaxResponseTokens,
      });
      const entry = {
        stepIndex: i,
        ...(step.id ? { id: step.id } : {}),
        fn: step.fn,
        ...(step.action ? { action: step.action } : {}),
        status: "ok",
        result: stepResult.result,
        tokens: stepResult.tokens,
        durationMs: Date.now() - stepStartedAt,
        ...(stepResult.truncatedResponse ? { truncatedResponse: stepResult.truncatedResponse } : {}),
      };
      results.push(entry);
      priorResults.push(executed);
      if (step.id) priorById.set(step.id, executed);
      totalTokens += stepResult.tokens;
      traceSteps.push(traceStep({ step, entry, resolvedArgs, trace: params.trace }));
    } catch (err) {
      const entry = errorStep({
        step,
        durationMs: Date.now() - stepStartedAt,
        error: err instanceof Error ? err.message : String(err),
      });
      results.push(entry);
      priorResults.push(null);
      if (step.id) priorById.set(step.id, null);
      traceSteps.push(traceStep({ step, entry, resolvedArgs, trace: params.trace }));
      if ((params.onError || "continue") === "stop") {
        pushSkippedAfterError({ results, steps, fromIndex: i + 1 });
        break;
      }
    }
  }

  let responseResults = results;
  if (params.onlyFinalResult === true && responseResults.length > 1) {
    const lastIdx = responseResults.length - 1;
    responseResults = responseResults.map((entry, index) => (
      index === lastIdx
        ? entry
        : { ...entry, result: null, tokens: 0 }
    ));
    totalTokens = responseResults.reduce((sum, entry) => sum + Number(entry.tokens || 0), 0);
  }

  const data = {
    results: responseResults,
    totalTokens,
    durationMs: Date.now() - startedAt,
    truncated,
    ...(params.trace ? {
      trace: {
        steps: traceSteps,
        totals: {
          durationMs: Date.now() - startedAt,
          tokens: totalTokens,
          stepsExecuted: results.filter((entry) => entry.status === "ok" || entry.status === "error").length,
        },
      },
    } : {}),
  };
  return okEnvelope({ action: "workflow", versionId, data });
}

/**
 * @param {WorkflowParams} params
 */
function workflowLimits(params) {
  const budget = params.budget && typeof params.budget === "object" ? params.budget : {};
  return {
    maxSteps: clampInt(/** @type {any} */ (budget).maxSteps, 1, 50, DEFAULT_MAX_STEPS),
    maxTotalTokens: clampInt(/** @type {any} */ (budget).maxTotalTokens, 100, 500_000, DEFAULT_MAX_TOKENS),
    maxDurationMs: clampInt(/** @type {any} */ (budget).maxDurationMs, 100, 300_000, DEFAULT_MAX_DURATION_MS),
  };
}

/**
 * @param {unknown} rawStep
 * @param {number} index
 */
function normalizeStep(rawStep, index) {
  const step = rawStep && typeof rawStep === "object" && !Array.isArray(rawStep)
    ? /** @type {Record<string, unknown>} */ (rawStep)
    : {};
  const fnRaw = String(step.fn || step.action || "").trim();
  const action = resolveActionName(String(step.action || fnRaw));
  const transform = TRANSFORM_SET.has(fnRaw);
  return {
    stepIndex: index,
    id: typeof step.id === "string" && step.id.trim() ? step.id.trim() : null,
    fn: fnRaw || action || `<step:${index}>`,
    action: transform ? null : action,
    transform,
    args: step.args && typeof step.args === "object" ? step.args : {},
    maxResponseTokens: step.maxResponseTokens,
  };
}

function resolveActionName(name) {
  const raw = String(name || "").trim();
  if (!raw) return null;
  const stripped = raw.startsWith("atlas.") ? raw.slice("atlas.".length) : raw;
  if (ACTION_SET.has(/** @type {any} */ (stripped))) return stripped;
  const alias = camelToAction(stripped);
  return ACTION_SET.has(/** @type {any} */ (alias)) ? alias : null;
}

function camelToAction(value) {
  const aliases = {
    symbolSearch: "symbol.search",
    symbolGetCard: "symbol.card",
    sliceBuild: "slice.build",
    sliceRefresh: "slice.refresh",
    sliceSpilloverGet: "slice.spillover.get",
    codeGetSkeleton: "code.skeleton",
    codeGetHotPath: "code.lens",
    codeNeedWindow: "code.window",
    contextSummary: "context.summary",
    repoRegister: "repo.register",
    repoStatus: "repo.status",
    indexRefresh: "index.refresh",
    repoOverview: "repo.overview",
    repoQuality: "repo.quality",
    agentFeedback: "agent.feedback",
    agentFeedbackQuery: "agent.feedback.query",
    deltaGet: "review.delta",
    prRiskAnalyze: "review.analyze",
    prRisk: "review.risk",
    fileRead: "file.read",
    memoryStore: "memory.store",
    memoryQuery: "memory.query",
    memoryRemove: "memory.remove",
    memorySurface: "memory.surface",
    policyGet: "policy.get",
    policySet: "policy.set",
    usageStats: "usage.stats",
    scipIngest: "scip.ingest",
    runtimeExecute: "runtime.execute",
    runtimeQueryOutput: "runtime.queryOutput",
  };
  return aliases[value] || value;
}

/**
 * @param {{ step: ReturnType<typeof normalizeStep>, resolvedArgs: Record<string, unknown>, params: WorkflowParams, runAction: (call: ToolCall) => AnyToolResult | Promise<AnyToolResult> }} args
 */
async function executeActionStep({ step, resolvedArgs, params, runAction }) {
  if (!step.action) throw new Error(`Unknown ATLAS action for workflow step: ${step.fn}`);
  if (step.action === "workflow") throw new Error("workflow steps cannot recursively call workflow");
  if (step.action === "file.write" || step.fn === "fileWrite") {
    throw new Error("file.write is not exposed in native ATLAS v2; use write_file/edit_file outside workflow");
  }
  const call = /** @type {ToolCall} */ ({
    action: step.action,
    ...(params.repoId && !("repoId" in resolvedArgs) ? { repoId: params.repoId } : {}),
    ...resolvedArgs,
  });
  const envelope = await Promise.resolve(runAction(call));
  if (!envelope || envelope.ok !== true) {
    const err = /** @type {any} */ (envelope)?.error;
    throw new Error(err?.message || err?.code || `ATLAS action failed: ${step.action}`);
  }
  return unwrapEnvelope(envelope);
}

function unwrapEnvelope(envelope) {
  const data = /** @type {any} */ (envelope).data === undefined ? {} : /** @type {any} */ (envelope).data;
  const meta = /** @type {any} */ (envelope).meta;
  if (meta && data && typeof data === "object" && !Array.isArray(data)) {
    return { ...data, _meta: meta };
  }
  return data;
}

function executeTransform(fn, args) {
  switch (fn) {
    case "dataPick":
      return dataPick(args);
    case "dataMap":
      return dataMap(args);
    case "dataFilter":
      return dataFilter(args);
    case "dataSort":
      return dataSort(args);
    case "dataTemplate":
      return dataTemplate(args);
    default:
      throw new Error(`Unknown workflow transform: ${fn}`);
  }
}

function dataPick(args) {
  const input = /** @type {any} */ (args).input;
  const fields = objectFields(/** @type {any} */ (args).fields);
  const source = input && typeof input === "object" ? input : { value: input };
  const out = {};
  for (const [key, path] of Object.entries(fields)) out[key] = valueAtPath(source, String(path));
  return out;
}

function dataMap(args) {
  const input = /** @type {any} */ (args).input;
  if (!Array.isArray(input)) throw new Error("dataMap requires array input");
  const fields = objectFields(/** @type {any} */ (args).fields);
  return input.map((item) => {
    const out = {};
    for (const [key, path] of Object.entries(fields)) out[key] = valueAtPath(item, String(path));
    return out;
  });
}

function dataFilter(args) {
  const input = /** @type {any} */ (args).input;
  if (!Array.isArray(input)) throw new Error("dataFilter requires array input");
  const clauses = Array.isArray(/** @type {any} */ (args).clauses) ? /** @type {any[]} */ (/** @type {any} */ (args).clauses) : [];
  if (clauses.length === 0) throw new Error("dataFilter requires clauses");
  const mode = /** @type {any} */ (args).mode === "any" ? "any" : "all";
  return input.filter((item) => {
    const checks = clauses.map((clause) => matchesClause(item, clause));
    return mode === "any" ? checks.some(Boolean) : checks.every(Boolean);
  });
}

function dataSort(args) {
  const input = /** @type {any} */ (args).input;
  if (!Array.isArray(input)) throw new Error("dataSort requires array input");
  const by = Array.isArray(/** @type {any} */ (args).by) ? /** @type {any[]} */ (/** @type {any} */ (args).by) : [/** @type {any} */ (args).by];
  const specs = by.filter((spec) => spec && typeof spec === "object");
  if (specs.length === 0) throw new Error("dataSort requires by");
  return [...input].sort((a, b) => compareBySpecs(a, b, specs));
}

function dataTemplate(args) {
  const input = /** @type {any} */ (args).input;
  const template = String(/** @type {any} */ (args).template || "");
  if (!template) throw new Error("dataTemplate requires template");
  const joinWith = String(/** @type {any} */ (args).joinWith ?? "\n");
  if (Array.isArray(input)) return input.map((item) => renderTemplate(template, item)).join(joinWith);
  return renderTemplate(template, input);
}

function objectFields(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("fields must be an object mapping output keys to source paths");
  }
  return /** @type {Record<string, unknown>} */ (value);
}

function matchesClause(item, clause) {
  const path = String(clause?.path || "");
  const op = String(clause?.op || "eq");
  const actual = valueAtPath(item, path);
  const expected = clause?.value;
  if (op === "exists") return actual !== undefined && actual !== null;
  if (op === "eq") return actual === expected;
  if (op === "ne") return actual !== expected;
  if (op === "contains") {
    if (typeof actual === "string") return actual.includes(String(expected ?? ""));
    return Array.isArray(actual) ? actual.includes(expected) : false;
  }
  if (op === "in") return Array.isArray(expected) ? expected.includes(actual) : false;
  const a = Number(actual);
  const b = Number(expected);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return false;
  if (op === "gt") return a > b;
  if (op === "gte") return a >= b;
  if (op === "lt") return a < b;
  if (op === "lte") return a <= b;
  return false;
}

function compareBySpecs(a, b, specs) {
  for (const spec of specs) {
    const av = valueAtPath(a, String(spec.path || ""));
    const bv = valueAtPath(b, String(spec.path || ""));
    const direction = spec.direction === "desc" ? -1 : 1;
    const cmp = compareValues(av, bv, spec.type || "string");
    if (cmp !== 0) return cmp * direction;
  }
  return 0;
}

function compareValues(a, b, type) {
  if (type === "number") return (Number(a) || 0) - (Number(b) || 0);
  if (type === "boolean") return (a ? 1 : 0) - (b ? 1 : 0);
  if (type === "date") return new Date(String(a || "")).getTime() - new Date(String(b || "")).getTime();
  return String(a ?? "").localeCompare(String(b ?? ""));
}

function renderTemplate(template, input) {
  return template.replace(/\{\{([^}]+)\}\}/g, (_match, path) => {
    const value = valueAtPath(input, String(path).trim());
    if (value == null) return "";
    return typeof value === "object" ? JSON.stringify(value) : String(value);
  });
}

function resolveRefs(value, priorResults, priorById) {
  if (typeof value === "string") return resolveRefString(value, priorResults, priorById);
  if (Array.isArray(value)) return value.map((entry) => resolveRefs(entry, priorResults, priorById));
  if (value && typeof value === "object") {
    const out = {};
    for (const [key, inner] of Object.entries(value)) out[key] = resolveRefs(inner, priorResults, priorById);
    return out;
  }
  return value;
}

function resolveRefString(value, priorResults, priorById) {
  const trimmed = value.trim();
  const direct = REF_PATTERN_SINGLE.exec(trimmed);
  if (direct) return resolveWorkflowRef(direct[1], direct[2] || "", priorResults, priorById);
  REF_PATTERN.lastIndex = 0;
  if (!REF_PATTERN.test(value)) return value;
  REF_PATTERN.lastIndex = 0;
  return value.replace(REF_PATTERN, (_match, ref, path) => {
    const resolved = resolveWorkflowRef(ref, path || "", priorResults, priorById);
    if (resolved == null) return "";
    return typeof resolved === "object" ? JSON.stringify(resolved) : String(resolved);
  });
}

function resolveWorkflowRef(ref, path, priorResults, priorById) {
  const target = /^\d+$/.test(ref)
    ? priorResults[Number(ref)]
    : priorById.get(ref);
  if (target === undefined) throw new Error(`Unresolved workflow reference: $${ref}`);
  if (!path) return target;
  const resolved = valueAtPath(target, path);
  if (resolved === undefined && !hasOptionalPathSegment(path)) {
    throw new Error(`Unresolved workflow reference path: $${ref}${path}`);
  }
  return resolved;
}

function valueAtPath(input, rawPath) {
  if (rawPath === "" || rawPath == null) return input;
  const segments = parsePathSegments(String(rawPath));
  if (segments.length === 0) return input;
  let current = input;
  for (const segment of segments) {
    const part = segment.key;
    if (part === "length" && (Array.isArray(current) || typeof current === "string")) {
      current = current.length;
      continue;
    }
    if (current == null) return undefined;
    if (/^\d+$/.test(part)) {
      if (!Array.isArray(current)) return undefined;
      current = current[Number(part)];
      continue;
    }
    if (typeof current !== "object") return undefined;
    if (BLOCKED_PATH_PROPS.has(part)) return undefined;
    current = /** @type {Record<string, unknown>} */ (current)[part];
    if (current === undefined && segment.optional) return undefined;
  }
  return current;
}

function hasOptionalPathSegment(path) {
  return /\?\./.test(path) || /\?\[/.test(path);
}

function parsePathSegments(rawPath) {
  const path = rawPath.replace(/^\./, "");
  if (!path) return [];
  /** @type {{ key: string, optional: boolean }[]} */
  const segments = [];
  let index = 0;
  while (index < path.length) {
    let optional = false;
    if (path.startsWith("?.", index)) {
      optional = true;
      index += 2;
    } else if (path[index] === ".") {
      index += 1;
    } else if (path.startsWith("?[", index)) {
      optional = true;
      index += 1;
    }

    if (path[index] === "[") {
      const end = path.indexOf("]", index);
      if (end === -1) return [];
      const key = path.slice(index + 1, end);
      if (!/^\d+$/.test(key)) return [];
      segments.push({ key, optional });
      index = end + 1;
      continue;
    }

    const match = /^[A-Za-z_][\w-]*/.exec(path.slice(index));
    if (!match) return [];
    segments.push({ key: match[0], optional });
    index += match[0].length;
  }
  return segments;
}

function maybeTruncateStep({ step, result, tokens, defaultMaxResponseTokens }) {
  const maxTokens = clampInt(step.maxResponseTokens, 50, 100_000, clampInt(defaultMaxResponseTokens, 50, 100_000, 0));
  if (!maxTokens || tokens <= maxTokens) return { result, tokens };
  const text = JSON.stringify(result);
  const keptText = text.slice(0, maxTokens * 4);
  return {
    result: { preview: keptText, truncated: true },
    tokens: maxTokens,
    truncatedResponse: {
      originalTokens: tokens,
      keptTokens: maxTokens,
    },
  };
}

function errorStep({ step, durationMs, error }) {
  return {
    stepIndex: step.stepIndex,
    ...(step.id ? { id: step.id } : {}),
    fn: step.fn,
    ...(step.action ? { action: step.action } : {}),
    status: "error",
    result: null,
    tokens: 0,
    durationMs,
    error,
  };
}

function traceStep({ step, entry, resolvedArgs, trace }) {
  if (!trace) return {};
  const maxPreviewTokens = clampInt(trace.maxPreviewTokens, 10, 2000, 200);
  return {
    stepIndex: step.stepIndex,
    fn: step.fn,
    ...(step.action ? { action: step.action } : {}),
    kind: step.transform ? "transform" : "action",
    status: String(entry.status || ""),
    durationMs: Number(entry.durationMs || 0),
    tokens: Number(entry.tokens || 0),
    summary: entry.error ? `${step.fn}: ${entry.error}` : `${step.fn}: ${entry.tokens || 0} tokens`,
    ...(trace.level === "verbose" && trace.includeResolvedArgs ? { resolvedArgsPreview: preview(resolvedArgs, maxPreviewTokens) } : {}),
    ...(trace.level === "verbose" ? { resultPreview: preview(entry.result, maxPreviewTokens) } : {}),
  };
}

function pushSkippedForBudget({ results, steps, fromIndex, reason }) {
  for (let i = fromIndex; i < steps.length; i += 1) {
    const step = normalizeStep(steps[i], i);
    results.push({
      stepIndex: i,
      ...(step.id ? { id: step.id } : {}),
      fn: step.fn,
      ...(step.action ? { action: step.action } : {}),
      status: "budget_exceeded",
      result: null,
      tokens: 0,
      durationMs: 0,
      error: reason,
    });
  }
}

function pushSkippedAfterError({ results, steps, fromIndex }) {
  for (let i = fromIndex; i < steps.length; i += 1) {
    const step = normalizeStep(steps[i], i);
    results.push({
      stepIndex: i,
      ...(step.id ? { id: step.id } : {}),
      fn: step.fn,
      ...(step.action ? { action: step.action } : {}),
      status: "skipped",
      result: null,
      tokens: 0,
      durationMs: 0,
    });
  }
}

function validateWorkflow(steps) {
  const priorIds = new Set();
  return steps.map((rawStep, index) => {
    const step = normalizeStep(rawStep, index);
    const issues = [];
    if (!step.transform && !step.action) issues.push(`Unknown function/action: ${step.fn}`);
    if (step.action === "workflow") issues.push("workflow cannot call itself");
    for (const ref of findRefs(step.args)) {
      if (/^\d+$/.test(ref) && Number(ref) >= index) issues.push(`Reference $${ref} points to a future step`);
      if (!/^\d+$/.test(ref) && !priorIds.has(ref)) issues.push(`Reference $${ref} does not match an earlier step id`);
    }
    if (step.id) priorIds.add(step.id);
    return {
      stepIndex: index,
      ...(step.id ? { id: step.id } : {}),
      fn: step.fn,
      action: step.action || step.fn,
      valid: issues.length === 0,
      issues,
    };
  });
}

function findRefs(value, out = new Set()) {
  if (typeof value === "string") {
    REF_PATTERN.lastIndex = 0;
    let match;
    while ((match = REF_PATTERN.exec(value)) !== null) out.add(match[1]);
  } else if (Array.isArray(value)) {
    for (const entry of value) findRefs(entry, out);
  } else if (value && typeof value === "object") {
    for (const entry of Object.values(value)) findRefs(entry, out);
  }
  return [...out];
}

function estimateTokens(value) {
  try {
    return Math.max(1, Math.ceil(JSON.stringify(value).length / 4));
  } catch {
    return Math.max(1, Math.ceil(String(value ?? "").length / 4));
  }
}

function preview(value, maxTokens) {
  const text = (() => {
    try { return JSON.stringify(value); } catch { return String(value); }
  })();
  const maxChars = maxTokens * 4;
  return text.length > maxChars ? `${text.slice(0, maxChars)}...` : text;
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
