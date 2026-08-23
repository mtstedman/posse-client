import path from "path";
import { runGitNativeMethodAsync } from "./native/invoke.js";
import { normalizeDisplaySlashes } from "../../../shared/format/functions/display-paths.js";

const SAFE_DIFF_REF_TOKEN_RE = /^(?!-)[A-Za-z0-9][A-Za-z0-9._/@{}~^+-]*$/;

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
      path: { type: "string", minLength: 1, description: "Optional file path filter. Required for blame." },
      ref: { type: "string", description: "Optional git ref/revision selector (e.g. HEAD~5). For diff, two safe refs separated by whitespace are normalized to A..B." },
      limit: { type: "integer", description: "log-only result cap. Default: 20, max: 100." },
      since: { type: "string", description: "log-only --since value (e.g. 2025-01-01)." },
      author: { type: "string", description: "log-only --author filter." },
      grep: { type: "string", description: "log-only --grep commit-message filter." },
    },
    required: ["op"],
    allOf: [{
      if: {
        properties: { op: { const: "blame" } },
        required: ["op"],
      },
      then: { required: ["path"] },
    }],
    additionalProperties: false,
  },
};

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

function normalizeHistoryRef(op, value) {
  if (op !== "diff" || typeof value !== "string") return value;
  const parts = value.trim().split(/\s+/);
  if (parts.length !== 2 || !parts.every((part) => SAFE_DIFF_REF_TOKEN_RE.test(part))) return value;
  return `${parts[0]}..${parts[1]}`;
}

export function createGitHistoryExecutor(safePath, { nativeParity = {} } = {}) {
  if (typeof safePath !== "function") {
    throw new Error("createGitHistoryExecutor requires a safePath function");
  }

  return async function execGitHistory(args = {}, cwd, scopePredicates) {
    if (!args || typeof args !== "object") return "Error: git_history requires an argument object.";
    const op = String(args.op || "").trim();

    let relPath = null;
    if (args.path != null) {
      if (typeof args.path !== "string" || !args.path.trim()) return "Error: path must be a non-empty string.";
      try {
        relPath = normalizeDisplaySlashes(path.relative(cwd, safePath(cwd, args.path, scopePredicates)));
      } catch (err) {
        return `Error: ${err.message}`;
      }
    }
    if (op === "blame" && !relPath) return "Error: path is required for git_history blame.";

    const scopeLists = scopeListsFromPredicates(scopePredicates);
    const nativePayload = {
      cwd,
      op,
      path: relPath || null,
      ref: normalizeHistoryRef(op, args.ref) ?? null,
      limit: args.limit ?? null,
      since: args.since ?? null,
      author: args.author ?? null,
      grep: args.grep ?? null,
      scopeFiles: scopeLists.scopeFiles,
      scopeRoots: scopeLists.scopeRoots,
    };

    try {
      return await runGitNativeMethodAsync("git.history", nativePayload, nativeParity);
    } catch (err) {
      const msg = String(err?.stderr || err?.message || err || "unknown git error").trim();
      return `Error: git_history failed - ${msg || "unknown git error"}`;
    }
  };
}
