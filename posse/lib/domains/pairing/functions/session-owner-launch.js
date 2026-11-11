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
 * Where the window reports on itself. Its shell writes `token=`, `pid=` and
 * `started_at=` before posse go runs, then `exit=` (go's exit code) and, when
 * it could not start go at all, `error=`. posse go adds `booted=1` once its
 * startup checks passed and `reason=` when it stops early. The console reads
 * it to tell a window that died (nothing written, or a pid that is gone) from
 * a go that is still booting, and to say why go ended.
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
  const marker = { token: null, pid: null, started_at: null, exit_code: undefined, error: null, reason: null, booted: false };
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
    // The shell could not start posse go at all (PowerShell's own message).
    else if (key === "error") marker.error = value || null;
    // posse go's own account of why it stopped; the last one written wins.
    else if (key === "reason") marker.reason = value || null;
    else if (key === "booted") marker.booted = value === "1";
  }
  return marker;
}

// The PowerShell the new window runs: the command with the owner pid and
// launch token set for that one command only, not for whatever the user types
// in the window afterwards (-NoExit keeps it open to read the wrap-up). With a
// marker path, the shell records its pid before the command and go's exit code
// after it, so the console can see what became of the window. A command that
// ends badly, or cannot start, leaves one plain line in the window saying so.
export function posseWindowScript(command, { ownerPid, token, markerPath = null, cwd = null }) {
  // Named once: the launch line has a length limit (see below).
  const marker = markerPath ? "$posseMarker" : null;
  const lines = [
    `$env:${SESSION_OWNER_CHILD_ENV} = '${Number(ownerPid)}'`,
    `$env:${SESSION_OWNER_LAUNCH_ENV} = ${powershellQuoted(token)}`,
    // Older libuv Node builds abort in a console whose title is empty; the
    // `start` title covers conhost, this covers hosts that reset it.
    `try { $Host.UI.RawUI.WindowTitle = 'Posse go' } catch { }`,
  ];
  // cmd.exe cannot start in a UNC folder (a network share, \\wsl$) and falls
  // back to the Windows directory, where posse go would find no project.
  if (cwd) lines.push(`try { Set-Location -LiteralPath ${powershellQuoted(cwd)} -ErrorAction Stop } catch { }`);
  if (marker) {
    lines.push(`$posseMarker = ${powershellQuoted(markerPath)}`);
    lines.push(
      `Set-Content -LiteralPath ${marker} -Value @(${powershellQuoted(`token=${token}`)}, ('pid=' + $PID), ('started_at=' + [DateTime]::UtcNow.ToString('o'))) -ErrorAction SilentlyContinue`,
    );
  }
  const cleanup = [
    `Remove-Item Env:${SESSION_OWNER_CHILD_ENV}, Env:${SESSION_OWNER_LAUNCH_ENV} -ErrorAction SilentlyContinue`,
    ...(marker ? [
      `if ($posseError) { Add-Content -LiteralPath ${marker} -Value ('error=' + $posseError) -ErrorAction SilentlyContinue }`,
      `Add-Content -LiteralPath ${marker} -Value ('exit=' + $posseExit) -ErrorAction SilentlyContinue`,
    ] : []),
  ].join("; ");
  lines.push(`$posseExit = $null`);
  lines.push(`$posseError = $null`);
  lines.push(
    `try { & ${command.map(powershellQuoted).join(" ")}; $posseExit = $LASTEXITCODE }`
    + ` catch { $posseError = ("$_" -replace '\\s+', ' ') }`
    + ` finally { ${cleanup} }`,
  );
  lines.push(
    `if ($posseError) { Write-Host ('posse go could not start in this window: ' + $posseError) -ForegroundColor Yellow }`
    + ` elseif ($null -eq $posseExit) { Write-Host 'posse go ended without an exit code.' -ForegroundColor Yellow }`
    + ` elseif ($posseExit -ne 0) { Write-Host ('posse go ended with exit code ' + $posseExit + '. Its output is above; this window stays open.') -ForegroundColor Yellow }`,
  );
  return lines.join("; ");
}

// cmd.exe refuses a command line longer than 8191 characters. The launch line
// is about 2.7 characters per script character (UTF-16 in base64), so only
// paths far beyond MAX_PATH get near it; such a launch runs in place instead
// of leaving cmd to fail on it.
export const GO_WINDOW_COMMAND_LINE_MAX = 8000;

/** The one command line cmd.exe runs to open the window. */
export function posseWindowCommandLine(script) {
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  // `start` needs a non-empty title: older libuv Node builds crash in a
  // console whose title is empty.
  return `start "Posse go" powershell.exe -NoLogo -NoExit -NoProfile -ExecutionPolicy Bypass -EncodedCommand ${encoded}`;
}

/**
 * On Windows the session console's `go window` opens `posse go` in a new
 * PowerShell window instead of taking over its own terminal, so the host
 * keeps the console (plain `go` runs in the console's terminal everywhere). The window carries a one-time token the console records first: its
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
    cwd,
  });
  const commandLine = posseWindowCommandLine(script);
  if (commandLine.length > GO_WINDOW_COMMAND_LINE_MAX) {
    throw new Error(`the launch command is ${commandLine.length} characters, more than cmd.exe accepts`);
  }
  const child = spawn(process.env.ComSpec || "cmd.exe", ["/d", "/s", "/c", commandLine],
    { cwd, stdio: "ignore", windowsHide: true, windowsVerbatimArguments: true });
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

// A terminal's own control characters and colours have no place in a one-line
// reason; neither has a line break, which would start another marker key.
const reasonText = (value) => String(value ?? "")
  .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/gu, "")
  .replace(/\s+/gu, " ")
  .trim()
  .slice(0, 300);

/**
 * A windowed posse go writes about itself into its window's marker: `booted`
 * once its startup checks passed, `reason` when it stops early. Only the go
 * the marker's window started may write; everything else is a no-op, so the
 * callers need no test for how they were launched.
 */
