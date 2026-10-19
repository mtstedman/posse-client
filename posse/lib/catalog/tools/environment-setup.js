// Human authorization for local application setup is independent of file scope.
import { PROJECT_DB_PERMISSIONS } from "../project-db.js";
export const ENVIRONMENT_SETUP_REVIEW_TYPE = "environment_setup";
export const ENVIRONMENT_SETUP_ACTIONS = Object.freeze(["approve", "reject"]);
export const ENVIRONMENT_SETUP_TOOLS = Object.freeze(["install_dependencies", "setup_database", "setup_environment"]);
export const ENVIRONMENT_PACKAGE_MANAGERS = Object.freeze(["npm", "composer"]);
export const DATABASE_ENV_KEYS = Object.freeze(["DATABASE_URL", "DB_DATABASE", "DB_CONNECTION"]);

export const DATABASE_CONNECTION_FILE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["path", "content"],
  description: "Optional new application connection module in the project's language. Supply complete minimal source that reads configuration through environment variables or the framework's config loader. Include its driver/loader dependencies in the approved installation. Contains no credentials, copied .env values, machine-specific paths, configuration logging, migrations or setup commands. Reuse an existing connector by omitting this field. Source is reviewed and written, not executed by setup.",
  properties: {
    path: { type: "string", minLength: 1, description: "New committable source file, e.g. src/db/connection.ts, src/Database.php or app/database.py. Existing files are preserved." },
    content: { type: "string", minLength: 1, maxLength: 16384, description: "Complete connection module source; reference variable names without substituting their values. Export a reusable connection function and document its import/use. Validate it with the application's normal checks." },
  },
};

// One setup tool call waits for the user's decision, then runs the approved
// installers before it returns. Both phases are bounded so the whole call fits
// the MCP transport; the live window also bounds the job watchdog exemption.
export const ENVIRONMENT_SETUP_APPROVAL_TIMEOUT_MS = 10 * 60_000;
export const ENVIRONMENT_SETUP_STEP_TIMEOUT_MS = 10 * 60_000;
export const ENVIRONMENT_SETUP_INSTALL_BUDGET_MS = 30 * 60_000;
// Another installer in the same checkout releases its lock within a step; an
// approval is not spent waiting a few minutes for it.
export const ENVIRONMENT_SETUP_LOCK_WAIT_MS = 5 * 60_000;
// Re-validation, the setup commit (its worker allows five minutes), and
// database provisioning after the installers.
export const ENVIRONMENT_SETUP_FINALIZE_SLACK_MS = 10 * 60_000;
export const ENVIRONMENT_SETUP_LIVE_MAX_MS = ENVIRONMENT_SETUP_APPROVAL_TIMEOUT_MS + ENVIRONMENT_SETUP_LOCK_WAIT_MS
  + ENVIRONMENT_SETUP_INSTALL_BUDGET_MS + ENVIRONMENT_SETUP_FINALIZE_SLACK_MS;
// Watchdog credit for live setup calls in one dispatch: an initial batch and
// one revision. Further requests count as runtime again.
export const ENVIRONMENT_SETUP_RUNTIME_CREDIT_CAP_MS = 2 * ENVIRONMENT_SETUP_LIVE_MAX_MS;

