import {
  CODE_CONTENT_KINDS,
  RAW_SOURCE_LINES_ENCODING,
  SOURCE_LINE_DISPLAY_FORMAT,
  SOURCE_WINDOW_DISPLAY_FIELDS,
} from "../../../catalog/source-display.js";
import { canonicalEvidenceSourcePath, normalizedEvidenceSourceWindows } from "./source-evidence.js";
import { sourceRows } from "./source-continuation.js";

function numberedWindow(window, fallbackPath) {
  if (window?.contentKind != null && window.contentKind !== CODE_CONTENT_KINDS.SOURCE) return null;
  const sourcePath = canonicalEvidenceSourcePath(window?.repo_rel_path || fallbackPath);
  const start = window?.startLine;
  const end = window?.endLine;
  const source = window?.content;
  if (!sourcePath || typeof source !== "string" || !source
    || !Number.isSafeInteger(start) || start < 1
    || !Number.isSafeInteger(end) || end < start) return null;
  // Keep the original newline bytes, including a final newline. The empty
  // regex match at EOF is not another source line.
  const rows = source.match(/[^\r\n]*(?:\r\n|\r|\n|$)/g);
  if (rows.at(-1) === "") rows.pop();
  if (end - start + 1 !== rows.length) return null;
  return rows.map((row, index) => `${start + index}\t${row}`).join("");
}

function parseInclusiveRange(text) {
  const match = /^(\d+)-(\d+)$/u.exec(String(text ?? ""));
  if (!match) return null;
  const start = Number(match[1]);
  const end = Number(match[2]);
  return Number.isSafeInteger(start) && Number.isSafeInteger(end) && start >= 1 && end >= start
    ? [start, end]
    : null;
}

function rangesIntersect([start, end], [otherStart, otherEnd]) {
  return otherStart <= end && otherEnd >= start;
}

function lowered(value) {
  return String(value ?? "").toLowerCase();
}

// Fields that describe the transport rather than the source. `exact_field`
// names a `content` field the display has already lifted into a block, `chars`
// has no reader, the line-format constant is explained nowhere the model can
// read, and `content_next_block` repeats what `content_block` says.
function trimTransportFields(header) {
  for (const field of [
    "content_line_format", "content_next_block",
    // `displayed`/`omitted` say whether every requested identifier arrived.
    "identifiersComplete",
    // Reuse bookkeeping: the notice text and `reused` below carry what the
    // model needs; the requested span and the line count are derivable.
    "source_deduplicated", "requestedStartLine", "requestedEndLine", "reusedLineCount",
  ]) delete header[field];
  // A bounded selection is the normal case; only a whole-file delivery is news.
  if (header.selectionBounded === true) delete header.selectionBounded;
  // The count restates the ranges list.
  if (Array.isArray(header.continuationRanges)) delete header.continuationWindows;
  if (header.evidence_ref && typeof header.evidence_ref === "object") {
    const { exact_field: _exactField, chars: _chars, ...evidenceRef } = header.evidence_ref;
    header.evidence_ref = evidenceRef;
  }
  if (Array.isArray(header.reusedRanges)) {
    header[SOURCE_WINDOW_DISPLAY_FIELDS.REUSED] = header.reusedRanges.map((range) => ({
      [SOURCE_WINDOW_DISPLAY_FIELDS.LINES]: [range.startLine, range.endLine],
      ...(Array.isArray(range.evidence_refs) ? { evidence_refs: range.evidence_refs } : {}),
    }));
    delete header.reusedRanges;
  }
  for (const field of ["identifiersFound", "identifiersReturned", "identifiersOmitted", "identifiersMissing"]) {
    if (Array.isArray(header[field]) && header[field].length === 0) delete header[field];
  }
}

// A symbol target (symbol.get, or code.window with a symbolId) is one body at
// one address. `selectionBounded` and `identifiersComplete` are true by
// construction there, `identifiersFound`/`identifiersReturned` restate the
// body, and syntax navigation into a single body restates what the body
// shows; only identifiers the body did not carry are worth a row. File-mode
// windows keep their decision points: there they point across windows.
function symbolWindowDisplay(header, shown) {
  header[SOURCE_WINDOW_DISPLAY_FIELDS.LINES] = [shown.startLine, shown.endLine];
  for (const field of [
    "startLine", "endLine", "selectionBounded", "identifiersFound", "identifiersReturned",
    "decisionPoints", "decisionPointsTruncated",
  ]) delete header[field];
  trimTransportFields(header);
  return header;
}

