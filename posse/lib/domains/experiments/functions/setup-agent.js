import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { EXPERIMENT_SETUP_SCHEMA, experimentPlanExample } from '../../../catalog/experiments.js';
import { EXPERIMENT_INIT_DEFAULTS as D } from '../../../catalog/experiment-workspace.js';
import { SETUP_AGENT_LIMITS as L } from '../../../catalog/experiment-setup-agent.js';
import { ExperimentSandbox } from '../classes/ExperimentSandbox.js';
import { validateExperimentSetup } from './setup.js';
import { validateNumericEvaluation } from './evaluation.js';
import { experimentDigest, fileDigest } from './snapshots.js';
import { validExperimentWorkPath } from './plan.js';

export async function setupTemplateFiles(template, source) {
  const files = {};
  for (const file of template.setup.plan.files) {
    const target = template.mapping?.find(item => item.source === file.path)?.target || file.path.slice(5);
    files[file.path] = Object.hasOwn(template.setup.files || {}, file.path) ? template.setup.files[file.path] : await source.load(`work/${target}`);
  }
  return files;
}

// Build a validation-only setup. Generated files must be new read-only adapters;
// all repository implementations are loaded from the frozen Git snapshot.
export async function materializeSetupTemplate(template, { source, corpus, selected, objective }) {
  if (!template || Object.keys(template).some(k => !['setup', 'mapping', 'checks', 'prepare', 'image'].includes(k))
    || !template.setup || Object.keys(template.setup).some(k => !['plan', 'files', 'prompt', 'guidelines'].includes(k))) throw new Error('Submit an init template with setup, mapping, checks and optional prepare/image only.');
  if (!template.setup.plan?.files?.length || !template.setup.plan.entrypoint || !template.setup.plan.metrics?.length) throw new Error('Template requires plan.files, entrypoint, metrics and integration checks.');
  const copy = structuredClone(template);
  const plan = { ...experimentPlanExample(), ...copy.setup.plan, objective };
  if (copy.setup.plan.evaluation || plan.files.some(f => f.source)) throw new Error('Reusable templates must omit evaluation and source bindings; initialization pins fresh sources.');
  if (plan.files.some(f => !validExperimentWorkPath(f.path) || f.mode === 'create')) throw new Error('Use valid work/ paths and read/modify modes; setup does not create production implementations.');
  if (!plan.files.some(f => f.mode === 'modify')) throw new Error('Declare at least one existing production file with mode:"modify" for later optimization. This is future optimizer scope, not a source edit during setup. Keep the generated JSONL adapter mode:"read".');
  if (copy.mapping !== undefined && (!Array.isArray(copy.mapping) || !copy.mapping.length)) throw new Error('Integration mapping must cover the production files declared mode:"modify" for later optimization. Omit mapping to derive it from work/ paths, or supply nonempty {source:"work/path",target:"path"} entries. Setup does not edit these files.');
  const generated = copy.setup.files || {}, files = {};
  if (Object.keys(generated).some(name => !plan.files.some(f => f.path === name && f.mode === 'read') || source.inventory.some(f => f.path === name))) throw new Error('Generated content is limited to new declared read-only adapters/support files, never repository source.');
  const mapping = copy.mapping || plan.files.filter(f => f.mode === 'modify').map(f => ({ source: f.path, target: f.path.slice(5) }));
  for (const file of plan.files) {
    const target = mapping.find(item => item.source === file.path)?.target || file.path.slice(5);
    files[file.path] = Object.hasOwn(generated, file.path) ? generated[file.path] : await source.load(`work/${target}`);
    if (typeof files[file.path] !== 'string') throw new Error('Adapter contents must be text.');
    file.source = { ref: Object.hasOwn(generated, file.path) ? 'setup-adapter' : `git:${source.base}:${target}`, digest: fileDigest(files[file.path]) };
  }
  if (!Object.hasOwn(generated, plan.entrypoint)) throw new Error('The entrypoint must be a generated read-only JSONL adapter.');
  plan.runtime = copy.setup.plan.runtime || { profile: /\.py$/.test(plan.entrypoint) ? 'python' : 'node', dependencies: [] };
  plan.acceptance = copy.setup.plan.acceptance || { mode: 'automatic', primary_metric: plan.metrics.find(m => m.role === 'goal')?.id, min_improvement: 0 };
  const evaluation = await corpus.evaluation(selected, plan.metrics);
  plan.evaluation = { ref: 'setup-validation', digest: experimentDigest(evaluation) };
  const setup = { schema: EXPERIMENT_SETUP_SCHEMA, prompt: copy.setup.prompt || objective,
    guidelines: copy.setup.guidelines || 'Preserve interfaces. Improve production algorithms generally; never infer or special-case evaluation answers.',
    plan, files, models: structuredClone(D.models), budget: { ...D.budget },
    integration: { strategy: 'direct', repo_path: source.repo, worktree_path: path.join(path.dirname(source.repo), 'posse-workbranch', path.basename(source.repo), 'setup-validation'),
      branch: 'experiment/setup-validation', trunk_branch: 'main', base_commit: source.base, commit_message: 'Apply accepted experiment', mapping,
      files: mapping.map(item => ({ path: item.target, mode: 'modify' })), checks: copy.checks, prepare: copy.prepare || [], budget: { ...D.integration_budget } } };
  const validation = validateExperimentSetup(setup);
  if (!validation.ok) throw new Error(validation.errors.join('; '));
  validateNumericEvaluation(plan, evaluation);
  // Keep no stale implementation bytes, hashes, evaluation binding, or run IDs.
  copy.setup.plan = { ...plan, files: plan.files.map(({ source: _source, ...file }) => file) };
  delete copy.setup.plan.evaluation;
  copy.setup.files = generated; copy.mapping = mapping; copy.corpus = selected;
  return { template: copy, setup, evaluation };
}

