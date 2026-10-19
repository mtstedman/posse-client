import fs from "node:fs";
import path from "node:path";
import { parseEnv } from "node:util";
import { localPath, fingerprint } from "./environment-paths.js";
import { gitExecAsync } from "../../git/functions/utils.js";
import { listIgnoredRepoPaths } from "../../git/functions/ignored-paths.js";
import { PROJECT_DB_PERMISSIONS } from "../../../catalog/project-db.js";
import { readProjectDbConfig, writeProjectDbConfig, projectDbConnectionFingerprint } from "../../../shared/tools/functions/toolkit/project-db/config.js";
import { prepareDatabaseConnectionFile } from "./database-connection-file.js";
import { configureServerDatabase } from "./server-database-driver.js";

// Connection values stay local. Proposals contain only a reference, a hash,
// and the non-secret endpoint the operator is authorizing.
function connectionFromEnvironment(database, cwd) {
  const file = localPath(cwd, database.server.env_file, { environmentFile: true });
  if (!fs.existsSync(file) || fs.statSync(file).size > 32 * 1024) throw new Error("Provide the server connection URL in a local .env file smaller than 32 KB.");
  const text = fs.readFileSync(file, "utf8");
  const name = database.server.url_env;
  if (text.split(/\r?\n/u).filter((line) => new RegExp(`^\\s*(?:export\\s+)?${name}\\s*=`).test(line)).length !== 1) throw new Error("The connection URL variable must be defined exactly once in the local .env file.");
  const raw = parseEnv(text)[name];
  if (!raw || /[\u0000-\u0020\u007f"'\\]/u.test(raw)) throw new Error("Use a database URL with percent-encoded whitespace, quotes, backslashes and credentials.");
  let url;
  try { url = new URL(raw); } catch { throw new Error("The local connection variable must contain a valid database URL."); }
  const validProtocol = database.type === "postgres" ? ["postgres:", "postgresql:"] : ["mysql:"];
  if (!validProtocol.includes(url.protocol) || !url.hostname || url.search || url.hash) throw new Error("Use a matching postgres/mysql URL with a host and database. URL query options and fragments are not supported by the project database driver.");
  let nameValue, username, password;
  try { nameValue = decodeURIComponent(url.pathname.slice(1)); username = decodeURIComponent(url.username); password = decodeURIComponent(url.password); }
  catch { throw new Error("The local database URL contains invalid escaping."); }
  if (!username) throw new Error("The database URL must specify an explicit username; ambient credentials are not approved by setup.");
  if (!nameValue || /[\u0000-\u001f\u007f/"'\\]/u.test(nameValue) || Buffer.byteLength(nameValue) > (database.type === "postgres" ? 63 : 64)) throw new Error("Use a single database name within the server's identifier limit, without quotes or backslashes.");
  const connection = { dbType: database.type, host: url.hostname.replace(/^\[|\]$/gu, ""), port: Number(url.port || (database.type === "postgres" ? 5432 : 3306)), database: nameValue, username, password };
  if (connection.port < 1 || connection.port > 65535) throw new Error("Invalid database port.");
  return { connection, values: { DATABASE_URL: raw, DB_DATABASE: nameValue, DB_CONNECTION: database.type } };
}

function additions(file, values, keepExisting = false) {
  const text = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (Buffer.byteLength(text) > 32 * 1024) throw new Error("Database environment files must be smaller than 32 KB.");
  const present = parseEnv(text);
  if (keepExisting && Object.keys(values).some((key) => Object.hasOwn(present, key))) return "";
  for (const [key, value] of Object.entries(values)) {
    if (text.split(/\r?\n/u).filter((line) => new RegExp(`^\\s*(?:export\\s+)?${key}\\s*=`).test(line)).length > 1) throw new Error(`Duplicate ${key} configuration must be resolved before setup.`);
    if (Object.hasOwn(present, key) && present[key] !== value) throw new Error(`Existing ${key} conflicts with the requested database. Resolve the local configuration before setup.`);
  }
  return Object.entries(values).filter(([key]) => !Object.hasOwn(present, key)).map(([key, value]) => `${key}='${value}'`).join("\n");
}

function target(connection) {
  const { password, ...endpoint } = connection;
  return { ...endpoint, hasPassword: !!password };
}

export async function prepareServerDatabase(args, cwd, capture, writes, { assertWritable, planning = true } = {}) {
  if (!["postgres", "mysql"].includes(args.type) || args.path || args.schema_path) throw new Error("Server setup requires postgres or mysql and a server reference, without SQLite path/schema_path. Apply application migrations separately.");
  const server = args.server;
  if (!server || typeof server !== "object" || typeof server.url_env !== "string" || !/^[A-Za-z_][A-Za-z0-9_]*$/u.test(server.url_env)
    || (server.create_database !== undefined && typeof server.create_database !== "boolean")) throw new Error("Reference a connection URL variable using server.url_env; do not supply credentials in tool arguments.");
  const config = readProjectDbConfig({ projectDir: cwd });
  if (config.enabled || config.dbType || config.database || config.hasPassword || config.permissions.length) throw new Error("A Posse project database is already configured. Preserve it and manage changes through database settings.");
  const permissions = args.permissions ?? ["read"];
  if (!Array.isArray(permissions) || !permissions.length || permissions.some((entry) => !PROJECT_DB_PERMISSIONS.includes(entry))) throw new Error("Choose explicit Posse database permissions: read and/or write.");
  const database = { type: args.type, server: { env_file: server.env_file || ".env", url_env: server.url_env, create_database: server.create_database === true }, config,
    config_input: projectDbConnectionFingerprint({ projectDir: cwd }), permissions: PROJECT_DB_PERMISSIONS.filter((entry) => permissions.includes(entry)), env: [] };
  const source = localPath(cwd, database.server.env_file, { environmentFile: true });
  if (path.basename(source) !== ".env") throw new Error("Server credentials must be referenced from a local .env file.");
  database.server.env_file = path.relative(cwd, source).replaceAll(path.sep, "/");
  const tracked = (await gitExecAsync(["ls-files", "-z"], cwd)).split("\0");
  if (tracked.includes(database.server.env_file) || !(await listIgnoredRepoPaths(cwd, [database.server.env_file])).length) throw new Error("Ignore the server credential .env file and remove it from Git tracking before requesting setup.");
  const { connection, values } = connectionFromEnvironment(database, cwd);
  database.target = target(connection);
  database.source_input = fingerprint(source);
  const envFiles = args.env_files ?? [".env"];
  if (!Array.isArray(envFiles) || !envFiles.length || envFiles.length > 8 || new Set(envFiles).size !== envFiles.length) throw new Error("Choose 1–8 distinct .env destinations.");
  const normalized = envFiles.map((relative) => path.relative(cwd, localPath(cwd, relative, { environmentFile: true })).replaceAll(path.sep, "/"));
  if (new Set(normalized).size !== normalized.length) throw new Error("Choose distinct .env destinations; aliases of the same path are not distinct.");
  for (const relative of normalized) {
    const file = localPath(cwd, relative, { environmentFile: true });
    if (path.basename(file) !== ".env" || tracked.includes(relative)) throw new Error("Database environment destinations must be untracked .env files.");
    additions(file, values);
    database.env.push({ path: relative, input: fingerprint(file) });
    const example = path.posix.join(path.posix.dirname(relative), "database.env.example");
    const exampleFile = capture(example, { writable: true });
    assertWritable?.(exampleFile);
    const exampleContent = `# Supply your own server URL in .env; never commit credentials.\nDATABASE_URL="${args.type}://USER:PASSWORD@HOST:PORT/DATABASE"\nDB_DATABASE="DATABASE"\nDB_CONNECTION="${args.type}"\n`;
    if (fs.existsSync(exampleFile) && fs.readFileSync(exampleFile, "utf8") !== exampleContent) throw new Error(`Existing ${example} differs; preserve it and resolve the configuration first.`);
    writes[example] = exampleContent;
  }
  database.connection_file = await prepareDatabaseConnectionFile(args.connection_file, cwd, capture, { reservedPaths: [".gitignore", ...Object.keys(writes)], assertWritable });
  database.connector_input = database.connection_file.existing ? fingerprint(localPath(cwd, database.connection_file.path)) : null;
  if (database.connection_file.existing) {
    const file = database.connection_file.path;
    if (planning && (!tracked.includes(file) || (await gitExecAsync(["status", "--porcelain", "--", file], cwd)).trim())) throw new Error("Commit the existing application connector before reusing it in planning setup.");
  } else writes[database.connection_file.path] = database.connection_file.content;
  return database;
}

export function serverDatabaseQuestion(database) {
  return [
    `${database.server.create_database ? "Create a new" : "Connect to an existing"} ${database.type} database: ${JSON.stringify(database.target)}. Existing databases are never overwritten; no existing data is migrated.`,
    `Read the connection URL only from ${database.server.env_file}, variable ${database.server.url_env}. No server software is installed.`,
    `Write DATABASE_URL, DB_DATABASE and DB_CONNECTION into ignored files: ${database.env.map((entry) => entry.path).join(", ")}. Credentials stay local; examples contain placeholders.`,
    `Register Posse permissions: ${database.permissions.join(", ")}. ${database.connection_file.existing ? "Reuse" : "Create"} application connector: ${database.connection_file.path}.`,
  ];
}

export async function executeServerDatabase(database, cwd, signal, { configure = configureServerDatabase } = {}) {
  if (signal?.aborted) throw new Error("Database setup canceled.");
  if (projectDbConnectionFingerprint({ projectDir: cwd }) !== database.config_input) throw new Error("Posse database settings changed after approval.");
  const source = localPath(cwd, database.server.env_file, { environmentFile: true });
  if (fingerprint(source) !== database.source_input) throw new Error("Database credentials changed after approval; request new approval.");
  const paths = [...new Set([database.server.env_file, ...database.env.map((entry) => entry.path)])];
  if ((await listIgnoredRepoPaths(cwd, paths)).length !== paths.length) throw new Error("Database environment files must be ignored before setup.");
  const { connection, values } = connectionFromEnvironment(database, cwd);
  const assertConnector = () => {
    const file = localPath(cwd, database.connection_file.path);
    if (!fs.existsSync(file) || (database.connection_file.existing
      ? fingerprint(file) !== database.connector_input
      : fs.readFileSync(file, "utf8") !== database.connection_file.content)) throw new Error("The approved application connector is missing or changed; request new approval.");
  };
  assertConnector();
  for (const entry of database.env) {
    const file = localPath(cwd, entry.path, { environmentFile: true });
    if (fingerprint(file) !== entry.input) throw new Error("Database environment inputs changed after approval.");
    additions(file, values);
  }
  if (fingerprint(source) !== database.source_input) throw new Error("Database credentials changed after approval; request new approval.");
  if (projectDbConnectionFingerprint({ projectDir: cwd }) !== database.config_input) throw new Error("Posse database settings changed after approval.");
  await configure(connection, { create: database.server.create_database, signal });
  if (signal?.aborted) throw new Error("Database setup canceled; a newly created database may remain.");
  // Revalidate after network I/O too, before writing local configuration.
  if (fingerprint(source) !== database.source_input) throw new Error("Database credentials changed during setup; local registration was not changed.");
  if (projectDbConnectionFingerprint({ projectDir: cwd }) !== database.config_input) throw new Error("Posse database settings changed during setup; existing registration was preserved.");
  assertConnector();
  for (const entry of database.env) {
    const file = localPath(cwd, entry.path, { environmentFile: true });
    if (fingerprint(file) !== entry.input) throw new Error("Database environment inputs changed during setup.");
  }
  await prepareServerDatabaseEnvironment(database, cwd, cwd);
  const config = writeProjectDbConfig({ ...connection, enabled: true, permissions: database.permissions }, { projectDir: cwd, expectedFingerprint: database.config_input });
  return { type: database.type, server: database.server, target: database.target, env: database.env.map(({ path: envPath }) => ({ path: envPath })), config, connection_file: database.connection_file.path };
}

export async function prepareServerDatabaseEnvironment(database, source, cwd) {
  const sourceFile = localPath(source, database.server.env_file, { environmentFile: true });
  const sourceInput = fingerprint(sourceFile);
  const { values } = connectionFromEnvironment(database, source);
  const notices = [];
  const destinations = [];
  for (const entry of database.env) {
    if (!(await listIgnoredRepoPaths(cwd, [entry.path])).length) { notices.push(`${entry.path} is not ignored; database settings were not written.`); continue; }
    destinations.push(entry);
  }
  if (source === cwd && notices.length) throw new Error("Database environment ignore policy changed during setup; configuration was not written.");
  if (fingerprint(localPath(source, database.server.env_file, { environmentFile: true })) !== (source === cwd ? database.source_input : sourceInput)) throw new Error("Database credentials changed while preparing environment files.");
  // Complete every asynchronous policy check before revalidating and writing
  // any destination, so partial policy failures cannot look like success.
  if (source === cwd) for (const entry of destinations) {
    if (fingerprint(localPath(cwd, entry.path, { environmentFile: true })) !== entry.input) throw new Error("Database environment inputs changed during setup.");
  }
  const pending = destinations.map((entry) => {
    const file = localPath(cwd, entry.path, { environmentFile: true });
    const added = additions(file, values, source !== cwd);
    return { file, added };
  });
  for (const { file, added } of pending) {
    if (!added) continue;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const existing = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
    fs.appendFileSync(file, `${existing && !existing.endsWith("\n") ? "\n" : ""}${added}\n`, { mode: 0o600 });
  }
  return notices;
}
