import { localPath, fingerprint, readManifest } from "./environment-paths.js";
import { preparePlanningEnvironment, executePlanningEnvironment, planningEnvironmentQuestion, planningEnvironmentRoot } from "./planning-environment.js";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import Database from "better-sqlite3";
import { listIgnoredRepoPaths } from "../../git/functions/ignored-paths.js";
import { guardToolWriteLock } from "../../queue/functions/write-lock-guard.js";
import { commandSpawnSpec, findCommandOnPath } from "../../../shared/platform/functions/command-launch.js";
import { withDependencyInstallLock } from "../../../shared/concurrency/functions/dependency-install-lock.js";
import { runVerificationPrerequisiteCommand } from "../../verification/functions/prerequisite-adapters.js";
import { splitSqlStatements } from "../../../shared/tools/functions/toolkit/project-db/permissions.js";
import { readProjectDbConfig } from "../../../shared/tools/functions/toolkit/project-db/config.js";
import { ENVIRONMENT_PACKAGE_MANAGERS, ENVIRONMENT_SETUP_INSTALL_BUDGET_MS, ENVIRONMENT_SETUP_LOCK_WAIT_MS, ENVIRONMENT_SETUP_STEP_TIMEOUT_MS } from "../../../catalog/tools/environment-setup.js";
import { PACKAGE_MANAGERS, detectPackageManagers, packageCommands, packageScriptsLine, readPackageManifest, resolvePackageManager, shownPackageInputs } from "./package-managers.js";
import { prepareDatabaseConnectionFile } from "./database-connection-file.js";
import { PROJECT_DB_TYPES } from "../../../catalog/project-db.js";
import { LOCAL_DATABASE_PLATFORMS, LOCAL_DATABASE_ENGINES } from "../../../catalog/local-database-provisioning.js";
import { detectNodePackageManager, preferredNodePackageManager } from "../../../shared/tools/functions/node-package-manager.js";
import { prepareServerDatabase, serverDatabaseQuestion, executeServerDatabase } from "./server-database-setup.js";

export function inspectEnvironment(args = {}, { cwd, role = null }) {
  if (role === "planner") cwd = planningEnvironmentRoot(cwd);
  const directory = localPath(cwd, args.path || ".");
  const manifestPath = localPath(cwd, path.relative(cwd, path.join(directory, "package.json")).replaceAll(path.sep, "/") || "package.json");
  const manifest = fs.existsSync(manifestPath) ? readManifest(manifestPath) : null;
  const modules = localPath(cwd, path.relative(cwd, path.join(directory, "node_modules")).replaceAll(path.sep, "/"), { dependencyDirectory: true });
  const composerFile = localPath(cwd, path.relative(cwd, path.join(directory, "composer.json")).replaceAll(path.sep, "/"));
  const composer = fs.existsSync(composerFile) ? readManifest(composerFile) : null;
  return {
    cwd, composer_available: !!findCommandOnPath("composer"), php_available: !!findCommandOnPath("php"),
    composer_json: composer, composer_lock: fs.existsSync(path.join(directory, "composer.lock")),
    vendor_present: fs.existsSync(localPath(cwd, path.relative(cwd, path.join(directory, "vendor")).replaceAll(path.sep, "/"), { dependencyDirectory: true })),
    path: args.path || ".", platform: process.platform, node: process.version,
    npm_available: !!findCommandOnPath("npm"), package_json: !!manifest,
    preferred_node_package_manager: preferredNodePackageManager(),
    node_package_manager: detectNodePackageManager(directory, { allowUnversioned: true }).manager,
    dependencies: manifest?.dependencies || {}, dev_dependencies: manifest?.devDependencies || {},
    package_lock: fs.existsSync(localPath(cwd, path.relative(cwd, path.join(directory, "package-lock.json")).replaceAll(path.sep, "/"))),
    node_modules_present: fs.existsSync(modules),
    package_managers: detectPackageManagers(directory).map((name) => {
      const manager = PACKAGE_MANAGERS[name];
      const lock = manager.lockfile(directory);
      let parsed = {};
      try { parsed = readPackageManifest(manager, path.join(directory, manager.manifest)); } catch { /* reported by the installer */ }
      const installDirs = manager.dependencyDirs(directory, parsed);
      return { manager: name, manifest: manager.manifest, lockfile: lock && fs.existsSync(path.join(directory, lock)) ? lock : null,
        installed: installDirs.length ? installDirs.every((dir) => fs.existsSync(path.join(directory, dir))) : null, available: !!manager.command() };
    }),
    supported_package_managers: ENVIRONMENT_PACKAGE_MANAGERS,
    sqlite_setup_available: true, database_setup_types: PROJECT_DB_TYPES, project_database: readProjectDbConfig({ projectDir: cwd }), approval_required: ["setup_environment", "install_dependencies", "setup_database"],
    local_database_provisioning: { platform: process.platform, distributions: LOCAL_DATABASE_PLATFORMS, engines: Object.keys(LOCAL_DATABASE_ENGINES), root: (process.geteuid?.() ?? process.getuid?.()) === 0, sudo_available: !!findCommandOnPath("sudo"), requires: "Ubuntu/Debian APT packages and root or non-interactive sudo; explicit local_server approval" },
    note: "An install directory's presence does not prove dependencies are current; installed is null for managers that use a shared cache. Installers require explicit user approval. Local database system provisioning is available only through an explicit local_server request; ordinary dependency installation remains project-local.",
  };
}

