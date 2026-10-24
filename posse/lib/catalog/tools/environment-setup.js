// Human authorization for local application setup is independent of file scope.
import { PROJECT_DB_PERMISSIONS, PROJECT_DB_TYPES } from "../project-db.js";
import { LOCAL_DATABASE_PROVISION_TIMEOUT_MS } from "../local-database-provisioning.js";
export const ENVIRONMENT_SETUP_REVIEW_TYPE = "environment_setup";
export const ENVIRONMENT_SETUP_ACTIONS = Object.freeze(["approve", "reject"]);
export const ENVIRONMENT_SETUP_TOOLS = Object.freeze(["install_dependencies", "setup_database", "setup_environment"]);
export const ENVIRONMENT_PACKAGE_MANAGERS = Object.freeze(["npm", "pnpm", "yarn", "bun", "composer", "pip", "uv", "poetry", "bundler", "cargo", "go"]);
export const DATABASE_ENV_KEYS = Object.freeze(["DATABASE_URL", "DB_DATABASE", "DB_CONNECTION"]);

export const DATABASE_CONNECTION_FILE_SCHEMA = {
  type: "object", additionalProperties: false, required: ["path"],
  description: "Required application connector in the project's language. Supply path and complete minimal content for a new module, or path alone to reuse an existing nonempty source file. Read configuration through environment variables or the framework's config loader. Include driver/loader dependencies in the approved installation. Contains no credentials, copied .env values, machine-specific paths, configuration logging, migrations or setup commands. New source is reviewed and written, not executed by setup. Planning requires a reused connector to be committed and unchanged.",
  properties: {
    path: { type: "string", minLength: 1, description: "Committable source file, e.g. src/db/connection.ts, src/Database.php or app/database.py. Omit content to preserve and reuse an existing connector." },
    content: { type: "string", minLength: 1, maxLength: 16384, description: "Complete connection module source; reference variable names without substituting their values. Export a reusable connection function and document its import/use. Validate it with the application's normal checks." },
  },
};

export const DATABASE_SERVER_SCHEMA = {
  type: "object", additionalProperties: false, required: ["url_env"],
  description: "Postgres/MySQL server connection reference. Reference the connection URL by variable name; its value and credentials stay in the ignored local .env file. The server must already be running. URL query options are not supported by the project database driver.",
  properties: {
    env_file: { type: "string", description: "Repo-relative ignored .env containing the URL; default .env." },
    url_env: { type: "string", pattern: "^[A-Za-z_][A-Za-z0-9_]*$", description: "Name of the variable containing the connection URL, e.g. DATABASE_URL." },
    create_database: { type: "boolean", description: "Default false: verify and configure an existing database. True: create the URL's named database on the existing server; fails if it already exists. Requires server creation privileges. No service installation or migrations." },
  },
};

