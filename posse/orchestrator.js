#!/usr/bin/env node

import fs from "node:fs";
import path from "node:path";

import { installCliWarningFilter } from "./lib/domains/cli/functions/warnings.js";
import { scrubSecrets } from "./lib/shared/telemetry/classes/logging/secret-scrub.js";

installCliWarningFilter();

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
  const line = scrubSecrets(`\n[${new Date().toISOString()}] FATAL ${kind}${code}\n${stack}\n`);
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
// not just known console.log sites.
for (const stream of [process.stdout, process.stderr]) {
  try { stream.on("error", (err) => { if (isBrokenPipe(err)) noteBrokenPipeOnce("stream"); else recordFatalCrash("stream", err); }); }
  catch { /* best effort */ }
}
process.on("uncaughtException", (err) => recordFatalCrash("uncaughtException", err));
process.on("unhandledRejection", (reason) => recordFatalCrash("unhandledRejection", reason));

const { runOrchestratorCli } = await import("./lib/domains/cli/functions/orchestrator-app.js");
await runOrchestratorCli();
