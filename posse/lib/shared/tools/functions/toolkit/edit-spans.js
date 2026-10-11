// Resolve a batch against one immutable file snapshot. All spans use offsets
// in that snapshot, so a replacement cannot shift a later edit's coordinates.

function exactSpan(content, item) {
  if (typeof item.old_string !== "string" || !item.old_string || typeof item.new_string !== "string") {
    return { error: "old_string/new_string requires a nonempty old_string and a new_string" };
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const variants = [[item.old_string, item.new_string]];
  const normalizedOld = item.old_string.replace(/\r\n/g, "\n").replace(/\n/g, eol);
  const normalizedNew = item.new_string.replace(/\r\n/g, "\n").replace(/\n/g, eol);
  if (normalizedOld !== item.old_string) variants.push([normalizedOld, normalizedNew]);
  for (const [oldText, newText] of variants) {
    const at = content.indexOf(oldText);
    if (at < 0) continue;
    if (content.indexOf(oldText, at + oldText.length) >= 0) return { error: "old_string matches more than once" };
    return { start: at, end: at + oldText.length, replacement: newText };
  }
  return { error: "old_string not found" };
}

function lineSpan(content, item) {
  const source = item.replaceLines;
  if (!source || typeof source !== "object" || Array.isArray(source)
    || Object.keys(source).some((key) => !["start", "end", "content"].includes(key))
    || typeof source.content !== "string") return { error: "replaceLines requires start, end and content" };
  const startLine = source.start;
  const endLine = source.end;
  if (!Number.isInteger(startLine) || !Number.isInteger(endLine) || startLine < 1 || endLine < startLine) {
    return { error: "replaceLines requires a 1-based inclusive range" };
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const hadFinalEol = content.endsWith("\n");
  const finalEolChars = content.endsWith("\r\n") ? 2 : 1;
  const body = hadFinalEol ? content.slice(0, -finalEolChars) : content;
  const starts = body ? [0] : [];
  const separator = /\r?\n/g;
  for (const match of body.matchAll(separator)) starts.push(match.index + match[0].length);
  const emptyInsert = starts.length === 0 && startLine === 1 && endLine === 1;
  if (!emptyInsert && endLine > starts.length) return { error: `replaceLines range ${startLine}:${endLine} is outside the file (${starts.length} lines)` };
  const replacementLines = String(source.content).replace(/\r\n/g, "\n").replace(/\n$/, "");
  const replacement = replacementLines ? replacementLines.split("\n").join(eol) : "";
  let start = emptyInsert ? 0 : starts[startLine - 1];
  const end = endLine < starts.length ? starts[endLine] : body.length;
  if (!replacement && endLine === starts.length && startLine > 1) start -= eol.length;
  return { start, end, replacement: replacement && endLine < starts.length ? `${replacement}${eol}` : replacement };
}

export function resolveExactSpan(content, item) {
  return exactSpan(String(content), item);
}

export function resolveLineSpan(content, item) {
  return lineSpan(String(content), item);
}

export function applyAtomicEdits(original, edits) {
  if (!Array.isArray(edits) || edits.length === 0) return { error: "edits requires a nonempty array" };
  const content = String(original);
  const spans = [];
  for (let index = 0; index < edits.length; index++) {
    const item = edits[index];
    if (!item || typeof item !== "object" || Array.isArray(item)) return { error: `edits[${index}]: expected an edit object` };
    const keys = Object.keys(item);
    const lineMode = keys.includes("replaceLines");
    const allowed = lineMode ? ["replaceLines"] : ["old_string", "new_string"];
    if (keys.some((key) => !allowed.includes(key)) || !keys.length) return { error: `edits[${index}]: use exactly one supported edit mode without path` };
    const span = lineMode ? lineSpan(content, item) : exactSpan(content, item);
    if (span.error) return { error: `edits[${index}]: ${span.error}` };
    spans.push({ ...span, index });
  }
  const ascending = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  for (let index = 1; index < ascending.length; index++) {
    if (ascending[index].start < ascending[index - 1].end
      || ascending[index].start === ascending[index - 1].start) {
      return { error: `edits[${ascending[index].index}]: overlaps edits[${ascending[index - 1].index}]` };
    }
  }
  let result = content;
  for (const span of ascending.reverse()) {
    result = result.slice(0, span.start) + span.replacement + result.slice(span.end);
  }
  if (result === content) return { error: "edits made no changes" };
  return { content: result, editCount: edits.length };
}
