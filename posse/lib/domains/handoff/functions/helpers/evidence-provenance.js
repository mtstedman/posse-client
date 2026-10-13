import { normalizedEvidenceSourceWindow } from "../../../../shared/tools/functions/source-evidence.js";
import { normalizeHashRefAlias } from "../../../../catalog/hash-store.js";
import { fetchHashRefForContext } from "../../../queue/functions/hash-refs.js";
import { RAW_SOURCE_LINES_ENCODING } from "../../../../catalog/source-display.js";
import { normalizedLines } from "./evidence-selector.js";
import { canonicalSourcePath } from "../evidence-source-path.js";

function deliveredRedactedLineMatches(sourceLine, deliveredLine) {
  const source = String(sourceLine ?? "");
  const delivered = String(deliveredLine ?? "");
  if (source === delivered) return true;
  const marker = "<redacted>";
  if (!delivered.includes(marker)) return false;
  const segments = delivered.split(marker);
  if (!source.startsWith(segments[0]) || !source.endsWith(segments.at(-1))) return false;
  let cursor = segments[0].length;
  const suffixStart = source.length - segments.at(-1).length;
  for (const segment of segments.slice(1, -1)) {
    if (!segment) continue;
    const next = source.indexOf(segment, cursor);
    if (next < cursor || next > suffixStart) return false;
    cursor = next + segment.length;
  }
  return cursor <= suffixStart;
}

export function deliveredSourceExcerptMatches(sourceExcerpt, deliveredExcerpt) {
  const sourceLines = String(sourceExcerpt ?? "").replace(/\r\n?/g, "\n").split("\n");
  const deliveredLines = String(deliveredExcerpt ?? "").replace(/\r\n?/g, "\n").split("\n");
  return sourceLines.length === deliveredLines.length
    && sourceLines.every((line, index) => deliveredRedactedLineMatches(line, deliveredLines[index]));
}

export function sourceLineage(entry, context, seen = new Set()) {
  const recorded = String(entry?.metadata?.line_semantics || "").toLowerCase();
  const recordedWindows = (Array.isArray(entry?.metadata?.source_windows)
    ? entry.metadata.source_windows
    : []).map(normalizedEvidenceSourceWindow).filter(Boolean);
  if (recorded === "source" && recordedWindows.length > 0) {
    return {
      line_semantics: "source",
      source_windows: recordedWindows,
      content_entry: entry,
      source_metadata: entry.metadata || {},
    };
  }
  if (recorded === "materialized") {
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }

  const source = String(entry?.source || "").trim().toLowerCase();
  if (source !== "agent:create_ref") {
    // Compatibility for refs created before source-window metadata existed:
    // preserve the original stored-result coordinate contract explicitly.
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }
  const sourceRef = normalizeHashRefAlias(entry?.descriptor?.source_ref ?? entry?.metadata?.source_ref);
  const slice = entry?.descriptor?.slice ?? entry?.metadata?.slice;
  if (!sourceRef || !slice || seen.has(sourceRef)) {
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }
  const fetched = fetchHashRefForContext(context, sourceRef);
  const sourceEntry = fetched?.found ? fetched.entry : null;
  if (!sourceEntry || sourceEntry.entry_kind !== "materialized" || sourceEntry.payload_text == null) {
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }
  const derived = exactDerivedSlice(sourceEntry.payload_text, slice);
  if (derived == null || derived !== String(entry?.payload_text ?? "")) {
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }
  const lineMatch = /^lines:(\d+)-(\d+)$/.exec(String(slice));
  if (!lineMatch) return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  const sliceStart = Number(lineMatch[1]);
  const sliceEnd = Number(lineMatch[2]);
  const nextSeen = new Set(seen);
  nextSeen.add(sourceRef);
  const parent = sourceLineage(sourceEntry, context, nextSeen);
  if (parent.line_semantics !== "source") {
    return { line_semantics: "materialized", source_windows: [], content_entry: entry };
  }
  const inherited = parent.source_windows.flatMap((window) => {
    if (!Number.isInteger(window.materialized_start_line)
      || !Number.isInteger(window.materialized_end_line)
      || window.materialized_end_line < sliceStart
      || window.materialized_start_line > sliceEnd) return [];
    const materializedStart = Math.max(window.materialized_start_line, sliceStart);
    const materializedEnd = Math.min(window.materialized_end_line, sliceEnd);
    const sourceSpan = window.source_end_line - window.source_start_line;
    const materializedSpan = window.materialized_end_line - window.materialized_start_line;
    if (sourceSpan !== materializedSpan) return [];
    return [{
      ...window,
      source_start_line: window.source_start_line
        + materializedStart - window.materialized_start_line,
      source_end_line: window.source_start_line
        + materializedEnd - window.materialized_start_line,
      materialized_start_line: materializedStart - sliceStart + 1,
      materialized_end_line: materializedEnd - sliceStart + 1,
    }];
  });
  return inherited.length > 0
    ? {
        line_semantics: "source",
        source_windows: inherited,
        content_entry: entry,
        source_metadata: parent.source_metadata || parent.content_entry?.metadata || {},
      }
    : { line_semantics: "materialized", source_windows: [], content_entry: entry };
}

