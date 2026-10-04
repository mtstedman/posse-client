// Short-lived, addon-free repair worker for Posse's own npm tree. Keeping this
// in a separate process is important after `posse update`: it loads the newly
// checked-out package manifest and dependency engine, and exits before any
// SQLite-backed application code can pin better_sqlite3.node on Windows.

import path from "node:path";
import { fileURLToPath } from "node:url";

import { repairPosseNodeTree } from "../../system/functions/posse-node-repair.js";

const POSSE_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const jsonMode = process.env.POSSE_MAINTENANCE_JSON === "1";

let result;
try {
  result = await repairPosseNodeTree({
    posseRoot: POSSE_ROOT,
    dryRun: process.env.POSSE_MAINTENANCE_DRY_RUN === "1",
    adoptNodeInstall: process.env.POSSE_MAINTENANCE_ADOPT_NODE === "1",
    // The installers set this right after their own --ignore-scripts npm step.
    runInstallScripts: process.env.POSSE_MAINTENANCE_INSTALL_SCRIPTS === "1",
    timeoutMs: 30 * 60 * 1000,
    onProgress: jsonMode
      ? null
      : (message) => process.stderr.write(`  [bootstrap] ${message}\n`),
  });
} catch (error) {
  result = {
    ok: false,
    status: "failed",
    label: "posse npm",
    message: error?.message || String(error),
  };
}

process.stdout.write(`${JSON.stringify(result)}\n`);
// The installers gate on the exit status alone: a failed repair must not read
// as success (setup reported a verified SQLite runtime with better-sqlite3
// missing). The maintenance parent parses the JSON either way.
if (result?.ok === false) process.exitCode = 1;
