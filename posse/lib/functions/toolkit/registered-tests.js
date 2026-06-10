import crypto from "crypto";
import fs from "fs";
import os from "os";
import path from "path";
import { spawnSync } from "child_process";

import { scrubSecrets } from "../../shared/telemetry/classes/logging/secret-scrub.js";
import { getDb } from "../../shared/storage/functions/index.js";
import { resolveManagedPythonRuntimeForProject } from "../../domains/runtime/functions/python-runtime.js";
import { createWorkspaceSkipDirs } from "../../domains/runtime/functions/workspace-skip.js";

const SUPPORTED_LANGUAGES = new Set(["javascript", "node", "js", "python", "py"]);
const JS_LANGUAGES = new Set(["javascript", "node", "js"]);
const PY_LANGUAGES = new Set(["python", "py"]);
const MAX_NAME_CHARS = 120;
const MAX_EXPLANATION_CHARS = 4000;
const MAX_SOURCE_CHARS = 120000;
const MAX_FAILURE_CHARS = 6000;
const MAX_TARGET_FILES = 80;
const MAX_TARGET_SYMBOLS = 120;
const MAX_TARGET_IMPORTS = 80;
const DEFAULT_TIMEOUT_MS = 30000;
const WORKSPACE_AUDIT_MAX_FILE_BYTES = 50 * 1024 * 1024;
const WORKSPACE_AUDIT_MAX_TOTAL_BYTES = 250 * 1024 * 1024;
const WORKSPACE_AUDIT_SKIP_DIRS = createWorkspaceSkipDirs();
const REGISTERED_TEST_ENV_ALLOWLIST = new Set([
  "allusersprofile",
  "appdata",
  "ci",
  "comspec",
  "home",
  "homedrive",
  "homepath",
  "lang",
  "lc_all",
  "lc_ctype",
  "localappdata",
  "logname",
  "no_color",
  "os",
  "path",
  "pathext",
  "programdata",
  "programfiles",
  "programfiles(x86)",
  "programw6432",
  "systemdrive",
  "systemroot",
  "temp",
  "term",
  "tmp",
  "tmpdir",
  "user",
  "userdomain",
  "username",
  "userprofile",
  "windir",
]);

function nowIso() {
  return new Date().toISOString();
}