function mergeSourceContentRecords(records) {
  const ordered = records
    .filter((record) => record?.path
      && Number.isInteger(record.source_start_line)
      && Number.isInteger(record.source_end_line)
      && record.source_end_line >= record.source_start_line
      && Array.isArray(record.content_lines)
      && record.content_lines.length === record.source_end_line - record.source_start_line + 1)
    .sort((left, right) => (
      left.path.localeCompare(right.path)
      || left.source_start_line - right.source_start_line
      || left.source_end_line - right.source_end_line
    ));
  const merged = [];
  for (const record of ordered) {
    const prior = merged.at(-1);
    if (!prior || prior.path !== record.path
      || record.source_start_line > prior.source_end_line + 1) {
      merged.push({ ...record, content_lines: [...record.content_lines] });
      continue;
    }
    let compatible = true;
    const overlapEnd = Math.min(prior.source_end_line, record.source_end_line);
    for (let line = record.source_start_line; line <= overlapEnd; line += 1) {
      if (prior.content_lines[line - prior.source_start_line]
        !== record.content_lines[line - record.source_start_line]) {
        compatible = false;
        break;
      }
    }
    if (!compatible) {
      merged.push({ ...record, content_lines: [...record.content_lines] });
      continue;
    }
    const appendFrom = Math.max(0, prior.source_end_line - record.source_start_line + 1);
    prior.content_lines.push(...record.content_lines.slice(appendFrom));
    prior.source_end_line = Math.max(prior.source_end_line, record.source_end_line);
  }
  return merged;
}

