import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { ENVIRONMENT_PACKAGE_MANAGERS } from "../../../catalog/tools/environment-setup.js";
import { localPath, fingerprint, readManifest } from "./environment-paths.js";
import { getJob, getWorkItem, listJobsByWorkItem } from "../../queue/functions/index.js";
import { primaryCheckoutFor, runVerificationPrerequisiteCommand } from "../../verification/functions/prerequisite-adapters.js";
import { findCommandOnPath, commandSpawnSpec } from "../../../shared/platform/functions/command-launch.js";
import { withDependencyInstallLock } from "../../../shared/concurrency/functions/dependency-install-lock.js";
import { gitCurrentHashAsync, gitExecAsync } from "../../git/functions/utils.js";
import { gitCommitAllAsync } from "../../git/functions/commit-scope.js";
import { listIgnoredRepoPaths } from "../../git/functions/ignored-paths.js";
import { guardToolWriteLock } from "../../queue/functions/write-lock-guard.js";
import { preparePlanningDatabase, databaseIgnoreRules, planningDatabaseQuestion, executePlanningDatabase, assertPlanningDatabaseReady } from "./planning-database.js";

export function planningEnvironmentRoot(cwd) {
  return fs.realpathSync(primaryCheckoutFor(cwd) || cwd);
}

function assertPlanning(context) {
  const job = getJob(context.jobId);
  const payload = JSON.parse(job?.payload_json || "{}");
  if (job?.job_type !== "plan" || job.status !== "running"
    || (payload.planner_role_mode && payload.planner_role_mode !== "normal")
    || payload._assessment_replan || getWorkItem(job.work_item_id)?.branch_name
    || listJobsByWorkItem(job.work_item_id).some((entry) => ["dev", "fix", "promote"].includes(entry.job_type)
      && !["canceled", "failed", "dead_lettered"].includes(entry.status))) {
    throw new Error("Batched environment setup requires initial planning, before development starts. Use a writable developer installer for an existing work-item branch.");
  }
  return job;
}

function packageArgument(pkg, manager) {
  const namePattern = manager === "npm" ? /^(?:@[a-z0-9._-]+\/)?[a-z0-9][a-z0-9._-]*$/u : /^[a-z0-9][a-z0-9_.-]*\/[a-z0-9][a-z0-9_.-]*$/u;
  const version = pkg?.version || "*";
  if (!namePattern.test(pkg?.name || "") || typeof version !== "string" || !/^[a-zA-Z0-9.*~^+<>= -]{1,100}$/u.test(version)) {
    throw new Error("Use registry package names and version constraints, not flags, paths, URLs, or shell syntax.");
  }
  return `${pkg.name}${manager === "npm" ? "@" : ":"}${version}`;
}

