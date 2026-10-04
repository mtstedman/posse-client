import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { TEST_SUBPROCESS_ENV_KEYS } from "../../../../catalog/process.js";
import { filterProcessEnv } from "../../../platform/functions/process-env.js";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", ".cache", ".next", ".nuxt",
  "build", "coverage", "dist", "node_modules", "target", "vendor", "venv", ".venv",
]);
const MAX_OUTPUT_CHARS = 128 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;

const ADAPTERS = Object.freeze({
  ".cjs": { language: "javascript", executable: "node", argv: (relative) => ["--test", relative] },
  ".js": { language: "javascript", executable: "node", argv: (relative) => ["--test", relative] },
  ".mjs": { language: "javascript", executable: "node", argv: (relative) => ["--test", relative] },
  ".cts": { language: "typescript", executable: "node", argv: (relative) => ["--experimental-strip-types", "--test", relative] },
  ".mts": { language: "typescript", executable: "node", argv: (relative) => ["--experimental-strip-types", "--test", relative] },
  ".ts": { language: "typescript", executable: "node", argv: (relative) => ["--experimental-strip-types", "--test", relative] },
  ".py": { language: "python", executable: "python3", argv: (relative) => [relative] },
  ".php": { language: "php", executable: "php", argv: (relative) => [relative] },
  ".rb": { language: "ruby", executable: "ruby", argv: (relative) => [relative] },
  ".go": {
    language: "go",
    executable: "go",
    argv: (relative) => ["test", `./${path.posix.dirname(relative)}`],
  },
  ".rs": {
    language: "rust",
    executable: "cargo",
    argv: (relative) => ["test", "--test", path.posix.basename(relative, ".rs")],
  },
});

function isTestDirectoryName(name) {
  return /^tests?/i.test(String(name || ""));
}

function commandAvailable(executable) {
  const extensions = process.platform === "win32"
    ? String(process.env.PATHEXT || ".EXE;.CMD;.BAT;.COM").split(";")
    : [""];
  return String(process.env.PATH || "").split(path.delimiter).some((directory) => extensions.some((extension) => {
    const candidate = path.join(directory, process.platform === "win32" ? `${executable}${extension}` : executable);
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }));
}

function walkTestFiles(root, current, inTestDirectory, output) {
  let entries;
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isSymbolicLink()) continue;
    const absolute = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name.toLowerCase())) continue;
      walkTestFiles(root, absolute, inTestDirectory || isTestDirectoryName(entry.name), output);
      continue;
    }
    if (!inTestDirectory || !entry.isFile()) continue;
    const extension = path.extname(entry.name).toLowerCase();
    if (!ADAPTERS[extension]) continue;
    output.push(path.relative(root, absolute).replace(/\\/g, "/"));
  }
}

export function discoverUnitTestCapability({ projectDir, scipAvailable = true } = {}) {
  const root = path.resolve(String(projectDir || ""));
  if (!root || !fs.existsSync(root) || !scipAvailable) {
    return Object.freeze({ available: false, reason: !scipAvailable ? "scip_unavailable" : "project_unavailable", files: [], languages: [] });
  }
  const files = [];
  walkTestFiles(root, root, isTestDirectoryName(path.basename(root)), files);
  files.sort();
  const adapters = [...new Set(files.map((file) => ADAPTERS[path.extname(file).toLowerCase()].executable))];
  const missing = adapters.filter((executable) => !commandAvailable(executable));
  const languages = [...new Set(files.map((file) => ADAPTERS[path.extname(file).toLowerCase()].language))].sort();
  return Object.freeze({
    available: files.length > 0 && missing.length === 0,
    reason: files.length === 0 ? "no_unit_tests" : missing.length > 0 ? "test_adapter_unavailable" : null,
    files: Object.freeze(files),
    languages: Object.freeze(languages),
    missing_executables: Object.freeze(missing),
  });
}

export function resolveUnitTestInvocation(projectDir, requestedPath, capability = null) {
  const root = path.resolve(String(projectDir || ""));
  const raw = String(requestedPath || "").trim().replace(/\\/g, "/");
  if (!raw || raw.includes("\0") || path.posix.isAbsolute(raw) || /^[A-Za-z]:\//.test(raw)) return null;
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === ".." || normalized.startsWith("../")) return null;
  const discovered = capability || discoverUnitTestCapability({ projectDir: root });
  if (!discovered.available || !discovered.files.includes(normalized)) return null;
  const absolute = path.resolve(root, normalized);
  let real;
  try { real = fs.realpathSync(absolute); } catch { return null; }
  const relativeReal = path.relative(fs.realpathSync(root), real);
  if (!relativeReal || relativeReal.startsWith("..") || path.isAbsolute(relativeReal)) return null;
  const adapter = ADAPTERS[path.extname(normalized).toLowerCase()];
  if (!adapter) return null;
  return Object.freeze({
    path: normalized,
    language: adapter.language,
    executable: adapter.executable,
    args: Object.freeze(adapter.argv(normalized)),
  });
}

function appendBounded(current, chunk) {
  const next = current + String(chunk || "");
  return next.length <= MAX_OUTPUT_CHARS ? next : next.slice(-MAX_OUTPUT_CHARS);
}

export async function runUnitTestFile({ projectDir, path: requestedPath, capability = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const invocation = resolveUnitTestInvocation(projectDir, requestedPath, capability);
  if (!invocation) {
    return { ok: null, passed: null, status: "unavailable", reason: "unit_test_path_unavailable", path: String(requestedPath || "") };
  }
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timer = null;
    const finish = (code, signal = null, error = null, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const passed = !timedOut && !error && !signal && code === 0;
      resolve({
        ok: passed,
        passed,
        status: timedOut ? "timed_out" : error || signal ? "infrastructure_error" : passed ? "passed" : "failed",
        path: invocation.path,
        language: invocation.language,
        exit_code: code,
        signal,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        stdout,
        stderr: error ? [stderr, error.message || String(error)].filter(Boolean).join("\n") : stderr,
      });
    };
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd: path.resolve(projectDir),
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: filterProcessEnv(process.env, { allowedKeys: TEST_SUBPROCESS_ENV_KEYS }),
      });
    } catch (error) {
      resolve({ ok: null, passed: null, status: "infrastructure_error", reason: "test_runner_spawn_failed", path: invocation.path, error: error?.message || String(error) });
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => { stdout = appendBounded(stdout, chunk); });
    child.stderr?.on("data", (chunk) => { stderr = appendBounded(stderr, chunk); });
    child.on("error", (error) => finish(error?.code ?? null, null, error));
    child.on("close", (code, signal) => finish(code, signal));
    timer = setTimeout(() => {
      try { child.kill("SIGKILL"); } catch { /* best effort */ }
      finish(124, null, null, true);
    }, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    timer.unref?.();
  });
}

export async function runUnitTestFiles({ projectDir, paths = [], capability = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const discovered = capability || discoverUnitTestCapability({ projectDir });
  const results = [];
  for (const testPath of paths) {
    results.push(await runUnitTestFile({ projectDir, path: testPath, capability: discovered, timeoutMs }));
  }
  const unavailable = results.find((result) => result.ok == null);
  const failed = results.find((result) => result.ok === false);
  return {
    ok: unavailable ? null : !failed,
    passed: unavailable ? null : !failed,
    status: unavailable ? unavailable.status : failed ? failed.status : "passed",
    results,
  };
}
