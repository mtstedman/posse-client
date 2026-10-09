// @ts-check
//
// Durable research refs for a work item: full research reports (web and
// trimmed code reports) and byte-exact web source snapshots. Each later
// agent gets a short index of them and a traversal for its own call, so it
// can read what research found on request instead of the planner restating
// it or a replan being told the research "failed".

import { AGENT_CALL_CHILD_KINDS } from "../../../catalog/agent-call.js";
import { WORK_ITEM_INPUT_OBJECT_TYPE } from "../../../catalog/artifact.js";
import { RESEARCH_CHILD_PROFILE, RESEARCH_REPORT_OBJECT_TYPE } from "../../../catalog/sub-agent.js";
import { WEB_SOURCE_SNAPSHOT_OBJECT_TYPE } from "../../../catalog/web-research.js";
import { surfaceWorkItemInputs } from "../../artifacts/functions/input-refs.js";
import { getObservationContext } from "../../observability/functions/observations.js";
import { issueHashRefTraversalForContext, surfaceHashRefForContext } from "../../queue/functions/hash-refs.js";
import { hashRefModelVisibility } from "../../../shared/tools/functions/fetch-ref-policy.js";
import { getDb } from "../../../shared/storage/functions/index.js";

const RESEARCH_REF_OBJECT_TYPES = Object.freeze([
  RESEARCH_REPORT_OBJECT_TYPE,
  WEB_SOURCE_SNAPSHOT_OBJECT_TYPE,
  WORK_ITEM_INPUT_OBJECT_TYPE,
]);
const DEFAULT_LIMIT = 12;

function positiveId(value) {
  const number = Number(value);
  return Number.isInteger(number) && number > 0 ? number : null;
}

