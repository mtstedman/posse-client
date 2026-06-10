import path from "path";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { getEvents, getSetting } from "../../../queue/functions/index.js";
import { validateMutableRepoPath } from "../../../runtime/functions/protected-paths.js";

export function getAssessmentInternalRetryLimit() {
  try {
    const raw = getSetting(SETTING_KEYS.ASSESSOR_INTERNAL_RETRY_LIMIT);
    if (raw == null || raw === "") return 2;
    const parsed = Number.parseInt(String(raw), 10);
    return Number.isFinite(parsed) ? Math.max(0, parsed) : 2;
  } catch {
    return 2;
  }
}

export function countInternalAssessmentRetries(jobId) {
  try {
    return getEvents(jobId, 100).filter((e) => e.event_type === "job.assessment_internal_retry").length;
  } catch {
    return 0;
  }
}

export function validateScopedPath(value, label) {
  if (typeof value !== "string") return `${label} must be a string`;
  const raw = value;
  const trimmed = raw.trim();
  if (!trimmed) return `${label} must not be empty`;
  if (trimmed !== raw) return `${label} must not have leading/trailing whitespace`;
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return `${label} must be repo-relative, not absolute`;
  }
  if (/[\r\n\t]/.test(trimmed)) return `${label} must be a single-line path`;
  if (/[<>"`]/.test(trimmed)) return `${label} contains invalid filename characters`;
  if (/[?*|]/.test(trimmed)) return `${label} contains invalid filename characters`;
  if (/[\\/]$/.test(trimmed)) return `${label} must reference a file path, not a directory`;

  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === "..") {
    return `${label} must reference a file path`;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `${label} must not traverse directories`;
  }
  const protectedErr = validateMutableRepoPath(normalized, label);
  if (protectedErr) return protectedErr;
  return null;
}
