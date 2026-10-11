import { EDIT_FILE_MODES } from "../../../catalog/native-tools.js";

const PREVIEW_LIMIT = 6000;
// Fields shown as JSON when no textual rendering applies: every catalog mode
// field except the ones rendered as diffs below.
const STRUCTURED_EDIT_FIELDS = EDIT_FILE_MODES.flat().filter((key) => !["old_string", "new_string", "edits"].includes(key));

function excerpt(value, limit = 3000) {
  const text = String(value ?? "");
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[preview truncated; ${text.length - limit} characters omitted]`;
}

function prefixed(text, prefix) {
  return excerpt(text).split("\n").map((line) => prefix + line).join("\n");
}

function exactDiff(oldText, newText) {
  return `--- before\n+++ after\n${prefixed(oldText, "-")}\n${prefixed(newText, "+")}`;
}

function batchItemPreview(item, index) {
  const label = `edits[${index}]`;
  if (item && typeof item.old_string === "string" && typeof item.new_string === "string") {
    return `${label}\n${exactDiff(item.old_string, item.new_string)}`;
  }
  const lines = item?.replaceLines;
  if (lines && typeof lines === "object" && typeof lines.content === "string") {
    const body = lines.content.replace(/\r\n/g, "\n").replace(/\n$/, "");
    return `${label} replaceLines ${lines.start}:${lines.end}\n${body ? prefixed(body, "+") : "(delete lines)"}`;
  }
  return `${label}\n${excerpt(JSON.stringify(item ?? null, null, 2))}`;
}

/** Describe the attempted edit without applying it or reading extra files. */
export function editScopeRequestReason(args = {}) {
  let preview;
  if (typeof args.old_string === "string" && typeof args.new_string === "string") {
    preview = exactDiff(args.old_string, args.new_string);
  } else if (Array.isArray(args.edits)) {
    preview = excerpt(args.edits.map(batchItemPreview).join("\n"), PREVIEW_LIMIT);
  } else {
    const edit = Object.fromEntries(STRUCTURED_EDIT_FIELDS
      .filter((key) => args[key] !== undefined).map((key) => [key, args[key]]));
    preview = excerpt(JSON.stringify(edit, null, 2), PREVIEW_LIMIT);
  }
  return `edit_file requires this existing file to complete the active job\nAttempted edit (preview):\n${preview}`;
}
