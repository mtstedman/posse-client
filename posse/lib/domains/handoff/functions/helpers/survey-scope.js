// @ts-check
//
// Determination logic for prefetch-injected code.survey: given the relevance
// signal the handoff prefetch already computes (tree.scope candidateFiles ->
// rankedFiles, candidateDirs, plus task text and seeds), decide whether to
// survey an area for this handoff and over WHICH paths.
//
// The decision is pure: filesystem/index probes (does a path exist and what
// kind; how many indexed files under a dir) are injected as `deps`, so the
// ladder is unit-testable without a live ATLAS view. Phase 2 wires the real
// disk-backed probes from `defaultSurveyScopeDeps`.
//
// Ladder (highest-confidence signal first), grounded by Phase 0 evidence:
//   1. Explicit indexed path named in the task -> survey it (dir or file list).
//      Recovers the named dir that tree.scope semantic-matching missed.
//   2. Seeds (key_files / files_to_modify), concentrated -> dir or file list.
//   3. Dominant candidateDir: >=60% of the top-K ranked files under ONE bounded
//      candidateDir (<=64 indexed files) -> directory mode.
//   4. Otherwise -> file-list over the top-N ranked hits (cross-cutting).
// Gate off when there is no area (<4 ranked files and no explicit/seed scope).
//
// Directory candidates only ever come from explicit paths, seeds' own parents,
// or tree.scope's candidateDirs (pre-scoped) - never a computed common ancestor
// - so a giant root like "lib/domains" can never be chosen.

import path from "node:path";
import fs from "node:fs";

const CODE_EXT_RE = /\.(js|mjs|cjs|ts|tsx|jsx|py|php|rs|go|java|rb)$/;
// Repo-relative path tokens the task text might name (top-level source roots).
const EXPLICIT_PATH_RE = /\b(?:lib|src|www|test|tests|app|apps|crates|rust|packages|internal|pkg|cmd)\/[A-Za-z0-9_.\/-]+/g;

export const MAX_SURVEY_FILES = 64;   // code.survey hard cap on paths resolution
export const FILE_LIST_MAX = 24;      // top-N when surveying a scattered file list
export const FILE_LIST_MAX_CROSS_CUTTING = 40;  // fan-in/inventory/reachability span more files — give them a wider file budget
export const TOP_K = 12;              // strongest slice of the ranked set for dominance
export const DOMINANCE = 0.6;         // fraction of top-K under one dir to call it dominant
export const MIN_AREA_FILES = 4;      // fewer than this is not an "area" - keep the ladder

function uniq(arr) {
  const seen = new Set();
  const out = [];
  for (const v of Array.isArray(arr) ? arr : []) {
    const s = typeof v === "string" ? v.replace(/\\/g, "/").trim() : "";
    if (s && !seen.has(s)) { seen.add(s); out.push(s); }
  }
  return out;
}

function parentDir(filePath) {
  const norm = String(filePath || "").replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx > 0 ? norm.slice(0, idx) : "";
}

function coverageUnder(files, dir) {
  const prefix = `${dir}/`;
  return files.filter((f) => f === dir || f.startsWith(prefix)).length;
}

// Best bounded directory (from the supplied candidate dirs) covering >= threshold
// of `files`. Ties broken toward higher coverage, then fewer indexed files (tighter).
function dominantDir(files, candidateDirs, dirFileCount, threshold = DOMINANCE) {
  const n = files.length;
  if (n === 0) return null;
  let best = null;
  for (const dir of uniq(candidateDirs)) {
    const cover = coverageUnder(files, dir);
    const frac = cover / n;
    if (frac < threshold) continue;
    const fileCount = dirFileCount(dir);
    if (!(fileCount >= 2 && fileCount <= MAX_SURVEY_FILES)) continue;
    if (!best || frac > best.frac || (frac === best.frac && fileCount < best.files)) {
      best = { dir, frac, files: fileCount, coverage: `${cover}/${n}` };
    }
  }
  return best;
}

