// Resolve a batch against one immutable file snapshot. All spans use offsets
// in that snapshot, so a replacement cannot shift a later edit's coordinates.

// An empty find matches between every character: never a span.
export const EMPTY_FIND_ERROR = "find/replace requires a nonempty find and a replace";

export function ambiguousExactMatchMessage(content, oldText) {
  if (!oldText) return EMPTY_FIND_ERROR;
  const lines = [];
  let count = 0;
  for (let at = content.indexOf(oldText); at >= 0; at = content.indexOf(oldText, at + oldText.length)) {
    count++;
    if (lines.length < 8) lines.push(1 + (content.slice(0, at).match(/\n/g)?.length || 0));
  }
  return `find matches ${count} times at line${lines.length === 1 ? "" : "s"} ${lines.join(", ")}${count > lines.length ? ", ..." : ""}; include more surrounding context or use replaceLines`;
}

function exactSpan(content, item) {
  if (typeof item.find !== "string" || !item.find || typeof item.replace !== "string") {
    return { error: EMPTY_FIND_ERROR };
  }
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const variants = [[item.find, item.replace]];
  const normalizedOld = item.find.replace(/\r\n/g, "\n").replace(/\n/g, eol);
  const normalizedNew = item.replace.replace(/\r\n/g, "\n").replace(/\n/g, eol);
  if (normalizedOld !== item.find) variants.push([normalizedOld, normalizedNew]);
  for (const [oldText, newText] of variants) {
    const at = content.indexOf(oldText);
    if (at < 0) continue;
    if (content.indexOf(oldText, at + oldText.length) >= 0) return { error: ambiguousExactMatchMessage(content, oldText) };
    return { start: at, end: at + oldText.length, replacement: newText };
  }
  return { error: "find not found" };
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
  // A deletion that reaches EOF also takes the separator before it. Mixed-EOL
  // files can hold either length there, so measure it, not the file's style.
  if (!replacement && endLine === starts.length && startLine > 1) start -= body.slice(start - 2, start) === "\r\n" ? 2 : 1;
  return { start, end, replacement: replacement && endLine < starts.length ? `${replacement}${eol}` : replacement };
}

export function resolveExactSpan(content, item) {
  return exactSpan(String(content), item);
}

export function resolveLineSpan(content, item) {
  return lineSpan(String(content), item);
}

export function applyBatchEdits(original, edits) {
  if (!Array.isArray(edits) || edits.length === 0) return { error: "edits requires a nonempty array" };
  const content = String(original);
  const spans = [];
  const results = edits.map((item, index) => {
    const fail = (error) => ({ index, ok: false, error });
    if (!item || typeof item !== "object" || Array.isArray(item)) return fail(`edits[${index}]: expected an edit object`);
    const keys = Object.keys(item);
    const lineMode = keys.includes("replaceLines");
    const allowed = lineMode ? ["replaceLines"] : ["find", "replace"];
    const unknown = keys.find((key) => !["replaceLines", "find", "replace"].includes(key));
    if (unknown) return fail(`arguments.edits[${index}].${unknown} is not allowed`);
    if (keys.some((key) => !allowed.includes(key)) || !keys.length) return fail(`edits[${index}]: use exactly one supported edit mode without path`);
    const span = lineMode ? lineSpan(content, item) : exactSpan(content, item);
    if (span.error) return fail(`edits[${index}]: ${span.error}`);
    spans.push({ ...span, index, line: lineMode ? item.replaceLines : null });
    return { index, ok: true };
  });
  // Reject both sides of a conflict, never unrelated items or an arbitrary
  // winner. Adjacent line edits are compatible even when EOF deletion takes
  // their shared newline; coalescing below resolves that separator once.
  for (let i = 0; i < spans.length; i++) {
    for (let j = i + 1; j < spans.length; j++) {
      const a = spans[i], b = spans[j];
      const overlaps = a.line && b.line
        ? a.line.start <= b.line.end && b.line.start <= a.line.end
        : a.start === b.start || (a.start < b.end && b.start < a.end);
      if (!overlaps) continue;
      for (const [left, right] of [[a, b], [b, a]]) {
        const result = results[left.index];
        result.ok = false;
        result.error = `${result.error ? `${result.error}; ` : ""}edits[${left.index}]: overlaps edits[${right.index}]`;
      }
    }
  }
  for (let i = spans.length - 1; i >= 0; i--) {
    if (!results[spans[i].index].ok) spans.splice(i, 1);
  }
  // Coalesce line items whose ranges touch and resolve each run once, so an
  // EOF deletion cannot claim the separator its neighbour's span ends on.
  const lineItems = spans.filter((span) => span.line).sort((a, b) => a.line.start - b.line.start);
  const runs = [];
  for (const span of lineItems) {
    const last = runs[runs.length - 1];
    if (last && last[last.length - 1].line.end + 1 === span.line.start) last.push(span);
    else runs.push([span]);
  }
  for (const run of runs.filter((items) => items.length > 1)) {
    const text = run.map((span) => span.line.content.replace(/\r\n/g, "\n").replace(/\n$/, "")).filter(Boolean).join("\n");
    const merged = lineSpan(content, { replaceLines: { start: run[0].line.start, end: run[run.length - 1].line.end, content: text } });
    if (merged.error) {
      for (const span of run) results[span.index] = { index: span.index, ok: false, error: `edits[${span.index}]: ${merged.error}` };
      for (const span of run) spans.splice(spans.indexOf(span), 1);
      continue;
    }
    for (const span of run) spans.splice(spans.indexOf(span), 1);
    spans.push({ ...merged, index: run[0].index, line: null });
  }
  const ascending = [...spans].sort((a, b) => a.start - b.start || a.end - b.end);
  let result = content;
  for (const span of ascending.reverse()) {
    result = result.slice(0, span.start) + span.replacement + result.slice(span.end);
  }
  const editCount = results.filter((item) => item.ok).length;
  return {
    ...(editCount ? { content: result } : { error: results.map((item) => item.error).join("; ") }),
    editCount, failed: edits.length - editCount, results,
  };
}
