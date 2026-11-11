// Running a posse command in the terminal this process holds: the same entry
// point this process was started with, in this checkout, with the terminal
// inherited. The session console runs `add`, `go`, `merge` and `deploy` this
// way, and the session screen runs `merge` and `deploy` this way, so the
// command owns the terminal (and Ctrl+C) while the operator reads and answers.

import { spawn } from "node:child_process";
import { SESSION_OWNER_CHILD_ENV } from "../../../catalog/session-sync.js";

export function spawnPosseInForeground(args, { cwd } = {}) {
  return spawn(process.execPath, [...process.execArgv, process.argv[1], ...args], {
    cwd,
    stdio: "inherit",
    // The child's crash recovery must read this process as the live session
    // owner, not as a crashed one.
    env: { ...process.env, [SESSION_OWNER_CHILD_ENV]: String(process.pid) },
  });
}

/** Resolves (never rejects) with how the child ended. */
export function waitForForegroundExit(child) {
  return new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("exit", (code, signal) => resolve({ code, signal }));
  });
}
