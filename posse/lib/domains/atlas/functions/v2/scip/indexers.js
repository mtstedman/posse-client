// @ts-check
//
// Central SCIP indexer registry. Target repos should not need to carry Posse's
// indexer wiring; they only provide project markers and source files. This
// module resolves installed Posse-managed indexers first, then falls back to
// repo-local bins and PATH as compatibility escape hatches.

import fs from "fs";
import path from "path";
import { createHash } from "crypto";
import { execFileSync } from "child_process";
import { fileURLToPath } from "url";
import { languageForPath } from "../parse/language-buckets.js";
import { normalizeScipLanguages } from "./languages.js";

export const DEFAULT_SCIP_INDEX_TIMEOUT_MS = 120_000;

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_POSSE_ROOT = path.resolve(THIS_DIR, "..", "..", "..", "..", "..", "..");

/**
 * @typedef {{
 *   command: string,
 *   args: string[],
 *   outputPath: string,
 *   label: string,
 *   source: "configured" | "auto",
 *   timeoutMs: number,
 *   indexerId: string,
 *   commandSource: string,
 *   sourceLanguages: string[],
 *   sourceExtensions: string[],
 *   markers: string[],
 * }} ScipStagePlan
 *
 * @typedef {{
 *   id: string,
 *   command: string,
 *   outputName: string,
 *   args: string[],
 *   markers: string[],
 *   sourceExtensions: string[],
 *   sourceLanguages: string[],
 * }} ScipIndexerCandidate
 *
 * @typedef {{
 *   plans: ScipStagePlan[],
 *   candidates: Array<ScipIndexerCandidate & { resolved: boolean, commandPath: string | null, commandSource: string | null }>,
 *   searchRoots: Array<{ dir: string, source: string }>,
 *   projectKinds: string[],
 *   configuredCommand: string | null,
 * }} ScipIndexerLookup
 */

const SCIP_INDEXERS = Object.freeze([
  Object.freeze({
    id: "typescript",
    command: "scip-typescript",
    outputName: "typescript.scip",
    markers: ["tsconfig.json", "package.json"],
    sourceExtensions: [".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs"],
    args: ["index", "--infer-tsconfig", "--output", "{output}"],
  }),
  Object.freeze({
    id: "python",
    command: "scip-python",
    outputName: "python.scip",
    markers: ["pyproject.toml", "setup.py", "requirements.txt"],
    sourceExtensions: [".py", ".pyi"],
    args: ["index", "--output", "{output}"],
  }),
  Object.freeze({
    id: "php",
    command: "scip-php",
    outputName: "php.scip",
    markers: ["composer.json"],
    sourceExtensions: [".php"],
    args: ["index", "--output", "{output}"],
  }),
  Object.freeze({
    id: "go",
    command: "scip-go",
    outputName: "go.scip",
    markers: ["go.mod"],
    sourceExtensions: [".go"],
    args: ["--output", "{output}"],
  }),
  Object.freeze({
    id: "rust",
    command: "scip-rust",
    outputName: "rust.scip",
    markers: ["Cargo.toml"],
    sourceExtensions: [".rs"],
    args: ["--output", "{output}", "."],
  }),
]);

/**
 * Resolve every applicable SCIP indexer plan for a repo. A configured command
 * is an explicit DB/admin override and produces a single plan. Without an
 * override, every matching project kind with an installed indexer gets a plan.
 *
 * @param {{
 *   repoRoot: string,
 *   scipDir?: string,
 *   command?: string | null,
 *   args?: string[] | string | null,
 *   timeoutMs?: number | null,
 *   posseRoot?: string | null,
 *   languages?: string[] | string | null,
 * }} input
 * @returns {ScipIndexerLookup}
 */