// File-mode code.window responses carry the same ranges three times: the
// hoisted primary window plus additionalWindows, map.inlineRanges, and every
// map target's inlineRanges; and the same identifiers three times: found,
// returned and omitted. The model-facing header keeps one row per delivered
// window and one row per requested declaration that is not fully inline.
// Internal readers (paging, reuse, coverage, observations) all run before this
// presentation and keep reading the native fields.
function targetLines(target) {
  const lines = Array.isArray(target?.lines) ? target.lines : null;
  return lines && lines.length === 2 && Number.isSafeInteger(lines[0]) && Number.isSafeInteger(lines[1])
    && lines[0] >= 1 && lines[1] >= lines[0]
    ? [lines[0], lines[1]]
    : null;
}

// Coverage is measured against the ranges actually displayed in this response,
// not against the map's own coverage words, which describe the native inline
// selection before paging or reuse moved windows out.
function displayedCoverage(range, displayedRanges) {
  const overlaps = displayedRanges
    .filter((candidate) => rangesIntersect(range, candidate))
    .map(([start, end]) => [Math.max(start, range[0]), Math.min(end, range[1])])
    .sort((left, right) => left[0] - right[0]);
  if (overlaps.length === 0) return "none";
  let cursor = range[0];
  for (const [start, end] of overlaps) {
    if (start > cursor) return "partial";
    cursor = Math.max(cursor, end + 1);
  }
  return cursor > range[1] ? "full" : "partial";
}

function fileWindowDisplay(header, windows, value) {
  const requests = Array.isArray(value.map?.requested) ? value.map.requested : [];
  const targets = requests.flatMap((request) => (
    (Array.isArray(request.targets) ? request.targets : []).map((target) => ({ request, target }))
  ));
  const displayedRanges = windows.map(({ window }) => [window.startLine, window.endLine]);
  const additionalIdentifiers = new Set(windows.flatMap(({ window }) => (
    Array.isArray(window.identifiers) ? window.identifiers.map(lowered) : []
  )));
  const displayed = windows.map(({ window, shown }) => {
    const range = [window.startLine, window.endLine];
    const symbols = [];
    for (const { target } of targets) {
      const lines = targetLines(target);
      if (!lines || !rangesIntersect(range, lines)) continue;
      const label = target.symbolId ?? target.name;
      if (label != null && !symbols.includes(label)) symbols.push(label);
    }
    if (symbols.length === 0) {
      // The primary window carries no identifier list of its own; it owns the
      // returned identifiers no additional window claims.
      const names = Array.isArray(window.identifiers)
        ? window.identifiers
        : (Array.isArray(value.identifiersReturned) ? value.identifiersReturned : [])
          .filter((identifier) => !additionalIdentifiers.has(lowered(identifier)));
      symbols.push(...names);
    }
    return {
      [SOURCE_WINDOW_DISPLAY_FIELDS.LINES]: range,
      ...(symbols.length > 0 ? { [SOURCE_WINDOW_DISPLAY_FIELDS.SYMBOLS]: symbols } : {}),
      // A window whose bytes did not number cleanly against its declared range
      // is still delivered, inline, so the reshape never hides source.
      ...(shown ? { content_block: shown.content_block } : { content: window.content }),
    };
  });

  const returned = new Set(
    (Array.isArray(value.identifiersReturned) ? value.identifiersReturned : []).map(lowered),
  );
  const omitted = [];
  const mapped = new Set();
  for (const request of requests) {
    mapped.add(lowered(request.identifier));
    const requestTargets = Array.isArray(request.targets) ? request.targets : [];
    if (requestTargets.length === 0) {
      if (!returned.has(lowered(request.identifier))) omitted.push({ identifier: request.identifier });
      continue;
    }
    for (const target of requestTargets) {
      const lines = targetLines(target);
      const coverage = lines ? displayedCoverage(lines, displayedRanges) : target.coverage;
      if (coverage === "full") continue;
      omitted.push({
        ...(target.symbolId != null ? { symbolId: target.symbolId } : {}),
        ...(target.name != null ? { name: target.name } : {}),
        ...(Array.isArray(target.lines) ? { [SOURCE_WINDOW_DISPLAY_FIELDS.LINES]: target.lines } : {}),
      });
    }
  }
  // Identifiers withheld beyond the map's per-call row limit, or with no map
  // at all, still need a row so the caller knows they were found but not shown.
  for (const identifier of Array.isArray(value.identifiersOmitted) ? value.identifiersOmitted : []) {
    if (mapped.has(lowered(identifier))) continue;
    omitted.push({ identifier });
  }

  // `content` is either already lifted into a block or the empty string an
  // emptied primary carries; `startLine`/`endLine` described that primary.
  for (const field of [
    "content", "startLine", "endLine", "content_block", "additionalWindows", "map",
    "identifiersFound", "identifiersReturned", "identifiersOmitted",
  ]) delete header[field];
  trimTransportFields(header);
  header[SOURCE_WINDOW_DISPLAY_FIELDS.DISPLAYED] = displayed;
  if (omitted.length > 0) header[SOURCE_WINDOW_DISPLAY_FIELDS.OMITTED] = omitted;
  return header;
}

