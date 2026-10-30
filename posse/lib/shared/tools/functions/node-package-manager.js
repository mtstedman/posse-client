import { NODE_LOCKS, NODE_PACKAGE_MANAGER_OPTIONS } from "../../../catalog/node-package-managers.js";
import { getSetting } from "../../../domains/settings/functions/repository-settings.js";
import fs from "node:fs";
import path from "node:path";


function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

export function preferredNodePackageManager() {
  let preferred;
  try { preferred = getSetting("node_package_manager"); } catch { /* Before account initialization, keep the existing default. */ }
  return NODE_PACKAGE_MANAGER_OPTIONS.includes(preferred) ? preferred : "npm";
}

function declaredManager(projectDir, packageManager, allowUnversioned) {
  let declaration = packageManager;
  if (declaration == null) {
    try { declaration = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8")).packageManager; }
    catch { declaration = ""; }
  }
  const match = String(declaration || "").trim().toLowerCase().match(allowUnversioned ? /^(npm|pnpm|yarn|bun)(?:@|$)/ : /^(npm|pnpm|yarn|bun)@/);
  return match?.[1] || null;
}

// A packageManager declaration is the project's explicit choice even when a
// stale lock from another manager is present. For undeclared mixed locks,
// prefer the non-npm workspace lock before an incidental npm install lock.
export function detectNodePackageManager(projectDir, { packageManager, allowUnversioned = false, defaultManager } = {}) {
  const declared = declaredManager(projectDir, packageManager, allowUnversioned);
  const locks = NODE_LOCKS.filter(([, lock]) => fileExists(path.join(projectDir, lock)));
  const selected = declared ? locks.find(([manager]) => manager === declared) : locks[0];
  return selected
    ? { manager: selected[0], lock: selected[1] }
    : { manager: declared || (defaultManager === undefined ? preferredNodePackageManager() : defaultManager), lock: null };
}
