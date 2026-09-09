#!/usr/bin/env node
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { AutomationOwnerClient } from "../classes/AutomationOwnerClient.js";

const ownerEntry = fileURLToPath(new URL("./automation-owner-entry.js", import.meta.url));
let stopping = false;
let child = null;

const stop = signal => {
  stopping = true;
  try { child?.kill(signal); } catch {}
};
process.once("SIGINT", () => stop("SIGINT"));
process.once("SIGTERM", () => stop("SIGTERM"));

let failures = 0;
while (!stopping) {
  child = spawn(process.execPath, [ownerEntry], {
    stdio: "ignore",
    windowsHide: true,
    env: { ...process.env, POSSE_AUTOMATION_SUPERVISOR_PID: String(process.pid) },
  });
  await new Promise(resolve => child.once("exit", resolve));
  child = null;
  if (stopping) break;
  try {
    if ((await new AutomationOwnerClient({ timeoutMs: 300 }).health())?.ready === true) break;
  } catch {}
  failures++;
  const delay = Math.min(30_000, 250 * 2 ** Math.min(failures, 7));
  await new Promise(resolve => setTimeout(resolve, delay));
}
