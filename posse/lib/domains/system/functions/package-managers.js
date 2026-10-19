// Package managers the approved setup tools can run. Each entry knows its
// manifest, lockfile, ignored install directories and how to build argv, so
// the installers stay manager-agnostic: Posse builds every command itself
// from registry package names and version constraints, never from free-form
// shell text.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { NODE_LOCKS } from "../../../catalog/node-package-managers.js";
import { ENVIRONMENT_PACKAGE_MANAGERS } from "../../../catalog/tools/environment-setup.js";
import { findCommandOnPath } from "../../../shared/platform/functions/command-launch.js";
import { readManifest } from "./environment-paths.js";

const has = (dir, name) => fs.existsSync(path.join(dir, name));
const readText = (file) => { try { return fs.readFileSync(file, "utf8"); } catch { return ""; } };
const VERSION = /^[a-zA-Z0-9.*~^+<>=!, -]{1,100}$/u;
const NPM_NAME = /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u;
const PYTHON_NAME = /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?(?:\[[A-Za-z0-9._,-]+\])?$/u;
const NODE_INSTALL_ENV = { COREPACK_ENABLE_DOWNLOAD_PROMPT: "0" };

function ancestors(dir) {
  const list = [];
  for (let parent = path.dirname(dir); parent !== path.dirname(parent); parent = path.dirname(parent)) list.push(parent);
  return list;
}

function assertNodePackage(name, dir, manifest) {
  // A workspace member's install mutates the workspace root's lockfile.
  if (manifest.workspaces || has(dir, "pnpm-workspace.yaml")) throw new Error("Workspace installs need a workspace-wide setup plan; this installer supports standalone packages.");
  for (const parent of ancestors(dir)) {
    const file = path.join(parent, "package.json");
    if (has(parent, "pnpm-workspace.yaml") || (fs.existsSync(file) && readManifest(file).workspaces)) throw new Error("Nested workspace installs are not supported.");
  }
  const declared = String(manifest.packageManager || "").trim().toLowerCase().match(/^(npm|pnpm|yarn|bun)(?:@|$)/u)?.[1];
  if (declared && declared !== name) throw new Error(`package.json declares packageManager ${manifest.packageManager}; use manager ${declared}.`);
  const foreign = NODE_LOCKS.find(([manager, lock]) => manager !== name && has(dir, lock));
  if (foreign) throw new Error(`This package has ${foreign[1]}; use manager ${foreign[0]}, or resolve that lockfile first.`);
}

function yarnBerry(dir, manifest) {
  return has(dir, ".yarnrc.yml") || /^yarn@(?:[2-9]|\d{2,})/u.test(String(manifest.packageManager || ""))
    || readText(path.join(dir, "yarn.lock")).includes("__metadata:");
}

function node(name, entry) {
  return {
    name, label: name, toolchain: `Node.js and ${name}`, ecosystem: "node", manifest: "package.json", format: "json", link: "node",
    scripts: "flag", scriptsLabel: "Lifecycle scripts", configFiles: [".npmrc"], packageName: NPM_NAME,
    spec: ({ name: pkg, version }) => `${pkg}@${version}`,
    initialManifest: () => `${JSON.stringify({ private: true }, null, 2)}\n`,
    dependencyDirs: () => ["node_modules"],
    // Another manager's lockfile appearing after approval invalidates it.
    inputs: () => NODE_LOCKS.map(([, lock]) => lock),
    validate: (dir, manifest) => assertNodePackage(name, dir, manifest),
    env: () => NODE_INSTALL_ENV,
    // A successful install with declared dependencies always leaves node_modules.
    verify: (dir, manifest, dependencyDirs) => {
      if (!dependencyDirs.includes("node_modules") || fs.existsSync(path.join(dir, "node_modules"))) return null;
      if (Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length) return `${name} returned success without installing the declared dependencies`;
      fs.mkdirSync(path.join(dir, "node_modules"), { recursive: true });
      return null;
    },
    ...entry,
  };
}