export async function smokeSetupTemplate(materialized, { image, sandbox = images => new ExperimentSandbox({ images }), signal, reserve, release }) {
  const { setup, evaluation } = materialized, profile = setup.plan.runtime.profile;
  const backend = sandbox({});
  const requestedImage = image || D.images[profile];
  let details;
  try { details = JSON.parse(await backend.command('/usr/bin/docker', ['image', 'inspect', requestedImage]))[0]; }
  catch {
    if (/^sha256:/.test(requestedImage)) throw new Error('Pinned runtime image is unavailable; restore the exact image before setup.');
    signal.throwIfAborted();
    await backend.command('/usr/bin/docker', ['pull', requestedImage], { timeout: 180000 });
    details = JSON.parse(await backend.command('/usr/bin/docker', ['image', 'inspect', requestedImage]))[0];
  }
  const images = { [profile]: details.Id }, runner = sandbox(images);
  await runner.preflight(setup.plan); signal.throwIfAborted();
  const runId = randomUUID(); reserve(runId, images);
  let unconfirmed = false;
  try {
    // Scores and expected answers stay inside the owner. This is only a
    // bounded protocol/runtime smoke, never an optimizer baseline or iteration.
    const smokeEvaluation = { ...evaluation, cases: (materialized.smokeCases || evaluation.cases).slice(0, L.smokeCases) };
    const smokePlan = { ...setup.plan, evaluation: { ref: 'setup-protocol-smoke', digest: experimentDigest(smokeEvaluation) } };
    await runner.run({ runId, plan: smokePlan, files: setup.files, evaluation: smokeEvaluation, signal, onObservation: () => {} });
    signal.throwIfAborted();
    return { ok: true, image: details.Id, requested_image: requestedImage, cases: smokeEvaluation.cases.length, case_ids: smokeEvaluation.cases.map(c => c.id), checks: 'configuration_validated_not_executed', kind: 'adapter_protocol_smoke' };
  } catch (error) { unconfirmed = error.cleanupUnconfirmed === true; throw error; }
  finally { release(unconfirmed); }
}
