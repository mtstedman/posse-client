#!/usr/bin/env node
// Posse wrapper for the Composer-installed scip-php CLI.
//
// Upstream scip-php writes `index.scip` in the target working directory and
// does not accept an output path. ATLAS expects each indexer to write to the
// staging directory, so this wrapper adapts `scip-php index --output <path>` to
// the upstream command shape without putting the PHP indexer runtime in the
// target repo.

import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const scipRoot = path.resolve(here, "..");
const upstream = path.join(scipRoot, "php", "vendor", "bin", "scip-php");
const composerPhar = path.join(here, "composer.phar");

const parsed = parseArgs(process.argv.slice(2));
if (parsed.help) {
  console.log("usage: scip-php index --output <path> [--memory-limit <limit>]");
  process.exit(0);
}
if (!parsed.output) {
  console.error("scip-php wrapper requires --output <path>");
  process.exit(2);
}
if (!fs.existsSync(upstream)) {
  console.error(`Posse scip-php runtime is not installed: ${upstream}`);
  process.exit(127);
}

const cwd = process.cwd();
const output = path.resolve(parsed.output);
const stagedVendorDir = path.join(path.dirname(output), "php-vendor");
const targetVendor = path.join(cwd, "vendor", "autoload.php");
const stagedVendor = path.join(stagedVendorDir, "autoload.php");
const hasTargetVendor = fs.existsSync(targetVendor);
const useTargetVendor = hasTargetVendor && truthyEnv(process.env.POSSE_SCIP_USE_TARGET_VENDOR);
if (!useTargetVendor && !fs.existsSync(stagedVendor)) {
  bootstrapComposerAutoload({ cwd, vendorDir: stagedVendorDir });
}

const localOutput = path.join(cwd, "index.scip");
try {
  fs.rmSync(localOutput, { force: true });
} catch {
  // Best effort cleanup before upstream writes its hardcoded output.
}

const args = [];
if (parsed.memoryLimit) args.push(`--memory-limit=${parsed.memoryLimit}`);
const run = spawnSync("php", ["-d", "error_reporting=8191", upstream, ...args], {
  cwd,
  stdio: "inherit",
  windowsHide: true,
  env: {
    ...process.env,
    ...(useTargetVendor ? {} : { POSSE_SCIP_TARGET_VENDOR_DIR: stagedVendorDir }),
  },
});
if (run.error) {
  console.error(run.error.message || String(run.error));
  process.exit(1);
}
if (run.status !== 0) process.exit(run.status ?? 1);
if (!fs.existsSync(localOutput)) {
  console.error(`scip-php completed but did not write ${localOutput}`);
  process.exit(1);
}

fs.mkdirSync(path.dirname(output), { recursive: true });
fs.renameSync(localOutput, output);

function bootstrapComposerAutoload({ cwd, vendorDir }) {
  const composerJson = path.join(cwd, "composer.json");
  if (!fs.existsSync(composerPhar)) {
    console.error(`Posse Composer runtime is not installed: ${composerPhar}`);
    process.exit(127);
  }
  fs.mkdirSync(vendorDir, { recursive: true });
  const composerCwd = fs.existsSync(composerJson)
    ? cwd
    : prepareMinimalComposerProject(path.dirname(vendorDir));
  const vendorEnv = path.relative(composerCwd, vendorDir) || vendorDir;
  // Keep the target repo's dependencies out of the PHP process by default.
  // Project vendors can register versions of nikic/php-parser (and friends)
  // that shadow scip-php's pinned runtime classes.
  const command = ["dump-autoload", "--no-interaction", "--no-scripts"];
  console.error(`scip-php preparing Composer autoload in ${vendorDir}`);
  const run = spawnSync("php", [composerPhar, ...command], {
    cwd: composerCwd,
    stdio: "inherit",
    windowsHide: true,
    env: {
      ...process.env,
      COMPOSER_VENDOR_DIR: vendorEnv,
    },
  });
  if (run.error) {
    console.error(run.error.message || String(run.error));
    process.exit(1);
  }
  if (run.status !== 0) process.exit(run.status ?? 1);
  const autoload = path.join(vendorDir, "autoload.php");
  if (!fs.existsSync(autoload)) {
    console.error(`Composer completed but did not write ${autoload}`);
    process.exit(1);
  }
  if (composerCwd !== cwd) {
    try { fs.rmSync(composerCwd, { recursive: true, force: true }); } catch { /* best effort */ }
  }
}

function prepareMinimalComposerProject(parentDir) {
  const dir = path.join(parentDir, "php-composer-bootstrap");
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "composer.json"),
    JSON.stringify({ name: "posse/scip-php-target", autoload: {} }, null, 2) + "\n",
    "utf8",
  );
  return dir;
}

function parseArgs(argv) {
  const out = { help: false, output: "", memoryLimit: "" };
  const args = [...argv];
  if (args[0] === "index") args.shift();
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "-h" || arg === "--help") {
      out.help = true;
      continue;
    }
    if (arg === "--output" && args[i + 1]) {
      out.output = args[++i];
      continue;
    }
    if (arg.startsWith("--output=")) {
      out.output = arg.slice("--output=".length);
      continue;
    }
    if (arg === "--memory-limit" && args[i + 1]) {
      out.memoryLimit = args[++i];
      continue;
    }
    if (arg.startsWith("--memory-limit=")) {
      out.memoryLimit = arg.slice("--memory-limit=".length);
      continue;
    }
  }
  return out;
}

function truthyEnv(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}
