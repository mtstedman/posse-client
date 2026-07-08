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
const TABLE_SOURCE_KEYWORDS = new Set(["FROM", "JOIN", "UPDATE", "INTO"]);
const TABLE_DDL_KEYWORDS = new Set(["TABLE"]);
const CLAUSE_BOUNDARY_KEYWORDS = new Set([
  "WHERE", "GROUP", "ORDER", "HAVING", "LIMIT", "OFFSET", "RETURNING", "SET",
  "VALUES", "ON", "USING", "UNION", "EXCEPT", "INTERSECT",
]);

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

function sqlIdentifierTokens(sql) {
  const tokens = [];
  const text = String(sql || "");
  let i = 0;
  while (i < text.length) {
    const ch = text[i];
    if (/\s/.test(ch)) {
      i += 1;
      continue;
    }
    if (ch === "-" && text[i + 1] === "-") {
      i += 2;
      while (i < text.length && text[i] !== "\n") i += 1;
      continue;
    }
    if (ch === "/" && text[i + 1] === "*") {
      i += 2;
      while (i < text.length && !(text[i] === "*" && text[i + 1] === "/")) i += 1;
      i += 2;
      continue;
    }
    if (ch === "'") {
      i += 1;
      while (i < text.length) {
        if (text[i] === "'" && text[i + 1] === "'") {
          i += 2;
          continue;
        }
        if (text[i] === "'") {
          i += 1;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === '"' || ch === "`") {
      const quote = ch;
      let value = "";
      i += 1;
      while (i < text.length) {
        if (text[i] === quote && text[i + 1] === quote) {
          value += quote;
          i += 2;
          continue;
        }
        if (text[i] === quote) {
          i += 1;
          break;
        }
        value += text[i];
        i += 1;
      }
      if (value) tokens.push({ type: "ident", value });
      continue;
    }
    if (ch === "[") {
      let value = "";
      i += 1;
      while (i < text.length && text[i] !== "]") {
        value += text[i];
        i += 1;
      }
      if (text[i] === "]") i += 1;
      if (value) tokens.push({ type: "ident", value });
      continue;
    }
    if (/[A-Za-z_]/.test(ch)) {
      let value = ch;
      i += 1;
      while (i < text.length && /[A-Za-z0-9_$]/.test(text[i])) {
        value += text[i];
        i += 1;
      }
      tokens.push({ type: "ident", value });
      continue;
    }
    if (".(),;".includes(ch)) {
      tokens.push({ type: ch, value: ch });
    }
    i += 1;
  }
  return tokens;
}

function upperToken(token) {
  return String(token?.value || "").toUpperCase();
}

function readQualifiedIdentifier(tokens, startIndex) {
  let i = startIndex;
  while (upperToken(tokens[i]) === "ONLY") i += 1;
  if (tokens[i]?.type === "(") return null;
  const parts = [];
  if (tokens[i]?.type !== "ident") return null;
  parts.push(tokens[i].value);
  i += 1;
  while (tokens[i]?.type === "." && tokens[i + 1]?.type === "ident") {
    parts.push(tokens[i + 1].value);
    i += 2;
  }
  const value = parts.join(".");
  if (!value || CLAUSE_BOUNDARY_KEYWORDS.has(value.toUpperCase())) return null;
  return { value, nextIndex: i };
}

function skipIfTableOptions(tokens, index) {
  let i = index;
  if (upperToken(tokens[i]) === "IF") {
    i += 1;
    if (upperToken(tokens[i]) === "NOT") i += 1;
    if (upperToken(tokens[i]) === "EXISTS") i += 1;
  }
  return i;
}

export function extractProjectDbTableNames(sql) {
  const tokens = sqlIdentifierTokens(sql);
  const tables = new Set();
  for (let i = 0; i < tokens.length; i += 1) {
    const upper = upperToken(tokens[i]);
    if (TABLE_SOURCE_KEYWORDS.has(upper)) {
      const found = readQualifiedIdentifier(tokens, i + 1);
      if (found) {
        tables.add(found.value);
        i = Math.max(i, found.nextIndex - 1);
      }
      continue;
    }
    if (TABLE_DDL_KEYWORDS.has(upper) && ["CREATE", "ALTER", "DROP", "TRUNCATE"].includes(upperToken(tokens[i - 1]))) {
      const found = readQualifiedIdentifier(tokens, skipIfTableOptions(tokens, i + 1));
      if (found) {
        tables.add(found.value);
        i = Math.max(i, found.nextIndex - 1);
      }
    }
  }
  return [...tables].slice(0, 12);
}

function tableSuffix(tables = []) {
  if (!Array.isArray(tables) || tables.length === 0) return "";
  return ` [tables=${tables.join(",")}]`;
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
  const tables = extractProjectDbTableNames(auth.statement);

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
      + tableSuffix(tables)
      + (result.truncated ? ` (truncated to ${maxRows}; refine with a WHERE/LIMIT)` : "");
    let out = `${header}\n${body}`;
    if (out.length > DEFAULT_MAX_BYTES) {
      out = `${out.slice(0, DEFAULT_MAX_BYTES)}\n… [output truncated at ${DEFAULT_MAX_BYTES} bytes; narrow the query]`;
    }
    return out;
  }

  // DDL path (CREATE/ALTER): "rows affected" is meaningless for schema changes.
  if (auth.verb === "CREATE" || auth.verb === "ALTER") {
    return `project_db_query (${conn.dbType}) — ${auth.verb}: statement executed${tableSuffix(tables)}`;
  }

  // Write path (UPDATE/INSERT/DELETE).
  const affected = result.affectedRows ?? 0;
  const extra = result.lastInsertRowid != null ? `, lastInsertRowid=${result.lastInsertRowid}`
    : (result.insertId != null && result.insertId !== 0 ? `, insertId=${result.insertId}` : "");
  return `project_db_query (${conn.dbType}) — ${auth.verb}: ${affected} row(s) affected${extra}${tableSuffix(tables)}`;
}
