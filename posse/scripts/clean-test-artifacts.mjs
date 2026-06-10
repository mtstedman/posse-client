import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const root = path.resolve(__dirname, "..");
const testDir = path.join(root, "test");
const ROOT_TEST_ARTIFACT_DIR_PATTERNS = [
  /^tmp-delete-noop-/,
  /^tmp-placement-noop-/,
];

function isInside(parent, child) {
  const rel = path.relative(parent, child);
  return rel && !rel.startsWith("..") && !path.isAbsolute(rel);
}

function chmodTreeBestEffort(target) {
  if (!fs.existsSync(target)) return;
  const stack = [target];
  while (stack.length > 0) {
    const current = stack.pop();
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      continue;
    }
    try {
      fs.chmodSync(current, stat.isDirectory() ? 0o777 : 0o666);
    } catch {
      // Best effort; a live process may still hold the path on Windows.
    }
    if (!stat.isDirectory()) continue;
    try {
      for (const child of fs.readdirSync(current)) {
        stack.push(path.join(current, child));
      }
    } catch {
      // Best effort; rmSync will report any path that still cannot be removed.
    }
  }
}

function removePath(target, opts = {}) {
  const resolved = path.resolve(target);
  const guardRoot = opts.guardRoot ? path.resolve(opts.guardRoot) : root;
  if (resolved !== guardRoot && !isInside(guardRoot, resolved)) {
    throw new Error(`Refusing to remove path outside ${guardRoot}: ${resolved}`);
  }
  const rmOptions = { recursive: true, force: true, maxRetries: 8, retryDelay: 150 };
  try {
    fs.rmSync(resolved, rmOptions);
  } catch (err) {
    chmodTreeBestEffort(resolved);
    try {
      fs.rmSync(resolved, rmOptions);
    } catch (retryErr) {
      const code = retryErr?.code || err?.code || "UNKNOWN";
      throw new Error(`Failed to remove test artifact ${resolved} (${code}). Check for a live test/ATLAS process holding this path.`);
    }
  }
}

let removedDirs = 0;
let removedFiles = 0;

if (fs.existsSync(testDir)) {
  for (const entry of fs.readdirSync(testDir, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    if (!/^runtime-db-/.test(entry.name) && !/^tmp-/.test(entry.name) && entry.name !== ".posse-worktrees") continue;
    removePath(path.join(testDir, entry.name), { guardRoot: testDir });
    removedDirs += 1;
  }
}

for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  if (!ROOT_TEST_ARTIFACT_DIR_PATTERNS.some((pattern) => pattern.test(entry.name))) continue;
  removePath(path.join(root, entry.name), { guardRoot: root });
  removedDirs += 1;
}

for (const file of ["test-output.txt", "queue-test.log"]) {
  const target = path.join(root, file);
  if (!fs.existsSync(target)) continue;
  removePath(target, { guardRoot: root });
  removedFiles += 1;
}

console.log(`Removed ${removedDirs} test director${removedDirs === 1 ? "y" : "ies"} and ${removedFiles} log file${removedFiles === 1 ? "" : "s"}.`);
