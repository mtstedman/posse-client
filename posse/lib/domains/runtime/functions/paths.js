import { normalizeCwd, normalizeProjectDir, getRuntimeRoot, getRuntimeDbPath, getRuntimeResourcesDir, getRuntimeLogDir } from "./base-paths.js";
export { normalizeCwd, normalizeProjectDir, safeProcessCwd, getRuntimeRoot, getRuntimeDbPath, getRuntimeResourcesDir, getRuntimeLogDir, getRuntimeReportsDir, setRuntimePathOverrides, getRuntimePathOverridesForTests, setRuntimePathOverridesForTests } from "./base-paths.js";
import path from "path";
import { resolveManagedPythonRuntimeForProject, resolveManagedPythonTestToolchain } from "./python-runtime.js";
import { inspectManagedPythonTestToolchain } from "../../environments/functions/python-test-toolchain.js";














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
