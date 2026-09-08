export function canonicalEvidenceSourcePath(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
  if (!normalized || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) return null;
  if (normalized.split("/").some((segment) => segment === "." || segment === "..")) return null;
  return normalized;
}

export function normalizedEvidenceSourceWindow(value) {
  const sourcePath = canonicalEvidenceSourcePath(value?.path ?? value?.repo_rel_path);
  const sourceStart = Number(value?.source_start_line ?? value?.start_line);
  const sourceEnd = Number(value?.source_end_line ?? value?.end_line);
  const materializedStart = Number(value?.materialized_start_line);
  const materializedEnd = Number(value?.materialized_end_line);
  if (!sourcePath || !Number.isInteger(sourceStart) || sourceStart < 1
    || !Number.isInteger(sourceEnd) || sourceEnd < sourceStart) return null;
  return {
    path: sourcePath,
    source_start_line: sourceStart,
    source_end_line: sourceEnd,
    materialized_start_line: Number.isInteger(materializedStart) && materializedStart > 0
      ? materializedStart
      : null,
    materialized_end_line: Number.isInteger(materializedEnd) && materializedEnd >= materializedStart
      ? materializedEnd
      : null,
    ...(value?.repository_identity != null && String(value.repository_identity).trim() !== ""
      ? { repository_identity: value.repository_identity }
      : {}),
    ...(value?.source_version != null && String(value.source_version).trim() !== ""
      ? { source_version: value.source_version }
      : {}),
    ...(value?.source_payload_encoding != null && String(value.source_payload_encoding).trim() !== ""
      ? { source_payload_encoding: value.source_payload_encoding }
      : {}),
  };
}

export function normalizedEvidenceSourceWindows(value) {
  return (Array.isArray(value) ? value : [])
    .map(normalizedEvidenceSourceWindow)
    .filter(Boolean);
}

// The entry must be the exact visible capability, not its backing stored ref.
// Structured source can occupy one JSON line while citing many source lines.
export function sourceEvidenceCitationSurface(entry, { maxChars } = {}) {
  if (entry?.metadata?.line_semantics !== "source" || entry.metadata.citable === false) return null;
  const windows = normalizedEvidenceSourceWindows(entry.metadata.source_windows);
  if (windows.length === 0) return null;
  const textLines = String(entry.payload_text ?? "").replace(/\r\n?/g, "\n").split("\n");
  if (textLines.length > 1 && textLines.at(-1) === "") textLines.pop();
  const ranges = windows.map((window) => ({
    path: window.path, start: window.source_start_line, end: window.source_end_line,
  }));
  const surface = {
    line_semantics: "source",
    lines: ranges.reduce((count, range) => count + range.end - range.start + 1, 0),
    text_lines: textLines.length,
    source_ranges: [],
  };
  const cap = Math.max(0, Number(maxChars) || 0);
  for (const range of ranges) {
    const selected = [...surface.source_ranges, range];
    const omitted = ranges.length - selected.length;
    const candidate = {
      ...surface, source_ranges: selected,
      ...(omitted > 0 ? { source_ranges_omitted: omitted } : {}),
    };
    if (JSON.stringify(candidate).length <= cap) surface.source_ranges = selected;
  }
  return {
    ...surface,
    ...(surface.source_ranges.length < ranges.length
      ? { source_ranges_omitted: ranges.length - surface.source_ranges.length }
      : {}),
  };
}
