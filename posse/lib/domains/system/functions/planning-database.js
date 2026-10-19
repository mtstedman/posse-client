// Database provisioning owned by an explicitly approved planning setup batch.
// Only generated local SQLite settings cross into .env; existing secrets never
// enter a proposal, receipt, example file, or developer handoff.
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import Database from "better-sqlite3";
import { localPath, fingerprint } from "./environment-paths.js";
import { gitExecAsync } from "../../git/functions/utils.js";
import { listIgnoredRepoPaths } from "../../git/functions/ignored-paths.js";
import { readProjectDbConfig, writeProjectDbConfig } from "../../../shared/tools/functions/toolkit/project-db/config.js";
import { splitSqlStatements } from "../../../shared/tools/functions/toolkit/project-db/permissions.js";
import { PROJECT_DB_PERMISSIONS } from "../../../catalog/project-db.js";
import { DATABASE_ENV_KEYS } from "../../../catalog/tools/environment-setup.js";
import { prepareDatabaseConnectionFile } from "./database-connection-file.js";
import { prepareServerDatabase, serverDatabaseQuestion, executeServerDatabase, prepareServerDatabaseEnvironment } from "./server-database-setup.js";

function envValues(database) {
  return { DATABASE_URL: pathToFileURL(database).href, DB_DATABASE: database.replaceAll(path.sep, "/"), DB_CONNECTION: "sqlite" };
}

// keepExisting: a development worktree that already has database settings
// keeps them as they are, including ones a developer removed on purpose.
function envAdditions(file, values, { keepExisting = false } = {}) {
  const content = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (Buffer.byteLength(content) > 32 * 1024) throw new Error("Database environment files must be smaller than 32 KB.");
  const present = new Set();
  for (const line of content.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/u);
    if (!match || !DATABASE_ENV_KEYS.includes(match[1])) continue;
    if (keepExisting) { present.add(match[1]); continue; }
    const raw = match[2];
    let value;
    try { value = raw.startsWith('"') && raw.endsWith('"') ? JSON.parse(raw) : raw.startsWith("'") && raw.endsWith("'") ? raw.slice(1, -1) : raw; }
    catch { throw new Error(`Existing ${match[1]} cannot be parsed; resolve its configuration before setup.`); }
    if (present.has(match[1]) || value !== values[match[1]]) throw new Error(`Existing ${match[1]} conflicts with the proposed local database. Resolve it before requesting setup.`);
    present.add(match[1]);
  }
  if (keepExisting && present.size) return "";
  return Object.entries(values).filter(([key]) => !present.has(key)).map(([key, value]) => `${key}=${JSON.stringify(value)}`).join("\n");
}

export function databaseIgnoreRules(database) {
  return [...(database.type && database.type !== "sqlite" ? [database.server.env_file] : [database.path, `${database.path}-wal`, `${database.path}-shm`, `${database.path}-journal`]), ...database.env.map((entry) => entry.path)]
    .map((relative) => `/${relative.replace(/[\[\]*? #!]/gu, "\\$&")}`);
}

