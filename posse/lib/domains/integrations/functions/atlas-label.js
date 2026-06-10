// @ts-check

export function isAtlasV2Attachment(value = {}) {
  const attachment = /** @type {Record<string, unknown>} */ (
    value && typeof value === "object" ? value : {}
  );
  if (attachment.atlasV2Enabled === true) return true;
  const candidates = [
    attachment.backend,
    attachment.method,
    attachment.atlasVersion,
    attachment.atlas_v2,
    attachment.atlasV2Mode,
  ];
  return candidates
    .map((entry) => String(entry || "").trim().toLowerCase())
    .some((entry) => entry === "v2" || entry === "atlas-v2" || entry === "atlas_v2" || entry === "atlasv2");
}

export function atlasBackendLabel(value = {}) {
  return isAtlasV2Attachment(value) ? "ATLASv2" : "ATLAS";
}

export function formatAtlasBackendText(text, value = {}) {
  const label = typeof value === "string" ? value : atlasBackendLabel(value);
  return String(text || "")
    .replace(/\bATLAS\/Iris\b/g, label)
    .replace(/\bATLAS\b/g, label);
}
