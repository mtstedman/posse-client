// @ts-check



export const NODE_LOCKS = Object.freeze([
  ["pnpm", "pnpm-lock.yaml"],
  ["yarn", "yarn.lock"],
  ["bun", "bun.lock"],
  ["bun", "bun.lockb"],
  ["npm", "npm-shrinkwrap.json"],
  ["npm", "package-lock.json"],
]);

// Executable spellings recognized by verification and dependency repair.
export const NODE_PACKAGE_MANAGER_EXECUTABLES = Object.freeze([
  "npm", "npm.cmd", "pnpm", "pnpm.cmd", "yarn", "yarn.cmd", "bun", "bun.exe",
]);