export async function preparePlanningDatabase(args, cwd, capture, writes) {
  if (!args || typeof args !== "object" || Array.isArray(args)) throw new Error("Provide a local SQLite database setup object.");
  if (args.type && args.type !== "sqlite") return prepareServerDatabase(args, cwd, capture, writes);
  if (args.server) throw new Error("SQLite setup uses path, not a server connection.");
  const file = localPath(cwd, args.path);
  if (!/\.(?:sqlite3?|db)$/iu.test(file)) throw new Error("Use a .sqlite, .sqlite3, or .db database filename.");
  if (fs.existsSync(file)) throw new Error("Database already exists. Planning setup only creates a new database; it never replaces application data.");
  const config = readProjectDbConfig({ projectDir: cwd });
  if (config.enabled || config.dbType || config.database || config.hasPassword || config.permissions.length) throw new Error("A Posse project database is already configured. Preserve it and manage changes through database settings.");
  const permissions = args.permissions ?? ["read"];
  if (!Array.isArray(permissions) || !permissions.length || permissions.some((entry) => !PROJECT_DB_PERMISSIONS.includes(entry))) throw new Error("Choose explicit Posse database permissions: read and/or write.");
  const envFiles = args.env_files ?? [".env"];
  if (!Array.isArray(envFiles) || !envFiles.length || envFiles.length > 8 || new Set(envFiles).size !== envFiles.length) throw new Error("Choose 1–8 distinct .env files for the application packages.");
  const database = { path: path.relative(cwd, file).replaceAll(path.sep, "/"), file, config, permissions: PROJECT_DB_PERMISSIONS.filter((entry) => permissions.includes(entry)), env: [], sql: "" };
  const tracked = (await gitExecAsync(["ls-files", "-z"], cwd)).split("\0");
  if (tracked.includes(database.path)) throw new Error("The runtime database must not be tracked by Git.");
  for (const value of envFiles) {
    const envFile = localPath(cwd, value, { environmentFile: true });
    if (path.basename(envFile) !== ".env") throw new Error("Database environment destinations must be named .env.");
    const relative = path.relative(cwd, envFile).replaceAll(path.sep, "/");
    if (tracked.includes(relative)) throw new Error("Local .env files must not be tracked by Git. Remove them from tracking before setup.");
    const additions = envAdditions(envFile, envValues(file));
    database.env.push({ path: relative, input: fingerprint(envFile), additions });
    const example = path.posix.join(path.posix.dirname(relative), "database.env.example");
    const portablePath = path.posix.relative(path.posix.dirname(relative), database.path);
    const exampleFile = capture(example, { writable: true });
    const exampleContent = `# Copy these settings to .env and adjust paths for your checkout.\nDATABASE_URL=${JSON.stringify(`file:./${portablePath}`)}\nDB_DATABASE=${JSON.stringify(portablePath)}\nDB_CONNECTION="sqlite"\n`;
    if (fs.existsSync(exampleFile) && fs.readFileSync(exampleFile, "utf8") !== exampleContent) throw new Error(`Existing ${example} differs; preserve it and resolve the configuration first.`);
    writes[example] = exampleContent;
  }
  if (args.schema_path) {
    const schemaFile = capture(args.schema_path, { writable: true });
    if (!/\.sql$/iu.test(schemaFile) || !fs.existsSync(schemaFile) || fs.statSync(schemaFile).size > 32 * 1024) throw new Error("Use an existing SQL schema smaller than 32 KB.");
    database.sql = fs.readFileSync(schemaFile, "utf8");
    for (const statement of splitSqlStatements(database.sql)) {
      if (!/^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s/iu.test(statement.trim())) throw new Error("Initial schema may contain only CREATE TABLE and CREATE INDEX statements.");
    }
    const probe = new Database(":memory:");
    try { if (database.sql.trim()) probe.exec(database.sql); } finally { probe.close(); }
  }
  database.connection_file = await prepareDatabaseConnectionFile(args.connection_file, cwd, capture, {
    reservedPaths: [database.path, ".gitignore", ...Object.keys(writes), ...(args.schema_path ? [args.schema_path] : [])],
  });
  if (database.connection_file.existing) {
    const connector = database.connection_file.path;
    if (!tracked.includes(connector) || (await gitExecAsync(["status", "--porcelain", "--", connector], cwd)).trim()) {
      throw new Error("Commit the existing application connector before reusing it in planning setup.");
    }
  } else writes[database.connection_file.path] = database.connection_file.content;
  return database;
}

export function planningDatabaseQuestion(database) {
  if (!database) return [];
  if (database.type && database.type !== "sqlite") return serverDatabaseQuestion(database);
  return [
    `Create SQLite database: ${database.file}. All development worktrees use this same local database. Existing data is never overwritten.`,
    `Initialize schema: ${database.sql || "empty database; developers create the application schema"}`,
    `Register with Posse database tools. Approved permissions: ${database.permissions.join(", ")}. Current agent tokens do not gain new permissions; subsequent jobs receive their permitted database tools.`,
    ...(database.connection_file ? [database.connection_file.existing
      ? `Reuse committed application connector: ${database.connection_file.path}. Existing source is preserved.`
      : `Create and commit connection module: ${database.connection_file.path}. The complete source is included in the proposed writes for review; setup does not execute it.`] : []),
    `Add these generated database variables to ignored environment files (preserving other values): ${JSON.stringify(database.env.map(({ path: envPath, additions }) => ({ path: envPath, additions })), null, 2)}. Commit database.env.example files only; never commit .env or database contents.`,
  ];
}

