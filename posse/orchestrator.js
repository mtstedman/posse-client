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
const recordFatalCrash = (kind, err) => {
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
process.on("uncaughtException", (err) => recordFatalCrash("uncaughtException", err));
process.on("unhandledRejection", (reason) => recordFatalCrash("unhandledRejection", reason));

const { runOrchestratorCli } = await import("./lib/domains/cli/functions/orchestrator-app.js");
await runOrchestratorCli();
