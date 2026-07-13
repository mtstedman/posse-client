#!/usr/bin/env node

import { BINARY_NAMES } from "../lib/catalog/binary.js";
import { nativeBinaries } from "../lib/shared/tools/classes/BinaryManager.js";

const requested = parseArgs(process.argv.slice(2));
let failed = false;

const results = await Promise.all(requested.map(async (name) => ({
  name,
  result: await nativeBinaries.ensureAvailable(name, { refresh: true }),
})));
for (const { name, result } of results) {
  if (!result.available) {
    failed = true;
    console.error(`[pull-native] ${name}: unavailable (${result.reason || "unknown"})`);
    continue;
  }
  console.log(
    `[pull-native] ${name}: ${result.downloaded ? "downloaded" : "ready"}`
    + ` ${result.version || ""} (${result.source || "cache"}) ${result.path}`,
  );
}

await nativeBinaries.disposeAll();
if (failed) process.exitCode = 1;

function parseArgs(argv) {
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(`Usage: npm run pull:native -- [atlas|git|ml|remote|vector ...]

Pulls all server-issued Posse native binaries by default. Pass one or more
binary names to pull only those artifacts.`);
    process.exit(0);
  }
  const names = argv.length > 0 ? argv : [...BINARY_NAMES];
  const unknown = names.filter((name) => !BINARY_NAMES.includes(name));
  if (unknown.length > 0) {
    console.error(`[pull-native] unknown binary: ${unknown.join(", ")}`);
    process.exit(1);
  }
  return [...new Set(names)];
}
