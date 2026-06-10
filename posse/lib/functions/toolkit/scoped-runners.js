import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";

const SOURCE_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".tsx", ".jsx"]);
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

function compact(value, max = MAX_OUTPUT_CHARS) {
  const text = String(value || "").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, max)}\n... (truncated ${text.length - max} chars)`;
}

function runProcess(command, args, cwd, { timeoutMs = 120000 } = {}) {
  const startedAt = Date.now();
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(command, args, {
    cwd,
    env,
    encoding: "utf8",
    windowsHide: true,
    shell: process.platform === "win32" && /\.cmd$/i.test(command),
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

function runScopedLint(cwd, files) {
  const targets = lintableFiles(cwd, files);
  if (targets.length === 0) {
    return { name: "lint", status: "skipped", reason: "no lintable scoped files", targets: [] };
  }
  const eslint = eslintBin(cwd);
  const result = eslint
    ? runProcess(process.execPath, [eslint, "--format", "json", ...targets], cwd)
    : runProcess(npmCommand(), ["run", "lint", "--", "--format", "json", ...targets], cwd);
  const findings = parseEslintFindings(result.stdout, result.stderr, cwd)
    .filter((finding) => finding.severity === "error");
  return {
    name: "lint",
    status: result.exitCode === 0 && findings.length === 0 ? "passed" : "failed",
    targets,
    command: result.command,
    durationMs: result.durationMs,
    failures: findings,
    output: result.exitCode === 0 ? null : compact(result.stderr || result.stdout || result.error || ""),
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
  return {
    ok,
    summary: ok ? "all checks passed" : `${failed.map((check) => check.name).join(", ")} failed`,
    scoped_files: files,
    checks: checks.map((check) => ({
      name: check.name,
      status: check.status,
      reason: check.reason || null,
      target_count: check.targets?.length ?? null,
      duration_ms: check.durationMs ?? null,
      command: check.command || null,
    })),
    failures: [...failures, ...outputFailures].slice(0, MAX_FAILURES),
  };
}
