// @ts-check

import fs from "node:fs";

export function isProcessAlive(pid) {
  const numericPid = Number(pid);
  if (!Number.isInteger(numericPid) || numericPid <= 0) return null;
  try {
    process.kill(numericPid, 0);
    return true;
  } catch (error) {
    if (error?.code === "ESRCH") return false;
    if (error?.code === "EPERM") return true;
    return null;
  }
}

let ownStartToken;

/**
 * Identity of one run of a process, so a recorded pid can be told apart from
 * a later process that reuses it (a restart, a container's pid 1, pid wrap):
 * the kernel boot id plus the process start time in clock ticks
 * (/proc/<pid>/stat field 22). Null where procfs is unavailable.
 * @param {number} [pid]
 * @returns {string | null}
 */
export function processStartToken(pid = process.pid) {
  const own = Number(pid) === process.pid;
  if (own && ownStartToken !== undefined) return ownStartToken;
  let token = null;
  if (process.platform === "linux" && Number.isInteger(Number(pid)) && Number(pid) > 0) {
    try {
      const stat = fs.readFileSync(`/proc/${Number(pid)}/stat`, "utf8");
      // Fields after the parenthesized command name start at field 3 (state).
      const startTicks = stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
      if (/^\d+$/.test(startTicks || "")) {
        let bootId = "";
        try { bootId = fs.readFileSync("/proc/sys/kernel/random/boot_id", "utf8").trim(); } catch { /* start time alone */ }
        token = `linux:${bootId}:${startTicks}`;
      }
    } catch { /* gone or unreadable */ }
  }
  if (own) ownStartToken = token;
  return token;
}

/**
 * Whether the process run that recorded (pid, startToken) is still running:
 * true when the pid is alive with the same start token, false when the pid is
 * gone or now belongs to another process, null when that cannot be told
 * (no token recorded, or none readable on this platform).
 * @param {number} pid
 * @param {string | null} [startToken]
 * @returns {boolean | null}
 */
export function isProcessRunAlive(pid, startToken = null) {
  const alive = isProcessAlive(pid);
  if (alive !== true) return alive;
  if (!startToken) return null;
  const current = processStartToken(pid);
  if (!current) return null;
  return current === startToken;
}
