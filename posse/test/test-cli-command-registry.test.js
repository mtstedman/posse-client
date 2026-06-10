import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";
import {
  COMMAND_DEFINITIONS,
  getCommandDefinition,
  requiresProviderForCommand,
  requiresWritableArtifactsForCommand,
  shouldRefreshContextAfterCommand,
} from "../lib/domains/cli/functions/command-registry.js";
import { createStatusCommands, parseStatusOptions } from "../lib/domains/cli/functions/status-command.js";
import { createMaintenanceCommands } from "../lib/domains/cli/functions/maintenance-commands.js";
import { cmdDoctor } from "../lib/domains/cli/functions/doctor-command.js";
import { getCommandPositionalArgs, parseConcurrency, parseStallTimeout } from "../lib/domains/cli/functions/flags.js";
import { buildColors, colorsEnabled } from "../lib/shared/format/functions/colors.js";
import { acquireSchedulerLock, createJob, createWorkItem, listJobsByWorkItem, logEvent, releaseSchedulerLock, updateJobStatus, updateWorkItemStatus } from "../lib/domains/queue/functions/index.js";

describe("CLI command registry", () => {
  it("keeps report commands out of writable/provider bootstrap", () => {
    for (const command of ["timeline", "cost", "prompts", "atlas", "atlas-v2"]) {
      assert.equal(getCommandDefinition(command).readOnly, true, command);
      assert.equal(requiresWritableArtifactsForCommand(command), false, command);
      assert.equal(requiresProviderForCommand(command), false, command);
    }
    assert.equal(requiresWritableArtifactsForCommand("definitely-unknown"), false);
    assert.equal(requiresProviderForCommand("run"), true);
  });

  it("keeps maintenance commands out of artifact/project-map bootstrap", () => {
    for (const command of ["doctor", "prune", "purge", "cleanup", "clear"]) {
      assert.equal(requiresWritableArtifactsForCommand(command), false, command);
      assert.equal(requiresProviderForCommand(command), false, command);
      assert.equal(shouldRefreshContextAfterCommand(command), false, command);
    }
  });

  it("runs dependency doctor in repair mode without a command timeout by default", async () => {
    const calls = [];
    const lines = [];
    const result = await cmdDoctor({
      projectDir: process.cwd(),
      argv: [],
      colors: new Proxy({}, { get: () => "" }),
      log: (line) => lines.push(line),
      runDoctor: async (input) => {
        calls.push(input);
        return {
          ok: true,
          dry_run: false,
          counts: { checked: 1, installed: 1, dry_run: 0, failed: 0, ready: 0 },
          doctor: {
            mode: "repair",
            summary: "installed 1",
            repaired: [{ label: "repo python", status: "installed", message: "python requirements installed" }],
            pending: [],
            failed: [],
            ready: [],
          },
        };
      },
    });

    assert.equal(result.ok, true);
    assert.equal(calls.length, 1);
    assert.equal(Object.hasOwn(calls[0], "timeoutMs"), false);
    assert.equal(calls[0].dryRun, false);
    assert.ok(lines.some((line) => line.includes("timeout: none")));
  });

  it("does not resolve the merge target for a canceled clear", async () => withTempRuntimeDb(async () => {
    let targetBranchReads = 0;
    const commands = createMaintenanceCommands({
      projectDir: process.cwd(),
      getTargetBranch: () => {
        targetBranchReads += 1;
        throw new Error("target branch should not be read");
      },
      C: new Proxy({}, { get: () => "" }),
      ask: async () => "n",
      cleanupWiBranch: () => true,
      gitBranchExists: () => false,
      gitWorktreePathsForBranch: () => [],
      gitWorktreeRemove: () => true,
    });

    await commands.clear();

    assert.equal(targetBranchReads, 0);
  }));

  it("refuses cleanup while the scheduler is live before resolving target branch", async () => withTempRuntimeDb(async () => {
    const ownerId = "cleanup-live-test";
    assert.equal(acquireSchedulerLock("main", ownerId, 60), true);
    const previousExitCode = process.exitCode;
    let targetBranchReads = 0;
    const commands = createMaintenanceCommands({
      projectDir: process.cwd(),
      getTargetBranch: () => {
        targetBranchReads += 1;
        throw new Error("target branch should not be read");
      },
      C: new Proxy({}, { get: () => "" }),
      ask: async () => {
        throw new Error("cleanup should refuse before prompting");
      },
      cleanupWiBranch: () => true,
      gitBranchExists: () => false,
      gitWorktreePathsForBranch: () => [],
      gitWorktreeRemove: () => true,
    });

    try {
      await commands.cleanup();
      assert.equal(targetBranchReads, 0);
      assert.equal(process.exitCode, 1);
    } finally {
      releaseSchedulerLock("main", ownerId);
      process.exitCode = previousExitCode;
    }
  }));

  it("normalizes missing CLI commands to help without an undefined registry alias", () => {
    assert.equal(getCommandDefinition(undefined).name, "help");
    assert.equal(getCommandDefinition("").name, "help");
    assert.equal(getCommandDefinition("--help").name, "help");

    const help = COMMAND_DEFINITIONS.find((command) => command.name === "help");
    assert.ok(help);
    assert.deepEqual(help.aliases, ["--help"]);
  });

  it("bounds status details and supports active JSON output", () => withTempRuntimeDb(() => {
    assert.deepEqual(parseStatusOptions(["--active", "--json", "--limit", "all"]), {
      active: true,
      json: true,
      limit: null,
      limitExplicit: true,
    });

    for (let i = 1; i <= 30; i += 1) {
      const wi = createWorkItem(`Status item ${i}`, `status detail ${i}`);
      const job = createJob({ work_item_id: wi.id, job_type: "dev", title: `Status job ${i}` });
      if (i <= 28) {
        updateJobStatus(job.id, "succeeded");
        updateWorkItemStatus(wi.id, "complete");
      }
      if (i === 29) updateWorkItemStatus(wi.id, "running");
    }

    const C0 = new Proxy({}, { get: () => "" });
    const statusCommands = createStatusCommands({ targetBranch: "main", C: C0 });
    const captureLog = (fn) => {
      const originalLog = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(" "));
      try {
        fn();
      } finally {
        console.log = originalLog;
      }
      return lines.join("\n");
    };

    const human = captureLog(() => statusCommands.status(["--limit", "5"]));
    assert.match(human, /Showing 5 of 30 newest work items/);
    assert.match(human, /WI#30/);
    assert.doesNotMatch(human, /WI#1(?!\d)/);
    assert.match(human, /Use --limit all to show everything/);

    const json = captureLog(() => statusCommands.status(["--active", "--json", "--limit", "all"]));
    const parsed = JSON.parse(json);
    assert.equal(parsed.filter.active, true);
    assert.equal(parsed.filter.limit, null);
    assert.equal(parsed.work_items.total, 2);
    assert.equal(parsed.work_items.shown, 2);
    assert.deepEqual(parsed.work_items.items.map(item => item.status).sort(), ["queued", "running"]);
  }));

  it("honors CLI color and positional parsing conventions", () => {
    assert.equal(colorsEnabled({ env: {}, stream: { isTTY: false } }), false);
    assert.equal(colorsEnabled({ env: { NO_COLOR: "1" }, stream: { isTTY: true } }), false);
    assert.equal(colorsEnabled({ env: { FORCE_COLOR: "1", NO_COLOR: "1" }, stream: { isTTY: false } }), true);
    assert.equal(colorsEnabled({ env: { FORCE_COLOR: "0" }, stream: { isTTY: true } }), false);
    assert.equal(buildColors({ env: {}, stream: { isTTY: false } }).red, "");
    assert.equal(buildColors({ env: { FORCE_COLOR: "1" }, stream: { isTTY: false } }).red, "\x1b[31m");

    assert.deepEqual(
      getCommandPositionalArgs(["--mode", "image", "--files=src/a.js", "--", "-literal", "--flag", "path with spaces"]),
      ["-literal", "--flag", "path with spaces"],
    );
    assert.deepEqual(
      getCommandPositionalArgs(["--mode", "build", "normal text", "--tier", "production"]),
      ["normal text"],
    );
  });

  it("validates --stall-timeout as a positive integer", () => {
    assert.equal(parseStallTimeout(["node", "orchestrator.js", "run", "--stall-timeout", "45"]), 45);
    assert.equal(parseStallTimeout(["node", "orchestrator.js", "run", "--stall-timeout=90"]), 90);
    assert.throws(
      () => parseStallTimeout(["node", "orchestrator.js", "run", "--stall-timeout", "0"]),
      /positive integer/,
    );
    assert.throws(
      () => parseStallTimeout(["node", "orchestrator.js", "run", "--stall-timeout", "1.5"]),
      /positive integer/,
    );
    assert.throws(
      () => parseStallTimeout(["node", "orchestrator.js", "run", "--stall-timeout"]),
      /positive integer/,
    );
  });

  it("validates --concurrency as a safe positive integer", () => {
    assert.equal(parseConcurrency(["node", "orchestrator.js", "run", "--concurrency", "4"]), 4);
    assert.equal(parseConcurrency(["node", "orchestrator.js", "run", "--concurrency=5"]), 5);
    assert.throws(
      () => parseConcurrency(["node", "orchestrator.js", "run", "--concurrency", "0"]),
      /positive integer/,
    );
    assert.throws(
      () => parseConcurrency(["node", "orchestrator.js", "run", "--concurrency", "9007199254740993"]),
      /positive integer/,
    );
  });
});
