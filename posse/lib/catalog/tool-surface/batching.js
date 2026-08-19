// Deterministic execution ordering policy. This is catalog data plus a pure
// lookup; it deliberately has no provider-registry dependency.
export const TOOL_BATCHING_CLASSES = Object.freeze({
  PARALLEL_READ: "parallel-read",
  NATIVE_BATCH: "native-batch",
  SERIAL_PROTOCOL: "serial-protocol",
  ORDERED: "ordered",
});

const PARALLEL_READ_TOOLS = new Set([
  "read_file", "list_files", "search_files", "git_history", "hash_file", "read_image_metadata",
  "validate_artifact_output", "extract_image_text", "query", "code", "repo", "action.search",
  "manual", "symbol.search", "symbol.overview", "tree.branch", "tree.expand", "code.skeleton",
  "code.lens", "code.window", "code.structure", "review.delta", "review.analyze", "review.risk",
  "file.read",
]);

const NATIVE_BATCH_TOOLS = new Set([
  "sub_agent", "inspect_file", "create_test", "run_test", "fetch_ref", "create_ref", "symbol.card",
  "code.survey", "memory.surface", "memory.get",
]);

const SERIAL_PROTOCOL_TOOLS = new Set([
  "agent_handoff", "sub_agent_next_input", "chain_read", "chain_verdict", "get_operator_feedback",
  "ack_operator_feedback", "agent.feedback", "memory.store", "memory.feedback",
]);

export function canonicalToolNameForBatching(name) {
  let canonicalName = String(name || "").trim().toLowerCase();
  if (!canonicalName) return "";
  if (canonicalName.startsWith("mcp__")) {
    const parts = canonicalName.split("__");
    canonicalName = parts.at(-1) || canonicalName;
  }
  canonicalName = canonicalName.replaceAll("-", "_");
  if (/^tools[._]/.test(canonicalName)) {
    return canonicalName.replace(/^tools[._]/, "");
  }
  if (/^atlas[._]/.test(canonicalName)) {
    return canonicalName.replace(/^atlas[._]/, "").replaceAll("_", ".");
  }
  return canonicalName;
}

export function getToolBatchingClass(name) {
  const canonicalName = String(name || "").trim();
  if (PARALLEL_READ_TOOLS.has(canonicalName)) return TOOL_BATCHING_CLASSES.PARALLEL_READ;
  if (NATIVE_BATCH_TOOLS.has(canonicalName)) return TOOL_BATCHING_CLASSES.NATIVE_BATCH;
  if (SERIAL_PROTOCOL_TOOLS.has(canonicalName)) return TOOL_BATCHING_CLASSES.SERIAL_PROTOCOL;
  return TOOL_BATCHING_CLASSES.ORDERED;
}
