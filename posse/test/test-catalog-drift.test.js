import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { describe, it } from "node:test";
import { fileURLToPath } from "node:url";

import { ARTIFACT_TYPES } from "../lib/catalog/artifact.js";
import { EVENT_ACTOR_TYPES } from "../lib/catalog/event.js";
import { ATLAS_SCIP_RESTAGE_POLICY_VALUES } from "../lib/catalog/atlas.js";
import {
  JOB_ASSESSOR_CONFIDENCE,
  JOB_ASSESSOR_VERDICTS,
  JOB_ATTEMPT_WORKER_TYPES,
  JOB_MODEL_TIERS,
  JOB_REASONING_EFFORTS,
  JOB_STATUSES,
  JOB_TYPES,
} from "../lib/catalog/job.js";
import {
  WORK_ITEM_GOVERNANCE_TIERS,
  WORK_ITEM_MERGE_STATES,
  WORK_ITEM_MODES,
  WORK_ITEM_PLAN_APPROVAL_STATES,
  WORK_ITEM_PRIORITIES,
  WORK_ITEM_SESSION_RECYCLE_VALUES,
  WORK_ITEM_STATUSES,
} from "../lib/catalog/work-item.js";
import {
  artifactsCreateSql,
  eventsCreateSql,
  jobsCreateSql,
  jobAttemptsCreateSql,
  workItemsCreateSql,
} from "../lib/shared/storage/functions/index.js";
import { getCatalogOptionValues } from "../lib/domains/settings/functions/catalog.js";

const __filename = fileURLToPath(import.meta.url);
const repoDir = path.resolve(path.dirname(__filename), "..");
const libDir = path.join(repoDir, "lib");
const schemaPath = path.join(repoDir, "schema.sql");

function listJsFiles(dir) {
  const files = [];
  const walk = (current) => {
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === "node_modules" || entry.name === ".git") continue;
      const fullPath = path.join(current, entry.name);
      if (entry.isDirectory()) walk(fullPath);
      else if (entry.isFile() && entry.name.endsWith(".js")) files.push(fullPath);
    }
  };
  walk(dir);
  return files;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function createTableBody(sql, tableName) {
  const pattern = new RegExp(
    `CREATE\\s+TABLE(?:\\s+IF\\s+NOT\\s+EXISTS)?\\s+"?${escapeRegExp(tableName)}"?\\s*\\(`,
    "i",
  );
  const match = pattern.exec(sql);
  assert.ok(match, `missing CREATE TABLE for ${tableName}`);
  const openIndex = sql.indexOf("(", match.index);
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < sql.length; i += 1) {
    const ch = sql[i];
    if (inString) {
      if (ch === "'" && sql[i + 1] === "'") {
        i += 1;
      } else if (ch === "'") {
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return sql.slice(openIndex + 1, i);
    }
  }
  assert.fail(`unterminated CREATE TABLE for ${tableName}`);
}

function splitTopLevelCommaList(text) {
  const parts = [];
  let start = 0;
  let depth = 0;
  let inString = false;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'" && text[i + 1] === "'") {
        i += 1;
      } else if (ch === "'") {
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
    } else if (ch === "," && depth === 0) {
      parts.push(text.slice(start, i).trim());
      start = i + 1;
    }
  }
  parts.push(text.slice(start).trim());
  return parts.filter(Boolean);
}

