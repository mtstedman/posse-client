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
import { fork } from "node:child_process";
import { TEST_SUBPROCESS_ENV_KEYS } from "../../../../../catalog/process.js";
import { filterProcessEnv } from "../../../../platform/functions/process-env.js";

export const DEFAULT_MAX_ROWS = 200;
const DEFAULT_SQLITE_TIMEOUT_MS = 30_000;

function boundedRemoteReadStatement(statement, maxRows) {
  const sql = String(statement || "").trim().replace(/;\s*$/, "");
  if (!/^(?:SELECT|WITH|VALUES|TABLE)\b/i.test(sql)) return sql;
  return `SELECT * FROM (${sql}) AS posse_bounded_query LIMIT ${Math.max(1, maxRows + 1)}`;
}

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

async function executeSqlite({ connection, statement, parameters, isRead, readOnly, maxRows, projectDir, signal, timeoutMs }) {
  signal?.throwIfAborted();
  const file = resolveSqlitePath(connection.database, projectDir);
  const limitMs = Math.max(1, Math.min(DEFAULT_SQLITE_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_SQLITE_TIMEOUT_MS));
  // A native sqlite3_step may never return to V8, so terminating a JS worker
  // thread is insufficient. A one-shot process can be killed while executing
  // native code, without blocking cancellation in the automation/MCP owner.
  return await new Promise((resolve, reject) => {
    const child = fork(new URL("./sqlite-query-worker.js", import.meta.url), [], {
      env: filterProcessEnv(process.env, { allowedKeys: TEST_SUBPROCESS_ENV_KEYS }),
      execArgv: [], serialization: "advanced", windowsHide: true,
      stdio: ["ignore", "ignore", "ignore", "ipc"],
    });
    let response = null, failure = null;
    const stop = error => { failure ||= error; child.kill("SIGKILL"); };
    const timer = setTimeout(() => stop(Object.assign(new Error(
      `SQLite query exceeded its ${limitMs} ms time limit.${isRead ? "" : " The statement may have completed; verify its effects before retrying."}`,
    ), { code: "ETIMEDOUT" })), limitMs);
    const onAbort = () => stop(signal.reason ?? Object.assign(new Error("SQLite query canceled"), { name: "AbortError" }));
    signal?.addEventListener("abort", onAbort, { once: true });
    child.once("message", message => { response = message; });
    child.once("error", error => { failure ||= error; });
    // Do not return on timeout/abort until the child is reaped: otherwise a
    // background statement could retain locks or commit after its caller left.
    child.once("close", code => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      if (failure) { reject(failure); return; }
      if (response?.ok) { resolve(response.result); return; }
      reject(Object.assign(new Error(response?.error?.message || `SQLite query worker exited without a result (${code})`),
        { code: response?.error?.code || "SQLITE_ERROR" }));
    });
    if (signal?.aborted) { onAbort(); return; }
    try {
      child.send({ file, statement, parameters, isRead, readOnly, maxRows, timeoutMs: limitMs }, error => { if (error) stop(error); });
    } catch (error) { stop(error); }
  });
}

async function executePostgres({ connection, statement, parameters, isRead, readOnly, maxRows, loadDriver }) {
  const pg = await loadDriver("pg");
  const Client = pg.Client || pg.default?.Client;
  const client = new Client({
    host: connection.host || undefined,
    port: connection.port || undefined,
    database: connection.database || undefined,
    user: connection.username || undefined,
    // An approved passwordless connection must not silently use PGPASSWORD
    // or ~/.pgpass credentials belonging to the Posse host process.
    password: connection.password || (() => ""),
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
    const queryText = isRead ? boundedRemoteReadStatement(statement, maxRows) : statement;
    const result = await client.query({ text: queryText, values: parameters, queryMode: "extended" });
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

async function executeMysql({ connection, statement, parameters, isRead, readOnly, maxRows, loadDriver }) {
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
    const queryText = isRead ? boundedRemoteReadStatement(statement, maxRows) : statement;
    const [result, fields] = parameters.length
      ? await conn.execute(queryText, parameters)
      : await conn.query(queryText);
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
 *   signal?: AbortSignal|null,
 *   timeoutMs?: number,
 * }} input
 */
export async function executeProjectDbStatement({
  connection,
  statement,
  parameters = [],
  isRead,
  readOnly,
  maxRows = DEFAULT_MAX_ROWS,
  projectDir = null,
  loadDriver = loadOptionalDriver,
  signal = null,
  timeoutMs = DEFAULT_SQLITE_TIMEOUT_MS,
}) {
  const dbType = connection?.dbType;
  const args = { connection, statement, parameters, isRead, readOnly, maxRows, projectDir, loadDriver, signal, timeoutMs };
  switch (dbType) {
    case "sqlite": return await executeSqlite(args);
    case "postgres": return await executePostgres(args);
    case "mysql": return await executeMysql(args);
    default: throw new Error(`Unsupported project DB type: ${dbType || "(unset)"}`);
  }
}
