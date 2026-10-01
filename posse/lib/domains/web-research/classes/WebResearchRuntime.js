import {
  RESEARCH_AGENT_TYPES,
  RESEARCH_CHILD_DEFAULT_MODEL_TIERS,
  RESEARCH_CHILD_FALLBACK_MODEL_TIER,
} from "../../../catalog/planner-dispatch.js";
import { readPlannerDispatchPolicy } from "../../planning/functions/planner-dispatch-policy.js";
import { subAgentRuntime } from "../../sub-agent/classes/SubAgentRuntime.js";
import { RESEARCH_CHILD_PROFILE, SUB_AGENT_PROTOCOL } from "../../../catalog/sub-agent.js";
// @ts-check

import crypto from "node:crypto";

import { SETTING_KEYS } from "../../../catalog/settings.js";
import {
  WEB_RESEARCH_FINDING_OBJECT_TYPE,
  WEB_RESEARCH_HANDOFF_OVERSIZED_OBSERVATION_TYPE,
  WEB_RESEARCH_LIMITS,
  WEB_RESEARCH_PROTOCOL,
} from "../../../catalog/web-research.js";
import { getSetting } from "../../queue/functions/index.js";
import { surfaceHashRefForContext } from "../../queue/functions/hash-refs.js";
import { agentHandoffTerminator } from "../../handoff/classes/AgentHandoffTerminator.js";
import { hashRefModelVisibility } from "../../../shared/tools/functions/fetch-ref-policy.js";
import { recordObservation } from "../../observability/functions/observations.js";
import { captureWebSources, normalizeNominatedSources } from "../functions/source-snapshots.js";
import {
  extractUrls,
  recordReportSalvaged,
  salvageableWebReportText,
  surfaceWebResearchReport,
} from "../functions/research-report.js";

function runtimeError(code, message, { retryable = false, stage = "runtime" } = {}) {
  const error = /** @type {Error & {code: string, retryable: boolean, stage: string}} */ (new Error(message));
  error.code = code;
  error.retryable = retryable;
  error.stage = stage;
  return error;
}

function positiveId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function exactObject(value, keys, label) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)) {
    throw runtimeError("WEB_RESEARCH_SCHEMA_INVALID", `${label} must be an object`, { stage: "validation" });
  }
  for (const key of Object.keys(value)) {
    if (!keys.includes(key)) {
      throw runtimeError("WEB_RESEARCH_SCHEMA_INVALID", `${label}.${key} is not allowed`, { stage: "validation" });
    }
  }
  return value;
}

// dispatch_agent arguments arrive from a model: an extra key is ignored rather
// than rejected, because a rejection costs the planner a whole turn and the
// keys the runtime needs are validated on their own.
function knownKeysObject(value, keys, label) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  if (!value
    || typeof value !== "object"
    || Array.isArray(value)
    || (prototype !== Object.prototype && prototype !== null)) {
    throw runtimeError("WEB_RESEARCH_SCHEMA_INVALID", `${label} must be an object`, { stage: "validation" });
  }
  return Object.fromEntries(Object.entries(value).filter(([key]) => keys.includes(key)));
}

function isPlainObject(value) {
  const prototype = value && typeof value === "object" ? Object.getPrototypeOf(value) : null;
  return !!value && typeof value === "object" && !Array.isArray(value)
    && (prototype === Object.prototype || prototype === null);
}

function boundedString(value, label, max, { optional = false } = {}) {
  const text = typeof value === "string" ? value.trim() : "";
  if (!text) {
    if (optional) return null;
    throw runtimeError("WEB_RESEARCH_SCHEMA_INVALID", `${label} is required`, { stage: "validation" });
  }
  if (text.length > max) {
    throw runtimeError("WEB_RESEARCH_TOO_LARGE", `${label} exceeds ${max} characters`, { stage: "validation" });
  }
  return text;
}

