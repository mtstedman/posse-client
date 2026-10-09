function excerpt(value, limit = 3000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[preview truncated; ${text.length - limit} characters omitted]`;
}

/** Describe the attempted edit without applying it or reading extra files. */
export function editScopeRequestReason(args = {}) {
  let preview;
  if (typeof args.old_string === "string" && typeof args.new_string === "string") {
    const lines = (text, prefix) => excerpt(text).split("\n").map((line) => prefix + line).join("\n");
    preview = `--- before\n+++ after\n${lines(args.old_string, "-")}\n${lines(args.new_string, "+")}`;
  } else {
    const edit = Object.fromEntries(["replaceLines", "replacePattern", "insertAt", "append", "jsonPath", "jsonValue", "executable"]
      .filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
    preview = excerpt(JSON.stringify(edit, null, 2), 6000);
  }
  return `edit_file requires this existing file to complete the active job\nAttempted edit (preview):\n${preview}`;
}
