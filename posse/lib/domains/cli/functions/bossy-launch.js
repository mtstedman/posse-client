// `posse --bossy` boots the Bossy fleet TUI in the current repository
// context instead of running a Posse CLI command. Bossy is a user-facing
// dashboard, not a method binary, so this launcher deliberately avoids the
// BinaryManager runtime (heartbeat auth, daemon supervision): it only needs a
// path to an executable and an inherited terminal.
//
// Resolution order:
//   1. BOSSY_BIN            — explicit operator override, must exist
//   2. verified cache       — versioned artifact downloaded by native pull
//   3. `bossy` on PATH      — a system install
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

/**
 * Launch Bossy on the caller's terminal and resolve with its exit code.
 * Every CLI argument except the `--bossy` trigger is forwarded, so
 * `posse --bossy --sample` works the way `bossy --sample` does.
 *
 * @param {{ argv?: string[], env?: NodeJS.ProcessEnv }} [opts]
 * @returns {Promise<number>}
 */
export async function launchBossy({ argv = process.argv.slice(2), env = process.env } = {}) {
  let resolved = resolveBossyBinary({ env });
  // An explicit override always wins. Otherwise prefer the newest artifact
  // Bossy's previous boot downloaded and checksum-verified. The first update
  // cannot replace the process currently executing, so activation is cleanly
  // deferred until this next launch.
  if (resolved.source !== "env") {
    try {
      const tokens = platformTokens();
      const cached = await findVerifiedNativeBinaryArtifact({
        name: "bossy", os: tokens.os, arch: tokens.arch,
      });
      if (cached?.binaryPath) resolved = { target: cached.binaryPath, source: "cache" };
    } catch { /* PATH fallback remains valid */ }
  }
  if (resolved.error) {
    console.error(`\nCannot launch Bossy: ${resolved.error}\n`);
    return 1;
  }
  const args = argv.filter((arg) => arg !== "--bossy");
  return new Promise((resolve) => {
    const child = spawn(resolved.target, args, { stdio: "inherit", env });
    child.on("error", (err) => {
      if (err && err.code === "ENOENT") {
        console.error("\nCannot launch Bossy: no `bossy` executable was found.");
        console.error("Run `npm run pull:native`, install it on PATH, or set BOSSY_BIN to the binary.\n");
      } else {
        console.error(`\nCannot launch Bossy: ${err?.message || err}\n`);
      }
      resolve(1);
    });
    child.on("exit", (code, signal) => {
      resolve(signal ? 1 : (code ?? 0));
    });
  });
}