export const TOOL_SETUP_ENVIRONMENT = {
  type: "function", name: "setup_environment",
  description: "Before development, propose an ordered npm/Composer batch and optional local SQLite database for explicit user approval. Initializes manifests, installs packages, creates database environment variables and portable examples, registers approved Posse database permissions, and commits setup source files in the primary checkout. Live .env/database files remain ignored. Scripts/plugins default off. Wait for a successful setup commit before handing off development. No arbitrary shell commands. Installed manifests are authoritative and must not be planned as files_to_create.",
  parameters: {
    type: "object", additionalProperties: false, required: ["reason", "steps"],
    properties: {
      reason: { type: "string", minLength: 1, maxLength: 1000 },
      steps: {
        type: "array", minItems: 0, maxItems: 12,
        items: {
          type: "object", additionalProperties: false, required: ["manager"],
          properties: {
            manager: { type: "string", enum: ENVIRONMENT_PACKAGE_MANAGERS },
            path: { type: "string", description: "Package directory relative to the primary checkout, default ." },
            packages: { type: "array", maxItems: 50, items: {
              type: "object", additionalProperties: false, required: ["name"],
              properties: { name: { type: "string" }, version: { type: "string", description: "Registry version/constraint; default *. No URLs or local paths." } },
            } },
            dev: { type: "boolean", description: "Save these packages as development dependencies." },
            lifecycle_scripts: { type: "boolean", description: "Enable project/dependency scripts in this step; requires explicit approval. Default false." },
            plugins: { type: "boolean", description: "Composer only: enable plugins allowed by Composer configuration. Default false." },
          },
        },
      },
      database: {
        type: "object", additionalProperties: false, required: ["path"],
        description: "Optional new local SQLite database, shared by application development worktrees. Use steps: [] for database-only setup. Creates DATABASE_URL, DB_DATABASE and DB_CONNECTION in ignored .env files and registers Posse access after approval. Preserves existing databases and connection registrations.",
        properties: {
          path: { type: "string", minLength: 1, description: "Repo-relative .sqlite/.sqlite3/.db file, e.g. data/app.sqlite. Ignored automatically." },
          schema_path: { type: "string", description: "Optional existing CREATE TABLE/INDEX SQL file to initialize and commit. Otherwise developers create the schema using approved DB access or application migrations." },
          env_files: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string" }, description: "Repo-relative .env destinations, default [.env]. Preserve other variables; conflicting DB values block setup. Each gets a committed database.env.example." },
          connection_file: DATABASE_CONNECTION_FILE_SCHEMA,
          permissions: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: PROJECT_DB_PERMISSIONS }, description: "Posse database permissions shown for explicit approval. Default [read]. Request read and write when developers need to initialize schema or modify data." },
        },
      },
    },
  },
};

const projectPath = { type: "string", description: "Repository-relative package directory; defaults to the job worktree root." };
export const TOOL_INSPECT_ENVIRONMENT = {
  type: "function",
  name: "inspect_environment",
  description: "Inspect local Node/npm and PHP/Composer availability, manifests, dependencies, lockfiles and installation state without installing anything. Planner inspection targets the primary checkout used for dependency batches.",
  parameters: { type: "object", properties: { path: projectPath }, additionalProperties: false },
};
export const TOOL_INSTALL_DEPENDENCIES = {
  type: "function",
  name: "install_dependencies",
  description: "Request explicit user approval to install the dependencies declared in package.json in this job's worktree. Edit package.json first and include package.json/package-lock.json in writable scope. Every invocation needs its own approval; scope auto-approval does not apply. Returns after approval and execution, rejection, or expiry. Accepts structured options for standalone npm packages.",
  parameters: {
    type: "object",
    properties: {
      path: projectPath,
      lifecycle_scripts: { type: "boolean", description: "Allow package lifecycle scripts (including native builds). Default false. The user must explicitly approve this in the installer proposal." },
      reason: { type: "string", minLength: 1, maxLength: 1000 },
    },
    required: ["reason"], additionalProperties: false,
  },
};
export const TOOL_SETUP_DATABASE = {
  type: "function",
  name: "setup_database",
  description: "Request explicit user approval to create a new local SQLite database at an ignored repo-relative path, optionally from a committed/scoped SQL schema file. Preserves existing databases and leaves Posse database permissions unchanged. Every invocation requires user approval. Keep the schema and application database path configuration in source control; runtime database files are local to this worktree.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "New local SQLite file, e.g. data/app.sqlite. Must be ignored by Git and outside Posse internals." },
      schema_path: { type: "string", description: "Optional repo-relative SQL file containing CREATE TABLE/INDEX statements. No external database access or destructive migrations." },
      connection_file: DATABASE_CONNECTION_FILE_SCHEMA,
      reason: { type: "string", minLength: 1, maxLength: 1000 },
    },
    required: ["path", "reason"], additionalProperties: false,
  },
};
