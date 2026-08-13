function toolReference(suite, canonicalName) {
  return Object.freeze({
    suite: String(suite || "").trim(),
    canonicalName: String(canonicalName || "").trim(),
  });
}

export const TOOL_REFS = Object.freeze({
  atlas: Object.freeze({
    codeWindow: toolReference("atlas", "code.window"),
  }),
  tools: Object.freeze({
    bash: toolReference("tools", "bash"),
    chainRead: toolReference("tools", "chain_read"),
    chainVerdict: toolReference("tools", "chain_verdict"),
    editFile: toolReference("tools", "edit_file"),
    listFiles: toolReference("tools", "list_files"),
    readFile: toolReference("tools", "read_file"),
    runScopedChecks: toolReference("tools", "run_scoped_checks"),
    searchFiles: toolReference("tools", "search_files"),
    writeFile: toolReference("tools", "write_file"),
  }),
});

export function normalizeToolReference(reference) {
  if (!reference || typeof reference !== "object") {
    throw new TypeError("Tool references must come from the canonical tool reference catalog");
  }
  const suite = String(reference.suite || "").trim();
  const canonicalName = String(reference.canonicalName || "").trim();
  if (!suite || !canonicalName) {
    throw new TypeError("Tool references require suite and canonicalName");
  }
  return { suite, canonicalName };
}
