// lib/domains/providers/functions/codex/session.js

import { assertTestContext } from "../../../runtime/functions/test-context.js";
import { CodexExitCleanupRegistry } from "../../classes/codex/CodexExitCleanupRegistry.js";

// Narrow provider lifecycle singleton: tracks temp/config cleanup callbacks for active Codex child processes.
export const codexExitCleanupRegistry = new CodexExitCleanupRegistry();

export function _extractCodexEventBody(msg) {
  if (!msg || typeof msg !== "object") return null;
  if (msg.msg && typeof msg.msg === "object" && typeof msg.msg.type === "string") return msg.msg;
  if (msg.payload && typeof msg.payload === "object" && typeof msg.payload.type === "string") return msg.payload;
  if (typeof msg.type === "string") return msg;
  if (msg.body && typeof msg.body === "object") return _extractCodexEventBody(msg.body);
  return null;
}

export function normalizeCodexSessionHandle(value) {
  const text = String(value || "").trim();
  return text || null;
}

function pickCodexSessionHandle(candidate) {
  if (!candidate || typeof candidate !== "object") return null;
  for (const key of [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
    "thread_id",
    "threadId",
  ]) {
    const handle = normalizeCodexSessionHandle(candidate[key]);
    if (handle) return handle;
  }
  return null;
}

export function extractCodexSessionHandleFromStreamMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const body = _extractCodexEventBody(msg);
  const candidates = [
    body,
    msg.session,
    msg.conversation,
    msg.thread,
    msg.result,
    msg.response,
    msg.payload,
    msg.msg,
  ];
  for (const candidate of candidates) {
    const handle = pickCodexSessionHandle(candidate);
    if (handle) return handle;
  }
  return null;
}

export function __testExtractCodexSessionHandleFromStreamMessage(msg) {
  return extractCodexSessionHandleFromStreamMessage(msg);
}

export function __testRegisterCodexExitCleanup(cleanup) {
  assertTestContext("__testRegisterCodexExitCleanup");
  return codexExitCleanupRegistry.register(cleanup);
}

export function __testDrainCodexExitCleanups() {
  assertTestContext("__testDrainCodexExitCleanups");
  codexExitCleanupRegistry.drain();
}
