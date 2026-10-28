import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { SESSION_OWNER_CHILD_ENV, SESSION_OWNER_LAUNCH_ENV } from "../../../catalog/session-sync.js";
import { readRuntimeStatus, RUNTIME_STATUS_KEYS, writeRuntimeStatus } from "../../queue/functions/runtime-status.js";

// A token is good for go's boot, which checks it within seconds of launch.
export const SESSION_OWNER_LAUNCH_TTL_MS = 10 * 60_000;

// The window's shell writes its marker within a moment of opening; a window
// still silent after this long never ran the script (it closed on startup).
export const GO_WINDOW_MARKER_GRACE_MS = 20_000;

// PowerShell ends a single-quoted string at ' and at the typographic quotes
// U+2018-U+201B (a path like C:\Users\O’Brien); doubling escapes each.
const powershellQuoted = (value) => `'${String(value).replace(/['\u2018\u2019\u201A\u201B]/gu, "$&$&")}'`;

/**
 * Where the window's shell reports on itself: its pid and start time before
 * posse go runs, and go's exit code after. The console reads it to tell a
 * window that died (nothing posse wrote, or a pid that is gone) from a go that
 * is still booting, and to say how go ended when the window closed on its own.
 */
export function goWindowMarkerPath(projectDir) {
  return path.join(projectDir, ".posse", "run", "session-go-window.txt");
}

/** Parse the marker: `key=value` lines. Null when there is none yet. */
export function readGoWindowMarker(projectDir) {
  let text;
  try {
    text = fs.readFileSync(goWindowMarkerPath(projectDir), "utf8");
  } catch {
    return null;
  }
  const marker = { token: null, pid: null, started_at: null, exit_code: undefined };
  for (const raw of String(text).split(/\r?\n/u)) {
    const line = raw.replace(/^\uFEFF/u, "").trim();
    const separator = line.indexOf("=");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (key === "token") marker.token = value || null;
    else if (key === "pid") marker.pid = /^\d+$/u.test(value) ? Number(value) : null;
    else if (key === "started_at") marker.started_at = value || null;
    else if (key === "exit") marker.exit_code = /^-?\d+$/u.test(value) ? Number(value) : null;
  }
  return marker;
}

// The PowerShell the new window runs: the command with the owner pid and
// launch token set for that one command only, not for whatever the user types
// in the window afterwards (-NoExit keeps it open to read the wrap-up). With a
// marker path, the shell records its pid before the command and go's exit code
// after it, so the console can see what became of the window.
export function posseWindowScript(command, { ownerPid, token, markerPath = null }) {
  const marker = markerPath ? powershellQuoted(markerPath) : null;
  const lines = [
    `$env:${SESSION_OWNER_CHILD_ENV} = '${Number(ownerPid)}'`,
    `$env:${SESSION_OWNER_LAUNCH_ENV} = ${powershellQuoted(token)}`,
    // Older libuv Node builds abort in a console whose title is empty; the
    // `start` title covers conhost, this covers hosts that reset it.
    `try { $Host.UI.RawUI.WindowTitle = 'Posse go' } catch { }`,
  ];
  if (marker) {
    lines.push(
      `Set-Content -LiteralPath ${marker} -Value @(${powershellQuoted(`token=${token}`)}, ('pid=' + $PID), ('started_at=' + [DateTime]::UtcNow.ToString('o'))) -ErrorAction SilentlyContinue`,
    );
  }
  const cleanup = [
    `Remove-Item Env:${SESSION_OWNER_CHILD_ENV}, Env:${SESSION_OWNER_LAUNCH_ENV} -ErrorAction SilentlyContinue`,
    ...(marker ? [`Add-Content -LiteralPath ${marker} -Value ('exit=' + $posseExit) -ErrorAction SilentlyContinue`] : []),
  ].join("; ");
  lines.push(`$posseExit = $null`);
  lines.push(`try { & ${command.map(powershellQuoted).join(" ")}; $posseExit = $LASTEXITCODE } finally { ${cleanup} }`);
  return lines.join("; ");
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
  // A fresh marker per window: a stale one from the last window must not
  // pass for this one. Losing the marker only costs the console its view of
  // the window, so neither step may stop the launch.
  let markerPath = null;
  if (cwd) {
    markerPath = goWindowMarkerPath(cwd);
    try {
      fs.mkdirSync(path.dirname(markerPath), { recursive: true });
      fs.rmSync(markerPath, { force: true });
    } catch {
      markerPath = null;
    }
  }
  const script = posseWindowScript([process.execPath, ...process.execArgv, process.argv[1], ...args], {
    ownerPid: process.pid,
    token,
    markerPath,
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
  return { token, markerPath };
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