/** @param {string} taskText @param {(p:string)=>('dir'|'file'|null)} pathKind */
export function extractExplicitPaths(taskText, pathKind) {
  const toks = String(taskText || "").match(EXPLICIT_PATH_RE) || [];
  const seen = new Set();
  const out = [];
  for (const raw of toks) {
    const t = raw.replace(/[.,;:)\]}'"]+$/, "").replace(/\\/g, "/");
    if (!t || seen.has(t)) continue;
    seen.add(t);
    const kind = pathKind(t);
    if (kind === "dir" || kind === "file") out.push({ path: t, kind });
  }
  return out;
}

// Dig terms for survey (switches it to symbol mode). Conservative: validated
// key_symbols win; otherwise only backticked identifiers when the task clearly
// asks to trace a symbol. Default null -> lean file-mode area map.
function deriveSymbols(taskText, keySymbols) {
  const seeds = uniq(keySymbols).slice(0, 16);
  if (seeds.length) return seeds;
  const t = String(taskText || "");
  if (!/\b(callers?|callees?|calls|usages?|references?|who calls|trace)\b/i.test(t)) return null;
  const backticked = (t.match(/`([A-Za-z_$][\w$]{2,})`/g) || []).map((s) => s.replace(/`/g, ""));
  const ids = uniq(backticked).slice(0, 16);
  return ids.length ? ids : null;
}

// Cross-cutting tasks — fan-in (who-calls), inventory ("every write"),
// reachability, and negative-evidence — resolve their answer in SIBLING dirs
// (the callers/writers/decoys), not the target symbol's home dir. Directory
// mode fences those out, so these tasks must stay file-list even when the
// ranked files cluster under one dir. `deriveSymbols` already flags the
// fan-in/trace verbs; this covers the inventory/enumeration/negative phrasings.
const CROSS_CUTTING_RE = /\b(inventor(?:y|ies)|enumerate|every\s+\w+|all\s+(?:the\s+)?(?:writes?|callers?|usages?|places?|references?|paths?)|reachable|reached\s+from|fan[-\s]?in|who\s+(?:calls|writes|reads|uses)|negative[-\s]evidence|decoys?|persist(?:ence|ed)?\s+writes?)\b/i;
function isCrossCuttingTask(taskText) {
  return CROSS_CUTTING_RE.test(String(taskText || ""));
}

// Lexically-matched test files routinely out-rank the real source in an area
// survey — a config/runtime task pulls the suites that name the same symbols,
// starving the source that actually answers it (measured: 6 of 8 top-ranked
// files were tests on a config-provenance task). Demote — never drop — test
// files below source so source fills the survey budget first; tests still ride
// the tail when there is room, so a fan-in task that legitimately counts test
// callers still sees them. Left alone when the task itself targets tests.
const TEST_PATH_RE = /(?:^|\/)(?:tests?|__tests__|specs?|e2e)\/|\.(?:test|spec)\.[cm]?[jt]sx?$|(?:^|\/)test_[^/]+\.py$|_test\.(?:py|go)$/i;
const TEST_TASK_RE = /\b(?:test\s+coverage|which\s+tests?|test\s+files?|unit\s+tests?|test\s+suites?|coverage\s+gaps?|spec\s+files?|how\s+is\s+[\w.]+\s+tested)\b/i;
function isTestPath(p) { return TEST_PATH_RE.test(String(p || "")); }
function demoteTestFiles(files, taskText) {
  if (TEST_TASK_RE.test(String(taskText || ""))) return files;
  const src = [];
  const tst = [];
  for (const f of files) (isTestPath(f) ? tst : src).push(f);
  return src.length > 0 ? [...src, ...tst] : files;
}

function decide(source, mode, paths, symbols, extra = {}) {
  return { inject: true, source, mode, paths, symbols: symbols || null, ...extra };
}

/**
 * @param {{taskText?:string, rankedFiles?:string[], candidateDirs?:string[], seedFiles?:string[], keySymbols?:string[]}} input
 * @param {{pathKind?:(p:string)=>('dir'|'file'|null), dirFileCount?:(dir:string)=>number}} [deps]
 */
export function chooseSurveyScope(input = {}, deps = {}) {
  const {
    taskText = "",
    rankedFiles = [],
    candidateDirs = [],
    seedFiles = [],
    keySymbols = [],
  } = input;
  const pathKind = typeof deps.pathKind === "function" ? deps.pathKind : () => null;
  const dirFileCount = typeof deps.dirFileCount === "function" ? deps.dirFileCount : () => -1;

  const symbols = deriveSymbols(taskText, keySymbols);
  // A relational/enumerative task must never collapse to one dir (rungs 2-3):
  // its evidence is cross-dir by definition. Explicit paths (rung 1) still win
  // — an author who named a dir scoped it deliberately.
  const crossCutting = symbols !== null || isCrossCuttingTask(taskText);
  const fileListCap = crossCutting ? FILE_LIST_MAX_CROSS_CUTTING : FILE_LIST_MAX;

  // (1) explicit path named in the task
  const explicit = extractExplicitPaths(taskText, pathKind);
  const explicitDir = explicit.find((e) => e.kind === "dir");
  if (explicitDir) {
    const n = dirFileCount(explicitDir.path);
    if (n >= 1 && n <= MAX_SURVEY_FILES) {
      return decide("explicit-path", "directory", explicitDir.path, symbols, { files: n });
    }
    // named dir too big: keep the ranked files that live under it, if any
    const under = uniq(rankedFiles).filter((f) => f.startsWith(`${explicitDir.path}/`));
    if (under.length >= 2) return decide("explicit-path", "file-list", under.slice(0, MAX_SURVEY_FILES), symbols, { note: "named dir over cap; ranked hits under it" });
  }
  const explicitFiles = explicit.filter((e) => e.kind === "file").map((e) => e.path);
  if (explicitFiles.length) return decide("explicit-path", "file-list", explicitFiles.slice(0, MAX_SURVEY_FILES), symbols);

  // (2) seeds (explicit scope / validated research key_files)
  const seeds = demoteTestFiles(uniq(seedFiles).filter((f) => CODE_EXT_RE.test(f)), taskText);
  if (seeds.length >= MIN_AREA_FILES) {
    const dom = crossCutting ? null : dominantDir(seeds, uniq(seeds.map(parentDir)), dirFileCount);
    if (dom) return decide("seeds", "directory", dom.dir, symbols, { files: dom.files, coverage: dom.coverage });
    return decide("seeds", "file-list", seeds.slice(0, fileListCap), symbols, crossCutting ? { crossCutting: true } : {});
  }

  // area gate
  const ranked = demoteTestFiles(uniq(rankedFiles).filter((f) => CODE_EXT_RE.test(f)), taskText);
  if (ranked.length < MIN_AREA_FILES) {
    return { inject: false, reason: `no area: ${ranked.length} ranked files, no explicit/seed scope`, symbols: null };
  }

  // (3) dominant candidateDir — skipped for cross-cutting tasks, whose callers/
  // writers/decoys live outside the dominant dir a directory survey would fence.
  const dom = crossCutting ? null : dominantDir(ranked.slice(0, TOP_K), candidateDirs, dirFileCount);
  if (dom) return decide("candidateDir", "directory", dom.dir, symbols, { files: dom.files, coverage: dom.coverage });

  // (4) file-list over the ranked hits (cross-cutting)
  return decide("ranked-file-list", "file-list", ranked.slice(0, fileListCap), symbols, {
    note: crossCutting ? "cross-cutting task; file-list spans sibling dirs" : "no dominant bounded dir; scattered hits",
    ...(crossCutting ? { crossCutting: true } : {}),
  });
}

// Disk-backed probes for production (Phase 2). A reasonable proxy for the ATLAS
// index for the existence/bound checks; the survey call itself resolves against
// the index. `repoRoot` anchors relative paths.
export function defaultSurveyScopeDeps(repoRoot) {
  const root = String(repoRoot || process.cwd());
  const pathKind = (rel) => {
    try {
      const st = fs.statSync(path.join(root, rel));
      return st.isDirectory() ? "dir" : (st.isFile() ? "file" : null);
    } catch { return null; }
  };
  const dirFileCount = (rel, cap = MAX_SURVEY_FILES + 1) => {
    const abs = path.join(root, rel);
    let n = 0;
    const stack = [abs];
    try {
      while (stack.length && n <= cap) {
        const dir = stack.pop();
        for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
          if (e.name === "node_modules" || e.name === ".git" || e.name.startsWith(".")) continue;
          const p = path.join(dir, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (CODE_EXT_RE.test(e.name)) n += 1;
          if (n > cap) break;
        }
      }
    } catch { return -1; }
    return n;
  };
  return { pathKind, dirFileCount };
}
