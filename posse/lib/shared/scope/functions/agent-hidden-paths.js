export function normalizeAgentHiddenRelPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

// Ignore configuration is ordinary repository context. Secrets and runtime
// internals are enforced by their dedicated path policies, not dotfile hiding.
export function agentHiddenReadablePathReason(_value) {
  return null;
}

export function isAgentHiddenReadablePath(value) {
  return !!agentHiddenReadablePathReason(value);
}
