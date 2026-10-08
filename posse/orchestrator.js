#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { loadUserProviderEnv, userProviderEnvPath } from "./lib/shared/platform/functions/user-provider-env.js";
import { installCliWarningFilter } from "./lib/domains/cli/functions/warnings.js";
import { scrubSecretText as scrubSecrets } from "./lib/shared/telemetry/functions/logging/scrub-secret-text.js";
import { nativeLoadFailureRemedy } from "./lib/shared/platform/functions/native-runtime-floor.js";

installCliWarningFilter();

// Node floor. Fail with the remedy before any native-addon import can turn a
// wrong Node into a raw ABI stack trace (package.json `engines` only warns).
// Nothing above this line may depend on a Node API newer than the floor.
const MIN_NODE_MAJOR = 24;
const nodeMajor = Number(String(process.versions.node).split(".")[0]);
if (Number.isFinite(nodeMajor) && nodeMajor < MIN_NODE_MAJOR) {
  process.stderr.write(
    `Posse requires Node ${MIN_NODE_MAJOR}+ (this is Node ${process.versions.node}).\n`
    + "Install a current Node (the Posse installer does this) and re-run, or re-run the installer.\n",
  );
  process.exit(1);
}

// Load only installer-owned credential names before boot imports read them.
// Explicit process/container environment values always take precedence. An
// unreadable private .env is fatal (the user asked for it to be used); an
// unreadable legacy file only warns so one stale root-owned file cannot
// disable every command.
if (!process.env.NODE_TEST_CONTEXT && !process.env.POSSE_TEST_RUN) {
  try {
    loadUserProviderEnv({
      onWarning: (error) => process.stderr.write(`Ignoring unreadable legacy credential file ${error?.path || "(unknown)"}: ${error?.code || error?.message || error}\n`),
    });
  } catch (error) {
    process.stderr.write(`Could not read ${error?.path || userProviderEnvPath()} (${error?.code || error?.message || error}); fix its permissions and retry.\n`);
    process.exit(1);
  }
}

// Fatal crash recorder. The main orchestrator process has no global
// rejection/exception handler (only the worker processes do), so a teardown
// unhandled rejection — e.g. a child-index/daemon close race during the
// post-merge wi_cleanup warm — crashes the run on Node's default behavior,
// silently aborting the wrap-up/push. This captures the FULL stack to a
// persistent crash log (+ stderr) so the exact teardown site can be fixed, then
// exits non-zero. It does NOT swallow — the process still dies, it's just no
// longer silent. Crash log: <cwd>/.posse/logs/fatal-crashes.log.
// A broken output pipe is benign and must NOT be treated as a fatal crash. When
// the stdout/stderr consumer (TUI/terminal/parent) detaches, the next raw
// console.log issues a synchronous write to a dead pipe; without this guard that
// EPIPE surfaces as an uncaughtException -> exit(1), aborting the run's wrap-up
// (worktree GC / push). Broken-pipe codes are swallowed everywhere; every other
// error still reaches the recorder and still dies.
const isBrokenPipe = (err) => {
  const code = err && err.code;
  return code === "EPIPE" || code === "ERR_STREAM_DESTROYED" || code === "ERR_STREAM_WRITE_AFTER_END";
};
// Observability for the swallowed-pipe case: leave a single benign note in the
// crash log (never stdout — that's the dead stream) so a detached consumer is
// visible without becoming a crash. Once per process to avoid spamming.
let brokenPipeNoted = false;
const noteBrokenPipeOnce = (kind) => {
  if (brokenPipeNoted) return;
  brokenPipeNoted = true;
  try {
    const dir = path.join(process.cwd(), ".posse", "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(
      path.join(dir, "fatal-crashes.log"),
      `\n[${new Date().toISOString()}] NOTE broken-pipe swallowed (${kind}) — output consumer detached; run continues\n`,
    );
  } catch { /* best effort */ }
};
const recordFatalCrash = (kind, err) => {
  if (isBrokenPipe(err)) { noteBrokenPipeOnce(kind); return; } // consumer gone — keep running, don't abort
  const stack = err && err.stack ? err.stack : String(err);
  const code = err && err.code ? ` code=${err.code}` : "";
  const remedyText = nativeLoadFailureRemedy(`${err?.code || ""} ${err?.message || ""} ${stack}`);
  const remedy = remedyText ? `\nRemedy: ${remedyText}\n` : "";
  const line = scrubSecrets(`\n[${new Date().toISOString()}] FATAL ${kind}${code}\n${stack}\n${remedy}`);
  try { process.stderr.write(`\x1b[?25h\x1b[0m${line}`); } catch { /* best effort */ }
  try {
    const dir = path.join(process.cwd(), ".posse", "logs");
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, "fatal-crashes.log"), line);
  } catch { /* best effort */ }
  process.exit(1);
};
// Durable, stream-level guard: attach 'error' listeners so a broken-pipe write
// never even becomes an uncaughtException. Covers ALL raw stdout/stderr writes,
// not just known console.log sites. A terminal window that was closed fails
// writes with EIO rather than EPIPE; it is the same detached consumer (a
// session host closing its terminal must still integrate and clean up).
for (const stream of [process.stdout, process.stderr]) {
  try {
    stream.on("error", (err) => {
      if (isBrokenPipe(err) || err?.code === "EIO") noteBrokenPipeOnce("stream");
      else recordFatalCrash("stream", err);
    });
  } catch { /* best effort */ }
}
process.on("uncaughtException", (err) => recordFatalCrash("uncaughtException", err));
process.on("unhandledRejection", (reason) => recordFatalCrash("unhandledRejection", reason));

