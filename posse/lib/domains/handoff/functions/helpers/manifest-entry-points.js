// Entry points a repository declares in its own package manifests. The
// prefetch code map ranks files by task wording, so a program's real entry
// (pytest's console_main in src/_pytest/config/__init__.py, reached through a
// two-line __main__.py stub) could stay unranked. These declarations are
// repository facts, independent of any task, key, or grade.

import fs from "node:fs";
import path from "node:path";

const MAX_DECLARED_FILES = 6;
const MAX_DECLARED_SYMBOLS = 4;
const CODE_FILE_RE = /\.(py|js|mjs|cjs|ts|mts|cts|jsx|tsx|rs|php|go|rb)$/i;

function readText(root, relPath) {
  try {
    return fs.readFileSync(path.join(root, relPath), "utf8");
  } catch {
    return null;
  }
}

function existingCodeFile(root, relPath) {
  const normalized = path.posix.normalize(String(relPath || "").replace(/\\/g, "/").replace(/^\.\//, ""));
  if (!normalized || normalized.startsWith("..") || path.posix.isAbsolute(normalized)) return null;
  if (!CODE_FILE_RE.test(normalized)) return null;
  try {
    return fs.statSync(path.join(root, normalized)).isFile() ? normalized : null;
  } catch {
    return null;
  }
}

// `name = "module.path:function"` lines of one TOML table, e.g. [project.scripts].
function tomlTableEntries(text, table) {
  const lines = String(text || "").split(/\r?\n/);
  const header = `[${table}]`;
  const out = [];
  let inside = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (line.startsWith("[")) {
      inside = line === header;
      continue;
    }
    if (!inside || !line || line.startsWith("#")) continue;
    const match = line.match(/^["']?[^"'=]+["']?\s*=\s*["']([^"']+)["']/);
    if (match) out.push(match[1]);
  }
  return out;
}

function pythonScriptSymbols(root) {
  const text = readText(root, "pyproject.toml");
  if (!text) return [];
  return ["project.scripts", "project.gui-scripts", "tool.poetry.scripts"]
    .flatMap((table) => tomlTableEntries(text, table))
    .map((target) => {
      const [module, attribute] = target.split(":");
      const name = String(attribute || "").split(".").at(-1)?.trim();
      return name ? { name, module: String(module || "").trim() } : null;
    })
    .filter(Boolean);
}

function packageJsonFiles(root) {
  const text = readText(root, "package.json");
  if (!text) return [];
  let pkg;
  try {
    pkg = JSON.parse(text);
  } catch {
    return [];
  }
  const values = [];
  const add = (value) => { if (typeof value === "string") values.push(value); };
  if (typeof pkg.bin === "string") add(pkg.bin);
  else if (pkg.bin && typeof pkg.bin === "object") Object.values(pkg.bin).forEach(add);
  add(pkg.main);
  const rootExport = typeof pkg.exports === "string" ? pkg.exports : pkg.exports?.["."];
  if (typeof rootExport === "string") add(rootExport);
  else if (rootExport && typeof rootExport === "object") {
    for (const key of ["require", "import", "node", "default"]) {
      const value = rootExport[key];
      add(typeof value === "string" ? value : value?.default);
    }
  }
  return values;
}

function cargoFiles(root) {
  const text = readText(root, "Cargo.toml");
  if (!text) return [];
  const values = [...String(text).matchAll(/\[\[bin\]\][^[]*?\bpath\s*=\s*["']([^"']+)["']/g)].map((match) => match[1]);
  values.push("src/main.rs", "src/lib.rs");
  const members = String(text).match(/members\s*=\s*\[([^\]]*)\]/);
  for (const member of members ? [...members[1].matchAll(/["']([^"'*]+)["']/g)].map((match) => match[1]) : []) {
    values.push(`${member}/src/main.rs`, `${member}/src/lib.rs`);
  }
  return values;
}

function composerFiles(root) {
  const text = readText(root, "composer.json");
  if (!text) return [];
  try {
    const bin = JSON.parse(text).bin;
    return Array.isArray(bin) ? bin : typeof bin === "string" ? [bin] : [];
  } catch {
    return [];
  }
}

/**
 * Declared entry files (existing code files) and declared entry symbols
 * (Python console scripts) from the repository-root manifests.
 *
 * @param {string} root
 * @returns {{ files: string[], symbols: Array<{ name: string, module: string }> }}
 */
export function declaredManifestEntries(root) {
  if (!root) return { files: [], symbols: [] };
  const files = [...new Set([...packageJsonFiles(root), ...cargoFiles(root), ...composerFiles(root)]
    .map((value) => existingCodeFile(root, value))
    .filter(Boolean))].slice(0, MAX_DECLARED_FILES);
  const seen = new Set();
  const symbols = pythonScriptSymbols(root)
    .filter((entry) => !seen.has(entry.name) && seen.add(entry.name))
    .slice(0, MAX_DECLARED_SYMBOLS);
  return { files, symbols };
}