function normalizedUrl(value, label) {
  const text = boundedString(value, label, 2_000);
  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw runtimeError("WEB_RESEARCH_SCHEMA_INVALID", `${label} must be an absolute HTTP(S) URL`, { stage: "validation" });
  }
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw runtimeError("WEB_RESEARCH_SCHEMA_INVALID", `${label} must be an absolute HTTP(S) URL`, { stage: "validation" });
  }
  return parsed.toString();
}

function normalizeHandoff(args) {
  if (Buffer.byteLength(JSON.stringify(args ?? null), "utf8") > WEB_RESEARCH_LIMITS.maxPacketBytes) {
    throw runtimeError(
      "WEB_RESEARCH_TOO_LARGE",
      `web_research_handoff exceeds ${WEB_RESEARCH_LIMITS.maxPacketBytes} bytes`,
      { stage: "validation" },
    );
  }
  const input = exactObject(args, ["protocol", "summary", "findings", "gaps", "sources"], "web_research_handoff");
  if (input.protocol !== WEB_RESEARCH_PROTOCOL) {
    throw runtimeError(
      "WEB_RESEARCH_PROTOCOL_INVALID",
      `protocol must be ${WEB_RESEARCH_PROTOCOL}`,
      { stage: "validation" },
    );
  }
  const summary = boundedString(input.summary, "web_research_handoff.summary", WEB_RESEARCH_LIMITS.maxSummaryChars);
  if (!Array.isArray(input.findings) || input.findings.length < 1 || input.findings.length > WEB_RESEARCH_LIMITS.maxFindings) {
    throw runtimeError(
      "WEB_RESEARCH_SCHEMA_INVALID",
      `web_research_handoff.findings must contain one to ${WEB_RESEARCH_LIMITS.maxFindings} entries`,
      { stage: "validation" },
    );
  }
  const findings = input.findings.map((raw, index) => {
    const finding = exactObject(
      raw,
      ["claim", "url", "title", "published_at", "confidence"],
      `web_research_handoff.findings[${index}]`,
    );
    const confidence = boundedString(finding.confidence, `web_research_handoff.findings[${index}].confidence`, 10);
    if (!["low", "medium", "high"].includes(confidence)) {
      throw runtimeError(
        "WEB_RESEARCH_SCHEMA_INVALID",
        `web_research_handoff.findings[${index}].confidence must be low, medium, or high`,
        { stage: "validation" },
      );
    }
    return {
      claim: boundedString(finding.claim, `web_research_handoff.findings[${index}].claim`, WEB_RESEARCH_LIMITS.maxClaimChars),
      url: normalizedUrl(finding.url, `web_research_handoff.findings[${index}].url`),
      ...(finding.title == null ? {} : {
        title: boundedString(finding.title, `web_research_handoff.findings[${index}].title`, WEB_RESEARCH_LIMITS.maxTitleChars),
      }),
      ...(finding.published_at == null ? {} : {
        published_at: boundedString(
          finding.published_at,
          `web_research_handoff.findings[${index}].published_at`,
          WEB_RESEARCH_LIMITS.maxPublishedAtChars,
        ),
      }),
      confidence,
    };
  });
  const gaps = input.gaps == null ? [] : input.gaps;
  if (!Array.isArray(gaps) || gaps.length > WEB_RESEARCH_LIMITS.maxGaps) {
    throw runtimeError(
      "WEB_RESEARCH_SCHEMA_INVALID",
      `web_research_handoff.gaps must contain at most ${WEB_RESEARCH_LIMITS.maxGaps} entries`,
      { stage: "validation" },
    );
  }
  // A bad source nomination is dropped and noted, never a reason to reject
  // the child's findings.
  const nominated = normalizeNominatedSources(input.sources);
  return {
    protocol: WEB_RESEARCH_PROTOCOL,
    summary,
    findings,
    gaps: gaps.map((gap, index) => boundedString(
      gap,
      `web_research_handoff.gaps[${index}]`,
      WEB_RESEARCH_LIMITS.maxGapChars,
    )),
    sources: nominated.sources,
    ...(nominated.dropped.length > 0 ? { dropped_sources: nominated.dropped } : {}),
  };
}

