#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { getRuntimeDbPath, getRuntimeLogDir } from "../lib/domains/runtime/functions/base-paths.js";
import { RunMonitor } from "../lib/domains/observability/classes/RunMonitor.js";
import { selectMonitorRun, renderMonitorCheck, monitorStatePath } from "../lib/domains/observability/functions/run-monitor.js";

const help = `Usage: node tools/monitor-run.mjs [options]

One incremental check by default; repeat the same command to get only new signals.
  --project <dir>    Target project (default: current directory)
  --run <id>         Run under the project's logs/runs (default: latest scheduler run)
  --run-dir <dir>    Explicit telemetry run directory; pins watch mode to this run
  --db <file>        Read-only gate DB (default: project's runtime DB)
  --work-item <id>   Filter one work item; retains unscoped run/errors
  --state <job>      Saved cursor name (default: default); storage managed automatically
  --watch           Poll continuously; idle checks are silent
  --poll-ms <ms>     Watch interval (default: 2000; minimum: 200)
  --limit <n>        Maximum signals per check (default: 40; range: 4–500)
  --stale-ms <ms>    Heartbeat warning threshold (default: 120000)
  --json            One JSON report per check
  --help            Show help

First check starts at the beginning. Backlog remains queued when bounded output
fills; repeat checks to drain it. No raw prompts, context, or indexing progress.
Use a new --state name to replay or maintain an independent observer.
Names are scoped to the selected run/filter; --state does not filter jobs.
`;

async function main() {
  const args = { project: process.cwd(), pollMs: 2000, limit: 40, staleMs: 120000 };
  const values = { "--project": "project", "--run": "run", "--run-dir": "runDir", "--db": "db", "--work-item": "workItemId", "--state": "state", "--poll-ms": "pollMs", "--limit": "limit", "--stale-ms": "staleMs" };
  const argv = process.argv.slice(2);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") { process.stdout.write(help); return; }
    if (arg === "--watch") args.watch = true;
    else if (arg === "--json") args.json = true;
    else if (values[arg]) {
      if (!argv[i + 1] || argv[i + 1].startsWith("--")) throw new Error(`Missing value for ${arg}`);
      args[values[arg]] = argv[++i];
    } else throw new Error(`Unknown option: ${arg}`);
  }
  for (const key of ["pollMs", "limit", "staleMs", "workItemId"]) {
    if (args[key] == null) continue;
    args[key] = Number(args[key]);
    if (!Number.isSafeInteger(args[key]) || args[key] < (key === "pollMs" ? 200 : 1)) throw new Error(`Invalid ${key}`);
  }
  if (args.limit < 4 || args.limit > 500) throw new Error("--limit must be between 4 and 500");
  if (args.run && args.runDir) throw new Error("Use either --run or --run-dir");
  const project = path.resolve(args.project);
  const runDir = args.runDir ? fs.realpathSync(args.runDir) : selectMonitorRun(path.join(getRuntimeLogDir(project), "runs"), args.run);
  const statePath = monitorStatePath({ runDir, workItemId: args.workItemId, name: args.state });
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  const lockPath = `${statePath}.lock`;
  let lock;
  try { lock = fs.openSync(lockPath, "wx", 0o600); }
  catch (error) {
    if (error.code === "EEXIST") throw new Error(`Cursor locked: ${lockPath}. Use another --state for an independent observer. Remove a stale lock only after its process has stopped.`);
    throw error;
  }
  fs.writeFileSync(lock, `${process.pid}\n`);
  const controller = new AbortController();
  const stop = () => controller.abort();
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  try {
    const monitor = new RunMonitor({ runDir, statePath, dbPath: path.resolve(args.db || getRuntimeDbPath(project)), workItemId: args.workItemId ?? null, limit: args.limit, staleMs: args.staleMs });
    let first = true;
    do {
      const report = monitor.check();
      if (first || !args.watch || report.items.length) {
        const output = args.json ? `${JSON.stringify(report)}\n` : renderMonitorCheck(report);
        // Persist only after stdout accepts the report. A crash between output
        // and save may replay that batch, but cannot silently consume it.
        await new Promise((resolve, reject) => process.stdout.write(output, (error) => error ? reject(error) : resolve()));
      }
      monitor.save();
      first = false;
      if (!args.watch || controller.signal.aborted) break;
      await sleep(args.pollMs, undefined, { signal: controller.signal }).catch((error) => { if (error.name !== "AbortError") throw error; });
    } while (!controller.signal.aborted);
  } finally {
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    fs.closeSync(lock);
    fs.unlinkSync(lockPath);
  }
}

process.stdout.on("error", () => { /* write callback reports output failure */ });
main().catch((error) => {
  process.stderr.write(`monitor-run: ${error.message}\n`);
  process.exitCode = 1;
});
