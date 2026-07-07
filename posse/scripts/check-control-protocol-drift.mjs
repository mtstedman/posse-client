#!/usr/bin/env node
// Fails if docs/control-protocol.md differs between the three Posse repos.
// The protocol doc is the canonical wire contract between the phone client,
// the relay, and the bridge — drift silently breaks the system.
//
// Usage: node scripts/check-control-protocol-drift.mjs
//
// Locations checked (relative to the repo root that contains this script):
//   ./docs/control-protocol.md              (tools/posse — this repo)
//   ../../posse/posse-remote/docs/control-protocol.md
//   ../../posse/posse-remote-control/docs/control-protocol.md
// Falls back to the legacy sibling layout without the intermediate posse/
// directory when that is the checked-out workspace shape.
//
// Override locations via POSSE_PROTOCOL_DOC_PATHS=path1,path2,...

import { readFileSync, existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..");

const overrides = process.env.POSSE_PROTOCOL_DOC_PATHS;
const localProtocolDoc = resolve(repoRoot, "docs/control-protocol.md");
const defaultSiblingLayouts = [
  [
    resolve(repoRoot, "../../posse/posse-remote/docs/control-protocol.md"),
    resolve(repoRoot, "../../posse/posse-remote-control/docs/control-protocol.md"),
  ],
  [
    resolve(repoRoot, "../../posse-remote/docs/control-protocol.md"),
    resolve(repoRoot, "../../posse-remote-control/docs/control-protocol.md"),
  ],
];
const defaultSiblingDocs =
  defaultSiblingLayouts.find((paths) => paths.every((target) => existsSync(target))) ??
  defaultSiblingLayouts[0];
const targets = overrides
  ? overrides.split(",").map((value) => value.trim()).filter(Boolean)
  : [localProtocolDoc, ...defaultSiblingDocs];

function normalizeProtocolDoc(text) {
  return String(text || "")
    .replace(/^\uFEFF/, "")
    .replace(/\r\n?/g, "\n");
}

if (targets.length < 2) {
  console.error("[check-control-protocol-drift] At least 2 doc paths are required.");
  process.exit(1);
}

const missing = targets.filter((path) => !existsSync(path));
if (missing.length > 0) {
  console.error("[check-control-protocol-drift] Missing protocol doc target(s):");
  for (const path of missing) console.error(`  ${path}`);
  console.error("\nAll protocol doc copies must be checked out or POSSE_PROTOCOL_DOC_PATHS must point to the copies to compare.");
  process.exit(1);
}

const reference = normalizeProtocolDoc(readFileSync(targets[0], "utf8"));
let drifted = false;
for (const path of targets.slice(1)) {
  const text = normalizeProtocolDoc(readFileSync(path, "utf8"));
  if (text !== reference) {
    drifted = true;
    console.error(
      `[check-control-protocol-drift] DRIFT: ${path} differs from ${targets[0]}`,
    );
  }
}

if (drifted) {
  console.error("\nThe protocol doc is the canonical wire contract. All copies MUST be identical.");
  console.error("Copy the authoritative version with:");
  console.error(`  cp "${targets[0]}" <each-other-path>`);
  process.exit(1);
}

console.log(
  `[check-control-protocol-drift] OK — ${targets.length} doc copies identical.`,
);
