export { operatorFeedbackDeliveryForJob, operatorFeedbackDeliveryText } from "./operator-feedback-delivery.js";
export { parseToolArgs, createStandardToolHandlerMap, executeToolWithMap } from "./legacy-embedded-tools.js";
import { stripPosseMcpGatewayPrefix } from "../../../integrations/functions/mcp-gateway.js";
import { ToolCatalog } from "../../../../shared/tools/classes/ToolCatalog.js";
import { OPERATOR_FEEDBACK_DELIVERY_MARKER } from "../../../../catalog/operator-feedback.js";
import { canonicalAtlasToolUseActionName, formatAtlasToolUseDisplayName } from "../../../../shared/tools/functions/mcp-surface.js";
import { atlasSummaryHint } from "../../../observability/functions/observations.js";

export function truncateToolResultPreservingFeedback(result, maxChars = 100000) {
  const text = String(result ?? "");
  const limit = Math.max(1, Number(maxChars) || 100000);
  if (text.length <= limit) return text;
  const marker = `\n\n${OPERATOR_FEEDBACK_DELIVERY_MARKER}:`;
  const deliveryIndex = text.lastIndexOf(marker);
  const truncationNotice = "\n... (tool result truncated; operator feedback preserved)";
  if (deliveryIndex < 0) return `${text.slice(0, limit)}\n... (truncated at ${Math.round(limit / 1000)} KB)`;
  const delivery = text.slice(deliveryIndex);
  const headChars = Math.max(0, limit - delivery.length - truncationNotice.length);
  return `${text.slice(0, headChars)}${truncationNotice}${delivery}`;
}

const OBSERVED_TOOL_FORMATTERS = {
  Read(input = {}) {
    return { target: input.file_path || "", summary: `Read: ${input.file_path || "?"}` };
  },
  Glob(input = {}) {
    return { target: input.pattern || "", summary: `Glob: ${input.pattern || "?"}` };
  },
  Grep(input = {}) {
    const pattern = input.pattern || "?";
    const where = input.path || input.glob || "";
    return {
      target: where ? `"${pattern}" in ${where}` : `"${pattern}"`,
      summary: `Grep: "${pattern}" in ${where || "."}`,
    };
  },
  Write(input = {}) {
    return { target: input.file_path || "", summary: `Write: ${input.file_path || "?"}` };
  },
  Edit(input = {}) {
    return { target: input.file_path || "", summary: `Edit: ${input.file_path || "?"}` };
  },
  Bash(input = {}) {
    const command = String(input.command || "");
    return {
      target: command.slice(0, 60),
      summary: `Bash: ${(command || "?").slice(0, 80)}`,
    };
  },
  chain_read(input = {}) {
    return { target: input.path || "", summary: `ChainRead: ${input.path || "?"}` };
  },
  chain_verdict(input = {}) {
    const verdict = String(input.verdict || "?").slice(0, 20);
    return { target: verdict, summary: `ChainVerdict: ${verdict}` };
  },
  agent_feedback(input = {}) {
    return { target: input.phase || "", summary: `AgentFeedback: ${input.summary || input.phase || "update"}` };
  },
  get_operator_feedback(input = {}) {
    return { target: "", summary: `GetFeedback: limit ${input.limit || 20}` };
  },
  ack_operator_feedback(input = {}) {
    return { target: String(input.interaction_id || ""), summary: `AckFeedback: #${input.interaction_id || "?"} ${input.decision || "accepted"}` };
  },
  agent_handoff(input = {}) {
    return { target: input.profile || "", summary: `AgentHandoff: ${input.profile || "?"} ${input.outcome || "?"}` };
  },
  sub_agent(input = {}) {
    return { target: input.batch_id || input.op || "", summary: `SubAgent: ${input.op || "?"}` };
  },
  sub_agent_next_input(input = {}) {
    return { target: String(input.position ?? ""), summary: `SubAgentInput: ${input.position ?? "?"}` };
  },
  dispatch_agent(input = {}) {
    return { target: input.agent_type || input.route || "", summary: `DispatchAgent: ${input.agent_type || input.route || "?"} ${input.question || ""}` };
  },
  web_research_handoff(input = {}) {
    return { target: input.protocol || "", summary: `WebResearchHandoff: ${(input.findings || []).length} finding(s)` };
  },
  read_file(input = {}) {
    return { target: input.path || "", summary: `Read: ${input.path || "?"}` };
  },
  write_file(input = {}) {
    return { target: input.path || "", summary: `Write: ${input.path || "?"}` };
  },
  edit_file(input = {}) {
    return { target: input.path || "", summary: `Edit: ${input.path || "?"}` };
  },
  list_files(input = {}) {
    return { target: input.path || "", summary: `List: ${input.path || "."}` };
  },
  search_files(input = {}) {
    const pattern = input.pattern || "?";
    return { target: pattern, summary: `Search: "${pattern}"` };
  },
  inspect_file(input = {}) {
    return { target: input.path || "", summary: `Inspect: ${input.path || "?"}` };
  },
  validate_artifact_output(input = {}) {
    return { target: input.output_root || ".", summary: `ValidateArtifact: ${input.output_root || "."}` };
  },
  prune_artifact_output(input = {}) {
    return { target: input.output_root || ".", summary: `PruneArtifact: ${input.output_root || "."}` };
  },
  bash(input = {}) {
    const command = String(input.command || "");
    return { target: command.slice(0, 60), summary: `Bash: ${(command || "?").slice(0, 80)}` };
  },
};

