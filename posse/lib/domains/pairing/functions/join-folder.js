import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// `posse session join CODE` works from any folder. A join needs a folder of
// its own: an empty one, or the member's clone of the project (`--here`).
// Started anywhere else, the join runs again in ~/posse-sessions/<CODE>
// before Posse writes anything (its run log, its database) into the folder it
// was typed in. The session's work stays in that folder after the session, so
// it is not a temporary directory. The same code always maps to the same
// folder, so typing the join again rejoins there.

export const SESSION_JOIN_FOLDER_ENV = "POSSE_SESSION_JOIN_FOLDER";
export const SESSION_JOIN_HERE_FLAG = "--here";
export const SESSION_JOIN_FOLDERS_DIRECTORY = "posse-sessions";
// What a folder may already hold and still count as empty: Posse's own state
// and Finder litter.
export const EMPTY_JOIN_FOLDER_ENTRIES = Object.freeze(new Set([".posse", ".DS_Store"]));

const SESSION_COMMANDS = new Set(["session", "pair"]);
const VALUE_OPTIONS = new Set(["--remote", "--branch"]);
const PAIRING_CODE_RE = /^[a-z0-9]{5}-[a-z0-9]{5}$/iu;
// Signals a terminal delivers to its whole foreground process group. The
// joining child receives them itself and owns the shutdown they ask for.
const TERMINAL_SIGNALS = Object.freeze(["SIGINT", "SIGTERM", "SIGHUP"]);

/** The join a command line asks for, in the shapes parsePairArgs accepts as a join. */
export function sessionJoinRequest(argv = process.argv.slice(2)) {
  const args = [...argv].map(String);
  if (!SESSION_COMMANDS.has(String(args[0] || "").trim().toLowerCase())) return null;
  const positional = [];
  let here = false;
  for (let index = 1; index < args.length; index += 1) {
    const arg = args[index];
    if (arg === "--help" || arg === "-h") return null;
    if (arg === SESSION_JOIN_HERE_FLAG) {
      here = true;
      continue;
    }
    if (VALUE_OPTIONS.has(arg)) {
      index += 1;
      continue;
    }
    if (arg.startsWith("-")) continue;
    positional.push(arg);
  }
  const [first = "", second = ""] = positional;
  let code = "";
  if (first.toLowerCase() === "join") code = second;
  else if (PAIRING_CODE_RE.test(first) || first.toLowerCase().startsWith("posse://")) code = first;
  return code ? { code, here } : null;
}

export function sessionJoinFolderName(code) {
  let token = String(code || "").trim();
  if (token.toLowerCase().startsWith("posse://")) {
    try {
      token = new URL(token).searchParams.get("token") || "";
    } catch {
      token = "";
    }
  }
  return token.toUpperCase().replace(/[^A-Z0-9-]/gu, "").slice(0, 64) || "session";
}

function folderIsEmpty(directory) {
  try {
    return fs.readdirSync(directory).every((entry) => EMPTY_JOIN_FOLDER_ENTRIES.has(entry));
  } catch {
    return false;
  }
}

/** Where a join typed in `cwd` runs, or null when it runs in `cwd` itself. */
export function sessionJoinFolder({
  argv = process.argv.slice(2),
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir(),
} = {}) {
  const request = sessionJoinRequest(argv);
  if (!request || request.here || env[SESSION_JOIN_FOLDER_ENV]) return null;
  if (folderIsEmpty(cwd)) return null;
  const target = path.join(homeDir, SESSION_JOIN_FOLDERS_DIRECTORY, sessionJoinFolderName(request.code));
  return path.resolve(cwd) === path.resolve(target) ? null : target;
}

// The child joins in its own folder, so an inherited project directory must
// not point its repository settings back at the folder the join was typed in.
function childEnvironment(env, target) {
  const childEnv = { ...env, [SESSION_JOIN_FOLDER_ENV]: target };
  delete childEnv.POSSE_PROJECT_DIR;
  return childEnv;
}

/**
 * Runs a join typed outside a join folder again inside its own folder, and
 * returns the child's exit code. Returns null when the join belongs here.
 */
export async function relocateSessionJoinIfNeeded({
  argv = process.argv,
  cwd = process.cwd(),
  env = process.env,
  homeDir = os.homedir(),
  execPath = process.execPath,
  execArgv = process.execArgv,
  spawnFn = spawn,
  stdout = process.stdout,
  stderr = process.stderr,
  signalTarget = process,
} = {}) {
  const target = sessionJoinFolder({ argv: argv.slice(2), cwd, env, homeDir });
  if (!target) return null;
  // --json keeps stdout for the join's own JSON lines.
  const json = argv.includes("--json");
  const say = (line) => (json ? stderr : stdout).write(`${line}\n`);
  try {
    fs.mkdirSync(target, { recursive: true });
  } catch (error) {
    // Reported here rather than as a crash logged into the folder the join
    // was typed in.
    stderr.write(`\n  Could not create the session folder ${target}: ${error?.message || error}\n`
      + "  Run the join with --here from an empty folder instead.\n");
    return { target, exitCode: 1 };
  }
  say(`\n  Joining in ${target}`);
  const ignore = () => {};
  for (const signal of TERMINAL_SIGNALS) signalTarget.on(signal, ignore);
  try {
    const child = spawnFn(execPath, [...execArgv, ...argv.slice(1)], {
      cwd: target,
      stdio: "inherit",
      env: childEnvironment(env, target),
    });
    const { code, signal } = await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (exitCode, exitSignal) => resolve({ code: exitCode, signal: exitSignal }));
    });
    if (!json) say(`  Session folder: ${target}\n`);
    return { target, exitCode: Number.isInteger(code) ? code : (signal ? 1 : 0) };
  } finally {
    for (const signal of TERMINAL_SIGNALS) signalTarget.removeListener(signal, ignore);
  }
}