function compact(value, max = MAX_FAILURE_CHARS) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated ${text.length - max} chars)`;
}

function compactScrubbed(value, max = MAX_FAILURE_CHARS) {
  return compact(scrubSecrets(String(value ?? "")), max);
}

function hashBuffer(buffer) {
  return crypto.createHash("sha256").update(buffer).digest("hex");
}

function workspaceRel(root, fullPath) {
  return path.relative(root, fullPath).replace(/\\/g, "/").replace(/^\.\//, "");
}

function safeWorkspacePath(root, rel) {
  const resolved = path.resolve(root, rel);
  const relative = path.relative(root, resolved);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return null;
  return resolved;
}

function captureWorkspaceEntry(fullPath, stat, auditState) {
  if (stat.isSymbolicLink()) {
    let target = "";
    try { target = fs.readlinkSync(fullPath); } catch { target = ""; }
    return {
      type: "symlink",
      target,
      mode: stat.mode,
    };
  }
  if (!stat.isFile()) return null;
  const entry = {
    type: "file",
    mode: stat.mode,
    mtimeMs: stat.mtimeMs,
    ctimeMs: stat.ctimeMs,
    size: stat.size,
    backedUp: false,
    fingerprint: `${stat.size}:${Math.round(stat.mtimeMs || 0)}:${Math.round(stat.ctimeMs || 0)}`,
  };
  if (stat.size <= WORKSPACE_AUDIT_MAX_FILE_BYTES && auditState.totalBytes + stat.size <= WORKSPACE_AUDIT_MAX_TOTAL_BYTES) {
    const content = fs.readFileSync(fullPath);
    auditState.totalBytes += content.length;
    entry.sha256 = hashBuffer(content);
    entry.content = content;
    entry.backedUp = true;
  }
  return entry;
}

function snapshotWorkspace(root) {
  const workspace = path.resolve(root || process.cwd());
  const files = new Map();
  const dirs = new Set();
  const auditState = { totalBytes: 0 };
  const stack = [workspace];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries = [];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (err) {
      throw new Error(`workspace audit could not read ${workspaceRel(workspace, dir) || "."}: ${err?.message || err}`);
    }
    for (const entry of entries) {
      if (entry.isDirectory() && WORKSPACE_AUDIT_SKIP_DIRS.has(entry.name)) continue;
      const fullPath = path.join(dir, entry.name);
      const rel = workspaceRel(workspace, fullPath);
      if (entry.isDirectory()) {
        dirs.add(rel);
        stack.push(fullPath);
        continue;
      }
      if (!entry.isFile() && !entry.isSymbolicLink()) continue;
      let stat;
      try {
        stat = fs.lstatSync(fullPath);
      } catch {
        continue;
      }
      const captured = captureWorkspaceEntry(fullPath, stat, auditState);
      if (captured) files.set(rel, captured);
    }
  }
  return { root: workspace, files, dirs };
}

function workspaceEntryChanged(before, after) {
  if (!before || !after || before.type !== after.type) return true;
  if (before.type === "symlink") return before.target !== after.target;
  if (before.sha256 && after.sha256) return before.sha256 !== after.sha256;
  return before.fingerprint !== after.fingerprint;
}

function workspaceSnapshotChanges(before, after) {
  const changes = [];
  for (const [rel, beforeEntry] of before.files) {
    const afterEntry = after.files.get(rel);
    if (!afterEntry) changes.push({ kind: "deleted", rel, before: beforeEntry });
    else if (workspaceEntryChanged(beforeEntry, afterEntry)) changes.push({ kind: "modified", rel, before: beforeEntry, after: afterEntry });
  }
  for (const [rel, afterEntry] of after.files) {
    if (!before.files.has(rel)) changes.push({ kind: "created", rel, after: afterEntry });
  }
  return changes.sort((a, b) => a.rel.localeCompare(b.rel));
}

function restoreWorkspaceEntry(root, rel, entry) {
  const fullPath = safeWorkspacePath(root, rel);
  if (!fullPath) return;
  fs.mkdirSync(path.dirname(fullPath), { recursive: true });
  try { fs.rmSync(fullPath, { recursive: true, force: true }); } catch { /* best effort before restore */ }
  if (entry.type === "symlink") {
    fs.symlinkSync(entry.target, fullPath);
    return;
  }
  if (!entry.backedUp || !entry.content) {
    throw new Error(`original content was not captured for ${rel}`);
  }
  fs.writeFileSync(fullPath, entry.content);
  try { fs.chmodSync(fullPath, entry.mode); } catch { /* best effort */ }
  try {
    const mtime = new Date(Number(entry.mtimeMs) || Date.now());
    fs.utimesSync(fullPath, mtime, mtime);
  } catch {
    // Best-effort metadata restore; content is the important part.
  }
}

function revertWorkspaceChanges(before, after, changes) {
  const root = before.root;
  let reverted = 0;
  let failed = 0;
  for (const change of changes) {
    const fullPath = safeWorkspacePath(root, change.rel);
    if (!fullPath) continue;
    try {
      if (change.kind === "created") {
        fs.rmSync(fullPath, { recursive: true, force: true });
      } else {
        restoreWorkspaceEntry(root, change.rel, change.before);
      }
      reverted++;
    } catch {
      failed++;
    }
  }
  const createdDirs = [...after.dirs].filter((rel) => !before.dirs.has(rel)).sort((a, b) => b.length - a.length);
  for (const rel of createdDirs) {
    const fullPath = safeWorkspacePath(root, rel);
    if (!fullPath) continue;
    try { fs.rmdirSync(fullPath); } catch { /* leave non-empty dirs */ }
  }
  return { reverted, failed };
}

function summarizeWorkspaceChanges(changes) {
  const preview = changes.slice(0, 10).map((change) => `${change.rel} (${change.kind})`).join(", ");
  const suffix = changes.length > 10 ? `, +${changes.length - 10} more` : "";
  return `${preview}${suffix}`;
}

function buildRegisteredTestEnv(baseEnv = process.env) {
  const env = {};
  for (const [key, value] of Object.entries(baseEnv || {})) {
    if (!REGISTERED_TEST_ENV_ALLOWLIST.has(String(key || "").toLowerCase())) continue;
    env[key] = value;
  }
  return env;
}

function normalizeName(value, label = "name") {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) throw new Error(`${label} is required.`);
  if (text.length > MAX_NAME_CHARS) throw new Error(`${label} exceeds ${MAX_NAME_CHARS} characters.`);
  return text;
}

function normalizeOptionalText(value, label, max = MAX_EXPLANATION_CHARS) {
  const text = String(value || "").trim();
  if (text.length > max) throw new Error(`${label} exceeds ${max} characters.`);
  return text;
}

function slugify(value) {
  const slug = String(value || "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || crypto.randomBytes(4).toString("hex");
}

function sourceHash(source) {
  return crypto.createHash("sha256").update(String(source || ""), "utf8").digest("hex");
}

function normalizeLanguage(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) throw new Error("language is required.");
  if (!SUPPORTED_LANGUAGES.has(raw)) {
    throw new Error(`Unsupported test language '${value}'. Supported: javascript, python.`);
  }
  if (JS_LANGUAGES.has(raw)) return "javascript";
  if (PY_LANGUAGES.has(raw)) return "python";
  return raw;
}

function normalizeSource(value) {
  const source = String(value || "").trim();
  if (!source) throw new Error("test source is required.");
  if (source.length > MAX_SOURCE_CHARS) throw new Error(`test source exceeds ${MAX_SOURCE_CHARS} characters.`);
  return source;
}

function normalizeFunctionName(value) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) {
    throw new Error("function_name must be a valid identifier.");
  }
  return text;
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === "") return [];
  try {
    const parsed = JSON.parse(String(value));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function normalizeWorkspacePath(cwd, value, label = "path") {
  const raw = String(value || "").replace(/\0/g, "").trim();
  if (!raw) throw new Error(`${label} is required.`);
  const root = path.resolve(cwd || process.cwd());
  const resolved = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  const rel = path.relative(root, resolved).replace(/\\/g, "/").replace(/^\.\//, "");
  if (!rel || rel === "." || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel) || /^[A-Za-z]:\//.test(rel)) {
    throw new Error(`${label} must stay inside the workspace.`);
  }
  const first = rel.split("/")[0];
  if ([".git", ".posse", ".posse-worktrees", ".posse-test-suites"].includes(first)) {
    throw new Error(`${label} must refer to production/testable workspace files, not private Posse metadata.`);
  }
  return rel;
}

function normalizePathList(cwd, values, label, { required = false, max = MAX_TARGET_FILES } = {}) {
  const list = Array.isArray(values) ? values : [];
  const out = [];
  const seen = new Set();
  for (const value of list) {
    const rel = normalizeWorkspacePath(cwd, value, label);
    if (seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
    if (out.length > max) throw new Error(`${label} exceeds ${max} entries.`);
  }
  if (required && out.length === 0) {
    throw new Error(`${label} is required and must include at least one workspace-relative file.`);
  }
  return out;
}

function normalizeSymbolList(values, label = "target_symbols") {
  const list = Array.isArray(values) ? values : [];
  const out = [];
  const seen = new Set();
  for (const value of list) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) continue;
    if (text.length > MAX_NAME_CHARS) throw new Error(`${label} entries must be ${MAX_NAME_CHARS} characters or fewer.`);
    if (seen.has(text)) continue;
    seen.add(text);
    out.push(text);
    if (out.length > MAX_TARGET_SYMBOLS) throw new Error(`${label} exceeds ${MAX_TARGET_SYMBOLS} entries.`);
  }
  return out;
}

function normalizeIdentifierHint(value, label) {
  const text = String(value || "").trim();
  if (!text) return "";
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(text)) {
    throw new Error(`${label} must be a valid identifier.`);
  }
  return text;
}

function normalizeTargetImports(cwd, values) {
  const list = Array.isArray(values) ? values : [];
  const out = [];
  const seen = new Set();
  for (const entry of list) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error("target_imports entries must be objects.");
    }
    const importPath = normalizeWorkspacePath(cwd, entry.path, "target_imports.path");
    const symbols = normalizeSymbolList(entry.symbols || entry.named || [], "target_imports.symbols");
    const defaultExport = normalizeIdentifierHint(entry.default || entry.default_export, "target_imports.default");
    const namespace = normalizeIdentifierHint(entry.namespace, "target_imports.namespace");
    const key = JSON.stringify([importPath, symbols, defaultExport, namespace]);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      path: importPath,
      symbols,
      ...(defaultExport ? { default: defaultExport } : {}),
      ...(namespace ? { namespace } : {}),
    });
    if (out.length > MAX_TARGET_IMPORTS) throw new Error(`target_imports exceeds ${MAX_TARGET_IMPORTS} entries.`);
  }
  return out;
}

function normalizeScopeFiles(cwd, scopeFiles = []) {
  try {
    return normalizePathList(cwd, scopeFiles, "scope_files", { required: false, max: 500 });
  } catch {
    return [];
  }
}

function targetFilesForRow(row) {
  return parseJsonArray(row?.target_files_json).map((value) => String(value || "")).filter(Boolean);
}

function targetFilesOverlapScope(rowOrFiles, scopeFiles = []) {
  const normalizedScope = Array.isArray(scopeFiles) ? scopeFiles.map((value) => String(value || "").replace(/\\/g, "/")).filter(Boolean) : [];
  if (normalizedScope.length === 0) return true;
  const scopeSet = new Set(normalizedScope);
  const targets = Array.isArray(rowOrFiles) ? rowOrFiles : targetFilesForRow(rowOrFiles);
  if (targets.length === 0) return false;
  return targets.some((file) => scopeSet.has(file));
}

function assertTargetsWithinScope(targetFiles, scopeFiles = []) {
  const normalizedScope = Array.isArray(scopeFiles) ? scopeFiles.map((value) => String(value || "").replace(/\\/g, "/")).filter(Boolean) : [];
  if (normalizedScope.length === 0) return;
  const scopeSet = new Set(normalizedScope);
  const outside = targetFiles.filter((file) => !scopeSet.has(file));
  if (outside.length > 0) {
    throw new Error(`target_files must be within the declared job file scope; outside scope: ${outside.join(", ")}`);
  }
}

function ensureColumn(db, tableName, columnName, ddl) {
  const columns = db.prepare(`PRAGMA table_info(${tableName})`).all().map((column) => column.name);
  if (columns.includes(columnName)) return;
  db.prepare(`ALTER TABLE ${tableName} ADD COLUMN ${ddl}`).run();
}

function testSuitesRoot(cwd) {
  return path.join(path.resolve(cwd || process.cwd()), ".posse-test-suites");
}

function ensureSuiteMirror(cwd, suite) {
  const suiteDir = path.join(testSuitesRoot(cwd), "suites", suite.slug);
  fs.mkdirSync(suiteDir, { recursive: true, mode: 0o700 });
  const manifest = {
    id: suite.id,
    name: suite.name,
    slug: suite.slug,
    explanation: suite.explanation || "",
    updated_at: suite.updated_at || nowIso(),
  };
  fs.writeFileSync(path.join(suiteDir, "suite.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

export function ensureRegisteredTestTables(db = getDb()) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS posse_test_suites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      slug TEXT NOT NULL UNIQUE,
      explanation TEXT NOT NULL DEFAULT '',
      created_by_role TEXT,
      created_by_job_id INTEGER,
      created_by_work_item_id INTEGER,
      metadata_json TEXT CHECK (metadata_json IS NULL OR json_valid(metadata_json)),
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (created_by_job_id) REFERENCES jobs(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by_work_item_id) REFERENCES work_items(id) ON DELETE SET NULL
    );

    CREATE TABLE IF NOT EXISTS posse_tests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suite_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      slug TEXT NOT NULL,
      explanation TEXT NOT NULL DEFAULT '',
      language TEXT NOT NULL CHECK (language IN ('javascript','python')),
      function_name TEXT,
      source TEXT NOT NULL,
      source_sha256 TEXT NOT NULL,
      target_files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_files_json)),
      target_symbols_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_symbols_json)),
      target_imports_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_imports_json)),
      status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','disabled')),
      last_run_json TEXT CHECK (last_run_json IS NULL OR json_valid(last_run_json)),
      created_by_role TEXT,
      created_by_job_id INTEGER,
      created_by_work_item_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (suite_id) REFERENCES posse_test_suites(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_job_id) REFERENCES jobs(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by_work_item_id) REFERENCES work_items(id) ON DELETE SET NULL,
      UNIQUE (suite_id, slug)
    );

    CREATE TABLE IF NOT EXISTS posse_test_runs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      suite_id INTEGER NOT NULL,
      test_id INTEGER,
      ok INTEGER NOT NULL CHECK (ok IN (0,1)),
      duration_ms INTEGER NOT NULL DEFAULT 0,
      failure_json TEXT CHECK (failure_json IS NULL OR json_valid(failure_json)),
      created_by_role TEXT,
      created_by_job_id INTEGER,
      created_by_work_item_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
      FOREIGN KEY (suite_id) REFERENCES posse_test_suites(id) ON DELETE CASCADE,
      FOREIGN KEY (test_id) REFERENCES posse_tests(id) ON DELETE CASCADE,
      FOREIGN KEY (created_by_job_id) REFERENCES jobs(id) ON DELETE SET NULL,
      FOREIGN KEY (created_by_work_item_id) REFERENCES work_items(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_posse_tests_suite_status
      ON posse_tests(suite_id, status, created_at);
    CREATE INDEX IF NOT EXISTS idx_posse_test_runs_suite
      ON posse_test_runs(suite_id, created_at);
    CREATE INDEX IF NOT EXISTS idx_posse_test_runs_test
      ON posse_test_runs(test_id, created_at);
  `);
  ensureColumn(db, "posse_tests", "target_files_json", "target_files_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_files_json))");
  ensureColumn(db, "posse_tests", "target_symbols_json", "target_symbols_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_symbols_json))");
  ensureColumn(db, "posse_tests", "target_imports_json", "target_imports_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(target_imports_json))");
}

