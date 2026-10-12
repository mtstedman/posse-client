// @ts-check



export const CHOICE_COPY = Object.freeze({
  approve: ["Approve", "Allow the exact requested transition."],
  reject: ["Reject", "Reject the exact requested transition."],
  pass: ["Pass", "Accept the current work as passing."],
  fail: ["Fail", "Mark the current work as failed."],
  skip: ["Skip", "Skip this work and continue where policy permits."],
  replan: ["Replan", "Return the Work Item to its planning path."],
  retry: ["Retry", "Retry through the canonical owner transition."],
  send_back: ["Send back", "Return the implementation for repair and reassessment."],
  retry_assessment: ["Retry assessment", "Run assessment again on the current implementation."],
  explicit_waiver: ["Explicit waiver", "Accept the current work while recording that deterministic verification did not pass."],
  "retry:claude": ["Retry with Claude", "Retry through the Claude provider path."],
  "retry:anthropic": ["Retry with Anthropic API", "Retry through the direct Anthropic API provider path."],
  "retry:openai": ["Retry with OpenAI", "Retry through the OpenAI provider path."],
  "retry:codex": ["Retry with Codex", "Retry through the Codex provider path."],
  "retry:grok": ["Retry with Grok", "Retry through the Grok provider path."],
  extend: ["Extend", "Resume partial work with an extended turn budget."],
  commit: ["Commit", "Commit the bounded partial output for assessment."],
  revert: ["Revert", "Discard the bounded partial output."],
  plan: ["Use planned flow", "Create a plan instead of a one-shot edit."],
  cancel: ["Cancel request", "Stop without creating a continuation job."],
  push: ["Push", "Run the repository-aware canonical push gate."],
  decline: ["Decline", "Close this push offer without pushing."],
  accept: ["Accept", "Accept the assessed implementation under operator review."],
  abandon: ["Abandon", "Cancel the work item and discard its branch."],
  wait: ["Wait", "Keep the merge deferred until its upstream work is recovered."],
  rebuild: ["Rebuild", "Discard inherited edits and rerun the work item from the target branch."],
});