export async function preparePlanningEnvironment(args, context) {
  const job = assertPlanning(context);
  if (!Array.isArray(args.steps) || args.steps.length > 12 || (!args.steps.length && !args.database)) throw new Error("Provide 1–12 ordered setup steps, or a database setup with optional dependency steps.");
  if (typeof args.reason !== "string" || !args.reason.trim() || args.reason.length > 1000) throw new Error("A setup reason of 1–1000 characters is required.");
  const cwd = planningEnvironmentRoot(context.cwd);
  const head = await gitCurrentHashAsync(cwd);
  const readHead = await gitCurrentHashAsync(context.cwd);
  const priorSetup = listJobsByWorkItem(job.work_item_id).some((entry) => {
    const previous = JSON.parse(entry.payload_json || "{}");
    return previous.proposal?.tool === "setup_environment" && previous.execution?.status === "completed"
      && previous.execution.result?.commit === head && previous.execution.result?.read_head === readHead;
  });
  if (readHead !== head && !priorSetup) throw new Error("Planning checkout differs from the primary checkout. Refresh planning before requesting setup.");
  const branch = (await gitExecAsync(["branch", "--show-current"], cwd)).trim();
  if (!branch) throw new Error("The primary checkout must be on a branch before setup can be committed.");
  const proposal = { tool: "setup_environment", cwd, head, read_head: readHead, branch, args, reason: args.reason, inputs: {}, writes: {}, changes: [], steps: [], work_item_id: job.work_item_id };
  const previous = listJobsByWorkItem(job.work_item_id).sort((a, b) => b.id - a.id).map((entry) => JSON.parse(entry.payload_json || "{}"))
    .find((entry) => entry.proposal?.tool === "setup_environment" && entry.execution?.status === "completed" && entry.execution.result?.ok)?.execution.result;
  if (previous) {
    if (previous.cwd !== cwd) throw new Error("The prior setup belongs to a different checkout.");
    assertPlanningDatabaseReady(previous.database, cwd);
    proposal.previous = { files: previous.files, packages: previous.packages, database: previous.database };
  }
  const capture = (relative, { writable = false } = {}) => {
    const file = localPath(cwd, relative);
    proposal.inputs[relative] = fingerprint(file);
    if (writable) {
      const conflict = guardToolWriteLock("setup_environment", relative, cwd);
      if (conflict) throw new Error(conflict);
      proposal.changes.push(relative);
    }
    return file;
  };
  const ignorePath = capture(".gitignore", { writable: true });
  let ignore = fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "";
  if (ignore.length > 32 * 1024) throw new Error("Ignore-file approval is limited to 32 KB.");
  for (const step of args.steps) {
    if (!ENVIRONMENT_PACKAGE_MANAGERS.includes(step?.manager)) throw new Error("Only npm and Composer package installers are supported.");
    const directory = localPath(cwd, step.path || ".");
    const rel = (name) => path.relative(cwd, path.join(directory, name)).replaceAll(path.sep, "/");
    const npm = step.manager === "npm";
    const manifestName = npm ? "package.json" : "composer.json";
    const lockName = npm ? "package-lock.json" : "composer.lock";
    const dependencyName = npm ? "node_modules" : "vendor";
    const manifestFile = capture(rel(manifestName), { writable: true });
    const manifest = fs.existsSync(manifestFile) && fs.statSync(manifestFile).size > 0 ? readManifest(manifestFile) : npm ? { private: true } : { require: {} };
    if (JSON.stringify(manifest).length > 32 * 1024) throw new Error("Manifest approval is limited to 32 KB.");
    if (!fs.existsSync(manifestFile) || fs.statSync(manifestFile).size === 0) proposal.writes[rel(manifestName)] = `${JSON.stringify(manifest, null, 2)}\n`;
    capture(rel(lockName), { writable: true });
    localPath(cwd, rel(dependencyName), { dependencyDirectory: true });
    if (npm) {
      if (manifest.workspaces || (manifest.packageManager && !String(manifest.packageManager).startsWith("npm@"))) throw new Error("Batched npm setup supports standalone npm packages; use the repository's declared package manager for workspaces.");
      for (let parent = path.dirname(directory); parent !== path.dirname(parent); parent = path.dirname(parent)) {
        if (fs.existsSync(path.join(parent, "package.json")) && readManifest(path.join(parent, "package.json")).workspaces) throw new Error("Nested npm workspace installs are not supported.");
      }
      capture(rel(".npmrc"));
      for (const name of ["pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb", "npm-shrinkwrap.json"]) {
        if (fs.existsSync(capture(rel(name)))) throw new Error(`Resolve the existing ${name} package-manager contract first.`);
      }
    } else {
      // Keep both installed packages and generated executable proxies inside
      // the reviewed directory even when the project has custom config.
      if ((manifest.config?.["vendor-dir"] && manifest.config["vendor-dir"] !== "vendor")
        || (manifest.config?.["bin-dir"] && manifest.config["bin-dir"] !== "vendor/bin")) throw new Error("Composer setup requires the standard vendor/ and vendor/bin paths.");
    }
    const packages = step.packages || [];
    if (!Array.isArray(packages) || packages.length > 50) throw new Error("Each step accepts at most 50 packages.");
    const packageArgs = packages.map((pkg) => packageArgument(pkg, step.manager));
    const command = findCommandOnPath(step.manager);
    if (!command) throw new Error(`${step.manager} is unavailable. Install its toolchain and restart Posse before requesting setup.`);
    const scripts = step.lifecycle_scripts === true;
    const plugins = !npm && step.plugins === true;
    const argv = npm
      ? ["install", "--prefix", directory, "--global=false", "--workspaces=false", "--package-lock=true", "--package-lock-only=false", "--dry-run=false", "--include=prod", "--include=dev", "--include=optional", "--no-audit", "--no-fund", `--ignore-scripts=${!scripts}`, ...(packageArgs.length ? [step.dev ? "--save-dev" : "--save-prod", "--", ...packageArgs] : [])]
      : [packageArgs.length ? "require" : "install", "--working-dir", directory, "--no-interaction", "--no-progress", ...(!scripts ? ["--no-scripts"] : []), ...(!plugins ? ["--no-plugins"] : []), ...(step.dev && packageArgs.length ? ["--dev"] : []), ...(packageArgs.length ? ["--", ...packageArgs] : [])];
    const ignoreRule = `/${rel(dependencyName).replace(/[\[\]*? ]/gu, "\\$&")}/`;
    if (!ignore.split(/\r?\n/u).includes(ignoreRule)) ignore = `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${ignoreRule}\n`;
    const env = npm ? {} : {
      COMPOSER: path.join(directory, "composer.json"), COMPOSER_VENDOR_DIR: path.join(directory, "vendor"),
      COMPOSER_BIN_DIR: path.join(directory, "vendor", "bin"), COMPOSER_NO_DEV: "0",
    };
    proposal.steps.push({ env, manager: step.manager, path: step.path || ".", directory, command, argv, scripts, plugins, manifest, dependency_path: rel(dependencyName) });
  }
  if (args.database) {
    proposal.database = await preparePlanningDatabase(args.database, cwd, capture, proposal.writes);
    for (const rule of databaseIgnoreRules(proposal.database)) {
      if (!ignore.split(/\r?\n/u).includes(rule)) ignore = `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${rule}\n`;
    }
  }
  proposal.changes = [...new Set(proposal.changes)];
  for (const [relative, expected] of Object.entries(proposal.previous?.files || {})) {
    if (proposal.changes.includes(relative)) continue;
    if (fingerprint(localPath(cwd, relative)) !== expected) throw new Error(`Previously approved setup file changed: ${relative}. Reconcile it in the new batch.`);
  }
  if ((await listIgnoredRepoPaths(cwd, proposal.changes)).length) throw new Error("Setup manifests, locks and .gitignore must be committable. Fix repository ignore policy first.");
  if (ignore !== (fs.existsSync(ignorePath) ? fs.readFileSync(ignorePath, "utf8") : "")) proposal.writes[".gitignore"] = ignore;
  proposal.digest = crypto.createHash("sha256").update(JSON.stringify(proposal)).digest("hex");
  return proposal;
}

