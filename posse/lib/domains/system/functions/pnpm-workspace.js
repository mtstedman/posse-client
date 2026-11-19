import fs from "node:fs";
import path from "node:path";
import { fingerprint, localPath, readManifest } from "./environment-paths.js";

// The manifest names pnpm accepts for a workspace project, in its read order.
const PROJECT_MANIFESTS = ["package.json", "package.json5", "package.yaml"];

// Resolve the packages pnpm will install so approval covers the whole
// workspace, including member manifests and ignored install directories.
export function pnpmWorkspace(dir) {
  const file = localPath(dir, "pnpm-workspace.yaml");
  if (!fs.existsSync(file)) return null;
  const source = fs.readFileSync(file, "utf8");
  const header = /^packages:[ \t]*([^\n]*)/m.exec(source);
  let patterns = [];
  if (header) {
    const inline = header[1].replace(/\s+#.*$/, "").trim();
    if (inline && !inline.startsWith("#")) {
      try { patterns = JSON.parse(inline.replace(/'([^']*)'/g, (_, value) => JSON.stringify(value))); }
      catch { throw new Error("Use a packages block list or JSON array in pnpm-workspace.yaml for workspace setup."); }
    } else {
      for (const line of source.slice(header.index + header[0].length).split(/\r?\n/)) {
        if (!line.trim() || /^\s*#/.test(line)) continue;
        if (/^\S/.test(line) && !line.startsWith("-")) break;
        const item = /^\s*-\s+(?:'([^']*)'|"([^"]*)"|([^#'"\s]+))\s*(?:#.*)?$/.exec(line);
        if (!item) throw new Error("Unsupported pnpm workspace package pattern; use literal package globs.");
        patterns.push(item[1] ?? item[2] ?? item[3]);
      }
    }
  } else patterns = ["."]; // pnpm 10: no `packages` key means the root project alone.
  if (!Array.isArray(patterns) || patterns.some((value) => typeof value !== "string" || !value
    || /[\\\0]/.test(value) || path.isAbsolute(value.replace(/^!/, ""))
    || value.replace(/^!/, "").split("/").includes(".."))) {
    throw new Error("Workspace package patterns must stay inside the repository.");
  }
  const excluded = patterns.filter((value) => value.startsWith("!")).map((value) => value.slice(1).replace(/\/$/, ""));
  const members = new Map();
  for (const pattern of patterns.filter((value) => !value.startsWith("!"))) {
    // pnpm's workspace search ignores node_modules and bower_components only;
    // test directories are members unless a `!` pattern excludes them.
    for (const candidate of fs.globSync(PROJECT_MANIFESTS.map((name) => `${pattern.replace(/\/$/, "")}/${name}`), {
      cwd: dir, exclude: ["**/node_modules/**", "**/bower_components/**", "**/.git/**"],
    })) {
      const member = path.posix.dirname(candidate.replaceAll(path.sep, "/"));
      if (member === "." || members.has(member) || excluded.some((value) => path.matchesGlob(member, value))) continue;
      const manifest = `${member}/${PROJECT_MANIFESTS.find((name) => fs.existsSync(path.join(dir, member, name)))}`;
      if (manifest.endsWith("/package.json")) {
        try {
          readManifest(localPath(dir, manifest));
        } catch (error) {
          if (!(error instanceof SyntaxError)) throw error;
          throw new Error(`pnpm workspace member ${manifest} is not valid JSON; fix it, or exclude its directory with a "!" pattern in pnpm-workspace.yaml.`);
        }
      } else fingerprint(localPath(dir, manifest));
      localPath(dir, `${member}/node_modules`, { dependencyDirectory: true });
      members.set(member, manifest);
    }
  }
  const packages = [...members.keys()].sort();
  return {
    packages,
    // Every manifest name is an input, so one that appears later invalidates approval.
    inputs: ["pnpm-workspace.yaml", ".pnpmfile.cjs", ".pnpmfile.mjs",
      ...packages.flatMap((member) => [...PROJECT_MANIFESTS.map((name) => `${member}/${name}`), `${member}/.npmrc`])],
    manifests: ["pnpm-workspace.yaml", ...packages.map((member) => members.get(member))],
    dependencyDirs: ["node_modules", ...packages.map((member) => `${member}/node_modules`)],
  };
}

const DEPENDENCY_FIELDS = ["dependencies", "devDependencies", "optionalDependencies"];
// Lockfile state pnpm compares with sources other than the manifests'
// dependency fields (overrides, catalogs, patches, pnpmfile) is not compared
// here, so its presence never counts as a match.
const COMPARED_LOCKFILE_KEYS = new Set(["lockfileVersion", "settings", "importers", "packages", "snapshots"]);

function yamlScalar(text) {
  if (text.startsWith("'")) {
    if (!/^'(?:[^']|'')*'$/u.test(text)) throw new Error("unterminated YAML string");
    return text.slice(1, -1).replaceAll("''", "'");
  }
  return text.startsWith('"') ? JSON.parse(text) : text;
}

// Each project's dependency specifiers from a pnpm 9 lockfile, which pnpm
// writes with two-space indentation. Null for any other format or content.
function lockfileImporters(source) {
  const importers = new Map();
  let version = false; let section = null; let project = null; let field = null; let dependency = null;
  for (const line of source.split(/\r?\n/u)) {
    if (!line.trim()) continue;
    const top = /^([A-Za-z]+):(?: +(\S.*))?$/u.exec(line);
    if (top) {
      if (!COMPARED_LOCKFILE_KEYS.has(top[1])) return null;
      if (top[1] === "lockfileVersion") {
        if (!/^'?9\.\d+'?$/u.test(top[2] || "")) return null;
        version = true;
      }
      section = top[1];
      continue;
    }
    if (!line.startsWith(" ")) return null;
    if (section !== "importers") continue;
    const match = /^( +)('(?:[^']|'')*'|"(?:[^"\\]|\\.)*"|[^\s'"][^:]*):(?: +(\S.*))?$/u.exec(line);
    if (!match) return null;
    const indent = match[1].length; const key = yamlScalar(match[2]); const value = match[3];
    if (indent === 2) {
      if (value && value !== "{}") return null;
      project = Object.fromEntries(DEPENDENCY_FIELDS.map((name) => [name, {}]));
      importers.set(key, project);
      field = null;
    } else if (indent === 4) {
      // dependenciesMeta and publishDirectory are compared by pnpm too.
      if (!project || !DEPENDENCY_FIELDS.includes(key) || (value && value !== "{}")) return null;
      field = key; dependency = null;
    } else if (indent === 6) {
      if (!field || value) return null;
      dependency = key;
    } else if (indent === 8 && dependency) {
      if (key === "specifier") project[field][dependency] = yamlScalar(value || "");
    } else return null;
  }
  return version ? importers : null;
}

