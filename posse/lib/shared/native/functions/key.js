// @ts-check

import { execFileSync } from "node:child_process";

/**
 * Resolve the canonical Posse credential. This function is intentionally kept
 * under the native-auth boundary so HeartbeatAuthManager remains the only
 * stateful authority that exposes it to consumers.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolvePosseKey(env = process.env) {
  const processValue = String(env?.POSSE_KEY || "").trim();
  if (processValue) return processValue;
  if (env !== process.env) return "";
  return readWindowsPersistedEnv("POSSE_KEY");
}

function readWindowsPersistedEnv(name) {
  if (process.platform !== "win32") return "";
  try {
    const script = [
      `$name = ${JSON.stringify(name)}`,
      "$user = [Environment]::GetEnvironmentVariable($name, 'User')",
      "if ($user) { $user; exit 0 }",
      "$machine = [Environment]::GetEnvironmentVariable($name, 'Machine')",
      "if ($machine) { $machine; exit 0 }",
    ].join("; ");
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}
