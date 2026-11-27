import { validateExperimentSkills } from '../functions/skills.js';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { SETUP_AGENT_OPERATIONS as O, SETUP_AGENT_OBJECT as K, SETUP_AGENT_STATES as S, SETUP_AGENT_DEFAULTS as D, SETUP_AGENT_REQUEST } from '../../../catalog/experiment-setup-agent.js';
import { ExperimentSetupAgent } from './ExperimentSetupAgent.js';
import { ExperimentSetupSource } from './ExperimentSetupSource.js';
import { ExperimentSetupArtifacts } from './ExperimentSetupArtifacts.js';
import { ExperimentSandbox } from './ExperimentSandbox.js';
import { ExperimentRuntimeInstaller } from './ExperimentRuntimeInstaller.js';
import { runtimeRecipe, runtimeSourcesMatch } from '../functions/runtime-install.js';
import { discoverEnvironment, mergeEnvironmentRecipe } from '../functions/environment-build.js';
import { smokeSetupTemplate, materializeSetupTemplate, setupTemplateFiles } from '../functions/setup-agent.js';
import { experimentDigest } from '../functions/snapshots.js';
import { validateToolArguments } from '../../../shared/tools/functions/schema-validation.js';
import { EXPERIMENT_OBJECTS } from '../../../catalog/experiments.js';

