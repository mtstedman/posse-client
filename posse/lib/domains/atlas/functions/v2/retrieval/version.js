// @ts-check

export function cleanBranchName(value) {
  const text = String(value || "").trim();
  return /^[A-Za-z0-9._/@-]+$/.test(text) ? text : "";
}

export function branchFromVersion(versionId, fallback = "main") {
  const text = String(versionId || "").trim();
  const idx = text.lastIndexOf("@");
  if (idx <= 0) return fallback;
  return cleanBranchName(text.slice(0, idx)) || fallback;
}
