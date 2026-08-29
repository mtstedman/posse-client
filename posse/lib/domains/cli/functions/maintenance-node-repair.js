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
