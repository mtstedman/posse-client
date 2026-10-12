// @ts-check



export function promptFromGatePayload(payload, { fallback = null, responsePrompt = false } = {}) {
  if (Array.isArray(payload?.questions) && payload.questions.length > 0) {
    return payload.questions.map((question) => String(question || "").trim()).filter(Boolean).join("\n\n");
  }
  if (typeof payload?.prompt === "string" && payload.prompt.trim()) return payload.prompt.trim();
  if (responsePrompt && typeof payload?.response_prompt === "string" && payload.response_prompt.trim()) return payload.response_prompt.trim();
  return fallback;
}
