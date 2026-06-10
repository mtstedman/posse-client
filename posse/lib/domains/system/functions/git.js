// @ts-check
//
// Trusted in-process git operations. This namespace is intentionally kept
// separate from agent-facing tool contracts: callers that mutate repository
// state should go through system.git.* rather than exposing raw git actions.

export * from "../../git/functions/index.js";
