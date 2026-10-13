import { SUB_AGENT_ROUTING_MIN_EVIDENCE_CALLS, SUB_AGENT_ROUTING_MIN_TARGETS, SUB_AGENT_ROUTING_MIN_MATERIALIZED_CHARS, SUB_AGENT_ROUTING_EVIDENCE_TOOLS, SUB_AGENT_ROUTING_WRITE_TOOLS } from "../../../catalog/sub-agent.js";
import { materializeAgentHandoffEvidenceSelector } from "../../../domains/handoff/functions/agent-handoff.js";
import { subAgentDispatchIdentities, subAgentEvidenceCallIdentities, subAgentMutationTargetKeys } from "../../../domains/sub-agent/functions/routing-identity.js";
import { classifyDelegatedToolResult } from "../../../domains/sub-agent/functions/delegated-evidence.js";
import { SUB_AGENT_EVIDENCE_OUTCOMES } from "../../../catalog/sub-agent.js";
import { createSubAgentRoutingState } from "./mcp-owner-session-support.js";

const SUB_AGENT_ROUTING_REMINDER =
  "\n\nSUB-AGENT ROUTING CHECKPOINT: multiple repository targets have now required two parent evidence calls. " +
  "Before another read or materialization call, dispatch one sub_agent batch with completion.mode=wait_all when at least two related targets still need synthesis. " +
  "Prefer one citation_synthesis.v1 request with two or three ordered inputs; use separate requests only for genuinely independent syntheses. " +
  "Treat the returned cited synthesis as a substitute for those reads rather than immediately reopening the delegated inputs. " +
  "Continue directly only when the current context already contains the answers or the remaining question needs one targeted call.";

const SUB_AGENT_ROUTING_BLOCK =
  "Sub-agent routing required before another parent evidence call: at least two reads across multiple repository targets have already completed. " +
  "Dispatch one sub_agent batch with completion.mode=wait_all, preferring one citation_synthesis.v1 request with two or three ordered inputs for related targets, " +
  "or continue without another read if current context is sufficient.";

const SUB_AGENT_DELEGATED_REPEAT_BLOCK =
  "Duplicate delegated read suppressed successfully: this exact evidence selection was already materialized and synthesized by the completed citation child. " +
  "Use the returned cited packet as the inspection result and synthesize now. " +
  "Do not retry this selection through another evidence tool. A successful write to the target still permits post-edit verification.";

const SUB_AGENT_REDUNDANT_DISPATCH_BLOCK =
  "Every requested sub-agent evidence selection is already present in the parent context from successful evidence calls. " +
  "Do not dispatch a child to reread completed parent work; make the decision or mutation directly.";

export function subAgentRoutingEnabled(policy) {
  return policy?.suites?.tools?.has("sub_agent") === true;
}

function subAgentIdentityOptions(context = null) {
  return {
    materializeRef: context && typeof context === "object"
      ? (ref) => materializeAgentHandoffEvidenceSelector(ref, context)
      : null,
  };
}

export function subAgentRoutingContext(session) {
  const boot = session?.bootConfig || {};
  return {
    work_item_id: boot.workItemId ?? null,
    job_id: boot.jobId ?? null,
    attempt_id: boot.attemptId ?? null,
    agent_call_id: boot.agentCallId ?? null,
  };
}

function subAgentRoutingIdentities(requested, args = {}, result = null, context = null) {
  if (requested?.suite === "tools" && requested?.name === "sub_agent") {
    return subAgentDispatchIdentities(args, subAgentIdentityOptions(context));
  }
  return subAgentEvidenceCallIdentities(requested, args, result);
}

function replaceDelegatedTargetSummary(state) {
  state.delegatedTargets.clear();
  for (const targets of state.delegatedSelections.values()) {
    for (const target of targets) state.delegatedTargets.add(target);
  }
}

