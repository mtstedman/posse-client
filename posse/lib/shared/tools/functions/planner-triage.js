// @ts-check

import { mcpToolErrorPayload, ownerErrorSummary } from "./mcp-owner-session-support.js";
import crypto from "node:crypto";
import { subAgentRuntime } from "../../../domains/sub-agent/classes/SubAgentRuntime.js";
import { PLANNER_DISPATCH_SETTINGS } from "../../../catalog/planner-dispatch.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { recordObservation } from "../../../domains/observability/functions/observations.js";
import { isResearchAtlasCitationFetchAction, isResearchAtlasExplorationAction } from "../../../domains/integrations/functions/deterministic-mcp/research-synthesis.js";
import { appendRunTelemetry } from "../../telemetry/functions/run-telemetry.js";

export const OWNER_MODEL_CONTROL_NOTICES = Symbol("ownerModelControlNotices");

export function appendToolResultText(response, suffix, { kind = "runtime_control", trigger = null } = {}) {
  if (!suffix || !response || response?.result?.isError === true) return response;
  const result = appendOwnerModelControlNotice(response.result, suffix, { kind, trigger });
  return result === response.result ? response : { ...response, result };
}

// Planner-owned direct-path read budget. The research decision belongs before
// these calls. Count reads before and after delegation against the same
// frozen allowance; completion, clarification and delegation stay available.
//
// The setting is stated in turns; the owner sees calls, and planners measured
// ~1.81 calls per turn (median 2), so the call threshold is two per budgeted
// turn.
export const PLANNER_TRIAGE_CALLS_PER_TURN = 2;

export const PLANNER_TRIAGE_DEFAULT_TURNS = Number(PLANNER_DISPATCH_SETTINGS
  .find((entry) => entry.key === SETTING_KEYS.PLANNER_DISPATCH_TRIAGE_MAX_TURNS)?.default) || 6;

export const PLANNER_TRIAGE_UNCOUNTED_TOOLS = new Set([
  "tools.dispatch_agent",
  "tools.agent_handoff",
  "tools.ack_operator_feedback",
]);

export function createPlannerTriageState() {
  return { calls: 0, admittedCalls: 0, dispatched: false, pathNoticeIssued: false, budgetNoticeIssued: false };
}

export function plannerTriageEnabled(session, policy) {
  const boot = session?.bootConfig || {};
  return String(boot.role || "").trim().toLowerCase() === "planner"
    && boot.researchInvestigation === true
    && policy?.suites?.tools?.has("dispatch_agent") === true;
}

// Read the direct-path budget from the policy frozen for this planner call
// (the one its prompt rendered), falling back to the catalog default.
export function plannerTriageThresholdCalls(agentCallId) {
  const configured = Number(subAgentRuntime.parents.get(Number(agentCallId))?.researchPolicy?.triageMaxTurns);
  const turns = Number.isSafeInteger(configured) && configured > 0 ? configured : PLANNER_TRIAGE_DEFAULT_TURNS;
  return { turns, calls: turns * PLANNER_TRIAGE_CALLS_PER_TURN };
}

export function plannerTriageNoticeText(turns) {
  return `\n\nDirect-path read budget reached (~${turns} turn${turns === 1 ? "" : "s"} of planner-owned reads). `
    + "Finish or hand off the plan now; do not start research after accumulating this context.";
}

export function plannerPathNoticeText(turns) {
  return "\n\nResearch decision checkpoint: keep orientation to at most two bounded calls before choosing the research path. "
    + "If substantial investigation is already clear, dispatch now; otherwise resolve the remaining scope uncertainty or continue directly "
    + `and do not dispatch later after accumulating planner context. Direct-path budget: ~${turns} turn${turns === 1 ? "" : "s"}.`;
}

export function plannerLateDispatchNoticeText(calls) {
  return `\n\nLate-dispatch checkpoint: research was dispatched after ${calls} planner-owned tool call${calls === 1 ? "" : "s"}. `
    + "Use the returned findings now and limit further planner reads to narrow, plan-blocking verification.";
}

export function plannerTriageSessionState(session, policy) {
  if (!session || !plannerTriageEnabled(session, policy)) return null;
  if (!session._plannerTriage) session._plannerTriage = createPlannerTriageState();
  return session._plannerTriage;
}