function suitePublic(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    explanation: row.explanation || "",
  };
}

function testPublic(row, suite = null) {
  if (!row) return null;
  return {
    id: row.id,
    suite_id: row.suite_id,
    suite: suite ? suitePublic(suite) : undefined,
    name: row.name,
    slug: row.slug,
    language: row.language,
    function_name: row.function_name || null,
    explanation: row.explanation || "",
    target_files: parseJsonArray(row.target_files_json),
    target_symbols: parseJsonArray(row.target_symbols_json),
    target_imports: parseJsonArray(row.target_imports_json),
    source_sha256: row.source_sha256,
  };
}

function resolveSuite(db, args = {}) {
  ensureRegisteredTestTables(db);
  const suiteId = Number(args.suite_id ?? args.suiteId ?? "");
  if (Number.isInteger(suiteId) && suiteId > 0) {
    return db.prepare(`SELECT * FROM posse_test_suites WHERE id = ?`).get(suiteId) || null;
  }
  const suiteName = String(args.suite ?? args.suite_name ?? args.suiteName ?? "").trim();
  if (!suiteName) return null;
  return db.prepare(`
    SELECT * FROM posse_test_suites
    WHERE name = ? OR slug = ?
    ORDER BY id
    LIMIT 1
  `).get(suiteName, slugify(suiteName)) || null;
}

