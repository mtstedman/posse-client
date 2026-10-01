// @ts-check
//
// The whole web research result as one durable work-item ref. Findings and
// source snapshots are refs of their own; the report ties them together so a
// planner, a replan, or a dev can read what the web child actually found
// without the planner restating it.

import { RESEARCH_REPORT_OBJECT_TYPE } from "../../../catalog/sub-agent.js";
import {
  WEB_RESEARCH_OBSERVATION_TYPES,
  WEB_RESEARCH_PROTOCOL,
  WEB_RESEARCH_REPORT_KIND,
} from "../../../catalog/web-research.js";
import { recordObservation } from "../../observability/functions/observations.js";
import {
  issueHashRefTraversalForContext,
  surfaceHashRefForContext,
} from "../../queue/functions/hash-refs.js";
import { hashRefModelVisibility } from "../../../shared/tools/functions/fetch-ref-policy.js";

// A salvaged final text is kept whole up to this size; the ref is read
// through fetch_ref windows, so it does not have to fit a prompt.
export const SALVAGED_REPORT_MAX_CHARS = 200_000;
const SALVAGE_MIN_CHARS = 40;
const URL_PATTERN = /\bhttps?:\/\/[^\s<>"'`)\]]+/g;

function positiveId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

/**
 * Surface the web research report as a pinned work-item ref and let the
 * parent call traverse it. Returns the ref, or null when it cannot be stored.
 * @param {Record<string, any>} context
 * @param {Record<string, any>} report
 * @param {{ dispatchId?: string | null, childAgentCallId?: number | null, question?: string }} [meta]
 */
export function surfaceWebResearchReport(context, report, { dispatchId = null, childAgentCallId = null, question = "" } = {}) {
  const payload = {
    protocol: WEB_RESEARCH_PROTOCOL,
    kind: WEB_RESEARCH_REPORT_KIND,
    question,
    ...report,
  };
  const payloadText = JSON.stringify(payload, null, 2);
  let surfaced;
  try {
    surfaced = surfaceHashRefForContext(context, {
      payloadText,
      objectType: RESEARCH_REPORT_OBJECT_TYPE,
      source: "tool:dispatch_agent.web_report",
      note: `Web research report: ${String(question || "").replace(/\s+/g, " ").slice(0, 160)}`,
      sizeChars: payloadText.length,
      recomputable: false,
      metadata: {
        line_semantics: "materialized",
        research_kind: "web",
        salvaged: report.salvaged === true,
        web_research_dispatch_id: dispatchId,
        child_agent_call_id: positiveId(childAgentCallId),
        handoff_evidence_pinned: true,
        ...hashRefModelVisibility(context, { visibility: "hidden", ranges: [] }),
      },
    }, { ownerScope: "work_item" });
  } catch {
    return null;
  }
  if (!surfaced?.ok || !surfaced.entry?.ref) return null;
  try {
    /** @type {any} issueHashRefTraversalForContext's options are inferred from its defaults only. */
    const traversal = {
      ref: surfaced.entry.ref,
      sourceRef: surfaced.entry.ref,
      selector: { mode: "full" },
      sourceContentHash: surfaced.entry.content_hash || null,
    };
    issueHashRefTraversalForContext(context, traversal);
  } catch {
    // The ref stays durable for later agents even if this call cannot traverse it.
  }
  return surfaced.entry.ref;
}

/**
 * A web child that never submitted web_research_handoff may still have
 * written its whole answer as final text. Keep that text rather than
 * discarding a paid run; it is marked salvaged and its claims are uncited.
 * @param {unknown} output
 */
export function salvageableWebReportText(output) {
  const text = typeof output === "string" ? output.trim() : "";
  return text.length >= SALVAGE_MIN_CHARS ? text.slice(0, SALVAGED_REPORT_MAX_CHARS) : null;
}

export function extractUrls(text, limit = 40) {
  const urls = [];
  const seen = new Set();
  for (const match of String(text || "").matchAll(URL_PATTERN)) {
    const url = match[0].replace(/[.,;:]+$/, "");
    if (seen.has(url)) continue;
    seen.add(url);
    urls.push(url);
    if (urls.length >= limit) break;
  }
  return urls;
}

export function recordReportSalvaged(context, detail) {
  try {
    recordObservation({
      work_item_id: context.work_item_id ?? context.workItemId ?? null,
      job_id: context.job_id ?? context.jobId ?? null,
      attempt_id: context.attempt_id ?? context.attemptId ?? null,
      observation_type: WEB_RESEARCH_OBSERVATION_TYPES.REPORT_SALVAGED,
      summary: `Salvaged a ${detail.chars}-character web research answer without web_research_handoff${detail.ref ? ` as ${detail.ref}` : ""}`,
      detail,
    });
  } catch {
    // Telemetry must not change the research result.
  }
}
