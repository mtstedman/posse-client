import fs from "fs";
import os from "os";
import path from "path";
import {
  resolveManagedPythonRuntimeForProject,
  resolveManagedPythonTestToolchain,
} from "./python-runtime.js";
import { inspectManagedPythonTestToolchain } from "../../environments/functions/python-test-toolchain.js";

let runtimePathOverrides = {};
let testRuntimeRoot = null;

function isUnderTest() {
  return Boolean(process.env.NODE_TEST_CONTEXT || process.env.POSSE_TEST_RUN);
}

function getTestRuntimeLogDir() {
  if (!testRuntimeRoot) {
    testRuntimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-test-runtime-"));
  }
  return path.join(testRuntimeRoot, "logs");
}

function overridePath(key) {
  const value = runtimePathOverrides?.[key];
  return value ? path.resolve(value) : null;
}

export function normalizeCwd(cwd = null) {
  return path.resolve(cwd || safeProcessCwd());
}

export function normalizeProjectDir(projectDir = null, cwd = null) {
  return path.resolve(overridePath("projectDir")
    || projectDir
    || cwd
    || safeProcessCwd());
}

export function safeProcessCwd() {
  try {
    return process.cwd();
  } catch {
    return os.tmpdir();
  }
}

export function getRuntimeRoot(projectDir = null, cwd = null) {
  const override = overridePath("runtimeRoot");
  if (override) return override;
  const projectRoot = normalizeProjectDir(projectDir, cwd);
  return path.join(projectRoot, ".posse");
}

export function getRuntimeDbPath(projectDir = null, cwd = null) {
  const override = overridePath("dbPath");
  if (override) return override;
  const projectRoot = normalizeProjectDir(projectDir, cwd);
  return path.join(getRuntimeRoot(projectRoot, cwd), "db", "orchestrator.db");
}

export function getRuntimeResourcesDir(projectDir = null, cwd = null) {
  const override = overridePath("resourcesDir");
  if (override) return override;
  const projectRoot = normalizeProjectDir(projectDir, cwd);
  return path.join(getRuntimeRoot(projectRoot, cwd), "resources");
}

export function getRuntimeLogDir(projectDir = null, cwd = null) {
  const override = overridePath("logDir");
  if (override) return override;
  const runtimeRootOverride = overridePath("runtimeRoot");
  if (runtimeRootOverride) return path.join(runtimeRootOverride, "logs");
  // Direct unit tests often exercise an in-memory database without installing
  // runtime-path overrides. Keep their logger side effects out of the source
  // checkout while preserving explicit fixture/project destinations.
  if (isUnderTest() && !overridePath("projectDir") && projectDir == null && cwd == null) {
    return getTestRuntimeLogDir();
  }
  const projectRoot = normalizeProjectDir(projectDir, cwd);
  return path.join(getRuntimeRoot(projectRoot, cwd), "logs");
}

export function getRuntimeReportsDir(projectDir = null, cwd = null) {
  return path.join(path.dirname(getRuntimeDbPath(projectDir, cwd)), "reports");
}

function pathKey(env) {
  if (process.platform !== "win32") return "PATH";
  return Object.keys(env || {}).find((key) => key.toLowerCase() === "path") || "PATH";
}

function prependPathDir(env, dir) {
  if (!dir) return env;
  const key = pathKey(env);
  const current = String(env[key] || "");
  const entries = current.split(path.delimiter).filter(Boolean);
  const normalized = path.resolve(dir);
  const hasEntry = entries.some((entry) => path.resolve(entry) === normalized);
  env[key] = hasEntry ? current : [normalized, ...entries].join(path.delimiter);
  return env;
}

/** Put one managed Python runtime on `env` (mutated and returned). */
export function applyManagedPythonRuntimeEnv(env, pythonRuntime) {
  if (!env || !pythonRuntime?.runtimeDir || !pythonRuntime?.binDir) return env;
  env.POSSE_PYTHON_RUNTIME = pythonRuntime.runtimeDir;
  env.POSSE_PROJECT_PYTHON = pythonRuntime.python;
  env.VIRTUAL_ENV = pythonRuntime.runtimeDir;
  return prependPathDir(env, pythonRuntime.binDir);
}

export function envPathIncludesDir(env, dir) {
  if (!dir) return false;
  const normalized = path.resolve(dir);
  return String(env?.[pathKey(env)] || "")
    .split(path.delimiter)
    .filter(Boolean)
    .some((entry) => path.resolve(entry) === normalized);
}

export function buildRuntimeEnv(projectDir = null, cwd = null, baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  const projectRoot = normalizeProjectDir(projectDir, cwd);
  const projectRuntime = resolveManagedPythonRuntimeForProject({ projectDir: projectRoot });
  const inspectedSharedRuntime = inspectManagedPythonTestToolchain();
  const sharedRuntime = inspectedSharedRuntime.ready
    ? { ...resolveManagedPythonTestToolchain(), ready: true }
    : null;
  const pythonRuntime = projectRuntime?.ready ? projectRuntime : sharedRuntime;
  if (pythonRuntime?.ready) applyManagedPythonRuntimeEnv(env, pythonRuntime);
  return env;
}

/**
 * Re-apply the runtime env to a live env (this process by default). Startup
 * builds PATH before the boot dependency step can create or rebuild the
 * managed project venv or shared selected-language test toolchain, and
 * children that inherit process.env only see it after this runs.
 */
export function refreshProcessRuntimeEnv(projectDir, env = process.env) {
  const next = buildRuntimeEnv(projectDir, projectDir, env);
  for (const key of ["POSSE_PYTHON_RUNTIME", "POSSE_PROJECT_PYTHON", "VIRTUAL_ENV", pathKey(next)]) {
    if (next[key] !== undefined && env[key] !== next[key]) env[key] = next[key];
  }
  return {
    python: next.POSSE_PROJECT_PYTHON || null,
    runtimeDir: next.POSSE_PYTHON_RUNTIME || null,
  };
}

export function setRuntimePathOverrides(overrides = null) {
  runtimePathOverrides = {};
  if (!overrides || typeof overrides !== "object") return;
  for (const [key, value] of Object.entries(overrides)) {
    if (value == null || String(value).trim() === "") continue;
    runtimePathOverrides[key] = path.resolve(String(value));
  }
}

export const setRuntimePathOverridesForTests = setRuntimePathOverrides;

/** Snapshot the exact override layer so nested test fixtures can restore it. */
export function getRuntimePathOverridesForTests() {
  return { ...runtimePathOverrides };
}

export function normalizeProviderPaths({ cwd = null, projectDir = null } = {}) {
  const normalizedCwd = normalizeCwd(cwd);
  const normalizedProjectDir = normalizeProjectDir(projectDir, normalizedCwd);
  return {
    cwd: normalizedCwd,
    projectDir: normalizedProjectDir,
    runtimeRoot: getRuntimeRoot(normalizedProjectDir, normalizedCwd),
    dbPath: getRuntimeDbPath(normalizedProjectDir, normalizedCwd),
    resourcesDir: getRuntimeResourcesDir(normalizedProjectDir, normalizedCwd),
    logDir: getRuntimeLogDir(normalizedProjectDir, normalizedCwd),
  };
}