function matchingParenIndex(text, openIndex) {
  let depth = 0;
  let inString = false;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (ch === "'" && text[i + 1] === "'") {
        i += 1;
      } else if (ch === "'") {
        inString = false;
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
    } else if (ch === "(") {
      depth += 1;
    } else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

function inListForColumn(sql, tableName, columnName) {
  const body = createTableBody(sql, tableName);
  const column = splitTopLevelCommaList(body).find((definition) => {
    const trimmed = definition.trim();
    return trimmed.startsWith(`${columnName} `) || trimmed.startsWith(`"${columnName}" `);
  });
  assert.ok(column, `missing ${tableName}.${columnName}`);
  const inMatch = /\bIN\s*\(/i.exec(column);
  assert.ok(inMatch, `missing IN (...) CHECK for ${tableName}.${columnName}`);
  const openIndex = column.indexOf("(", inMatch.index);
  const closeIndex = matchingParenIndex(column, openIndex);
  assert.notEqual(closeIndex, -1, `unterminated IN (...) CHECK for ${tableName}.${columnName}`);
  return [...column.slice(openIndex + 1, closeIndex).matchAll(/'([^']+)'/g)].map((match) => match[1]);
}

const CATALOG_CHECKS = Object.freeze([
  { table: "work_items", column: "priority", values: WORK_ITEM_PRIORITIES },
  { table: "work_items", column: "status", values: WORK_ITEM_STATUSES },
  { table: "work_items", column: "mode", values: WORK_ITEM_MODES },
  { table: "work_items", column: "governance_tier", values: WORK_ITEM_GOVERNANCE_TIERS },
  { table: "work_items", column: "session_recycle", values: WORK_ITEM_SESSION_RECYCLE_VALUES },
  { table: "work_items", column: "merge_state", values: WORK_ITEM_MERGE_STATES },
  { table: "work_items", column: "plan_approval_state", values: WORK_ITEM_PLAN_APPROVAL_STATES },
  { table: "jobs", column: "job_type", values: JOB_TYPES },
  { table: "jobs", column: "status", values: JOB_STATUSES },
  { table: "jobs", column: "priority", values: WORK_ITEM_PRIORITIES },
  { table: "jobs", column: "model_tier", values: JOB_MODEL_TIERS },
  { table: "jobs", column: "reasoning_effort", values: JOB_REASONING_EFFORTS },
  { table: "jobs", column: "assessor_verdict", values: JOB_ASSESSOR_VERDICTS },
  { table: "jobs", column: "assessor_confidence", values: JOB_ASSESSOR_CONFIDENCE },
  { table: "job_attempts", column: "worker_type", values: JOB_ATTEMPT_WORKER_TYPES },
  { table: "job_attempts", column: "reasoning_effort", values: JOB_REASONING_EFFORTS },
  { table: "artifacts", column: "artifact_type", values: ARTIFACT_TYPES },
  { table: "events", column: "actor_type", values: EVENT_ACTOR_TYPES },
]);

const CREATE_SQL_HELPERS = Object.freeze({
  work_items: workItemsCreateSql,
  jobs: jobsCreateSql,
  job_attempts: jobAttemptsCreateSql,
  artifacts: artifactsCreateSql,
  events: eventsCreateSql,
});

describe("catalog drift guards", () => {
  it("keeps shared job-status subsets out of ad hoc literals", () => {
    const ignored = new Set([
      "lib/catalog/job.js",
    ]);
    const patterns = [
      /["']failed["']\s*,\s*["']dead_letter["']/,
      /["']queued["']\s*,\s*["']blocked["']\s*,\s*["']waiting_on_human["']\s*,\s*["']waiting_on_review["']/,
      /["']queued["']\s*,\s*["']leased["']\s*,\s*["']running["']\s*,\s*["']awaiting_assessment["']/,
      /["']succeeded["']\s*,\s*["']failed["']\s*,\s*["']dead_letter["']\s*,\s*["']canceled["']/,
      /status\s+IN\s*\(\s*["']leased["']\s*,\s*["']running["']\s*,\s*["']awaiting_assessment["']\s*,\s*["']waiting_on_human["']\s*,\s*["']waiting_on_review["']\s*\)/,
    ];
    const failures = [];
    for (const file of listJsFiles(libDir)) {
      const rel = path.relative(repoDir, file).replace(/\\/g, "/");
      if (ignored.has(rel)) continue;
      const text = fs.readFileSync(file, "utf8");
      if (patterns.some((pattern) => pattern.test(text))) failures.push(rel);
    }
    assert.deepEqual(failures, []);
  });

  it("keeps fresh schema CHECK enums aligned with catalog arrays", () => {
    const schema = fs.readFileSync(schemaPath, "utf8");
    for (const check of CATALOG_CHECKS) {
      assert.deepEqual(
        inListForColumn(schema, check.table, check.column),
        [...check.values],
        `${check.table}.${check.column} drifted from catalog`,
      );
    }
  });

  it("keeps migration create-SQL helpers aligned with catalog arrays", () => {
    for (const check of CATALOG_CHECKS) {
      const createSql = CREATE_SQL_HELPERS[check.table];
      if (!createSql) continue;
      assert.deepEqual(
        inListForColumn(createSql(check.table), check.table, check.column),
        [...check.values],
        `${check.table}.${check.column} helper drifted from catalog`,
      );
    }
  });

  it("keeps SCIP restage policy settings options aligned with the ATLAS catalog", () => {
    assert.deepEqual(
      [...getCatalogOptionValues("atlas_scip_restage_policy")],
      [...ATLAS_SCIP_RESTAGE_POLICY_VALUES],
    );
  });
});