function resolveTest(db, args = {}) {
  ensureRegisteredTestTables(db);
  const testId = Number(args.test_id ?? args.testId ?? "");
  if (Number.isInteger(testId) && testId > 0) {
    return db.prepare(`SELECT * FROM posse_tests WHERE id = ? AND status = 'active'`).get(testId) || null;
  }
  const suite = resolveSuite(db, args);
  if (!suite) return null;
  const testName = String(args.test ?? args.test_name ?? args.testName ?? args.name ?? "").trim();
  if (!testName) return null;
  return db.prepare(`
    SELECT * FROM posse_tests
    WHERE suite_id = ?
      AND status = 'active'
      AND (name = ? OR slug = ?)
    ORDER BY id
    LIMIT 1
  `).get(suite.id, testName, slugify(testName)) || null;
}

const JS_RUNNER = `
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const sourcePath = process.env.POSSE_TEST_SOURCE_PATH;
const functionName = process.env.POSSE_TEST_FUNCTION_NAME || "";
const workspace = process.env.POSSE_TEST_WORKSPACE;
const tmp = process.env.POSSE_TEST_TMP;
const targetFiles = JSON.parse(process.env.POSSE_TEST_TARGET_FILES || "[]");
const targetSymbols = JSON.parse(process.env.POSSE_TEST_TARGET_SYMBOLS || "[]");
const targetImports = JSON.parse(process.env.POSSE_TEST_TARGET_IMPORTS || "[]");
process.chdir(tmp);

function fail(message, err) {
  if (err?.stack) console.error(err.stack);
  else console.error(message || String(err || "test failed"));
  process.exit(1);
}

async function resolveFn(source) {
  if (functionName || /\\bexport\\b/.test(source)) {
    try {
      const mod = await import(pathToFileURL(sourcePath).href);
      const fn = functionName ? mod[functionName] : mod.default;
      if (typeof fn === "function") return fn;
    } catch (err) {
      if (/\\bexport\\b/.test(source)) throw err;
    }
  }
  try {
    const fn = (0, eval)(\`(\${source})\`);
    if (typeof fn === "function") return fn;
  } catch {
    // Try declaration-style source below.
  }
  const fallbackName = functionName || "test";
  try {
    const fn = (0, eval)(\`\${source}\\n;\${fallbackName}\`);
    if (typeof fn === "function") return fn;
  } catch (err) {
    throw new Error(\`Could not resolve test function '\${fallbackName}': \${err?.message || err}\`);
  }
  throw new Error(\`Could not resolve test function '\${fallbackName}'.\`);
}

function resolveWorkspacePath(relPath) {
  const full = path.resolve(workspace, String(relPath || ""));
  const rel = path.relative(workspace, full).replace(/\\\\/g, "/");
  if (!rel || rel === ".." || rel.startsWith("../") || path.isAbsolute(rel) || /^[A-Za-z]:\\//.test(rel)) {
    throw new Error(\`Target path escapes workspace: \${relPath}\`);
  }
  return full;
}

try {
  const source = fs.readFileSync(sourcePath, "utf8");
  const fn = await resolveFn(source);
  const context = {
    workspace,
    tmp,
    assert,
    fs,
    path,
    require,
    targetFiles,
    targetSymbols,
    targetImports,
    importModule: (specifier) => import(specifier),
    importTarget: (relPath) => import(pathToFileURL(resolveWorkspacePath(relPath)).href),
    requireTarget: (relPath) => require(resolveWorkspacePath(relPath)),
  };
  const result = await fn(context);
  if (result !== true) {
    throw new Error(\`Test returned \${JSON.stringify(result)}; expected true.\`);
  }
  console.log(JSON.stringify({ ok: true }));
} catch (err) {
  fail(err?.message, err);
}
`;

