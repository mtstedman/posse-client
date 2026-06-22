export function extractClaudeSessionHandleFromStreamMessage(msg) {
  if (!msg || typeof msg !== "object") return null;
  const directKeys = [
    "session_id",
    "sessionId",
    "conversation_id",
    "conversationId",
  ];
  for (const key of directKeys) {
    const value = msg[key];
    if (typeof value === "string" && value.trim()) return value.trim();
  }
  const nestedCandidates = [
    msg.session,
    msg.conversation,
    msg.result,
    msg.message,
    msg.metadata,
  ];
  for (const candidate of nestedCandidates) {
    if (!candidate || typeof candidate !== "object") continue;
    const nested = extractClaudeSessionHandleFromStreamMessage(candidate);
    if (nested) return nested;
  }
  return null;
}

export function isClaudeResumeHandleExpiredError(text) {
  return /no\s+(?:session|conversation|resume)(?:\s+\w+)*\s+found|(?:session|conversation|resume).*(?:not\s+found|unknown|invalid|expired)|(?:not\s+found|unknown|invalid|expired).*(?:session|conversation|resume)/i
    .test(String(text || ""));
}
