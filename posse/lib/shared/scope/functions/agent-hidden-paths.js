export function normalizeAgentHiddenRelPath(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/")
    .replace(/\/+$/, "");
}

function pathParts(normalized) {
  return normalized.split("/").filter(Boolean);
}

export function agentHiddenReadablePathReason(value) {
  const normalized = normalizeAgentHiddenRelPath(value).toLowerCase();
  if (!normalized) return null;
  const parts = pathParts(normalized);
  if (parts.includes(".gitignore")) return ".gitignore files are hidden from agent file tools";
  return null;
}

export function isAgentHiddenReadablePath(value) {
  return !!agentHiddenReadablePathReason(value);
}
