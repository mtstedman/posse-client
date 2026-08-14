function normalizedRelativeTestScript(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return "";
  const normalized = raw.replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "";
  return normalized;
}

/**
 * Allow repository-owned executable Node regression modules without opening
 * general `node script.js` execution. The command must contain exactly one
 * relative script under test/ or tests/ and may not carry runtime flags.
 */
export function isSafeDirectNodeTestScriptArgs(args = []) {
  if (!Array.isArray(args) || args.length !== 1) return false;
  const script = normalizedRelativeTestScript(args[0]);
  return /^tests?\/.+\.(?:c|m)?js$/i.test(script);
}
