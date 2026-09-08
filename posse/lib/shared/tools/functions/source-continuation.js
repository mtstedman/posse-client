import crypto from "crypto";
import { RAW_SOURCE_LINES_ENCODING } from "../../../catalog/source-display.js";
import { canonicalEvidenceSourcePath } from "./source-evidence.js";

// Rows include their original terminators; a terminator is not an extra row.
export function sourceRows(text) {
  const rows = String(text ?? "").match(/[^\r\n]*(?:\r\n|\r|\n|$)/g);
  if (rows.at(-1) === "") rows.pop();
  return rows;
}

export function sourceContinuationPayload(windows, { path, repositoryIdentity, sourceVersion, selectorFingerprint } = {}) {
  const sourcePath = canonicalEvidenceSourcePath(path);
  let payload = "";
  let row = 1;
  const mapped = [];
  for (const window of windows) {
    // A separator between unterminated selections is framing, outside both
    // exact content spans. It does not create or claim a source gap line.
    if (payload && (!/[\r\n]$/.test(payload)
      || (payload.endsWith("\r") && window.content.startsWith("\n")))) payload += "\n";
    const start = payload.length;
    const rows = sourceRows(window.content);
    payload += window.content;
    if (sourcePath && rows.length > 0
      && Number.isSafeInteger(window.startLine) && window.startLine > 0
      && window.endLine === window.startLine + rows.length - 1) {
      mapped.push({
        repository_identity: repositoryIdentity || null,
        source_version: sourceVersion || null,
        repo_rel_path: sourcePath, path: sourcePath,
        start_line: window.startLine, end_line: window.endLine,
        source_start_line: window.startLine, source_end_line: window.endLine,
        materialized_start_line: row, materialized_end_line: row + rows.length - 1,
        payload_start: start, payload_end: payload.length,
        source_payload_encoding: RAW_SOURCE_LINES_ENCODING,
        content_sha256: crypto.createHash("sha256").update(window.content.replace(/\r\n/g, "\n")).digest("hex"),
        selector_fingerprint: selectorFingerprint,
      });
    }
    row += rows.length;
  }
  // Conflicting overlaps are retained for inspection, without inventing one
  // authoritative version of their source lines.
  const conflicting = new Set();
  for (let i = 0; i < mapped.length; i += 1) {
    for (let j = i + 1; j < mapped.length; j += 1) {
      const a = mapped[i];
      const b = mapped[j];
      const start = Math.max(a.source_start_line, b.source_start_line);
      const end = Math.min(a.source_end_line, b.source_end_line);
      if (start > end) continue;
      const aRows = sourceRows(payload.slice(a.payload_start, a.payload_end));
      const bRows = sourceRows(payload.slice(b.payload_start, b.payload_end));
      for (let line = start; line <= end; line += 1) {
        if (aRows[line - a.source_start_line].replace(/[\r\n]+$/, "")
          !== bRows[line - b.source_start_line].replace(/[\r\n]+$/, "")) {
          conflicting.add(a);
          conflicting.add(b);
          break;
        }
      }
    }
  }
  return { payload, sourceWindows: mapped.filter((window) => !conflicting.has(window)) };
}

// Apply after serialized shrinking, before issuing the visible capability or
// its successor cursor. Never grow a page to force a complete line to fit.
export function alignSourceContinuationPage(renderedText, entry) {
  if (entry?.metadata?.source_payload_encoding !== RAW_SOURCE_LINES_ENCODING) return renderedText;
  let value;
  try { value = JSON.parse(renderedText); } catch { return renderedText; }
  if (value?.page?.mode !== "offset" || typeof value.text !== "string" || !value.text) return renderedText;
  const offset = value.page.offset;
  const full = entry.payload_text;
  const end = offset + value.text.length;
  if (end >= full.length) return renderedText;
  const beginsLine = offset === 0 || full[offset - 1] === "\n"
    || (full[offset - 1] === "\r" && full[offset] !== "\n");
  if (!beginsLine) return renderedText;
  let length = value.text.length;
  // Even fallback pages should avoid splitting surrogate pairs and CRLF when
  // possible. A one-character budget must still make lossless progress.
  if (length > 1 && ((/[\uD800-\uDBFF]/.test(full[end - 1]) && /[\uDC00-\uDFFF]/.test(full[end]))
    || (full[end - 1] === "\r" && full[end] === "\n"))) length -= 1;
  if (beginsLine) {
    let complete = 0;
    for (const row of sourceRows(value.text.slice(0, length))) {
      if (!/[\r\n]$/.test(row)) break;
      complete += row.length;
    }
    if (complete > 0) length = complete;
  }
  if (length === value.text.length) return renderedText;
  value.text = value.text.slice(0, length);
  Object.assign(value.page, {
    returned_chars: length, limit: length, next_offset: offset + length, has_more: true,
  });
  return JSON.stringify(value);
}