function parseMetadata(value) {
  if (!value) return {};
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

/**
 * @param {number} workItemId
 * @param {{ db?: any, limit?: number }} [options]
 */
export function listWorkItemResearchRefs(workItemId, { db = getDb(), limit = DEFAULT_LIMIT } = {}) {
  const id = positiveId(workItemId);
  if (!id) return [];
  const placeholders = RESEARCH_REF_OBJECT_TYPES.map(() => "?").join(", ");
  let rows = [];
  try {
    rows = db.prepare(`
      SELECT ref, object_type, note, size_chars, metadata_json, content_hash
      FROM work_item_hash_refs
      WHERE work_item_id = ?
        AND object_type IN (${placeholders})
        AND COALESCE(degraded, 0) = 0
      ORDER BY id DESC
      LIMIT ?
    `).all(id, ...RESEARCH_REF_OBJECT_TYPES, Math.max(1, Math.min(50, Number(limit) || DEFAULT_LIMIT)));
  } catch {
    return [];
  }
  return rows.map((row) => {
    const metadata = parseMetadata(row.metadata_json);
    return {
      ref: String(row.ref),
      objectType: String(row.object_type),
      note: String(row.note || "").replace(/\s+/g, " ").trim(),
      sizeChars: Number(row.size_chars) || 0,
      contentHash: row.content_hash || null,
      researchKind: metadata.research_kind || null,
      salvaged: metadata.salvaged === true,
      url: metadata.final_url || metadata.url || null,
      contentType: metadata.content_type || null,
      bytes: Number(metadata.bytes) || null,
      label: metadata.label || null,
    };
  });
}

// The provider call the index is rendered for; refs are issued to it.
function callRefContext(workItemId, { jobId = null, packet = null } = {}) {
  const observation = getObservationContext() || {};
  return {
    work_item_id: workItemId,
    job_id: positiveId(jobId ?? packet?.job_id ?? observation.job_id),
    attempt_id: positiveId(observation.attempt_id ?? packet?.attempt_id),
    agent_call_id: positiveId(observation.agent_call_id ?? packet?.agent_call_id),
  };
}

function describe(entry) {
  if (entry.objectType === WORK_ITEM_INPUT_OBJECT_TYPE) {
    return `operator input — ${entry.label || entry.note || "file"}${entry.bytes ? ` (${entry.bytes} bytes)` : ""}`;
  }
  if (entry.objectType === WEB_SOURCE_SNAPSHOT_OBJECT_TYPE) {
    const size = entry.bytes ? `, ${entry.bytes} bytes` : "";
    return `source snapshot — ${entry.label || "web source"} (${entry.contentType || "text"}${size}) ${entry.url || ""}`.trim();
  }
  const kind = entry.researchKind === "web"
    ? (entry.salvaged ? "web research report (salvaged, uncited)" : "web research report")
    : "research report";
  return `${kind} — ${entry.note || "full report"} (${entry.sizeChars} chars)`;
}

/**
 * Render the index for the current provider call and issue traversals so the
 * listed refs are readable through traverse_ref/fetch_ref. Returns null when
 * the work item has no durable research refs.
 * @param {{ workItemId?: number | null, jobId?: number | null, packet?: Record<string, any> | null, projectDir?: string | null, db?: any }} options
 */
export function workItemResearchRefsBlock({ workItemId = null, jobId = null, packet = null, projectDir = null, db = undefined } = {}) {
  const wiId = positiveId(workItemId ?? packet?.work_item_id);
  if (!wiId) return null;
  // Inputs the operator dropped since the last job are picked up here.
  try {
    surfaceWorkItemInputs(wiId, { projectDir });
  } catch {
    // Inputs are best effort; research refs still render.
  }
  const entries = listWorkItemResearchRefs(wiId, db ? { db } : {});
  if (entries.length === 0) return null;
  const context = callRefContext(wiId, { jobId, packet });
  const readable = entries.filter((entry) => {
    try {
      /** @type {any} issueHashRefTraversalForContext's options are inferred from its defaults only. */
      const traversal = { ref: entry.ref, sourceRef: entry.ref, selector: { mode: "full" }, sourceContentHash: entry.contentHash };
      return issueHashRefTraversalForContext(context, traversal, db ? { db } : {})?.ok === true;
    } catch {
      return false;
    }
  });
  if (readable.length === 0) return null;
  return [
    "WORK ITEM RESEARCH REFS:",
    "  Durable research and operator inputs for this work item. Read one with traverse_ref (or fetch_ref) when your task needs it; use page or line windows for large refs. Prefer a source snapshot or input over re-fetching or restating its data.",
    ...readable.map((entry) => `  - ${entry.ref} ${describe(entry)}`),
    "",
  ].join("\n");
}

/**
 * Committed research child reports that earlier planner jobs on this work
 * item dispatched, newest first.
 * @param {number} workItemId
 * @param {{ beforeJobId?: number | null, db?: any, limit?: number }} [options]
 */
export function listPriorPlanResearchPackets(workItemId, { beforeJobId = null, db = getDb(), limit = DEFAULT_LIMIT } = {}) {
  const id = positiveId(workItemId);
  const before = positiveId(beforeJobId);
  if (!id || !before) return [];
  try {
    return db.prepare(`
      SELECT child.id AS agent_call_id, parent.job_id AS plan_job_id, child.activity AS intent,
        packet.materialized_packet_json AS packet_json
      FROM agent_calls child
      JOIN agent_calls parent ON parent.id = child.parent_agent_call_id
      JOIN jobs plan ON plan.id = parent.job_id
      JOIN agent_handoff_packets packet ON packet.agent_call_id = child.id
      WHERE parent.work_item_id = ?
        AND parent.job_id < ?
        AND plan.job_type = 'plan'
        AND child.child_kind = ?
        AND packet.status = 'committed'
        AND packet.profile = ?
      ORDER BY child.id DESC
      LIMIT ?
    `).all(id, before, AGENT_CALL_CHILD_KINDS.RESEARCH, RESEARCH_CHILD_PROFILE, Math.max(1, Math.min(50, Number(limit) || DEFAULT_LIMIT)));
  } catch {
    return [];
  }
}

/**
 * A replan planner's index of the research children earlier plans on this
 * work item dispatched. Each report is surfaced on the replan job (not the
 * work item, so it never joins WORK ITEM RESEARCH REFS for other roles) and
 * issued to the current call for traverse_ref/fetch_ref. These are refs to
 * read on request, not research continuity: nothing seeds the plan from
 * them. Returns null when there is nothing readable.
 * @param {{ workItemId?: number | null, jobId?: number | null, packet?: Record<string, any> | null, db?: any }} options
 */
export function priorPlanResearchRefsBlock({ workItemId = null, jobId = null, packet = null, db = undefined } = {}) {
  const wiId = positiveId(workItemId ?? packet?.work_item_id);
  if (!wiId) return null;
  const context = callRefContext(wiId, { jobId, packet });
  if (!context.job_id) return null;
  const rows = listPriorPlanResearchPackets(wiId, { beforeJobId: context.job_id, ...(db ? { db } : {}) });
  const lines = [];
  for (const row of rows) {
    try {
      const payloadText = JSON.stringify(JSON.parse(String(row.packet_json)), null, 2);
      const question = String(row.intent || "").replace(/\s+/g, " ").trim().slice(0, 160);
      const surfaced = surfaceHashRefForContext(context, {
        payloadText,
        objectType: RESEARCH_REPORT_OBJECT_TYPE,
        source: "planner:prior_plan_research",
        note: `Research child report from plan job #${row.plan_job_id}${question ? `: ${question}` : ""}`,
        sizeChars: payloadText.length,
        recomputable: false,
        metadata: {
          line_semantics: "materialized",
          child_agent_call_id: positiveId(row.agent_call_id),
          plan_job_id: positiveId(row.plan_job_id),
          handoff_evidence_pinned: true,
          ...hashRefModelVisibility(context, { visibility: "hidden", ranges: [] }),
        },
      }, { ownerScope: "job", ...(db ? { db } : {}) });
      if (!surfaced?.ok || !surfaced.entry?.ref) continue;
      /** @type {any} issueHashRefTraversalForContext's options are inferred from its defaults only. */
      const traversal = {
        ref: surfaced.entry.ref,
        sourceRef: surfaced.entry.ref,
        selector: { mode: "full" },
        sourceContentHash: surfaced.entry.content_hash || null,
      };
      if (issueHashRefTraversalForContext(context, traversal, db ? { db } : {})?.ok !== true) continue;
      lines.push(`  - ${surfaced.entry.ref} research report — plan job #${row.plan_job_id}${question ? `: ${question}` : ""} (${payloadText.length} chars)`);
    } catch {
      // One unreadable report must not hide the others.
    }
  }
  if (lines.length === 0) return null;
  return [
    "PRIOR PLAN RESEARCH (may predate retained commits; verify current source):",
    "  Reports from research children that earlier plans on this work item dispatched. Read one with traverse_ref (or fetch_ref) before dispatching a child for the same question; use page or line windows for large refs.",
    ...lines,
    "",
  ].join("\n");
}