// Count one successful planner call; returns the one-shot notice text when the
// budget is crossed, otherwise "". The caller appends it to the tool result.
// Only a dispatch_agent call that succeeded ends counting: a failed dispatch
// leaves the planner reading on its own, which is what the notice is for.
export function notePlannerTriageCall(session, policy, requested, { record = recordObservation } = {}) {
  const state = plannerTriageSessionState(session, policy);
  if (!state) return "";
  const boot = session.bootConfig || {};
  if (`${requested?.suite}.${requested?.name}` === "tools.dispatch_agent") {
    state.dispatched = true;
    if (state.calls > 0) {
      try {
        record({
          work_item_id: boot.workItemId ?? null,
          job_id: boot.jobId ?? null,
          attempt_id: boot.attemptId ?? null,
          observation_type: "planner.dispatch_after_own_reads",
          summary: `Planner dispatched research after ${state.calls} own tool call(s)`,
          detail: {
            calls_before_dispatch: state.calls,
            agent_call_id: boot.agentCallId ?? null,
          },
        });
      } catch {
        // Prompt pressure and telemetry must not break a successful dispatch.
      }
      return plannerLateDispatchNoticeText(state.calls);
    }
    return "";
  }
  if (PLANNER_TRIAGE_UNCOUNTED_TOOLS.has(`${requested?.suite}.${requested?.name}`)) return "";
  state.calls += 1;
  const threshold = plannerTriageThresholdCalls(boot.agentCallId);
  if (!state.pathNoticeIssued && !state.dispatched) {
    state.pathNoticeIssued = true;
    try {
      record({
        work_item_id: boot.workItemId ?? null,
        job_id: boot.jobId ?? null,
        attempt_id: boot.attemptId ?? null,
        observation_type: "planner.direct_path_started",
        summary: "Planner made an own tool call before dispatching research",
        detail: {
          calls: state.calls,
          direct_read_budget_calls: threshold.calls,
          direct_read_budget_turns: threshold.turns,
          tool: `${requested?.suite}.${requested?.name}`,
          agent_call_id: boot.agentCallId ?? null,
        },
      });
    } catch {
      // The notice is advisory; telemetry must not break the tool result.
    }
    return plannerPathNoticeText(threshold.turns);
  }
  if (state.budgetNoticeIssued || state.calls < threshold.calls) return "";
  state.budgetNoticeIssued = true;
  try {
    record({
      work_item_id: boot.workItemId ?? null,
      job_id: boot.jobId ?? null,
      attempt_id: boot.attemptId ?? null,
      observation_type: "planner.triage_budget_exceeded",
      summary: `Planner direct-path read budget reached after ${state.calls} call(s)`,
      detail: {
        calls: state.calls,
        threshold: threshold.calls,
        triage_max_turns: threshold.turns,
        tool: `${requested?.suite}.${requested?.name}`,
        agent_call_id: boot.agentCallId ?? null,
      },
    });
  } catch {
    // The notice is advisory; telemetry must not break the tool result.
  }
  return plannerTriageNoticeText(threshold.turns);
}

export function reservePlannerRead(session, policy, requested) {
  if (!isResearchPhysicalWorkRequest(requested)) return null;
  const state = plannerTriageSessionState(session, policy);
  if (!state) return null;
  const threshold = plannerTriageThresholdCalls(session.bootConfig?.agentCallId);
  // Admission is synchronous, before dispatch, so concurrent calls cannot all
  // consume the last slot. Failed reads consume their physical call as well.
  if (state.admittedCalls < threshold.calls) {
    state.admittedCalls++;
    return null;
  }
  return mcpToolErrorPayload(
    `Planner read allowance exhausted (${threshold.calls} calls${state.dispatched ? ", including reads after child research" : ""}). `
      + `Counted: ${[...RESEARCH_NATIVE_PHYSICAL_WORK_TOOLS].join(", ")}, Atlas exploration and citation reads. `
      + "Clarification, dispatch, handoff, feedback, environment inspection and unit tests do not count. "
      + "Use the evidence already returned to finish the plan. If evidence is insufficient, report the specific gap or ask a focused clarification; do not claim an unverified conclusion.",
    { code: "planner_read_budget_exhausted" },
  );
}

export function appendPlannerTriageNotice(response, session, policy, requested, toolName) {
  if (!mcpToolCallSuccess(response)) return response;
  const notice = notePlannerTriageCall(session, policy, requested);
  const budgetNotice = notice.includes("Direct-path read budget reached");
  const finalized = appendToolResultText(response, notice, {
    kind: budgetNotice ? "planner_triage_budget" : "planner_research_decision",
    trigger: budgetNotice ? "planner_triage_threshold" : "planner_research_decision_checkpoint",
  });
  if (finalized !== response) {
    recordOwnerModelControlNotice(session, toolName, {
      kind: budgetNotice ? "planner_triage_budget" : "planner_research_decision",
      text: notice,
      trigger: budgetNotice ? "planner_triage_threshold" : "planner_research_decision_checkpoint",
    });
  }
  return finalized;
}

export function __testPlannerTriageSequence({
  role = "planner",
  researchInvestigation = true,
  tools = ["dispatch_agent", "agent_handoff", "read_file"],
  agentCallId = null,
} = {}, calls = []) {
  const session = { bootConfig: { role, researchInvestigation, agentCallId } };
  const policy = { suites: { tools: new Set(tools.map((name) => String(name))) } };
  const observations = [];
  const record = (entry) => { observations.push(entry); return true; };
  const notices = calls.map((call) => {
    const requested = { suite: String(call?.suite || "tools"), name: String(call?.name || "") };
    if (call?.ok === false) return "";
    return notePlannerTriageCall(session, policy, requested, { record });
  });
  return { notices, observations, state: session._plannerTriage || null };
}

export const ATLAS_NESTED_ACTION_WRAPPERS = new Set(["query", "code", "repo", "agent", "workflow"]);

