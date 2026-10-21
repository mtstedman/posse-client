import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { managedToolRoot } from "../../../shared/platform/functions/managed-install-state.js";
import { MANAGED_TYPESCRIPT_PACKAGES, MANAGED_NODE_VERIFIER_ENTRIES } from "../../../catalog/node-verification.js";

export function managedNodeVerificationRoot(posseRoot) {
  return path.join(managedToolRoot(posseRoot), "scip", "node");
}

// Check the shipped lock, not just the indexer's executable: an older install
// may contain working SCIP binaries but none of the newly required verifiers.
export function managedNodeVerifiersReady(nodeRoot, sourceRoot = nodeRoot) {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
    const required = Object.entries(MANAGED_NODE_VERIFIER_ENTRIES).filter(([name]) => manifest.dependencies?.[name]);
    if (!required.length) return true;
    const lock = JSON.parse(fs.readFileSync(path.join(sourceRoot, "package-lock.json"), "utf8"));
    return required.every(([name, entry]) => {
      const root = path.join(nodeRoot, "node_modules", name);
      const installed = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
      return installed.version === lock.packages?.[`node_modules/${name}`]?.version
        && fs.statSync(path.join(root, entry)).isFile();
    });
  } catch { return false; }
}

export function resolveVerificationTypeScript(cwd, { posseRoot } = {}) {
  const projectRequire = createRequire(path.join(cwd, "package.json"));
  try {
    return { compiler: projectRequire.resolve("typescript/bin/tsc"), ts: projectRequire("typescript"), source: "project" };
  } catch { /* use a compatible managed compiler */ }
  const root = managedNodeVerificationRoot(posseRoot);
  try {
    const managedRequire = createRequire(path.join(root, "package.json"));
    const semver = managedRequire("semver");
    let manifest = {};
    try { manifest = JSON.parse(fs.readFileSync(path.join(cwd, "package.json"), "utf8")); } catch { /* config-only */ }
    const range = manifest.devDependencies?.typescript || manifest.dependencies?.typescript || manifest.peerDependencies?.typescript;
    for (const name of MANAGED_TYPESCRIPT_PACKAGES) {
      const packageRoot = path.join(root, "node_modules", name);
      const version = JSON.parse(fs.readFileSync(path.join(packageRoot, "package.json"), "utf8")).version;
      if (range && (!semver.validRange(range) || !semver.satisfies(version, range))) continue;
      return { compiler: path.join(packageRoot, "bin", "tsc"), ts: managedRequire(packageRoot), source: "managed" };
    }
  } catch { /* unavailable is explicit; verification never installs packages */ }
  return null;
}

export function managedBaselineLintInvocation({ posseRoot, projectConfigRoot = null } = {}) {
  const root = managedNodeVerificationRoot(posseRoot);
  const eslint = path.join(root, "node_modules", "eslint", "bin", "eslint.js");
  const parser = path.join(root, "node_modules", "@typescript-eslint", "parser", "dist", "index.js");
  if (!fs.existsSync(eslint) || !fs.existsSync(parser)) return null;
  if (projectConfigRoot) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(projectConfigRoot, "package.json"), "utf8"));
      const range = manifest.devDependencies?.eslint || manifest.dependencies?.eslint;
      const require = createRequire(path.join(root, "package.json"));
      const version = require("eslint/package.json").version;
      const semver = require("semver");
      if (range && (!semver.validRange(range) || !semver.satisfies(version, range))) return null;
    } catch { return null; }
  }
  return { eslint, root };
}
