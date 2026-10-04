import { getDefaultRemoteComposer } from "../../remote/classes/RemoteComposer.js";

export async function compileAgentPolicy({ definition, message, provider, cwd = process.cwd(), composer = null }) {
  const packet = {
    recipient: "agent",
    job_type: "agent",
    title: definition.description,
    cwd,
    model_name: definition.model,
    model_tier: "standard",
    reasoning_effort: "medium",
    governance_tier: "production",
    attempt: { count: 1, max: 1 },
    tool_policy: { allow_read: false, allow_write: false, allow_shell: false, allow_tests: false },
    capabilities: { tools: {}, atlas: { available: false }, coordination: {} },
    atlas: { active: false },
    skills: [],
    requested_skills: [],
  };
  const compiled = await (composer || getDefaultRemoteComposer()).composePrompt(packet, message, {
    providerName: provider,
    maxPromptChars: 128_000,
    maxContextChars: 64_000,
  });
  if (!compiled.systemPrompt) throw Object.assign(new Error("The remote agent role returned no system prompt"), { code: "POSSE_REMOTE_REQUIRED" });
  return { systemPrompt: compiled.systemPrompt, metadata: compiled.metadata || null, issuance: compiled.issuance || null };
}
