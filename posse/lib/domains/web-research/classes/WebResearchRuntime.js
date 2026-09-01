// @ts-check

import crypto from "node:crypto";

import { SETTING_KEYS } from "../../../catalog/settings.js";
import {
  WEB_RESEARCH_LIMITS,
  WEB_RESEARCH_PROTOCOL,
} from "../../../catalog/web-research.js";
import { getSetting } from "../../queue/functions/index.js";
import { surfaceHashRefForContext } from "../../queue/functions/hash-refs.js";
import { agentHandoffTerminator } from "../../handoff/classes/AgentHandoffTerminator.js";
import { hashRefModelVisibility } from "../../../shared/tools/functions/fetch-ref-policy.js";

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
  const input = exactObject(args, ["protocol", "summary", "findings", "gaps"], "web_research_handoff");
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
  return {
    protocol: WEB_RESEARCH_PROTOCOL,
    summary,
    findings,
    gaps: gaps.map((gap, index) => boundedString(
      gap,
      `web_research_handoff.gaps[${index}]`,
      WEB_RESEARCH_LIMITS.maxGapChars,
    )),
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
    objectType: "web.research.finding",
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
  } = {}) {
    this.readSetting = readSetting;
    this.maxActiveChildren = maxActiveChildren;
    this.timeoutMs = Number.isFinite(Number(timeoutMs)) && Number(timeoutMs) > 0
      ? Number(timeoutMs)
      : WEB_RESEARCH_LIMITS.timeoutMs;
    this.surfaceFinding = surfaceFinding;
    this.parents = new Map();
    this.dispatches = new Map();
    this.childBindings = new Map();
    this.activeChildren = 0;
  }

  registerParent({ agentCallId, runChild }) {
    const id = positiveId(agentCallId);
    if (!id || typeof runChild !== "function") return () => {};
    const registration = { runChild, accepting: true };
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
    dispatch.packet = normalizeHandoff(args);
    return {
      ok: true,
      protocol: WEB_RESEARCH_PROTOCOL,
      status: "accepted",
      terminal: true,
    };
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

  async execute(args, { context = {} } = {}) {
    const runtimeContext = /** @type {Record<string, any>} */ (context);
    const parentAgentCallId = positiveId(runtimeContext.agentCallId ?? runtimeContext.agent_call_id);
    if (!parentAgentCallId) {
      throw runtimeError(
        "WEB_RESEARCH_CONTEXT_INVALID",
        "dispatch_agent requires an active parent agent call",
        { stage: "admission" },
      );
    }
    const input = exactObject(args, ["route", "question"], "dispatch_agent");
    if (input.route !== "web") {
      throw runtimeError(
        "WEB_RESEARCH_ROUTE_INVALID",
        "dispatch_agent.route must be web",
        { stage: "validation" },
      );
    }
    const question = boundedString(input.question, "dispatch_agent.question", WEB_RESEARCH_LIMITS.maxQuestionChars);
    if (String(this.readSetting(SETTING_KEYS.AGENT_COORDINATION_MODE) || "off").trim().toLowerCase() !== "subagents") {
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
    const duplicate = [...this.dispatches.values()].find((dispatch) => (
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
    };
    this.dispatches.set(dispatch.id, dispatch);
    this.activeChildren += 1;
    const timeout = setTimeout(() => {
      dispatch.controller.abort(runtimeError(
        "WEB_RESEARCH_TIMEOUT",
        `Web research exceeded ${this.timeoutMs}ms`,
        { stage: "child" },
      ));
    }, this.timeoutMs);
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
      const result = await Promise.race([
        registration.runChild({
          dispatchId: dispatch.id,
          question,
          signal: dispatch.controller.signal,
        }),
        abortPromise,
      ]);
      if (dispatch.controller.signal.aborted) throw dispatch.controller.signal.reason;
      if (!dispatch.packet) {
        throw runtimeError(
          "WEB_RESEARCH_HANDOFF_MISSING",
          "Web research child did not submit web_research_handoff",
          { stage: "terminal" },
        );
      }
      const surfacedPacket = {
        ...dispatch.packet,
        findings: dispatch.packet.findings.map((finding) => this.surfaceFinding(finding, context)),
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
      dispatch.controller.signal.removeEventListener("abort", handleAbort);
      if (dispatch.childAgentCallId) this.childBindings.delete(dispatch.childAgentCallId);
      this.dispatches.delete(dispatch.id);
      this.activeChildren = Math.max(0, this.activeChildren - 1);
    }
  }
}

export const webResearchRuntime = new WebResearchRuntime();

export async function executeDispatchAgent(args, options = {}) {
  return await webResearchRuntime.execute(args, options);
}

export function submitWebResearchHandoff(agentCallId, args) {
  return webResearchRuntime.submitHandoff(agentCallId, args);
}

export function acknowledgeWebResearchHandoffReceipt(agentCallId, detail = {}) {
  return webResearchRuntime.acknowledgeReceipt(agentCallId, detail);
}