const PY_RUNNER = `
import asyncio
import importlib.util
import inspect
import json
import os
import pathlib
import sys

source_path = os.environ["POSSE_TEST_SOURCE_PATH"]
function_name = os.environ.get("POSSE_TEST_FUNCTION_NAME") or ""
workspace = os.environ["POSSE_TEST_WORKSPACE"]
tmp = os.environ["POSSE_TEST_TMP"]
target_files = json.loads(os.environ.get("POSSE_TEST_TARGET_FILES") or "[]")
target_symbols = json.loads(os.environ.get("POSSE_TEST_TARGET_SYMBOLS") or "[]")
target_imports = json.loads(os.environ.get("POSSE_TEST_TARGET_IMPORTS") or "[]")
os.chdir(tmp)
if workspace not in sys.path:
    sys.path.insert(0, workspace)

def resolve_workspace_path(rel_path):
    root = pathlib.Path(workspace).resolve()
    full = (root / str(rel_path or "")).resolve()
    try:
        full.relative_to(root)
    except ValueError:
        raise RuntimeError(f"Target path escapes workspace: {rel_path}")
    return full

def import_target(rel_path, module_name=None):
    full = resolve_workspace_path(rel_path)
    name = module_name or ("posse_target_" + "".join(ch if ch.isalnum() else "_" for ch in str(rel_path)))
    spec = importlib.util.spec_from_file_location(name, str(full))
    if spec is None or spec.loader is None:
        raise RuntimeError(f"Could not import target file: {rel_path}")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod

try:
    spec = importlib.util.spec_from_file_location("posse_registered_test", source_path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    fn = None
    if function_name:
        fn = getattr(mod, function_name, None)
    else:
        for candidate in ("test", "run", "main"):
            value = getattr(mod, candidate, None)
            if callable(value):
                fn = value
                break
    if not callable(fn):
        raise RuntimeError(f"Could not resolve test function '{function_name or 'test'}'.")
    context = {
        "workspace": workspace,
        "tmp": tmp,
        "pathlib": pathlib,
        "target_files": target_files,
        "target_symbols": target_symbols,
        "target_imports": target_imports,
        "import_target": import_target,
    }
    try:
        params = inspect.signature(fn).parameters
        result = fn(context) if len(params) > 0 else fn()
    except (TypeError, ValueError):
        result = fn(context)
    if inspect.isawaitable(result):
        result = asyncio.run(result)
    if result is not True:
        raise AssertionError(f"Test returned {result!r}; expected True.")
    print(json.dumps({"ok": True}))
except Exception as exc:
    import traceback
    traceback.print_exc()
    sys.exit(1)
`;

function resolvePythonCommand(cwd = process.cwd()) {
  const workspace = path.resolve(cwd || process.cwd());
  const managedRuntime = resolveManagedPythonRuntimeForProject({ projectDir: workspace });
  const candidates = [
    ...(managedRuntime?.ready ? [{ command: managedRuntime.python, args: [] }] : []),
    ...(process.platform === "win32"
      ? [
        { command: path.join(workspace, ".venv", "Scripts", "python.exe"), args: [] },
        { command: path.join(workspace, "venv", "Scripts", "python.exe"), args: [] },
      ]
      : [
        { command: path.join(workspace, ".venv", "bin", "python"), args: [] },
        { command: path.join(workspace, "venv", "bin", "python"), args: [] },
      ]),
    { command: "python", args: [] },
    { command: "python3", args: [] },
    { command: "py", args: ["-3"] },
  ];
  for (const candidate of candidates) {
    if (path.isAbsolute(candidate.command) && !fs.existsSync(candidate.command)) continue;
    const result = spawnSync(candidate.command, [...candidate.args, "--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 5000,
    });
    if ((result.status ?? 1) === 0) return candidate;
  }
  return null;
}

