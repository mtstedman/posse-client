export const PROMPT_BODY_STORAGE_REASON = "prompt_and_skill_content_are_remote_owned";

export const PROMPT_BODY_STORAGE_NOTICE =
  "Prompt body intentionally omitted from local storage; prompt and skill content are remote-owned.";

export function promptMetadataPreview({
  role = null,
  provider = null,
  promptChars = null,
  systemPromptChars = null,
} = {}) {
  return [
    "Prompt metadata only (body remote-owned)",
    role ? `role=${role}` : null,
    provider ? `provider=${provider}` : null,
    promptChars != null && Number.isFinite(Number(promptChars)) ? `prompt_chars=${Number(promptChars)}` : null,
    systemPromptChars != null && Number.isFinite(Number(systemPromptChars)) ? `system_prompt_chars=${Number(systemPromptChars)}` : null,
  ].filter(Boolean).join(" ");
}

export function normalizePromptPersistenceSummary(value) {
  const text = String(value || "");
  if (!/^PROMPT CONTENT NOT PERSISTED\s*(?:\r?\n|$)/.test(text)) return text;
  const remainder = text.replace(/^PROMPT CONTENT NOT PERSISTED\s*(?:\r?\n)?/, "").replace(/^\s+/, "");
  return [
    "PROMPT METADATA",
    "",
    "status: metadata_recorded",
    "body_storage: remote_owned",
    "local_body: intentionally_omitted",
    remainder,
  ].filter((line, index) => index < 5 || line).join("\n");
}

export function promptPersistenceSummary({
  prompt = "",
  packet = null,
  role = null,
  provider = null,
  reason = PROMPT_BODY_STORAGE_REASON,
} = {}) {
  const metadata = packet?.remote_prompt_metadata || packet?.posse_remote?.metadata || {};
  const skills = Array.isArray(packet?.skills_attached)
    ? packet.skills_attached
    : (Array.isArray(packet?.skills) ? packet.skills : []);
  return [
    "PROMPT METADATA",
    "",
    "status: metadata_recorded",
    "body_storage: remote_owned",
    "local_body: intentionally_omitted",
    `reason: ${reason}`,
    `role: ${role || packet?.recipient || "(unknown)"}`,
    provider ? `provider: ${provider}` : null,
    `prompt_chars: ${String(prompt || "").length}`,
    metadata?.prompt_version ? `prompt_version: ${metadata.prompt_version}` : null,
    skills.length > 0 ? `selected_skills: ${skills.join(", ")}` : "selected_skills: (none)",
  ].filter(Boolean).join("\n");
}