function pep508({ name, version }) {
  if (version === "*") return name;
  if (/^\d/u.test(version)) return `${name}==${version}`;
  if (/^(?:===?|~=|!=|<=?|>=?)/u.test(version)) return `${name}${version.replaceAll(" ", "")}`;
  throw new Error(`Use a PEP 440 version or specifier for ${name}, e.g. 2.1.0 or >=2,<3.`);
}

const venvPython = (dir) => (process.platform === "win32" ? path.join(dir, ".venv", "Scripts", "python.exe") : path.join(dir, ".venv", "bin", "python"));
const verifyVenv = (label) => (dir) => (has(dir, ".venv/pyvenv.cfg") ? null : `${label} did not create .venv`);
const PIP_REQUIREMENT_FILES = ["requirements.txt", "requirements-dev.txt", "dev-requirements.txt"];
const requirementName = (line) => line.trim().match(/^([A-Za-z0-9][A-Za-z0-9._-]*)/u)?.[1]?.toLowerCase().replace(/[-_.]+/gu, "-");

// Poetry 2 keeps locked versions on `poetry lock`; Poetry 1 needs --no-update.
function poetryLockArgs(command) {
  const result = spawnSync(command, ["--version"], { encoding: "utf8", timeout: 20_000, windowsHide: true });
  const major = Number(String(result.stdout || "").match(/(\d+)\.\d+/u)?.[1] || 0);
  return major >= 2 ? ["lock"] : ["lock", "--no-update"];
}