export function subAgentRoutingBlockReason(state, requested, args = {}, context = null) {
  if (!state) return "";
  const identities = subAgentRoutingIdentities(requested, args, null, context);
  if (
    requested?.suite === "tools"
    && requested?.name === "sub_agent"
    && args?.op === "dispatch"
    && identities.selectionKeys.size > 0
    && [...identities.selectionKeys].every((selection) => state.selections.has(selection))
  ) {
    return "redundant_dispatch";
  }
  if (!SUB_AGENT_ROUTING_EVIDENCE_TOOLS.has(`${requested?.suite}.${requested?.name}`)) return "";
  if (state.dispatched
    && [...identities.selectionKeys].some((selection) => state.delegatedSelections.has(selection))) {
    return "delegated_repeat";
  }
  if (state.mutated) return "";
  if (state.dispatched) return "";
  return state.evidenceCalls >= SUB_AGENT_ROUTING_MIN_EVIDENCE_CALLS
    && state.materializedChars >= SUB_AGENT_ROUTING_MIN_MATERIALIZED_CHARS
    && state.targets.size >= SUB_AGENT_ROUTING_MIN_TARGETS
    ? "required"
    : "";
}

function subAgentMaterializedChars(result) {
  const content = result?.result?.content;
  if (!Array.isArray(content)) return 0;
  return content.reduce((total, part) => (
    total + (part?.type === "text" && typeof part.text === "string" ? part.text.length : 0)
  ), 0);
}

export function noteSubAgentRoutingSuccess(state, requested, args = {}, result = null, context = null) {
  if (!state) return "";
  if (requested?.suite === "tools" && requested?.name === "sub_agent") {
    state.dispatched = true;
    const completedWaitAll = args?.op === "dispatch"
      && args?.completion?.mode === "wait_all"
      && Array.isArray(result?.results)
      && result.results.length > 0
      && result.results.every((entry) => (
        entry?.status === "completed"
        && ["complete", "partial"].includes(entry?.packet?.outcome)
    ));
    if (completedWaitAll) {
      const identities = subAgentRoutingIdentities(requested, args, result, context);
      for (const selection of identities.selectionKeys) {
        state.delegatedSelections.set(
          selection,
          new Set(identities.selectionTargets?.get(selection) || []),
        );
      }
      replaceDelegatedTargetSummary(state);
    }
    return "";
  }
  if (SUB_AGENT_ROUTING_WRITE_TOOLS.has(`${requested?.suite}.${requested?.name}`)) {
    state.mutated = true;
    const mutatedTargets = subAgentMutationTargetKeys(args);
    for (const [selection, targets] of state.delegatedSelections) {
      if ([...targets].some((target) => mutatedTargets.has(target))) {
        state.delegatedSelections.delete(selection);
      }
    }
    replaceDelegatedTargetSummary(state);
    return "";
  }
  if (!SUB_AGENT_ROUTING_EVIDENCE_TOOLS.has(`${requested?.suite}.${requested?.name}`)) return "";
  if (result?.result
    && classifyDelegatedToolResult(result.result).outcome !== SUB_AGENT_EVIDENCE_OUTCOMES.DELIVERED) {
    return "";
  }
  const identities = subAgentRoutingIdentities(requested, args, result, context);
  state.evidenceCalls += 1;
  state.materializedChars += subAgentMaterializedChars(result);
  for (const target of identities.targetKeys) state.targets.add(target);
  for (const selection of identities.selectionKeys) {
    state.selections.set(selection, new Set(identities.selectionTargets?.get(selection) || []));
  }
  if (
    !state.mutated
    && !state.dispatched
    && !state.reminderIssued
    && state.evidenceCalls >= SUB_AGENT_ROUTING_MIN_EVIDENCE_CALLS
    && state.materializedChars >= SUB_AGENT_ROUTING_MIN_MATERIALIZED_CHARS
    && state.targets.size >= SUB_AGENT_ROUTING_MIN_TARGETS
  ) {
    state.reminderIssued = true;
    return SUB_AGENT_ROUTING_REMINDER;
  }
  return "";
}