function cleanupTempDir(tmpDir) {
  if (!tmpDir) return true;
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return !fs.existsSync(tmpDir);
  } catch {
    return false;
  }
}

function runSource({
  cwd,
  source,
  language,
  functionName = "",
  targetFiles = [],
  targetSymbols = [],
  targetImports = [],
  timeoutMs = DEFAULT_TIMEOUT_MS,
} = {}) {
  const startedAt = Date.now();
  const workspace = path.resolve(cwd || process.cwd());
  let workspaceBefore;
  try {
    workspaceBefore = snapshotWorkspace(workspace);
  } catch (err) {
    return {
      ok: false,
      duration_ms: Date.now() - startedAt,
      tmp_cleaned: true,
      failure: {
        message: `workspace audit failed before test run: ${err?.message || String(err)}`,
        exit_code: null,
      },
    };
  }
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "posse-test-"));
  const sourcePath = path.join(root, language === "python" ? "test_source.py" : "test_source.mjs");
  const runnerPath = path.join(root, language === "python" ? "runner.py" : "runner.mjs");
  let response = null;
  try {
    fs.writeFileSync(sourcePath, source, "utf8");
    fs.writeFileSync(runnerPath, language === "python" ? PY_RUNNER : JS_RUNNER, "utf8");
    const env = {
      ...buildRegisteredTestEnv(process.env),
      POSSE_TEST_SOURCE_PATH: sourcePath,
      POSSE_TEST_WORKSPACE: workspace,
      POSSE_TEST_TMP: root,
      POSSE_TEST_FUNCTION_NAME: functionName || "",
      POSSE_TEST_TARGET_FILES: JSON.stringify(Array.isArray(targetFiles) ? targetFiles : []),
      POSSE_TEST_TARGET_SYMBOLS: JSON.stringify(Array.isArray(targetSymbols) ? targetSymbols : []),
      POSSE_TEST_TARGET_IMPORTS: JSON.stringify(Array.isArray(targetImports) ? targetImports : []),
    };
    const command = language === "python"
      ? resolvePythonCommand(workspace)
      : { command: process.execPath, args: [] };
    if (!command) {
      response = {
        ok: false,
        duration_ms: Date.now() - startedAt,
        tmp_cleaned: false,
        failure: { message: "Python is not available on PATH.", exit_code: null },
      };
      return response;
    }
    const result = spawnSync(command.command, [...command.args, runnerPath], {
      cwd: root,
      env,
      encoding: "utf8",
      windowsHide: true,
      timeout: Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
      maxBuffer: 8 * 1024 * 1024,
    });
    let ok = (result.status ?? 1) === 0 && !result.error;
    const failureText = compactScrubbed(`${result.stderr || ""}\n${result.stdout || ""}`);
    let stdout = ok ? compactScrubbed(result.stdout, 2000) : null;
    let failure = ok ? null : {
      message: result.error?.code === "ETIMEDOUT"
        ? `test timed out after ${timeoutMs}ms`
        : failureText || result.error?.message || `test exited ${result.status ?? "unknown"}`,
      exit_code: result.status ?? null,
      signal: result.signal || null,
      timed_out: result.error?.code === "ETIMEDOUT",
    };
    try {
      const workspaceAfter = snapshotWorkspace(workspace);
      const changes = workspaceSnapshotChanges(workspaceBefore, workspaceAfter);
      if (changes.length > 0) {
        const reverted = revertWorkspaceChanges(workspaceBefore, workspaceAfter, changes);
        ok = false;
        stdout = null;
        failure = {
          message: `registered test mutated workspace files; ${reverted.failed === 0 ? "changes were reverted" : "some changes could not be reverted"}: ${summarizeWorkspaceChanges(changes)}`,
          exit_code: result.status ?? null,
          workspace_mutation: true,
          changed_files: changes.map((change) => ({ path: change.rel, change: change.kind })).slice(0, 50),
          reverted_files: reverted.reverted,
          revert_failures: reverted.failed,
        };
      }
    } catch (err) {
      ok = false;
      stdout = null;
      failure = {
        message: `workspace audit failed after test run: ${err?.message || String(err)}`,
        exit_code: result.status ?? null,
        workspace_mutation: true,
      };
    }
    response = {
      ok,
      duration_ms: Date.now() - startedAt,
      stdout,
      tmp_cleaned: false,
      failure,
    };
    return response;
  } finally {
    const cleaned = cleanupTempDir(root);
    if (response) response.tmp_cleaned = cleaned;
  }
}

function runSourceWithCleanup(opts) {
  return runSource(opts);
}

