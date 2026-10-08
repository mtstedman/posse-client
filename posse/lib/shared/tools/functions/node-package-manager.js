import fs from "node:fs";
import path from "node:path";

const NODE_LOCKS = Object.freeze([
  ["npm", "package-lock.json"],
  ["npm", "npm-shrinkwrap.json"],
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
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

// The manifest declaration wins when its lock exists. Mixed lockfiles without
// a declaration use one stable order across install and verification paths.
export function detectNodePackageManager(projectDir, { packageManager } = {}) {
  const declared = declaredManager(projectDir, packageManager);
  const locks = NODE_LOCKS.filter(([, lock]) => fileExists(path.join(projectDir, lock)));
  const selected = locks.find(([manager]) => manager === declared) || locks[0];
  return selected
    ? { manager: selected[0], lock: selected[1] }
    : { manager: declared || "npm", lock: null };
}
