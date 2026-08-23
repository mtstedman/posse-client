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