function displayWindows(value, blockOffset) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !canonicalEvidenceSourcePath(value.repo_rel_path)) return null;
  const header = { ...value };
  const blocks = [];
  const lifted = [];
  function lift(window) {
    // `header` is lifted in place and loses `content` afterwards, so record
    // emptiness now rather than reading it back later.
    const empty = typeof window?.content !== "string" || window.content === "";
    const numbered = numberedWindow(window, value.repo_rel_path);
    if (numbered == null) {
      lifted.push({ window, shown: null, empty });
      return window;
    }
    blocks.push({ type: "text", text: numbered });
    const displayed = { ...window };
    delete displayed.content;
    displayed.content_block = blockOffset + blocks.length;
    displayed.content_line_format = SOURCE_LINE_DISPLAY_FORMAT;
    lifted.push({ window, shown: displayed, empty });
    return displayed;
  }
  // Preserve the returned order, including separate ranges in the same file.
  Object.assign(header, lift(header));
  if (blocks.length > 0) {
    delete header.content;
    if (blockOffset === 0) header.content_next_block = true;
  }
  for (const field of ["additionalWindows", "requestedWindows"]) {
    if (Array.isArray(header[field])) header[field] = header[field].map(lift);
  }
  // Only a file-mode code.window (identifier selection, no symbol target) is
  // reshaped. Compaction has already swapped a canonical symbolId for its
  // short symbolHandle, so a symbol target is recognised by either field.
  const fileMode = value.symbolId == null
    && value.symbolHandle == null
    && Array.isArray(value.identifiersFound)
    && !Array.isArray(value.requestedWindows);
  // A response with nothing to display and nothing withheld (a coverage
  // notice such as `status: "covered"`) is not a window and keeps its shape.
  const hasWindowContent = blocks.length > 0 || value.map != null
    || Array.isArray(value.continuationRanges) || value.traversal_ref != null;
  if (fileMode && hasWindowContent) {
    // Paging or range reuse can empty the primary window (content "" and an
    // end line below the start line). That is the absence of a window, not a
    // window that failed to number, so it is not displayed. The reshape runs
    // even with no numbered block at all (a map-only or fully paged response)
    // so the native map never reaches the model.
    const windows = lifted.filter(({ empty }, index) => !(index === 0 && empty));
    return { header: fileWindowDisplay(header, windows, value), blocks };
  }
  if (blocks.length === 0) return null;
  // Symbol-card responses carry no identifier lists at all, so a symbol target
  // is recognised by its id or handle and a single numbered body.
  const symbolTarget = (value.symbolId != null || value.symbolHandle != null)
    && lifted.length === 1 && lifted[0].shown;
  if (symbolTarget) return { header: symbolWindowDisplay(header, lifted[0].shown), blocks };
  return { header, blocks };
}