function assertWritable(file, context, tool = "install_dependencies") {
  const allowed = fs.existsSync(file) ? context.scope?.canEdit(file) : context.scope?.canCreate(file);
  if (!allowed) throw new Error(`Request writable scope for ${path.relative(context.cwd, file)} before environment setup.`);
  const error = guardToolWriteLock(tool, path.relative(context.cwd, file), context.cwd);
  if (error) throw new Error(error);
}

export async function prepareEnvironmentSetup(tool, args, context) {
  if (tool === "setup_environment") return preparePlanningEnvironment(args, context);
  const { cwd } = context;
  const reason = String(args.reason || "").trim();
  if (!reason || reason.length > 1000) throw new Error("A setup reason of 1–1000 characters is required.");
  const proposal = { tool, cwd: fs.realpathSync(cwd), reason, args, inputs: {}, changes: [] };
  const capture = (relative) => {
    const file = localPath(cwd, relative);
    proposal.inputs[relative] = fingerprint(file);
    return file;
  };
  if (tool === "install_dependencies") {
    const directory = localPath(cwd, args.path || ".");
    if (!fs.statSync(directory).isDirectory()) throw new Error("Package path must be a directory.");
    const relative = (name) => path.relative(cwd, path.join(directory, name)).replaceAll(path.sep, "/");
    const manager = resolvePackageManager(directory, args.manager, args.path || ".");
    const manifestFile = capture(relative(manager.manifest));
    if (!fs.existsSync(manifestFile)) throw new Error(`Declare the dependencies in ${manager.manifest} before requesting installation.`);
    if (fs.statSync(manifestFile).size > 32 * 1024) throw new Error("Manifest approval is limited to 32 KB.");
    const manifest = readPackageManifest(manager, manifestFile);
    manager.validate(directory, manifest);
    for (const name of manager.inputs(directory)) capture(relative(name));
    const lock = manager.lockfile(directory);
    const lockFile = lock ? capture(relative(lock)) : null;
    const configFiles = manager.configFiles.filter((name) => fs.existsSync(capture(relative(name)))).map(relative);
    if (manager.writesManifest) assertWritable(manifestFile, context);
    if (lockFile) assertWritable(lockFile, context);
    const dependencyDirs = manager.dependencyDirs(directory, manifest).map(relative);
    for (const dir of dependencyDirs) localPath(cwd, dir, { dependencyDirectory: true });
    const committable = [relative(manager.manifest), ...(lock ? [relative(lock)] : [])];
    const probes = dependencyDirs.map((dir) => `${dir}/.posse-setup-probe`);
    const ignored = new Set((await listIgnoredRepoPaths(cwd, [...committable, ...probes])).map((item) => item.path));
    if (committable.some((file) => ignored.has(file))) throw new Error("Package manifests and lockfiles must be committable; fix repository ignore rules first.");
    const exposed = dependencyDirs.find((dir, index) => !ignored.has(probes[index]));
    if (exposed) throw new Error(`Ignore ${exposed}/ in repository policy before requesting installation.`);
    const command = manager.command();
    if (!command) throw new Error(`${manager.label} is unavailable on this machine. Install ${manager.toolchain}, restart Posse, then request dependency installation.`);
    const scripts = manager.scripts === "always" || (manager.scripts === "flag" && args.lifecycle_scripts === true);
    const options = { dir: directory, manifest, command, scripts, plugins: false };
    manager.validateInstall(options);
    proposal.manager = manager.name;
    proposal.directory = directory;
    proposal.commands = packageCommands(manager, manager.install(options), options);
    proposal.manifest = manifest;
    proposal.other_manifests = shownPackageInputs(manager, directory, relative);
    proposal.config_files = configFiles;
    proposal.changes = [...(lock ? [relative(lock)] : []), ...dependencyDirs.map((dir) => `${dir}/`)];
    proposal.lifecycle_scripts = scripts;
  } else if (tool === "setup_database" && args.type && args.type !== "sqlite") {
    proposal.writes = {};
    proposal.server_database = await prepareServerDatabase(args, cwd, capture, proposal.writes, { planning: false, assertWritable: (file) => assertWritable(file, context, tool) });
    proposal.changes = Object.keys(proposal.writes);
    for (const entry of proposal.server_database.env) {
      if (!(await listIgnoredRepoPaths(cwd, [entry.path])).length) throw new Error("Ignore all .env destinations before requesting server setup.");
    }
  } else if (tool === "setup_database") {
    if (args.server || args.local_server || args.env_files || args.permissions) throw new Error("SQLite worktree setup uses path/schema_path and leaves database registration unchanged. Use planning setup for shared configuration.");
    const database = capture(args.path);
    if (fs.existsSync(database)) throw new Error("Database already exists; this tool only creates new databases and never overwrites data.");
    if (!(await listIgnoredRepoPaths(cwd, [args.path])).length) throw new Error("Add the runtime database path to .gitignore before requesting setup; keep the SQL schema in source control.");
    proposal.database = database;
    proposal.sql = "";
    if (args.schema_path) {
      const schema = capture(args.schema_path);
      if ((await listIgnoredRepoPaths(cwd, [args.schema_path])).length) throw new Error("The SQL schema must be committable; it cannot be an ignored runtime artifact.");
      if (!/\.sql$/iu.test(schema)) throw new Error("schema_path must be a SQL file.");
      if (fs.statSync(schema).size > 32 * 1024) throw new Error("Schema approval is limited to 32 KB per new database.");
      proposal.sql = fs.readFileSync(schema, "utf8");
      // This is an initializer, not an arbitrary SQL executor. No ATTACH,
      // PRAGMA, extension loading, external files or destructive migrations.
      for (const statement of splitSqlStatements(proposal.sql)) {
        const text = statement.trim();
        if (!/^CREATE\s+(?:TABLE|(?:UNIQUE\s+)?INDEX)\s/iu.test(text)) throw new Error("Initial schema may contain only CREATE TABLE and CREATE INDEX statements.");
      }
    }
    proposal.changes = [args.path];
    proposal.connection_file = await prepareDatabaseConnectionFile(args.connection_file, cwd, capture, {
      reservedPaths: Object.keys(proposal.inputs),
      assertWritable: (file) => assertWritable(file, context, tool),
    });
    if (!proposal.connection_file.existing) proposal.changes.push(proposal.connection_file.path);
  } else throw new Error("Unknown environment setup tool.");
  proposal.digest = crypto.createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
  return proposal;
}

