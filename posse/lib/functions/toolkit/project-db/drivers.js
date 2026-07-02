// Project-DB driver layer: one tiny adapter per engine, behind a uniform
// execute() that returns { columns, rows, rowCount, affectedRows, truncated }.
//
// sqlite  -> better-sqlite3 (a hard dependency; always available)
// postgres -> pg            (optional dependency, lazy-imported)
// mysql    -> mysql2        (optional dependency, lazy-imported)
//
// The read-row cap is enforced here so a stray `SELECT *` over a huge table
// can't flood the agent's context. Read-only grants additionally open/scope the
// engine read-only (defense-in-depth behind permissions.js).

import path from "path";
import Database from "better-sqlite3";

export const DEFAULT_MAX_ROWS = 200;

/** Lazy-import an optional driver, with an actionable message if it's absent. */
async function loadOptionalDriver(moduleName) {
  try {
    return await import(moduleName);
  } catch (err) {
    if (err && err.code === "ERR_MODULE_NOT_FOUND") {
      throw new Error(
        `The '${moduleName}' package is not installed. It ships as an optional ` +
        `dependency and is installed by Posse's boot dependency sync; or install ` +
        `it manually with: npm install ${moduleName}`,
      );
    }
    throw err;
  }
}

function resolveSqlitePath(database, projectDir) {
  const raw = String(database || "").trim();
  if (!raw) throw new Error("sqlite project DB requires a database file path.");
  return path.isAbsolute(raw) ? raw : path.resolve(projectDir || process.cwd(), raw);
}

async function executeSqlite({ connection, statement, isRead, readOnly, maxRows, projectDir }) {
  const file = resolveSqlitePath(connection.database, projectDir);
  const db = new Database(file, { readonly: readOnly, fileMustExist: true });
  try {
    db.pragma("busy_timeout = 5000");
    const stmt = db.prepare(statement);
    if (isRead && stmt.reader) {
      const rows = [];
      let truncated = false;
      for (const row of stmt.iterate()) {
        if (rows.length >= maxRows) { truncated = true; break; }
        rows.push(row);
      }
      const columns = stmt.columns().map((c) => c.name);
      return { columns, rows, rowCount: rows.length, truncated };
    }
    const info = stmt.run();
    return {
      columns: [],
      rows: [],
      rowCount: 0,
      affectedRows: info.changes,
      lastInsertRowid: typeof info.lastInsertRowid === "bigint" ? Number(info.lastInsertRowid) : info.lastInsertRowid,
      truncated: false,
    };
  } finally {
    try { db.close(); } catch { /* best effort */ }
  }
}

async function executePostgres({ connection, statement, isRead, readOnly, maxRows, loadDriver }) {
  const pg = await loadDriver("pg");
  const Client = pg.Client || pg.default?.Client;
  const client = new Client({
    host: connection.host || undefined,
    port: connection.port || undefined,
    database: connection.database || undefined,
    user: connection.username || undefined,
    password: connection.password || undefined,
  });
  await client.connect();
  try {
    if (readOnly) {
      await client.query("SET SESSION CHARACTERISTICS AS TRANSACTION READ ONLY");
    }
    // Force the EXTENDED query protocol (Parse/Bind/Execute) by passing a config
    // object with queryMode. A bare string uses the SIMPLE protocol, which runs
    // every ';'-separated command in the string — so a parser miss in the
    // single-statement guard would let stacked SQL through. Under the extended
    // protocol PostgreSQL rejects "multiple commands in a prepared statement",
    // making single-statement enforcement authoritative at the wire level.
    const result = await client.query({ text: statement, queryMode: "extended" });
    if (isRead) {
      const allRows = Array.isArray(result.rows) ? result.rows : [];
      const rows = allRows.slice(0, maxRows);
      const columns = (result.fields || []).map((f) => f.name);
      return { columns, rows, rowCount: rows.length, truncated: allRows.length > rows.length, command: result.command };
    }
    return { columns: [], rows: [], rowCount: 0, affectedRows: result.rowCount || 0, truncated: false, command: result.command };
  } finally {
    try { await client.end(); } catch { /* best effort */ }
  }
}

async function executeMysql({ connection, statement, isRead, readOnly, maxRows, loadDriver }) {
  const mysql = await loadDriver("mysql2/promise");
  const create = mysql.createConnection || mysql.default?.createConnection;
  const conn = await create({
    host: connection.host || undefined,
    port: connection.port || undefined,
    database: connection.database || undefined,
    user: connection.username || undefined,
    password: connection.password || undefined,
  });
  try {
    if (readOnly) {
      await conn.query("SET SESSION TRANSACTION READ ONLY");
    }
    const [result, fields] = await conn.query(statement);
    if (isRead && Array.isArray(result)) {
      const rows = result.slice(0, maxRows);
      const columns = (fields || []).map((f) => f.name);
      return { columns, rows, rowCount: rows.length, truncated: result.length > rows.length };
    }
    // Write path: mysql2 returns a ResultSetHeader.
    return { columns: [], rows: [], rowCount: 0, affectedRows: result?.affectedRows || 0, insertId: result?.insertId, truncated: false };
  } finally {
    try { await conn.end(); } catch { /* best effort */ }
  }
}

/**
 * Execute an already-authorized statement against the configured engine.
 * @param {{
 *   connection: { dbType: string, host, port, database, username, password },
 *   statement: string,
 *   isRead: boolean,
 *   readOnly: boolean,
 *   maxRows?: number,
 *   projectDir?: string|null,
 *   loadDriver?: (moduleName: string) => Promise<any>,
 * }} input
 */
export async function executeProjectDbStatement({
  connection,
  statement,
  isRead,
  readOnly,
  maxRows = DEFAULT_MAX_ROWS,
  projectDir = null,
  loadDriver = loadOptionalDriver,
}) {
  const dbType = connection?.dbType;
  const args = { connection, statement, isRead, readOnly, maxRows, projectDir, loadDriver };
  switch (dbType) {
    case "sqlite": return await executeSqlite(args);
    case "postgres": return await executePostgres(args);
    case "mysql": return await executeMysql(args);
    default: throw new Error(`Unsupported project DB type: ${dbType || "(unset)"}`);
  }
}