export function payloadSourceContentWindows(entry, lineage, { allowUnrecordedWindows = false } = {}) {
  const payload = String(entry?.payload_text || "");
  // Delegated excerpts and raw source windows are joins of the source-line
  // array, not raw file bytes. A trailing LF can therefore be the declared
  // final blank source line rather than an ignorable file terminator. Keep it
  // here and let the authoritative materialized window count validate it.
  const payloadLines = ["delegated_excerpt", RAW_SOURCE_LINES_ENCODING].includes(entry?.metadata?.source_payload_encoding)
    ? payload.replace(/\r\n?/g, "\n").split("\n")
    : normalizedLines(payload);
  const authoritative = lineage.source_windows;
  if (entry?.metadata?.source_payload_encoding === RAW_SOURCE_LINES_ENCODING) {
    return authoritative.map((window) => {
      const start = window.materialized_start_line;
      const end = window.materialized_end_line;
      const selected = Number.isSafeInteger(start) && start > 0 && Number.isSafeInteger(end)
        ? payloadLines.slice(start - 1, end) : [];
      return { ...window, content_lines: selected.length === window.source_end_line - window.source_start_line + 1
        ? selected : null };
    });
  }
  let parsed;
  try { parsed = JSON.parse(payload); } catch { parsed = null; }
  const data = parsed?.data && typeof parsed.data === "object" ? parsed.data : parsed;
  const records = [];
  const add = (sourcePath, sourceStart, content, expectedLineCount = null) => {
    const canonicalPath = canonicalSourcePath(sourcePath);
    const lines = Number.isInteger(expectedLineCount) && expectedLineCount > 0
      ? String(content ?? "").replace(/\r\n?/g, "\n").split("\n")
      : normalizedLines(content);
    // Raw window bytes may terminate the last source line with a newline.
    // Remove only that split sentinel when the declared count proves it is
    // extra; a final blank line already included in the count is source.
    if (Number.isInteger(expectedLineCount)
      && lines.length === expectedLineCount + 1 && lines.at(-1) === "") lines.pop();
    if (!canonicalPath || !Number.isInteger(sourceStart) || sourceStart < 1 || lines.length === 0) return;
    if (Number.isInteger(expectedLineCount) && lines.length !== expectedLineCount) return;
    records.push({
      path: canonicalPath,
      source_start_line: sourceStart,
      source_end_line: sourceStart + lines.length - 1,
      content_lines: lines,
    });
  };

  const worktreeHeaderPrefix = "[posse.worktree_evidence.v1 ";
  const worktreeHeader = payloadLines[0] || "";
  if (worktreeHeader.startsWith(worktreeHeaderPrefix) && worktreeHeader.endsWith("]")) {
    try {
      const identity = JSON.parse(worktreeHeader.slice(worktreeHeaderPrefix.length, -1));
      const headerEnd = payload.indexOf("\n");
      const sourceLineCount = Number(identity.end_line) - Number(identity.start_line) + 1;
      add(
        identity.path,
        Number(identity.start_line),
        headerEnd >= 0 ? payload.slice(headerEnd + 1) : "",
        sourceLineCount,
      );
    } catch {
      // Invalid identity headers are not authoritative source content.
    }
  }

  if (parsed?.kind === "posse.worktree_evidence.v1" && typeof parsed.content === "string") {
    add(parsed.path, Number(parsed.start_line), parsed.content);
  }

  const candidates = data && typeof data === "object" ? [
    data,
    ...(Array.isArray(data.additionalWindows) ? data.additionalWindows : []),
    ...(Array.isArray(data.additional_windows) ? data.additional_windows : []),
  ] : [];
  const fallbackPath = data?.repo_rel_path || data?.repoRelPath || data?.path || entry?.metadata?.path;
  for (const candidate of candidates) {
    if (candidate && typeof candidate.content === "string") {
      const sourceStart = Number(candidate.startLine ?? candidate.start_line);
      const sourceEnd = Number(candidate.endLine ?? candidate.end_line);
      const expectedLineCount = Number.isInteger(sourceStart)
        && Number.isInteger(sourceEnd)
        && sourceEnd >= sourceStart
        ? sourceEnd - sourceStart + 1
        : null;
      add(
        candidate.repo_rel_path || candidate.repoRelPath || candidate.path || fallbackPath,
        sourceStart,
        candidate.content,
        expectedLineCount,
      );
    }
  }
  for (const candidate of Array.isArray(data?.requestedWindows) ? data.requestedWindows : []) {
    if (candidate && typeof candidate.content === "string") {
      const sourceStart = Number(candidate.startLine ?? candidate.start_line);
      const sourceEnd = Number(candidate.endLine ?? candidate.end_line);
      const expectedLineCount = Number.isInteger(sourceStart)
        && Number.isInteger(sourceEnd)
        && sourceEnd >= sourceStart
        ? sourceEnd - sourceStart + 1
        : null;
      add(
        candidate.repo_rel_path || candidate.repoRelPath || candidate.path || fallbackPath,
        sourceStart,
        candidate.content,
        expectedLineCount,
      );
    }
  }

  const lensMatches = [
    ...(Array.isArray(data?.matches) ? data.matches : []),
    ...(Array.isArray(data?.tailMatches) ? data.tailMatches : []),
  ];
  if (lensMatches.length > 0) {
    const byPath = new Map();
    for (const match of lensMatches) {
      const sourcePath = canonicalSourcePath(match?.repo_rel_path || match?.repoRelPath || fallbackPath);
      const sourceLine = Number(match?.line);
      if (!sourcePath || !Number.isInteger(sourceLine) || sourceLine < 1 || typeof match?.text !== "string") continue;
      const lineMap = byPath.get(sourcePath) || new Map();
      byPath.set(sourcePath, lineMap);
      const before = Array.isArray(match?.context?.before) ? match.context.before.map(String) : [];
      const after = Array.isArray(match?.context?.after) ? match.context.after.map(String) : [];
      const values = [...before, match.text, ...after];
      const firstLine = Math.max(1, sourceLine - before.length);
      for (const [index, text] of values.entries()) {
        const lineNumber = firstLine + index;
        const prior = lineMap.get(lineNumber);
        if (prior == null) lineMap.set(lineNumber, text);
        else if (prior !== text) lineMap.set(lineNumber, null);
      }
    }
    for (const [sourcePath, lineMap] of byPath) {
      for (const window of authoritative.filter((candidate) => candidate.path === sourcePath)) {
        const lines = [];
        for (let line = window.source_start_line; line <= window.source_end_line; line += 1) {
          const text = lineMap.get(line);
          if (typeof text !== "string") {
            lines.length = 0;
            break;
          }
          lines.push(text);
        }
        if (lines.length > 0) records.push({ ...window, content_lines: lines });
      }
    }
  }

  const uniqueAuthoritativePaths = [...new Set(authoritative.map((window) => window.path))];
  const gutterPath = canonicalSourcePath(entry?.metadata?.path)
    || (uniqueAuthoritativePaths.length === 1 ? uniqueAuthoritativePaths[0] : null);
  let current = null;
  for (const line of normalizedLines(payload)) {
    const matched = /^\s*(\d+)\t(.*)$/.exec(line);
    const sourceLine = Number(matched?.[1]);
    if (!gutterPath || !matched || !Number.isInteger(sourceLine) || sourceLine < 1) {
      current = null;
      continue;
    }
    if (!current || sourceLine !== current.source_end_line + 1) {
      current = {
        path: gutterPath,
        source_start_line: sourceLine,
        source_end_line: sourceLine,
        content_lines: [],
      };
      records.push(current);
    }
    current.source_end_line = sourceLine;
    current.content_lines.push(matched[2]);
  }

  for (const window of authoritative) {
    if (!Number.isInteger(window.materialized_start_line)
      || !Number.isInteger(window.materialized_end_line)) continue;
    const selected = payloadLines.slice(
      window.materialized_start_line - 1,
      window.materialized_end_line,
    );
    const numbered = selected.map((line) => /^\s*(\d+)\t(.*)$/.exec(line));
    if (numbered.length === window.source_end_line - window.source_start_line + 1
      && numbered.every((match, index) => (
        Number(match?.[1]) === window.source_start_line + index
      ))) {
      records.push({
        ...window,
        content_lines: numbered.map((match) => match[2]),
      });
    }
    if (selected.length === window.source_end_line - window.source_start_line + 1) {
      records.push({ ...window, content_lines: selected });
    }
  }

  // Legacy compact envelopes have no authoritative metadata. Preserve each
  // candidate independently so overlapping windows cannot hide ambiguity.
  if (allowUnrecordedWindows && authoritative.length === 0) return records;
  const mergedRecords = mergeSourceContentRecords(records);
  return authoritative.map((window) => {
    const record = mergedRecords.find((candidate) => (
      candidate.path === window.path
      && candidate.source_start_line <= window.source_start_line
      && candidate.source_end_line >= window.source_end_line
    ));
    if (!record) return { ...window, content_lines: null };
    return {
      ...window,
      content_lines: record.content_lines.slice(
        window.source_start_line - record.source_start_line,
        window.source_end_line - record.source_start_line + 1,
      ),
    };
  });
}

