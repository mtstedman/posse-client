// @ts-check

import fs from "node:fs";
import path from "node:path";

function readJson(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * Return the non-optional package directories npm says are installed. npm's
 * hidden node_modules lock reflects the actual tree even when an ignored root
 * package-lock.json is stale; fall back to the root lock for older installs
 * and fixtures that do not have a hidden lock.
 *
 * @param {string} root
 * @returns {string[]}
 */
/**
 * Installed packages that have install-time work, judged from each package's
 * own package.json the way npm means to: a preinstall/install/postinstall
 * script, or a binding.gyp it has not opted out of with `"gypfile": false`.
 * Posse installs with --ignore-scripts and then rebuilds only these, because
 * npm installing from a lockfile misses `"gypfile": false` and compiles
 * better-sqlite3 (which ships prebuilt addons) from source, failing the whole
 * install on a host without a C++ toolchain such as a stock Windows PC. The
 * installed `.package-lock.json` records that same mistake, so the
 * dependency lockfile only names the packages and each package.json decides.
 * @param {string} root
 * @returns {string[]}
 */
export function npmInstallScriptPackages(root) {
  const lock = readJson(path.join(root, "npm-shrinkwrap.json"))
    || readJson(path.join(root, "package-lock.json"));
  if (!lock?.packages || typeof lock.packages !== "object") return [];

  const names = new Set();
  for (const relative of Object.keys(lock.packages)) {
    const normalized = String(relative || "").replace(/\\/g, "/").replace(/^\.\//u, "");
    const marker = normalized.lastIndexOf("node_modules/");
    if (marker === -1) continue;
    const dir = path.join(root, ...normalized.split("/"));
    const pkg = readJson(path.join(dir, "package.json"));
    if (!pkg) continue;
    const scripts = pkg.scripts || {};
    const builds = Boolean(scripts.preinstall || scripts.install || scripts.postinstall)
      || (pkg.gypfile !== false && fs.existsSync(path.join(dir, "binding.gyp")));
    if (builds) names.add(pkg.name || normalized.slice(marker + "node_modules/".length));
  }
  return [...names].sort();
}

export function npmInstalledPackageDirs(root) {
  const installedLock = readJson(path.join(root, "node_modules", ".package-lock.json"));
  const manifestLock = readJson(path.join(root, "npm-shrinkwrap.json"))
    || readJson(path.join(root, "package-lock.json"));
  const lock = installedLock?.packages && typeof installedLock.packages === "object"
    ? installedLock
    : manifestLock;
  if (!lock?.packages || typeof lock.packages !== "object") return [];

  const dirs = [];
  for (const [relative, metadata] of Object.entries(lock.packages)) {
    const normalized = String(relative || "").replace(/\\/g, "/").replace(/^\.\//u, "");
    if (!normalized || !normalized.split("/").includes("node_modules")) continue;
    if (metadata?.optional === true) continue;
    dirs.push(normalized);
  }
  return dirs;
}
