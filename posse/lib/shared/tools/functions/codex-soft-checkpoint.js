import { readContextBudgetCheckpoint } from "../../../domains/billing/functions/context-budget.js";
import { resolveContextCompactionConfig } from "../../../domains/settings/functions/context-compaction.js";
import { getSetting, getWorkItem } from "../../../domains/queue/functions/index.js";

// Called at a tool-result boundary. The provider keeps running; this only
// asks it to condense its working plan before another large context request.
// One checkpoint per agent call: a reusable Agent session is rebound to later
// calls, and each of those has its own context to condense.
export function codexSoftCheckpoint(session, {
  readCheckpoint = readContextBudgetCheckpoint,
  readConfig = resolveContextCompactionConfig,
} = {}) {
  const boot = session?.bootConfig || {};
  if (boot.providerName !== "codex") return null;
  const callId = Number(boot.agentCallId);
  const attemptId = Number(boot.attemptId);
  if (!Number.isSafeInteger(callId) || callId < 1 || !Number.isSafeInteger(attemptId) || attemptId < 1) return null;
  if (session._codexSoftCheckpointCallId === callId) return null;
  const observed = readCheckpoint({ agentCallId: callId, attemptId });
  if (!observed.usable) return null;
  const checkpoint = observed.checkpoint;
  const config = readConfig({ readSetting: getSetting, readWorkItem: getWorkItem, workItemId: boot.workItemId });
  if (config.mode === "off") return null;
  const target = Number(boot.maxTurns);
  const byTurns = Number.isSafeInteger(target) && target > 0 && checkpoint.sequence_id >= target * 2;
  const byContext = checkpoint.request_context_input_tokens >= Math.floor(config.sessionResetInputTokens * 0.8);
  if (!byTurns && !byContext) return null;
  session._codexSoftCheckpointCallId = callId;
  return {
    trigger: byContext ? "near_context_reset" : "twice_turn_target",
    text: "\n\nContext checkpoint: briefly summarize the remaining work, current evidence, and next action in your own working context. Then continue the task. Avoid rereading material already available unless it changed.",
  };
}
