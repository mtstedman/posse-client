import { execFile, execFileSync } from "child_process";
import { promisify } from "util";

const MAX_FILES = 40;
const MAX_HUNKS_PER_FILE = 12;
const MAX_SIGNALS_PER_FILE = 8;
const MAX_NARRATIVE_CHARS = 12000;
const execFileAsync = promisify(execFile);

function git(cwd, args) {
  return execFileSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 15000,
    maxBuffer: 1024 * 1024 * 2,
  });
}

async function gitAsync(cwd, args) {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    encoding: "utf8",
    timeout: 15000,
    maxBuffer: 1024 * 1024 * 2,
    windowsHide: true,
  });
  return String(stdout || "");
}

function normalizePath(value) {
  return String(value || "").replace(/\\/g, "/").trim();
}

function diffArgs(commitHash, paths = [], extra = []) {
  return [
    "diff",
    ...extra,
    `${commitHash}^!`,
    "--",
    ...paths,
  ];
}

function parseNumstat(raw = "") {
  const map = new Map();
  for (const line of String(raw || "").split(/\r?\n/)) {
    const parts = line.split("\t");
    if (parts.length < 3) continue;
    const added = Number.parseInt(parts[0], 10);
    const deleted = Number.parseInt(parts[1], 10);
    const file = normalizePath(parts.slice(2).join("\t"));
    map.set(file, {
      added: Number.isFinite(added) ? added : null,
      deleted: Number.isFinite(deleted) ? deleted : null,
    });
  }
  return map;
}

