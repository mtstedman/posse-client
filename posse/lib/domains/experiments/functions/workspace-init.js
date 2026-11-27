import { experimentBudget } from './budget.js';
import { ExperimentCorpora } from '../classes/ExperimentCorpora.js';
import { ExperimentSetupArtifacts } from '../classes/ExperimentSetupArtifacts.js';
import { ExperimentSetupSource } from '../classes/ExperimentSetupSource.js';
import { runtimeSourcesMatch } from './runtime-install.js';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { gitExecAsync } from '../../git/functions/utils.js';
import { automationDataDir } from '../../automation/functions/paths.js';
import { ensurePosseGitInfoExcludeAsync } from '../../runtime/functions/ignore.js';
import { EXPERIMENT_SETUP_SCHEMA, EXPERIMENT_RUNTIME_SCHEMA, experimentPlanExample } from '../../../catalog/experiments.js';
import { EXPERIMENT_WORKSPACE_SCHEMA, EXPERIMENT_INIT_FIELDS, EXPERIMENT_INIT_DEFAULTS as D } from '../../../catalog/experiment-workspace.js';
import { ExperimentSandbox } from '../classes/ExperimentSandbox.js';
import { IntegrationWorkspace } from '../classes/IntegrationWorkspace.js';
import { validateExperimentSetup } from './setup.js';
import { validateNumericEvaluation } from './evaluation.js';
import { experimentDigest, fileDigest } from './snapshots.js';
import { integrationRelativePath } from './integration-config.js';
import { validExperimentWorkPath } from './plan.js';

export async function privateJson(filename, limit = 4194304) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.uid !== process.getuid() || (info.mode & 0o077) || info.size > limit) throw new Error(`Expected a private, owned regular file: ${filename}`);
  return JSON.parse(await fs.readFile(filename, 'utf8'));
}
async function privateDirectory(directory) {
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  const info = await fs.lstat(directory);
  if (!info.isDirectory() || info.isSymbolicLink() || info.uid !== process.getuid()
    || await fs.realpath(directory) !== directory) throw new Error(`Expected a private directory without symlinks: ${directory}`);
}
const write = (filename, value) => fs.writeFile(filename, JSON.stringify(value, null, 2) + '\n', { flag: 'wx', mode: 0o600 });

// Resolve the checked-out destination, even when invoked from a task worktree.
async function repository(cwd, requested, git) {
  const root = String(await git(['rev-parse', '--show-toplevel'], cwd)).trim();
  const listing = String(await git(['worktree', 'list', '--porcelain'], root));
  const worktrees = listing.trim().split(/\n\n/).map(block => ({
    path: block.match(/^worktree (.+)$/m)?.[1], branch: block.match(/^branch refs\/heads\/(.+)$/m)?.[1],
  }));
  const candidates = worktrees.filter(w => ['main', 'master'].includes(w.branch));
  const trunk = requested || (candidates.length === 1 ? candidates[0].branch : null);
  const target = worktrees.find(w => w.branch === trunk);
  if (!target) throw new Error('Specify trunk_branch naming a checked-out destination; main/master could not be selected unambiguously.');
  const repo = await fs.realpath(target.path);
  const base = String(await git(['rev-parse', 'HEAD'], repo)).trim();
  return { repo, base, trunk };
}

