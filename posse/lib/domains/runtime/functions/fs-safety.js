import fs from "node:fs";
import path from "node:path";

export function realpathExistingPrefix(absPath) {
  let current = path.resolve(absPath);
  const missingParts = [];

  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(absPath);
    missingParts.unshift(path.basename(current));
    current = parent;
  }

  let realCurrent;
  try {
    realCurrent = fs.realpathSync.native(current);
  } catch {
    realCurrent = path.resolve(current);
  }
  return missingParts.length > 0 ? path.join(realCurrent, ...missingParts) : realCurrent;
}

function comparablePath(value, { followSymlinks = true } = {}) {
  const resolved = path.resolve(value);
  return followSymlinks ? realpathExistingPrefix(resolved) : resolved;
}

export function isInsideRoot(targetPath, rootPath, {
  allowEqual = true,
  followSymlinks = true,
} = {}) {
  if (!targetPath || !rootPath) return false;
  const root = comparablePath(rootPath, { followSymlinks });
  const target = comparablePath(targetPath, { followSymlinks });
  const relative = path.relative(root, target);
  if (!relative) return allowEqual;
  return !relative.startsWith("..") && !path.isAbsolute(relative);
}

export function isPathInside(rootPath, candidatePath, options = {}) {
  return isInsideRoot(candidatePath, rootPath, options);
}

export function resolvePathWithin(rootPath, targetPath, options = {}) {
  if (!rootPath || !targetPath) return null;
  const resolved = path.resolve(rootPath, targetPath);
  return isInsideRoot(resolved, rootPath, options) ? resolved : null;
}
