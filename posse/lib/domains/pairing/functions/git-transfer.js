import { setTimeout as sleep } from "node:timers/promises";
import { adminGitExecAsync } from "../../git/functions/admin-git-exec.js";
import { pairingGitTimeoutMs } from "./git-timeout.js";
import { pairingCommandError } from "./environment-errors.js";
import { PAIRING_GIT_TRANSFER_RETRY_DELAYS_MS, PAIRING_GIT_TRANSFER_INTERRUPTION } from "../../../catalog/pairing-environment.js";

export function formatPairingGitProgress(line) {
  // Only display Git's known progress vocabulary, never remote URLs, command
  // arguments, arbitrary server messages, or terminal control sequences.
  const match = String(line).trim().match(/^(?:remote: )?((?:Enumerating|Counting|Compressing|Receiving|Writing) objects|Resolving deltas|Updating files|Filtering content):\s*([\d\s%(),./|A-Za-z+-]+)$/u);
  if (!match) return null;
  const percent = match[2].match(/^(\d{1,3})%/u);
  const filled = percent ? Math.round(Math.min(100, Number(percent[1])) / 5) : null;
  return `${match[1]}: ${filled == null ? "" : `[${"#".repeat(filled)}${"-".repeat(20 - filled)}] `}${match[2]}`;
}

export async function runPairingGitTransfer(args, cwd, {
  operation = args[0], env, onProgress = () => {},
  timeoutMs = pairingGitTimeoutMs(operation),
  exec = adminGitExecAsync, wait = sleep,
} = {}) {
  const deadline = Date.now() + timeoutMs;
  for (let attempt = 0; ; attempt++) {
    let pending = "";
    let lastUpdate = 0;
    const started = Date.now();
    const heartbeat = setInterval(() => onProgress(`Git ${operation} still running (${Math.floor((Date.now() - started) / 1000)}s)...`), 15_000);
    heartbeat.unref?.();
    try {
      return await exec(args, cwd, { env, timeoutMs: Math.max(1, deadline - Date.now()),
        onStderr: (chunk) => {
          pending += String(chunk);
          const lines = pending.split(/[\r\n]/u);
          pending = lines.pop().slice(-4096);
          for (const line of lines) {
            const progress = formatPairingGitProgress(line);
            if (progress && (Date.now() - lastUpdate >= 250 || /100%/u.test(progress))) {
              onProgress(progress);
              lastUpdate = Date.now();
            }
          }
        },
      });
    } catch (error) {
      const delay = PAIRING_GIT_TRANSFER_RETRY_DELAYS_MS[attempt];
      const detail = `${error?.stderr || ""}\n${error?.message || ""}`;
      const interrupted = ["fetch", "push"].includes(operation) && PAIRING_GIT_TRANSFER_INTERRUPTION.test(detail);
      if (!["fetch", "push"].includes(operation) || delay == null || Date.now() + delay >= deadline
        || !interrupted) {
        if (interrupted) {
          throw Object.assign(new Error(`Git ${operation} connection interrupted after ${attempt + 1} attempt(s). Check your network, VPN, or firewall. If joining, rerun \`posse session join <code>\` in the same folder while the host session is open; if hosting, rerun \`posse pair\`.`, { cause: error }), {
            code: "pairing_git_transfer_interrupted", operation, attempts: attempt + 1,
          });
        }
        throw pairingCommandError("git", error, { operation, timeoutMs });
      }
      onProgress(`Git ${operation} connection interrupted; retrying in ${delay / 1000}s (attempt ${attempt + 2}/3)...`);
      clearInterval(heartbeat);
      await wait(delay);
    } finally { clearInterval(heartbeat); }
  }
}
