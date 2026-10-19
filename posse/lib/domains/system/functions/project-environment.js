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
import { ENVIRONMENT_SETUP_LOCK_WAIT_MS, ENVIRONMENT_SETUP_STEP_TIMEOUT_MS } from "../../../catalog/tools/environment-setup.js";
import { prepareDatabaseConnectionFile } from "./database-connection-file.js";

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
    dependencies: manifest?.dependencies || {}, dev_dependencies: manifest?.devDependencies || {},
    package_lock: fs.existsSync(localPath(cwd, path.relative(cwd, path.join(directory, "package-lock.json")).replaceAll(path.sep, "/"))),
    node_modules_present: fs.existsSync(modules),
    sqlite_setup_available: true, project_database: readProjectDbConfig({ projectDir: cwd }), approval_required: ["setup_environment", "install_dependencies", "setup_database"],
    note: "node_modules presence does not prove dependencies are current. Installers require explicit user approval. OS toolchains and services are not installed by these tools.",
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
    const manifestFile = capture(relative("package.json"));
    const manifest = readManifest(manifestFile);
    if (fs.statSync(manifestFile).size > 32 * 1024) throw new Error("Manifest approval is limited to 32 KB.");
    if (manifest.workspaces) throw new Error("Workspace installs need a workspace-wide setup plan; this installer supports standalone npm packages.");
    // npm may otherwise discover an enclosing workspace and mutate its lock.
    for (let parent = path.dirname(directory); parent !== path.dirname(parent); parent = path.dirname(parent)) {
      const file = path.join(parent, "package.json");
      if (fs.existsSync(file) && readManifest(file).workspaces) throw new Error("Nested npm workspace installs are not supported.");
    }
    if (manifest.packageManager && !String(manifest.packageManager).startsWith("npm@")) throw new Error("This package declares a different package manager; npm installation is unavailable.");
    for (const name of ["yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "npm-shrinkwrap.json"]) {
      if (fs.existsSync(capture(relative(name)))) throw new Error(`Resolve the existing ${name} package-manager contract before using npm setup.`);
    }
    const lockFile = capture(relative("package-lock.json"));
    if (fs.existsSync(capture(relative(".npmrc")))) proposal.npmrc = relative(".npmrc");
    assertWritable(manifestFile, context);
    assertWritable(lockFile, context);
    localPath(cwd, relative("node_modules"), { dependencyDirectory: true });
    const ignored = await listIgnoredRepoPaths(cwd, [relative("package.json"), relative("package-lock.json"), `${relative("node_modules")}/.posse-setup-probe`]);
    if (ignored.some((item) => item.path === relative("package.json") || item.path === relative("package-lock.json"))) throw new Error("Package manifests and lockfiles must be committable; fix repository ignore rules first.");
    if (!ignored.some((item) => item.path.endsWith("/.posse-setup-probe"))) throw new Error("Ignore node_modules/ in repository policy before requesting installation.");
    const npm = findCommandOnPath("npm");
    if (!npm) throw new Error("npm is unavailable on this machine. Install Node.js/npm, restart Posse, then request dependency installation.");
    proposal.directory = directory;
    proposal.command = npm;
    proposal.argv = ["install", "--prefix", directory, "--global=false", "--workspaces=false", "--package-lock=true", "--include=dev", "--no-audit", "--no-fund", `--ignore-scripts=${args.lifecycle_scripts !== true}`];
    proposal.manifest = manifest;
    proposal.changes = [relative("package-lock.json"), `${relative("node_modules")}/`];
    proposal.lifecycle_scripts = args.lifecycle_scripts === true;
  } else if (tool === "setup_database") {
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
    if (proposal.connection_file) proposal.changes.push(proposal.connection_file.path);
  } else throw new Error("Unknown environment setup tool.");
  proposal.digest = crypto.createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
  return proposal;
}

export function environmentSetupQuestion(proposal) {
  if (proposal.tool === "setup_environment") return planningEnvironmentQuestion(proposal);
  const operation = proposal.tool === "install_dependencies"
    ? [`Command: ${JSON.stringify([proposal.command, ...proposal.argv])}`, `Lifecycle scripts: ${proposal.lifecycle_scripts ? "ENABLED — dependency and project scripts execute with your user permissions" : "disabled"}.`,
      ...(proposal.npmrc ? [`npm configuration: ${proposal.npmrc} applies to this install (registry, authentication and git settings). Review it before approving; changing it invalidates this approval.`] : []),
      `Manifest: ${JSON.stringify(proposal.manifest, null, 2)}`]
    : ["Operation: create a new local SQLite database (no existing data is modified).", `Database: ${proposal.database}`, `SQL schema:\n${proposal.sql || "(empty database)"}`,
      ...(proposal.connection_file ? [`New connection module (review source; setup does not execute it):\n${JSON.stringify(proposal.connection_file, null, 2)}\nCommit this source with the application; configuration values stay local.`] : [])];
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
      const spec = commandSpawnSpec(proposal.command, proposal.argv);
      const result = await runCommand(spec.command, spec.args, { cwd: proposal.directory, signal, windowsVerbatimArguments: spec.windowsVerbatimArguments, timeoutMs: ENVIRONMENT_SETUP_STEP_TIMEOUT_MS });
      return { ...result, changes: proposal.changes, message: result.ok ? "Dependencies installed. Commit the scoped manifest and lockfile with the implementation." : "Installation did not complete; partial dependency/lockfile changes may remain. A retry requires new approval." };
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
      if (proposal.connection_file) {
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