function childUsage(result = {}) {
  const stats = result.stats || {};
  return {
    agent_call_id: positiveId(result.agentCallId),
    provider: stats.provider || null,
    model: stats.modelName || null,
    input_tokens: stats.inputTokens ?? null,
    output_tokens: stats.outputTokens ?? null,
    cached_input_tokens: stats.cachedInputTokens ?? null,
    turns: stats.numTurns ?? null,
    duration_ms: stats.durationMs ?? null,
  };
}

function surfaceFindingForParent(finding, context) {
  const payloadText = JSON.stringify({
    protocol: WEB_RESEARCH_PROTOCOL,
    kind: "web_source_finding",
    claim: finding.claim,
    url: finding.url,
    ...(finding.title ? { title: finding.title } : {}),
    ...(finding.published_at ? { published_at: finding.published_at } : {}),
    confidence: finding.confidence,
  }, null, 2);
  const surfaced = surfaceHashRefForContext(context, {
    entryKind: "materialized",
    payloadText,
    descriptor: {
      kind: "web_source_finding",
      tool: "dispatch_agent",
      url: finding.url,
    },
    objectType: WEB_RESEARCH_FINDING_OBJECT_TYPE,
    source: "tool:dispatch_agent.web",
    note: finding.title || finding.url,
    sizeChars: payloadText.length,
    recomputable: false,
    metadata: {
      surfaced_by: "web_research_handoff",
      fetch_class: "visible_copy",
      citable: true,
      line_semantics: "materialized",
      url: finding.url,
      ...hashRefModelVisibility(context, {
        visibility: "full",
        ranges: [{ start: 0, end: payloadText.length }],
        issuedAs: "evidence",
      }),
    },
  }, { ownerScope: "work_item" });
  if (!surfaced?.ok || !surfaced.entry?.ref) {
    throw runtimeError(
      "WEB_RESEARCH_EVIDENCE_SURFACE_FAILED",
      `Could not surface web evidence for ${finding.url}`,
      { stage: "terminal" },
    );
  }
  return {
    ...finding,
    evidence: {
      ref: surfaced.entry.ref,
    },
  };
}

export class WebResearchRuntime {
  constructor({
    readSetting = getSetting,
    maxActiveChildren = WEB_RESEARCH_LIMITS.maxActiveChildren,
    timeoutMs = WEB_RESEARCH_LIMITS.timeoutMs,
    surfaceFinding = surfaceFindingForParent,
    captureSources = captureWebSources,
    surfaceReport = surfaceWebResearchReport,
  } = {}) {
    this.readSetting = readSetting;
    this.maxActiveChildren = maxActiveChildren;
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : WEB_RESEARCH_LIMITS.timeoutMs;
    this.surfaceFinding = surfaceFinding;
    this.captureSources = captureSources;
    this.surfaceReport = surfaceReport;
    this.parents = new Map();
    this.dispatches = new Map();
    this.childBindings = new Map();
    this.activeChildren = 0;
  }

  registerParent({ agentCallId, runChild, projectDir = null }) {
    const id = positiveId(agentCallId);
    if (!id || typeof runChild !== "function") return () => {};
    const registration = {
      runChild,
      projectDir: typeof projectDir === "string" && projectDir.trim() ? projectDir : null,
      accepting: true,
    };
    const previous = this.parents.get(id);
    if (previous) previous.accepting = false;
    this.parents.set(id, registration);
    return () => {
      registration.accepting = false;
      if (this.parents.get(id) === registration) this.parents.delete(id);
      for (const dispatch of this.dispatches.values()) {
        if (dispatch.parentAgentCallId === id && dispatch.status === "running") {
          dispatch.controller.abort(runtimeError(
            "WEB_RESEARCH_PARENT_CLOSED",
            "Parent closed while web research was running",
            { stage: "control" },
          ));
        }
      }
    };
  }

