import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { commandSpawnSpec } from "../../../platform/functions/command-launch.js";

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

const PACKAGE_DISCOVERY_SKIP_DIRS = new Set([
  ".git",
  ".posse",
  ".posse-test-suites",
  ".posse-worktrees",
  "node_modules",
  "vendor",
]);
const MAX_DISCOVERED_PACKAGE_ROOTS = 64;
const JS_PROJECT_EXTENSIONS = new Set([".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx"]);

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

function normalizedRelativePath(from, to) {
  return path.relative(from, to).replace(/\\/g, "/");
}

function globPatternRegex(pattern) {
  const normalized = String(pattern || "").replace(/\\/g, "/").replace(/^\.\//, "");
  let source = "";
  for (let index = 0; index < normalized.length; index += 1) {
    const char = normalized[index];
    if (char === "*" && normalized[index + 1] === "*") {
      index += 1;
      if (normalized[index + 1] === "/") {
        index += 1;
        source += "(?:.*/)?";
      } else {
        source += ".*";
      }
    } else if (char === "*") {
      source += "[^/]*";
    } else if (char === "?") {
      source += "[^/]";
    } else {
      source += char.replace(/[|\\{}()[\]^$+?.]/g, "\\$&");
    }
  }
  return new RegExp(`^${source}$`);
}

function parseJsonConfig(text) {
  let stripped = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const next = text[index + 1];
    if (inString) {
      stripped += char;
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      stripped += char;
      continue;
    }
    if (char === "/" && next === "/") {
      while (index < text.length && text[index] !== "\n") index += 1;
      stripped += "\n";
      continue;
    }
    if (char === "/" && next === "*") {
      index += 2;
      while (index < text.length && !(text[index] === "*" && text[index + 1] === "/")) index += 1;
      index += 1;
      continue;
    }
    if (char === ",") {
      let lookahead = index + 1;
      while (/\s/.test(text[lookahead] || "")) lookahead += 1;
      if (["}", "]"].includes(text[lookahead])) continue;
    }
    stripped += char;
  }
  return JSON.parse(stripped.replace(/^\uFEFF/, ""));
}

function projectConfigOwnsFile(packageRoot, absoluteFile) {
  let config = null;
  for (const name of ["tsconfig.json", "jsconfig.json"]) {
    try {
      config = parseJsonConfig(fs.readFileSync(path.join(packageRoot, name), "utf8"));
      break;
    } catch {
      // Try the other supported project config.
    }
  }
  if (!config) return false;
  const relative = normalizedRelativePath(packageRoot, absoluteFile);
  const files = Array.isArray(config?.files) ? config.files : [];
  if (files.some((file) => normalizedRelativePath(packageRoot, path.resolve(packageRoot, file)) === relative)) {
    return true;
  }
  const includes = Array.isArray(config?.include) ? config.include : [];
  return includes.some((pattern) => {
    try { return globPatternRegex(pattern).test(relative); } catch { return false; }
  });
}

function discoverPackageRoots(projectRoot) {
  const roots = [];
  const stack = [path.resolve(projectRoot)];
  while (stack.length > 0 && roots.length < MAX_DISCOVERED_PACKAGE_ROOTS) {
    const dir = stack.pop();
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    if (entries.some((entry) => entry.isFile() && entry.name === "package.json")) roots.push(dir);
    for (const entry of entries) {
      if (!entry.isDirectory() || PACKAGE_DISCOVERY_SKIP_DIRS.has(entry.name)) continue;
      stack.push(path.join(dir, entry.name));
    }
  }
  return roots;
}

function siblingPackageRoot(projectRoot, file, packageRoots) {
  if (!JS_PROJECT_EXTENSIONS.has(path.extname(file).toLowerCase())) return null;
  const absoluteFile = path.resolve(projectRoot, file);
  const candidates = packageRoots
    .filter((root) => projectConfigOwnsFile(root, absoluteFile))
    .map((root) => ({
      root,
      distance: normalizedRelativePath(root, absoluteFile).split("/").length,
    }))
    .sort((left, right) => left.distance - right.distance || left.root.localeCompare(right.root));
  return candidates[0]?.root || null;
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

export function executableReady(command, root, {
  platform = process.platform,
  env = process.env,
  spawnSyncImpl = spawnSync,
} = {}) {
  if (!command) return false;
  const spawnSpec = commandSpawnSpec(command, ["--version"], { platform, env, spawnSyncImpl });
  try {
    const result = spawnSyncImpl(spawnSpec.command, spawnSpec.args, {
      cwd: root,
      env,
      stdio: "ignore",
      shell: false,
      timeout: 10_000,
      windowsHide: true,
      windowsVerbatimArguments: spawnSpec.windowsVerbatimArguments === true,
    });
    return result.status === 0;
  } catch {
    return false;
  }
}

function manifestsAt(root) {
  return ROOT_MARKERS.filter((marker) => fileExists(path.join(root, marker)));
}

export function groupVerificationFiles(projectRoot, files = []) {
  const root = path.resolve(projectRoot);
  const grouped = new Map();
  let packageRoots = null;
  for (const projectFile of files) {
    const nearest = nearestRoot(root, projectFile);
    if (!fileExists(path.join(nearest, "package.json"))) {
      packageRoots ||= discoverPackageRoots(root);
    }
    const verificationRoot = fileExists(path.join(nearest, "package.json"))
      ? nearest
      : (siblingPackageRoot(root, projectFile, packageRoots || []) || nearest);
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
  const command = manager;
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