export function noteGoWindow(key, value, { env = process.env, projectDir = process.cwd() } = {}) {
  const token = String(env?.[SESSION_OWNER_LAUNCH_ENV] || "");
  if (!token || !/^[a-z_]+$/u.test(String(key))) return false;
  try {
    if (readGoWindowMarker(projectDir)?.token !== token) return false;
    fs.appendFileSync(goWindowMarkerPath(projectDir), `${key}=${reasonText(value)}\r\n`);
    return true;
  } catch {
    return false;
  }
}

/**
 * The console gave up on a window (it never reported, or died) and runs posse
 * go itself. Revoking the launch makes a window that turns up late stop
 * instead of starting a second run. False when the window's go has recorded
 * its pid meanwhile: it is running, and the console must not start another.
 */
export function revokeOwnerLaunch(token, reason = "") {
  const launch = readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_OWNER_LAUNCH);
  if (!token || launch?.token !== token) return true;
  if (Number(launch.child_pid) > 0) return false;
  writeRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_OWNER_LAUNCH, { ...launch, revoked_at: new Date().toISOString(), revoked_reason: reasonText(reason) });
  return true;
}

/** Why this windowed posse go must not run, or null when it may. */
export function ownerLaunchRevoked({ env = process.env } = {}) {
  const token = String(env?.[SESSION_OWNER_LAUNCH_ENV] || "");
  if (!token) return null;
  const launch = readRuntimeStatus(RUNTIME_STATUS_KEYS.SESSION_OWNER_LAUNCH);
  if (launch?.token !== token || !launch.revoked_at) return null;
  return "the session console stopped waiting for this window and runs posse go itself";
}

// Ctrl+C in the window (130, and Windows' STATUS_CONTROL_C_EXIT as PowerShell
// reports it, signed or unsigned): the person stopped it; nothing to rerun.
const INTERRUPT_EXIT_CODES = new Set([130, 3221225786, -1073741510]);

/**
 * What became of a posse go window, from what the console can observe. Pure,
 * so every branch is testable without a window.
 *
 *   settled   the console stops watching this window
 *   fallback  run posse go in the console's own terminal instead
 *   message   what to tell the operator (null: nothing worth a line)
 *
 * A go that holds the scheduler lock or whose recorded pid is alive is
 * running. Otherwise the window's marker decides. The fallback is only for a
 * window in which posse go provably is not running and never got through its
 * startup: nothing a second run could collide with.
 */
export function goWindowVerdict({
  marker = null,
  token,
  childPid = null,
  childAlive = false,
  lockLive = false,
  shellDead = false,
  hasMarker = false,
  elapsedMs = 0,
  graceMs = GO_WINDOW_MARKER_GRACE_MS,
} = {}) {
  const waiting = { settled: false, fallback: false, message: null };
  const acknowledged = Number.isSafeInteger(childPid) && childPid > 0;
  if (lockLive || (acknowledged && childAlive)) return waiting;
  const own = marker && marker.token === token ? marker : null;
  const started = acknowledged || own?.booted === true;
  const why = own?.reason ? `: ${own.reason}` : "";
  if (own?.error) {
    return { settled: true, fallback: true, message: `the go window could not start posse go: ${own.error}; running posse go here instead.` };
  }
  if (own && own.exit_code !== undefined) {
    if (own.exit_code === 0) {
      return { settled: true, fallback: false, message: own.reason ? `posse go finished in its window: ${own.reason}` : null };
    }
    const code = own.exit_code ?? "unknown";
    if (own.reason) {
      return { settled: true, fallback: false, message: `posse go stopped in its window: ${own.reason} (exit code ${code}); the window is still open.` };
    }
    if (started || INTERRUPT_EXIT_CODES.has(own.exit_code)) {
      return { settled: true, fallback: false, message: `posse go ended with exit code ${code} in its window; its output is still there.` };
    }
    // It died during startup without saying why (a crash, or a kill): the
    // console's own terminal either works or shows the error where it is read.
    return { settled: true, fallback: true, message: `posse go ended with exit code ${code} in its window before it finished starting; running posse go here instead.` };
  }
  if (own?.pid ? !shellDead : !(hasMarker && elapsedMs >= graceMs)) return waiting;
  if (started) {
    return { settled: true, fallback: false, message: `the go window closed: it went away while posse go was running${why || "; the exit status is unavailable"}.` };
  }
  return own
    ? { settled: true, fallback: true, message: `the go window closed: it went away before posse go finished starting${why}; running posse go here instead.` }
    : { settled: true, fallback: true, message: `the go window closed: its PowerShell never ran the launch script (no report after ${Math.round(graceMs / 1000)}s); running posse go here instead.` };
}

/**
 * Why this terminal cannot show posse go's full-screen run display, or null
 * when it can. The console then runs posse go with its plain log output
 * (--no-tui) instead of handing a terminal escape codes it prints verbatim.
 */
export function terminalFullScreenLimit({ stdout = process.stdout, env = process.env } = {}) {
  if (!stdout?.isTTY) return "its output is not a terminal";
  if (String(env?.TERM || "").toLowerCase() === "dumb") return "TERM=dumb";
  return null;
}
