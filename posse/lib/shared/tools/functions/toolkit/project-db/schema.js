// Agent-facing schema for project_db_query, rendered for one job.
//
// The description names exactly the statements the job's effective scopes
// allow and nothing else: a read job is told about reads, a write job about
// what it may write. It never describes scopes the job does not hold.

import { TOOL_PROJECT_DB_QUERY } from "../../../../../catalog/native-tools.js";
import { normalizePermissions } from "./config.js";

const SCOPE_STATEMENTS = Object.freeze({
  read: "SELECT and read-only inspection statements (PRAGMA/EXPLAIN/SHOW/DESCRIBE)",
  write: "UPDATE, INSERT, DELETE, CREATE, and ALTER statements",
});

/** One-line contract summary for exactly the job's effective scopes. */
export function projectDbQuerySummaryForPermissions(permissions = []) {
  const allowed = normalizePermissions(permissions).map((perm) => SCOPE_STATEMENTS[perm]);
  const base = "Run a single SQL statement against the project's configured application database";
  return allowed.length === 0 ? `${base}.` : `${base}: ${allowed.join(", and ")}.`;
}

/**
 * @param {string[]|string} permissions - the job's effective scopes (operator
 *   grant already capped to the job's capability lane).
 * @returns the tool schema with a description for exactly those scopes; the
 *   scope-neutral base schema when no scope is known.
 */
export function projectDbQuerySchemaForPermissions(permissions = []) {
  const allowed = normalizePermissions(permissions).map((perm) => SCOPE_STATEMENTS[perm]);
  if (allowed.length === 0) return TOOL_PROJECT_DB_QUERY;
  return {
    ...TOOL_PROJECT_DB_QUERY,
    description:
      "Run a single SQL statement against this project's configured application database " +
      `(sqlite/postgres/mysql). You may run ${allowed.join(", and ")}. ` +
      "One statement per call; read results are row- and byte-capped.",
  };
}
