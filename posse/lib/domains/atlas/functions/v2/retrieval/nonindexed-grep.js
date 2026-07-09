// @ts-check
//
// Best-effort grep sidecar over NON-INDEXED config/data files for symbol.search.
//
// ATLAS's structural index only covers source languages (see the language
// registry / language-buckets). Load-bearing config and data files — .sql
// migrations, docs/specs/*.json, YAML/TOML config — are invisible to
// symbol.search because indexing is extension-gated to those languages. This
// module runs a bounded ripgrep pass over the COMPLEMENT of the indexed
// extension set (intersected with a curated config/data allowlist) so those
// files can still surface next to the symbol hits.
//
// Everything here is defensive: a missing rg binary, a timeout, a spawn error,
// or any parse problem returns null. It must never throw and never block the
// search it augments.

import { execFileSync } from "child_process";
import { EXT_TO_LANG } from "../parse/language-buckets.js";
import { resolveRipgrepCommand } from "../../../../../shared/tools/functions/toolkit/ripgrep.js";

// Curated config/data extensions. Each is intersected against the indexed
// extension set below so an entry that a language actually owns is dropped —
// guaranteeing we never grep a source language (py/js/ts/go/rust/c/cpp/...).
const CURATED_EXTS = Object.freeze([
  ".sql", ".json", ".yaml", ".yml", ".toml", ".ini",
  ".conf", ".cfg", ".env", ".properties", ".xml", ".tf", ".gradle",
]);
// Extension-less config filenames worth scanning.
const CURATED_FILENAMES = Object.freeze(["crontab"]);
// Never scan lockfiles / minified data blobs — huge, generated, low signal.
const EXCLUDE_GLOBS = Object.freeze([
  "*-lock.json", "package-lock.json", "composer.lock", "*.min.json",
]);

const MAX_TERMS = 12;
const RG_TIMEOUT_MS = 3000;
const RG_MAX_BUFFER = 8 * 1024 * 1024;
const RG_MAX_FILESIZE = "2M";
const MATCH_TEXT_CAP = 400;

/**
 * Curated extensions that are NOT owned by an indexed language. This is the
 * COMPLEMENT guarantee: anything language-buckets maps to a source language is
 * filtered out here, so the allowlist can only ever target non-indexed files.
 *
 * @returns {string[]}
 */
export function nonIndexedAllowlistExts() {
  return CURATED_EXTS.filter((ext) => !EXT_TO_LANG[ext]);
}

/**
 * @returns {string[]} ripgrep `-g` glob arguments (allowlist then exclusions).
 */
function buildGlobArgs() {
  /** @type {string[]} */
  const args = [];
  for (const ext of nonIndexedAllowlistExts()) {
    // Basename glob → matches the extension at any directory depth.
    args.push("-g", `*${ext}`);
    // `.env` / `.gradle` etc. as leading-dot dotfiles are not caught by `*.ext`.
    if (ext === ".env") args.push("-g", ".env", "-g", ".env.*");
  }
  for (const name of CURATED_FILENAMES) args.push("-g", name);
  for (const ex of EXCLUDE_GLOBS) args.push("-g", `!${ex}`);
  return args;
}

/**
 * ripgrep globs covering INDEXED source extensions — the complement of
 * {@link buildGlobArgs}. Used by the identifier-miss rescue: when a search
 * term has no identifier-space hit, the term may still live in source as a
 * string literal or dynamic dispatch key, which the symbol index never
 * tokenizes (body_identifiers is an identifier bag).
 *
 * @returns {string[]}
 */
function buildIndexedSourceGlobArgs() {
  /** @type {string[]} */
  const args = [];
  for (const ext of Object.keys(EXT_TO_LANG)) args.push("-g", `*${ext}`);
  for (const ex of EXCLUDE_GLOBS) args.push("-g", `!${ex}`);
  args.push("-g", "!*.min.js", "-g", "!node_modules/**", "-g", "!vendor/**");
  return args;
}

/**
 * Identifier-miss rescue: grep INDEXED source for terms the symbol index has
 * no identifier for. Same bounded runner and scoring as the non-indexed
 * sidecar, different glob set and matchKind. Best-effort; never throws.
 *
 * @param {{ repoRoot: string, terms: string[], maxTotal?: number }} args
 */
