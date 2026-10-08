import fs from "node:fs";
import path from "node:path";

const NODE_LOCKS = Object.freeze([
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
  ["npm", "npm-shrinkwrap.json"],
  ["npm", "package-lock.json"],
]);

function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function declaredManager(projectDir, packageManager) {
  let declaration = packageManager;
  if (declaration == null) {
    try { declaration = JSON.parse(fs.readFileSync(path.join(projectDir, "package.json"), "utf8")).packageManager; }
    catch { declaration = ""; }
  }
  const match = String(declaration || "").trim().toLowerCase().match(/^(npm|pnpm|yarn|bun)@/);
  return match?.[1] || null;
}

// A packageManager declaration is the project's explicit choice even when a
// stale lock from another manager is present. For undeclared mixed locks,
// prefer the non-npm workspace lock before an incidental npm install lock.
export function detectNodePackageManager(projectDir, { packageManager } = {}) {
  const declared = declaredManager(projectDir, packageManager);
  const locks = NODE_LOCKS.filter(([, lock]) => fileExists(path.join(projectDir, lock)));
  const selected = declared ? locks.find(([manager]) => manager === declared) : locks[0];
  return selected
    ? { manager: selected[0], lock: selected[1] }
    : { manager: declared || "npm", lock: null };
}