export function coalescedSourceContentWindows(entry, lineage) {
  const windows = payloadSourceContentWindows(lineage.content_entry || entry, lineage);
  if (windows.some((window) => !Array.isArray(window.content_lines))) return windows;
  const merged = mergeSourceContentRecords(windows);
  for (let index = 1; index < merged.length; index += 1) {
    const prior = merged[index - 1];
    const current = merged[index];
    if (prior.path === current.path && current.source_start_line <= prior.source_end_line) {
      return windows;
    }
  }
  return merged.map((window) => {
    const contributors = windows.filter((candidate) => (
      candidate.path === window.path
      && candidate.source_start_line <= window.source_end_line
      && candidate.source_end_line >= window.source_start_line
    ));
    return {
      ...window,
      materialized_start_line: Math.min(...contributors.map((candidate) => (
        Number(candidate.materialized_start_line) || Number.MAX_SAFE_INTEGER
      ))),
      materialized_end_line: Math.max(...contributors.map((candidate) => (
        Number(candidate.materialized_end_line) || 0
      ))),
    };
  });
}

export function sourceLineSlice(entry, lineage, start, end, {
  sourcePath = null,
  sourceWindow = null,
} = {}) {
  const windows = coalescedSourceContentWindows(lineage.content_entry || entry, lineage);
  const containing = windows.filter((window) => (
    start >= window.source_start_line && end <= window.source_end_line
  ));
  const requestedPath = canonicalSourcePath(sourcePath || sourceWindow?.path);
  const matches = requestedPath
    ? containing.filter((window) => window.path === requestedPath)
    : containing;
  const sourceRanges = windows.map((window) => ({
    path: window.path,
    start: window.source_start_line,
    end: window.source_end_line,
  }));
  if (matches.length === 0) return { matched: false, sourceRanges };
  const excerpts = matches.map((window) => Array.isArray(window.content_lines)
    ? window.content_lines.slice(
        start - window.source_start_line,
        end - window.source_start_line + 1,
      ).join("\n")
    : null);
  const distinctPaths = new Set(matches.map((window) => window.path));
  const distinctExcerpts = new Set(excerpts);
  if (matches.length > 1 && (distinctPaths.size !== 1 || distinctExcerpts.size !== 1)) {
    return { matched: false, sourceRanges };
  }
  const matched = matches[0];
  if (!Array.isArray(matched.content_lines)) {
    return { matched: false, sourceRanges, contentUnavailable: true };
  }
  return {
    matched: true,
    path: matched.path,
    sourceStart: start,
    sourceEnd: end,
    sourceRanges,
    excerpt: excerpts[0],
    sourceWindow: Object.fromEntries(
      Object.entries(matched).filter(([key]) => key !== "content_lines"),
    ),
  };
}

