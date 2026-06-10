export function promptPersistenceSummary({
  prompt = "",
  packet = null,
  role = null,
  provider = null,
  reason = "prompt_and_skill_content_are_remote_owned",
} = {}) {
  const metadata = packet?.remote_prompt_metadata || packet?.posse_remote?.metadata || {};
  const skills = Array.isArray(packet?.skills_attached)
    ? packet.skills_attached
    : (Array.isArray(packet?.skills) ? packet.skills : []);
  return [
    "PROMPT CONTENT NOT PERSISTED",
    "",
    `reason: ${reason}`,
    `role: ${role || packet?.recipient || "(unknown)"}`,
    provider ? `provider: ${provider}` : null,
    `prompt_chars: ${String(prompt || "").length}`,
    metadata?.prompt_version ? `prompt_version: ${metadata.prompt_version}` : null,
    skills.length > 0 ? `selected_skills: ${skills.join(", ")}` : "selected_skills: (none)",
  ].filter(Boolean).join("\n");
}