function insertRun(db, { suiteId, testId = null, result, actor = {} }) {
  const failureJson = result.ok ? null : JSON.stringify(result.failure || {});
  const info = db.prepare(`
    INSERT INTO posse_test_runs (
      suite_id, test_id, ok, duration_ms, failure_json,
      created_by_role, created_by_job_id, created_by_work_item_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    suiteId,
    testId,
    result.ok ? 1 : 0,
    Number(result.duration_ms || 0),
    failureJson,
    actor.role || null,
    actor.jobId || null,
    actor.workItemId || null,
  );
  return info.lastInsertRowid;
}

function updateTestLastRun(db, testId, result) {
  db.prepare(`
    UPDATE posse_tests
    SET last_run_json = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
    WHERE id = ?
  `).run(JSON.stringify({
    ok: result.ok,
    duration_ms: result.duration_ms,
    failure: result.failure || null,
    ran_at: nowIso(),
  }), testId);
}

export function createRegisteredTestSuite({ args = {}, cwd, actor = {}, db = getDb() } = {}) {
  ensureRegisteredTestTables(db);
  const name = normalizeName(args.name ?? args.suite ?? args.suite_name, "suite name");
  const explanation = normalizeOptionalText(args.explanation ?? args.description, "explanation");
  const slug = slugify(args.slug || name);
  const existing = db.prepare(`SELECT * FROM posse_test_suites WHERE name = ? OR slug = ?`).get(name, slug);
  if (existing) {
    if (explanation && explanation !== existing.explanation) {
      db.prepare(`
        UPDATE posse_test_suites
        SET explanation = ?, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
        WHERE id = ?
      `).run(explanation, existing.id);
    }
    const row = db.prepare(`SELECT * FROM posse_test_suites WHERE id = ?`).get(existing.id);
    ensureSuiteMirror(cwd, row);
    return {
      ok: true,
      summary: "test suite already registered",
      created: false,
      suite: suitePublic(row),
    };
  }

  const info = db.prepare(`
    INSERT INTO posse_test_suites (
      name, slug, explanation, created_by_role, created_by_job_id, created_by_work_item_id
    ) VALUES (?, ?, ?, ?, ?, ?)
  `).run(
    name,
    slug,
    explanation,
    actor.role || null,
    actor.jobId || null,
    actor.workItemId || null,
  );
  const row = db.prepare(`SELECT * FROM posse_test_suites WHERE id = ?`).get(info.lastInsertRowid);
  ensureSuiteMirror(cwd, row);
  return {
    ok: true,
    summary: "test suite registered",
    created: true,
    suite: suitePublic(row),
  };
}

export function createRegisteredTest({ args = {}, cwd, actor = {}, scopeFiles = [], db = getDb() } = {}) {
  ensureRegisteredTestTables(db);
  const suite = resolveSuite(db, args);
  if (!suite) {
    return { ok: false, summary: "test suite not found", failure: { message: "Provide suite_id or suite name/slug for an existing suite." } };
  }
  const normalizedScopeFiles = normalizeScopeFiles(cwd, scopeFiles);
  const name = normalizeName(args.name ?? args.test_name ?? args.testName, "test name");
  const explanation = normalizeOptionalText(args.explanation ?? args.description, "explanation");
  const language = normalizeLanguage(args.language);
  const functionName = normalizeFunctionName(args.function_name ?? args.functionName);
  const source = normalizeSource(args.test ?? args.source ?? args.code);
  const targetFiles = normalizePathList(cwd, args.target_files ?? args.targetFiles, "target_files", { required: true });
  const targetSymbols = normalizeSymbolList(args.target_symbols ?? args.targetSymbols ?? args.target_functions ?? args.targetFunctions, "target_symbols");
  const targetImports = normalizeTargetImports(cwd, args.target_imports ?? args.targetImports);
  assertTargetsWithinScope(targetFiles, normalizedScopeFiles);
  const timeoutMs = Math.max(1000, Math.min(120000, Number(args.timeout_ms ?? args.timeoutMs) || DEFAULT_TIMEOUT_MS));

  const registrationRun = runSourceWithCleanup({
    cwd,
    source,
    language,
    functionName,
    targetFiles,
    targetSymbols,
    targetImports,
    timeoutMs,
  });
  if (!registrationRun.ok) {
    return {
      ok: false,
      registered: false,
      summary: "test registration rejected: test failed",
      suite: suitePublic(suite),
      failure: registrationRun.failure,
      duration_ms: registrationRun.duration_ms,
      tmp_cleaned: registrationRun.tmp_cleaned,
    };
  }

  const slug = slugify(args.slug || name);
  const hash = sourceHash(source);
  const targetFilesJson = JSON.stringify(targetFiles);
  const targetSymbolsJson = JSON.stringify(targetSymbols);
  const targetImportsJson = JSON.stringify(targetImports);
  const existing = db.prepare(`
    SELECT * FROM posse_tests WHERE suite_id = ? AND slug = ?
  `).get(suite.id, slug);
  let testId;
  if (existing) {
    db.prepare(`
      UPDATE posse_tests
      SET name = ?, explanation = ?, language = ?, function_name = ?, source = ?,
          source_sha256 = ?, target_files_json = ?, target_symbols_json = ?, target_imports_json = ?,
          status = 'active', updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
      WHERE id = ?
    `).run(name, explanation, language, functionName || null, source, hash, targetFilesJson, targetSymbolsJson, targetImportsJson, existing.id);
    testId = existing.id;
  } else {
    const info = db.prepare(`
      INSERT INTO posse_tests (
        suite_id, name, slug, explanation, language, function_name, source,
        source_sha256, target_files_json, target_symbols_json, target_imports_json,
        created_by_role, created_by_job_id, created_by_work_item_id
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      suite.id,
      name,
      slug,
      explanation,
      language,
      functionName || null,
      source,
      hash,
      targetFilesJson,
      targetSymbolsJson,
      targetImportsJson,
      actor.role || null,
      actor.jobId || null,
      actor.workItemId || null,
    );
    testId = info.lastInsertRowid;
  }
  const row = db.prepare(`SELECT * FROM posse_tests WHERE id = ?`).get(testId);
  const runId = insertRun(db, { suiteId: suite.id, testId, result: registrationRun, actor });
  updateTestLastRun(db, testId, registrationRun);
  ensureSuiteMirror(cwd, suite);
  return {
    ok: true,
    registered: true,
    created: !existing,
    updated: !!existing,
    summary: existing ? "test updated and passed registration" : "test registered and passed",
    suite: suitePublic(suite),
    test: testPublic(row),
    registration_run_id: runId,
    duration_ms: registrationRun.duration_ms,
    tmp_cleaned: registrationRun.tmp_cleaned,
  };
}