// `posse bossy` / `posse --bossy` refreshes and launches the Bossy TUI without
// booting the CLI runtime (db, daemons, telemetry) underneath it — Bossy is
// its own operator surface and reads Posse's persisted state itself.
if (process.argv[2] === "bossy" || process.argv.includes("--bossy")) {
  const { launchBossy } = await import("./lib/domains/cli/functions/bossy-launch.js");
  process.exit(await launchBossy());
}

// Read-only repository Atlas access for Bossy, before queue/runtime startup.
if (process.argv[2] === "atlas-read") {
  try {
    const { runBossyAtlasReadCli } = await import("./lib/domains/atlas/functions/bossy-read.js");
    await runBossyAtlasReadCli();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`atlas_read_error: ${error?.message || error}\n`);
    process.exit(1);
  }
}

// The machine automation owner has its own private database and lifecycle. It
// must be callable without opening a repository queue so Bossy and service
// managers can use the same operator protocol from any working directory.
if (process.argv[2] === "automation") {
  const { runAutomationCli } = await import("./lib/domains/automation/functions/automation-cli.js");
  try {
    await runAutomationCli();
    process.exit(0);
  } catch (error) {
    process.stderr.write(`${error?.code || "automation_error"}: ${error?.message || error}\n`);
    process.exit(1);
  }
}

// Script tools live with the machine automation owner too: authoring, tests,
// secrets and grants go through its operator protocol, never a repository
// queue, so `posse tools` works from any directory.
if (process.argv[2] === "tools") {
  const { runToolsCli } = await import("./lib/domains/automation/functions/tools-cli.js");
  try {
    process.exit(await runToolsCli(process.argv.slice(3)));
  } catch (error) {
    process.stderr.write(`${error?.code || "tools_error"}: ${error?.message || error}\n`);
    process.exit(1);
  }
}

// A session join typed in any folder runs in a folder of its own. This runs
// before the application import below, which writes Posse state (run logs,
// the database) into the current folder.
const { relocateSessionJoinIfNeeded } = await import("./lib/domains/pairing/functions/join-folder.js");
const relocatedJoin = await relocateSessionJoinIfNeeded();
if (relocatedJoin) process.exit(relocatedJoin.exitCode);

// Doctor and update may have to replace Posse's own native Node dependencies.
// Handle them before the main application imports/opens better-sqlite3; Windows
// will not unlink a loaded .node module from the live process.
const { runMaintenanceCliIfRequested, guardRunNodeDependencies } = await import("./lib/domains/cli/functions/maintenance-bootstrap.js");
if (await runMaintenanceCliIfRequested()) {
  // Maintenance awaited every child and flushed its output. Exit explicitly so
  // a native heartbeat or package-manager handle cannot pin the bootstrap.
  process.exit(process.exitCode ?? 0);
}

await guardRunNodeDependencies();

// User-defined agents use the provider runtime but not a repository queue.
// Keep this after the native dependency guard and before the main app opens
// repository state, so `posse agent` works from any directory.
if (process.argv[2] === "agent") {
  const { runAgentCli } = await import("./lib/domains/agents/functions/agent-cli.js");
  try {
    process.exit(await runAgentCli(process.argv.slice(3)));
  } catch (error) {
    process.stderr.write(`${error?.code || "agent_error"}: ${error?.message || error}\n`);
    process.exit(1);
  }
}

const { runOrchestratorCli } = await import("./lib/domains/cli/functions/orchestrator-app.js");
await runOrchestratorCli();