function atlasToolTarget(input = {}) {
  const candidates = [
    input.file,
    input.filePath,
    input.path,
    input.query,
    input.pattern,
    input.repoId,
    input.sliceHandle,
    input.taskText,
  ];
  const first = candidates.find((value) => value != null && String(value).trim() !== "");
  if (first) return String(first).split(/\r?\n/)[0].slice(0, 80);
  if (input.symbolId) return "symbol target";
  if (Array.isArray(input.symbolIds) && input.symbolIds.length > 0) {
    return `${input.symbolIds.length} symbol target${input.symbolIds.length === 1 ? "" : "s"}`;
  }
  return "";
}

function observationValueFromKeys(input = {}, keys = []) {
  for (const key of keys || []) {
    const value = input?.[key];
    if (Array.isArray(value)) {
      const first = value.find((item) => item != null && String(item).trim() !== "");
      if (first != null) return String(first);
      continue;
    }
    if (value != null && String(value).trim() !== "") return String(value);
  }
  return "";
}

function summarizeCatalogObservedToolUse(toolName, input = {}) {
  const entry = ToolCatalog.getCanonical(toolName);
  const observation = entry?.observation;
  if (!observation?.label) return null;
  const source = observationValueFromKeys(input, observation.sourceKey ? [observation.sourceKey] : []);
  const destination = observationValueFromKeys(input, observation.destinationKey ? [observation.destinationKey] : []);
  const target = source || destination
    ? `${source || "?"} -> ${destination || "?"}`
    : observationValueFromKeys(input, [
        observation.commandKey,
        observation.rootKey,
        ...(observation.pathKeys || []),
        ...(observation.arrayPathKeys || []),
        ...(observation.targetKeys || []),
      ]);
  const clippedTarget = String(target || "").split(/\r?\n/)[0].slice(0, 80);
  return {
    target: clippedTarget,
    summary: `${observation.label}${clippedTarget ? `: ${clippedTarget}` : ""}`,
  };
}

export function summarizeObservedToolUse(toolName, input = {}) {
  const raw = String(toolName || "");
  const atlasDisplayName = formatAtlasToolUseDisplayName(raw, input);
  if (atlasDisplayName) {
    const action = canonicalAtlasToolUseActionName(raw, input);
    const target = atlasSummaryHint(input, action) || atlasToolTarget(input);
    return {
      target,
      summary: `${atlasDisplayName}${target ? `: ${target}` : ""}`,
    };
  }
  // Claude/Codex surface deterministic-toolkit tools under an MCP prefix;
  // strip it so the formatter table matches bare names uniformly.
  const normalized = stripPosseMcpGatewayPrefix(raw);
  const formatter = OBSERVED_TOOL_FORMATTERS[normalized];
  if (typeof formatter === "function") return formatter(input);
  const catalogSummary = summarizeCatalogObservedToolUse(normalized, input);
  if (catalogSummary) return catalogSummary;
  const fallback = Object.values(input).filter((value) => typeof value === "string").join(" ");
  return {
    target: fallback.slice(0, 60),
    summary: `${normalized || "Tool"}: ${JSON.stringify(input || {}).slice(0, 80)}`,
  };
}