export function grepIndexedSource({ repoRoot, terms, maxTotal = 20 }) {
  return grepNonIndexed({
    repoRoot,
    terms,
    maxTotal,
    maxPerFile: 3,
    maxFilesScanned: 120,
    globArgs: buildIndexedSourceGlobArgs(),
    matchKind: "grep-source-text",
  });
}

/**
 * @param {unknown} terms
 * @returns {string[]}
 */
function normalizeTerms(terms) {
  const out = [];
  const seen = new Set();
  for (const raw of Array.isArray(terms) ? terms : []) {
    const term = String(raw == null ? "" : raw).trim();
    if (term.length < 3) continue;
    const key = term.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(term);
    if (out.length >= MAX_TERMS) break;
  }
  return out;
}

/**
 * @param {string | undefined} text
 * @returns {string}
 */
function firstLineOf(text) {
  return String(text ?? "").replace(/\r?\n$/, "").split(/\r?\n/)[0] ?? "";
}

/**
 * Grep NON-INDEXED config/data files for any of `terms` (OR'd). Returns the
 * capped matches, or null on any failure. Never throws.
 *
 * @param {{
 *   repoRoot: string,
 *   terms: string[],
 *   maxFilesScanned?: number,
 *   maxPerFile?: number,
 *   maxTotal?: number,
 *   maxMatchesScanned?: number,
 *   cursor?: string | number | null,
 *   offset?: number,
 * }} args
 * @returns {{ matches: Array<{ path: string, line: number, text: string, matchKind: "grep-nonindexed", score: number, scoreSignals: Record<string, unknown> }>, truncated: boolean, filesMatched: number, nextCursor: string | null, offset: number, totalCollected: number } | null}
 */
