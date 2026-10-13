import { COMPACT_RELATIONSHIP_PROJECTION, COMPACT_STRUCTURE_PROJECTION } from "../../../catalog/atlas-presentation.js";


import { recordObservation } from "../../../domains/observability/functions/observations.js";
import { sortAgentToolDefinitions } from "./agent-schema.js";
import { capString } from "./mcp-owner-session-support.js";
import crypto from "node:crypto";
import { getTraversalCompletionSnapshotForCall } from "../../../domains/handoff/functions/agent-handoff.js";
import { TOOL_SURFACE_ISSUED_OBSERVATION_TYPE } from "../../../catalog/observation.js";
import { usesResearcherAtlasReadSurface, sessionToolPolicy, toolAllowedByPolicy } from "./mcp-owner-tool-policy.js";
import { researcherStructureProjection } from "./mcp-owner-atlas-presentation.js";

export function filterToolsListMessage(message, policy) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return message;
  return {
    ...message,
    result: {
      ...message.result,
      tools: sortAgentToolDefinitions(tools.filter((tool) => toolAllowedByPolicy(policy, tool?.name))),
    },
  };
}

// A tools/list that answers with a JSON-RPC error leaves the provider with
// no tools at all. Keep the error on the attach proof and surface it on the
// job, so an empty surface is never mistaken for an empty allowlist.
export function toolsListError(message) {
  const error = message?.error;
  if (!error || typeof error !== "object") return null;
  const dataCode = error.data && typeof error.data === "object" ? error.data.code : null;
  return {
    code: error.code ?? null,
    data_code: dataCode ? capString(String(dataCode), 120) : null,
    message: capString(String(error.message || ""), 300),
  };
}

export function recordToolsListFailure(session, listError) {
  const boot = session?.bootConfig || {};
  try {
    recordObservation({
      work_item_id: boot.workItemId ?? null,
      job_id: boot.jobId ?? null,
      attempt_id: boot.attemptId ?? null,
      observation_type: "tool.surface.list_failed",
      summary: `Provider tools/list failed (${listError.data_code || listError.code || "error"}): ${listError.message || "no message"}`,
      detail: {
        ...listError,
        role: boot.role || null,
        provider: boot.providerName || null,
        agent_call_id: boot.agentCallId ?? null,
        session_id: session?.id || null,
      },
    });
  } catch {
    // Telemetry must not change the provider's tools/list response.
  }
}

function atlasActionEnumFromToolsList(message) {
  const tools = message?.result?.tools;
  if (!Array.isArray(tools)) return [];
  const dispatcher = tools.find((tool) => String(tool?.name || "") === "atlas.query");
  const values = dispatcher?.inputSchema?.properties?.action?.enum;
  if (Array.isArray(values)) return values.map((value) => String(value));
  return tools
    .map((tool) => String(tool?.name || ""))
    .filter((name) => name.startsWith("atlas."))
    .map((name) => name.slice("atlas.".length));
}

export function recordProviderIssuedToolSurface(session, message, researchSynthesisPolicyFor) {
  try {
    const tools = message?.result?.tools;
    if (!Array.isArray(tools)) return null;
    const canonical = JSON.stringify(tools);
    const schemaSha256 = crypto.createHash("sha256").update(canonical, "utf8").digest("hex");
    const attemptKey = `${session?.bootConfig?.attemptId ?? "none"}|${schemaSha256}`;
    if (!session._providerIssuedSurfaceKeys) session._providerIssuedSurfaceKeys = new Set();
    if (session._providerIssuedSurfaceKeys.has(attemptKey)) return null;
    session._providerIssuedSurfaceKeys.add(attemptKey);
    const names = tools.map((tool) => String(tool?.name || "")).filter(Boolean);
    const actionEnum = atlasActionEnumFromToolsList(message);
    const policy = sessionToolPolicy(session);
    const boot = session?.bootConfig || {};
    const coverageRequired = getTraversalCompletionSnapshotForCall({
      jobId: boot.jobId ?? null,
      attemptId: boot.attemptId ?? null,
    })?.active === true;
    const detail = {
      kind: "tool_surface_issued",
      projection_stage: "provider_issued",
      names,
      tool_count: names.length,
      action_enum: actionEnum,
      action_enum_source: "atlas_tool_names",
      schema_sha256: schemaSha256,
      schema_chars: canonical.length,
      effective_policy: {
        disable_system_tools: boot.disableSystemTools === true,
        atlas_available: boot.atlasAvailable === true,
        traversal_coverage_required: coverageRequired,
        direct: policy.atlasResearcherDirect === true,
      },
      limits: { ...researchSynthesisPolicyFor(session) },
      projections: {
        ...(usesResearcherAtlasReadSurface(policy) ? { "symbol.callers": COMPACT_RELATIONSHIP_PROJECTION } : {}),
        ...(researcherStructureProjection(session) ? { "code.structure": COMPACT_STRUCTURE_PROJECTION } : {}),
      },
      instructions_sha256: null,
      role: boot.role || null,
      provider: boot.providerName || null,
      agent_call_id: boot.agentCallId ?? null,
    };
    recordObservation({
      work_item_id: boot.workItemId ?? null,
      job_id: boot.jobId ?? null,
      attempt_id: boot.attemptId ?? null,
      observation_type: TOOL_SURFACE_ISSUED_OBSERVATION_TYPE,
      summary: `Provider-issued tool surface: ${names.length} tool${names.length === 1 ? "" : "s"}; ${actionEnum.length} Atlas action${actionEnum.length === 1 ? "" : "s"}; schema ${schemaSha256.slice(0, 12)}`,
      detail,
    });
    return detail;
  } catch {
    return null;
  }
}
