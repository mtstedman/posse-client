import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { spawn } from "child_process";
import fs from "fs";
import path from "path";
import { TEST_SUBPROCESS_ENV_KEYS } from "../../../../catalog/process.js";
import { filterProcessEnv } from "../../../platform/functions/process-env.js";
import { testExecutionCounts } from "./test-output-counts.js";

const SKIP_DIRS = new Set([
  ".git", ".hg", ".svn", ".idea", ".vscode", ".cache", ".next", ".nuxt",
  "build", "coverage", "dist", "node_modules", "target", "vendor", "venv", ".venv",
]);
const MAX_OUTPUT_CHARS = 128 * 1024;
const MAX_SOURCE_SNIFF_BYTES = 256 * 1024;
const DEFAULT_TIMEOUT_MS = 120_000;
const PHPUNIT_CONFIG_NAMES = Object.freeze(["phpunit.xml", "phpunit.xml.dist", "phpunit.dist.xml"]);

// Outcome -> legacy wire status. `ok` stays true only for a real pass, false
// for a real product failure or timeout, and null when nothing was verified.
const OUTCOME_STATUS = Object.freeze({
  passed: "passed",
  product_failed: "failed",
  timed_out: "timed_out",
  infrastructure_error: "infrastructure_error",
  unavailable: "unavailable",
});

// The managed project venv, when Posse provisioned one, is where pytest lives;
// a bare python3 on the host may not have it.
function pythonExecutable() {
  const managed = String(process.env.POSSE_PROJECT_PYTHON || "").trim();
  if (managed && path.isAbsolute(managed) && fs.existsSync(managed)) return managed;
  return "python3";
}

const ADAPTERS = Object.freeze({
  ".cjs": { language: "javascript", runner: "node_test", executable: () => "node", argv: (relative) => ["--test", relative] },
  ".js": { language: "javascript", runner: "node_test", executable: () => "node", argv: (relative) => ["--test", relative] },
  ".mjs": { language: "javascript", runner: "node_test", executable: () => "node", argv: (relative) => ["--test", relative] },
  ".cts": { language: "typescript", runner: "node_test", executable: () => "node", argv: (relative) => ["--experimental-strip-types", "--test", relative] },
  ".mts": { language: "typescript", runner: "node_test", executable: () => "node", argv: (relative) => ["--experimental-strip-types", "--test", relative] },
  ".ts": { language: "typescript", runner: "node_test", executable: () => "node", argv: (relative) => ["--experimental-strip-types", "--test", relative] },
  // Python and PHP files are not self-running: the runner is chosen per file.
  ".py": { language: "python", executable: pythonExecutable, resolve: pythonRunner },
  ".php": { language: "php", executable: () => "php", resolve: phpRunner },
  ".rb": { language: "ruby", runner: "ruby", executable: () => "ruby", argv: (relative) => [relative] },
  ".go": {
    language: "go",
    runner: "go_test",
    executable: () => "go",
    argv: (relative) => ["test", `./${path.posix.dirname(relative)}`],
  },
  ".rs": {
    language: "rust",
    runner: "cargo_test",
    executable: () => "cargo",
    argv: (relative) => ["test", "--test", path.posix.basename(relative, ".rs")],
  },
});