export function grepNonIndexed({
  repoRoot,
  terms,
  maxFilesScanned = 200,
  maxPerFile = 5,
  maxTotal = 40,
  maxMatchesScanned,
  cursor = null,
  offset,
  globArgs = null,
  matchKind = /** @type {"grep-nonindexed" | "grep-source-text"} */ ("grep-nonindexed"),
}) {
  try {
    if (!repoRoot || typeof repoRoot !== "string") return null;
    const searchTerms = normalizeTerms(terms);
    if (searchTerms.length === 0) return null;
    const pageSize = Math.max(1, Number(maxTotal) || 40);
    const startOffset = normalizeOffset(offset ?? cursor);
    const requestedScanCap = Number(maxMatchesScanned);
    const scanCap = Number.isFinite(requestedScanCap) && requestedScanCap > 0
      ? requestedScanCap
      : Math.min(Math.max(1, maxFilesScanned) * Math.max(1, maxPerFile), 400);
    const collectLimit = Math.max(startOffset + pageSize + 1, scanCap);

    const command = resolveRipgrepCommand();
    const rgArgs = [
      "--json",
      "--ignore-case",
      // Literal identifier/keyword matching: no regex-metachar surprises.
      "--fixed-strings",
      "--max-filesize", RG_MAX_FILESIZE,
      // rg caps matches PER FILE; the parse loop caps total + distinct files.
      "--max-count", String(Math.max(1, maxPerFile)),
    ];
    for (const term of searchTerms) rgArgs.push("-e", term);
    rgArgs.push(...(Array.isArray(globArgs) && globArgs.length > 0 ? globArgs : buildGlobArgs()));
    rgArgs.push("--", ".");

    let stdout = "";
    try {
      stdout = String(execFileSync(command, rgArgs, {
        cwd: repoRoot,
        timeout: RG_TIMEOUT_MS,
        maxBuffer: RG_MAX_BUFFER,
        encoding: "utf8",
        windowsHide: true,
        stdio: ["ignore", "pipe", "ignore"],
      }) || "");
    } catch (err) {
      // rg exits 1 when there are simply no matches — a clean empty result, not
      // a failure. Anything else (ENOENT, timeout, real rg error) is best-effort:
      // return null and let search proceed unaugmented.
      const e = /** @type {any} */ (err);
      const noMatchExit = e && e.status === 1 && e.signal == null && !e.code;
      const partialStdout = typeof e?.stdout === "string" ? e.stdout : String(e?.stdout || "");
      if (partialStdout && (e?.signal || e?.code === "ETIMEDOUT" || e?.killed)) {
        stdout = partialStdout;
      } else if (noMatchExit) {
        stdout = typeof e.stdout === "string" ? e.stdout : String(e.stdout || "");
      } else {
        return null;
      }
    }

    /** @type {Array<{ path: string, line: number, text: string, matchKind: "grep-nonindexed" }>} */
    const matches = [];
    const filesSeen = new Set();
    let truncated = false;
    for (const line of stdout.split(/\r?\n/)) {
      if (!line) continue;
      if (matches.length >= collectLimit) { truncated = true; break; }
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      if (event?.type !== "match") continue;
      const data = event.data || {};
      const rawPath = data.path?.text;
      if (!rawPath) continue;
      const relPath = String(rawPath).replace(/\\/g, "/").replace(/^\.\//, "");
      if (!filesSeen.has(relPath)) {
        if (filesSeen.size >= maxFilesScanned) { truncated = true; break; }
        filesSeen.add(relPath);
      }
      const lineNo = Math.max(1, Number(data.line_number) || 1);
      const text = firstLineOf(data.lines?.text).slice(0, MATCH_TEXT_CAP);
      matches.push({ path: relPath, line: lineNo, text, matchKind });
    }
    const scored = matches
      .map((match) => {
        const { score, scoreSignals } = scoreGrepMatch(match, searchTerms);
        return { ...match, score, scoreSignals };
      })
      .sort((a, b) =>
        b.score - a.score
        || a.path.localeCompare(b.path)
        || a.line - b.line
      );
    const page = scored.slice(startOffset, startOffset + pageSize);
    const nextOffset = startOffset + page.length;
    const hasMore = nextOffset < scored.length || truncated;
    return {
      matches: page,
      truncated: hasMore,
      filesMatched: filesSeen.size,
      nextCursor: hasMore ? String(nextOffset) : null,
      offset: startOffset,
      totalCollected: scored.length,
    };
  } catch {
    // Sidecar is strictly best-effort; never let it break search.
    return null;
  }
}

/**
 * @param {{ path: string, text: string }} match
 * @param {string[]} terms
 * @returns {{ score: number, scoreSignals: Record<string, unknown> }}
 */
function scoreGrepMatch(match, terms) {
  const path = String(match.path || "").toLowerCase();
  const base = path.split("/").pop() || path;
  const text = String(match.text || "").toLowerCase();
  let textHits = 0;
  let pathHits = 0;
  let basenameHits = 0;
  const matchedTerms = [];
  const positions = [];
  for (const term of terms) {
    const needle = term.toLowerCase();
    const inText = countOccurrences(text, needle);
    const inPath = path.includes(needle) ? 1 : 0;
    const inBase = base.includes(needle) ? 1 : 0;
    if (inText > 0 || inPath > 0) matchedTerms.push(term);
    textHits += inText;
    pathHits += inPath;
    basenameHits += inBase;
    const pos = text.indexOf(needle);
    if (pos >= 0) positions.push(pos);
  }
  const proximity = positions.length >= 2
    ? Math.max(0, 6 - ((Math.max(...positions) - Math.min(...positions)) / 24))
    : 0;
  const extensionWeight = path.endsWith(".sql") ? 2 : (path.endsWith(".json") ? 1.5 : 1);
  const score = roundScore(
    textHits * 10
    + basenameHits * 4
    + pathHits * 2
    + proximity
    + extensionWeight,
  );
  return {
    score,
    scoreSignals: {
      textHits,
      pathHits,
      basenameHits,
      matchedTerms,
      proximity: roundScore(proximity),
      extensionWeight,
    },
  };
}

function normalizeOffset(value) {
  const n = Number.parseInt(String(value ?? "0"), 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function countOccurrences(text, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while (index < text.length) {
    const found = text.indexOf(needle, index);
    if (found < 0) break;
    count += 1;
    index = found + Math.max(1, needle.length);
  }
  return count;
}

function roundScore(value) {
  return Math.round(Number(value || 0) * 1000) / 1000;
}
