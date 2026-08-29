import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const THIS_DIR = path.dirname(fileURLToPath(import.meta.url));
export const DEFAULT_INSTALLED_POSSE_ROOT = path.resolve(THIS_DIR, "..", "..", "..", "..");

function samePath(left, right, platform) {
  const a = path.resolve(String(left || ""));
  const b = path.resolve(String(right || ""));
  return platform === "win32" ? a.toLowerCase() === b.toLowerCase() : a === b;
}

export function defaultPerUserPosseStateRoot({
  platform = process.platform,
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  if (platform === "win32") {
    const localAppData = String(env?.LOCALAPPDATA || "").trim()
      || path.join(homeDir, "AppData", "Local");
    return path.resolve(localAppData, "Posse");
  }
  return path.resolve(homeDir, ".posse");
}

/**
 * Production Windows installs keep generated tools outside the code checkout.
 * Explicit/custom posseRoot values retain their colocated layout so development
 * sandboxes and tests remain isolated and deterministic.
 */
export function managedInstallStateRoot(posseRoot = DEFAULT_INSTALLED_POSSE_ROOT, options = {}) {
  const platform = options.platform || process.platform;
  const resolvedPosseRoot = path.resolve(String(posseRoot || DEFAULT_INSTALLED_POSSE_ROOT));
  if (platform === "win32" && samePath(resolvedPosseRoot, DEFAULT_INSTALLED_POSSE_ROOT, platform)) {
    return defaultPerUserPosseStateRoot({ ...options, platform });
  }
  return path.join(resolvedPosseRoot, ".posse");
}

export function managedToolRoot(posseRoot = DEFAULT_INSTALLED_POSSE_ROOT, options = {}) {
  const platform = options.platform || process.platform;
  const resolvedPosseRoot = path.resolve(String(posseRoot || DEFAULT_INSTALLED_POSSE_ROOT));
  if (platform === "win32" && samePath(resolvedPosseRoot, DEFAULT_INSTALLED_POSSE_ROOT, platform)) {
    return defaultPerUserPosseStateRoot({ ...options, platform });
  }
  return resolvedPosseRoot;
}