// Ref-relative ("page") coordinates → source coordinates for compatibility
// with citations that treat a compact body or continuation page as lines 1..N.
// Source-numbered display is authoritative: any source-coordinate overlap,
// including partial overlap, wins and is trimmed by claim materialization.
// Only a selector with no source overlap reaches this translation path. It
// must resolve against one unambiguous materialized window. A single scoped
// window without materialized coordinates is treated as materialized at 1..span.
export function refRelativeCoordinates(entry, lineage, start, end, { sourcePath = null } = {}) {
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  const requestedPath = canonicalSourcePath(sourcePath);
  const scoped = lineage.source_windows.filter((window) => !requestedPath || window.path === requestedPath);
  const eligible = scoped
    .map((window) => {
      const sourceSpan = Number(window.source_end_line) - Number(window.source_start_line);
      let materializedStart = Number(window.materialized_start_line);
      let materializedEnd = Number(window.materialized_end_line);
      if ((!Number.isInteger(materializedStart) || !Number.isInteger(materializedEnd)) && scoped.length === 1) {
        materializedStart = 1;
        materializedEnd = 1 + sourceSpan;
      }
      if (!Number.isInteger(materializedStart) || !Number.isInteger(materializedEnd)) return null;
      if (materializedEnd - materializedStart !== sourceSpan) return null;
      return { ...window, materialized_start_line: materializedStart, materialized_end_line: materializedEnd };
    })
    .filter(Boolean);
  const candidates = eligible.filter((window) => {
    const materializedStart = Number(window.materialized_start_line);
    const materializedEnd = Number(window.materialized_end_line);
    return start >= materializedStart
      && end <= materializedEnd;
  });
  const singleStartCovered = candidates.length === 0 && eligible.length === 1
    && start >= eligible[0].materialized_start_line
    && start <= eligible[0].materialized_end_line;
  const translatable = candidates.length === 1
    ? candidates
    : (singleStartCovered ? eligible : []);
  if (translatable.length !== 1) {
    // A compact code.window envelope can be one serialized JSON line while
    // carrying exact multi-line source windows in its content fields. The
    // model may cite that embedded body as 1..N when those coordinates have
    // no source overlap, but the envelope's recorded range is 1..1. Translate
    // against the unique available body that covers the relative start line.
    // Never apply this when two bodies could satisfy the same selector.
    const contentWindows = coalescedSourceContentWindows(lineage.content_entry || entry, lineage)
      .filter((window) => !requestedPath || window.path === requestedPath)
      .filter((window) => Array.isArray(window.content_lines)
        && window.content_lines.length === window.source_end_line - window.source_start_line + 1);
    const coveringContentWindows = contentWindows.filter((window) => (
      start >= 1 && start <= window.content_lines.length
    ));
    const contentWindow = coveringContentWindows.length === 1 ? coveringContentWindows[0] : null;
    if (contentWindow) {
      const clampedRelativeEnd = Math.min(end, contentWindow.content_lines.length);
      return {
        matched: true,
        path: contentWindow.path,
        translatedStart: contentWindow.source_start_line + start - 1,
        translatedEnd: contentWindow.source_start_line + clampedRelativeEnd - 1,
        sourceContentRelative: true,
        ...(clampedRelativeEnd === end ? {} : {
          requestedMaterializedEnd: end,
          clampedMaterializedEnd: clampedRelativeEnd,
        }),
        materializedRange: { start: 1, end: contentWindow.content_lines.length },
        materializedRanges: [{
          path: contentWindow.path,
          start: 1,
          end: contentWindow.content_lines.length,
        }],
      };
    }
    return {
      matched: false,
      ambiguous: candidates.length > 1,
      materializedRanges: lineage.source_windows.map((window) => ({
        path: window.path,
        start: window.materialized_start_line,
        end: window.materialized_end_line,
      })),
    };
  }
  const window = translatable[0];
  const clampedMaterializedEnd = Math.min(end, window.materialized_end_line);
  const translatedStart = window.source_start_line + start - window.materialized_start_line;
  const translatedEnd = window.source_start_line + clampedMaterializedEnd - window.materialized_start_line;
  return {
    matched: true,
    path: window.path,
    translatedStart,
    translatedEnd,
    ...(clampedMaterializedEnd === end ? {} : {
      requestedMaterializedEnd: end,
      clampedMaterializedEnd,
    }),
    materializedRange: {
      start: window.materialized_start_line,
      end: window.materialized_end_line,
    },
    materializedRanges: [{
      path: window.path,
      start: window.materialized_start_line,
      end: window.materialized_end_line,
    }],
  };
}

