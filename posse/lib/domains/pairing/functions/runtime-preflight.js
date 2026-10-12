import { execFile } from "node:child_process";
import { commandSpawnSpec, findCommandOnPath } from "../../../shared/platform/functions/command-launch.js";
import { PAIRING_COMMAND_CHECK_TIMEOUT_MS, PAIRING_RUNTIME_COMMANDS } from "../../../catalog/pairing-environment.js";
import { pairingCommandError } from "./environment-errors.js";

/** Fast local probes; authentication and remote write access keep their existing checks. */
export async function checkPairingRuntimeCommands(projectDir, {
  host = false, env = process.env, platform = process.platform,
  findCommand = findCommandOnPath, exec = execFile, onProgress = () => {},
  timeoutMs = PAIRING_COMMAND_CHECK_TIMEOUT_MS,
} = {}) {
  const results = [];
  for (const entry of PAIRING_RUNTIME_COMMANDS) {
    if (entry.hostOnly && !host) continue;
    onProgress({ message: `Checking ${entry.label}...`, status: "checking", command: entry.command });
    const executable = findCommand(entry.command, { platform, env });
    if (!executable) throw pairingCommandError(entry.command, { code: "ENOENT" });
    let version = "available";
    if (entry.args) {
      // The absolute PATH match avoids an extra Windows where.exe subprocess.
      const spec = commandSpawnSpec(executable, entry.args, { platform, env });
      try {
        version = await new Promise((resolve, reject) => {
          exec(spec.command, spec.args, { cwd: projectDir, env, timeout: timeoutMs,
            encoding: "utf8", windowsHide: true, windowsVerbatimArguments: spec.windowsVerbatimArguments === true,
            maxBuffer: 64 * 1024 }, (error, stdout, stderr) => {
            if (error) reject(error);
            else resolve(String(stdout || stderr || "available").split(/\r?\n/u)[0].trim().slice(0, 140));
          });
        });
      } catch (error) {
        const failure = pairingCommandError(entry.command, error, { timeoutMs, operation: "version check" });
        if (failure !== error) throw failure;
        throw Object.assign(new Error(`${entry.label} could not run its version check. ${entry.remedy}`, { cause: error }), {
          code: "pairing_environment_command_failed", command: entry.command,
        });
      }
    }
    results.push({ command: entry.command, ok: true, version });
    onProgress({ message: `${entry.label}: ${version}`, status: "ready", command: entry.command });
  }
  return { ok: true, commands: results };
}
