import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { SESSION_OWNER_CHILD_ENV, SESSION_OWNER_LAUNCH_ENV } from "../../../catalog/session-sync.js";
import { readRuntimeStatus, RUNTIME_STATUS_KEYS, writeRuntimeStatus } from "../../queue/functions/runtime-status.js";

// A token is good for go's boot, which checks it within seconds of launch.
export const SESSION_OWNER_LAUNCH_TTL_MS = 10 * 60_000;

// PowerShell ends a single-quoted string at ' and at the typographic quotes
// U+2018-U+201B (a path like C:\Users\O’Brien); doubling escapes each.
const powershellQuoted = (value) => `'${String(value).replace(/['\u2018\u2019\u201A\u201B]/gu, "$&$&")}'`;

// The PowerShell the new window runs: the command with the owner pid and
// launch token set for that one command only, not for whatever the user types
// in the window afterwards (-NoExit keeps it open to read the wrap-up).
export function posseWindowScript(command, { ownerPid, token }) {
  return [
    `$env:${SESSION_OWNER_CHILD_ENV} = '${Number(ownerPid)}'`,
    `$env:${SESSION_OWNER_LAUNCH_ENV} = ${powershellQuoted(token)}`,
    `try { & ${command.map(powershellQuoted).join(" ")} } finally { Remove-Item Env:${SESSION_OWNER_CHILD_ENV}, Env:${SESSION_OWNER_LAUNCH_ENV} -ErrorAction SilentlyContinue }`,
  ].join("; ");
}

/**
 * On Windows the session console opens `posse go` in a new PowerShell window
 * instead of taking over its own terminal, so the host keeps the session
 * screen. The window carries a one-time token the console records first: its
 * shell, not the console, is go's parent, so the parent check alone would
 * read a live console as crashed.
 */
export async function openPosseInNewWindow(args, { cwd } = {}) {
  const token = randomUUID();
  const recorded = writeRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_OWNER_LAUNCH, {
    owner_pid: process.pid,
    token,
    created_at: new Date().toISOString(),
  });
  // Without the token, go's recovery could not tell this console is alive.
  if (!recorded) throw new Error("could not record the launch token");
  const script = posseWindowScript([process.execPath, ...process.execArgv, process.argv[1], ...args], {
    ownerPid: process.pid,
    token,
  });
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // `start` needs a non-empty title: older libuv Node builds crash in a
  // console whose title is empty.
  const child = spawn(process.env.ComSpec || "cmd.exe", [
    "/d", "/s", "/c",
    `start "Posse go" powershell.exe -NoLogo -NoExit -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`,
  ], { cwd, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
  // `start` returns as soon as the window exists; a non-zero exit or a spawn
  // error means no window, and the console runs go in place instead.
  await new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, 15_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("exit", (code) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`start exited with code ${code}`));
    });
  });
  child.unref?.();
  return { token };
}

/**
 * A windowed go records its own pid against the launch token as soon as its
 * recovery check accepts the token, so the console can tell a go that is
 * still starting (before it takes the scheduler lock) from one that died.
 */
export function acknowledgeOwnerLaunch({ env = process.env, pid = process.pid } = {}) {
  const token = String(env?.[SESSION_OWNER_LAUNCH_ENV] || "");
  if (!token) return;
  const launch = readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_OWNER_LAUNCH);
  if (launch?.token !== token) return;
  writeRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_OWNER_LAUNCH, { ...launch, child_pid: pid, acknowledged_at: new Date().toISOString() });
}

/**
 * True for a posse process the live session owner started itself: it names
 * the owner as its parent, or carries the token of a window the owner opened,
 * and the owner still runs. Recovery would otherwise read a heartbeat gone
 * stale in a relay outage as a crash and close the session out from under
 * its running owner.
 */
export function spawnedByLiveSessionOwner(state, {
  env = process.env,
  parentPid = process.ppid,
  kill = process.kill.bind(process),
  readLaunch = () => readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_OWNER_LAUNCH),
  nowMs = Date.now(),
} = {}) {
  const ownerPid = Number(env?.[SESSION_OWNER_CHILD_ENV]);
  if (!Number.isSafeInteger(ownerPid) || ownerPid <= 0) return false;
  if (ownerPid !== Number(state?.process_pid)) return false;
  if (ownerPid !== Number(parentPid)) {
    const token = String(env?.[SESSION_OWNER_LAUNCH_ENV] || "");
    const launch = token ? readLaunch() : null;
    const age = nowMs - Date.parse(launch?.created_at || "");
    if (!token || launch?.token !== token || Number(launch?.owner_pid) !== ownerPid
      || !(age >= 0 && age < SESSION_OWNER_LAUNCH_TTL_MS)) return false;
  }
  try {
    kill(ownerPid, 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}
