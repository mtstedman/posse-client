// lib/domains/providers/functions/codex/config-format.js

export function _toCodexConfigKey(name = "atlas_mcp") {
  const normalized = String(name || "atlas_mcp")
    .trim()
    .replace(/[^A-Za-z0-9_]/g, "_")
    .replace(/_{2,}/g, "_");
  return normalized || "atlas_mcp";
}

export function _toTomlLiteral(value) {
  if (Array.isArray(value)) return JSON.stringify(value);
  if (typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value == null) return '""';
  return JSON.stringify(value);
}

export function _toTomlKeyPart(key) {
  const value = String(key || "");
  return /^[A-Za-z0-9_-]+$/.test(value) ? value : JSON.stringify(value);
}

const CODEX_MCP_ENV_ALLOWED_EXACT = new Set([
  "PATH",
  "Path",
  "PATHEXT",
  "ComSpec",
  "SystemRoot",
  "WINDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "TMP",
  "TEMP",
  "LOCALAPPDATA",
  "APPDATA",
  "ProgramData",
  "ProgramFiles",
  "ProgramFiles(x86)",
  "NVM_HOME",
  "NVM_SYMLINK",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
  "http_proxy",
  "https_proxy",
  "no_proxy",
]);

export function shouldForwardCodexMcpEnvKey(envKey, extraAllowedKeys = null) {
  const key = String(envKey || "");
  if (!key) return false;
  if (CODEX_MCP_ENV_ALLOWED_EXACT.has(key)) return true;
  if (extraAllowedKeys instanceof Set && extraAllowedKeys.has(key)) return true;
  // Keep ATLAS server handles, but do not forward POSSE_* product configuration toggles.
  if (key.startsWith("ATLAS_")) return true;
  // Keep common Node/package-manager runtime knobs used by CLI subprocesses.
  if (key.startsWith("NODE_") || key.startsWith("NPM_")) return true;
  return false;
}

export function appendCodexMcpEnvOverrides(configOverrides, serverKey, env = {}, { extraAllowedKeys = [] } = {}) {
  const extraAllowed = new Set((Array.isArray(extraAllowedKeys) ? extraAllowedKeys : []).filter(Boolean));
  if (!env || typeof env !== "object") return;
  for (const [envKey, envValue] of Object.entries(env)) {
    if (!envKey || envValue == null || envValue === "") continue;
    if (!shouldForwardCodexMcpEnvKey(envKey, extraAllowed)) continue;
    configOverrides.push(`mcp_servers.${serverKey}.env.${_toTomlKeyPart(envKey)}=${_toTomlLiteral(envValue)}`);
  }
}
