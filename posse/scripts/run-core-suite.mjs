// Run a tagged core suite in fast, slow, or full mode.

import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const [suite = "all", mode = "full", ...extraFiles] = process.argv.slice(2);
const normalizedMode = String(mode || "full").toLowerCase();
const allowedModes = new Set(["fast", "slow", "full"]);

if (!allowedModes.has(normalizedMode)) {
  console.error(`Unknown core suite mode "${mode}". Expected fast, slow, or full.`);
  process.exit(2);
}

const env = {
  ...process.env,
  POSSE_TEST_SUITES: suite,
  POSSE_TEST_SUITE_MODE: normalizedMode,
};

const args = [
  "--disable-warning=DEP0040",
  "--test",
  "test/core.test.js",
  ...extraFiles,
];

const proc = spawn(process.execPath, args, { stdio: "inherit", cwd: ROOT, env });
proc.on("exit", (code) => process.exit(code ?? 1));