function parseNameStatus(raw = "") {
  const files = [];
  for (const line of String(raw || "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    const parts = line.split("\t");
    const code = parts[0] || "";
    const status = code[0] || "?";
    const file = normalizePath(parts[parts.length - 1]);
    if (!file) continue;
    files.push({ status, code, file });
  }
  return files;
}

function changeKind(status) {
  if (status === "A") return "added";
  if (status === "D") return "deleted";
  if (status === "R") return "renamed";
  if (status === "C") return "copied";
  if (status === "M") return "modified";
  return "changed";
}

function shouldKeepSignal(line) {
  const text = String(line || "").trim();
  if (!text || text.length > 180) return false;
  if (/^[{}[\]);,]+$/.test(text)) return false;
  if (/^(?:\/\/|\/\*|\*|#)\s?/.test(text)) return false;
  return /(?:function|class|export|import|const|let|var|return|if|for|while|switch|case|throw|await|async|=>|=|\(|:)/.test(text);
}

function parseUnifiedDiff(raw = "") {
  const map = new Map();
  let current = null;
  for (const line of String(raw || "").split(/\r?\n/)) {
    const diffMatch = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (diffMatch) {
      current = normalizePath(diffMatch[2]);
      if (!map.has(current)) map.set(current, { hunks: [], addedSignals: [], removedSignals: [] });
      continue;
    }
    if (!current) continue;
    const entry = map.get(current);
    const hunk = /^@@\s+(.+?)\s+@@\s*(.*)$/.exec(line);
    if (hunk) {
      if (entry.hunks.length < MAX_HUNKS_PER_FILE) {
        entry.hunks.push({
          range: hunk[1],
          context: hunk[2] ? hunk[2].trim() : "",
        });
      }
      continue;
    }
    if (line.startsWith("+++") || line.startsWith("---")) continue;
    if (line.startsWith("+") && entry.addedSignals.length < MAX_SIGNALS_PER_FILE) {
      const signal = line.slice(1).trim();
      if (shouldKeepSignal(signal)) entry.addedSignals.push(signal);
    } else if (line.startsWith("-") && entry.removedSignals.length < MAX_SIGNALS_PER_FILE) {
      const signal = line.slice(1).trim();
      if (shouldKeepSignal(signal)) entry.removedSignals.push(signal);
    }
  }
  return map;
}

function compact(text, max = MAX_NARRATIVE_CHARS) {
  const value = String(text || "").trim();
  if (value.length <= max) return value;
  return `${value.slice(0, max)}\n...[diff narrative truncated]`;
}

function scopedNarrativePaths(paths) {
  return [...new Set((Array.isArray(paths) ? paths : []).map(normalizePath).filter(Boolean))].slice(0, MAX_FILES);
}

// Shared assembly for both twins: the sync/async pair differ only in how the
// four raw git outputs are gathered — everything downstream of the raw text
// (parsing, per-file shaping, totals, result shape) lives here once.
function assembleDiffNarrative(commit, { numstatRaw, nameStatusRaw, statRaw, unifiedRaw }) {
  const numstat = parseNumstat(numstatRaw);
  const nameStatus = parseNameStatus(nameStatusRaw);
  const stat = String(statRaw || "").trim();
  const unified = parseUnifiedDiff(unifiedRaw);
  const files = nameStatus.slice(0, MAX_FILES).map((entry) => {
    const counts = numstat.get(entry.file) || {};
    const detail = unified.get(entry.file) || { hunks: [], addedSignals: [], removedSignals: [] };
    return {
      file: entry.file,
      status: changeKind(entry.status),
      status_code: entry.code,
      added: counts.added ?? null,
      deleted: counts.deleted ?? null,
      hunks: detail.hunks,
      added_signals: detail.addedSignals,
      removed_signals: detail.removedSignals,
    };
  });
  const totalAdded = files.reduce((sum, file) => sum + (Number.isFinite(file.added) ? file.added : 0), 0);
  const totalDeleted = files.reduce((sum, file) => sum + (Number.isFinite(file.deleted) ? file.deleted : 0), 0);
  return {
    ok: true,
    commit_hash: commit,
    summary: `${files.length} file(s) changed, +${totalAdded}/-${totalDeleted}`,
    files,
    stat,
  };
}

function missingNarrativeInputResult() {
  return { ok: false, reason: "commitHash and paths are required", summary: "", files: [] };
}

function diffNarrativeFailure(err, commit, scopedPaths) {
  return {
    ok: false,
    reason: err?.message?.split("\n")[0] || String(err),
    commit_hash: commit,
    paths: scopedPaths,
    summary: "",
    files: [],
  };
}

export function buildDiffNarrative({
  cwd = process.cwd(),
  commitHash = "",
  paths = [],
} = {}) {
  const commit = String(commitHash || "").trim();
  const scopedPaths = scopedNarrativePaths(paths);
  if (!commit || scopedPaths.length === 0) return missingNarrativeInputResult();

  try {
    return assembleDiffNarrative(commit, {
      numstatRaw: git(cwd, diffArgs(commit, scopedPaths, ["--numstat"])),
      nameStatusRaw: git(cwd, diffArgs(commit, scopedPaths, ["--name-status"])),
      statRaw: git(cwd, diffArgs(commit, scopedPaths, ["--stat", "--summary"])),
      unifiedRaw: git(cwd, diffArgs(commit, scopedPaths, ["--unified=0"])),
    });
  } catch (err) {
    return diffNarrativeFailure(err, commit, scopedPaths);
  }
}

export async function buildDiffNarrativeAsync({
  cwd = process.cwd(),
  commitHash = "",
  paths = [],
} = {}) {
  const commit = String(commitHash || "").trim();
  const scopedPaths = scopedNarrativePaths(paths);
  if (!commit || scopedPaths.length === 0) return missingNarrativeInputResult();

  try {
    const [numstatRaw, nameStatusRaw, statRaw, unifiedRaw] = await Promise.all([
      gitAsync(cwd, diffArgs(commit, scopedPaths, ["--numstat"])),
      gitAsync(cwd, diffArgs(commit, scopedPaths, ["--name-status"])),
      gitAsync(cwd, diffArgs(commit, scopedPaths, ["--stat", "--summary"])),
      gitAsync(cwd, diffArgs(commit, scopedPaths, ["--unified=0"])),
    ]);
    return assembleDiffNarrative(commit, { numstatRaw, nameStatusRaw, statRaw, unifiedRaw });
  } catch (err) {
    return diffNarrativeFailure(err, commit, scopedPaths);
  }
}

export function formatDiffNarrative(narrative) {
  if (!narrative?.ok) return "";
  const lines = [
    `DIFF NARRATIVE: ${narrative.summary}`,
  ];
  for (const file of narrative.files || []) {
    const counts = file.added == null || file.deleted == null ? "" : ` (+${file.added}/-${file.deleted})`;
    lines.push(`- ${file.file}: ${file.status}${counts}`);
    const hunkContexts = (file.hunks || [])
      .map((hunk) => hunk.context)
      .filter(Boolean)
      .slice(0, 4);
    if (hunkContexts.length > 0) lines.push(`  touched: ${hunkContexts.join("; ")}`);
    if (file.added_signals?.length > 0) lines.push(`  added: ${file.added_signals.slice(0, 4).join(" | ")}`);
    if (file.removed_signals?.length > 0) lines.push(`  removed: ${file.removed_signals.slice(0, 4).join(" | ")}`);
  }
  if (narrative.stat) {
    lines.push("");
    lines.push("Diff stat:");
    lines.push(narrative.stat);
  }
  return compact(lines.join("\n"));
}

function narrativeInputsFromContext(assessmentContext) {
  return {
    commitHash: String(assessmentContext.commit_hash || "").trim(),
    paths: [
      ...(Array.isArray(assessmentContext.files_committed) ? assessmentContext.files_committed : []),
      ...(Array.isArray(assessmentContext.files_reverted) ? assessmentContext.files_reverted : []),
    ],
  };
}

function applyNarrativeToContext(assessmentContext, narrative) {
  const formatted = formatDiffNarrative(narrative);
  if (formatted) {
    assessmentContext.scoped_diff_narrative = formatted;
    assessmentContext.scoped_diff_narrative_json = narrative;
  }
  return assessmentContext;
}

export function attachDiffNarrative(assessmentContext = null, cwd = null) {
  if (!assessmentContext || typeof assessmentContext !== "object" || !cwd) return assessmentContext;
  const { commitHash, paths } = narrativeInputsFromContext(assessmentContext);
  return applyNarrativeToContext(assessmentContext, buildDiffNarrative({ cwd, commitHash, paths }));
}

export async function attachDiffNarrativeAsync(assessmentContext = null, cwd = null) {
  if (!assessmentContext || typeof assessmentContext !== "object" || !cwd) return assessmentContext;
  const { commitHash, paths } = narrativeInputsFromContext(assessmentContext);
  return applyNarrativeToContext(assessmentContext, await buildDiffNarrativeAsync({ cwd, commitHash, paths }));
}