export function subAgentObservationResults(results) {
  return Array.isArray(results) ? results.map((entry) => ({
    id: entry?.id || null,
    status: entry?.status || null,
    outcome: entry?.packet?.outcome || null,
    error_code: entry?.error?.code || null,
    coverage: entry?.coverage ? {
      authorized: entry.coverage.authorized ?? null,
      consumed: entry.coverage.consumed ?? null,
      selected: entry.coverage.selected ?? null,
      unconsumed: entry.coverage.unconsumed ?? null,
      stopped_early: entry.coverage.stopped_early === true,
    } : null,
  })) : [];
}

export function __testSubAgentObservationResults(results) {
  return subAgentObservationResults(results);
}

export function subAgentInputObservationDetails(result) {
  const entries = result?.op === "next_input_batch" && Array.isArray(result.results)
    ? result.results
    : result ? [result] : [];
  const inputIds = entries.map((entry) => entry?.input?.id).filter(Boolean).slice(0, 3);
  const errorCodes = [...new Set(entries.map((entry) => entry?.error?.code).filter(Boolean))].slice(0, 3);
  return {
    input_id: entries.length === 1 ? inputIds[0] || null : null,
    input_ids: inputIds,
    result_count: entries.length,
    succeeded_count: entries.filter((entry) => entry?.ok === true).length,
    failed_count: entries.filter((entry) => entry?.ok !== true).length,
    error_codes: errorCodes,
    evidence_chars: entries.reduce((total, entry) => total + (entry?.evidence?.lines || [])
      .reduce((sum, line) => sum + String(line?.text || "").length, 0), 0),
    evidence_lines: entries.reduce((total, entry) => total + (entry?.evidence?.lines?.length || 0), 0),
  };
}

export function __testSubAgentInputObservationDetails(result) {
  return subAgentInputObservationDetails(result);
}

export function subAgentRoutingGuardResult(reason) {
  const delegatedRepeat = reason === "delegated_repeat";
  const redundantDispatch = reason === "redundant_dispatch";
  return {
    content: [{
      type: "text",
      text: delegatedRepeat
        ? SUB_AGENT_DELEGATED_REPEAT_BLOCK
        : redundantDispatch
          ? SUB_AGENT_REDUNDANT_DISPATCH_BLOCK
          : SUB_AGENT_ROUTING_BLOCK,
    }],
    // A delegated repeat is a successful deduplication, not an execution
    // failure. Marking it as an error makes providers troubleshoot the guard
    // by retrying the same target through alternate read tools.
    isError: !delegatedRepeat,
  };
}

export function __testSubAgentRoutingGuardResult(reason) {
  return subAgentRoutingGuardResult(reason);
}

export function __testSubAgentRoutingSequence(calls = []) {
  const state = createSubAgentRoutingState();
  return calls.map((call) => {
    const requested = {
      suite: String(call?.suite || ""),
      name: String(call?.name || ""),
    };
    const delegatedEvidence = call?.delegatedEvidence === true;
    const blockReason = delegatedEvidence
      ? ""
      : subAgentRoutingBlockReason(state, requested, call?.args || {});
    const blocked = !!blockReason;
    const reminder = blocked || delegatedEvidence
      ? ""
      : noteSubAgentRoutingSuccess(state, requested, call?.args || {}, call?.result || null);
    return {
      blocked,
      reminder: !!reminder,
      evidenceCalls: state.evidenceCalls,
      targets: state.targets.size,
      delegatedTargets: state.delegatedTargets.size,
      dispatched: state.dispatched,
    };
  });
}

export function __testSubAgentRoutingEnabled(toolNames = []) {
  return subAgentRoutingEnabled({
    suites: { tools: new Set(toolNames.map((name) => String(name))) },
  });
}