export async function executePlanningDatabase(database, cwd, signal) {
  if (!database) return null;
  if (database.type && database.type !== "sqlite") return executeServerDatabase(database, cwd, signal);
  if (signal?.aborted) throw new Error("Database setup canceled; development remains blocked.");
  if (JSON.stringify(readProjectDbConfig({ projectDir: cwd })) !== JSON.stringify(database.config)) throw new Error("Posse database settings changed after approval.");
  for (const entry of database.env) {
    if (fingerprint(localPath(cwd, entry.path, { environmentFile: true })) !== entry.input) throw new Error("Database environment inputs changed after approval.");
  }
  const expectedIgnored = [database.path, ...database.env.map((entry) => entry.path)];
  if ((await listIgnoredRepoPaths(cwd, expectedIgnored)).length !== expectedIgnored.length) throw new Error("Database and .env files must be ignored before setup.");
  const file = localPath(cwd, database.path);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Reserve the file exclusively so another local process cannot be overwritten.
  fs.closeSync(fs.openSync(file, "wx", 0o600));
  const db = new Database(file);
  try {
    // Materialize the SQLite header without claiming an application schema
    // version; migration runners keyed on user_version must start from zero.
    db.pragma("user_version = 0");
    if (database.sql.trim()) db.transaction(() => db.exec(database.sql))();
  } finally { db.close(); }
  const env = [];
  for (const entry of database.env) {
    const envFile = localPath(cwd, entry.path, { environmentFile: true });
    fs.mkdirSync(path.dirname(envFile), { recursive: true });
    const existing = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
    if (entry.additions) fs.appendFileSync(envFile, `${existing && !existing.endsWith("\n") ? "\n" : ""}${entry.additions}\n`, { mode: 0o600 });
    env.push({ path: entry.path });
  }
  const config = writeProjectDbConfig({ enabled: true, dbType: "sqlite", database: file, host: null, port: null, username: null, password: null, permissions: database.permissions }, { projectDir: cwd });
  return { path: database.path, file, env, config, ...(database.connection_file ? { connection_file: database.connection_file.path } : {}) };
}

// Later operator changes to the database's Posse registration or to the
// primary checkout's .env are the operator's to make.
export function assertPlanningDatabaseReady(database, cwd) {
  if (!database) return;
  if ((!database.type || database.type === "sqlite") && !fs.existsSync(localPath(cwd, database.path))) throw new Error("The approved local database is missing.");
  if (database.connection_file) {
    const connector = localPath(cwd, database.connection_file);
    if (!fs.existsSync(connector) || !fs.statSync(connector).isFile() || !fs.statSync(connector).size) {
      throw new Error("The approved application connector is missing or empty.");
    }
  }
}

// Development worktrees get the generated settings once and own their .env
// afterwards. A missing database or an unignored .env is reported, not fatal:
// development continues, and nothing machine-specific is written where Git
// could commit it.
export async function prepareDevelopmentDatabase(database, source, cwd) {
  if (!database) return [];
  if (database.type && database.type !== "sqlite") {
    try { return await prepareServerDatabaseEnvironment(database, source, cwd); }
    catch { return ["The server database configuration could not be copied from the primary checkout; check its local .env connection reference."]; }
  }
  if (!fs.existsSync(localPath(source, database.path))) {
    return [`The approved local database ${database.path} is missing from the primary checkout, so database settings were not added to this worktree.`];
  }
  const notices = [];
  const values = envValues(database.file);
  for (const entry of database.env) {
    const file = localPath(cwd, entry.path, { environmentFile: true });
    if (!(await listIgnoredRepoPaths(cwd, [entry.path])).length) {
      notices.push(`${entry.path} is not ignored in this checkout, so database settings were not written to it.`);
      continue;
    }
    const additions = envAdditions(file, values, { keepExisting: true });
    if (!additions) continue;
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}${additions}\n`, { mode: 0o600 });
  }
  return notices;
}
