import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import {
  DEFAULT_INSTALLED_POSSE_ROOT,
  managedInstallStateRoot,
} from "../../../shared/platform/functions/managed-install-state.js";

export const DEFAULT_POSSE_ROOT = DEFAULT_INSTALLED_POSSE_ROOT;
export const PYTHON_RUNTIME_STAMP_NAME = ".posse-requirements.sha256";

// A repo counts as a Python project for managed-runtime provisioning when any
// of these exist at its root. Keep this aligned with the SCIP python fileset
// (indexers.js) so "SCIP says python" and "doctor provisions python" agree.
export const PYTHON_PROJECT_MANIFESTS = Object.freeze([
  "requirements.txt",
  "pyproject.toml",
  "setup.py",
  "setup.cfg",
  "Pipfile",
  "poetry.lock",
  "uv.lock",
  "tox.ini",
  "pytest.ini",
]);

// Executability is stable for the life of one Posse process. Cache successful
// and failed probes by file metadata so building child environments does not
// spawn Python for every provider/tool invocation.
const PYTHON_EXECUTABLE_PROBE_CACHE = new Map();

function fileExists(filePath) {
  try {
    return fs.statSync(filePath).isFile();
  } catch {
    return false;
  }
}

function hashText(value) {
  return crypto.createHash("sha256").update(String(value || "")).digest("hex");
}

function hashFile(filePath) {
  try {
    return crypto.createHash("sha256").update(fs.readFileSync(filePath)).digest("hex");
  } catch {
    return "";
  }
}

function runtimeSlug(projectDir) {
  const base = path.basename(path.resolve(projectDir || process.cwd())) || "workspace";
  return base
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40) || "workspace";
}

export function getPythonRuntimeRoot(posseRoot = DEFAULT_POSSE_ROOT) {
  return path.join(managedInstallStateRoot(posseRoot || DEFAULT_POSSE_ROOT), "runtime", "python");
}

export function getPythonToolchainRoot(posseRoot = DEFAULT_POSSE_ROOT) {
  return path.join(managedInstallStateRoot(posseRoot || DEFAULT_POSSE_ROOT), "runtime", "python-toolchain");
}

export function getPythonToolchainExecutable(posseRoot = DEFAULT_POSSE_ROOT) {
  const root = getPythonToolchainRoot(posseRoot);
  return process.platform === "win32"
    ? path.join(root, "python", "python.exe")
    : path.join(root, "python", "bin", "python3");
}

export function getPythonToolchainSearchDirs(posseRoot = DEFAULT_POSSE_ROOT) {
  const root = getPythonToolchainRoot(posseRoot);
  return [
    path.join(root, "python"),
    path.join(root, "python", "Scripts"),
    path.join(root, "python", "bin"),
  ];
}

export function listPythonProjectManifests(projectDir = process.cwd()) {
  const root = path.resolve(projectDir || process.cwd());
  return PYTHON_PROJECT_MANIFESTS
    .map((name) => ({ name, path: path.join(root, name) }))
    .filter((entry) => fileExists(entry.path));
}

export function getPythonVenvBinDir(runtimeDir) {
  return process.platform === "win32"
    ? path.join(runtimeDir, "Scripts")
    : path.join(runtimeDir, "bin");
}

export function getPythonVenvExecutable(runtimeDir) {
  return process.platform === "win32"
    ? path.join(getPythonVenvBinDir(runtimeDir), "python.exe")
    : path.join(getPythonVenvBinDir(runtimeDir), "python");
}

function pythonExecutableWorks(python) {
  if (!fileExists(python)) return false;
  try {
    const stat = fs.statSync(python);
    const signature = `${stat.size}:${stat.mtimeMs}`;
    const cached = PYTHON_EXECUTABLE_PROBE_CACHE.get(python);
    if (cached?.signature === signature) return cached.ok;
    const result = spawnSync(python, ["--version"], {
      encoding: "utf8",
      windowsHide: true,
      timeout: 15000,
    });
    // A zero exit is not enough: interpreter-shaped stubs (e.g. the Windows
    // Store alias) can exit 0 without being Python. Require the banner.
    const ok = result.status === 0
      && /^Python 3\./mu.test(`${result.stdout || ""}\n${result.stderr || ""}`);
    PYTHON_EXECUTABLE_PROBE_CACHE.set(python, { signature, ok });
    return ok;
  } catch {
    return false;
  }
}

export function resolveManagedPythonRuntime({
  projectDir = process.cwd(),
  posseRoot = DEFAULT_POSSE_ROOT,
  requirementsHash = "",
} = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const normalizedRoot = process.platform === "win32" ? root.toLowerCase() : root;
  const rootKey = hashText(normalizedRoot).slice(0, 12);
  const reqKey = String(requirementsHash || "no-requirements").slice(0, 16);
  const runtimeDir = path.join(getPythonRuntimeRoot(posseRoot), `${runtimeSlug(root)}-${rootKey}-${reqKey}`);
  return {
    runtimeDir,
    binDir: getPythonVenvBinDir(runtimeDir),
    python: getPythonVenvExecutable(runtimeDir),
    stampPath: path.join(runtimeDir, PYTHON_RUNTIME_STAMP_NAME),
  };
}

export function resolveManagedPythonRuntimeForProject({
  projectDir = process.cwd(),
  posseRoot = DEFAULT_POSSE_ROOT,
  assumePython = false,
} = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const manifests = listPythonProjectManifests(root);
  if (manifests.length === 0 && !assumePython) {
    // Marker-less repos can still own a managed runtime: doctor provisions one
    // when the enabled SCIP environments detect python sources. Consumers that
    // cannot re-run that detection (buildRuntimeEnv, test resolvers) find it
    // through its stamp instead of returning null.
    const provisioned = resolveManagedPythonRuntime({ projectDir: root, posseRoot, requirementsHash: hashText("no-manifest") });
    if (!fileExists(provisioned.stampPath)) return null;
    return {
      ...provisioned,
      projectDir: root,
      manifests: [],
      requirements: null,
      requirementsHash: hashText("no-manifest"),
      ready: pythonExecutableWorks(provisioned.python),
    };
  }
  const requirements = manifests.find((entry) => entry.name === "requirements.txt")?.path || null;
  // Requirements-only projects keep the legacy requirements-file hash so their
  // existing managed venvs and stamps survive the manifest-detection widening.
  const manifestHash = manifests.length === 0
    ? hashText("no-manifest")
    : (manifests.length === 1 && requirements
      ? hashFile(requirements)
      : hashText(manifests.map((entry) => `${entry.name}:${hashFile(entry.path)}`).join("\n")));
  if (!manifestHash) return null;
  const runtime = resolveManagedPythonRuntime({ projectDir: root, posseRoot, requirementsHash: manifestHash });
  let installedHash = "";
  try { installedHash = fs.readFileSync(runtime.stampPath, "utf8").trim(); } catch { installedHash = ""; }
  return {
    ...runtime,
    projectDir: root,
    manifests,
    requirements,
    requirementsHash: manifestHash,
    ready: installedHash === manifestHash && pythonExecutableWorks(runtime.python),
  };
}