export class ExperimentSetupService {
  constructor(service, { dispatch, source = repo => new ExperimentSetupSource(repo), artifacts = repo => new ExperimentSetupArtifacts(repo),
    sandbox = images => new ExperimentSandbox({ images }), smoke = smokeSetupTemplate, runtimeInstaller = () => new ExperimentRuntimeInstaller(), now = Date.now } = {}) {
    this.service = service; this.store = service.campaigns.store; this.dispatch = dispatch; this.source = source; this.artifacts = artifacts;
    this.sandbox = sandbox; this.validateSmoke = smoke; this.runtimeInstaller = runtimeInstaller; this.now = now; this.active = new Map(); this.smokeActive = null; this.installActive = null;
  }
  guard(signal) { signal?.throwIfAborted(); this.service.assertOwner(); if (this.service.stopping) throw new Error('Experiment owner is stopping.'); }
  save(record) { this.service.assertOwner(); record.updated_at = this.now(); this.store.put(K, record.id, record); }
  runtimeSummary(runtime) {
    return runtime ? { image: runtime.image, profile: runtime.profile, recipe_digest: runtime.recipe_digest, paths: runtime.paths, reused: runtime.reused } : null;
  }
  activeCount() { return new Set([...this.active.keys(), this.installActive, this.smokeActive].filter(Boolean)).size; }
  status(id) {
    const r = this.store.get(K, id); if (!r) throw new Error('Unknown setup preparation.');
    return { id: r.id, state: r.state, repo_path: r.repo, objective: r.objective, base_commit: r.base_commit || null, artifact: r.artifact || null,
      baseline_required: r.state === S.READY, skills: r.skills || {},
      selection: r.selection || null, reuse: r.reuse || null, child: r.child || null, usage: r.usage, combined_usage: this.combinedUsage(r), budget: r.config,
      pending_call: r.pending_call, validation_attempts: r.validation_attempts, last_action: r.last_action || null, error: r.error || null,
      runtime: this.runtimeSummary(r.runtime), environment: r.environment || null, install: r.install || null,
      usage_incomplete: r.pending_call || r.child?.usage_incomplete === true || r.child?.usage_unknown === true,
      ...(r.smoke ? { smoke: { id: r.smoke.id, cleanup_unconfirmed: r.smoke.cleanup_unconfirmed || false } } : {}) };
  }
  async request(operation, args) {
    if (!args || typeof args !== 'object' || Array.isArray(args)) throw new Error('Setup request must be an object.');
    if ([O.STATUS, O.STOP].includes(operation)) {
      if (Object.keys(args).some(k => k !== 'id')) throw new Error('Setup status/stop accepts only id.');
      this.status(args.id);
      if (operation === O.STOP) { this.guard(); this.active.get(args.id)?.controller.abort(new Error('Setup preparation cancelled by operator.')); }
      return this.status(args.id);
    }
    if (typeof args.repo_path !== 'string' || !path.isAbsolute(args.repo_path)) throw new Error('Choose an absolute repository path.');
    if (operation !== O.PREPARE && Object.keys(args).some(k => !['repo_path', ...(operation === O.GET ? ['artifact'] : ['offset'])].includes(k))) throw new Error('Invalid setup artifact lookup.');
    const corpus = await this.service.corpora.open(args.repo_path);
    if (operation === O.LIST) return this.artifacts(corpus.repo).list(args);
    if (operation === O.GET) return this.artifacts(corpus.repo).get(args.artifact);
    if (operation !== O.PREPARE) throw new Error('Unknown setup operation.');
    const checked = validateToolArguments({ name: 'setup-prepare', parameters: SETUP_AGENT_REQUEST }, args);
    if (!checked.ok) throw new Error(checked.message);
    if (args.contract && !args.corpus) throw new Error('A supplied contract must identify its immutable corpus.');
    const digest = experimentDigest(args), previous = this.store.list(K).find(r => r.request_key === args.idempotency_key);
    if (previous) { if (previous.digest !== digest) throw new Error('Setup idempotency conflict.'); return this.status(previous.id); }
    this.guard();
    const record = { id: randomUUID(), repo: corpus.repo, objective: args.objective, request_key: args.idempotency_key, digest, state: S.RUNNING,
      config: { ...D, ...args.budget, model: args.model || D.model, reasoning_effort: args.reasoning_effort || D.reasoning_effort },
      skills: validateExperimentSkills(args.skills || {}), skills_explicit: args.skills !== undefined, usage: { model_calls: 0, tokens: 0, spend_usd: 0 }, pending_call: false, validation_attempts: 0 };
    record.deadline_at = this.now() + record.config.wall_seconds * 1000;
    this.save(record);
    const controller = new AbortController(), task = { controller, promise: null }; this.active.set(record.id, task);
    const timer = setTimeout(() => controller.abort(Object.assign(new Error('Setup wall budget exhausted.'), { code: 'setup_budget' })), record.config.wall_seconds * 1000);
    task.promise = Promise.resolve().then(async () => {
      try {
        const source = await this.source(record.repo).open(); record.base_commit = source.base;
        const environment = args.image ? { state: 'provided', recipe: null, projects: [], issues: [], digest: experimentDigest({ image: args.image }) } : await discoverEnvironment(source, args.environment);
        record.environment = { state: environment.state, digest: environment.digest, projects: environment.projects.map(({ manager, root }) => ({ manager, root })), issues: environment.issues };
        this.guard(controller.signal); this.save(record);
        if (!await this.tryReuse(record, args, controller.signal, source, environment)) {
          if (environment.recipe) await this.installDeps(record, environment.recipe, source, controller.signal);
          await new ExperimentSetupAgent(this, { dispatch: this.dispatch }).run(record, args, controller.signal, source);
        }
      }
      catch (error) {
        record.state = controller.signal.aborted ? (controller.signal.reason?.code === 'setup_budget' ? S.BUDGET : S.CANCELLED) : S.BLOCKED;
        record.error = String(error.message).slice(0, 2000);
      } finally {
        clearTimeout(timer);
        try { this.save(record); } catch { /* Replacement owner reconciles interruption; never replay paid work. */ }
        this.active.delete(record.id);
      }
    });
    return this.status(record.id);
  }
  charge(record, stats) {
    if (!Number.isFinite(stats?.costUsd) || stats.costUsd < 0 || !Number.isFinite(stats?.inputTokens) || stats.inputTokens < 0 || !Number.isFinite(stats?.outputTokens) || stats.outputTokens < 0) throw new Error('Model usage unknown; setup cannot make further paid calls.');
    record.usage.tokens += stats.inputTokens + stats.outputTokens; record.usage.spend_usd += stats.costUsd; record.pending_call = false;
  }
  combinedUsage(record) { return Object.fromEntries(['model_calls', 'tokens', 'spend_usd'].map(k => [k, record.usage[k] + (record.child?.usage?.[k] || 0)])); }
  async tryReuse(record, request, signal, source, environment) {
    const artifacts = this.artifacts(record.repo), corpus = await this.service.corpora.open(record.repo), candidates = [];
    let page = await artifacts.list();
    for (let pages = 0; pages < 10; pages++) {
      candidates.push(...page.artifacts.filter(a => a.objective === request.objective.slice(0, 240)));
      if (page.next_offset === null) break;
      page = await artifacts.list({ offset: page.next_offset });
    }
    const matching = [];
    for (const candidate of candidates) {
      const artifact = await artifacts.get(candidate.artifact);
      if (artifact.template.setup.plan.objective !== request.objective || (request.image && ![artifact.validation.image, artifact.validation.requested_image].includes(request.image))) continue;
      if (environment?.recipe && environment.recipe.profile !== artifact.template.setup.plan.runtime.profile) continue;
      const bound = artifact.template.corpus;
      if (request.corpus && (bound.experiment !== request.corpus.experiment || bound.corpus !== request.corpus.corpus)) continue;
      const current = await corpus.load(request.corpus || { experiment: bound.experiment, corpus: bound.corpus });
      const prior = await corpus.load(bound);
      if (experimentDigest(current.contract) !== experimentDigest(prior.contract) || (request.contract && experimentDigest(request.contract) !== experimentDigest(current.contract))) continue;
      matching.push({ artifact, selected: { experiment: bound.experiment, corpus: bound.corpus, revision: current.revision } });
    }
    if (!matching.length || new Set(matching.map(m => `${m.selected.experiment}/${m.selected.corpus}`)).size > 1) return false;
    // Reuse one frozen source cache while comparing receipts: an older artifact
    // must not force another smoke when a newer exact receipt already exists.
    source ||= await this.source(record.repo).open(); record.base_commit = source.base;
    const compatible = [];
    for (const match of matching) {
      try {
        const files = await setupTemplateFiles(match.artifact.template, source);
        const runtimeMatches = !match.artifact.runtime || await runtimeSourcesMatch(match.artifact.runtime, source);
        const environmentMatches = !environment?.recipe || (match.artifact.runtime
          && experimentDigest(mergeEnvironmentRecipe(match.artifact.runtime.recipe, environment.recipe)) === experimentDigest(match.artifact.runtime.recipe));
        // An explicitly pinned image cannot silently acquire changed dependencies.
        if (!runtimeMatches && request.image) continue;
        compatible.push({ ...match, rank: Number(runtimeMatches && environmentMatches) * 4 + Number(experimentDigest(files) === match.artifact.validation.source_digest) * 2
          + Number(match.artifact.template.corpus.revision === match.selected.revision) });
      } catch { /* Removed/renamed bindings require the setup agent to adapt. */ }
    }
    if (!compatible.length) return false;
    compatible.sort((a, b) => b.rank - a.rank);
    const chosen = compatible[0];
    await this.reuse(record, chosen.artifact.artifact, chosen.selected, source, signal, 'Existing validated setup matches the objective, corpus interface and runtime.', request.image, environment?.recipe);
    return true;
  }
  async reuse(record, artifactId, selected, source, signal, reason, pinnedImage, environmentRecipe) {
    this.guard(signal);
    const artifacts = this.artifacts(record.repo), artifact = await artifacts.get(artifactId), corpus = await this.service.corpora.open(record.repo);
    const prior = await corpus.load(artifact.template.corpus), current = await corpus.load(selected);
    if (prior.id !== current.id || experimentDigest(prior.contract) !== experimentDigest(current.contract)) throw new Error('Artifact corpus interface changed; prepare a new compatible adapter.');
    let runtime = artifact.runtime;
    const targetRecipe = mergeEnvironmentRecipe(runtime?.recipe, environmentRecipe || {});
    if (runtime || environmentRecipe) {
      if (!runtime || experimentDigest(targetRecipe) !== experimentDigest(runtime.recipe) || !await runtimeSourcesMatch(runtime, source) || !await this.runtimeInstaller().isAvailable(runtime)) {
        if (pinnedImage) throw new Error('The explicitly pinned runtime is unavailable or has changed dependency bindings. Restore that exact image, or omit request.image in a new preparation to rebuild dependencies.');
        record.runtime = runtime;
        runtime = await this.installDeps(record, targetRecipe, source, signal);
      } else {
        record.runtime = { ...runtime, reused: true };
        if (record.environment) record.environment.state = 'reused';
      }
    }
    const skills = validateExperimentSkills(record.skills_explicit ? record.skills : artifact.template.setup.skills || {});
    record.skills = skills;
    const skillsChanged = experimentDigest(skills) !== experimentDigest(artifact.template.setup.skills || {});
    const runtimeChanged = Boolean(runtime && (runtime.image !== artifact.validation.image || runtime.recipe_digest !== artifact.runtime?.recipe_digest));
    const files = await setupTemplateFiles(artifact.template, source), sourceChanged = experimentDigest(files) !== artifact.validation.source_digest;
    const corpusChanged = selected.revision !== artifact.template.corpus.revision;
    record.selection = { corpus: selected, reason };
    record.reuse = { artifact: artifactId, reason, deterministic: true, source_changed: sourceChanged, corpus_changed: corpusChanged, runtime_changed: runtimeChanged,
      reused_components: ['adapter', ...(runtimeChanged ? [] : ['runtime']), 'checks', ...(sourceChanged || runtimeChanged ? [] : ['source_boundary']), ...(corpusChanged ? ['existing_verified_cases'] : ['corpus'])] };
    if (!sourceChanged && !corpusChanged && !runtimeChanged && record.objective === artifact.template.setup.plan.objective) {
      if (skillsChanged) {
        const updated = structuredClone(artifact); delete updated.artifact; delete updated.schema;
        updated.template.setup.skills = skills;
        const saved = await artifacts.save(updated, { guard: () => this.guard(signal) });
        record.artifact = saved.artifact;
      } else record.artifact = artifactId;
      record.state = S.READY; this.save(record);
      return { ready: true, artifact: record.artifact, validation_reused: true, reuse: record.reuse };
    }
    const template = structuredClone(artifact.template); delete template.corpus;
    template.setup.skills = skills;
    if (runtime) template.image = runtime.image;
    const materialized = await materializeSetupTemplate(template, { source, corpus, selected, objective: record.objective });
    const oldCases = new Set(prior.entries.map(e => e.case_id));
    const newCases = materialized.evaluation.cases.filter(c => !oldCases.has(c.id));
    if (!sourceChanged && !runtimeChanged) materialized.smokeCases = newCases;
    let validation;
    if (sourceChanged || runtimeChanged || newCases.length) {
      record.validation_attempts++; this.save(record);
      validation = await this.smoke(record, materialized, signal, runtime?.image || artifact.validation.image);
    } else validation = { ...artifact.validation, kind: 'validated_receipt_reused', cases: 0, case_ids: [] };
    this.guard(signal);
    const saved = await artifacts.save({ template: materialized.template, ...(runtime ? { runtime } : {}), ...(record.environment ? { environment: record.environment } : {}), validation: { ...validation, requested_image: runtime?.image || artifact.validation.requested_image, base_commit: source.base, source_digest: experimentDigest(files),
      evaluation_digest: materialized.setup.plan.evaluation.digest, reused_from: artifactId, reused_components: record.reuse.reused_components,
      validated_components: runtimeChanged ? ['runtime_adapter_boundary'] : sourceChanged ? ['source_adapter_boundary'] : newCases.length ? ['new_corpus_inputs'] : ['corpus_binding'] }, selection: record.selection, reuse: record.reuse }, { guard: () => this.guard(signal) });
    record.artifact = saved.artifact; record.state = S.READY; this.save(record);
    return { ready: true, artifact: saved.artifact, validation: saved.validation, reuse: record.reuse };
  }
  async installDeps(record, recipe, source, signal) {
    this.guard(signal);
    recipe = mergeEnvironmentRecipe(record.runtime?.recipe, recipe);
    if (this.installActive || this.smokeActive || this.service.active.size || this.service.campaigns.store.list(EXPERIMENT_OBJECTS.CAMPAIGNS).some(c => c.active_run)) throw new Error('Another owner sandbox run or dependency install must finish first.');
    const inputs = await runtimeRecipe(recipe, source), attempt = experimentDigest({ recipe: inputs.recipe, files: inputs.files });
    this.guard(signal);
    if (record.install_failures?.[attempt]) throw new Error(`This unchanged dependency recipe already failed; no installation was repeated. Correct the recipe or report the blocker. Previous error: ${record.install_failures[attempt]}`);
    if (this.installActive || this.smokeActive || this.service.active.size || this.service.campaigns.store.list(EXPERIMENT_OBJECTS.CAMPAIGNS).some(c => c.active_run)) throw new Error('Another owner sandbox run or dependency install must finish first.');
    this.installActive = record.id;
    if (record.environment) { record.environment.state = 'building'; this.save(record); }
    try {
      const runtime = await this.runtimeInstaller().install(recipe, { source, signal, previous: record.runtime, guard: () => this.guard(signal),
        reserve: reservation => { this.guard(signal); record.install = reservation; this.save(record); },
        release: ({ cleanup_unconfirmed }) => {
          if (cleanup_unconfirmed) { record.install.cleanup_unconfirmed = true; this.save(record); return; }
          record.install = null; this.save(record);
        } });
      this.guard(signal); record.runtime = runtime;
      if (record.environment) record.environment.state = runtime.reused ? 'reused' : 'ready';
      this.save(record); return runtime;
    } catch (error) {
      if (record.environment) record.environment.state = 'failed';
      if (!signal?.aborted) { (record.install_failures ||= {})[attempt] = String(error.message).slice(0, 1000); this.save(record); }
      throw error;
    } finally { if (!record.install) this.installActive = null; }
  }
  async prepareCorpus(record, args, signal) {
    this.guard(signal);
    const remaining = Object.fromEntries(['model_calls', 'tokens', 'spend_usd'].map(k => [k, record.config[k] - this.combinedUsage(record)[k]]));
    remaining.wall_seconds = Math.floor((record.deadline_at - this.now()) / 1000);
    if (Object.values(remaining).some(n => n <= 0)) throw new Error('No remaining setup budget for corpus preparation.');
    const preparation = { experiment: args.experiment, corpus: args.corpus, prompt: args.prompt,
      model: record.config.model, reasoning_effort: record.config.reasoning_effort,
      budget: remaining,
      ...(args.expected_revision ? { expected_revision: args.expected_revision } : {}), ...(args.contract ? { contract: args.contract } : {}) };
    const receipt = await this.service.corpora.prepare(await this.service.corpora.open(record.repo), { mode: args.mode, preparation, idempotency_key: `setup-corpus-${record.id}` });
    record.child = { id: receipt.id, state: receipt.state, corpus: receipt.corpus, reason: args.reason }; this.save(record);
    const child = this.service.corpora.active.get(receipt.id), abort = () => child?.controller.abort(signal.reason);
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    try { await child?.promise; } finally {
      signal.removeEventListener('abort', abort);
      const result = this.service.corpora.status(receipt.id);
      record.child = { id: result.id, state: result.state, corpus: result.corpus, usage: result.usage, usage_incomplete: result.usage_incomplete, error: result.error, reason: args.reason };
      this.save(record);
    }
    this.guard(signal);
    if (record.child.state === 'complete' && ['model_calls', 'tokens', 'spend_usd'].some(k => !Number.isFinite(record.child.usage?.[k]) || record.child.usage[k] < 0)) {
      record.child.usage_unknown = true;
      throw Object.assign(new Error('Child corpus model usage unknown; no further paid setup calls permitted.'), { code: 'model_usage_unknown' });
    }
    return record.child;
  }
  async smoke(record, materialized, signal, image) {
    return this.validateSmoke(materialized, { image, sandbox: this.sandbox, signal,
      reserve: (id, images) => {
        this.guard(signal);
        if (this.installActive || this.smokeActive || this.service.active.size || this.service.campaigns.store.list(EXPERIMENT_OBJECTS.CAMPAIGNS).some(c => c.active_run)) throw new Error('Another owner sandbox run or dependency install must finish before adapter validation.');
        this.smokeActive = record.id; record.smoke = { id, images }; this.save(record);
      },
      release: unconfirmed => {
        if (unconfirmed) { record.smoke.cleanup_unconfirmed = true; this.save(record); return; }
        record.smoke = null; this.smokeActive = null; this.save(record);
      } });
  }
  async recover() {
    for (const record of this.store.list(K)) {
      if (record.install) {
        try { await this.runtimeInstaller().cleanup(record.install.id); record.install = null; if (this.installActive === record.id) this.installActive = null; }
        catch { record.install.cleanup_unconfirmed = true; this.installActive = record.id; }
      }
      if (record.child?.id) {
        const child = this.service.corpora.status(record.child.id);
        record.child = { ...record.child, state: child.state, corpus: child.corpus, usage: child.usage, usage_incomplete: child.usage_incomplete, error: child.error };
      }
      if (record.smoke) {
        try { await this.sandbox(record.smoke.images).cleanup(record.smoke.id); record.smoke = null; if (this.smokeActive === record.id) this.smokeActive = null; }
        catch { record.smoke.cleanup_unconfirmed = true; this.smokeActive = record.id; }
      }
      if (record.state === S.RUNNING) { record.state = S.INTERRUPTED; record.error = record.pending_call ? 'Owner interrupted with model usage unknown; no automatic replay.' : 'Owner interrupted; no automatic setup replay.'; }
      this.save(record);
    }
  }
  async shutdown() { for (const task of this.active.values()) task.controller.abort(); await Promise.all([...this.active.values()].map(t => t.promise)); }
}