  bindChild({ agentCallId, dispatchId }) {
    const childId = positiveId(agentCallId);
    const dispatch = this.dispatches.get(String(dispatchId || ""));
    if (!childId || !dispatch || dispatch.status !== "running") {
      throw runtimeError(
        "WEB_RESEARCH_CHILD_BINDING_INVALID",
        "Web research child could not bind to its active dispatch",
        { stage: "admission" },
      );
    }
    if (dispatch.childAgentCallId && dispatch.childAgentCallId !== childId) {
      throw runtimeError(
        "WEB_RESEARCH_CHILD_BINDING_CONFLICT",
        "Web research dispatch is already bound to another child call",
        { stage: "admission" },
      );
    }
    dispatch.childAgentCallId = childId;
    this.childBindings.set(childId, dispatch);
    return () => {
      if (this.childBindings.get(childId) === dispatch) this.childBindings.delete(childId);
    };
  }

  submitHandoff(agentCallId, args) {
    const childId = positiveId(agentCallId);
    const dispatch = this.childBindings.get(childId);
    if (!dispatch || dispatch.status !== "running") {
      throw runtimeError(
        "WEB_RESEARCH_CHILD_UNBOUND",
        "web_research_handoff requires an active web research child",
        { stage: "terminal" },
      );
    }
    if (dispatch.packet) {
      throw runtimeError(
        "WEB_RESEARCH_HANDOFF_DUPLICATE",
        "Web research child already submitted its handoff",
        { stage: "terminal" },
      );
    }
    const packet = normalizeHandoff(args);
    if (dispatch.resultChars != null) {
      // The parent receives a compact report bounded by its research policy.
      // An oversized handoff is accepted and noted: the sub-agent runtime trims
      // the delivered report deterministically, whereas a rejection here would
      // cost the child another full-context turn.
      const compactChars = JSON.stringify(packet).length;
      if (compactChars > dispatch.resultChars) {
        try {
          recordObservation({
            ...dispatch.observationContext,
            observation_type: WEB_RESEARCH_HANDOFF_OVERSIZED_OBSERVATION_TYPE,
            summary: `Accepted a ${compactChars}-character web_research_handoff over the ${dispatch.resultChars}-character report limit`,
            detail: {
              child_agent_call_id: childId,
              chars: compactChars,
              result_chars: dispatch.resultChars,
              findings: packet.findings.length,
            },
          });
        } catch {
          // Telemetry must not reject an accepted handoff.
        }
      }
    }
    dispatch.packet = packet;
    return {
      ok: true,
      protocol: WEB_RESEARCH_PROTOCOL,
      status: "accepted",
      terminal: true,
    };
  }

  // True when this child is bound to a running dispatch that has no accepted
  // web_research_handoff: the child's call ended without its terminal report.
  childHandoffMissing(agentCallId) {
    const dispatch = this.childBindings.get(positiveId(agentCallId));
    return !!dispatch && dispatch.status === "running" && !dispatch.packet;
  }

  // True while a research-batch web child of this parent call is running.
  hasRunningDispatchForParent(agentCallId) {
    const parentId = positiveId(agentCallId);
    if (!parentId) return false;
    for (const dispatch of this.dispatches.values()) {
      if (dispatch.parentAgentCallId === parentId && dispatch.status === "running") return true;
    }
    return false;
  }

  acknowledgeReceipt(agentCallId, detail = {}) {
    const childId = positiveId(agentCallId);
    const dispatch = this.childBindings.get(childId);
    if (!dispatch?.packet || dispatch.status !== "running") return false;
    agentHandoffTerminator.acknowledge(childId, {
      ...detail,
      kind: "web_research_handoff",
      dispatchId: dispatch.id,
    });
    return true;
  }