export function environmentSetupQuestion(proposal) {
  if (proposal.tool === "setup_environment") return planningEnvironmentQuestion(proposal);
  if (proposal.server_database) return ["Approve this server database setup?", `Reason: ${proposal.reason}`, ...serverDatabaseQuestion(proposal.server_database), `Create scoped source files: ${JSON.stringify(proposal.writes, null, 2)}`, "Approval is for this request only; rejection makes no changes."].join("\n\n");
  const operation = proposal.tool === "install_dependencies"
    ? [...proposal.commands.map((entry) => `Command: ${JSON.stringify([entry.command, ...entry.argv])}${Object.keys(entry.env).length ? `\nEnvironment overrides: ${JSON.stringify(entry.env)}` : ""}`),
      ...packageScriptsLine(PACKAGE_MANAGERS[proposal.manager], proposal.lifecycle_scripts),
      ...proposal.config_files.map((file) => `${PACKAGE_MANAGERS[proposal.manager].label} configuration: ${file} applies to this install (registry, authentication and install settings). Review it before approving; changing it invalidates this approval.`),
      `Manifest: ${typeof proposal.manifest === "string" ? proposal.manifest || "(empty)" : JSON.stringify(proposal.manifest, null, 2)}`,
      ...Object.entries(proposal.other_manifests).map(([file, text]) => `Also installed from ${file}:\n${text || "(empty)"}`)]
    : ["Operation: create a new local SQLite database (no existing data is modified).", `Database: ${proposal.database}`, `SQL schema:\n${proposal.sql || "(empty database)"}`,
      ...(proposal.connection_file ? [proposal.connection_file.existing
        ? `Reuse application connector: ${proposal.connection_file.path}. Existing source is preserved.`
        : `New connection module (review source; setup does not execute it):\n${JSON.stringify(proposal.connection_file, null, 2)}\nCommit this source with the application; configuration values stay local.`] : [])];
  return [`Approve this environment setup?`, `Reason: ${proposal.reason}`, `Worktree: ${proposal.cwd}`, ...operation, `Changes: ${proposal.changes.join(", ")}`, "Approval is for this request only. Rejection makes no setup changes."].join("\n\n");
}