export function disjointSourceMaterialization(entry, lineage) {
  const contentWindows = coalescedSourceContentWindows(lineage.content_entry || entry, lineage);
  if (contentWindows.length === 0
    || contentWindows.some((window) => !Array.isArray(window.content_lines))) return null;
  const ordered = [...contentWindows].sort((left, right) => (
    (Number(left.materialized_start_line) || Number.MAX_SAFE_INTEGER)
    - (Number(right.materialized_start_line) || Number.MAX_SAFE_INTEGER)
    || left.path.localeCompare(right.path)
    || left.source_start_line - right.source_start_line
  ));
  const excerptLines = [];
  const sourceWindows = [];
  for (const window of ordered) {
    const materializedStart = excerptLines.length + 1;
    excerptLines.push(...window.content_lines);
    const sourceWindow = Object.fromEntries(
      Object.entries(window).filter(([key]) => key !== "content_lines"),
    );
    sourceWindows.push({
      ...sourceWindow,
      materialized_start_line: materializedStart,
      materialized_end_line: excerptLines.length,
    });
  }
  return {
    excerpt: excerptLines.join("\n"),
    lineCount: excerptLines.length,
    sourceWindows,
    paths: [...new Set(sourceWindows.map((window) => window.path))],
  };
}

function directProvenance(entry) {
  const objectType = String(entry?.object_type || "").trim().toLowerCase();
  const source = String(entry?.source || "").trim().toLowerCase();
  if (
    source === "agent:create_ref"
    || /(?:^|[._:-])(?:agent|assistant|prose)(?:[._:-]|$)/.test(objectType)
  ) {
    return "Agent Prose";
  }
  if (["full_tool_call", "tool_call_envelope", "tool.call.envelope"].includes(objectType)) {
    return "Full Tool Call";
  }
  if (
    objectType === "tool_result"
    || source === "system:worktree_read"
    || source.startsWith("tool:")
    || source.startsWith("tools.")
    || source.startsWith("atlas:")
    || source.startsWith("atlas.")
    || (source.startsWith("sub_agent:") && objectType === "tool_result")
  ) {
    return "Tool Result";
  }
  return "Materialized Text";
}

