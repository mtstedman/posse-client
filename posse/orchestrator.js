#!/usr/bin/env node

import { INSTALLATION_POLICY } from "./lib/catalog/installation-policy.js";

import { loadUserProviderEnv, userProviderEnvPath } from "./lib/shared/platform/functions/user-provider-env.js";
import { installCliWarningFilter } from "./lib/domains/cli/functions/warnings.js";
import { CliCrashRecorder } from "./lib/domains/cli/classes/CliCrashRecorder.js";

installCliWarningFilter();

// Node floor. Fail with the remedy before any native-addon import can turn a
// wrong Node into a raw ABI stack trace (package.json `engines` only warns).
// Nothing above this line may depend on a Node API newer than the floor.
const MIN_NODE_MAJOR = INSTALLATION_POLICY.nodeMajor;
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

// Record startup failures without loading the application runtime.
new CliCrashRecorder().install();

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
const { relocateSessionJoinIfNeeded, sessionJoinRequest } = await import("./lib/domains/pairing/functions/join-folder.js");
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

// Run and session hosting repair npm before the application loads. Refuse an
// uninitialized project first so a command in an arbitrary folder cannot
// install dependencies or create runtime state there. Joining owns first-run
// initialization in the folder selected above.
const { isPosseProjectInitialized, uninitializedProjectMessage } = await import("./lib/domains/cli/functions/project-init-state.js");
const { pairingCommandOpensSession } = await import("./lib/catalog/pairing-command.js");
const earlyCommand = String(process.argv[2] || "").toLowerCase();
const opensSession = ["pair", "session"].includes(earlyCommand)
  && pairingCommandOpensSession(process.argv.slice(3));
if ((earlyCommand === "run" || (opensSession && !sessionJoinRequest()))
    && !process.argv.includes("--help") && !process.argv.includes("-h")
    && !isPosseProjectInitialized()) {
  process.stderr.write(`${uninitializedProjectMessage()}\n`);
  process.exit(1);
}

await guardRunNodeDependencies();

// The account preference is read in a short-lived child after npm repair;
// the bootstrap itself still holds no native addon during an accepted update.
const { runStartupUpdateIfNeeded } = await import("./lib/domains/cli/functions/startup-update.js");
const startupUpdateExitCode = await runStartupUpdateIfNeeded();
if (startupUpdateExitCode !== null) process.exit(startupUpdateExitCode);

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
