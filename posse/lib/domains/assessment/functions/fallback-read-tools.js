const ASSESSOR_FALLBACK_READ_TOOL_KEYS = new Set([
  "tools.read_file",
  "tools.chain_read",
  "tools.chain_verdict",
  "tools.list_files",
  "tools.search_files",
  "tools.git_history",
  "tools.inspect_file",
  "tools.hash_file",
  "atlas.symbol.search",
  "atlas.symbol.card",
  "atlas.symbol.overview",
  "atlas.tree.branch",
  "atlas.tree.expand",
  "atlas.code.skeleton",
  "atlas.code.lens",
  "atlas.code.window",
  "atlas.code.survey",
  "atlas.code.structure",
  "atlas.review.delta",
  "atlas.review.analyze",
  "atlas.review.risk",
]);

export function assessorFallbackReadKey(requested = {}) {
  const action = requested.suite === "atlas"
    ? (requested.nested || requested.name)
    : requested.name;
  return `${requested.suite || ""}.${action || ""}`;
}

export function assessorFallbackReadCallKey(toolName, args = {}) {
  const rawToolName = String(toolName || "");
  const atlasTool = /^atlas[._]/.test(rawToolName);
  let normalizedToolName = rawToolName
    .replace(/^atlas[._]/, "")
    .replace(/^tools[._]/, "");
  if (atlasTool) normalizedToolName = normalizedToolName.replaceAll("_", ".");
  const action = ["query", "code"].includes(normalizedToolName)
    ? String(args.action || args.gatewayAction || args.targetAction || normalizedToolName)
    : normalizedToolName;
  return `${atlasTool ? "atlas" : "tools"}.${action}`;
}

export function isAssessorFallbackReadKey(key) {
  return ASSESSOR_FALLBACK_READ_TOOL_KEYS.has(String(key || ""));
}
