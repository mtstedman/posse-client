import fs from "node:fs";
import path from "node:path";
import { gitExec } from "../../../../git/functions/utils.js";

const VENDOR_ROOTS = ["third_party", "third-party", "vendor"];

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

function runtimeDependencyNames(repoRoot) {
  const names = new Set();
  const composer = readJson(path.join(repoRoot, "composer.json"));
  for (const name of Object.keys(composer?.require || {})) {
    if (name !== "php" && !name.startsWith("ext-")) names.add(name);
  }
  const pkg = readJson(path.join(repoRoot, "package.json"));
  for (const section of [pkg?.dependencies, pkg?.optionalDependencies, pkg?.peerDependencies]) {
    for (const name of Object.keys(section || {})) names.add(name);
  }
  return [...names].sort();
}

function packageRootCandidates(dependency) {
  const unscoped = String(dependency).split("/").filter(Boolean).at(-1);
  const out = [];
  for (const vendorRoot of VENDOR_ROOTS) {
    out.push(`${vendorRoot}/${dependency}`);
    if (unscoped && unscoped !== dependency) out.push(`${vendorRoot}/${unscoped}`);
  }
  return [...new Set(out)];
}

function childManifestName(repoRoot, relativeRoot) {
  const composer = readJson(path.join(repoRoot, relativeRoot, "composer.json"));
  if (typeof composer?.name === "string") return composer.name.trim();
  const pkg = readJson(path.join(repoRoot, relativeRoot, "package.json"));
  return typeof pkg?.name === "string" ? pkg.name.trim() : "";
}

function trackedRepoPaths(repoRoot) {
  try {
    return String(gitExec(["ls-files", "-z"], repoRoot, { timeoutMs: 5000 }))
      .split("\0")
      .filter(Boolean)
      .map((entry) => entry.replace(/\\/g, "/"));
  } catch { return []; }
}

/**
 * Resolve in-tree runtime dependencies whose declaration, child package
 * identity, and tracked source root all agree. The triple check prevents a
 * generic `vendor/` directory from changing ranking by path name alone.
 *
 * @param {string} repoRoot
 * @param {{ trackedPaths?: string[] }} [options]
 */
export function resolveVendoredSourcePromotions(repoRoot, { trackedPaths } = {}) {
  const root = path.resolve(repoRoot || process.cwd());
  const tracked = (Array.isArray(trackedPaths) ? trackedPaths : trackedRepoPaths(root))
    .map((entry) => String(entry).replace(/\\/g, "/").replace(/^\.\//, ""));
  const promotions = [];
  for (const dependency of runtimeDependencyNames(root)) {
    for (const relativeRoot of packageRootCandidates(dependency)) {
      if (childManifestName(root, relativeRoot) !== dependency) continue;
      const sourcePrefix = `${relativeRoot}/src`;
      if (!tracked.some((entry) => entry.startsWith(`${sourcePrefix}/`))) continue;
      promotions.push({ dependency, root: relativeRoot, sourcePrefix });
      break;
    }
  }
  return promotions;
}

export function vendoredPromotionForPath(repoRelativePath, promotions = []) {
  const normalized = String(repoRelativePath || "").replace(/\\/g, "/").replace(/^\.\//, "");
  if (!normalized || /(?:^|\/)(?:tests?|specs?|fixtures?|__tests__|__fixtures__)(?:\/|$)/i.test(normalized)) {
    return null;
  }
  return (Array.isArray(promotions) ? promotions : []).find((entry) => (
    normalized === entry?.sourcePrefix || normalized.startsWith(`${entry?.sourcePrefix}/`)
  )) || null;
}