// Resolve the repository's installed loader, never download one or infer that
// Node's type stripping implements the project's TypeScript resolution rules.
function nodeRunner(root, relative) {
  let pkg = {};
  try { pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")); } catch { /* no package */ }
  const script = String(pkg.scripts?.test || "").trim();
  if (/^(?:tsx\s+--test|node\s+--import(?:=|\s+)tsx\s+--test)(?:\s|$)/u.test(script)) {
    try {
      const cli = createRequire(path.join(root, "package.json")).resolve("tsx/cli");
      return { runner: "node_test", executable: "node", args: [cli, "--test", relative] };
    } catch { return { reason: "typescript_test_loader_unavailable" }; }
  }
  if (script && /\b(?:vitest|jest|mocha|ava)\b/u.test(script)) return { reason: "project_test_runner_requires_declared_command" };
  const typed = /\.[cm]?ts$/u.test(relative);
  return { runner: "node_test", executable: "node", args: [...(typed ? ["--experimental-strip-types"] : []), "--test", relative] };
}

function nodeBootstrapFailure(invocation, output) {
  if (invocation.runner !== "node_test") return null;
  if (/ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX|ERR_UNKNOWN_FILE_EXTENSION/u.test(output)) return "typescript_test_loader_unavailable";
  if (/ERR_MODULE_NOT_FOUND/u.test(output)) {
    const url = /url: ['"](file:[^'"]+)['"]/u.exec(output)?.[1];
    if (url) {
      try {
        const missing = fileURLToPath(url);
        if (!path.extname(missing) && [".ts", ".tsx", ".js"].some((ext) => fs.existsSync(missing + ext))) return "test_loader_resolution_mismatch";
      } catch { /* malformed diagnostic */ }
    }
    if (/Cannot find package ['"]/u.test(output)) return "test_dependency_unavailable";
  }
  return null;
}

const PYTEST_SOURCE_RE = /^\s*(?:async\s+)?def\s+test\w*\s*\(|^\s*class\s+Test\w*|^\s*(?:import|from)\s+(?:pytest|unittest)\b/m;
const PYTHON_MAIN_RE = /^if\s+__name__\s*==\s*["']__main__["']\s*:/m;
const PHPUNIT_SOURCE_RE = /\bPHPUnit\\|\bextends\s+\\?(?:\w+\\)*\w*TestCase\b/;
const PHP_CLASS_EXTENDS_RE = /^\s*(?:(?:final|abstract|readonly)\s+)*class\s+\w+\s+extends\b/m;

function readSourceHead(absolute) {
  let fd;
  try {
    fd = fs.openSync(absolute, "r");
    const buffer = Buffer.alloc(MAX_SOURCE_SNIFF_BYTES);
    const bytes = fs.readSync(fd, buffer, 0, buffer.length, 0);
    return buffer.subarray(0, bytes).toString("utf8");
  } catch {
    return "";
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch { /* best effort */ }
    }
  }
}

// Nearest of `names` walking from the test file's directory up to the root.
function nearestUpward(root, relative, names) {
  let directory = path.posix.dirname(relative);
  for (;;) {
    for (const name of names) {
      const candidate = directory === "." ? name : `${directory}/${name}`;
      try {
        if (fs.statSync(path.join(root, candidate)).isFile()) return candidate;
      } catch { /* keep walking */ }
    }
    if (directory === "." || !directory) return null;
    directory = path.posix.dirname(directory);
  }
}

// pytest collects test functions, Test classes, and unittest cases. A file
// that only guards a __main__ block is a script. Anything else (conftest,
// helpers) has no runner.
function pythonRunner(root, relative, source) {
  const python = pythonExecutable();
  const pytest = { runner: "pytest", executable: python, args: ["-m", "pytest", "-q", "-p", "no:cacheprovider", relative] };
  if (PYTEST_SOURCE_RE.test(source)) return pytest;
  if (PYTHON_MAIN_RE.test(source)) return { runner: "python_script", executable: python, args: [relative] };
  if (/^test_.+\.py$|_test\.py$/i.test(path.posix.basename(relative))) return pytest;
  return { reason: "python_runner_unidentified" };
}

// A PHPUnit class only defines a class; `php <file>` runs nothing (or dies on
// the missing base class). It needs vendor/bin/phpunit and the config that
// names its bootstrap. Plain assertion scripts run directly.
function phpRunner(root, relative, source) {
  if (PHPUNIT_SOURCE_RE.test(source)) {
    const phpunit = nearestUpward(root, relative, ["vendor/bin/phpunit"]);
    if (!phpunit) return { reason: "phpunit_unavailable" };
    const config = nearestUpward(root, relative, PHPUNIT_CONFIG_NAMES);
    return { runner: "phpunit", executable: "php", args: [phpunit, ...(config ? ["-c", config] : []), relative] };
  }
  if (PHP_CLASS_EXTENDS_RE.test(source)) return { reason: "php_runner_unidentified" };
  return { runner: "php_script", executable: "php", args: [relative] };
}

function isTestDirectoryName(name) {
  return /^tests?/i.test(String(name || ""));
}

function commandAvailable(executable) {
  if (path.isAbsolute(executable)) {
    try {
      fs.accessSync(executable, fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  }
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
  const adapters = [...new Set(files.map((file) => ADAPTERS[path.extname(file).toLowerCase()].executable()))];
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

/**
 * Resolve a discovered test file to the framework that runs it. Returns null
 * for a path that is invalid or not a discovered test file. A discovered file
 * with no positively identified runner resolves with `runner: null` and a
 * `reason`, so callers report it as unavailable instead of guessing.
 */
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
  const resolved = ["javascript", "typescript"].includes(adapter.language)
    ? nodeRunner(root, normalized)
    : adapter.resolve
    ? adapter.resolve(root, normalized, readSourceHead(real))
    : { runner: adapter.runner, executable: adapter.executable(), args: adapter.argv(normalized) };
  if (!resolved.runner) {
    return Object.freeze({ path: normalized, language: adapter.language, runner: null, reason: resolved.reason });
  }
  return Object.freeze({
    path: normalized,
    language: adapter.language,
    runner: resolved.runner,
    executable: resolved.executable,
    args: Object.freeze(resolved.args),
  });
}

function appendBounded(current, chunk) {
  const next = current + String(chunk || "");
  return next.length <= MAX_OUTPUT_CHARS ? next : next.slice(-MAX_OUTPUT_CHARS);
}

// `No module named 'x'` for a top-level module the repository does not
// contain is a missing dependency, not a product failure.
function missingExternalPythonModule(root, output) {
  return [...String(output).matchAll(/ModuleNotFoundError: No module named '([^'.]+)/g)]
    .some((match) => !["", "src"].some((prefix) => {
      const base = prefix ? path.join(root, prefix, match[1]) : path.join(root, match[1]);
      return fs.existsSync(base) || fs.existsSync(`${base}.py`);
    }));
}

function classifyCompletedRun(invocation, { code, stdout, stderr }, root) {
  const output = `${stdout}\n${stderr}`;
  const bootstrapFailure = nodeBootstrapFailure(invocation, output);
  if (bootstrapFailure) return { outcome: "infrastructure_error", reason: bootstrapFailure };
  const counts = testExecutionCounts(output);
  const zeroTests = !!counts && (counts.total === 0 || counts.skipped === counts.total);
  const noTests = { outcome: "unavailable", reason: "no_tests_executed" };
  switch (invocation.runner) {
    case "pytest":
      if (/No module named pytest\b/.test(output)) return { outcome: "infrastructure_error", reason: "pytest_unavailable" };
      if (code === 5 || (code === 0 && zeroTests)) return noTests;
      if (code === 0) return { outcome: "passed", reason: null };
      if (code === 1) return { outcome: "product_failed", reason: "tests_failed" };
      if (code === 2 && /errors? during collection|ERROR collecting/.test(output)) {
        return missingExternalPythonModule(root, output)
          ? { outcome: "infrastructure_error", reason: "python_dependency_unavailable" }
          : { outcome: "product_failed", reason: "test_collection_failed" };
      }
      // 2 interrupted, 3 internal error, 4 usage error.
      return { outcome: "infrastructure_error", reason: "pytest_runner_error" };
    case "phpunit":
      if (code === 0) return zeroTests || /No tests executed/i.test(output) ? noTests : { outcome: "passed", reason: null };
      if (code === 1) return { outcome: "product_failed", reason: "tests_failed" };
      // Dying before PHPUnit prints its banner is bootstrap/autoload trouble.
      if (!/PHPUnit \d+\.\d+/.test(output)) return { outcome: "infrastructure_error", reason: "phpunit_bootstrap_failed" };
      // PHPUnit exits 2 both for erroring tests (with a Tests: summary) and
      // for its own configuration/runner errors (without one).
      if (code === 2 && !(counts?.total > 0)) return { outcome: "infrastructure_error", reason: "phpunit_runner_error" };
      return { outcome: "product_failed", reason: "tests_failed" };
    case "php_script":
      if (code === 0) return zeroTests || !stdout.trim() ? noTests : { outcome: "passed", reason: null };
      if (/(?:Failed opening required|failed to open stream)[^\n]*vendor[\\/]autoload\.php/i.test(output)) {
        return { outcome: "infrastructure_error", reason: "php_dependency_unavailable" };
      }
      return { outcome: "product_failed", reason: "tests_failed" };
    case "python_script":
      if (code === 0) return { outcome: "passed", reason: null };
      if (missingExternalPythonModule(root, output)) return { outcome: "infrastructure_error", reason: "python_dependency_unavailable" };
      return { outcome: "product_failed", reason: "tests_failed" };
    default:
      if (code === 0) return zeroTests ? noTests : { outcome: "passed", reason: null };
      return { outcome: "product_failed", reason: "tests_failed" };
  }
}

function unitTestResult(outcome, fields = {}) {
  return {
    ok: outcome === "passed" ? true : ["product_failed", "timed_out"].includes(outcome) ? false : null,
    passed: outcome === "passed" ? true : ["product_failed", "timed_out"].includes(outcome) ? false : null,
    outcome,
    status: OUTCOME_STATUS[outcome],
    ...fields,
  };
}

export async function runUnitTestFile({ projectDir, path: requestedPath, capability = null, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  const invocation = resolveUnitTestInvocation(projectDir, requestedPath, capability);
  if (!invocation) {
    return unitTestResult("unavailable", { reason: "unit_test_path_unavailable", path: String(requestedPath || "") });
  }
  if (!invocation.runner) {
    return unitTestResult("unavailable", { reason: invocation.reason, path: invocation.path, language: invocation.language });
  }
  const root = path.resolve(projectDir);
  const command = [path.basename(invocation.executable), ...invocation.args].join(" ");
  const startedAt = Date.now();
  return await new Promise((resolve) => {
    let child;
    let stdout = "";
    let stderr = "";
    let stdoutTruncated = false;
    let stderrTruncated = false;
    let settled = false;
    let timer = null;
    const finish = (code, signal = null, error = null, timedOut = false) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const { outcome, reason } = timedOut
        ? { outcome: "timed_out", reason: "test_timed_out" }
        : error
          ? { outcome: "infrastructure_error", reason: error?.code === "ENOENT" ? "test_runner_missing" : "test_runner_spawn_failed" }
          : signal
            ? { outcome: "infrastructure_error", reason: "test_runner_killed" }
            : classifyCompletedRun(invocation, { code, stdout, stderr }, root);
      const combinedStderr = error ? [stderr, error.message || String(error)].filter(Boolean).join("\n") : stderr;
      resolve(unitTestResult(outcome, {
        reason,
        path: invocation.path,
        language: invocation.language,
        runner: invocation.runner,
        command,
        exit_code: code,
        signal,
        timed_out: timedOut,
        duration_ms: Date.now() - startedAt,
        test_counts: testExecutionCounts(`${stdout}\n${stderr}`),
        stdout_truncated: stdoutTruncated,
        stderr_truncated: stderrTruncated,
        stdout,
        stderr: combinedStderr,
      }));
    };
    try {
      child = spawn(invocation.executable, invocation.args, {
        cwd: root,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: filterProcessEnv(process.env, { allowedKeys: TEST_SUBPROCESS_ENV_KEYS }),
      });
    } catch (error) {
      settled = true;
      resolve(unitTestResult("infrastructure_error", {
        reason: "test_runner_spawn_failed",
        path: invocation.path,
        language: invocation.language,
        runner: invocation.runner,
        command,
        error: error?.message || String(error),
      }));
      return;
    }
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk) => {
      stdoutTruncated ||= stdout.length + String(chunk || "").length > MAX_OUTPUT_CHARS;
      stdout = appendBounded(stdout, chunk);
    });
    child.stderr?.on("data", (chunk) => {
      stderrTruncated ||= stderr.length + String(chunk || "").length > MAX_OUTPUT_CHARS;
      stderr = appendBounded(stderr, chunk);
    });
    child.on("error", (error) => finish(null, null, error));
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
  // A real failure is the actionable result; otherwise anything that did not
  // run keeps the whole set unverified.
  const failed = results.find((result) => result.ok === false);
  const unavailable = results.find((result) => result.ok == null);
  return {
    ok: failed ? false : unavailable ? null : true,
    passed: failed ? false : unavailable ? null : true,
    status: failed ? failed.status : unavailable ? unavailable.status : "passed",
    reason: failed?.reason || unavailable?.reason || null,
    results,
  };
}

export { classifyCompletedRun as __testClassifyUnitTestRun };
