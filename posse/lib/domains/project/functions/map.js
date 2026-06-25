import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { execFile, spawnSync } from "child_process";
import { promisify } from "util";

const CACHE_RELATIVE_PATH = path.join(".posse", "project-map.json");
const SCAN_ROOTS = Object.freeze(["lib", "test", "prompts"]);
const HOOK_BEGIN = "# >>> POSSE PROJECT MAP (managed) >>>";
const HOOK_END = "# <<< POSSE PROJECT MAP (managed) <<<";
const execFileAsync = promisify(execFile);

function toPosix(value) {
  return String(value || "").replace(/\\/g, "/");
}

function normalizeProjectDir(projectDir) {
  return path.resolve(projectDir || process.cwd());
}

function projectMapPath(projectDir) {
  return path.join(normalizeProjectDir(projectDir), CACHE_RELATIVE_PATH);
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort((a, b) => a.localeCompare(b));
}

function currentGitHead(projectDir, execImpl = spawnSync) {
  try {
    const out = execImpl("git", ["rev-parse", "HEAD"], {
      cwd: normalizeProjectDir(projectDir),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    }) || {};
    if (out.status === 0) {
      const sha = String(out.stdout || "").trim();
      return sha || null;
    }
  } catch {
    // Non-git directories are valid Posse targets; the cache just has no SHA.
  }
  return null;
}

async function currentGitHeadAsync(projectDir) {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: normalizeProjectDir(projectDir),
      encoding: "utf8",
      timeout: 5000,
      windowsHide: true,
    });
    const sha = String(stdout || "").trim();
    return sha || null;
  } catch {
    return null;
  }
}

