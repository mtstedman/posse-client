// Only the approved target database may be created. No migrations, grants,
// service installation, or arbitrary SQL are accepted by this setup adapter.
export async function configureServerDatabase(connection, { create = false, signal, loadDriver = (name) => import(name) } = {}) {
  let client;
  const checkCanceled = () => { if (signal?.aborted) throw new Error("Database setup canceled."); };
  checkCanceled();
  try {
    const options = { host: connection.host, port: connection.port, user: connection.username, password: connection.password };
    if (connection.dbType === "postgres") {
      const pg = await loadDriver("pg");
      const Client = pg.Client || pg.default?.Client;
      client = new Client({ ...options, password: connection.password || (() => ""), database: create ? "postgres" : connection.database, connectionTimeoutMillis: 10000, query_timeout: 10000 });
      await client.connect();
      checkCanceled();
      if (create) {
        const existing = await client.query("SELECT 1 FROM pg_database WHERE datname = $1", [connection.database]);
        if (existing.rows.length) throw new Error("Database already exists; choose configuration without creation to preserve it.");
        checkCanceled();
        await client.query(`CREATE DATABASE "${connection.database.replaceAll('"', '""')}"`);
      } else await client.query("SELECT 1");
    } else if (connection.dbType === "mysql") {
      const mysql = await loadDriver("mysql2/promise");
      const createConnection = mysql.createConnection || mysql.default?.createConnection;
      client = await createConnection({ ...options, database: create ? undefined : connection.database, connectTimeout: 10000, multipleStatements: false });
      checkCanceled();
      if (create) {
        // No IF NOT EXISTS: an existing database must never be mistaken for a
        // new, empty one, including when another process races this request.
        await client.query({ sql: `CREATE DATABASE \`${connection.database.replaceAll('`', '``')}\``, timeout: 10000 });
      } else await client.query({ sql: "SELECT 1", timeout: 10000 });
    } else throw new Error("Unsupported server database engine.");
    checkCanceled();
  } catch {
    // Driver errors can contain credentials or server diagnostics. Keep those
    // out of approval receipts and agent observations.
    throw new Error("Database connection/setup failed. Check the local connection URL, server availability, and creation permissions. Existing databases require create_database: false. No existing data was modified; a newly created database may remain after a connection failure.");
  } finally {
    try { await client?.end(); } catch { /* connection cleanup */ }
  }
  // Creation uses a maintenance connection; verify the application target too.
  if (create) await configureServerDatabase(connection, { signal, loadDriver });
}
