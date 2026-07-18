// ATLAS-backed file candidate discovery for explicit one-shot requests whose
// target cannot be resolved uniquely from the request text alone.

import path from "node:path";

import { extractJson } from "../../../shared/format/functions/json.js";
import { gitExec } from "../../git/functions/utils.js";
import { executeEmbeddedAtlasTool } from "../../integrations/functions/atlas-embedded.js";
import {
  atlasResultData,
  atlasResultField,
} from "../../atlas/functions/v2/contracts/tool-results.js";
import {
  normalizeCandidatePath,
  oneshotTargetRisk,
} from "./oneshot-policy.js";

const DEFAULT_MAX_CANDIDATES = 10;
const ATLAS_SCOPE_POOL_SIZE = 30;

function clampCandidateLimit(value) {
  return Math.max(1, Math.min(DEFAULT_MAX_CANDIDATES, Number(value) || DEFAULT_MAX_CANDIDATES));
}

function trackedFileMap(projectDir) {
  const raw = gitExec(["ls-files", "-z"], projectDir, { trim: false, timeoutMs: 30_000 });
  const tracked = new Map();
  for (const value of String(raw || "").split("\0")) {
    const normalized = normalizeCandidatePath(value);
    if (!normalized) continue;
    const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
    tracked.set(key, normalized);
  }
  return tracked;
}

function canonicalSafeTrackedPath(value, tracked) {
  const normalized = normalizeCandidatePath(value);
  if (!normalized || path.isAbsolute(normalized) || normalized.split("/").includes("..")) return null;
  const key = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const canonical = tracked.get(key);
  if (!canonical || oneshotTargetRisk(canonical)) return null;
  return canonical;
}

function normalizeReasons(value) {
  return (Array.isArray(value) ? value : [])
    .map((reason) => String(reason || "").trim())
    .filter(Boolean)
    .slice(0, 4);
}

function addCandidate(out, seen, tracked, entry, source) {
  if (!entry || entry.generated === true || entry.config === true) return;
  const rawPath = typeof entry === "string" ? entry : (entry.path || entry.file);
  const file = canonicalSafeTrackedPath(rawPath, tracked);
  if (!file) return;
  const key = process.platform === "win32" ? file.toLowerCase() : file;
  if (seen.has(key)) return;
  seen.add(key);
  out.push({
    file,
    source,
    score: Number.isFinite(Number(entry.score)) ? Number(entry.score) : null,
    reasons: normalizeReasons(entry.reasons),
    matched_tokens: normalizeReasons(entry.matched_tokens),
  });
}

function atlasErrorMessage(raw, parsed, data) {
  if (String(raw || "").startsWith("Error:")) return String(raw).slice(0, 300);
  if (!parsed) return "ATLAS returned a non-JSON tree.scope response.";
  if (data?.available === false) return String(data.reason || "tree.scope unavailable").slice(0, 300);
  return null;
}

export async function resolveOneshotScopeCandidates({
  projectDir,
  taskText,
  lexicalCandidates = [],
  maxCandidates = DEFAULT_MAX_CANDIDATES,
  executeAtlasTool = executeEmbeddedAtlasTool,
} = {}) {
  const limit = clampCandidateLimit(maxCandidates);
  let tracked;
  try {
    tracked = trackedFileMap(projectDir);
  } catch (err) {
    return {
      candidates: [],
      atlas_ok: false,
      atlas_error: `Tracked-file lookup failed: ${err?.message || err}`.slice(0, 300),
    };
  }

  let atlasEntries = [];
  let atlasError = null;
  try {
    const raw = await executeAtlasTool("tree.scope", {
      taskText: String(taskText || "").trim(),
      paths: [],
      maxFiles: ATLAS_SCOPE_POOL_SIZE,
    }, {
      cwd: projectDir,
      origin: "prefetch",
    });
    const parsed = extractJson(String(raw || ""));
    const data = parsed ? atlasResultData("tree.scope", parsed) : null;
    atlasError = atlasErrorMessage(raw, parsed, data);
    const rawEntries = parsed ? atlasResultField("tree.scope", parsed, "candidateFiles") : null;
    if (!atlasError && Array.isArray(rawEntries)) atlasEntries = rawEntries;
  } catch (err) {
    atlasError = String(err?.message || err).slice(0, 300);
  }

  const candidates = [];
  const seen = new Set();
  for (const entry of atlasEntries) {
    addCandidate(candidates, seen, tracked, entry, "atlas");
    if (candidates.length >= limit) break;
  }
  for (const entry of Array.isArray(lexicalCandidates) ? lexicalCandidates : []) {
    if (candidates.length >= limit) break;
    addCandidate(candidates, seen, tracked, entry, "lexical");
  }

  return {
    candidates,
    atlas_ok: !atlasError,
    atlas_error: atlasError,
  };
}

export function formatOneshotScopeSelection({ candidates = [], atlasError = null } = {}) {
  const rows = (Array.isArray(candidates) ? candidates : []).slice(0, DEFAULT_MAX_CANDIDATES);
  const lines = rows.map((entry, index) => {
    const details = entry.source === "atlas" ? "ATLAS semantic match" : "filename match";
    return `${index + 1}. ${entry.file} (${details})`;
  });
  if (lines.length === 0) {
    lines.push("No safe tracked candidate was inferred.");
  }
  if (atlasError) lines.push(`ATLAS fallback note: ${atlasError}`);
  return {
    question: rows.length > 0
      ? `Which file should this one-shot edit? Enter 1-${rows.length}, an exact listed path, "plan", or "cancel".`
      : "No safe one-shot file was inferred. Enter \"plan\" to use the planned flow or \"cancel\".",
    context: [
      "Posse inferred these candidates from the task semantics and tracked repository tree:",
      "",
      ...lines,
      "",
      "Choosing a file skips research and planning. Entering \"plan\" explicitly opts into the planned flow.",
    ].join("\n"),
  };
}

export function parseOneshotScopeSelection(answer, candidates = []) {
  const text = String(answer || "").trim();
  const lower = text.toLowerCase();
  if (!text || lower === "(skipped)") return { action: "unknown", file: null };
  if (/^(?:use\s+)?plan(?:ning)?\b/i.test(text)) return { action: "plan", file: null };
  if (/^(?:cancel|stop|abort|none)\b/i.test(text)) return { action: "cancel", file: null };

  const rows = (Array.isArray(candidates) ? candidates : [])
    .map((entry) => typeof entry === "string" ? { file: entry } : entry)
    .filter((entry) => entry?.file);
  const numbered = text.match(/^(?:option|file)?\s*#?(\d+)\b/i);
  if (numbered) {
    const index = Number(numbered[1]) - 1;
    if (index >= 0 && index < rows.length) return { action: "select", file: rows[index].file };
    return { action: "unknown", file: null };
  }

  const unquoted = text.replace(/^['"`]([^'"`]+)['"`]$/, "$1");
  const normalized = normalizeCandidatePath(unquoted);
  const exact = rows.find((entry) => {
    const candidate = normalizeCandidatePath(entry.file);
    return process.platform === "win32"
      ? candidate.toLowerCase() === normalized.toLowerCase()
      : candidate === normalized;
  });
  return exact
    ? { action: "select", file: exact.file }
    : { action: "unknown", file: null };
}
