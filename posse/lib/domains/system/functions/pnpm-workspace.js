import fs from "node:fs";
import path from "node:path";
import { localPath, readManifest } from "./environment-paths.js";

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
  } else patterns = ["**"];
  if (!Array.isArray(patterns) || patterns.some((value) => typeof value !== "string" || !value
    || /[\\\0]/.test(value) || path.isAbsolute(value.replace(/^!/, ""))
    || value.replace(/^!/, "").split("/").includes(".."))) {
    throw new Error("Workspace package patterns must stay inside the repository.");
  }
  const excluded = patterns.filter((value) => value.startsWith("!")).map((value) => value.slice(1).replace(/\/$/, ""));
  const members = new Set();
  for (const pattern of patterns.filter((value) => !value.startsWith("!"))) {
    for (const candidate of fs.globSync(`${pattern.replace(/\/$/, "")}/package.json`, {
      cwd: dir, exclude: ["**/node_modules/**", "**/.git/**"],
    })) {
      const relative = candidate.replaceAll(path.sep, "/");
      const member = path.posix.dirname(relative);
      if (member === "." || excluded.some((value) => path.matchesGlob(member, value))) continue;
      readManifest(localPath(dir, relative));
      localPath(dir, `${member}/node_modules`, { dependencyDirectory: true });
      members.add(member);
    }
  }
  const packages = [...members].sort();
  return {
    packages,
    inputs: ["pnpm-workspace.yaml", ".pnpmfile.cjs", ".pnpmfile.mjs",
      ...packages.flatMap((member) => [`${member}/package.json`, `${member}/.npmrc`])],
    manifests: ["pnpm-workspace.yaml", ...packages.map((member) => `${member}/package.json`)],
    dependencyDirs: ["node_modules", ...packages.map((member) => `${member}/node_modules`)],
  };
}
