import { CODE_CONTENT_KINDS, RAW_SOURCE_LINES_ENCODING, SOURCE_LINE_DISPLAY_FORMAT } from "../../../catalog/source-display.js";
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

function displayWindows(value, blockOffset) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || !canonicalEvidenceSourcePath(value.repo_rel_path)) return null;
  const header = { ...value };
  const blocks = [];
  function lift(window) {
    const numbered = numberedWindow(window, value.repo_rel_path);
    if (numbered == null) return window;
    blocks.push({ type: "text", text: numbered });
    const displayed = { ...window };
    delete displayed.content;
    displayed.content_block = blockOffset + blocks.length;
    displayed.content_line_format = SOURCE_LINE_DISPLAY_FORMAT;
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
  return blocks.length > 0 ? { header, blocks } : null;
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
