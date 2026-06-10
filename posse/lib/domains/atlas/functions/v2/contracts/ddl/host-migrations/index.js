// @ts-check
//
// Host-schema migrations needed before ATLAS v2 boots. These touch posse's
// own DB (jobs, events) — they do NOT touch the ATLAS v2 ledger.
//
// Workstream E (pipeline integration) owns wiring these into posse's
// bootstrap. The mechanism (in-place runner, embedded into schema.sql,
// or manual one-time fixup) is a separate decision; this module just
// exposes the SQL as ordered strings.
//
// Order is strict — 001 before 002 before 003. The file naming convention enforces
// it lexically.

import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import path from "path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function load(name) {
  return readFileSync(path.join(__dirname, name), "utf-8");
}

/**
 * @typedef {Object} HostMigration
 * @property {string} id                      Sortable identifier; matches filename prefix.
 * @property {string} description
 * @property {string} sql                     Full SQL script, includes BEGIN/COMMIT.
 */

/** @type {readonly HostMigration[]} */
export const HOST_MIGRATIONS = Object.freeze([
  {
    id: "001-add-atlas-warm-job-type",
    description: "Add 'atlas_warm' to jobs.job_type CHECK constraint.",
    sql: load("001-add-atlas-warm-job-type.sql"),
  },
  {
    id: "002-add-atlas-actor-type",
    description: "Add 'atlas' to events.actor_type CHECK constraint.",
    sql: load("002-add-atlas-actor-type.sql"),
  },
  {
    id: "003-add-run-insights-promotion-columns",
    description: "Add run_insights promotion bookkeeping columns and lookup indexes.",
    sql: load("003-add-run-insights-promotion-columns.sql"),
  },
]);