async function runtimeSource(request, repo) {
  if (request.runtime_path) return privateJson(path.resolve(request.runtime_path));
  for (const directory of [path.join(repo, '.posse', 'experiment-owner'), automationDataDir()]) {
    try { return await privateJson(path.join(directory, 'experiment-runtime.json')); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return { schema: EXPERIMENT_RUNTIME_SCHEMA, images: {}, evaluations: {} };
}

export async function initializeExperiment(request, { cwd = process.cwd(), git = gitExecAsync,
  budgetDefaults = experimentBudget, sandbox = images => new ExperimentSandbox({ images }), ignore = ensurePosseGitInfoExcludeAsync,
  stateRoot = path.join(os.homedir(), '.local', 'state', 'posse', 'experiment-owners') } = {}) {
  if (process.platform !== 'linux') throw new Error('Experiment execution currently requires Linux Docker and user systemd.');
  if (!request || Object.keys(request).some(key => !EXPERIMENT_INIT_FIELDS.includes(key)) || !/^[a-z0-9][a-z0-9-]{0,47}$/.test(request.name || '')) throw new Error('Use a unique lowercase experiment name and the fields in init-schema.');
  const { repo, base, trunk } = await repository(cwd, request.trunk_branch, git);
  if (request.artifact) {
    const artifact = await new ExperimentSetupArtifacts(repo).get(request.artifact);
    if (artifact.runtime) {
      const source = await new ExperimentSetupSource(repo, { git }).open();
      if (source.base !== base) throw new Error('Repository HEAD moved during runtime validation; initialize again against one frozen commit.');
      if (!await runtimeSourcesMatch(artifact.runtime, source)) throw new Error('Runtime dependency files changed. Run setup-prepare to install the changed dependencies and validate only the affected runtime boundary.');
    }
    if (Object.hasOwn(request, 'corpus') && experimentDigest(request.corpus) !== experimentDigest(artifact.template.corpus)) throw new Error('Setup artifact binds a different corpus revision. Prepare a compatible artifact.');
    if (Object.hasOwn(request, 'evaluation') || Object.hasOwn(request, 'runtime_path')) throw new Error('Artifact initialization uses its verified corpus and runtime.');
    const overrides = request.setup || {};
    if (Object.keys(overrides).some(k => !['budget', 'models', 'prompt', 'guidelines', 'plan', 'skills'].includes(k)) || Object.keys(overrides.plan || {}).some(k => !['max_iterations', 'acceptance'].includes(k))) throw new Error('Artifact setup overrides are limited to run budget/models/instructions, role-scoped skills and iteration/acceptance policy.');
    if (['mapping', 'checks', 'prepare'].some(k => Object.hasOwn(request, k)) || (Object.hasOwn(request, 'image') && request.image !== artifact.template.image)) throw new Error('Prepare a new artifact to change adapter bindings, checks or runtime.');
    request = { ...artifact.template, ...request, setup: { ...artifact.template.setup, ...overrides, plan: { ...artifact.template.setup.plan, ...overrides.plan } } };
  }
  const directory = path.join(repo, '.posse', 'experiments', request.name);
  try { await fs.lstat(directory); throw new Error('Experiment directory already exists; use its launch/status commands or choose a new name.'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (!request.corpus && !request.evaluation && !request.setup?.plan?.evaluation?.ref) return { ok: false, state: 'corpus_choice_required', ...(await new ExperimentCorpora(repo).choices()) };
  const supplied = structuredClone(request.setup || {});
  if (supplied.integration) throw new Error('init builds direct integration; provide mapping, checks and prepare at the top level. Use the raw setup route for agent adaptation.');
  const defaults = experimentPlanExample();
  const partial = supplied.plan || {};
  if (!partial.objective || !partial.entrypoint || !partial.files?.length || !partial.metrics?.length) throw new Error('Supply setup.plan.objective, entrypoint, files and metrics.');
  const plan = { ...defaults, ...partial, runtime: partial.runtime || { profile: /\.py$/.test(partial.entrypoint) ? 'python' : 'node', dependencies: [] } };
  plan.acceptance = partial.acceptance || { mode: 'automatic', primary_metric: plan.metrics.find(m => m.role === 'goal')?.id, min_improvement: 0 };
  const mapping = request.mapping || plan.files.filter(f => f.mode !== 'read').map(f => ({ source: f.path, target: f.path.slice(5) }));
  const files = { ...supplied.files };
  const scope = [];
  for (const file of plan.files) {
    if (!validExperimentWorkPath(file.path)) throw new Error('Invalid payload path.');
    const target = mapping.find(item => item.source === file.path)?.target || file.path.slice(5);
    if (!integrationRelativePath(target)) throw new Error('Invalid repository source path.');
    const entry = String(await git(['ls-tree', base, '--', target], repo)).trim();
    let source;
    if (entry) {
      if (!/^100(644|755) blob /.test(entry)) throw new Error(`Source must be a regular Git file: ${target}`);
      source = String(await git(['show', `${base}:${target}`], repo, { trim: false }));
    }
    if (!Object.hasOwn(files, file.path)) {
      if (source === undefined) throw new Error(`Supply initial contents for ${file.path}; no source exists at ${target}.`);
      files[file.path] = source;
    }
    if (file.mode !== 'read') {
      if (source !== undefined && files[file.path] !== source) throw new Error(`Initial payload differs from pinned repository source: ${target}`);
      if (String(await git(['status', '--porcelain', '--untracked-files=all', '--', target], repo)).trim()) throw new Error(`Commit or preserve pending edits to mapped source before initialization: ${target}`);
      scope.push({ path: target, mode: source === undefined ? 'create' : 'modify' });
    }
    if (file.mode !== 'create') {
      const digest = fileDigest(files[file.path]);
      if (file.source && file.source.digest !== digest) throw new Error(`Declared source digest changed: ${file.path}`);
      file.source = file.source || { ref: `git:${base}:${target}`, digest };
    }
  }
  const runtime = await runtimeSource(request, repo);
  if (runtime.schema !== EXPERIMENT_RUNTIME_SCHEMA) throw new Error('Invalid runtime configuration schema.');
  if (request.corpus && request.evaluation) throw new Error('Choose either a registered corpus or an inline evaluation.');
  const evaluation = request.corpus ? await new ExperimentCorpora(repo).evaluation(request.corpus, plan.metrics) : request.evaluation || runtime.evaluations?.[partial.evaluation?.ref];
  if (!evaluation) throw new Error('Supply evaluation cases/scorers, or a plan.evaluation.ref registered in the existing runtime.');
  const evaluationDigest = experimentDigest(evaluation);
  if (partial.evaluation?.digest && partial.evaluation.digest !== evaluationDigest) throw new Error('Declared evaluation digest changed.');
  plan.evaluation = { ref: partial.evaluation?.ref || request.name, digest: evaluationDigest };
  validateNumericEvaluation(plan, evaluation);
  const identity = experimentDigest([repo, request.name]).slice(0, 20);
  const owner = path.join(path.resolve(stateRoot), identity);
  if (Buffer.byteLength(path.join(owner, 'automation.sock')) > 103) throw new Error('Owner state path is too long for a Unix socket. Choose a shorter state root.');
  const worktree = path.join(path.dirname(repo), 'posse-workbranch', path.basename(repo), `experiment-${request.name}-${identity.slice(0, 8)}`);
  const setup = { ...supplied, schema: EXPERIMENT_SETUP_SCHEMA, prompt: supplied.prompt || plan.objective,
    guidelines: supplied.guidelines || 'Preserve the public interface. Use general improvements; do not infer or special-case hidden evaluation answers.',
    plan, files, ...(supplied.skills ? { skills: supplied.skills } : {}), models: { ...structuredClone(D.models), ...supplied.models }, budget: budgetDefaults(supplied.budget),
    integration: { strategy: 'direct', repo_path: repo, worktree_path: worktree, branch: `experiment/${request.name}-${identity.slice(0, 8)}`,
      trunk_branch: trunk, base_commit: base, commit_message: `Apply accepted experiment ${request.name}`, mapping, files: scope,
      checks: request.checks, prepare: request.prepare || [], budget: { ...D.integration_budget } } };
  const validation = validateExperimentSetup(setup);
  if (!validation.ok) throw new Error(`Invalid experiment setup: ${validation.errors.join('; ')}`);
  await new IntegrationWorkspace(setup.integration, { git }).validateBindings(files);
  const profile = plan.runtime.profile;
  const backend = sandbox({});
  const image = request.image || runtime.images?.[profile] || D.images[profile];
  let details;
  try { details = JSON.parse(await backend.command('/usr/bin/docker', ['image', 'inspect', image]))[0]; }
  catch {
    if (/^sha256:/.test(image)) throw new Error('Pinned runtime image is missing; restore it or explicitly select a new image.');
    await backend.command('/usr/bin/docker', ['pull', image], { timeout: 180000 });
    details = JSON.parse(await backend.command('/usr/bin/docker', ['image', 'inspect', image]))[0];
  }
  const pinned = { schema: EXPERIMENT_RUNTIME_SCHEMA, images: { [profile]: details.Id }, evaluations: { [plan.evaluation.ref]: evaluation } };
  await sandbox(pinned.images).preflight(plan);
  // No model or owner starts until every source, evaluation and runtime check passes.
  await ignore(repo);
  await privateDirectory(path.dirname(directory));
  await privateDirectory(path.dirname(owner));
  await fs.mkdir(owner, { mode: 0o700 }); // Exclusive: never replace another run's runtime.
  let created = false;
  try {
    await fs.mkdir(directory, { mode: 0o700 }); created = true;
    await write(path.join(owner, 'experiment-runtime.json'), pinned);
    const launch = { setup, setup_digest: validation.setup_digest, idempotency_key: `workspace-${identity}` };
    const manifest = { schema: EXPERIMENT_WORKSPACE_SCHEMA, owner, directory, repo_path: repo, base_commit: base,
      setup_digest: validation.setup_digest, runtime_digest: experimentDigest(pinned), idempotency_key: launch.idempotency_key };
    await write(path.join(directory, 'setup.json'), setup);
    await write(path.join(directory, 'launch.json'), launch);
    await write(path.join(directory, 'workspace.json'), manifest);
    return { ok: true, directory, base_commit: base, summary: validation.summary,
      commands: Object.fromEntries(['launch', 'status', 'progress', 'stop'].map(action => [action, `posse experiment ${action} '${directory.replaceAll("'", "'\\''")}'`])) };
  } catch (error) {
    if (created) await fs.rm(directory, { recursive: true, force: true });
    await fs.rm(owner, { recursive: true, force: true });
    throw error;
  }
}
