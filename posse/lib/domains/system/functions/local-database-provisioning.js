import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { parseEnv } from "node:util";
import { LOCAL_DATABASE_PLATFORMS, LOCAL_DATABASE_ENGINES, LOCAL_DATABASE_COMMANDS as COMMANDS, LOCAL_DATABASE_COMMAND_ENV, LOCAL_DATABASE_PROVISION_TIMEOUT_MS } from "../../../catalog/local-database-provisioning.js";
import { runVerificationPrerequisiteCommand } from "../../verification/functions/prerequisite-adapters.js";
import { configureServerDatabase } from "./server-database-driver.js";

// Privileged executables come from fixed system paths, not repository PATH.
// Check parent ownership too: a trusted file in a writable directory can be
// replaced between approval and launch.
export function assertTrustedSystemCommand(file) {
  let current;
  try { current = fs.realpathSync(file); } catch { throw new Error(`Required system command is unavailable: ${file}`); }
  if (!fs.statSync(current).isFile()) throw new Error(`Invalid system command: ${file}`);
  for (;;) {
    const stat = fs.statSync(current);
    if (stat.uid !== 0 || (stat.mode & 0o022)) throw new Error(`System command path must be root-owned and not group/world writable: ${file}`);
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
}

function commandRunner(run, privilege = "root", { signal, deadline = Date.now() + LOCAL_DATABASE_PROVISION_TIMEOUT_MS, trusted = assertTrustedSystemCommand } = {}) {
  return async (command, args, { input = null, privileged = true, timeoutMs = 30000 } = {}) => {
    if (signal?.aborted) throw new Error("Local database setup canceled; partial system changes may remain.");
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Local database setup timed out; partial system changes may remain.");
    trusted(command);
    if (privileged && privilege === "sudo") { trusted(COMMANDS.sudo); trusted(COMMANDS.env); }
    const result = await run(privileged && privilege === "sudo" ? COMMANDS.sudo : command,
      privileged && privilege === "sudo" ? ["-n", "--", COMMANDS.env, "-i", ...Object.entries(LOCAL_DATABASE_COMMAND_ENV).map(([key, value]) => `${key}=${value}`), command, ...args] : args,
      { cwd: "/", env: LOCAL_DATABASE_COMMAND_ENV, inheritEnv: false, input, signal, timeoutMs: Math.min(timeoutMs, remaining) });
    return result;
  };
}

export async function inspectLocalDatabaseHost(type, {
  platform = process.platform, uid = (process.geteuid?.() ?? process.getuid?.()), osRelease = null, systemd = fs.existsSync("/run/systemd/system"),
  run = runVerificationPrerequisiteCommand, trusted = assertTrustedSystemCommand,
} = {}) {
  const engine = LOCAL_DATABASE_ENGINES[type];
  if (!engine) throw new Error("Local server provisioning supports postgres and mysql.");
  if (platform !== "linux") throw new Error("Local server provisioning currently requires Ubuntu/Debian Linux. Use an existing server connection on this platform.");
  const release = osRelease ?? fs.readFileSync("/etc/os-release", "utf8");
  const os = parseEnv(release);
  if (!LOCAL_DATABASE_PLATFORMS.includes(os.ID)) throw new Error("Local server provisioning currently supports Ubuntu/Debian package repositories.");
  trusted(COMMANDS.apt);
  const privilege = uid === 0 ? "root" : "sudo";
  const invoke = commandRunner(run, privilege, { trusted });
  if (privilege === "sudo" && !(await invoke(COMMANDS.true, [], { timeoutMs: 5000 })).ok) {
    throw new Error("Local database setup needs root or non-interactive sudo. Use a root session or authorize non-interactive sudo for setup, then request setup again; Posse does not collect sudo passwords.");
  }
  const status = await invoke(COMMANDS.dpkg, ["--show", "--showformat=${db:Status-Status} ${Version}", engine.package], { privileged: false, timeoutMs: 5000 });
  const installed = status.ok && /^installed /u.test(status.stdout || "") ? status.stdout.trim() : null;
  const serviceCommand = systemd ? COMMANDS.systemctl : COMMANDS.service;
  trusted(serviceCommand);
  if (type === "postgres") trusted(COMMANDS.runuser);
  return { type, distribution: os.ID, release: os.VERSION_ID || null, privilege, installed,
    package: engine.package, service: engine.service, service_command: serviceCommand, port: engine.port };
}

export async function prepareLocalDatabase(args, type, cwd, { inspect = inspectLocalDatabaseHost } = {}) {
  if (!args || typeof args !== "object" || Array.isArray(args) || typeof args.database !== "string"
    || !/^[a-z][a-z0-9_]{0,62}$/u.test(args.database)) throw new Error("Choose a local database name using lowercase letters, digits and underscores (1–63 characters, beginning with a letter).");
  const username = args.username ?? `posse_${crypto.createHash("sha256").update(`${cwd}\0${type}\0${args.database}`).digest("hex").slice(0, 16)}`;
  if (typeof username !== "string" || !/^[a-z][a-z0-9_]{0,31}$/u.test(username) || /^(?:root|postgres|mysql|pg_.*)$/u.test(username)) throw new Error("Choose a new application username of 1–32 lowercase letters, digits or underscores; reserved administrator names are excluded.");
  return { ...(await inspect(type)), database: args.database, username };
}

export function localDatabaseQuestion(local) {
  return [
    `Local system provisioning on ${local.distribution} ${local.release || ""}, using ${local.privilege === "root" ? "the current root user" : "sudo -n"}.`,
    local.installed ? `Reuse installed ${local.package} (${local.installed}); no package upgrade is requested.`
      : `Refresh configured APT repositories and install ${local.package} with dependencies. Package scripts may initialize and start the service. Repositories are preserved.`,
    `Start service ${local.service} using ${local.service_command}. Existing service configuration is preserved.`,
    `Create database ${local.database} and application user ${local.username} for 127.0.0.1:${local.port}. Existing databases/users cause a stop, not replacement. A random application password is generated locally and saved only to ignored environment files and Posse's local credential store.`,
    "System installation and database creation are not rolled back on a later failure. Partial changes are reported; retry requires a new approval.",
  ];
}

function adminCommand(type) {
  return type === "postgres"
    ? { command: COMMANDS.runuser, args: ["-u", "postgres", "--", LOCAL_DATABASE_ENGINES.postgres.client, "-X", "--no-password", "--host=/var/run/postgresql", "--port=5432", "--dbname=postgres", "--set=ON_ERROR_STOP=1", "--tuples-only", "--no-align"] }
    : { command: LOCAL_DATABASE_ENGINES.mysql.client, args: ["--no-defaults", "--protocol=SOCKET", "--socket=/var/run/mysqld/mysqld.sock", "--user=root", "--batch", "--skip-column-names"] };
}

export async function provisionLocalDatabase(local, {
  signal, run = runVerificationPrerequisiteCommand, inspect = inspectLocalDatabaseHost,
  trusted = assertTrustedSystemCommand, configure = configureServerDatabase,
} = {}) {
  if (signal?.aborted) throw new Error("Local database setup canceled.");
  const validated = await prepareLocalDatabase({ database: local.database, username: local.username }, local.type, "/", { inspect });
  const { database, username, ...current } = validated;
  const { database: _database, username: _username, ...approvedHost } = local;
  if (JSON.stringify(current) !== JSON.stringify(approvedHost)) throw new Error("System database prerequisites changed after approval. Request a new setup approval.");
  const invoke = commandRunner(run, local.privilege, { signal, trusted });
  const requireSuccess = async (command, args, options, message) => {
    const result = await invoke(command, args, options);
    if (!result.ok) {
      if (result.status === "cancelled") throw new Error("Local database setup canceled; partial system changes may remain.");
      if (result.reason === "dependency_repair_timeout") throw new Error("Local database setup timed out; partial system changes may remain.");
      throw new Error(message); // SQL diagnostics can include the generated password.
    }
    return result;
  };
  if (!local.installed) {
    await requireSuccess(COMMANDS.apt, ["-o", "Acquire::Retries=2", "-o", "DPkg::Lock::Timeout=120", "update"], { timeoutMs: 180000 }, "Could not refresh configured APT repositories; no database setup completed.");
    await requireSuccess(COMMANDS.apt, ["-o", "Acquire::Retries=2", "-o", "DPkg::Lock::Timeout=120", "install", "-y", "--no-upgrade", "--no-install-recommends", local.package], { timeoutMs: 300000 }, `Could not install ${local.package} from configured repositories. Partial packages may remain.${local.type === "mysql" && local.distribution === "debian" ? " Debian MySQL requires a repository providing mysql-server; MariaDB is not substituted." : ""}`);
  }
  const serviceArgs = local.service_command === COMMANDS.systemctl ? ["start", local.service] : [local.service, "start"];
  await requireSuccess(local.service_command, serviceArgs, { timeoutMs: 60000 }, `Could not start ${local.service}. Inspect the system service; packages may already be installed.`);
  const admin = adminCommand(local.type);
  trusted(LOCAL_DATABASE_ENGINES[local.type].client);
  const preflight = local.type === "postgres"
    ? `SELECT (SELECT count(*) FROM pg_database WHERE datname='${database}') + (SELECT count(*) FROM pg_roles WHERE rolname='${username}');\n`
    : `SELECT (SELECT count(*) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME='${database}') + (SELECT count(*) FROM mysql.user WHERE User='${username}');\nSELECT @@GLOBAL.partial_revokes;\n`;
  const existing = await requireSuccess(admin.command, admin.args, { input: preflight }, "Local database administration via the system socket failed. Existing administrator authentication is preserved; configure an existing server connection if socket administration is unavailable.");
  const rows = existing.stdout.trim().split(/\r?\n/u);
  if (rows[0] !== "0") throw new Error("The requested database or application user already exists. Existing accounts/data were preserved; use existing-server configuration or choose new names.");
  if (local.type === "mysql" && !["0", "1"].includes(rows[1])) throw new Error("Could not establish MySQL database-grant semantics; no account was created.");
  // MySQL database-level GRANT treats '_' as a wildcard unless partial revokes
  // are enabled. Quote the identifier AND escape its wildcard semantics.
  const grantDatabase = rows[1] === "1" ? database : database.replaceAll("_", "\\_");
  const password = `pP0_${crypto.randomBytes(32).toString("base64url")}`;
  const sql = local.type === "postgres"
    ? `CREATE ROLE "${username}" LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION PASSWORD '${password}';\nCREATE DATABASE "${database}" OWNER "${username}";\n`
    : `CREATE USER '${username}'@'localhost' IDENTIFIED BY '${password}';\nCREATE DATABASE \`${database}\`;\nGRANT ALL PRIVILEGES ON \`${grantDatabase}\`.* TO '${username}'@'localhost';\n`;
  await requireSuccess(admin.command, admin.args, { input: sql }, "Local database/account creation failed; newly created resources may remain. Existing resources were not replaced. Inspect the approved names before retrying.");
  const connection = { dbType: local.type, host: "127.0.0.1", port: local.port, database, username, password };
  try { await configure(connection, { signal }); }
  catch {
    if (signal?.aborted) throw new Error("Local database setup canceled; the new database and application user may remain.");
    throw new Error(`Local database ${database} and application user ${username} were created, but the application connection to 127.0.0.1:${local.port} failed. Check the service TCP/authentication configuration. Local credentials were not registered; created resources remain and require inspection before another setup approval.`);
  }
  return connection;
}
