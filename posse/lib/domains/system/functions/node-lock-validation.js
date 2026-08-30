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
