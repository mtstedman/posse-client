import {
  composePromptRemoteAware,
  handoff,
  renderAtlasHandoffSections,
} from "../../../handoff/functions/index.js";

export async function composeRemoteAssessorPromptForProvider(promptText, {
  role = "planner",
  providerName = null,
  workingDir = process.cwd(),
  activity = "",
  scopedFiles = null,
  atlasAttachment = null,
  atlasConfig = null,
  composer = null,
  handoffFn = handoff,
  renderAtlasHandoffSectionsFn = renderAtlasHandoffSections,
} = {}) {
  if (role !== "assessor" || !atlasAttachment?.active || !providerName) return null;

  const packet = await handoffFn({
    recipient: "assessor",
    data: {
      cwd: workingDir,
      execution_provider: providerName,
      title: activity || null,
      project_context: promptText,
      files_to_modify: Array.isArray(scopedFiles) ? scopedFiles : [],
      atlasConfig,
    },
  });

  const atlasSummary = String(renderAtlasHandoffSectionsFn(packet) || "").trim();
  if (atlasSummary) {
    packet.atlas = {
      ...(packet.atlas || {}),
      summary: atlasSummary,
    };
  }

  const remotePrompt = await composePromptRemoteAware(packet, promptText, {
    providerName,
    ...(composer ? { composer } : {}),
  });

  return {
    promptText: remotePrompt,
    stableContext: packet.stable_context || null,
    remoteSystemPrompt: packet.remote_system_prompt || null,
    packet,
  };
}