const REGISTRY = {
  npm: node("npm", {
    toolchain: "Node.js/npm",
    lockfile: (dir) => (has(dir, "npm-shrinkwrap.json") ? "npm-shrinkwrap.json" : "package-lock.json"),
    // npm may rewrite package.json, so it is part of the reviewed scope.
    writesManifest: true,
    install: ({ dir, scripts }) => [{ argv: ["install", "--prefix", dir, "--global=false", "--workspaces=false", "--package-lock=true", "--package-lock-only=false", "--dry-run=false", "--include=prod", "--include=dev", "--include=optional", "--no-audit", "--no-fund", `--ignore-scripts=${!scripts}`] }],
    add(context, specs) {
      return [{ argv: [...this.install(context)[0].argv, context.dev ? "--save-dev" : "--save-prod", "--", ...specs] }];
    },
  }),
  pnpm: node("pnpm", {
    lockfile: () => "pnpm-lock.yaml",
    install: ({ dir, scripts }) => [{ argv: ["install", "--dir", dir, "--no-frozen-lockfile", "--production=false", "--config.confirmModulesPurge=false", ...(scripts ? [] : ["--ignore-scripts"])] }],
    add: ({ dir, scripts, dev }, specs) => [{ argv: ["add", "--dir", dir, ...(dev ? ["--save-dev"] : []), "--config.confirmModulesPurge=false", ...(scripts ? [] : ["--ignore-scripts"]), ...specs] }],
  }),
  yarn: node("yarn", {
    lockfile: () => "yarn.lock",
    configFiles: [".npmrc", ".yarnrc", ".yarnrc.yml"],
    // Yarn 2+ defaults to Plug'n'Play, which has no node_modules to ignore or link.
    dependencyDirs: (dir, manifest) => (!yarnBerry(dir, manifest) || /^nodeLinker:\s*["']?(?:node-modules|pnpm)\b/mu.test(readText(path.join(dir, ".yarnrc.yml"))) ? ["node_modules"] : []),
    env: (dir, manifest, { scripts }) => (yarnBerry(dir, manifest)
      ? { ...NODE_INSTALL_ENV, YARN_ENABLE_SCRIPTS: String(scripts), YARN_ENABLE_IMMUTABLE_INSTALLS: "false", YARN_ENABLE_TELEMETRY: "false", YARN_ENABLE_PROGRESS_BARS: "false" }
      : NODE_INSTALL_ENV),
    install: ({ dir, manifest, scripts }) => [{ argv: yarnBerry(dir, manifest) ? ["install"] : ["install", "--non-interactive", "--no-progress", "--production=false", ...(scripts ? [] : ["--ignore-scripts"])] }],
    add: ({ dir, manifest, scripts, dev }, specs) => [{ argv: yarnBerry(dir, manifest)
      ? ["add", ...(dev ? ["--dev"] : []), ...specs]
      : ["add", ...(dev ? ["--dev"] : []), "--non-interactive", "--no-progress", ...(scripts ? [] : ["--ignore-scripts"]), ...specs] }],
  }),
  bun: node("bun", {
    lockfile: (dir) => (has(dir, "bun.lockb") && !has(dir, "bun.lock") ? "bun.lockb" : "bun.lock"),
    configFiles: [".npmrc", "bunfig.toml"],
    install: ({ scripts }) => [{ argv: ["install", ...(scripts ? [] : ["--ignore-scripts"])] }],
    add: ({ scripts, dev }, specs) => [{ argv: ["add", ...(dev ? ["--dev"] : []), ...(scripts ? [] : ["--ignore-scripts"]), ...specs] }],
  }),
  composer: {
    name: "composer", label: "Composer", toolchain: "PHP and Composer", ecosystem: "php", manifest: "composer.json", format: "json", link: "composer",
    scripts: "flag", scriptsLabel: "Composer scripts", configFiles: ["auth.json"],
    packageName: /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/u,
    spec: ({ name, version }) => `${name}:${version}`,
    initialManifest: () => `${JSON.stringify({ require: {} }, null, 2)}\n`,
    lockfile: () => "composer.lock",
    dependencyDirs: () => ["vendor"],
    validate(dir, manifest) {
      // Keep installed packages and executable proxies inside the reviewed directory.
      if ((manifest.config?.["vendor-dir"] && manifest.config["vendor-dir"] !== "vendor")
        || (manifest.config?.["bin-dir"] && manifest.config["bin-dir"] !== "vendor/bin")) throw new Error("Composer installation requires the standard vendor/ and vendor/bin paths.");
    },
    env: (dir) => ({ COMPOSER: path.join(dir, "composer.json"), COMPOSER_VENDOR_DIR: path.join(dir, "vendor"), COMPOSER_BIN_DIR: path.join(dir, "vendor", "bin"), COMPOSER_NO_DEV: "0" }),
    flags: ({ dir, scripts, plugins }) => ["--working-dir", dir, "--no-interaction", "--no-progress", ...(scripts ? [] : ["--no-scripts"]), ...(plugins ? [] : ["--no-plugins"])],
    install(context) {
      // An existing lock is honored; only packages the manifest declares but
      // the lock lacks are resolved, so unrelated locked versions do not move.
      const lockFile = path.join(context.dir, "composer.lock");
      const locked = fs.existsSync(lockFile) ? readManifest(lockFile) : null;
      const lockedNames = new Set([...(locked?.packages || []), ...(locked?.["packages-dev"] || [])].map((entry) => String(entry?.name || "").toLowerCase()));
      const missing = locked ? Object.keys({ ...context.manifest.require, ...context.manifest["require-dev"] })
        .filter((name) => name.includes("/") && !lockedNames.has(name.toLowerCase())) : [];
      return [{ argv: missing.length ? ["update", ...this.flags(context), "--with-dependencies", "--", ...missing] : ["install", ...this.flags(context)] }];
    },
    add(context, specs) {
      return [{ argv: ["require", ...this.flags(context), ...(context.dev ? ["--dev"] : []), "--", ...specs] }];
    },
    verify: (dir) => (has(dir, "vendor/autoload.php") ? null : "Composer did not produce an autoloader"),
  },
  pip: {
    name: "pip", label: "pip", toolchain: "Python 3 with venv", ecosystem: "python", manifest: "requirements.txt", format: "text", link: null,
    // Without approval only prebuilt wheels install; source builds run package code.
    scripts: "flag", scriptsLabel: "Source builds", packageName: PYTHON_NAME, spec: pep508,
    command: () => findCommandOnPath("python3") || findCommandOnPath("python"),
    // Setup commits refuse empty new files.
    initialManifest: () => "# Python dependencies (pip requirements format)\n",
    lockfile: () => null,
    inputs: () => PIP_REQUIREMENT_FILES.slice(1),
    // pip installs these too, so approval shows their requirements.
    shownInputs: (dir) => PIP_REQUIREMENT_FILES.slice(1).filter((name) => has(dir, name)),
    dependencyDirs: () => [".venv"],
    install: ({ dir, scripts }) => [
      ...(has(dir, ".venv/pyvenv.cfg") ? [] : [{ argv: ["-m", "venv", path.join(dir, ".venv")] }]),
      { command: venvPython(dir), argv: ["-m", "pip", "install", "--disable-pip-version-check", "--no-input", ...(scripts ? [] : ["--only-binary=:all:"]),
        ...PIP_REQUIREMENT_FILES.filter((name) => name === "requirements.txt" || has(dir, name)).flatMap((name) => ["-r", path.join(dir, name)])] },
    ],
    // pip has no add command: the batch rewrites requirements.txt, then installs it.
    editManifest(text, specs) {
      const lines = text ? text.replace(/\r?\n$/u, "").split(/\r?\n/u) : [];
      for (const spec of specs) {
        const index = lines.findIndex((line) => requirementName(line) === requirementName(spec));
        if (index >= 0) lines[index] = spec; else lines.push(spec);
      }
      return lines.length ? `${lines.join("\n")}\n` : "";
    },
    verify: verifyVenv("pip"),
  },
  uv: {
    name: "uv", label: "uv", toolchain: "uv", ecosystem: "python", manifest: "pyproject.toml", format: "text", link: null,
    scripts: "flag", scriptsLabel: "Source builds", configFiles: ["uv.toml"], packageName: PYTHON_NAME, spec: pep508,
    initialManifest: (dir) => `[project]\nname = "${path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/gu, "-").replace(/^-+|-+$/gu, "") || "app"}"\nversion = "0.1.0"\ndependencies = []\n`,
    lockfile: () => "uv.lock",
    dependencyDirs: () => [".venv"],
    env: (dir) => ({ UV_PROJECT_ENVIRONMENT: path.join(dir, ".venv") }),
    install: ({ dir, scripts }) => [{ argv: ["sync", "--project", dir, "--no-progress", ...(scripts ? [] : ["--no-build"])] }],
    add: ({ dir, scripts, dev }, specs) => [{ argv: ["add", "--project", dir, "--no-progress", ...(dev ? ["--dev"] : []), ...(scripts ? [] : ["--no-build"]), ...specs] }],
    verify: verifyVenv("uv"),
  },
  poetry: {
    name: "poetry", label: "Poetry", toolchain: "Poetry", ecosystem: "python", manifest: "pyproject.toml", format: "text", link: null,
    scripts: "always", scriptsLabel: "Source builds", configFiles: ["poetry.toml"], packageName: PYTHON_NAME,
    spec: ({ name, version }) => (version === "*" ? name : `${name}@${version}`),
    initialManifest: () => null,
    lockfile: () => "poetry.lock",
    dependencyDirs: () => [".venv"],
    env: () => ({ POETRY_VIRTUALENVS_IN_PROJECT: "true", POETRY_VIRTUALENVS_CREATE: "true", POETRY_NO_INTERACTION: "1" }),
    install: ({ dir, command }) => [{ argv: [...poetryLockArgs(command), "--directory", dir] }, { argv: ["install", "--directory", dir, "--no-interaction", "--no-ansi"] }],
    add: ({ dir, dev }, specs) => [{ argv: ["add", "--directory", dir, "--no-interaction", "--no-ansi", ...(dev ? ["--group", "dev"] : []), ...specs] }],
    verify: verifyVenv("Poetry"),
  },
  bundler: {
    name: "bundler", label: "Bundler", toolchain: "Ruby and Bundler", ecosystem: "ruby", manifest: "Gemfile", format: "text", link: null,
    // Native extensions compile during install; Bundler cannot skip them.
    scripts: "always", scriptsLabel: "Native extension builds", configFiles: [], packageName: /^[A-Za-z0-9][A-Za-z0-9._-]*$/u,
    spec: ({ name, version }) => ({ name, version }),
    command: () => findCommandOnPath("bundle"),
    initialManifest: () => "source \"https://rubygems.org\"\n",
    lockfile: () => "Gemfile.lock",
    // The local path setting lives in .bundle/config so later commands find vendor/bundle.
    dependencyDirs: () => ["vendor/bundle", ".bundle"],
    env: (dir) => ({ BUNDLE_GEMFILE: path.join(dir, "Gemfile"), BUNDLE_FROZEN: "false", BUNDLE_DEPLOYMENT: "false" }),
    install: () => [{ argv: ["config", "set", "--local", "path", "vendor/bundle"] }, { argv: ["install"] }],
    add(context, specs) {
      return [...specs.map(({ name, version }) => ({ argv: ["add", name, ...(version === "*" ? [] : [`--version=${version}`]), ...(context.dev ? ["--group=development"] : []), "--skip-install"] })), ...this.install(context)];
    },
  },
  cargo: {
    name: "cargo", label: "Cargo", toolchain: "Rust and Cargo", ecosystem: "rust", manifest: "Cargo.toml", format: "text", link: null,
    // fetch and add download sources only; build scripts run at build time.
    scripts: "none", configFiles: [".cargo/config.toml", ".cargo/config"], packageName: /^[A-Za-z0-9][A-Za-z0-9_-]*$/u,
    spec: ({ name, version }) => (version === "*" ? name : `${name}@${version}`),
    initialManifest: () => null,
    lockfile: () => "Cargo.lock",
    dependencyDirs: () => [],
    validate(dir) {
      for (const parent of ancestors(dir)) {
        if (/^\s*\[workspace\]/mu.test(readText(path.join(parent, "Cargo.toml")))) throw new Error(`This crate belongs to the Cargo workspace at ${parent}; install from the workspace root.`);
      }
    },
    install: ({ dir }) => [{ argv: ["fetch", "--manifest-path", path.join(dir, "Cargo.toml")] }],
    add(context, specs) {
      return [{ argv: ["add", "--manifest-path", path.join(context.dir, "Cargo.toml"), ...(context.dev ? ["--dev"] : []), ...specs] }, ...this.install(context)];
    },
  },
  go: {
    name: "go", label: "Go", toolchain: "Go", ecosystem: "go", manifest: "go.mod", format: "text", link: null,
    // Module downloads run no package code.
    scripts: "none", configFiles: [], packageName: /^[a-z0-9][a-z0-9.-]*\.[a-z]{2,}(?:\/[A-Za-z0-9._~-]+)*$/u,
    spec: ({ name, version }) => `${name}@${version === "*" ? "latest" : version}`,
    initialManifest: () => null,
    lockfile: () => "go.sum",
    // Missing requirements can be added to go.mod while go.sum is completed.
    writesManifest: true,
    dependencyDirs: () => [],
    validate(dir) {
      if (has(dir, "vendor/modules.txt")) throw new Error("This module vendors its dependencies; vendored Go modules are not supported by the installer.");
    },
    env: () => ({ GOWORK: "off" }),
    // Explicit `all` records every module's checksum in go.sum.
    install: () => [{ argv: ["mod", "download", "all"] }],
    add(context, specs) {
      return [{ argv: ["get", ...specs] }, ...this.install(context)];
    },
  },
};

export const PACKAGE_MANAGERS = Object.freeze(Object.fromEntries(ENVIRONMENT_PACKAGE_MANAGERS.map((name) => [name, Object.freeze({
  configFiles: [], writesManifest: false, inputs: () => [], shownInputs: () => [], env: () => ({}), validate: () => {}, verify: () => null,
  command: () => findCommandOnPath(name), ...REGISTRY[name],
})])));

// The managers a package directory's manifests and lockfiles call for.
export function detectPackageManagers(dir) {
  const found = [];
  if (has(dir, "package.json")) {
    let declared = "";
    try { declared = readManifest(path.join(dir, "package.json")).packageManager; } catch { /* the installer reports it */ }
    found.push(String(declared || "").trim().toLowerCase().match(/^(npm|pnpm|yarn|bun)(?:@|$)/u)?.[1]
      || NODE_LOCKS.find(([, lock]) => has(dir, lock))?.[0] || "npm");
  }
  if (has(dir, "composer.json")) found.push("composer");
  if (has(dir, "uv.lock")) found.push("uv");
  else if (has(dir, "poetry.lock") || /^\s*\[tool\.poetry\]/mu.test(readText(path.join(dir, "pyproject.toml")))) found.push("poetry");
  else if (has(dir, "requirements.txt")) found.push("pip");
  else if (has(dir, "pyproject.toml")) found.push("uv");
  if (has(dir, "Gemfile")) found.push("bundler");
  if (has(dir, "Cargo.toml")) found.push("cargo");
  if (has(dir, "go.mod")) found.push("go");
  return found;
}

export function resolvePackageManager(dir, requested, label = ".") {
  if (requested != null) {
    if (!PACKAGE_MANAGERS[requested]) throw new Error(`Use one of these package managers: ${ENVIRONMENT_PACKAGE_MANAGERS.join(", ")}.`);
    return PACKAGE_MANAGERS[requested];
  }
  const found = detectPackageManagers(dir);
  if (found.length === 1) return PACKAGE_MANAGERS[found[0]];
  if (!found.length) throw new Error(`No package manifest found in ${label}. Create the manifest first, or pass manager (${ENVIRONMENT_PACKAGE_MANAGERS.join(", ")}).`);
  throw new Error(`Several package managers apply in ${label} (${found.join(", ")}); pass manager to choose one.`);
}

export function packageSpecs(manager, packages) {
  if (!Array.isArray(packages) || packages.length > 50) throw new Error("Each step accepts at most 50 packages.");
  return packages.map((pkg) => {
    const version = pkg?.version || "*";
    if (!manager.packageName.test(pkg?.name || "") || typeof version !== "string" || !VERSION.test(version) || version.startsWith("-")) {
      throw new Error("Use registry package names and version constraints, not flags, paths, URLs, or shell syntax.");
    }
    return manager.spec({ name: pkg.name, version });
  });
}

// Commands carry their executable and environment so approval shows exactly
// what runs.
export function packageCommands(manager, entries, { dir, manifest, command, scripts }) {
  const base = manager.env(dir, manifest, { scripts });
  return entries.map((entry) => ({ command: entry.command || command, argv: entry.argv, env: { ...base, ...entry.env } }));
}

// Additional dependency declarations the installer reads, keyed by path.
export function shownPackageInputs(manager, dir, relative) {
  return Object.fromEntries(manager.shownInputs(dir).map((name) => [relative(name), fs.readFileSync(path.join(dir, name), "utf8")]));
}

export function readPackageManifest(manager, file) {
  return manager.format === "json" ? readManifest(file) : fs.readFileSync(file, "utf8");
}

export function packageScriptsLine(manager, enabled, { plugins = false } = {}) {
  const lines = manager.scripts === "none"
    ? [`Package code: ${manager.label} runs no package scripts or builds during this install.`]
    : manager.scripts === "always"
      ? [`${manager.scriptsLabel}: ALWAYS RUN — ${manager.label} cannot disable them; package build code executes with your user permissions.`]
      : [`${manager.scriptsLabel}: ${enabled ? "ENABLED — dependency and project scripts execute with your user permissions" : "disabled"}.`];
  if (manager.name === "composer") lines.push(`Composer plugins: ${plugins ? "ENABLED" : "disabled"}.`);
  return lines;
}