  // A child that answered in prose instead of calling web_research_handoff
  // (for example because the tool was missing from its surface) still paid
  // for the research. Keep the answer as an uncited report ref instead of
  // failing the dispatch, so the planner and later agents can read it.
  #salvage(result, context, reportMeta) {
    const text = salvageableWebReportText(result?.output);
    if (!text) return null;
    const urls = extractUrls(text);
    const ref = this.surfaceReport(context, {
      summary: "The web child did not submit web_research_handoff; its final answer is preserved uncited.",
      salvaged: true,
      text,
      urls,
      findings: [],
      sources: [],
      gaps: ["Findings are uncited: verify a claim against its URL before relying on it."],
    }, reportMeta);
    recordReportSalvaged(context, {
      chars: text.length,
      urls: urls.length,
      ref,
      web_research_dispatch_id: reportMeta.dispatchId,
      child_agent_call_id: reportMeta.childAgentCallId || null,
    });
    if (!ref) return null;
    return {
      protocol: WEB_RESEARCH_PROTOCOL,
      salvaged: true,
      summary: [
        `SALVAGED (uncited): the web child did not submit web_research_handoff. Its full answer is report ${ref}; traverse it before relying on any part.`,
        text.slice(0, 1_200),
      ].join("\n"),
      findings: [],
      sources: [],
      gaps: ["The web child's answer was salvaged from final text; its claims are uncited."],
      report_ref: ref,
    };
  }

  async execute(args, { context = {}, budget = null, signal = null, dispatchId = null } = {}) {
    const runtimeContext = /** @type {Record<string, any>} */ (context);
    const parentAgentCallId = positiveId(runtimeContext.agentCallId ?? runtimeContext.agent_call_id);
    if (!parentAgentCallId) {
      throw runtimeError(
        "WEB_RESEARCH_CONTEXT_INVALID",
        "dispatch_agent requires an active parent agent call",
        { stage: "admission" },
      );
    }
    if (signal?.aborted) throw signal.reason || runtimeError("WEB_RESEARCH_ABORTED", "Web research was aborted", { stage: "control" });
    const input = exactObject(args, ["route", "question"], "dispatch_agent");
    if (input.route !== "web") {
      throw runtimeError(
        "WEB_RESEARCH_ROUTE_INVALID",
        "dispatch_agent.route must be web",
        { stage: "validation" },
      );
    }
    const question = boundedString(input.question, "dispatch_agent.question", WEB_RESEARCH_LIMITS.maxQuestionChars);
    const coordinationMode = String(this.readSetting(SETTING_KEYS.AGENT_COORDINATION_MODE) || "off").trim().toLowerCase();
    const dispatchPolicy = readPlannerDispatchPolicy({ readSetting: (key, options) => this.readSetting(key, options) });
    const dispatchEnabled = coordinationMode !== "subagents" && dispatchPolicy.enabled;
    // A web child fetches and summarizes: it runs on a cheaper tier than the
    // planner, whatever was requested and whichever path dispatched it.
    const childModelTier = RESEARCH_CHILD_DEFAULT_MODEL_TIERS.includes(budget?.modelTier)
      ? budget.modelTier
      : (dispatchPolicy.childModelTier || RESEARCH_CHILD_FALLBACK_MODEL_TIER);
    budget = { ...(budget || {}), modelTier: childModelTier };
    if (coordinationMode !== "subagents" && !dispatchEnabled) {
      throw runtimeError(
        "WEB_RESEARCH_ADMIN_DISABLED",
        "dispatch_agent web research is disabled by the repository administrator",
        { stage: "admission" },
      );
    }
    const registration = this.parents.get(parentAgentCallId);
    if (!registration?.accepting) {
      throw runtimeError(
        "WEB_RESEARCH_PARENT_UNAVAILABLE",
        "The parent provider call cannot dispatch web research",
        { stage: "admission" },
      );
    }
    if (this.activeChildren >= this.maxActiveChildren) {
      throw runtimeError(
        "WEB_RESEARCH_CAPACITY",
        "The inline web research lane is at capacity",
        { retryable: true, stage: "admission" },
      );
    }
    // The direct tool path allows one web dispatch per parent call. Research
    // batches arrive through the sub-agent runtime, which already bounds
    // concurrency per parent and runs sibling entries at the same time, so a
    // coordinated dispatch must not be refused because its sibling is running.
    const coordinatedDispatchId = typeof dispatchId === "string" && dispatchId.trim()
      ? dispatchId.trim()
      : null;
    const duplicate = coordinatedDispatchId ? null : [...this.dispatches.values()].find((dispatch) => (
      dispatch.parentAgentCallId === parentAgentCallId && dispatch.status === "running"
    ));
    if (duplicate) {
      throw runtimeError(
        "WEB_RESEARCH_PARENT_BUSY",
        "Only one web research dispatch may run at a time for a parent call",
        { stage: "admission" },
      );
    }

    const dispatch = {
      id: `wrd_${crypto.randomUUID().replaceAll("-", "")}`,
      parentAgentCallId,
      question,
      status: "running",
      packet: null,
      childAgentCallId: null,
      controller: new AbortController(),
      coordinatedDispatchId,
      resultChars: Number.isSafeInteger(budget?.resultChars) && budget.resultChars > 0 ? budget.resultChars : null,
      observationContext: {
        work_item_id: runtimeContext.work_item_id ?? runtimeContext.workItemId ?? null,
        job_id: runtimeContext.job_id ?? runtimeContext.jobId ?? null,
        attempt_id: runtimeContext.attempt_id ?? runtimeContext.attemptId ?? null,
      },
    };
    const forwardAbort = () => dispatch.controller.abort(signal.reason);
    signal?.addEventListener("abort", forwardAbort, { once: true });
    if (signal?.aborted) forwardAbort();
    this.dispatches.set(dispatch.id, dispatch);
    this.activeChildren += 1;
    const timeoutMs = budget?.timeoutMs || this.timeoutMs;
    const timeout = setTimeout(() => {
      dispatch.controller.abort(runtimeError(
        "WEB_RESEARCH_TIMEOUT",
        `Web research exceeded ${timeoutMs}ms`,
        { stage: "child" },
      ));
    }, timeoutMs);
    timeout.unref?.();
    /** @type {() => void} */
    let handleAbort = () => {};
    const abortPromise = new Promise((_, reject) => {
      handleAbort = () => {
        reject(dispatch.controller.signal.reason || runtimeError(
          "WEB_RESEARCH_ABORTED",
          "Web research was aborted",
          { stage: "control" },
        ));
      };
      dispatch.controller.signal.addEventListener("abort", handleAbort, { once: true });
    });
    try {
      let result;
      try {
        result = await Promise.race([
          registration.runChild({
            dispatchId: dispatch.id,
            question,
            budget,
            signal: dispatch.controller.signal,
          }),
          abortPromise,
        ]);
      } catch (error) {
        // The child's call already failed its row for the missing handoff;
        // its final text may still be salvageable below.
        if (error?.code !== "WEB_RESEARCH_HANDOFF_MISSING" || dispatch.packet || dispatch.controller.signal.aborted) throw error;
        result = { agentCallId: error.agentCallId, output: error.output, stats: error.stats };
      }
      if (dispatch.controller.signal.aborted) throw dispatch.controller.signal.reason;
      const reportMeta = {
        dispatchId: dispatch.id,
        childAgentCallId: dispatch.childAgentCallId || positiveId(result?.agentCallId),
        question,
      };
      if (!dispatch.packet) {
        const salvaged = this.#salvage(result, context, reportMeta);
        if (!salvaged) {
          const error = /** @type {Error & Record<string, any>} */ (runtimeError(
            "WEB_RESEARCH_HANDOFF_MISSING",
            "Web research child did not submit web_research_handoff",
            { stage: "terminal" },
          ));
          // The child ran and has its own call row: keep its identity and
          // usage so callers do not report this as a pre-start rejection.
          error.agentCallId = reportMeta.childAgentCallId;
          error.stats = result?.stats || {};
          throw error;
        }
        dispatch.status = "completed";
        return { ok: true, protocol: WEB_RESEARCH_PROTOCOL, route: "web", result: salvaged, usage: childUsage(result) };
      }
      const { sources: nominatedSources, dropped_sources: droppedSources, ...handoff } = dispatch.packet;
      const sources = nominatedSources.length > 0
        ? await this.captureSources(nominatedSources, {
          context,
          projectDir: registration.projectDir || runtimeContext.projectDir || null,
          signal: dispatch.controller.signal,
          dispatchId: dispatch.id,
        })
        : [];
      if (dispatch.controller.signal.aborted) throw dispatch.controller.signal.reason;
      const findings = handoff.findings.map((finding) => this.surfaceFinding(finding, context));
      const reportRef = this.surfaceReport(context, {
        summary: handoff.summary,
        findings: findings.map((finding) => ({
          claim: finding.claim,
          url: finding.url,
          confidence: finding.confidence,
          ref: finding.evidence?.ref || null,
        })),
        sources: sources.map(({ file: _file, ...source }) => source),
        gaps: handoff.gaps,
        ...(droppedSources ? { dropped_sources: droppedSources } : {}),
        salvaged: false,
      }, reportMeta);
      const surfacedPacket = {
        ...handoff,
        findings,
        sources,
        ...(droppedSources ? { dropped_sources: droppedSources } : {}),
        ...(reportRef ? { report_ref: reportRef } : {}),
      };
      dispatch.status = "completed";
      return {
        ok: true,
        protocol: WEB_RESEARCH_PROTOCOL,
        route: "web",
        result: surfacedPacket,
        usage: childUsage(result),
      };
    } finally {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", forwardAbort);
      dispatch.controller.signal.removeEventListener("abort", handleAbort);
      if (dispatch.childAgentCallId) this.childBindings.delete(dispatch.childAgentCallId);
      this.dispatches.delete(dispatch.id);
      this.activeChildren = Math.max(0, this.activeChildren - 1);
    }
  }
}

