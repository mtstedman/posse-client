import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { FAILED_JOB_STATUSES } from "../../../catalog/job.js";
import { ENVIRONMENT_PACKAGE_MANAGERS, ENVIRONMENT_SETUP_INSTALL_BUDGET_MS, ENVIRONMENT_SETUP_LOCK_WAIT_MS, ENVIRONMENT_SETUP_STEP_TIMEOUT_MS } from "../../../catalog/tools/environment-setup.js";
import { localPath, fingerprint, readManifest } from "./environment-paths.js";
import { PACKAGE_MANAGERS, packageCommands, packageScriptsLine, packageSpecs, readPackageManifest, shownPackageInputs } from "./package-managers.js";
import { getJob, getWorkItem, listJobsByWorkItem } from "../../queue/functions/index.js";
import { primaryCheckoutFor, runVerificationPrerequisiteCommand } from "../../verification/functions/prerequisite-adapters.js";
import { commandSpawnSpec } from "../../../shared/platform/functions/command-launch.js";
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
      && !["canceled", ...FAILED_JOB_STATUSES].includes(entry.status))) {
    throw new Error("Batched environment setup requires initial planning, before development starts. Use a writable developer installer for an existing work-item branch.");
  }
  return job;
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
    const manager = PACKAGE_MANAGERS[step?.manager];
    if (!manager) throw new Error(`Use one of these package managers: ${ENVIRONMENT_PACKAGE_MANAGERS.join(", ")}.`);
    const directory = localPath(cwd, step.path || ".");
    const rel = (name) => path.relative(cwd, path.join(directory, name)).replaceAll(path.sep, "/");
    const manifestPath = rel(manager.manifest);
    const manifestFile = capture(manifestPath, { writable: true });
    let manifest;
    if (fs.existsSync(manifestFile) && fs.statSync(manifestFile).size > 0) {
      if (fs.statSync(manifestFile).size > 32 * 1024) throw new Error("Manifest approval is limited to 32 KB.");
      manifest = readPackageManifest(manager, manifestFile);
    } else if (proposal.writes[manifestPath] === undefined) {
      const initial = manager.initialManifest(directory);
      if (initial == null) throw new Error(`${manager.label} setup needs an existing ${manifestPath}. Let development create the project, then install with install_dependencies.`);
      proposal.writes[manifestPath] = initial;
    }
    // An earlier step in this batch may already have written the manifest.
    if (proposal.writes[manifestPath] !== undefined) manifest = manager.format === "json" ? JSON.parse(proposal.writes[manifestPath]) : proposal.writes[manifestPath];
    manager.validate(directory, manifest);
    for (const name of manager.inputs(directory)) capture(rel(name));
    const lock = manager.lockfile(directory);
    if (lock) capture(rel(lock), { writable: true });
    const installDirs = manager.dependencyDirs(directory, manifest);
    const dependencyDirs = installDirs.map(rel);
    for (const dir of dependencyDirs) localPath(cwd, dir, { dependencyDirectory: true });
    const configFiles = manager.configFiles.filter((name) => fs.existsSync(capture(rel(name)))).map(rel);
    const specs = packageSpecs(manager, step.packages || []);
    const command = manager.command();
    if (!command) throw new Error(`${manager.label} is unavailable. Install ${manager.toolchain} and restart Posse before requesting setup.`);
    const scripts = manager.scripts === "always" || (manager.scripts === "flag" && step.lifecycle_scripts === true);
    const plugins = manager.name === "composer" && step.plugins === true;
    const options = { dir: directory, manifest, command, scripts, plugins, dev: step.dev === true };
    let entries;
    if (!specs.length) entries = manager.install(options);
    else if (manager.editManifest) {
      proposal.writes[manifestPath] = manager.editManifest(proposal.writes[manifestPath] ?? manifest, specs);
      entries = manager.install(options);
    } else entries = manager.add(options, specs);
    manager.validateInstall({ ...options, manifest: proposal.writes[manifestPath] ?? manifest });
    for (const dir of dependencyDirs) {
      const ignoreRule = `/${dir.replace(/[\[\]*? ]/gu, "\\$&")}/`;
      if (!ignore.split(/\r?\n/u).includes(ignoreRule)) ignore = `${ignore}${ignore && !ignore.endsWith("\n") ? "\n" : ""}${ignoreRule}\n`;
    }
    proposal.steps.push({ manager: manager.name, path: step.path || ".", directory, commands: packageCommands(manager, entries, options), scripts, plugins,
      manifest: proposal.writes[manifestPath] !== undefined && manager.format === "text" ? proposal.writes[manifestPath] : manifest,
      other_manifests: shownPackageInputs(manager, directory, rel),
      install_dirs: installDirs, dependency_paths: dependencyDirs, dependency_path: dependencyDirs[0] || null, config_files: configFiles });
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
    `${i + 1}. ${step.manager} in ${step.path}:`,
    ...step.commands.map((entry) => `${JSON.stringify([entry.command, ...entry.argv])}${Object.keys(entry.env).length ? ` with environment ${JSON.stringify(entry.env)}` : ""}`),
    ...packageScriptsLine(PACKAGE_MANAGERS[step.manager], step.scripts, { plugins: step.plugins }),
    ...step.config_files.map((file) => `${PACKAGE_MANAGERS[step.manager].label} configuration: ${file} applies to this install (registry, authentication and install settings). Review it before approving; changing it invalidates this approval.`),
    `Current manifest: ${typeof step.manifest === "string" ? step.manifest || "(empty)" : JSON.stringify(step.manifest, null, 2)}`,
    ...Object.entries(step.other_manifests).map(([file, text]) => `Also installed from ${file}:\n${text || "(empty)"}`),
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
    // A batch that does not reach its commit puts the setup files back, so the
    // primary checkout stays mergeable and a revised batch starts clean.
    // Installed packages remain in their ignored directories.
    const originals = new Map(proposal.changes.map((relative) => {
      const file = localPath(proposal.cwd, relative);
      return [file, fs.existsSync(file) ? fs.readFileSync(file) : null];
    }));
    const restore = () => {
      for (const [file, content] of originals) {
        try { if (content == null) fs.rmSync(file, { force: true }); else fs.writeFileSync(file, content); } catch { /* the failure result still reports it */ }
      }
    };
    let committed = false;
    try {
      for (const [relative, content] of Object.entries(proposal.writes)) {
        const file = localPath(proposal.cwd, relative);
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, content);
      }
      for (const step of proposal.steps) {
        for (const dir of step.dependency_paths) {
          if (!(await listIgnoredRepoPaths(proposal.cwd, [`${dir}/.posse-setup-probe`])).length) {
            throw new Error(`Repository policy must ignore ${dir}/. Check nested ignore overrides before approving another batch.`);
          }
        }
      }
      const results = [];
      // The whole batch shares one budget so the tool call fits its deadline.
      const installDeadline = Date.now() + ENVIRONMENT_SETUP_INSTALL_BUDGET_MS;
      for (const step of proposal.steps) {
        if (signal?.aborted) throw new Error("Environment setup canceled; setup files were restored and development is blocked.");
        const remainingMs = installDeadline - Date.now();
        if (remainingMs <= 0) {
          restore();
          return { ok: false, status: "failed", results, message: "Setup exceeded its installer time budget before every step ran. Setup files were restored. Development is blocked; split the batch and request new approval." };
        }
        fs.mkdirSync(step.directory, { recursive: true });
        PACKAGE_MANAGERS[step.manager].prepareInstall(step.directory);
        for (const entry of step.commands) {
          const remaining = installDeadline - Date.now();
          const spec = commandSpawnSpec(entry.command, entry.argv);
          const result = remaining <= 0 ? { ok: false, status: "blocked", reason: "setup_budget_exhausted" }
            : await runCommand(spec.command, spec.args, { cwd: step.directory, env: entry.env, signal, windowsVerbatimArguments: spec.windowsVerbatimArguments, timeoutMs: Math.min(ENVIRONMENT_SETUP_STEP_TIMEOUT_MS, remaining) });
          results.push(result);
          if (!result.ok) {
            restore();
            return { ok: false, status: "failed", results, message: "Setup stopped at the first failed installer. Setup files were restored. Development is blocked; a retry requires new approval." };
          }
        }
      }
      if (signal?.aborted) throw new Error("Environment setup canceled before commit; development is blocked.");
      for (const step of proposal.steps) {
        const manager = PACKAGE_MANAGERS[step.manager];
        for (const dir of step.dependency_paths) localPath(proposal.cwd, dir, { dependencyDirectory: true });
        const installed = manager.format === "json" ? readManifest(path.join(step.directory, manager.manifest)) : null;
        const problem = manager.verify(step.directory, installed, step.install_dirs);
        if (problem) throw new Error(`${problem}; development is blocked.`);
      }
      const connector = proposal.database?.connection_file;
      if (connector?.existing && fingerprint(localPath(proposal.cwd, connector.path)) !== proposal.inputs[connector.path]) {
        throw new Error("The reused application connector changed during installation; request new approval.");
      }
      const files = proposal.changes.filter((relative) => fs.existsSync(localPath(proposal.cwd, relative)));
      const result = await commit("posse: approved planning dependency setup", proposal.cwd, { modifyFiles: files, createFiles: files, deleteFiles: [], createRoots: [] }, {
        jobId: context.jobId, wiId: proposal.work_item_id, projectDir: proposal.cwd, expectedHead: proposal.head,
      });
      if (!result?.hash) throw new Error("Setup commit did not complete; development remains blocked.");
      committed = true;
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
    } catch (error) {
      if (!committed) restore();
      throw error;
    }
  }, { waitMs: ENVIRONMENT_SETUP_LOCK_WAIT_MS });
}
