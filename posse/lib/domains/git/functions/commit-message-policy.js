import fs from "node:fs";
import path from "node:path";

import { getSetting } from "../../queue/functions/index.js";
import { SECRET_PATTERNS } from "../../../shared/telemetry/functions/logging/secret-patterns.js";
import { gitExec } from "./utils.js";

const COMMIT_STYLES = new Set(["off", "conventional", "gitmoji"]);
const COMMIT_TYPES = new Set([
  "build",
  "chore",
  "ci",
  "docs",
  "feat",
  "fix",
  "perf",
  "refactor",
  "revert",
  "style",
  "test",
]);
const MAX_CLASSIFIER_DIFF_CHARS = 160_000;
const MAX_UNTRACKED_FILE_BYTES = 64_000;

export function getGitCommitStyle(projectDir = null) {
  try {
    const raw = getSetting("git_commit_style", { projectDir });
    const normalized = String(raw || "").trim().toLowerCase();
    return COMMIT_STYLES.has(normalized) ? normalized : "off";
  } catch {
    return "off";
  }
}

function normalizedPathspecs(scope = null) {
  const values = [
    ...(scope?.modifyFiles || []),
    ...(scope?.createFiles || []),
    ...(scope?.deleteFiles || []),
    ...(scope?.createRoots || []),
  ];
  const normalized = [...new Set(values
    .map((value) => String(value || "").replace(/\\/g, "/").replace(/^\.\//, "").trim())
    .filter(Boolean)
    .map((value) => value === "*" ? "." : value))];
  return normalized.length > 0 ? normalized : ["."];
}

function trackedPatch(cwd, pathspecs, nativeParity) {
  try {
    return gitExec(
      ["diff", "--binary", "--no-ext-diff", "--no-renames", "HEAD", "--", ...pathspecs],
      cwd,
      { trim: false, nativeParity },
    );
  } catch {
    // An unborn branch has no HEAD. Its staged patch is relative to the empty
    // tree, while new unstaged files are included below.
    try {
      return gitExec(
        ["diff", "--cached", "--binary", "--no-ext-diff", "--no-renames", "--", ...pathspecs],
        cwd,
        { trim: false, nativeParity },
      );
    } catch {
      return "";
    }
  }
}

function trackedPaths(cwd, pathspecs, nativeParity) {
  try {
    return gitExec(
      ["diff", "--name-only", "--no-ext-diff", "--no-renames", "HEAD", "--", ...pathspecs],
      cwd,
      { trim: false, nativeParity },
    ).split(/\r?\n/).filter(Boolean);
  } catch {
    try {
      return gitExec(
        ["diff", "--cached", "--name-only", "--no-ext-diff", "--no-renames", "--", ...pathspecs],
        cwd,
        { trim: false, nativeParity },
      ).split(/\r?\n/).filter(Boolean);
    } catch {
      return [];
    }
  }
}

function redactPotentialSecrets(patch) {
  return String(patch || "").split(/\r?\n/).map((line) => {
    for (const { re, label } of SECRET_PATTERNS) {
      re.lastIndex = 0;
      if (re.test(line)) return "[redacted potential " + label + "]";
    }
    return line;
  }).join("\n");
}

function safeUntrackedPath(cwd, relativePath) {
  const root = path.resolve(cwd);
  const absolute = path.resolve(root, relativePath);
  if (absolute === root || !absolute.startsWith(root + path.sep)) return null;
  return absolute;
}

function untrackedPatch(cwd, relativePath) {
  const absolute = safeUntrackedPath(cwd, relativePath);
  if (!absolute) return "";
  let stat;
  try {
    stat = fs.lstatSync(absolute);
  } catch {
    return "";
  }
  const header = [
    "diff --git a/" + relativePath + " b/" + relativePath,
    "new file mode",
    "--- /dev/null",
    "+++ b/" + relativePath,
  ];
  if (stat.isSymbolicLink()) {
    let target = "";
    try { target = fs.readlinkSync(absolute); } catch { target = "<unreadable>"; }
    return [...header, "@@ symbolic link @@", "+" + target, ""].join("\n");
  }
  if (!stat.isFile()) return "";
  const size = Math.min(stat.size, MAX_UNTRACKED_FILE_BYTES);
  const handle = fs.openSync(absolute, "r");
  const buffer = Buffer.alloc(size);
  try {
    fs.readSync(handle, buffer, 0, size, 0);
  } finally {
    fs.closeSync(handle);
  }
  if (buffer.includes(0)) {
    return [...header, "Binary file (" + stat.size + " bytes)", ""].join("\n");
  }
  const lines = buffer.toString("utf8").split(/\r?\n/).map((line) => "+" + line);
  if (stat.size > size) lines.push("+[truncated after " + size + " bytes]");
  return [...header, "@@ untracked file @@", ...lines, ""].join("\n");
}

export function collectScopedCommitDiff(cwd, scope = null, { nativeParity = {} } = {}) {
  const pathspecs = normalizedPathspecs(scope);
  let patch = trackedPatch(cwd, pathspecs, nativeParity);
  const changedPaths = trackedPaths(cwd, pathspecs, nativeParity);
  let untracked = [];
  try {
    untracked = gitExec(
      ["ls-files", "-z", "--others", "--exclude-standard", "--", ...pathspecs],
      cwd,
      { trim: false, nativeParity },
    ).split("\0").filter(Boolean);
  } catch {
    untracked = [];
  }
  for (const relativePath of untracked) {
    changedPaths.push(relativePath);
    const addition = untrackedPatch(cwd, relativePath);
    if (addition) patch += (patch && !patch.endsWith("\n") ? "\n" : "") + addition;
    if (patch.length >= MAX_CLASSIFIER_DIFF_CHARS) break;
  }
  const truncated = patch.length > MAX_CLASSIFIER_DIFF_CHARS;
  if (truncated) {
    patch = patch.slice(0, MAX_CLASSIFIER_DIFF_CHARS)
      + "\n[diff truncated for commit classification]\n";
  }
  return {
    diff: redactPotentialSecrets(patch),
    paths: [...new Set(changedPaths)],
    truncated,
  };
}

function classifierPrompt({ originalMessage, diff, truncated }) {
  return [
    "Classify this completed scoped git diff for its final commit subject.",
    "Return exactly one JSON object and no prose or markdown:",
    '{"type":"feat","scope":"git","summary":"surface conventional commit policy","breaking":false}',
    "",
    "type must be one of: " + [...COMMIT_TYPES].join(", ") + ".",
    "scope must be null or a lowercase canonical token up to 32 bytes using letters, digits, dot, underscore, slash, or hyphen.",
    "summary must be a concise, user-readable imperative description of the primary change, without a type prefix or final period.",
    "Set breaking=true only when the diff intentionally breaks a public API or compatibility contract.",
    "Base the answer only on the supplied message and diff.",
    "",
    "Original message: " + String(originalMessage || "").split(/\r?\n/, 1)[0],
    "Diff" + (truncated ? " (truncated)" : "") + ":",
    "BEGIN DIFF",
    diff,
    "END DIFF",
  ].join("\n");
}

function normalizeClassification(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("assessor commit classification must be a JSON object");
  }
  const type = String(value.type || "").trim().toLowerCase();
  if (!COMMIT_TYPES.has(type)) {
    throw new Error(
      'assessor returned unsupported Conventional Commit type "' + (type || "<empty>") + '"',
    );
  }
  const scope = value.scope == null || String(value.scope).trim() === ""
    ? null
    : String(value.scope).trim();
  if (
    scope != null
    && (
      Buffer.byteLength(scope, "utf8") > 32
      || !/^[a-z0-9](?:[a-z0-9._/-]*[a-z0-9])?$/.test(scope)
    )
  ) {
    throw new Error("assessor returned an invalid Conventional Commit scope");
  }
  const summary = String(value.summary || "").trim();
  if (
    !summary
    || /[\r\n]/.test(summary)
    || [...summary].some((character) => /[\u0000-\u001f\u007f]/.test(character))
  ) {
    throw new Error("assessor returned an invalid commit summary");
  }
  if (typeof value.breaking !== "boolean") {
    throw new Error("assessor commit classification must include boolean breaking");
  }
  return { type, scope, summary, breaking: value.breaking };
}

export async function classifyScopedCommit({
  style,
  originalMessage,
  diff,
  truncated = false,
  cwd,
  providerResolver = null,
} = {}) {
  const normalizedStyle = String(style || "").trim().toLowerCase();
  if (normalizedStyle === "off") return null;
  if (!COMMIT_STYLES.has(normalizedStyle)) {
    throw new Error('unsupported git commit style "' + normalizedStyle + '"');
  }
  if (!String(diff || "").trim()) {
    throw new Error("cannot classify an empty scoped git diff");
  }
  const resolveProvider = providerResolver || (async () => {
    const { getProvider } = await import("../../providers/functions/provider.js");
    return getProvider("assessor");
  });
  const provider = await resolveProvider("assessor");
  const result = await provider.callProvider(classifierPrompt({
    originalMessage,
    diff,
    truncated,
  }), {
    role: "assessor",
    modelTier: "standard",
    reasoningEffort: "low",
    activity: "git commit classification",
    silent: true,
    allowWrite: false,
    autoApprove: true,
    maxTurns: 1,
    cwd,
    disableAtlas: true,
    skipRolePrompt: true,
  });
  const parsed = provider.extractJson
    ? provider.extractJson(result?.output || "")
    : JSON.parse(String(result?.output || ""));
  return {
    style: normalizedStyle,
    classification: normalizeClassification(parsed),
  };
}

export const __testCommitMessagePolicy = Object.freeze({
  COMMIT_TYPES,
  MAX_CLASSIFIER_DIFF_CHARS,
  normalizeClassification,
});