function exactDerivedSlice(sourceText, slice) {
  const value = String(sourceText ?? "");
  const lineMatch = /^lines:(\d+)-(\d+)$/.exec(String(slice || ""));
  if (lineMatch) {
    const start = Number(lineMatch[1]);
    const end = Number(lineMatch[2]);
    // Match atlas.create_ref's server-side line slicer byte-for-byte. This is
    // deliberately separate from terminal excerpt normalization below.
    const lines = value.replace(/\r\n/g, "\n").split("\n");
    if (start < 1 || end < start || end > lines.length) return null;
    return lines.slice(start - 1, end).join("\n");
  }
  const charMatch = /^chars:(\d+)-(\d+)$/.exec(String(slice || ""));
  if (charMatch) {
    const start = Number(charMatch[1]);
    const end = Number(charMatch[2]);
    if (start < 0 || end < start || end > value.length) return null;
    return value.slice(start, end);
  }
  return null;
}

export function evidenceProvenance(entry, context, seen = new Set()) {
  const kind = directProvenance(entry);
  const source = String(entry?.source || "").trim().toLowerCase();
  if (source !== "agent:create_ref") {
    return {
      kind,
      source: entry?.source || null,
      object_type: entry?.object_type || "text",
    };
  }

  const sourceRef = normalizeHashRefAlias(entry?.descriptor?.source_ref ?? entry?.metadata?.source_ref);
  const slice = entry?.descriptor?.slice ?? entry?.metadata?.slice;
  if (!sourceRef || !slice || seen.has(sourceRef)) {
    return {
      kind: "Agent Prose",
      source: entry?.source || null,
      object_type: entry?.object_type || "text",
    };
  }
  const fetched = fetchHashRefForContext(context, sourceRef);
  const sourceEntry = fetched?.found ? fetched.entry : null;
  if (!sourceEntry || sourceEntry.entry_kind !== "materialized" || sourceEntry.payload_text == null) {
    return {
      kind: "Agent Prose",
      source: entry?.source || null,
      object_type: entry?.object_type || "text",
    };
  }
  const derived = exactDerivedSlice(sourceEntry.payload_text, slice);
  if (derived == null || derived !== String(entry?.payload_text ?? "")) {
    return {
      kind: "Agent Prose",
      source: entry?.source || null,
      object_type: entry?.object_type || "text",
    };
  }
  const nextSeen = new Set(seen);
  nextSeen.add(sourceRef);
  const origin = evidenceProvenance(sourceEntry, context, nextSeen);
  return {
    kind: origin.kind,
    source: origin.source,
    object_type: entry?.object_type || sourceEntry.object_type || "text",
    derived_from: sourceRef,
    derivation: "server_slice",
  };
}