export const webResearchRuntime = new WebResearchRuntime();

export async function executeDispatchAgent(args, options = {}) {
  const raw = options.context || {};
  const context = { ...raw, work_item_id: raw.work_item_id ?? raw.workItemId, job_id: raw.job_id ?? raw.jobId,
    attempt_id: raw.attempt_id ?? raw.attemptId, agent_call_id: raw.agent_call_id ?? raw.agentCallId };
  options = { ...options, context };
  const parentId = Number(context.agentCallId ?? context.agent_call_id);
  const research = subAgentRuntime.parents.get(parentId)?.researchPolicy?.enabled;
  // Providers that flatten the planner schema's oneOf send one budget beside
  // requests[]. Fold it into every request that has none rather than drop it.
  const foldedBudgetRequests = [];
  if (Array.isArray(args?.requests) && isPlainObject(args.budget)) {
    const shared = args.budget;
    args = {
      ...args,
      requests: args.requests.map((request, index) => {
        if (!isPlainObject(request) || request.budget != null) return request;
        foldedBudgetRequests.push(typeof request.id === "string" && request.id.trim() ? request.id.trim() : `requests[${index}]`);
        return { ...request, budget: { ...shared } };
      }),
    };
    delete args.budget;
  }
  const withFoldRepair = (result) => (foldedBudgetRequests.length > 0 && result && typeof result === "object"
    ? {
        ...result,
        repairs: [
          { field: "budget", action: "folded_into_requests", request_ids: foldedBudgetRequests },
          ...(Array.isArray(result.repairs) ? result.repairs : []),
        ],
      }
    : result);
  // A one-entry batch is the single dispatch written the long way: unwrap it
  // instead of bouncing the planner for the shape.
  if (Array.isArray(args?.requests) && args.requests.length === 1
    && args.requests[0] && typeof args.requests[0] === "object" && !Array.isArray(args.requests[0])) {
    const only = args.requests[0];
    args = {
      agent_type: only.agent_type,
      question: only.question,
      ...(only.anchors == null ? {} : { anchors: only.anchors }),
      ...(only.budget == null ? {} : { budget: only.budget }),
    };
  }
  if (Object.hasOwn(args || {}, "requests")) {
    if (!research) throw runtimeError("RESEARCH_BATCH_DISABLED", "Research batches require an eligible planner", { stage: "admission" });
    if (!Array.isArray(args.requests) || args.requests.length < 2 || args.requests.length > 3) {
      throw runtimeError("WEB_RESEARCH_SCHEMA_INVALID", "dispatch_agent.requests must contain two to three entries", { stage: "validation" });
    }
    const requests = args.requests.map((raw, index) => {
      const request = knownKeysObject(raw, ["id", "agent_type", "question", "anchors", "budget"], `requests[${index}]`);
      if (!RESEARCH_AGENT_TYPES.includes(request.agent_type)) {
        throw runtimeError("RESEARCH_AGENT_TYPE_INVALID", "agent_type must be code or web", { stage: "validation" });
      }
      return {
        id: boundedString(request.id, `requests[${index}].id`, 40),
        profile: RESEARCH_CHILD_PROFILE,
        agent_type: request.agent_type,
        intent: boundedString(request.question, `requests[${index}].question`, 2000),
        ...(request.anchors == null ? {} : { anchors: request.anchors }),
        ...(request.budget ? { budget: request.budget } : {}),
      };
    });
    return withFoldRepair(await subAgentRuntime.execute({
      protocol: SUB_AGENT_PROTOCOL, op: "dispatch", completion: { mode: "wait_all" }, requests,
    }, options));
  }
  if (research && args?.agent_type == null) throw runtimeError("RESEARCH_AGENT_TYPE_REQUIRED", "dispatch_agent requires agent_type code or web", { stage: "validation" });
  if (args?.agent_type != null && research) {
    args = knownKeysObject(args, ["agent_type", "question", "anchors", "budget"], "dispatch_agent");
    if (!RESEARCH_AGENT_TYPES.includes(args.agent_type)) throw runtimeError("RESEARCH_AGENT_TYPE_INVALID", "agent_type must be code or web", { stage: "validation" });
    return withFoldRepair(await subAgentRuntime.execute({
      protocol: SUB_AGENT_PROTOCOL, op: "dispatch", completion: { mode: "wait_all" },
      requests: [{ id: "research", profile: RESEARCH_CHILD_PROFILE, agent_type: args.agent_type, intent: args.question, ...(args.anchors == null ? {} : { anchors: args.anchors }), ...(args.budget ? { budget: args.budget } : {}) }],
    }, options));
  }
  if (args?.agent_type != null) {
    args = knownKeysObject(args, ["agent_type", "question"], "dispatch_agent");
    if (args.agent_type !== "web") throw runtimeError("RESEARCH_AGENT_TYPE_DISABLED", "Code research requires the gated planner", { stage: "admission" });
    return await webResearchRuntime.execute({ route: "web", question: args.question }, options);
  }
  return await webResearchRuntime.execute(args, options);
}

export function submitWebResearchHandoff(agentCallId, args) {
  return webResearchRuntime.submitHandoff(agentCallId, args);
}

export function acknowledgeWebResearchHandoffReceipt(agentCallId, detail = {}) {
  return webResearchRuntime.acknowledgeReceipt(agentCallId, detail);
}
