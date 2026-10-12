import { NODE_LOCKS } from "../../../catalog/node-package-managers.js";
import fs from "node:fs";
import path from "node:path";


function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
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
export function detectNodePackageManager(projectDir, { packageManager, allowUnversioned = false, defaultManager = "npm" } = {}) {
  const declared = declaredManager(projectDir, packageManager, allowUnversioned);
  const locks = NODE_LOCKS.filter(([, lock]) => fileExists(path.join(projectDir, lock)));
  const selected = declared ? locks.find(([manager]) => manager === declared) : locks[0];
  return selected
    ? { manager: selected[0], lock: selected[1] }
    : { manager: declared || defaultManager, lock: null };
}
