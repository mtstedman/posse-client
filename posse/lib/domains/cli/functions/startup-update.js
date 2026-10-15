import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { STARTUP_UPDATE_FLAGS } from "../../../catalog/cli-flags.js";
import { STARTUP_UPDATE_MODES, STARTUP_UPDATE_MODE_VALUES } from "../../../catalog/setting-policy.js";
import { needsRunnablePosse } from "./maintenance-bootstrap.js";
import { checkPosseUpdateAvailability } from "./update-command.js";
import { ask } from "./input-prompts.js";

const POSSE_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const SETTINGS_PROBE = fileURLToPath(new URL("./startup-update-settings-probe.js", import.meta.url));

export function readStartupUpdateMode({ cwd = process.cwd(), env = process.env } = {}) {
  const probe = spawnSync(process.execPath, [SETTINGS_PROBE], {
    cwd, env, encoding: "utf8", windowsHide: true, timeout: 10_000, maxBuffer: 1024 * 1024,
  });
  let payload;
  try { payload = JSON.parse(String(probe.stdout || "").trim()); } catch { /* reported below */ }
  if (probe.status !== 0 || !payload?.ok) {
    throw new Error(`Cannot read startup update preference: ${payload?.error || String(probe.stderr || probe.error?.message || "settings probe failed").trim()}`);
  }
  return payload.mode;
}

async function runStartupChild(args, { cwd, env, signalTarget = process }) {
  // A separate POSIX group lets this parent forward both terminal-group and
  // parent-only signals exactly once, including to the child's subprocesses.
  const separateGroup = process.platform !== "win32";
  const child = spawn(process.execPath, args, { cwd, env, stdio: "inherit", windowsHide: false, detached: separateGroup });
  const signals = ["SIGINT", "SIGTERM", "SIGHUP", ...(separateGroup ? ["SIGWINCH", "SIGTSTP", "SIGCONT"] : [])];
  const handlers = new Map(signals.map((signal) => [signal, () => {
    if (!child.pid) return;
    try {
      if (separateGroup) {
        // Detached groups cannot rely on terminal job-control delivery.
        process.kill(-child.pid, signal === "SIGTSTP" ? "SIGSTOP" : signal);
        if (signal === "SIGTSTP") process.kill(process.pid, "SIGSTOP");
      }
      // Windows console Ctrl-C already reaches both processes. child.kill
      // would terminate the child before its graceful console handler runs.
      else if (signal !== "SIGINT") child.kill(signal);
    } catch (error) { if (error.code !== "ESRCH") throw error; }
  }]));
  for (const [signal, handler] of handlers) signalTarget.on(signal, handler);
  try {
    return await new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => resolve(Number.isInteger(code) ? code : (signal === "SIGINT" ? 130 : 1)));
    });
  } finally {
    for (const [signal, handler] of handlers) signalTarget.removeListener(signal, handler);
  }
}

// Both children are fresh processes: neither native addons nor already
// imported JavaScript survive replacement of the installation.
export async function runStartupUpdateIfNeeded({
  argv = process.argv.slice(2),
  posseRoot = POSSE_ROOT,
  cwd = process.cwd(),
  env = process.env,
  input = process.stdin,
  output = process.stderr,
  check = checkPosseUpdateAvailability,
  getMode = readStartupUpdateMode,
  prompt = ask,
  runChild = runStartupChild,
} = {}) {
  const delimiter = argv.indexOf("--");
  const options = delimiter < 0 ? argv : argv.slice(0, delimiter);
  if (!needsRunnablePosse(options) || options.includes("--help") || options.includes("-h")) return null;
  if (options.includes(STARTUP_UPDATE_FLAGS.skip)) return null;
  const interactive = Boolean(input.isTTY && output.isTTY)
    && !options.some((flag) => ["--non-interactive", "--unattended", "--json"].includes(flag));

  try {
    const mode = options.includes(STARTUP_UPDATE_FLAGS.update)
      ? STARTUP_UPDATE_MODES.AUTO : await getMode({ cwd, env });
    if (!STARTUP_UPDATE_MODE_VALUES.includes(mode)) throw new Error(`Invalid startup update mode: ${mode}`);
    const automatic = mode === STARTUP_UPDATE_MODES.AUTO;
    if (mode === STARTUP_UPDATE_MODES.OFF || (!automatic && !interactive)) return null;
    // An actionable boot check observes upstream now, rather than consuming
    // the six-hour advisory cache used by the background boot panel.
    const availability = await check({ posseRoot });
    if (!availability.ok || availability.status === "skipped") {
      if (!automatic) return null;
      output.write(`Cannot verify a fresh Posse installation: ${availability.reason || "update check failed"}.\n`);
      return 1;
    }
    if (!availability.available) return null;
    output.write(`Posse update available (${availability.local_sha.slice(0, 8)} -> ${availability.remote_sha.slice(0, 8)}).\n`);
    if (!automatic) {
      const answer = await prompt("Save local installation edits in Git, update, and restart? [y/N] ", { input, output });
      if (!/^(?:y|yes)$/iu.test(String(answer).trim())) return null;
    }
    const cli = path.join(posseRoot, "orchestrator.js");
    const childOptions = { cwd, env };
    const updateCode = await runChild([cli, "update", STARTUP_UPDATE_FLAGS.stash], childOptions);
    if (updateCode !== 0) {
      output.write("Posse startup stopped because the update did not complete. Inspect the update result before retrying.\n");
      return updateCode;
    }
    output.write("Starting with the refreshed Posse installation.\n");
    const resumedOptions = options.filter((flag) => flag !== STARTUP_UPDATE_FLAGS.update);
    // Insert before literal arguments so descriptions can contain flag names,
    // and suppress a second prompt/restart loop in the resumed process.
    const resumed = [...resumedOptions, STARTUP_UPDATE_FLAGS.skip, ...(delimiter < 0 ? [] : argv.slice(delimiter))];
    return await runChild([cli, ...resumed], childOptions);
  } catch (error) {
    output.write(`Posse startup update failed: ${error?.message || error}\n`);
    return 1;
  }
}
