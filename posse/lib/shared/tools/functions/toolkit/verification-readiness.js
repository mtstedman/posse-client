import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const ROOT_MARKERS = Object.freeze([
  "package.json",
  "pyproject.toml",
  "setup.cfg",
  "Cargo.toml",
  "go.mod",
  "composer.json",
]);

const PACKAGE_MANAGER_LOCKS = Object.freeze([
  ["pnpm", ["pnpm-lock.yaml"]],
  ["yarn", ["yarn.lock"]],
  ["bun", ["bun.lock", "bun.lockb"]],
  ["npm", ["npm-shrinkwrap.json", "package-lock.json"]],
]);

function fileExists(filePath) {
  try { return fs.statSync(filePath).isFile(); } catch { return false; }
}

function nearestRoot(projectRoot, file) {
  const root = path.resolve(projectRoot);
  let cursor = path.dirname(path.resolve(root, file));
  while (cursor === root || cursor.startsWith(`${root}${path.sep}`)) {
    if (ROOT_MARKERS.some((marker) => fileExists(path.join(cursor, marker)))) return cursor;
    if (cursor === root) break;
    cursor = path.dirname(cursor);
  }
  return root;
}

function packageManagerFromManifest(root) {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
    const declared = String(pkg?.packageManager || "").split("@")[0].trim().toLowerCase();
    if (["npm", "pnpm", "yarn", "bun"].includes(declared)) return declared;
  } catch {
    // Lockfile precedence below is deterministic when packageManager is absent.
  }
  for (const [manager, locks] of PACKAGE_MANAGER_LOCKS) {
    if (locks.some((lock) => fileExists(path.join(root, lock)))) return manager;
  }
  return fileExists(path.join(root, "package.json")) ? "npm" : null;
}

function executableReady(command, root) {
  if (!command) return false;
  const executable = process.platform === "win32" && ["npm", "pnpm", "yarn", "bun"].includes(command)
    ? `${command}.cmd`
    : command;
  const result = spawnSync(executable, ["--version"], {
    cwd: root,
    stdio: "ignore",
    shell: false,
    timeout: 10_000,
    windowsHide: true,
  });
  return result.status === 0;
}

function manifestsAt(root) {
  return ROOT_MARKERS.filter((marker) => fileExists(path.join(root, marker)));
}

export function groupVerificationFiles(projectRoot, files = []) {
  const root = path.resolve(projectRoot);
  const grouped = new Map();
  for (const projectFile of files) {
    const verificationRoot = nearestRoot(root, projectFile);
    if (!grouped.has(verificationRoot)) {
      const packageManager = packageManagerFromManifest(verificationRoot);
      grouped.set(verificationRoot, {
        root: verificationRoot,
        root_relative: path.relative(root, verificationRoot).replace(/\\/g, "/") || ".",
        manifests: manifestsAt(verificationRoot),
        package_manager: packageManager,
        package_manager_ready: packageManager ? executableReady(packageManager, verificationRoot) : null,
        project_files: [],
        files: [],
      });
    }
    const group = grouped.get(verificationRoot);
    group.project_files.push(projectFile);
    group.files.push(path.relative(verificationRoot, path.resolve(root, projectFile)).replace(/\\/g, "/"));
  }
  if (grouped.size === 0) {
    const packageManager = packageManagerFromManifest(root);
    grouped.set(root, {
      root,
      root_relative: ".",
      manifests: manifestsAt(root),
      package_manager: packageManager,
      package_manager_ready: packageManager ? executableReady(packageManager, root) : null,
      project_files: [],
      files: [],
    });
  }
  return [...grouped.values()];
}

export function packageManagerRun(manager, script, extraArgs = []) {
  const command = process.platform === "win32" ? `${manager}.cmd` : manager;
  if (manager === "yarn") {
    return { command, args: ["run", script, ...extraArgs] };
  }
  if (manager === "bun") {
    return { command, args: ["run", script, ...extraArgs] };
  }
  return { command, args: ["run", script, ...(extraArgs.length ? ["--", ...extraArgs] : [])] };
}

export function verificationReadinessManifest(projectRoot, files = [], requested = []) {
  return {
    requested: [...requested],
    roots: groupVerificationFiles(projectRoot, files).map((group) => ({
      root: group.root_relative,
      manifests: group.manifests,
      package_manager: group.package_manager,
      package_manager_ready: group.package_manager_ready,
      files: group.project_files,
    })),
  };
}
