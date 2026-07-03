// execProjectDbQuery — the project_db_query tool handler.
//
// Ties the per-repo config, statement authorization, and the driver layer
// together, and renders an agent-readable string result (the deterministic-MCP
// server marks a result failed only when it starts with "Error:").
//
// The configured DB password is never returned or surfaced: it lives only on
// the connection object passed to the driver, and any error text is scrubbed of
// it before it leaves this module.

import { capProjectDbPermissions, readProjectDbConnection } from "./config.js";
import { authorizeProjectDbStatement, isReadOnlyGrant } from "./permissions.js";
import { executeProjectDbStatement, DEFAULT_MAX_ROWS } from "./drivers.js";

const MAX_ROWS_CEILING = 1000;
const DEFAULT_MAX_BYTES = 16000;

function clampMaxRows(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_MAX_ROWS;
  return Math.max(1, Math.min(MAX_ROWS_CEILING, Math.floor(n)));
}

function redact(text, secret) {
  const str = String(text || "");
  if (!secret) return str;
  return str.split(secret).join("***");
}

function renderRows(rows, columns) {
  // Stable column order: prefer the driver-reported columns, fall back to keys.
  const cols = columns && columns.length ? columns : (rows[0] ? Object.keys(rows[0]) : []);
  const shaped = rows.map((row) => {
    const out = {};
    for (const c of cols) out[c] = row[c];
    return out;
  });
  return JSON.stringify(shaped, (_k, v) => (typeof v === "bigint" ? Number(v) : v), 2);
}

/**
 * @param {{ query?: string, sql?: string, maxRows?: number, limit?: number }} args
 * @param {{ projectDir?: string|null, capability?: "read"|"write" }} [ctx]
 *   `capability` is the calling job's lane: read-lane jobs (researcher/planner,
 *   or any job without write permission) are capped to the `read` grant no
 *   matter what the operator granted; write-lane jobs use the full grant.
 * @returns {Promise<string>}
 */
export async function execProjectDbQuery(args = {}, { projectDir = null, capability = "write" } = {}) {
  const conn = readProjectDbConnection({ projectDir });
  if (!conn.enabled || !conn.dbType || conn.permissions.length === 0) {
    return "Error: Project DB access is not enabled for this repository.";
  }
  const permissions = capProjectDbPermissions(conn.permissions, capability);
  if (permissions.length === 0) {
    return "Error: Project DB access for this read-capability role requires the 'read' permission, which is not granted.";
  }

  const sql = String(args.query ?? args.sql ?? "").trim();
  if (!sql) return "Error: No SQL query provided (pass `query`).";

  const auth = authorizeProjectDbStatement(sql, permissions);
  if (!auth.ok) return `Error: ${auth.error}`;

  const maxRows = clampMaxRows(args.maxRows ?? args.limit);
  const readOnly = isReadOnlyGrant(permissions);

  let result;
  try {
    result = await executeProjectDbStatement({
      connection: conn,
      statement: auth.statement,
      isRead: auth.isRead,
      readOnly,
      maxRows,
      projectDir,
    });
  } catch (err) {
    const message = redact(err?.message || String(err), conn.password);
    return `Error: project_db_query (${conn.dbType}) failed: ${message}`;
  }

  if (auth.isRead) {
    const body = renderRows(result.rows || [], result.columns || []);
    const header = `project_db_query (${conn.dbType}) — ${result.rowCount} row(s)`
      + (result.truncated ? ` (truncated to ${maxRows}; refine with a WHERE/LIMIT)` : "");
    let out = `${header}\n${body}`;
    if (out.length > DEFAULT_MAX_BYTES) {
      out = `${out.slice(0, DEFAULT_MAX_BYTES)}\n… [output truncated at ${DEFAULT_MAX_BYTES} bytes; narrow the query]`;
    }
    return out;
  }

  // DDL path (CREATE/ALTER): "rows affected" is meaningless for schema changes.
  if (auth.verb === "CREATE" || auth.verb === "ALTER") {
    return `project_db_query (${conn.dbType}) — ${auth.verb}: statement executed`;
  }

  // Write path (UPDATE/INSERT/DELETE).
  const affected = result.affectedRows ?? 0;
  const extra = result.lastInsertRowid != null ? `, lastInsertRowid=${result.lastInsertRowid}`
    : (result.insertId != null && result.insertId !== 0 ? `, insertId=${result.insertId}` : "");
  return `project_db_query (${conn.dbType}) — ${auth.verb}: ${affected} row(s) affected${extra}`;
}
