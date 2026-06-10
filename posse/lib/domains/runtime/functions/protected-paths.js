// lib/runtime/protected-paths.js
//
import path from "path";

// Central policy for repo-relative paths that agents must not mutate even when
// a planner, assessor, or file-request block puts them in nominal write scope.

export function normalizeRepoRelativePath(value) {
  const normalized = String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/\/+/g, "/");
  return normalized.replace(/\/+$/, "");
}

function pathParts(normalized) {
  return normalized.split("/").filter(Boolean);
}

const POSSE_ROLE_PROMPT_FILES = new Set([
  "artificer.md",
  "assessor.md",
  "delegator.md",
  "dev.md",
  "planner.md",
  "preflight.md",
  "researcher.md",
]);

export function protectedMutablePathReason(value, {
  allowRuntimeResources = true,
} = {}) {
  const normalized = normalizeRepoRelativePath(value);
  if (!normalized) return null;
  const lowered = normalized.toLowerCase();
  const parts = pathParts(lowered);
  const first = parts[0] || "";

  if (first === ".git") return ".git internals are protected";
  if (first === ".posse-worktrees") return "worktree runtime internals are protected";
  if (first === ".posse-test-suites") return "Posse test suite internals are protected";
  if (parts.includes("node_modules")) return "dependency directories are protected";

  if (first === ".posse") {
    if (allowRuntimeResources && parts[1] === "resources" && parts.length > 2) return null;
    return "Posse runtime state is protected";
  }

  if (first === "prompts") {
    const second = parts[1] || "";
    if (second === "contracts" || second === "skills" || (parts.length === 2 && POSSE_ROLE_PROMPT_FILES.has(second))) {
      return "Posse agent prompts and role contracts are protected";
    }
  }

  return null;
}

export function isProtectedMutablePath(value, opts = {}) {
  return !!protectedMutablePathReason(value, opts);
}

export function validateMutableRepoPath(value, label = "path", opts = {}) {
  const reason = protectedMutablePathReason(value, opts);
  return reason ? `${label} is protected: ${reason}` : null;
}

export function relativePathFromCwd(cwd, fullPath) {
  if (!cwd || !fullPath) return "";
  try {
    return normalizeRepoRelativePath(path.relative(cwd, fullPath));
  } catch {
    return "";
  }
}