export const LOCAL_DATABASE_SERVER_SCHEMA = {
  type: "object", additionalProperties: false, required: ["database"],
  description: "Explicit local PostgreSQL/MySQL system provisioning on Ubuntu/Debian with root or non-interactive sudo. Installs the distribution package when missing, starts its service, creates a new database and dedicated local application user, and generates an ignored DATABASE_URL. Uses configured APT repositories; Debian MySQL needs a repository providing mysql-server. Existing accounts, data and service configuration are preserved. The approval includes system changes; partial installations remain after a failure.",
  properties: {
    database: { type: "string", pattern: "^[a-z][a-z0-9_]{0,62}$", description: "New application database, 1–63 lowercase letters, digits or underscores, beginning with a letter." },
    username: { type: "string", pattern: "^[a-z][a-z0-9_]{0,31}$", description: "Optional new application user; default is a stable project-specific name. Existing/reserved administrator names cause a stop. A random password is generated locally." },
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
export const ENVIRONMENT_SETUP_FINALIZE_SLACK_MS = 6 * 60_000 + LOCAL_DATABASE_PROVISION_TIMEOUT_MS;
// While the call waits on the user and then on installers, the requesting
// agent holds no model compute; the scheduler parks it and hands its slot to
// other work. Before the call returns, the agent takes a slot back through a
// scheduler grant, waiting at most this long so concurrency is restored
// rather than exceeded on resumption. The wait spends the live window's
// remaining time (it is not added to it: the whole call must still fit the
// MCP transport), and without a live scheduler to grant (stale heartbeat)
// the call returns at once.
export const ENVIRONMENT_SETUP_RESUME_WAIT_MAX_MS = 15 * 60_000;
export const ENVIRONMENT_SETUP_LIVE_MAX_MS = ENVIRONMENT_SETUP_APPROVAL_TIMEOUT_MS + ENVIRONMENT_SETUP_LOCK_WAIT_MS
  + ENVIRONMENT_SETUP_INSTALL_BUDGET_MS + ENVIRONMENT_SETUP_FINALIZE_SLACK_MS;
// Watchdog credit for live setup calls in one dispatch: an initial batch and
// one revision. Further requests count as runtime again.
export const ENVIRONMENT_SETUP_RUNTIME_CREDIT_CAP_MS = 2 * ENVIRONMENT_SETUP_LIVE_MAX_MS;

export const TOOL_SETUP_ENVIRONMENT = {
  type: "function", name: "setup_environment",
  description: "Before development, propose an ordered package-manager batch (npm, pnpm, yarn, bun, Composer, pip, uv, Poetry, Bundler, Cargo or Go) and optional SQLite/Postgres/MySQL database for explicit user approval. Initializes missing manifests, installs packages, creates database environment variables and portable examples, registers approved Posse database permissions, and commits setup source files including an application connector in the primary checkout. Choose an existing server reference or explicit local_server system provisioning. Live .env/database files remain ignored. Scripts/plugins default off where the manager can disable them. Wait for a successful setup commit before handing off development. No arbitrary shell commands. Installed manifests are authoritative and must not be planned as files_to_create.",
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
              properties: { name: { type: "string", description: "Registry package name: npm name, Composer vendor/name, PyPI name, gem, crate or Go module path." }, version: { type: "string", description: "Version or constraint in the manager's syntax; default latest. No URLs or local paths." } },
            } },
            dev: { type: "boolean", description: "Save these packages as development dependencies." },
            lifecycle_scripts: { type: "boolean", description: "Enable project/dependency scripts (pip and uv: source builds) in this step; requires explicit approval. Default false." },
            plugins: { type: "boolean", description: "Composer only: enable plugins allowed by Composer configuration. Default false." },
          },
        },
      },
      database: {
        type: "object", additionalProperties: false, required: ["connection_file"],
        description: "Database configuration shared by development worktrees. Use steps: [] for database-only setup. Defaults to a new local SQLite database (path required); postgres/mysql use either server or local_server. Creates DATABASE_URL, DB_DATABASE and DB_CONNECTION in ignored .env files and registers Posse access after approval. Preserves existing data and registrations.",
        properties: {
          type: { type: "string", enum: PROJECT_DB_TYPES, description: "Default sqlite. All registered project database engines are supported." },
          server: DATABASE_SERVER_SCHEMA,
          local_server: LOCAL_DATABASE_SERVER_SCHEMA,
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
  description: "Inspect the package managers a directory uses (detected from manifests and lockfiles), their availability, lockfiles and installation state without installing anything. Planner inspection targets the primary checkout used for dependency batches.",
  parameters: { type: "object", properties: { path: projectPath }, additionalProperties: false },
};
export const TOOL_INSTALL_DEPENDENCIES = {
  type: "function",
  name: "install_dependencies",
  description: "Request explicit user approval to install the dependencies declared in a package directory's manifest in this job's worktree, with its package manager (npm, pnpm, yarn, bun, Composer, pip, uv, Poetry, Bundler, Cargo or Go). The manager is detected from the manifest and lockfile; pass manager when several apply. Edit the manifest first and include its lockfile in writable scope (npm and Go also need the manifest). Every invocation needs its own approval; scope auto-approval does not apply. Returns after approval and execution, rejection, or expiry.",
  parameters: {
    type: "object",
    properties: {
      path: projectPath,
      manager: { type: "string", enum: [...ENVIRONMENT_PACKAGE_MANAGERS], description: "Package manager to run. Default: detected from the directory's manifests and lockfiles." },
      lifecycle_scripts: { type: "boolean", description: "Allow package scripts and builds (npm-family lifecycle scripts, Composer scripts, pip/uv source builds). Default false. The user must explicitly approve this in the installer proposal. Composer plugins stay disabled. Poetry and Bundler always run build code; Cargo and Go run none." },
      reason: { type: "string", minLength: 1, maxLength: 1000 },
    },
    required: ["reason"], additionalProperties: false,
  },
};
export const TOOL_SETUP_DATABASE = {
  type: "function",
  name: "setup_database",
  description: "Request explicit approval for SQLite/Postgres/MySQL setup with a reusable application connector. SQLite creates a new ignored worktree-local file and leaves Posse grants unchanged. Server engines use an existing server reference or explicit local_server system provisioning, write ignored environment settings and scoped portable examples, and register approved permissions. Existing data and registrations are preserved. Each invocation requires approval; existing-data migrations are managed separately.",
  parameters: {
    type: "object",
    properties: {
      type: { type: "string", enum: PROJECT_DB_TYPES, description: "Default sqlite; postgres/mysql use server or local_server; path/schema_path are SQLite-only." },
      server: DATABASE_SERVER_SCHEMA,
      local_server: LOCAL_DATABASE_SERVER_SCHEMA,
      env_files: { type: "array", minItems: 1, maxItems: 8, uniqueItems: true, items: { type: "string" }, description: "Server setup only: already ignored .env destinations, default [.env]. Corresponding database.env.example files need writable scope." },
      permissions: { type: "array", minItems: 1, uniqueItems: true, items: { type: "string", enum: PROJECT_DB_PERMISSIONS }, description: "Server setup only: explicit Posse grants, default [read]." },
      path: { type: "string", minLength: 1, description: "New local SQLite file, e.g. data/app.sqlite. Must be ignored by Git and outside Posse internals." },
      schema_path: { type: "string", description: "Optional repo-relative SQL file containing CREATE TABLE/INDEX statements. No external database access or destructive migrations." },
      connection_file: DATABASE_CONNECTION_FILE_SCHEMA,
      reason: { type: "string", minLength: 1, maxLength: 1000 },
    },
    required: ["reason", "connection_file"], additionalProperties: false,
  },
};
