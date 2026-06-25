import path from "path";

import { validateMutableRepoPath } from "../../../domains/runtime/functions/protected-paths.js";

export function validateScopedPath(value, label) {
  if (typeof value !== "string") return `${label} must be a string`;
  const raw = value;
  const trimmed = raw.trim();
  if (!trimmed) return `${label} must not be empty`;
  if (trimmed !== raw) return `${label} must not have leading/trailing whitespace`;
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
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

export function validateCreateRootPath(value, label) {
  if (typeof value !== "string") return `${label} must be a string`;
  const raw = value;
  const trimmed = raw.trim();
  if (!trimmed) return `${label} must not be empty`;
  if (trimmed !== raw) return `${label} must not have leading/trailing whitespace`;
  if (trimmed === "*" || trimmed === "." || trimmed === "./" || trimmed === ".\\") {
    return `${label} must not grant repo-wide write scope`;
  }
  if (path.isAbsolute(trimmed) || /^[A-Za-z]:/.test(trimmed)) {
    return `${label} must be repo-relative, not absolute`;
  }
  if (/[\r\n\t]/.test(trimmed)) return `${label} must be a single-line path`;
  if (/[<>"`?*|]/.test(trimmed)) return `${label} contains invalid filename characters`;

  const normalized = trimmed.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
  if (!normalized || normalized === "." || normalized === "..") {
    return `${label} must reference a directory below the repo root`;
  }
  const segments = normalized.split("/").filter(Boolean);
  if (segments.some((segment) => segment === "." || segment === "..")) {
    return `${label} must not traverse directories`;
  }
  const protectedErr = validateMutableRepoPath(normalized, label);
  if (protectedErr) return protectedErr;
  return null;
}
