import path from "node:path";
import { canonicalEvidenceSourcePath } from "../../../shared/tools/functions/source-evidence.js";

export function evidenceSourcePathSyntaxError(value) {
  const raw = String(value || "");
  if (!raw || raw !== raw.trim()) return "evidence selector.path must be a non-empty trimmed path";
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    return "evidence selector.path must be repo-relative, not absolute";
  }
  if (/[\r\n\t]/.test(raw)) return "evidence selector.path must be a single-line path";
  const normalized = raw.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".."
    || normalized.split("/").some((segment) => segment === "." || segment === "..")) {
    return "evidence selector.path must not traverse directories";
  }
  return null;
}

export function canonicalSourcePath(value) {
  return evidenceSourcePathSyntaxError(value) ? null : canonicalEvidenceSourcePath(value);
}