/**
 * Whether pnpm-lock.yaml records exactly the dependencies every workspace
 * manifest declares. A frozen install then reproduces the reviewed lockfile;
 * after a developer edits a manifest, pnpm must update it instead, and the
 * approval lists the lockfile as a change. Undecidable content is no match:
 * an unfrozen install still prefers a lockfile that satisfies the manifests,
 * while a frozen one fails on any format this pnpm cannot read.
 */
export function pnpmLockfileMatchesManifests(dir) {
  try {
    const importers = lockfileImporters(fs.readFileSync(localPath(dir, "pnpm-lock.yaml"), "utf8"));
    if (!importers) return false;
    const projects = [".", ...(pnpmWorkspace(dir)?.packages || [])];
    if ([...importers.keys()].some((id) => !projects.includes(id))) return false;
    // Overrides, patches, extensions and catalogs change resolution without
    // touching a dependency field; they are not compared, so they read as no match.
    const root = readManifest(localPath(dir, "package.json"));
    if (root.resolutions || root.pnpm?.overrides || root.pnpm?.patchedDependencies || root.pnpm?.packageExtensions) return false;
    try {
      if (/^(?:overrides|patchedDependencies|packageExtensions|catalogs?):/m.test(fs.readFileSync(localPath(dir, "pnpm-workspace.yaml"), "utf8"))) return false;
    } catch (error) {
      if (error?.code !== "ENOENT") return false;
    }
    return projects.every((id) => {
      // A package.json5 or package.yaml member is not compared, so it reads as no match.
      const manifest = readManifest(localPath(dir, id === "." ? "package.json" : `${id}/package.json`));
      if (manifest.dependenciesMeta || manifest.publishConfig?.directory) return false;
      return DEPENDENCY_FIELDS.every((name) => {
        const declared = Object.entries(manifest[name] || {});
        const locked = importers.get(id)?.[name] || {};
        return declared.length === Object.keys(locked).length
          && declared.every(([dependency, specifier]) => Object.hasOwn(locked, dependency) && locked[dependency] === specifier);
      });
    });
  } catch { return false; }
}
