import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { resolveManagedPythonRuntimeForProject } from "../../domains/runtime/functions/python-runtime.js";

const JS_SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
const PHP_SOURCE_EXTENSIONS = new Set([".php"]);
const PYTHON_SOURCE_EXTENSIONS = new Set([".py", ".pyi"]);
const GO_SOURCE_EXTENSIONS = new Set([".go"]);
const RUST_SOURCE_EXTENSIONS = new Set([".rs"]);
const C_SOURCE_EXTENSIONS = new Set([".c", ".h"]);
const CPP_SOURCE_EXTENSIONS = new Set([".cc", ".cpp", ".cxx", ".hh", ".hpp", ".hxx"]);
const CLANG_SOURCE_EXTENSIONS = new Set([...C_SOURCE_EXTENSIONS, ...CPP_SOURCE_EXTENSIONS]);
const SOURCE_EXTENSIONS = new Set([
  ...JS_SOURCE_EXTENSIONS,
  ...PHP_SOURCE_EXTENSIONS,
  ...PYTHON_SOURCE_EXTENSIONS,
  ...GO_SOURCE_EXTENSIONS,
  ...RUST_SOURCE_EXTENSIONS,
  ...CLANG_SOURCE_EXTENSIONS,
]);
const MAX_SCOPE_ROOT_FILES = 250;
const MAX_FAILURES = 60;
const MAX_OUTPUT_CHARS = 6000;

function relPath(cwd, value) {
  const raw = String(value || "").replace(/\\/g, "/").trim();
  if (!raw) return "";
  const resolved = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  const rel = path.relative(cwd, resolved).replace(/\\/g, "/");
  if (!rel || rel.startsWith("../") || rel === "..") return "";
  return rel.replace(/^\.\//, "");
}

function normalizePathList(cwd, values = []) {
  const out = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const rel = relPath(cwd, value);
    if (!rel || seen.has(rel)) continue;
    seen.add(rel);
    out.push(rel);
  }
  return out;
}

function walkFiles(root, { limit = MAX_SCOPE_ROOT_FILES } = {}) {
  const out = [];
  const stack = [root];
  while (stack.length > 0 && out.length < limit) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (out.length >= limit) break;
      if (entry.name === "node_modules" || entry.name === ".git" || entry.name === ".posse" || entry.name === ".posse-worktrees" || entry.name === ".posse-test-suites") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile()) out.push(full);
    }
  }
  return out;
}

export function declaredScopeFiles(cwd, scope = {}) {
  const files = normalizePathList(cwd, [
    ...(scope.files || []),
    ...(scope.modifyFiles || []),
    ...(scope.scopedFiles || []),
    ...(scope.createFiles || []),
    ...(scope.deleteFiles || []),
  ]);
  const seen = new Set(files);
  for (const root of normalizePathList(cwd, [
    ...(scope.roots || []),
    ...(scope.createRoots || []),
  ])) {
    if (root === "*") continue;
    const abs = path.resolve(cwd, root);
    for (const full of walkFiles(abs)) {
      const rel = relPath(cwd, full);
      if (rel && !seen.has(rel)) {
        seen.add(rel);
        files.push(rel);
      }
    }
  }
  return files;
}

function existingFiles(cwd, files = []) {
  return files.filter((file) => {
    try {
      return fs.statSync(path.join(cwd, file)).isFile();
    } catch {
      return false;
    }
  });
}