// Run after source custody, ref materialization and admission. This function
// never writes to the stored evidence or changes which ranges are citable.
export function sourceLineDisplay(parsed, blockOffset = 0, resolveEvidence = null) {
  if ([parsed?.tool, parsed?.action].some((name) => String(name || "").endsWith("code.skeleton"))
    && parsed?.contentKind !== CODE_CONTENT_KINDS.SOURCE) return null;
  if (parsed?.evidence_ref?.citable === false
    || parsed?.evidence_ref?.usage === "inspect_only"
    || parsed?.page?.mode === "search") return null;
  // A multi-ref read has one shared header. Block indices in every nested
  // source window must refer to the blocks after that header, not restart at 1.
  if (Array.isArray(parsed?.refs)) {
    const blocks = [];
    const refs = parsed.refs.map((entry) => {
      const displayed = sourceLineDisplay(entry, blockOffset + blocks.length, resolveEvidence);
      if (!displayed) return entry;
      blocks.push(...displayed.blocks);
      return displayed.header;
    });
    return blocks.length > 0
      ? { header: { ...parsed, refs, source_blocks_follow: blocks.length }, blocks }
      : null;
  }
  const direct = displayWindows(parsed, blockOffset);
  if (direct) return direct;
  // Raw pages use exact capability mappings. Legacy structured pages still
  // require a complete JSON envelope; search pages are not source evidence.
  if (parsed?.evidence_ref?.line_semantics !== "source"
    || typeof parsed.text !== "string") return null;
  if (resolveEvidence) {
    const entry = resolveEvidence(parsed.evidence_ref.ref);
    if (!entry || entry.payload_text !== parsed.text || entry.metadata?.line_semantics !== "source"
      || entry.metadata.citable === false) return null;
    if (entry?.metadata?.source_payload_encoding === RAW_SOURCE_LINES_ENCODING) {
      return displayRawSourcePage(parsed, entry, blockOffset);
    }
  }
  let source;
  try { source = JSON.parse(parsed.text); } catch { return null; }
  if (source?.tool !== "code.window") return null;
  const displayed = displayWindows(source, blockOffset);
  if (!displayed) return null;
  return {
    header: {
      ...parsed,
      text: JSON.stringify(displayed.header),
      source_blocks_follow: displayed.blocks.length,
    },
    blocks: displayed.blocks,
  };
}

function displayRawSourcePage(parsed, entry, blockOffset) {
  // Resolve only the exact issued capability in this call's scope. Never
  // recover coordinates from the backing ref or apparent gutters in source.
  if (entry.payload_text !== parsed.text || entry.metadata.line_semantics !== "source"
    || entry.metadata.citable === false) return null;
  const rows = sourceRows(parsed.text);
  const windows = normalizedEvidenceSourceWindows(entry.metadata.source_windows)
    .sort((a, b) => a.materialized_start_line - b.materialized_start_line);
  const blocks = [];
  const selections = [];
  let nextRow = 1;
  const lift = (start, end, window = null) => {
    const content = rows.slice(start - 1, end).join("");
    if (!content) return;
    const numbered = window ? numberedWindow({
      content, startLine: window.source_start_line, endLine: window.source_end_line,
    }, window.path) : null;
    blocks.push({ type: "text", text: numbered ?? content });
    selections.push({
      ...(numbered != null ? {
        repo_rel_path: window.path, startLine: window.source_start_line, endLine: window.source_end_line,
        content_line_format: SOURCE_LINE_DISPLAY_FORMAT,
      } : { citable: false }),
      content_block: blockOffset + blocks.length,
    });
  };
  for (const window of windows) {
    const start = window.materialized_start_line;
    const end = window.materialized_end_line;
    if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < nextRow
      || end > rows.length || end - start !== window.source_end_line - window.source_start_line) continue;
    if (start > nextRow) lift(nextRow, start - 1);
    lift(start, end, window);
    nextRow = end + 1;
  }
  if (nextRow <= rows.length) lift(nextRow, rows.length);
  if (!selections.some((selection) => selection.content_line_format)) return null;
  return {
    header: {
      ...parsed,
      text: JSON.stringify({ tool: "code.window", requestedWindows: selections }),
      source_blocks_follow: blocks.length,
    },
    blocks,
  };
}