export async function executeEnvironmentSetup(proposal, context, { signal, beforeExecute = () => {}, runCommand = runVerificationPrerequisiteCommand } = {}) {
  if (proposal.tool === "setup_environment") return executePlanningEnvironment(proposal, context, { signal, beforeExecute, runCommand });
  return withDependencyInstallLock(proposal.cwd, async () => {
    if (signal?.aborted) throw new Error("Environment setup canceled.");
    const fresh = await prepareEnvironmentSetup(proposal.tool, proposal.args, context);
    if (fresh.digest !== proposal.digest) throw new Error("Setup inputs changed after approval. Request a new approval.");
    // Preparation includes asynchronous Git policy checks. Recheck exact files
    // and symlinks synchronously after those checks, immediately before launch.
    for (const [relative, expected] of Object.entries(proposal.inputs)) {
      if (fingerprint(localPath(context.cwd, relative)) !== expected) throw new Error("Setup inputs changed after approval. Request a new approval.");
    }
    if (signal?.aborted) throw new Error("Environment setup canceled.");
    beforeExecute();
    if (proposal.tool === "install_dependencies") {
      PACKAGE_MANAGERS[proposal.manager].prepareInstall(proposal.directory);
      // Commands run in order and stop at the first failure, inside one budget.
      const results = [];
      const deadline = Date.now() + ENVIRONMENT_SETUP_INSTALL_BUDGET_MS;
      for (const entry of proposal.commands) {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) { results.push({ ok: false, status: "blocked", reason: "setup_budget_exhausted" }); break; }
        const spec = commandSpawnSpec(entry.command, entry.argv);
        const result = await runCommand(spec.command, spec.args, { cwd: proposal.directory, env: entry.env, signal, windowsVerbatimArguments: spec.windowsVerbatimArguments, timeoutMs: Math.min(ENVIRONMENT_SETUP_STEP_TIMEOUT_MS, remainingMs) });
        results.push(result);
        if (!result.ok) break;
      }
      const ok = results.length === proposal.commands.length && results.every((result) => result.ok);
      return { ...results.at(-1), ok, ...(results.length > 1 ? { results } : {}), changes: proposal.changes, message: ok ? "Dependencies installed. Commit the scoped manifest and lockfile with the implementation." : "Installation did not complete; partial dependency/lockfile changes may remain. A retry requires new approval." };
    }
    if (proposal.server_database) {
      for (const [relative, content] of Object.entries(proposal.writes)) {
        const file = localPath(context.cwd, relative);
        // Existing examples were validated byte-for-byte and remain unchanged.
        if (fs.existsSync(file)) continue;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content, { flag: "wx" });
      }
      const database = await executeServerDatabase(proposal.server_database, context.cwd, signal);
      return { ok: true, status: "configured", database, changes: proposal.changes, message: "Server database configured. Commit and test the application connector and portable examples. Existing data was preserved." };
    }
    fs.mkdirSync(path.dirname(proposal.database), { recursive: true });
    fs.closeSync(fs.openSync(proposal.database, "wx"));
    let db;
    try {
      db = new Database(proposal.database);
      db.transaction(() => {
        // Materialize the SQLite header even when no schema was requested.
        db.exec("PRAGMA user_version = 0");
        for (const statement of splitSqlStatements(proposal.sql)) db.prepare(statement).run();
      })();
      if (proposal.connection_file && !proposal.connection_file.existing) {
        const file = localPath(context.cwd, proposal.connection_file.path);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, proposal.connection_file.content, { flag: "wx" });
      }
      return { ok: true, status: "created", path: proposal.args.path,
        ...(proposal.connection_file ? { connection_file: proposal.connection_file.path } : {}),
        message: "Local SQLite database created in this worktree. Keep the schema and app path configuration in source control. Commit and test any generated connection module with the application. project_db_query grants are unchanged." };
    } catch (error) {
      db?.close(); db = null;
      fs.rmSync(proposal.database, { force: true });
      throw error;
    } finally { db?.close(); }
  }, { waitMs: ENVIRONMENT_SETUP_LOCK_WAIT_MS });
}
