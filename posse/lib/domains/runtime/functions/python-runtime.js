import crypto from "crypto";
import fs from "fs";
import path from "path";
import { spawnSync } from "child_process";
import { fileURLToPath } from "url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_POSSE_ROOT = path.resolve(THIS_DIR, "..", "..", "..", "..");
export const PYTHON_RUNTIME_STAMP_NAME = ".posse-requirements.sha256";

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
  return path.join(path.resolve(posseRoot || DEFAULT_POSSE_ROOT), ".posse", "runtime", "python");
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
      stdio: "ignore",
      windowsHide: true,
      timeout: 15000,
    });
    const ok = result.status === 0;
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
} = {}) {
  const root = path.resolve(projectDir || process.cwd());
  const requirements = path.join(root, "requirements.txt");
  if (!fileExists(requirements)) return null;
  const requirementsHash = hashFile(requirements);
  if (!requirementsHash) return null;
  const runtime = resolveManagedPythonRuntime({ projectDir: root, posseRoot, requirementsHash });
  let installedHash = "";
  try { installedHash = fs.readFileSync(runtime.stampPath, "utf8").trim(); } catch { installedHash = ""; }
  return {
    ...runtime,
    projectDir: root,
    requirements,
    requirementsHash,
    ready: installedHash === requirementsHash && pythonExecutableWorks(runtime.python),
  };
}
