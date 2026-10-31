// A normally returned dev call can omit its terminal tool even though its
// edits are already on disk. Give that omission one tracked correction call;
// rejected evidence, cancellation and provider failures use their own paths.
export function canCorrectMissingDevHandoff(error, opts) {
  return opts?.role === "dev"
    && !opts?._parentAgentCallId
    && !opts?.abortSignal?.aborted
    && error?.code === "TERMINAL_PROTOCOL_ERROR"
    && error?.message === "agent_handoff was required but no report was staged";
}

export function missingHandoffCorrectionPrompt(prompt) {
  return [
    prompt,
    "TERMINAL HANDOFF CORRECTION:",
    "The previous execution returned without submitting its required agent_handoff. Its existing edits and commits remain in this workspace.",
    "Inspect the current work before changing it; do not restart or discard completed implementation. Finish any genuinely incomplete work and submit the required terminal report using the issued tool and schema.",
    "A prose completion message cannot replace the terminal tool. Report actual evidence and any unresolved failures; do not claim success merely to finish the handoff.",
  ].join("\n\n");
}
