// Bossy startup refreshes the server-issued artifact before handing over the
// terminal. Artifact verification stays with Posse's native manager; no CLI
// queue, daemon, or worker runtime is started here.
// BOSSY_BIN remains an explicit override. Offline boots retain the verified
// cache, then the system install on PATH, as fallbacks.
import { spawn } from "node:child_process";
import fs from "node:fs";

import { platformTokens, exeSuffix } from "../../../shared/platform/functions/native-platform.js";
import { findVerifiedNativeBinaryArtifact } from "../../../shared/native/functions/artifact-download.js";

/**
 * Resolve the Bossy executable to launch.
 *
 * @param {{ env?: NodeJS.ProcessEnv }} [opts]
 * @returns {{ target: string, source: "env" | "path" } | { error: string }}
 */
export function resolveBossyBinary({ env = process.env } = {}) {
  const override = String(env.BOSSY_BIN || "").trim();
  if (override) {
    if (fs.existsSync(override)) return { target: override, source: "env" };
    return { error: `BOSSY_BIN is set but does not exist: ${override}` };
  }
  // Delegate the PATH walk to spawn itself; a missing install surfaces as
  // ENOENT and gets the guidance message below.
  return { target: "bossy" + exeSuffix(), source: "path" };
}

async function ensureBossyArtifact(name, options) {
  const { nativeBinaries } = await import("../../../shared/tools/classes/BinaryManager.js");
  return nativeBinaries.ensureAvailable(name, options);
}

/** Refresh before spawn so this launch uses the issued version immediately. */
export async function prepareBossyBinary({
  env = process.env,
  ensureAvailable = ensureBossyArtifact,
  findCached = findVerifiedNativeBinaryArtifact,
  log = console.error,
} = {}) {
  const resolved = resolveBossyBinary({ env });
  if (resolved.error || resolved.source === "env") return resolved;

  log("[bossy] Checking for updates…");
  try {
    const result = await ensureAvailable("bossy", { refresh: true });
    if (result?.available && result.path) {
      if (result.current === false) {
        log("[bossy] Update check unavailable; using the verified cached version.");
      } else if (result.downloaded) {
        log(`[bossy] Updated to ${result.version}.`);
      }
      return { target: result.path, source: result.current === false ? "cache" : "remote" };
    }
  } catch { /* A failed refresh must not strand an offline dashboard. */ }

  try {
    const tokens = platformTokens();
    const cached = await findCached({ name: "bossy", os: tokens.os, arch: tokens.arch });
    if (cached?.binaryPath) {
      log("[bossy] Update check unavailable; using the verified cached version.");
      return { target: cached.binaryPath, source: "cache" };
    }
  } catch { /* PATH fallback remains valid. */ }
  log("[bossy] Update check unavailable; trying the system installation.");
  return resolved;
}

/**
 * Launch Bossy on the caller's terminal and resolve with its exit code.
 * Both `posse bossy` and `posse --bossy` forward the remaining arguments.
 */
export async function launchBossy({
  argv = process.argv.slice(2), env = process.env,
  prepare = prepareBossyBinary, spawnProcess = spawn, log = console.error,
} = {}) {
  const resolved = await prepare({ env, log });
  if (resolved.error) {
    log(`\nCannot launch Bossy: ${resolved.error}\n`);
    return 1;
  }
  const forwarded = argv[0] === "bossy" ? argv.slice(1) : argv;
  const args = forwarded.filter((arg) => arg !== "--bossy");
  return new Promise((resolve) => {
    const child = spawnProcess(resolved.target, args, { stdio: "inherit", env });
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        log("\nCannot launch Bossy: no `bossy` executable was found.");
        log("Run `npm run pull:native -- bossy`, install it on PATH, or set BOSSY_BIN to the binary.\n");
      } else {
        log(`\nCannot launch Bossy: ${err?.message || err}\n`);
      }
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      resolve(signal ? 1 : (code ?? 0));
    });
  });
}