export function resolveScipStagePlans(input) {
  const repoRoot = path.resolve(input.repoRoot || process.cwd());
  const scipDir = path.resolve(input.scipDir || path.join(repoRoot, ".posse", "atlas", "scip"));
  const posseRoot = path.resolve(String(input.posseRoot || DEFAULT_POSSE_ROOT));
  const timeout = positiveInt(input.timeoutMs) || DEFAULT_SCIP_INDEX_TIMEOUT_MS;
  const searchRoots = commandSearchRoots({ posseRoot, repoRoot });
  const configuredCommand = String(input.command || "").trim() || null;
  const enabledLanguages = new Set(normalizeScipLanguages(input.languages));

  if (configuredCommand) {
    const resolution = resolveCommand(configuredCommand, searchRoots);
    const commandPath = resolution?.path || configuredCommand;
    const outputPath = path.join(scipDir, "configured.scip");
    const rawArgs = normalizeArgs(input.args);
    const finalArgs = rawArgs.length > 0
      ? rawArgs
      : defaultArgsForCommand(configuredCommand);
    return {
      plans: [{
        command: commandPath,
        args: expandArgs(finalArgs, { outputPath, repoRoot, scipDir }),
        outputPath,
        label: configuredCommand,
        source: "configured",
        timeoutMs: timeout,
        indexerId: "configured",
        commandSource: resolution?.source || "configured",
        sourceLanguages: [],
        sourceExtensions: [],
        markers: [],
      }],
      candidates: [],
      searchRoots,
      projectKinds: [],
      configuredCommand,
    };
  }

  /** @type {ScipIndexerLookup["candidates"]} */
  const candidates = [];
  /** @type {ScipStagePlan[]} */
  const plans = [];
  const projectKinds = new Set();
  for (const candidate of autoCandidates(repoRoot, enabledLanguages)) {
    projectKinds.add(candidate.id);
    const outputPath = path.join(scipDir, candidate.outputName);
    const resolution = resolveCommand(candidate.command, searchRoots);
    candidates.push({
      ...candidate,
      resolved: Boolean(resolution?.path),
      commandPath: resolution?.path || null,
      commandSource: resolution?.source || null,
    });
    if (!resolution?.path) continue;
    plans.push({
      command: resolution.path,
      args: expandArgs(candidate.args, { outputPath, repoRoot, scipDir }),
      outputPath,
      label: candidate.command,
      source: "auto",
      timeoutMs: timeout,
      indexerId: candidate.id,
      commandSource: resolution.source,
      sourceLanguages: candidate.sourceLanguages || [],
      sourceExtensions: candidate.sourceExtensions || [],
      markers: candidate.markers || [],
    });
  }
  return {
    plans,
    candidates,
    searchRoots,
    projectKinds: Array.from(projectKinds),
    configuredCommand,
  };
}

/**
 * Compatibility helper for older callers/tests that expect one plan.
 * @param {Parameters<typeof resolveScipStagePlans>[0]} input
 * @returns {ScipStagePlan | null}
 */
export function resolveScipStagePlan(input) {
  return resolveScipStagePlans(input).plans[0] || null;
}

/**
 * @param {ScipIndexerLookup} lookup
 * @returns {string}
 */
export function describeScipIndexerLookup(lookup) {
  if (lookup.configuredCommand) {
    return `configured SCIP indexer '${lookup.configuredCommand}' could not be launched`;
  }
  if (lookup.projectKinds.length === 0) {
    return "no recognized SCIP source files for the central Posse indexer registry";
  }
  const commands = unique(lookup.candidates.map((candidate) => candidate.command)).join(", ");
  return `no Posse SCIP indexer found for ${lookup.projectKinds.join(", ")} (looked for ${commands} in Posse-managed bins, repo-local bins, and PATH)`;
}

/**
 * @param {string} command
 * @returns {string[]}
 */
export function defaultArgsForCommand(command) {
  const base = path.basename(command).toLowerCase().replace(/\.(exe|cmd|bat)$/u, "");
  if (base === "scip-typescript") return ["index", "--infer-tsconfig", "--output", "{output}"];
  if (base === "scip-rust") return ["--output", "{output}", "."];
  return ["--output", "{output}"];
}

/**
 * @param {string[] | string | null | undefined} value
 * @returns {string[]}
 */