export function runRegisteredTest({ args = {}, cwd, actor = {}, scopeFiles = [], db = getDb() } = {}) {
  ensureRegisteredTestTables(db);
  const test = resolveTest(db, args);
  if (!test) {
    return {
      ok: false,
      summary: "registered test not found",
      failure: { message: "Provide test_id, or provide suite plus test name/slug." },
    };
  }
  const normalizedScopeFiles = normalizeScopeFiles(cwd, scopeFiles);
  if (!targetFilesOverlapScope(test, normalizedScopeFiles)) {
    return {
      ok: false,
      summary: "registered test is outside the current file scope",
      test: testPublic(test),
      failure: { message: "This registered test does not cover any file in the declared job scope." },
    };
  }
  const suite = db.prepare(`SELECT * FROM posse_test_suites WHERE id = ?`).get(test.suite_id);
  const timeoutMs = Math.max(1000, Math.min(120000, Number(args.timeout_ms ?? args.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const result = runSourceWithCleanup({
    cwd,
    source: test.source,
    language: test.language,
    functionName: test.function_name || "",
    targetFiles: parseJsonArray(test.target_files_json),
    targetSymbols: parseJsonArray(test.target_symbols_json),
    targetImports: parseJsonArray(test.target_imports_json),
    timeoutMs,
  });
  const runId = insertRun(db, { suiteId: test.suite_id, testId: test.id, result, actor });
  updateTestLastRun(db, test.id, result);
  return {
    ok: result.ok,
    summary: result.ok ? "test passed" : "test failed",
    suite: suitePublic(suite),
    test: testPublic(test),
    run_id: runId,
    duration_ms: result.duration_ms,
    tmp_cleaned: result.tmp_cleaned,
    failure: result.failure,
  };
}

export function runRegisteredTestSuite({ args = {}, cwd, actor = {}, scopeFiles = [], db = getDb() } = {}) {
  ensureRegisteredTestTables(db);
  const suite = resolveSuite(db, args);
  if (!suite) {
    return {
      ok: false,
      summary: "test suite not found",
      failure: { message: "Provide suite_id or suite name/slug for an existing suite." },
    };
  }
  const allTests = db.prepare(`
    SELECT * FROM posse_tests
    WHERE suite_id = ? AND status = 'active'
    ORDER BY created_at, id
  `).all(suite.id);
  const normalizedScopeFiles = normalizeScopeFiles(cwd, scopeFiles);
  const tests = normalizedScopeFiles.length > 0
    ? allTests.filter((test) => targetFilesOverlapScope(test, normalizedScopeFiles))
    : allTests;
  if (tests.length === 0) {
    return {
      ok: true,
      summary: allTests.length === 0
        ? "test suite has no active tests"
        : "test suite has no active tests matching the current file scope",
      suite: suitePublic(suite),
      tests: [],
      failures: [],
      skipped_out_of_scope: Math.max(0, allTests.length - tests.length),
    };
  }
  const timeoutMs = Math.max(1000, Math.min(120000, Number(args.timeout_ms ?? args.timeoutMs) || DEFAULT_TIMEOUT_MS));
  const results = [];
  for (const test of tests) {
    const result = runSourceWithCleanup({
      cwd,
      source: test.source,
      language: test.language,
      functionName: test.function_name || "",
      targetFiles: parseJsonArray(test.target_files_json),
      targetSymbols: parseJsonArray(test.target_symbols_json),
      targetImports: parseJsonArray(test.target_imports_json),
      timeoutMs,
    });
    const runId = insertRun(db, { suiteId: suite.id, testId: test.id, result, actor });
    updateTestLastRun(db, test.id, result);
    results.push({
      ok: result.ok,
      run_id: runId,
      test: testPublic(test),
      duration_ms: result.duration_ms,
      tmp_cleaned: result.tmp_cleaned,
      failure: result.failure,
    });
  }
  const failures = results.filter((result) => !result.ok);
  return {
    ok: failures.length === 0,
    summary: failures.length === 0
      ? `all ${results.length} registered tests passed`
      : `${failures.length} of ${results.length} registered tests failed`,
    suite: suitePublic(suite),
    tests: results.map((result) => ({
      id: result.test.id,
      name: result.test.name,
      ok: result.ok,
      run_id: result.run_id,
      duration_ms: result.duration_ms,
      tmp_cleaned: result.tmp_cleaned,
    })),
    failures: failures.map((result) => ({
      test_id: result.test.id,
      name: result.test.name,
      failure: result.failure,
    })),
    skipped_out_of_scope: Math.max(0, allTests.length - tests.length),
  };
}