function walkDepth(rootAbs, rootRel, maxDepth = 2) {
  const out = [];
  const visit = (absDir, relDir, depth) => {
    let entries = [];
    try {
      entries = fs.readdirSync(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".posse") continue;
      const relPath = toPosix(path.join(relDir, entry.name));
      if (entry.isDirectory()) {
        out.push(`${relPath}/`);
        if (depth < maxDepth) visit(path.join(absDir, entry.name), relPath, depth + 1);
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  };
  visit(rootAbs, rootRel, 1);
  return out;
}

async function walkDepthAsync(rootAbs, rootRel, maxDepth = 2) {
  const out = [];
  const visit = async (absDir, relDir, depth) => {
    let entries = [];
    try {
      entries = await fs.promises.readdir(absDir, { withFileTypes: true });
    } catch {
      return;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".posse") continue;
      const relPath = toPosix(path.join(relDir, entry.name));
      if (entry.isDirectory()) {
        out.push(`${relPath}/`);
        if (depth < maxDepth) await visit(path.join(absDir, entry.name), relPath, depth + 1);
      } else if (entry.isFile()) {
        out.push(relPath);
      }
    }
  };
  await visit(rootAbs, rootRel, 1);
  return out;
}

function moduleNameForLibPath(relPath) {
  const normalized = toPosix(relPath);
  if (!normalized.startsWith("lib/")) return null;
  const rest = normalized.slice("lib/".length).replace(/\/$/, "");
  if (!rest) return null;
  const first = rest.split("/")[0];
  return first.replace(/\.[^.]+$/, "") || null;
}

function buildModules(libEntries) {
  const modules = {};
  const aliases = {};
  for (const entry of libEntries) {
    const moduleName = moduleNameForLibPath(entry);
    if (!moduleName) continue;
    if (!modules[moduleName]) modules[moduleName] = [];
    modules[moduleName].push(entry);

    if (!aliases[moduleName]) aliases[moduleName] = [`lib/${moduleName}`];
    aliases[moduleName].push(entry.replace(/\/$/, ""));
    if (entry.endsWith("/")) aliases[moduleName].push(entry);
  }

  for (const key of Object.keys(modules)) {
    modules[key] = uniqueSorted(modules[key]);
    aliases[key] = uniqueSorted(aliases[key]);
  }
  return { modules, module_aliases: aliases };
}

function readTopLevel(projectDir) {
  try {
    return fs.readdirSync(projectDir, { withFileTypes: true })
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

async function readTopLevelAsync(projectDir) {
  try {
    const entries = await fs.promises.readdir(projectDir, { withFileTypes: true });
    return entries
      .filter((entry) => !entry.name.startsWith(".") && entry.name !== "node_modules")
      .map((entry) => entry.isDirectory() ? `${entry.name}/` : entry.name)
      .sort((a, b) => a.localeCompare(b));
  } catch {
    return [];
  }
}

function isStringArray(value) {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isStringArrayRecord(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  return Object.values(value).every(isStringArray);
}

function isProjectMapShape(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  if (typeof value.generated_at !== "string") return false;
  if (!(typeof value.head_sha === "string" || value.head_sha == null)) return false;
  if (!isStringArray(value.top_level)) return false;
  if (!isStringArrayRecord(value.modules)) return false;
  if (!isStringArrayRecord(value.module_aliases)) return false;
  return true;
}

function readCache(projectDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(projectMapPath(projectDir), "utf8"));
    return isProjectMapShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

async function readCacheAsync(projectDir) {
  try {
    const parsed = JSON.parse(await fs.promises.readFile(projectMapPath(projectDir), "utf8"));
    return isProjectMapShape(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmpPath = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmpPath, JSON.stringify(value, null, 2), "utf8");
    fs.renameSync(tmpPath, file);
  } catch (err) {
    try { fs.rmSync(tmpPath, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

async function writeJsonAtomicAsync(file, value) {
  await fs.promises.mkdir(path.dirname(file), { recursive: true });
  const tmpPath = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    await fs.promises.writeFile(tmpPath, JSON.stringify(value, null, 2), "utf8");
    await fs.promises.rename(tmpPath, file);
  } catch (err) {
    try { await fs.promises.rm(tmpPath, { force: true }); } catch { /* ignore */ }
    throw err;
  }
}

export function generateProjectMap(projectDir, { execImpl = spawnSync } = {}) {
  const root = normalizeProjectDir(projectDir);
  const scanned = {};
  for (const relRoot of SCAN_ROOTS) {
    const absRoot = path.join(root, relRoot);
    scanned[relRoot] = fs.existsSync(absRoot)
      ? walkDepth(absRoot, relRoot, 2)
      : [];
  }
  const { modules, module_aliases } = buildModules(scanned.lib || []);
  return {
    generated_at: new Date().toISOString(),
    head_sha: currentGitHead(root, execImpl),
    top_level: readTopLevel(root),
    modules,
    module_aliases,
  };
}

export async function generateProjectMapAsync(projectDir) {
  const root = normalizeProjectDir(projectDir);
  const scanned = {};
  await Promise.all(SCAN_ROOTS.map(async (relRoot) => {
    const absRoot = path.join(root, relRoot);
    scanned[relRoot] = await walkDepthAsync(absRoot, relRoot, 2);
  }));
  const { modules, module_aliases } = buildModules(scanned.lib || []);
  return {
    generated_at: new Date().toISOString(),
    head_sha: await currentGitHeadAsync(root),
    top_level: await readTopLevelAsync(root),
    modules,
    module_aliases,
  };
}

export function getCachedProjectMap(projectDir) {
  return readCache(projectDir);
}

export async function getCachedProjectMapAsync(projectDir) {
  return await readCacheAsync(projectDir);
}

export function ensureProjectMap(projectDir, { force = false, execImpl = spawnSync } = {}) {
  const root = normalizeProjectDir(projectDir);
  const currentHead = currentGitHead(root, execImpl);
  const cached = force ? null : readCache(root);
  if (cached && (currentHead == null || cached.head_sha === currentHead)) {
    return cached;
  }
  const map = generateProjectMap(root, { execImpl });
  writeJsonAtomic(projectMapPath(root), map);
  return map;
}

export async function ensureProjectMapAsync(projectDir, { force = false } = {}) {
  const root = normalizeProjectDir(projectDir);
  const currentHead = await currentGitHeadAsync(root);
  const cached = force ? null : await readCacheAsync(root);
  if (cached && (currentHead == null || cached.head_sha === currentHead)) {
    return cached;
  }
  const map = await generateProjectMapAsync(root);
  await writeJsonAtomicAsync(projectMapPath(root), map);
  return map;
}

function resolveGitHooksDir(cwd, execImpl = spawnSync) {
  const resolvedCwd = normalizeProjectDir(cwd);
  try {
    const out = execImpl("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: resolvedCwd,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    }) || {};
    if (Number.isInteger(out.status) && out.status !== 0) return null;
    const raw = String(out.stdout || "").trim();
    return raw ? path.resolve(resolvedCwd, raw) : null;
  } catch {
    return null;
  }
}

async function resolveGitHooksDirAsync(cwd) {
  const resolvedCwd = normalizeProjectDir(cwd);
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "--git-path", "hooks"], {
      cwd: resolvedCwd,
      encoding: "utf8",
      timeout: 10000,
      windowsHide: true,
    });
    const raw = String(stdout || "").trim();
    return raw ? path.resolve(resolvedCwd, raw) : null;
  } catch {
    return null;
  }
}

function stripManagedHookBlock(content = "", beginMarker = HOOK_BEGIN, endMarker = HOOK_END) {
  const begin = content.indexOf(beginMarker);
  if (begin === -1) return content;
  const end = content.indexOf(endMarker, begin);
  if (end === -1) return content.slice(0, begin).trimEnd();
  const before = content.slice(0, begin).trimEnd();
  const after = content.slice(end + endMarker.length).trimStart();
  return [before, after].filter(Boolean).join("\n\n");
}

function shQuote(value) {
  return `'${toPosix(value).replace(/'/g, "'\"'\"'")}'`;
}

function fastHooksDir(projectDir) {
  // Mirrors fastInfoExcludePath: for ordinary (non-worktree) repos, the hooks
  // dir is at a deterministic path and we can skip the git subprocess.
  const gitPath = path.join(projectDir, ".git");
  let stat;
  try { stat = fs.statSync(gitPath); } catch { return null; }
  if (!stat.isDirectory()) return null;
  return path.join(gitPath, "hooks");
}

async function fastHooksDirAsync(projectDir) {
  const gitPath = path.join(projectDir, ".git");
  let stat;
  try { stat = await fs.promises.stat(gitPath); } catch { return null; }
  if (!stat.isDirectory()) return null;
  return path.join(gitPath, "hooks");
}

function buildHookBlock(repoCwd) {
  const modulePath = fileURLToPath(import.meta.url);
  return [
    HOOK_BEGIN,
    "# Auto-generated by Posse. Refreshes .posse/project-map.json after each commit.",
    // resolveGitHooksDir returns the shared common-dir hooks, so this managed
    // block can fire for a commit that belongs to a sibling worktree or a
    // different project sharing the repo. Only rebuild when the commit's repo
    // (toplevel) owns this project: repoCwd is at or under the committing
    // worktree root. The sibling ATLAS hook guards the same way; we use an
    // ownership match instead of strict equality so a nested project under the
    // toplevel still rebuilds rather than being over-skipped.
    `POSSE_MAP_HOOK_TOP=$(git rev-parse --show-toplevel 2>/dev/null || pwd)`,
    `case ${shQuote(repoCwd)} in`,
    `  "$POSSE_MAP_HOOK_TOP"|"$POSSE_MAP_HOOK_TOP"/*)`,
    `    (`,
    `      cd ${shQuote(repoCwd)} || exit 0`,
    `      NODE_BIN="node"`,
    `      "$NODE_BIN" ${shQuote(modulePath)} ${shQuote(repoCwd)} || ${shQuote(process.execPath)} ${shQuote(modulePath)} ${shQuote(repoCwd)}`,
    `    ) >/dev/null 2>&1 || true`,
    `    ;;`,
    `esac`,
    HOOK_END,
  ].join("\n");
}

export function ensureProjectMapRebuildHook({
  cwd = null,
  execImpl = spawnSync,
  resolveHooksDirImpl = resolveGitHooksDir,
} = {}) {
  const repoCwd = normalizeProjectDir(cwd);

  // Fast path: ordinary repo with an already-installed managed hook block.
  // Skips git rev-parse and the rewrite entirely on the steady-state path.
  const fastDir = fastHooksDir(repoCwd);
  if (fastDir) {
    const fastHookPath = path.join(fastDir, "post-commit");
    try {
      const existing = fs.readFileSync(fastHookPath, "utf8");
      if (existing.includes(HOOK_BEGIN) && existing.includes(HOOK_END) && existing.includes(buildHookBlock(repoCwd))) {
        return { attempted: true, ok: true, hookPath: fastHookPath, changed: false };
      }
    } catch { /* fall through to slow path */ }
  }

  const hooksDir = resolveHooksDirImpl(repoCwd, execImpl);
  if (!hooksDir) return { attempted: false, skipped: "not_git_repo" };

  const hookPath = path.join(hooksDir, "post-commit");
  const block = buildHookBlock(repoCwd);

  try {
    fs.mkdirSync(hooksDir, { recursive: true });
    const existing = fs.existsSync(hookPath) ? fs.readFileSync(hookPath, "utf8") : "";
    const stripped = stripManagedHookBlock(existing);
    const prefix = stripped.trim() ? `${stripped.trimEnd()}\n\n` : "#!/bin/sh\n\n";
    const next = `${prefix}${block}\n`;
    const changed = next !== existing;
    if (changed) {
      const tmpPath = `${hookPath}.${process.pid}.${Date.now()}.tmp`;
      fs.writeFileSync(tmpPath, next, "utf8");
      try { fs.chmodSync(tmpPath, 0o755); } catch { /* ignore */ }
      fs.renameSync(tmpPath, hookPath);
    } else {
      try { fs.chmodSync(hookPath, 0o755); } catch { /* ignore */ }
    }
    return { attempted: true, ok: true, hookPath, changed };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      hookPath,
      error: String(err?.message || err || "unknown"),
    };
  }
}

export async function ensureProjectMapRebuildHookAsync({
  cwd = null,
} = {}) {
  const repoCwd = normalizeProjectDir(cwd);

  const fastDir = await fastHooksDirAsync(repoCwd);
  if (fastDir) {
    const fastHookPath = path.join(fastDir, "post-commit");
    try {
      const existing = await fs.promises.readFile(fastHookPath, "utf8");
      if (existing.includes(HOOK_BEGIN) && existing.includes(HOOK_END) && existing.includes(buildHookBlock(repoCwd))) {
        return { attempted: true, ok: true, hookPath: fastHookPath, changed: false };
      }
    } catch { /* fall through to slow path */ }
  }

  const hooksDir = await resolveGitHooksDirAsync(repoCwd);
  if (!hooksDir) return { attempted: false, skipped: "not_git_repo" };

  const hookPath = path.join(hooksDir, "post-commit");
  const block = buildHookBlock(repoCwd);

  try {
    await fs.promises.mkdir(hooksDir, { recursive: true });
    let existing = "";
    try { existing = await fs.promises.readFile(hookPath, "utf8"); } catch { /* missing hook */ }
    const stripped = stripManagedHookBlock(existing);
    const prefix = stripped.trim() ? `${stripped.trimEnd()}\n\n` : "#!/bin/sh\n\n";
    const next = `${prefix}${block}\n`;
    const changed = next !== existing;
    if (changed) {
      const tmpPath = `${hookPath}.${process.pid}.${Date.now()}.tmp`;
      await fs.promises.writeFile(tmpPath, next, "utf8");
      try { await fs.promises.chmod(tmpPath, 0o755); } catch { /* ignore */ }
      await fs.promises.rename(tmpPath, hookPath);
    } else {
      try { await fs.promises.chmod(hookPath, 0o755); } catch { /* ignore */ }
    }
    return { attempted: true, ok: true, hookPath, changed };
  } catch (err) {
    return {
      attempted: true,
      ok: false,
      hookPath,
      error: String(err?.message || err || "unknown"),
    };
  }
}

const invokedPath = process.argv[1] ? path.resolve(process.argv[1]) : null;
if (invokedPath && invokedPath === fileURLToPath(import.meta.url)) {
  try {
    ensureProjectMap(process.argv[2] || process.cwd(), { force: true });
  } catch {
    process.exitCode = 0;
  }
}