export const RESEARCH_NATIVE_PHYSICAL_WORK_TOOLS = new Set([
  "read_file",
  "chain_verdict",
  "list_files",
  "search_files",
  "git_history",
  "inspect_file",
  "hash_file",
]);

// Research admission/classification must see the REAL action: gateway wrappers
// (atlas_query/atlas_code/atlas_repo/...) carry it nested in args.action, and
// classifying by the wrapper name would serialize concurrent-eligible reads
// and let a wrapped fetch.ref bypass the citation gate.
export function effectiveAtlasResearchAction(requested) {
  if (!requested || requested.suite !== "atlas") return requested?.name || "";
  return ATLAS_NESTED_ACTION_WRAPPERS.has(requested.name) && requested.nested
    ? requested.nested
    : requested.name;
}

export function isResearchPhysicalWorkRequest(requested) {
  if (!requested) return false;
  if (requested.suite === "atlas") {
    const action = effectiveAtlasResearchAction(requested);
    if (action === "workflow") return false;
    return isResearchAtlasExplorationAction(action)
      || isResearchAtlasCitationFetchAction(action);
  }
  return requested.suite === "tools"
    && RESEARCH_NATIVE_PHYSICAL_WORK_TOOLS.has(requested.name);
}

export function attachTelemetryContext(session, ownerBootId, bootConfig = session?.bootConfig || {}) {
  const boot = bootConfig || {};
  return {
    component: "deterministic_mcp",
    owner_boot_id: ownerBootId || null,
    session_id: session?.id || null,
    provider: boot.providerName || null,
    role: boot.role || null,
    work_item_id: boot.workItemId ?? null,
    job_id: boot.jobId ?? null,
    attempt_id: boot.attemptId ?? null,
  };
}

export function ownerControlNoticePublicMetadata(notice = {}) {
  return {
    kind: String(notice.kind || "runtime_control"),
    chars: String(notice.text || "").length,
    sha256: crypto.createHash("sha256").update(String(notice.text || ""), "utf8").digest("hex"),
    ...(notice.trigger ? { trigger: String(notice.trigger) } : {}),
    ...(notice.explorationStep != null && Number.isFinite(Number(notice.explorationStep))
      ? { exploration_step: Number(notice.explorationStep) }
      : {}),
  };
}

export function appendOwnerModelControlNotice(result, suffix, detail = {}) {
  const content = result?.content;
  if (!Array.isArray(content) || !suffix) return result;
  const textIndex = content.findIndex((part) => part?.type === "text" && typeof part.text === "string");
  if (textIndex < 0) return result;
  const textPart = content[textIndex];
  const notice = {
    kind: detail.kind || "runtime_control",
    text: String(suffix),
    trigger: detail.trigger || null,
    explorationStep: detail.explorationStep ?? null,
  };
  const publicNotice = ownerControlNoticePublicMetadata(notice);
  const priorPublic = Array.isArray(result?._meta?.posseControlNotices)
    ? result._meta.posseControlNotices
    : [];
  const next = {
    ...result,
    content: content.map((part, index) => (
      index === textIndex ? { ...textPart, text: `${textPart.text}${notice.text}` } : part
    )),
    _meta: {
      ...(result?._meta && typeof result._meta === "object" ? result._meta : {}),
      posseControlNotices: [...priorPublic, publicNotice],
    },
  };
  Object.defineProperty(next, OWNER_MODEL_CONTROL_NOTICES, {
    value: [...(result?.[OWNER_MODEL_CONTROL_NOTICES] || []), notice],
    enumerable: false,
  });
  return next;
}

export function mcpToolCallSuccess(response = null) {
  const result = response?.result;
  if (!result || result.isError === true) return false;
  if (result?._meta?.posseControlOnly === true) return false;
  const text = Array.isArray(result?.content)
    ? result.content.map((entry) => typeof entry?.text === "string" ? entry.text : "").join("")
    : "";
  return !/^(?:Error:|AUDIT ERROR:)/i.test(String(text || ""));
}

export function recordOwnerModelControlNotice(session, toolName, notice = {}) {
  const boot = session?.bootConfig || {};
  try {
    recordObservation({
      work_item_id: boot.workItemId ?? null,
      job_id: boot.jobId ?? null,
      attempt_id: boot.attemptId ?? null,
      observation_type: "tool.response_control",
      summary: `Model-visible ${notice.kind || "runtime"} notice appended to ${toolName || "tool result"}`,
      detail: {
        kind: notice.kind || "runtime_control",
        tool: toolName || null,
        text: String(notice.text || ""),
        chars: String(notice.text || "").length,
        trigger: notice.trigger || null,
        exploration_step: notice.explorationStep ?? null,
        source: "mcp_owner",
      },
    });
  } catch (error) {
    try {
      appendRunTelemetry("diagnostics", {
        kind: "mcp.owner.response_control_observation_failed",
        ...attachTelemetryContext(session, null),
        tool_name: toolName || null,
        control_kind: notice.kind || "runtime_control",
        error: ownerErrorSummary(error),
      });
    } catch {
      // Response-control telemetry is advisory and must not break a tool result.
    }
  }
}
