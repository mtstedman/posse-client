// @ts-check
//
// One installation-level Python runtime for Posse's deterministic test tools.
// Project environments remain isolated for declared dependencies; a bare .py
// file uses this shared pytest-capable runtime and never creates a project venv.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

import {
  DEFAULT_POSSE_ROOT,
  getPythonToolchainExecutable,
  resolveManagedPythonTestToolchain,
} from "../../runtime/functions/python-runtime.js";
import { findCommandOnPath } from "../../../shared/platform/functions/command-launch.js";
import { runCommand, scipDependencyInstallEnv } from "./scip-install-runtime.js";
import { ensureManagedPythonToolchain } from "./python-toolchain-install.js";

export const PYTHON_TEST_TOOLCHAIN_SCHEMA = 1;
const INSPECTION_CACHE = new Map();

function fileExists(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function pythonCandidateWorks(candidate) {
  if (!candidate?.command) return false;
  try {
    const result = spawnSync(candidate.command, [...candidate.args, "--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15_000,
    });
    const match = `${result.stdout || ""}\n${result.stderr || ""}`.match(/^Python (\d+)\.(\d+)/mu);
    return result.status === 0 && Number(match?.[1]) === 3 && Number(match?.[2]) >= 9;
  } catch {
    return false;
  }
}

function basePythonCandidates(posseRoot, platform = process.platform, env = process.env) {
  const roots = platform === "win32"
    ? [
      { name: "py", args: ["-3"] },
      { name: "python", args: [] },
      { name: "python3", args: [] },
    ]
    : [
      { name: "python3", args: [] },
      { name: "python", args: [] },
    ];
  return [
    ...roots.map(({ name, args }) => ({ command: findCommandOnPath(name, { platform, env }), args })),
    { command: getPythonToolchainExecutable(posseRoot), args: [] },
  ].filter((candidate) => candidate.command && fileExists(candidate.command));
}

function pytestWorks(python) {
  if (!fileExists(python)) return false;
  try {
    const result = spawnSync(python, ["-m", "pytest", "--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 30_000,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

export function inspectManagedPythonTestToolchain(posseRoot = DEFAULT_POSSE_ROOT) {
  const runtime = resolveManagedPythonTestToolchain(posseRoot);
  let signature = "missing";
  try {
    const python = fs.statSync(runtime.python);
    const stamp = fs.statSync(runtime.stampPath);
    signature = `${python.size}:${python.mtimeMs}:${stamp.size}:${stamp.mtimeMs}`;
  } catch { /* incomplete runtime */ }
  const cached = INSPECTION_CACHE.get(runtime.runtimeDir);
  if (cached?.signature === signature) return { ...runtime, ...cached.result };
  const pythonReady = pythonCandidateWorks({ command: runtime.python, args: [] });
  const pytestReady = pythonReady && pytestWorks(runtime.python);
  const result = {
    ready: pythonReady && pytestReady,
    pythonReady,
    pytestReady,
  };
  INSPECTION_CACHE.set(runtime.runtimeDir, { signature, result });
  return { ...runtime, ...result };
}

export async function ensureManagedPythonTestToolchain({
  posseRoot = DEFAULT_POSSE_ROOT,
  dryRun = false,
  timeoutMs = null,
  onProgress = null,
  platform = process.platform,
  env = process.env,
} = {}) {
  const installEnv = scipDependencyInstallEnv(env);
  let before = inspectManagedPythonTestToolchain(posseRoot);
  if (before.ready) {
    return { ...before, ok: true, status: "ok", message: "shared Python + pytest test toolchain ready" };
  }
  if (dryRun) {
    return {
      ...before,
      ok: true,
      status: "dry-run",
      message: `would install shared Python + pytest test toolchain in ${before.runtimeDir}`,
    };
  }

  let basePython = basePythonCandidates(posseRoot, platform, env).find(pythonCandidateWorks) || null;
  if (!basePython) {
    onProgress?.("Python not found; installing managed CPython for the shared test toolchain");
    const toolchain = await ensureManagedPythonToolchain({ posseRoot, timeoutMs, onProgress, platform });
    if (!toolchain.ok) {
      return { ...before, ok: false, status: "failed", message: toolchain.message };
    }
    basePython = basePythonCandidates(posseRoot, platform, env).find(pythonCandidateWorks) || null;
  }
  if (!basePython) {
    return { ...before, ok: false, status: "failed", message: "Python 3.9+ is unavailable for the shared test toolchain" };
  }

  if (!before.pythonReady) {
    onProgress?.("creating shared Python test toolchain");
    fs.rmSync(before.runtimeDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(before.runtimeDir), { recursive: true });
    const create = await runCommand(basePython.command, [...basePython.args, "-m", "venv", before.runtimeDir], {
      timeoutMs,
      env: installEnv,
    });
    if (!create.ok) {
      return { ...before, ok: false, status: "failed", message: `python -m venv failed: ${create.message}` };
    }
    before = inspectManagedPythonTestToolchain(posseRoot);
  }

  if (!before.pytestReady) {
    onProgress?.("installing pytest into the shared Python test toolchain");
    const install = await runCommand(before.python, ["-m", "pip", "install", "pytest"], {
      timeoutMs,
      env: installEnv,
    });
    if (!install.ok) {
      return { ...before, ok: false, status: "failed", message: `pip install pytest failed: ${install.message}` };
    }
  }

  fs.writeFileSync(before.stampPath, `${PYTHON_TEST_TOOLCHAIN_SCHEMA}\n`, "utf8");
  const after = inspectManagedPythonTestToolchain(posseRoot);
  return after.ready
    ? { ...after, ok: true, status: "installed", message: "installed shared Python + pytest test toolchain" }
    : { ...after, ok: false, status: "failed", message: "shared Python test toolchain was installed, but pytest is not runnable" };
}
