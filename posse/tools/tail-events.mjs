#!/usr/bin/env node

import { getEventsByWorkItemSinceId } from "../lib/domains/queue/functions/index.js";

function parseArgs(argv = []) {
  const out = {
    workItemId: null,
    sinceId: 0,
    pollMs: 1500,
    limit: 200,
    once: false,
  };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === "--work-item" || arg === "--wi") out.workItemId = Number(argv[++i]);
    else if (arg === "--since-id") out.sinceId = Number(argv[++i] || 0);
    else if (arg === "--poll-ms") out.pollMs = Number(argv[++i] || 1500);
    else if (arg === "--limit") out.limit = Number(argv[++i] || 200);
    else if (arg === "--once") out.once = true;
    else if (arg === "--help" || arg === "-h") out.help = true;
  }
  return out;
}

function usage() {
  console.log(`Usage: node tools/tail-events.mjs --work-item <id> [--since-id <n>] [--poll-ms <ms>] [--limit <n>] [--once]

Streams only new events for one work item using an id cursor (id > since-id).
Output: one JSON line per event.
`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  if (args.help || !Number.isFinite(args.workItemId) || args.workItemId <= 0) {
    usage();
    process.exit(args.help ? 0 : 1);
  }

  let cursor = Number.isFinite(args.sinceId) ? args.sinceId : 0;
  const limit = Math.max(1, Math.min(1000, Number.isFinite(args.limit) ? args.limit : 200));
  const pollMs = Math.max(200, Number.isFinite(args.pollMs) ? args.pollMs : 1500);

  for (;;) {
    const rows = getEventsByWorkItemSinceId(args.workItemId, cursor, limit);
    for (const row of rows) {
      console.log(JSON.stringify(row));
      if (row?.id && row.id > cursor) cursor = row.id;
    }
    if (args.once) break;
    await sleep(pollMs);
  }
}

main().catch((err) => {
  console.error(String(err?.stack || err?.message || err));
  process.exit(1);
});
