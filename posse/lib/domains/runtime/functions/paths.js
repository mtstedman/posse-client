import path from "path";
import { resolveManagedPythonRuntimeForProject } from "./python-runtime.js";

let runtimePathOverrides = {};

function overridePath(key) {
  const value = runtimePathOverrides?.[key];
  return value ? path.resolve(value) : null;
}

export function normalizeCwd(cwd = null) {
  return path.resolve(cwd || process.cwd());
}

export function normalizeProjectDir(projectDir = null, cwd = null) {
  return path.resolve(overridePath("projectDir")
    || projectDir
    || cwd
    || process.cwd());
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

export function buildRuntimeEnv(projectDir = null, cwd = null, baseEnv = process.env) {
  const env = { ...(baseEnv || {}) };
  const projectRoot = normalizeProjectDir(projectDir, cwd);
  const pythonRuntime = resolveManagedPythonRuntimeForProject({ projectDir: projectRoot });
  if (pythonRuntime?.ready) {
    env.POSSE_PYTHON_RUNTIME = pythonRuntime.runtimeDir;
    env.POSSE_PROJECT_PYTHON = pythonRuntime.python;
    env.VIRTUAL_ENV = pythonRuntime.runtimeDir;
    prependPathDir(env, pythonRuntime.binDir);
  }
  return env;
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
