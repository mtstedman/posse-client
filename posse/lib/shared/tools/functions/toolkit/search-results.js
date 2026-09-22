import { CONTEXT_SEARCH_FILES_SELF_BOUND_CHARS } from "../../../../catalog/context.js";

export function boundedSearchRows(rows, {
  offset, headLimit, maxChars = CONTEXT_SEARCH_FILES_SELF_BOUND_CHARS,
  totalRows = rows.length, pageOffset = offset,
} = {}) {
  const candidates = rows.slice(offset, offset + headLimit);
  if (candidates.length === 0) return "No matches found.";
  const output = [];
  for (const candidate of candidates) {
    if ([...output, candidate].join("\n").length > maxChars - 160) break;
    output.push(candidate);
  }
  const partial = output.length === 0;
  if (partial) output.push(`${String(candidates[0]).slice(0, Math.max(1, maxChars - 240))}\n[partial match: source row clipped]`);
  const returned = output.length;
  const truncated = partial || pageOffset + returned < totalRows;
  output.push(`[search_files matchesTotal=${totalRows} returned=${returned} truncated=${truncated}]`);
  return output.join("\n").slice(0, maxChars);
}

function formatContentRow(entry) {
  const out = [`${entry.file}:${entry.line}:${entry.text}`];
  if (entry.before.length || entry.after.length) {
    for (const row of entry.before) out.push(`${entry.file}:${row.line}-${row.text}`);
    for (const row of entry.after) out.push(`${entry.file}:${row.line}+${row.text}`);
    out.push("--");
  }
  return out.join("\n");
}

export function renderSearchContentRows(rows, { offset, headLimit }, transform, context) {
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.text.localeCompare(b.text));
  const selected = [];
  let chars = 0;
  for (const row of rows.slice(offset, offset + headLimit)) {
    const size = formatContentRow(row).length + (selected.length ? 1 : 0);
    if (selected.length && chars + size > CONTEXT_SEARCH_FILES_SELF_BOUND_CHARS - 160) break;
    selected.push(row);
    chars += size;
    if (chars > CONTEXT_SEARCH_FILES_SELF_BOUND_CHARS - 160) break;
  }
  const render = (safeRows) => {
    if (!Array.isArray(safeRows) || safeRows.length !== selected.length) {
      throw new Error("Invalid source-search transformation");
    }
    return boundedSearchRows(safeRows.map(formatContentRow), {
      offset: 0, headLimit: safeRows.length, totalRows: rows.length, pageOffset: offset,
    });
  };
  // Transform complete selected source rows BEFORE clipping, retention or display.
  // Legacy callers without a transformer retain their synchronous contract.
  return transform && selected.length
    ? Promise.resolve().then(() => transform(selected, context)).then(render)
      .catch(() => "Error: search_files could not safely prepare source matches. No source was returned.")
    : render(selected);
}