export function normalizeArgs(value) {
  if (Array.isArray(value)) return value.map((item) => String(item));
  const input = String(value || "").trim();
  if (!input) return [];
  const out = [];
  let current = "";
  let quote = null;
  for (const ch of input) {
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "\"" || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/u.test(ch)) {
      if (current) {
        out.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/**
 * @param {{ repoRoot: string, posseRoot: string }} input
 * @returns {Array<{ dir: string, source: string }>}
 */
function commandSearchRoots({ repoRoot, posseRoot }) {
  const scipRoot = path.join(posseRoot, "scip");
  /** @type {Array<{ dir: string, source: string }>} */
  const roots = [
    { dir: path.join(scipRoot, "bin"), source: "posse scip/bin" },
    { dir: path.join(scipRoot, "node", "node_modules", ".bin"), source: "posse scip/node" },
    { dir: path.join(scipRoot, "php", "vendor", "bin"), source: "posse scip/php" },
    { dir: path.join(posseRoot, "node_modules", ".bin"), source: "posse node_modules/.bin" },
    { dir: path.join(posseRoot, "vendor", "bin"), source: "posse vendor/bin" },
    { dir: path.join(posseRoot, ".venv", "Scripts"), source: "posse .venv/Scripts" },
    { dir: path.join(posseRoot, "venv", "Scripts"), source: "posse venv/Scripts" },
    { dir: path.join(posseRoot, ".venv", "bin"), source: "posse .venv/bin" },
    { dir: path.join(posseRoot, "venv", "bin"), source: "posse venv/bin" },
    { dir: path.join(posseRoot, "bin"), source: "posse bin" },
    { dir: path.join(repoRoot, "node_modules", ".bin"), source: "repo node_modules/.bin" },
    { dir: path.join(repoRoot, "vendor", "bin"), source: "repo vendor/bin" },
    { dir: path.join(repoRoot, ".venv", "Scripts"), source: "repo .venv/Scripts" },
    { dir: path.join(repoRoot, "venv", "Scripts"), source: "repo venv/Scripts" },
    { dir: path.join(repoRoot, ".venv", "bin"), source: "repo .venv/bin" },
    { dir: path.join(repoRoot, "venv", "bin"), source: "repo venv/bin" },
  ];
  const pathEnv = String(process.env.PATH || "");
  for (const dir of pathEnv.split(path.delimiter).filter(Boolean)) {
    roots.push({ dir, source: "PATH" });
  }
  return uniqueRoots(roots);
}

/**
 * @param {string} repoRoot
 * @param {Set<string>} enabledLanguages
 * @returns {ScipIndexerCandidate[]}
 */
function autoCandidates(repoRoot, enabledLanguages) {
  const out = [];
  for (const indexer of SCIP_INDEXERS) {
    if (!enabledLanguages.has(indexer.id)) continue;
    const sourceLanguages = repoSourceLanguagesForExtensions(repoRoot, indexer.sourceExtensions);
    if (sourceLanguages.length === 0) continue;
    out.push({ ...indexer, sourceLanguages });
  }
  return out;
}

const SOURCE_SCAN_IGNORED_DIRS = new Set([
  ".git",
  ".hg",
  ".svn",
  ".posse",
  ".posse-worktrees",
  ".posse-test-suites",
  "node_modules",
  "vendor",
  "dist",
  "build",
  "coverage",
  ".next",
  ".nuxt",
  ".cache",
  ".venv",
  "venv",
  "__pycache__",
  "target",
]);

const SOURCE_SCAN_MAX_DIRS = 2_000;
const SOURCE_SCAN_MAX_FILES = 20_000;

/**
 * Count source files in the repo matching the given file extensions. Used to
 * synthesise SCIP progress for indexers (scip-php, scip-go, scip-ruby) that
 * emit one filename per line but no explicit N/M ratio — counting unique
 * paths in their stdout against this total gives a real percent bar.
 *
 * Respects the same ignore set as repoSourceLanguagesForExtensions and shares
 * the SOURCE_SCAN_MAX_DIRS / SOURCE_SCAN_MAX_FILES caps so very large
 * monorepos don't stall boot on the scan. When the cap is hit we return
 * whatever count we have plus a `capped: true` flag; the caller can still
 * render meaningful progress, just bounded.
 *
 * @param {string} repoRoot
 * @param {string[]} extensions  e.g. [".php"], [".go"], [".ts",".tsx"]
 * @returns {{ total: number, capped: boolean }}
 */
export function countSourceFilesByExtensions(repoRoot, extensions = []) {
  const root = String(repoRoot || process.cwd());
  const wanted = new Set((extensions || []).map((ext) => String(ext || "").toLowerCase()));
  if (wanted.size === 0) return { total: 0, capped: false };
  let total = 0;
  let capped = false;
  const stack = [root];
  let dirsSeen = 0;
  let filesSeen = 0;
  while (stack.length > 0) {
    if (dirsSeen >= SOURCE_SCAN_MAX_DIRS || filesSeen >= SOURCE_SCAN_MAX_FILES) {
      capped = true;
      break;
    }
    const dir = stack.pop();
    if (!dir) continue;
    dirsSeen++;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SOURCE_SCAN_IGNORED_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      filesSeen++;
      if (wanted.has(path.extname(entry.name).toLowerCase())) total++;
      if (filesSeen >= SOURCE_SCAN_MAX_FILES) { capped = true; break; }
    }
  }
  return { total, capped };
}

const SCIP_FILESET_INPUTS_BY_INDEXER = Object.freeze({
  typescript: Object.freeze({
    basenames: Object.freeze([
      "package.json",
      "package-lock.json",
      "npm-shrinkwrap.json",
      "yarn.lock",
      "pnpm-lock.yaml",
      "bun.lock",
      "bun.lockb",
      "tsconfig.json",
      "jsconfig.json",
    ]),
    basenamePatterns: Object.freeze([/^tsconfig\..+\.json$/iu, /^jsconfig\..+\.json$/iu]),
  }),
  python: Object.freeze({
    basenames: Object.freeze([
      "pyproject.toml",
      "setup.py",
      "setup.cfg",
      "requirements.txt",
      "poetry.lock",
      "uv.lock",
      "Pipfile",
      "Pipfile.lock",
      "tox.ini",
      "mypy.ini",
      "pytest.ini",
    ]),
    basenamePatterns: Object.freeze([/^requirements[-_.].+\.txt$/iu]),
  }),
  php: Object.freeze({
    basenames: Object.freeze(["composer.json", "composer.lock"]),
    basenamePatterns: Object.freeze([]),
  }),
  go: Object.freeze({
    basenames: Object.freeze(["go.mod", "go.sum"]),
    basenamePatterns: Object.freeze([]),
  }),
  rust: Object.freeze({
    basenames: Object.freeze(["Cargo.toml", "Cargo.lock"]),
    basenamePatterns: Object.freeze([]),
  }),
});

/**
 * Compute the input fingerprint that should invalidate a staged SCIP artifact.
 * For known auto-detected indexers this is deliberately language-scoped: source
 * extensions plus language config/dependency files. A docs-only commit should
 * therefore leave every language fileset hash unchanged.
 *
 * @param {{ repoRoot: string, plan: ScipStagePlan, ref?: string | null }} input
 * @returns {{ ok: boolean, hash: string | null, files: number, source: string, ref: string | null, reason?: string }}
 */
export function computeScipPlanFilesetHash({ repoRoot, plan, ref = null } = {}) {
  const root = path.resolve(String(repoRoot || process.cwd()));
  const spec = filesetSpecForPlan(plan);
  if (!spec) {
    return { ok: false, hash: null, files: 0, source: "unsupported", ref: ref || null, reason: "fileset_unsupported" };
  }

  const gitRef = String(ref || "").trim();
  if (gitRef) {
    const fromTree = gitTreeFilesetEntries(root, gitRef, spec);
    if (fromTree.ok) {
      return filesetHashResult(fromTree.entries, spec, { source: "git-tree", ref: gitRef });
    }
    return { ok: false, hash: null, files: 0, source: "git-tree", ref: gitRef, reason: fromTree.reason || "git_tree_failed" };
  }

  const fromGitWorktree = gitWorktreeFilesetEntries(root, spec);
  if (fromGitWorktree.ok) {
    return filesetHashResult(fromGitWorktree.entries, spec, { source: "git-worktree", ref: null });
  }

  const fromFilesystem = filesystemFilesetEntries(root, spec);
  if (fromFilesystem.ok) {
    return filesetHashResult(fromFilesystem.entries, spec, { source: "filesystem", ref: null });
  }

  return {
    ok: false,
    hash: null,
    files: 0,
    source: "filesystem",
    ref: null,
    reason: fromFilesystem.reason || fromGitWorktree.reason || "fileset_scan_failed",
  };
}

function filesetSpecForPlan(plan = {}) {
  const extensions = uniqueNonEmptyStrings(plan.sourceExtensions || [])
    .map((ext) => ext.startsWith(".") ? ext.toLowerCase() : `.${ext.toLowerCase()}`);
  const indexerId = String(plan.indexerId || "").trim().toLowerCase();
  const languageInputs = SCIP_FILESET_INPUTS_BY_INDEXER[indexerId] || null;
  const basenames = uniqueNonEmptyStrings([
    ...(Array.isArray(plan.markers) ? plan.markers : []),
    ...(languageInputs?.basenames || []),
  ]).map((name) => name.toLowerCase());
  const basenamePatterns = Array.isArray(languageInputs?.basenamePatterns)
    ? [...languageInputs.basenamePatterns]
    : [];
  if (extensions.length === 0 && basenames.length === 0 && basenamePatterns.length === 0) return null;
  return {
    indexerId,
    extensions: new Set(extensions),
    basenames: new Set(basenames),
    basenamePatterns,
  };
}

function gitTreeFilesetEntries(repoRoot, ref, spec) {
  let buf;
  try {
    buf = execFileSync("git", ["ls-tree", "-rz", "-r", "--full-tree", ref], {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    return { ok: false, entries: [], reason: err?.message || "git_ls_tree_failed" };
  }
  const entries = [];
  for (const raw of buf.toString("utf8").split("\0")) {
    if (!raw) continue;
    const tab = raw.indexOf("\t");
    if (tab === -1) continue;
    const header = raw.slice(0, tab).split(/\s+/u);
    const type = header[1] || "";
    const objectId = header[2] || "";
    if (type !== "blob" || !objectId) continue;
    const rel = normalizeRepoRel(raw.slice(tab + 1));
    if (!pathMatchesFilesetSpec(rel, spec)) continue;
    entries.push({ path: rel, digest: objectId, kind: "git-blob" });
  }
  return { ok: true, entries };
}

function gitWorktreeFilesetEntries(repoRoot, spec) {
  let buf;
  try {
    buf = execFileSync("git", ["ls-files", "-z", "--cached", "--others", "--exclude-standard"], {
      cwd: repoRoot,
      encoding: "buffer",
      maxBuffer: 64 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    });
  } catch (err) {
    return { ok: false, entries: [], reason: err?.message || "git_ls_files_failed" };
  }
  const entries = [];
  for (const raw of buf.toString("utf8").split("\0")) {
    const rel = normalizeRepoRel(raw);
    if (!rel || !pathMatchesFilesetSpec(rel, spec)) continue;
    const abs = path.join(repoRoot, rel);
    try {
      const st = fs.statSync(abs);
      if (!st.isFile()) continue;
      entries.push({ path: rel, digest: sha256File(abs), kind: "worktree-file" });
    } catch {
      // Deleted paths are not current fileset inputs.
    }
  }
  return { ok: true, entries };
}

function filesystemFilesetEntries(repoRoot, spec) {
  const entries = [];
  const stack = [repoRoot];
  let dirsSeen = 0;
  let filesSeen = 0;
  while (stack.length > 0) {
    if (dirsSeen >= SOURCE_SCAN_MAX_DIRS || filesSeen >= SOURCE_SCAN_MAX_FILES) {
      return { ok: false, entries, reason: "fileset_scan_capped" };
    }
    const dir = stack.pop();
    if (!dir) continue;
    dirsSeen++;
    let dirEntries;
    try {
      dirEntries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of dirEntries) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SOURCE_SCAN_IGNORED_DIRS.has(entry.name)) stack.push(abs);
        continue;
      }
      if (!entry.isFile()) continue;
      filesSeen++;
      const rel = normalizeRepoRel(path.relative(repoRoot, abs));
      if (pathMatchesFilesetSpec(rel, spec)) {
        try {
          entries.push({ path: rel, digest: sha256File(abs), kind: "filesystem-file" });
        } catch {
          // If the file disappeared during the scan, the next pass can decide.
        }
      }
      if (filesSeen >= SOURCE_SCAN_MAX_FILES) break;
    }
  }
  return { ok: true, entries };
}

function filesetHashResult(entries, spec, { source, ref }) {
  const sorted = [...entries].sort((a, b) => a.path.localeCompare(b.path));
  const h = createHash("sha256");
  h.update("atlas-scip-fileset-v1\0");
  h.update(JSON.stringify({
    indexer_id: spec.indexerId || "",
    extensions: [...spec.extensions].sort(),
    basenames: [...spec.basenames].sort(),
    patterns: spec.basenamePatterns.map((pattern) => String(pattern)),
  }));
  h.update("\0");
  for (const entry of sorted) {
    h.update(entry.path);
    h.update("\0");
    h.update(entry.kind || "");
    h.update("\0");
    h.update(entry.digest || "");
    h.update("\0");
  }
  return {
    ok: true,
    hash: `sha256:${h.digest("hex")}`,
    files: sorted.length,
    source,
    ref,
  };
}

function pathMatchesFilesetSpec(repoRelPath, spec) {
  const rel = normalizeRepoRel(repoRelPath);
  if (!rel || isIgnoredRepoRelPath(rel)) return false;
  const basename = path.posix.basename(rel).toLowerCase();
  const ext = path.posix.extname(basename).toLowerCase();
  if (spec.extensions.has(ext)) return true;
  if (spec.basenames.has(basename)) return true;
  return spec.basenamePatterns.some((pattern) => pattern.test(basename));
}

function isIgnoredRepoRelPath(repoRelPath) {
  return normalizeRepoRel(repoRelPath)
    .split("/")
    .some((part) => SOURCE_SCAN_IGNORED_DIRS.has(part));
}

function normalizeRepoRel(value) {
  return String(value || "")
    .replace(/\\/g, "/")
    .replace(/^\.\/+/u, "")
    .replace(/^\/+/u, "")
    .trim();
}

function sha256File(filePath) {
  const h = createHash("sha256");
  h.update(fs.readFileSync(filePath));
  return h.digest("hex");
}

function uniqueNonEmptyStrings(values) {
  const out = [];
  const seen = new Set();
  for (const raw of values || []) {
    const value = String(raw || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

/**
 * @param {string} repoRoot
 * @param {string[]} extensions
 * @returns {string[]}
 */
function repoSourceLanguagesForExtensions(repoRoot, extensions) {
  const wanted = new Set(extensions.map((ext) => ext.toLowerCase()));
  const languages = new Set();
  const stack = [repoRoot];
  let dirsSeen = 0;
  let filesSeen = 0;
  while (stack.length > 0 && dirsSeen < SOURCE_SCAN_MAX_DIRS && filesSeen < SOURCE_SCAN_MAX_FILES) {
    const dir = stack.pop();
    if (!dir) continue;
    dirsSeen++;
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SOURCE_SCAN_IGNORED_DIRS.has(entry.name)) stack.push(path.join(dir, entry.name));
        continue;
      }
      if (!entry.isFile()) continue;
      filesSeen++;
      if (wanted.has(path.extname(entry.name).toLowerCase())) {
        const lang = languageForPath(entry.name);
        if (lang && lang !== "unknown") languages.add(lang);
      }
      if (filesSeen >= SOURCE_SCAN_MAX_FILES) break;
    }
  }
  return sortLanguageTags([...languages]);
}

const LANGUAGE_ORDER = ["ts", "js", "py", "php", "go", "rs", "java", "kt", "cs", "c", "cpp", "sh"];
function sortLanguageTags(values) {
  return values.sort((a, b) => {
    const ai = LANGUAGE_ORDER.indexOf(a);
    const bi = LANGUAGE_ORDER.indexOf(b);
    if (ai !== -1 || bi !== -1) return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    return a.localeCompare(b);
  });
}

/**
 * @param {string} command
 * @param {Array<{ dir: string, source: string }>} searchRoots
 * @returns {{ path: string, source: string } | null}
 */
function resolveCommand(command, searchRoots) {
  const raw = String(command || "").trim();
  if (!raw) return null;
  const hasPath = raw.includes("/") || raw.includes("\\") || path.isAbsolute(raw);
  const bases = hasPath
    ? [{ file: raw, source: "path" }]
    : searchRoots.map((root) => ({ file: path.join(root.dir, raw), source: root.source }));
  for (const base of bases) {
    for (const ext of commandExts()) {
      const candidate = ext && base.file.toLowerCase().endsWith(ext)
        ? base.file
        : `${base.file}${ext}`;
      try {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          return { path: candidate, source: base.source };
        }
      } catch {
        // Keep searching.
      }
    }
  }
  return null;
}

/**
 * @param {string[]} args
 * @param {{ outputPath: string, repoRoot: string, scipDir: string }} input
 * @returns {string[]}
 */
function expandArgs(args, { outputPath, repoRoot, scipDir }) {
  return normalizeArgs(args).map((arg) => String(arg)
    .replaceAll("{output}", outputPath)
    .replaceAll("{repoRoot}", repoRoot)
    .replaceAll("{scipDir}", scipDir));
}

/**
 * @returns {string[]}
 */
function commandExts() {
  return process.platform === "win32" ? [".cmd", ".bat", ".exe", ""] : [""];
}

/**
 * @param {number | string | null | undefined} value
 * @returns {number | null}
 */
function positiveInt(value) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : null;
}

/**
 * @param {Array<{ dir: string, source: string }>} roots
 * @returns {Array<{ dir: string, source: string }>}
 */
function uniqueRoots(roots) {
  const seen = new Set();
  const out = [];
  for (const root of roots) {
    const key = path.resolve(root.dir).toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ dir: path.resolve(root.dir), source: root.source });
  }
  return out;
}

/**
 * @param {string[]} values
 * @returns {string[]}
 */
function unique(values) {
  return Array.from(new Set(values.filter(Boolean)));
}