function lintableFiles(cwd, files = []) {
  return existingFiles(cwd, files)
    .filter((file) => SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function jsLintableFiles(cwd, files = []) {
  return existingFiles(cwd, files)
    .filter((file) => JS_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function phpLintableFiles(cwd, files = []) {
  return existingFiles(cwd, files)
    .filter((file) => PHP_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function pythonLintableFiles(cwd, files = []) {
  return existingFiles(cwd, files)
    .filter((file) => PYTHON_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function goLintableFiles(cwd, files = []) {
  return existingFiles(cwd, files)
    .filter((file) => GO_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function rustLintableFiles(cwd, files = []) {
  return existingFiles(cwd, files)
    .filter((file) => RUST_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function clangLintableFiles(cwd, files = []) {
  return existingFiles(cwd, files)
    .filter((file) => CLANG_SOURCE_EXTENSIONS.has(path.extname(file).toLowerCase()));
}

function compact(value, max = MAX_OUTPUT_CHARS) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated ${text.length - max} chars)`;
}

function quoteCmdArg(value) {
  const text = String(value || "");
  if (text === "") return "\"\"";
  if (!/[\s"]/u.test(text)) return text;
  return `"${text
    .replace(/(\\*)"/g, "$1$1\\\"")
    .replace(/\\+$/g, "$&$&")}"`;
}

function runProcess(command, args, cwd, { timeoutMs = 120000 } = {}) {
  const startedAt = Date.now();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const useCmdTrampoline = process.platform === "win32" && /\.cmd$/i.test(command);
  const spawnCommand = useCmdTrampoline ? (process.env.ComSpec || "cmd.exe") : command;
  const spawnArgs = useCmdTrampoline
    ? ["/d", "/s", "/c", [command, ...args].map(quoteCmdArg).join(" ")]
    : args;
  const result = spawnSync(spawnCommand, spawnArgs, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    shell: false,
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
  });
  return {
    command: [command, ...args].join(" "),
    exitCode: result.status ?? (result.error ? 1 : 0),
    signal: result.signal || null,
    timedOut: result.error?.code === "ETIMEDOUT",
    stdout: String(result.stdout || ""),
    stderr: String(result.stderr || ""),
    error: result.error?.message || null,
    durationMs: Date.now() - startedAt,
  };
}

function eslintBin(cwd) {
  const bin = path.join(cwd, "node_modules", "eslint", "bin", "eslint.js");
  return fs.existsSync(bin) ? bin : null;
}

function packageScript(cwd, name) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8"));
    return typeof pkg?.scripts?.[name] === "string" ? pkg.scripts[name] : null;
  } catch {
    return null;
  }
}

function npmCommand() {
  return process.platform === "win32" ? "npm.cmd" : "npm";
}

function commandUnavailable(result) {
  return !!result.error && /ENOENT|not found/i.test(result.error);
}

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function pythonCommandCandidates(cwd) {
  const candidates = [];
  const managedRuntime = resolveManagedPythonRuntimeForProject({ projectDir: cwd });
  if (managedRuntime?.ready && managedRuntime.python) {
    candidates.push({ command: managedRuntime.python, args: [], display: managedRuntime.python });
  }

  const localVenvs = process.platform === "win32"
    ? [path.join(cwd, ".venv", "Scripts", "python.exe"), path.join(cwd, "venv", "Scripts", "python.exe")]
    : [path.join(cwd, ".venv", "bin", "python"), path.join(cwd, "venv", "bin", "python")];
  for (const python of localVenvs) {
    if (fileExists(python)) candidates.push({ command: python, args: [], display: python });
  }

  if (process.platform === "win32") {
    candidates.push(
      { command: "python", args: [], display: "python" },
      { command: "py", args: ["-3"], display: "py -3" },
      { command: "python3", args: [], display: "python3" },
    );
  } else {
    candidates.push(
      { command: "python3", args: [], display: "python3" },
      { command: "python", args: [], display: "python" },
    );
  }

  const seen = new Set();
  return candidates.filter((candidate) => {
    const key = `${candidate.command}\0${candidate.args.join("\0")}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function resolvePythonCommand(cwd) {
  const probe = "import sys; raise SystemExit(0 if sys.version_info >= (3, 8) else 1)";
  for (const candidate of pythonCommandCandidates(cwd)) {
    const result = runProcess(candidate.command, [...candidate.args, "-c", probe], cwd, { timeoutMs: 30000 });
    if (result.exitCode === 0) return candidate;
  }
  return null;
}

function parseEslintFindings(stdout, stderr, cwd) {
  let parsed = null;
  try { parsed = JSON.parse(stdout || "[]"); } catch { parsed = null; }
  if (!Array.isArray(parsed)) {
    return [{
      file: null,
      line: null,
      column: null,
      rule: null,
      message: compact(stderr || stdout || "eslint failed"),
      severity: "error",
    }];
  }
  const findings = [];
  for (const fileResult of parsed) {
    const rel = fileResult.filePath ? relPath(cwd, fileResult.filePath) || fileResult.filePath.replace(/\\/g, "/") : null;
    for (const msg of fileResult.messages || []) {
      if (findings.length >= MAX_FAILURES) break;
      findings.push({
        file: rel,
        line: msg.line || null,
        column: msg.column || null,
        rule: msg.ruleId || null,
        message: String(msg.message || "").trim(),
        severity: msg.severity === 2 ? "error" : "warning",
      });
    }
  }
  return findings;
}

function runScopedJsLint(cwd, targets) {
  if (targets.length === 0) {
    return { name: "eslint", status: "skipped", reason: "no JS/TS lintable scoped files", targets: [] };
  }
  const eslint = eslintBin(cwd);
  const result = eslint
    ? runProcess(process.execPath, [eslint, "--format", "json", ...targets], cwd)
    : runProcess(npmCommand(), ["run", "lint", "--", "--format", "json", ...targets], cwd);
  const findings = parseEslintFindings(result.stdout, result.stderr, cwd)
    .filter((finding) => finding.severity === "error");
  return {
    name: "eslint",
    status: result.exitCode === 0 && findings.length === 0 ? "passed" : "failed",
    targets,
    command: result.command,
    durationMs: result.durationMs,
    failures: findings,
    output: result.exitCode === 0 ? null : compact(result.stderr || result.stdout || result.error || ""),
  };
}

function parsePythonLintFinding(result, cwd, file) {
  const text = compact(`${result.stdout}\n${result.stderr}`) || result.error || `python -m py_compile exited ${result.exitCode}`;
  const lineMatch = text.match(/\bFile\s+"[^"]+",\s+line\s+(\d+)\b/i);
  const errorMatch = text.match(/\b(?:SyntaxError|IndentationError|TabError):\s*([^\n]+)/i);
  return {
    file: relPath(cwd, file) || file,
    line: lineMatch ? Number(lineMatch[1]) : null,
    column: null,
    rule: "python -m py_compile",
    message: errorMatch ? errorMatch[0].trim() : text,
    severity: "error",
  };
}

function runScopedPythonLint(cwd, targets) {
  if (targets.length === 0) {
    return { name: "python-lint", status: "skipped", reason: "no Python lintable scoped files", targets: [] };
  }

  const python = resolvePythonCommand(cwd);
  if (!python) {
    return {
      name: "python-lint",
      status: "skipped",
      reason: "python executable not available",
      targets,
    };
  }

  const failures = [];
  let unavailable = false;
  let durationMs = 0;
  for (const file of targets) {
    const result = runProcess(python.command, [...python.args, "-m", "py_compile", file], cwd);
    durationMs += result.durationMs;
    if (commandUnavailable(result)) {
      unavailable = true;
      break;
    }
    if (result.exitCode !== 0) {
      failures.push(parsePythonLintFinding(result, cwd, file));
      if (failures.length >= MAX_FAILURES) break;
    }
  }

  if (unavailable) {
    return {
      name: "python-lint",
      status: "skipped",
      reason: "python executable not available",
      targets,
      durationMs,
    };
  }

  return {
    name: "python-lint",
    status: failures.length === 0 ? "passed" : "failed",
    targets,
    command: `${python.display} -m py_compile ${targets.length === 1 ? targets[0] : "<scoped python files>"}`,
    durationMs,
    failures,
  };
}

function parseGenericLintFinding({ result, cwd, file, rule, fallback }) {
  const text = compact(`${result.stdout}\n${result.stderr}`) || result.error || `${rule} exited ${result.exitCode}`;
  const lineMatch = text.match(/(?:^|\b)(?:line\s+)?(\d+)(?::\d+)?(?::|\b)/i);
  return {
    file: relPath(cwd, file) || file,
    line: lineMatch ? Number(lineMatch[1]) : null,
    column: null,
    rule,
    message: text || fallback,
    severity: "error",
  };
}

function runScopedGoLint(cwd, targets) {
  if (targets.length === 0) {
    return { name: "go-lint", status: "skipped", reason: "no Go lintable scoped files", targets: [] };
  }

  const failures = [];
  let unavailable = false;
  let durationMs = 0;
  for (const file of targets) {
    const result = runProcess("gofmt", ["-e", "-l", file], cwd);
    durationMs += result.durationMs;
    if (commandUnavailable(result)) {
      unavailable = true;
      break;
    }
    if (result.exitCode !== 0) {
      failures.push(parseGenericLintFinding({
        result,
        cwd,
        file,
        rule: "gofmt -e",
        fallback: "Go syntax check failed",
      }));
      if (failures.length >= MAX_FAILURES) break;
    }
  }

  if (unavailable) {
    return {
      name: "go-lint",
      status: "skipped",
      reason: "gofmt executable not available",
      targets,
      durationMs,
    };
  }

  return {
    name: "go-lint",
    status: failures.length === 0 ? "passed" : "failed",
    targets,
    command: `gofmt -e -l ${targets.length === 1 ? targets[0] : "<scoped go files>"}`,
    durationMs,
    failures,
  };
}

function runScopedRustLint(cwd, targets) {
  if (targets.length === 0) {
    return { name: "rust-lint", status: "skipped", reason: "no Rust lintable scoped files", targets: [] };
  }

  const failures = [];
  let unavailable = false;
  let durationMs = 0;
  for (const file of targets) {
    const result = runProcess("rustfmt", ["--check", "--edition", "2021", file], cwd);
    durationMs += result.durationMs;
    if (commandUnavailable(result)) {
      unavailable = true;
      break;
    }
    if (result.exitCode !== 0) {
      failures.push(parseGenericLintFinding({
        result,
        cwd,
        file,
        rule: "rustfmt --check",
        fallback: "Rust syntax/format check failed",
      }));
      if (failures.length >= MAX_FAILURES) break;
    }
  }

  if (unavailable) {
    return {
      name: "rust-lint",
      status: "skipped",
      reason: "rustfmt executable not available",
      targets,
      durationMs,
    };
  }

  return {
    name: "rust-lint",
    status: failures.length === 0 ? "passed" : "failed",
    targets,
    command: `rustfmt --check ${targets.length === 1 ? targets[0] : "<scoped rust files>"}`,
    durationMs,
    failures,
  };
}

function clangCommandsForFile(file) {
  const ext = path.extname(file).toLowerCase();
  if (CPP_SOURCE_EXTENSIONS.has(ext)) {
    const args = ext === ".hh" || ext === ".hpp" || ext === ".hxx"
      ? ["-x", "c++-header", "-fsyntax-only", file]
      : ["-fsyntax-only", file];
    return [
      { command: "clang++", args, display: "clang++ -fsyntax-only" },
      { command: "g++", args, display: "g++ -fsyntax-only" },
      { command: "c++", args, display: "c++ -fsyntax-only" },
    ];
  }
  const args = ext === ".h"
    ? ["-x", "c-header", "-fsyntax-only", file]
    : ["-fsyntax-only", file];
  return [
    { command: "clang", args, display: "clang -fsyntax-only" },
    { command: "gcc", args, display: "gcc -fsyntax-only" },
    { command: "cc", args, display: "cc -fsyntax-only" },
  ];
}

function runFirstAvailableSyntaxCommand(cwd, candidates) {
  let unavailable = true;
  let lastResult = null;
  let used = null;
  for (const candidate of candidates) {
    const result = runProcess(candidate.command, candidate.args, cwd);
    if (commandUnavailable(result)) {
      lastResult = result;
      continue;
    }
    unavailable = false;
    lastResult = result;
    used = candidate;
    break;
  }
  return { unavailable, result: lastResult, used };
}

function runScopedClangLint(cwd, targets) {
  if (targets.length === 0) {
    return { name: "clang-lint", status: "skipped", reason: "no C/C++ lintable scoped files", targets: [] };
  }

  const failures = [];
  let unavailable = false;
  let durationMs = 0;
  const usedCommands = new Set();
  for (const file of targets) {
    const probe = runFirstAvailableSyntaxCommand(cwd, clangCommandsForFile(file));
    const result = probe.result;
    durationMs += result?.durationMs || 0;
    if (probe.unavailable) {
      unavailable = true;
      break;
    }
    if (probe.used?.display) usedCommands.add(probe.used.display);
    if (result?.exitCode !== 0) {
      failures.push(parseGenericLintFinding({
        result,
        cwd,
        file,
        rule: probe.used?.display || "C/C++ syntax check",
        fallback: "C/C++ syntax check failed",
      }));
      if (failures.length >= MAX_FAILURES) break;
    }
  }

  if (unavailable) {
    return {
      name: "clang-lint",
      status: "skipped",
      reason: "clang/gcc executable not available",
      targets,
      durationMs,
    };
  }

  return {
    name: "clang-lint",
    status: failures.length === 0 ? "passed" : "failed",
    targets,
    command: usedCommands.size > 0 ? [...usedCommands].join(" && ") : "clang/gcc -fsyntax-only",
    durationMs,
    failures,
  };
}

function parsePhpLintFinding(result, cwd, file) {
  const text = compact(`${result.stdout}\n${result.stderr}`) || result.error || `php -l exited ${result.exitCode}`;
  const lineMatch = text.match(/\bon\s+line\s+(\d+)\b/i);
  return {
    file: relPath(cwd, file) || file,
    line: lineMatch ? Number(lineMatch[1]) : null,
    column: null,
    rule: "php -l",
    message: text.replace(/\n?Errors parsing .+$/i, "").trim() || "PHP syntax check failed",
    severity: "error",
  };
}

function runScopedPhpLint(cwd, targets) {
  if (targets.length === 0) {
    return { name: "php-lint", status: "skipped", reason: "no PHP lintable scoped files", targets: [] };
  }

  const failures = [];
  let unavailable = false;
  let durationMs = 0;
  for (const file of targets) {
    const result = runProcess("php", ["-l", file], cwd);
    durationMs += result.durationMs;
    if (commandUnavailable(result)) {
      unavailable = true;
      break;
    }
    if (result.exitCode !== 0) {
      failures.push(parsePhpLintFinding(result, cwd, file));
      if (failures.length >= MAX_FAILURES) break;
    }
  }

  if (unavailable) {
    return {
      name: "php-lint",
      status: "skipped",
      reason: "php executable not available",
      targets,
      durationMs,
    };
  }

  return {
    name: "php-lint",
    status: failures.length === 0 ? "passed" : "failed",
    targets,
    command: `php -l ${targets.length === 1 ? targets[0] : "<scoped php files>"}`,
    durationMs,
    failures,
  };
}

function runScopedLint(cwd, files) {
  const targets = lintableFiles(cwd, files);
  if (targets.length === 0) {
    return { name: "lint", status: "skipped", reason: "no lintable scoped files", targets: [] };
  }

  const subchecks = [
    runScopedJsLint(cwd, jsLintableFiles(cwd, files)),
    runScopedPythonLint(cwd, pythonLintableFiles(cwd, files)),
    runScopedPhpLint(cwd, phpLintableFiles(cwd, files)),
    runScopedGoLint(cwd, goLintableFiles(cwd, files)),
    runScopedRustLint(cwd, rustLintableFiles(cwd, files)),
    runScopedClangLint(cwd, clangLintableFiles(cwd, files)),
  ].filter((check) => check.targets?.length > 0);
  const failed = subchecks.filter((check) => check.status === "failed");
  const passed = subchecks.filter((check) => check.status === "passed");
  const skipped = subchecks.filter((check) => check.status === "skipped");
  const status = failed.length > 0
    ? "failed"
    : passed.length > 0
      ? "passed"
      : "skipped";
  const failures = failed.flatMap((check) =>
    (check.failures || []).map((failure) => ({ ...failure, subcheck: check.name }))
  );

  // A skipped language subcheck alongside passes must stay visible at the top
  // level; otherwise "passed" can overstate scoped lint coverage.
  const skippedNote = skipped.length > 0 && status !== "skipped"
    ? skipped.map((check) => `${check.name} skipped: ${check.reason || "unknown reason"}`).join("; ")
    : null;
  return {
    name: "lint",
    status,
    reason: status === "skipped"
      ? skipped.map((check) => check.reason).filter(Boolean).join("; ") || "all lint subchecks skipped"
      : skippedNote,
    targets,
    command: subchecks.map((check) => check.command).filter(Boolean).join(" && ") || null,
    durationMs: subchecks.reduce((sum, check) => sum + (Number(check.durationMs) || 0), 0),
    failures,
    // Raw runner output from failed subchecks; runScopedChecks falls back to
    // this when a failure produced no parsed findings (e.g. eslint config
    // errors that print only to stderr).
    output: failed.map((check) => check.output).filter(Boolean).join("\n") || null,
    subchecks: subchecks.map((check) => ({
      name: check.name,
      status: check.status,
      reason: check.reason || null,
      target_count: check.targets?.length ?? null,
      command: check.command || null,
    })),
  };
}

function runTypecheck(cwd) {
  if (!packageScript(cwd, "typecheck")) {
    return { name: "typecheck", status: "skipped", reason: "package.json has no typecheck script" };
  }
  const result = runProcess(npmCommand(), ["run", "typecheck"], cwd, { timeoutMs: 180000 });
  const failureOutput = compact(`${result.stdout}\n${result.stderr}`) || result.error || `typecheck exited ${result.exitCode}`;
  return {
    name: "typecheck",
    status: result.exitCode === 0 ? "passed" : "failed",
    command: result.command,
    durationMs: result.durationMs,
    output: result.exitCode === 0 ? null : failureOutput,
  };
}

export function runScopedChecks({ args = {}, cwd, declaredScope = {} } = {}) {
  const requested = Array.isArray(args.checks) && args.checks.length > 0
    ? args.checks.map((check) => String(check).trim().toLowerCase()).filter(Boolean)
    : ["lint"];
  const scope = args.scope && typeof args.scope === "object" ? args.scope : declaredScope;
  const files = declaredScopeFiles(cwd, scope);
  const checks = [];
  if (requested.includes("lint")) checks.push(runScopedLint(cwd, files));
  if (requested.includes("typecheck")) checks.push(runTypecheck(cwd));
  if (checks.length === 0) {
    return {
      ok: true,
      summary: "no checks requested",
      scoped_files: files,
      checks: [],
    };
  }
  const failed = checks.filter((check) => check.status === "failed");
  const failures = failed.flatMap((check) =>
    (check.failures || []).map((failure) => ({ check: check.name, ...failure }))
  );
  const outputFailures = failed
    .filter((check) => !check.failures?.length && check.output)
    .map((check) => ({ check: check.name, message: check.output }));
  const ok = failed.length === 0;
  // Keep skip caveats in the headline: agents act on ok/summary alone, and a
  // bare "all checks passed" over a skipped subcheck overstates coverage.
  const skipNotes = ok
    ? checks.filter((check) => check.status !== "failed" && check.reason).map((check) => `${check.name}: ${check.reason}`)
    : [];
  return {
    ok,
    summary: ok
      ? (skipNotes.length ? `all checks passed (${skipNotes.join("; ")})` : "all checks passed")
      : `${failed.map((check) => check.name).join(", ")} failed`,
    scoped_files: files,
    checks: checks.map((check) => ({
      name: check.name,
      status: check.status,
      reason: check.reason || null,
      target_count: check.targets?.length ?? null,
      duration_ms: check.durationMs ?? null,
      command: check.command || null,
      subchecks: check.subchecks || null,
    })),
    failures: [...failures, ...outputFailures].slice(0, MAX_FAILURES),
  };
}
