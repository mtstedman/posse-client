// @ts-check
//
// What a checkout declares for testing, read once when a planner starts.
//
// Planners choose a task's test_command from what the repository already
// declares. Without a list they searched for it on every job (`phpunit|
// "scripts"|npm test` was 107 of one site's planner searches). This reads the
// same facts from the manifests and test directories directly.

import fs from "node:fs";
import path from "node:path";

const TEST_SCRIPT_NAME = /^(?:tests?|checks?|verify|lint|typecheck|types|spec|e2e)(?:[:._-].*)?$/iu;
const TEST_FILE = /(?:\.(?:test|spec)\.[cm]?[jt]sx?|_test\.(?:py|go|rb)|^test_.*\.py|Test\.php|_spec\.rb)$/u;
const TEST_DIRS = ["tests", "test", "__tests__", "spec"];
const WRAPPER = /^(?:run[-_.])?(?:tests?|checks?|verify|lint|typecheck|spec)(?:[-_.][^/]*)?\.sh$/iu;
const MAX_SCRIPTS = 12;
const MAX_BODY_CHARS = 80;
const MAX_WALK_FILES = 5000;

function readJson(/** @type {string} */ file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function clip(/** @type {string} */ value) {
  const text = String(value).replace(/\s+/gu, " ").trim();
  return text.length > MAX_BODY_CHARS ? `${text.slice(0, MAX_BODY_CHARS - 1)}…` : text;
}

function scriptLine(/** @type {string} */ label, /** @type {Record<string, unknown> | null} */ scripts, /** @type {string} */ runAs) {
  if (!scripts || typeof scripts !== "object") return null;
  const entries = Object.entries(scripts)
    .filter(([name, body]) => TEST_SCRIPT_NAME.test(name) && (typeof body === "string" || Array.isArray(body)));
  if (entries.length === 0) return null;
  const shown = entries.slice(0, MAX_SCRIPTS)
    .map(([name, body]) => `${name} = ${clip(Array.isArray(body) ? body.join(" && ") : String(body))}`);
  const more = entries.length > MAX_SCRIPTS ? `; ${entries.length - MAX_SCRIPTS} more` : "";
  return `${label} (run as ${runAs} <name>): ${shown.join("; ")}${more}`;
}

function makefileTargets(/** @type {string} */ root) {
  try {
    const text = fs.readFileSync(path.join(root, "Makefile"), "utf8");
    return [...new Set([...text.matchAll(/^([A-Za-z0-9_.-]+)\s*:(?!=)/gmu)].map((match) => match[1]))]
      .filter((target) => TEST_SCRIPT_NAME.test(target));
  } catch {
    return [];
  }
}

function testFiles(/** @type {string} */ root) {
  const found = [];
  let visited = 0;
  const walk = (/** @type {string} */ dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (visited++ > MAX_WALK_FILES) return;
      if (entry.name.startsWith(".") || entry.name === "node_modules" || entry.name === "vendor") continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && TEST_FILE.test(entry.name)) found.push(path.relative(root, full).split(path.sep).join("/"));
    }
  };
  for (const name of TEST_DIRS) {
    const dir = path.join(root, name);
    if (fs.existsSync(dir)) walk(dir);
  }
  return found.sort();
}

function wrapperScripts(/** @type {string} */ root) {
  const wrappers = [];
  for (const name of ["tests", "test", "scripts"]) {
    let entries;
    try { entries = fs.readdirSync(path.join(root, name), { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".sh")) continue;
      if (name === "scripts" && !WRAPPER.test(entry.name)) continue;
      wrappers.push(`${name}/${entry.name}`);
    }
  }
  return wrappers.sort();
}

/**
 * One line per kind of declared test entry point in `root`; empty when the
 * checkout declares none.
 *
 * @param {string} root
 * @param {{ nodePackageManager?: string }} [options]
 * @returns {string[]}
 */
export function repositoryTestInventory(root, { nodePackageManager = "npm" } = {}) {
  const dir = path.resolve(String(root || ""));
  if (!dir || !fs.existsSync(dir)) return [];
  const runNode = nodePackageManager === "npm" ? "npm run" : `${nodePackageManager} run`;
  const lines = [
    scriptLine("package.json scripts", readJson(path.join(dir, "package.json"))?.scripts ?? null, runNode),
    scriptLine("composer.json scripts", readJson(path.join(dir, "composer.json"))?.scripts ?? null, "composer"),
  ];
  const configs = ["phpunit.xml", "phpunit.xml.dist", "pytest.ini", "tox.ini", "jest.config.js", "jest.config.mjs",
    "vitest.config.ts", "vitest.config.js", "vitest.config.mjs", "playwright.config.ts", "playwright.config.js"]
    .filter((name) => fs.existsSync(path.join(dir, name)));
  if (configs.length > 0) lines.push(`Test runner config: ${configs.join(", ")}`);
  const targets = makefileTargets(dir);
  if (targets.length > 0) lines.push(`Makefile targets: ${targets.join(", ")}`);
  const wrappers = wrapperScripts(dir);
  if (wrappers.length > 0) lines.push(`Test wrapper scripts: ${wrappers.slice(0, 8).join(", ")}${wrappers.length > 8 ? `, ${wrappers.length - 8} more` : ""}`);
  const files = testFiles(dir);
  if (files.length > 0) {
    const dirs = [...new Set(files.map((file) => file.split("/")[0]))];
    lines.push(`Test files: ${files.length} under ${dirs.join(", ")}/, e.g. ${files.slice(0, 3).join(", ")}`);
  }
  return lines.filter((line) => typeof line === "string" && line.length > 0);
}
