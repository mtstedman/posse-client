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

// Group content matches under one `File: path` header instead of repeating the
// path on every row: in one HARD-40 run the repeated prefix was 37.7% of all
// search output (114.6k characters over 3834 rows across 260 files). Inside a
// group the lines read in ascending order like any other source display —
// `> ` marks a matching line, context lines are blank-marked — instead of the
// ripgrep ordering that emitted the match, then its before rows, then its
// after rows, with `:`/`-`/`+` markers. Non-adjacent runs are separated by
// `--`, and a line two matches both report is emitted once.
function fileGroups(rows) {
  const groups = [];
  for (const entry of rows) {
    let group = groups.at(-1);
    if (!group || group.file !== entry.file) {
      group = { file: entry.file, rows: new Map(), matches: 0 };
      groups.push(group);
    }
    group.matches += 1;
    const put = (line, text, matched) => {
      const prior = group.rows.get(line);
      if (prior && !matched) return;
      group.rows.set(line, { text, matched: matched || prior?.matched === true });
    };
    for (const row of entry.before) put(row.line, row.text, false);
    for (const row of entry.after) put(row.line, row.text, false);
    put(entry.line, entry.text, true);
  }
  return groups;
}

function groupText(group) {
  const ordered = [...group.rows.entries()].sort(([left], [right]) => left - right);
  const lines = [];
  let previous = null;
  for (const [line, row] of ordered) {
    if (previous !== null && line !== previous + 1) lines.push("--");
    lines.push(`${row.matched ? ">" : " "} ${line}\t${row.text}`);
    previous = line;
  }
  return `File: ${group.file}\n${lines.join("\n")}`;
}

// Cost of appending one row to the current rendering: its own display lines,
// plus a new file header when the row opens a group. Context lines shared with
// a neighbouring match are counted twice here, so the budget errs small.
function groupedRowSize(entry, previousFile) {
  const rows = [[entry.line, entry.text], ...entry.before.map((row) => [row.line, row.text]),
    ...entry.after.map((row) => [row.line, row.text])];
  const body = rows.reduce((total, [line, text]) => total + `> ${line}\t${text}`.length + 1, 0);
  return entry.file === previousFile ? body : body + `File: ${entry.file}`.length + 1;
}

export function renderGroupedSearchRows(rows, {
  maxChars = CONTEXT_SEARCH_FILES_SELF_BOUND_CHARS, totalRows = rows.length, pageOffset = 0,
} = {}) {
  const groups = fileGroups(rows);
  if (groups.length === 0) return "No matches found.";
  const output = [];
  let returned = 0;
  for (const group of groups) {
    const text = groupText(group);
    if ([...output, text].join("\n").length > maxChars - 200) break;
    output.push(text);
    returned += group.matches;
  }
  const partial = output.length === 0;
  if (partial) {
    output.push(`${groupText(groups[0]).slice(0, Math.max(1, maxChars - 280))}\n[partial match: source row clipped]`);
    // One clipped row is still one row shown, as before grouping.
    returned = Math.min(1, groups[0].matches);
  }
  const truncated = partial || pageOffset + returned < totalRows;
  output.push(`[search_files matchesTotal=${totalRows} returned=${returned} truncated=${truncated}; > marks a matching line]`);
  return output.join("\n").slice(0, maxChars);
}

export function renderSearchContentRows(rows, { offset, headLimit }, transform, context) {
  rows.sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.text.localeCompare(b.text));
  const selected = [];
  let chars = 0;
  let previousFile = null;
  for (const row of rows.slice(offset, offset + headLimit)) {
    const size = groupedRowSize(row, previousFile);
    if (selected.length && chars + size > CONTEXT_SEARCH_FILES_SELF_BOUND_CHARS - 160) break;
    selected.push(row);
    previousFile = row.file;
    chars += size;
    if (chars > CONTEXT_SEARCH_FILES_SELF_BOUND_CHARS - 160) break;
  }
  const render = (safeRows) => {
    if (!Array.isArray(safeRows) || safeRows.length !== selected.length) {
      throw new Error("Invalid source-search transformation");
    }
    return renderGroupedSearchRows(safeRows, { totalRows: rows.length, pageOffset: offset });
  };
  // Transform complete selected source rows BEFORE clipping, retention or display.
  // Legacy callers without a transformer retain their synchronous contract.
  return transform && selected.length
    ? Promise.resolve().then(() => transform(selected, context)).then(render)
      .catch(() => "Error: search_files could not safely prepare source matches. No source was returned.")
    : render(selected);
}
