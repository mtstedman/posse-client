#!/usr/bin/env node
// Receipt-drain probe for the release reconciler. It runs as the owner
// account (root must not open the owner's WAL database: a root-created -shm
// would lock the owner out) and prints {"unfinished": N}:
//
//   node agent-release-receipts.js /var/lib/posse-agent/automation.db

import fs from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { fileURLToPath } from "node:url";

import { REGISTERED_AGENT_TERMINAL_STATUSES } from "../../../catalog/registered-agent.js";

/** Registered receipts still running in the owner; a missing store has none. */
export function countUnfinishedReceipts(filename) {
  if (!fs.existsSync(filename)) return 0;
  const db = new DatabaseSync(filename, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='registered_agent_receipts'").get();
    if (!table) return 0;
    const marks = REGISTERED_AGENT_TERMINAL_STATUSES.map(() => "?").join(",");
    const row = db.prepare(`SELECT count(*) AS unfinished FROM registered_agent_receipts
      WHERE coalesce(json_extract(value,'$.status'),'') NOT IN (${marks})`).get(...REGISTERED_AGENT_TERMINAL_STATUSES);
    return Number(row.unfinished);
  } finally { db.close(); }
}

if (process.argv[1] && fs.realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (!process.argv[2]) throw new Error("automation database path is required");
    process.stdout.write(`${JSON.stringify({ unfinished: countUnfinishedReceipts(process.argv[2]) })}\n`);
  } catch (error) {
    process.stderr.write(`receipt probe failed: ${String(error?.message || error).slice(0, 300)}\n`);
    process.exitCode = 1;
  }
}