export function planningEnvironmentQuestion(proposal) {
  return ["Approve this complete dependency setup batch before development?", `Reason: ${proposal.reason}`, `Primary checkout: ${proposal.cwd}`, ...proposal.steps.map((step, i) => [
    `${i + 1}. ${JSON.stringify([step.command, ...step.argv])}`,
    `Scripts: ${step.scripts ? "ENABLED (run with your user permissions)" : "disabled"}; Composer plugins: ${step.plugins ? "ENABLED" : "disabled"}.`,
    `Environment overrides: ${JSON.stringify(step.env)}`,
    `Current manifest: ${JSON.stringify(step.manifest, null, 2)}`,
  ].join("\n")), ...planningDatabaseQuestion(proposal.database), `Create/update before installing: ${JSON.stringify(proposal.writes, null, 2)}`,
  `Commit only these setup files locally on ${proposal.branch}: ${proposal.changes.join(", ")}. No push or deployment.`,
  "Steps run in order and stop on the first failure. Partial changes are preserved for inspection. Rejection runs nothing; any retry requires new approval."].join("\n\n");
}

export async function executePlanningEnvironment(proposal, context, { signal, beforeExecute = () => {}, runCommand = runVerificationPrerequisiteCommand, commit = gitCommitAllAsync } = {}) {
  return withDependencyInstallLock(proposal.cwd, async () => {
    if (signal?.aborted) throw new Error("Environment setup canceled.");
    const fresh = await preparePlanningEnvironment(proposal.args, context);
    if (fresh.digest !== proposal.digest) throw new Error("Setup inputs changed after approval. Request a new approval.");
    for (const [relative, expected] of Object.entries(proposal.inputs)) {
      if (fingerprint(localPath(proposal.cwd, relative)) !== expected) throw new Error("Setup inputs changed after approval. Request a new approval.");
    }
    if (signal?.aborted) throw new Error("Environment setup canceled.");
    beforeExecute();
    for (const [relative, content] of Object.entries(proposal.writes)) {
      const file = localPath(proposal.cwd, relative);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, content);
    }
    for (const step of proposal.steps) {
      if (!(await listIgnoredRepoPaths(proposal.cwd, [`${step.dependency_path}/.posse-setup-probe`])).length) {
        throw new Error(`Repository policy must ignore ${step.dependency_path}/. Check nested ignore overrides before approving another batch.`);
      }
    }
    const results = [];
    for (const step of proposal.steps) {
      if (signal?.aborted) throw new Error("Environment setup canceled. Partial changes remain; development is blocked.");
      fs.mkdirSync(step.directory, { recursive: true });
      const spec = commandSpawnSpec(step.command, step.argv);
      const result = await runCommand(spec.command, spec.args, { cwd: step.directory, env: step.env, signal, windowsVerbatimArguments: spec.windowsVerbatimArguments, timeoutMs: 10 * 60 * 1000 });
      results.push(result);
      if (!result.ok) return { ok: false, status: "failed", results, message: "Setup stopped at the first failed installer. Partial changes remain. Development is blocked; a retry requires new approval." };
    }
    if (signal?.aborted) throw new Error("Environment setup canceled before commit; development is blocked.");
    for (const step of proposal.steps) {
      const dependencyPath = localPath(proposal.cwd, step.dependency_path, { dependencyDirectory: true });
      if (step.manager === "npm" && !fs.existsSync(dependencyPath)) {
        const manifest = readManifest(path.join(step.directory, "package.json"));
        if (Object.keys({ ...manifest.dependencies, ...manifest.devDependencies }).length) throw new Error("npm returned success without installing the declared dependencies; development is blocked.");
        fs.mkdirSync(dependencyPath, { recursive: true });
      }
      if (step.manager === "composer" && !fs.existsSync(path.join(dependencyPath, "autoload.php"))) throw new Error("Composer did not produce an autoloader; development is blocked.");
    }
    const files = proposal.changes.filter((relative) => fs.existsSync(localPath(proposal.cwd, relative)));
    const result = await commit("posse: approved planning dependency setup", proposal.cwd, { modifyFiles: files, createFiles: files, deleteFiles: [], createRoots: [] }, {
      jobId: context.jobId, wiId: proposal.work_item_id, projectDir: proposal.cwd, expectedHead: proposal.head,
    });
    if (!result?.hash) throw new Error("Setup commit did not complete; development remains blocked.");
    const dirty = await gitExecAsync(["status", "--porcelain", "--", ...files], proposal.cwd);
    if (dirty.trim()) throw new Error("Setup files remain uncommitted; development remains blocked.");
    const database = await executePlanningDatabase(proposal.database, proposal.cwd, signal) || proposal.previous?.database;
    assertPlanningDatabaseReady(database, proposal.cwd);
    const packages = new Map((proposal.previous?.packages || []).map((entry) => [`${entry.manager}:${entry.path}`, entry]));
    for (const { manager, path: packagePath, dependency_path } of proposal.steps) packages.set(`${manager}:${packagePath}`, { manager, path: packagePath, dependency_path });
    return { ok: true, status: "completed", results, commit: result.hash, read_head: proposal.read_head, cwd: proposal.cwd,
      ...(database ? { database } : {}),
      files: { ...proposal.previous?.files, ...Object.fromEntries(files.map((relative) => [relative, fingerprint(localPath(proposal.cwd, relative))])) },
      packages: [...packages.values()],
      message: "Approved dependency batch installed and committed. Use these manifests and locks when planning development; do not recreate them.",
    };
  }, { waitMs: 30_000 });
}
