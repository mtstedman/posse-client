import path from "path";
import { runGitNativeMethod } from "./native/invoke.js";

export const TOOL_GIT_HISTORY = {
  type: "function",
  name: "git_history",
  description:
    "Inspect git history deterministically (log, show, blame, diff) " +
    "without shell access.",
  parameters: {
    type: "object",
    properties: {
      op: {
        type: "string",
        enum: ["log", "show", "blame", "diff"],
        description: "Git history operation to run.",
      },
      path: { type: "string", description: "Optional file path filter. Required for blame." },
      ref: { type: "string", description: "Optional git ref/revision selector (e.g. HEAD~5)." },
      limit: { type: "integer", description: "log-only result cap. Default: 20, max: 100." },
      since: { type: "string", description: "log-only --since value (e.g. 2025-01-01)." },
      author: { type: "string", description: "log-only --author filter." },
      grep: { type: "string", description: "log-only --grep commit-message filter." },
    },
    required: ["op"],
    additionalProperties: false,
  },
};

function normalizeRelativePath(cwd, safeAbsPath) {
  const rel = path.relative(cwd, safeAbsPath);
  return rel.replace(/\\/g, "/");
}

function scopeListsFromPredicates(scopePredicates) {
  const scope = scopePredicates?.policy?.scope;
  if (!scope || typeof scope !== "object") return { scopeFiles: [], scopeRoots: [] };
  return {
    scopeFiles: [
      ...new Set([
        ...(Array.isArray(scope.modifyFiles) ? scope.modifyFiles : []),
        ...(Array.isArray(scope.createFiles) ? scope.createFiles : []),
        ...(Array.isArray(scope.deleteFiles) ? scope.deleteFiles : []),
      ].map((value) => String(value || "").replace(/\\/g, "/")).filter(Boolean)),
    ],
    scopeRoots: [
      ...new Set((Array.isArray(scope.createRoots) ? scope.createRoots : [])
        .map((value) => String(value || "").replace(/\\/g, "/"))
        .filter(Boolean)),
    ],
  };
}

export function createGitHistoryExecutor(safePath, { nativeParity = {} } = {}) {
  if (typeof safePath !== "function") {
    throw new Error("createGitHistoryExecutor requires a safePath function");
  }

  return function execGitHistory(args = {}, cwd, scopePredicates) {
    if (!args || typeof args !== "object") return "Error: git_history requires an argument object.";
    const op = String(args.op || "").trim();

    let relPath = null;
    if (args.path != null) {
      if (typeof args.path !== "string" || !args.path.trim()) return "Error: path must be a non-empty string.";
      try {
        relPath = normalizeRelativePath(cwd, safePath(cwd, args.path, scopePredicates));
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }

    const scopeLists = scopeListsFromPredicates(scopePredicates);
    const nativePayload = {
      cwd,
      op,
      path: relPath || null,
      ref: args.ref ?? null,
      limit: args.limit ?? null,
      since: args.since ?? null,
      author: args.author ?? null,
      grep: args.grep ?? null,
      scopeFiles: scopeLists.scopeFiles,
      scopeRoots: scopeLists.scopeRoots,
    };

    try {
      return runGitNativeMethod("git.history", nativePayload, nativeParity);
    } catch (err) {
      const msg = String(err?.stderr || err?.message || err || "unknown git error").trim();
      return `Error: git_history failed - ${msg || "unknown git error"}`;
    }
  };
}
