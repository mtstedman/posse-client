import fs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { gitExecAsync } from '../../git/functions/utils.js';
import { withWorktreeLockAsync } from '../../git/functions/worktree-locks.js';
import { ensurePosseGitInfoExcludeAsync } from '../../runtime/functions/ignore.js';
import { EXPERIMENT_CORPUS_SCHEMA, EXPERIMENT_CORPUS_EVALUATION_SCHEMA, EXPERIMENT_CASE_SCHEMA, EXPERIMENT_ANSWER_SCHEMA, EXPERIMENT_CORPUS_REGISTRY_SCHEMA, EXPERIMENT_CORPUS_PROFILE_PATTERN, EXPERIMENT_CORPUS_LIMITS as L } from '../../../catalog/experiment-corpus.js';
import { validCorpusFilename } from '../functions/corpus-inputs.js';
import { packCorpusResource, unpackCorpusResource, corpusHash as hash } from '../functions/corpus-archive.js';
import { experimentDigest } from '../functions/snapshots.js';
import { validateCorpusContract, scoreCorpusAnswer } from '../functions/corpus-scoring.js';
import { validateCorpusMeasurements } from '../functions/evaluation.js';
import { EXPERIMENT_LATENCY_METRIC as LATENCY } from '../../../catalog/experiment-measurement.js';

const name = value => typeof value === 'string' && /^[a-z0-9][a-z0-9-]{0,63}$/.test(value);
const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const json = value => JSON.stringify(value, null, 2) + '\n';

async function directory(target) {
  await fs.mkdir(target, { recursive: true, mode: 0o700 });
  if (await fs.realpath(target) !== target) throw new Error('Corpus directories must not contain symlinks.');
}
async function regular(filename, maxBytes) {
  const info = await fs.lstat(filename);
  if (!info.isFile() || info.isSymbolicLink() || info.size > maxBytes || await fs.realpath(filename) !== filename) throw new Error('Resource must be a bounded regular file without symlinks.');
  const bytes = await fs.readFile(filename);
  if (bytes.length > maxBytes) throw new Error('Resource grew beyond its byte limit.');
  return bytes;
}
async function readJson(filename) { return JSON.parse((await regular(filename, L.jsonBytes)).toString('utf8')); }
async function replaceJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try { await fs.writeFile(temporary, json(value), { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename); }
  finally { await fs.rm(temporary, { force: true }); }
}
async function immutableJson(filename, value) {
  const temporary = `${filename}.${randomUUID()}.tmp`;
  try {
    await fs.writeFile(temporary, json(value), { flag: 'wx', mode: 0o600 });
    try { await fs.link(temporary, filename); }
    catch (error) { if (error.code !== 'EEXIST') throw error; if (experimentDigest(await readJson(filename)) !== experimentDigest(value)) throw new Error('Immutable corpus record was modified.'); }
  } finally { await fs.rm(temporary, { force: true }); }
}

export class ExperimentCorpora {
  constructor(repo, { lock = fn => withWorktreeLockAsync(repo, repo, fn), ignore = ensurePosseGitInfoExcludeAsync } = {}) {
    this.repo = repo; this.root = path.join(repo, '.posse', 'experiments'); this.lock = lock; this.ignore = ignore;
  }
  static async open(cwd = process.cwd(), options = {}) {
    const git = options.git || gitExecAsync;
    const listing = String(await git(['worktree', 'list', '--porcelain'], cwd));
    const root = listing.match(/^worktree (.+)$/m)?.[1];
    if (!root) throw new Error('A Git project is required.');
    return new ExperimentCorpora(await fs.realpath(root), options);
  }
  paths(experiment, corpus) {
    if (!name(experiment) || !name(corpus)) throw new Error('Experiment and corpus names must be lowercase names with hyphens.');
    const root = path.join(this.root, experiment);
    return { root, inputs: path.join(root, 'inputs'), items: path.join(root, 'items'), answers: path.join(root, 'answers'),
      revisions: path.join(root, 'corpora', corpus), head: path.join(root, 'corpora', `${corpus}.json`), id: `${experiment}/${corpus}` };
  }
  async registry() {
    try {
      const registry = await readJson(path.join(this.root, 'corpora.json'));
      if (registry.schema !== EXPERIMENT_CORPUS_REGISTRY_SCHEMA || !Array.isArray(registry.corpora)) throw new Error('Invalid corpus registry.');
      return registry;
    } catch (error) { if (error.code !== 'ENOENT') throw error; return { schema: EXPERIMENT_CORPUS_REGISTRY_SCHEMA, corpora: [] }; }
  }
  async list() { return (await this.registry()).corpora; }
  async choices({ offset = 0 } = {}) {
    if (!Number.isInteger(offset) || offset < 0) throw new Error('Invalid corpus inventory offset.');
    const all = await this.list(), rows = [];
    for (const entry of all.slice(offset, offset + 50)) {
      const [experiment, corpus] = entry.id.split('/');
      const snapshot = await this.inspect({ experiment, corpus });
      const verified = snapshot.entries.filter(item => item.status === 'verified').length;
      rows.push([entry.id, snapshot.entries.length, verified, snapshot.entries.length - verified,
        snapshot.contract.fields.map(field => field.id), snapshot.entries.slice(0, 3).map(item => item.label.slice(0, 96)), snapshot.revision]);
    }
    return { project: this.repo, corpora: { columns: ['corpus', 'cases', 'verified', 'draft', 'metrics', 'examples', 'revision'], rows, total: all.length, offset, omitted: Math.max(0, all.length - offset - rows.length) },
      question: all.length ? 'Use an existing corpus, create a new one, or expand an existing corpus?' : 'No corpora are registered. Create a new corpus?',
      choices: all.length ? ['Use existing', 'Create new', 'Expand existing'] : ['Create new', 'Cancel'],
      instruction: 'Ask the user which action and corpus to use. Preparation is separate from testing. Do not infer a selection or include answer keys in test-agent context.' };
  }
  async load({ experiment, corpus, revision }) {
    const p = this.paths(experiment, corpus);
    if (revision !== undefined && !digest(revision)) throw new Error('Invalid corpus revision.');
    const snapshot = await readJson(revision ? path.join(p.revisions, `${revision}.json`) : p.head);
    const { revision: recorded, ...body } = snapshot;
    if (snapshot.schema !== EXPERIMENT_CORPUS_SCHEMA || snapshot.id !== p.id || recorded !== experimentDigest(body) || (revision && revision !== recorded)) throw new Error('Corpus revision identity changed.');
    validateCorpusContract(snapshot.contract);
    return snapshot;
  }
  async publish(p, contract, entries) {
    if (entries.length > L.items || new Set(entries.map(item => item.case_id)).size !== entries.length) throw new Error('Corpus has too many or duplicate cases.');
    const body = { schema: EXPERIMENT_CORPUS_SCHEMA, id: p.id, contract, entries: entries.sort((a, b) => a.case_id.localeCompare(b.case_id)) };
    const snapshot = { ...body, revision: experimentDigest(body) };
    if (Buffer.byteLength(json(snapshot)) > L.jsonBytes) throw new Error('Corpus manifest is too large.');
    await immutableJson(path.join(p.revisions, `${snapshot.revision}.json`), snapshot);
    const registry = await this.registry();
    const entry = { id: p.id, directory: p.root, revision: snapshot.revision, cases: entries.length };
    registry.corpora = [...registry.corpora.filter(c => c.id !== p.id), entry].sort((a, b) => a.id.localeCompare(b.id));
    await replaceJson(p.head, snapshot);
    await replaceJson(path.join(this.root, 'corpora.json'), registry);
    return snapshot;
  }
  async prepareInputs(args) {
    const p = this.paths(args.experiment, args.corpus);
    return this.lock(async () => {
      await this.ignore(this.repo);
      await directory(p.inputs); await directory(path.join(this.root, '.resources'));
      return p;
    });
  }
  async create({ experiment, corpus, contract }) {
    validateCorpusContract(contract); const p = this.paths(experiment, corpus);
    return this.lock(async () => {
      await this.ignore(this.repo);
      for (const target of [p.inputs, p.items, p.answers, p.revisions, path.join(this.root, '.resources')]) await directory(target);
      try { await fs.lstat(p.head); throw new Error('Corpus already exists; import or update it.'); }
      catch (error) { if (error.code !== 'ENOENT') throw error; }
      return this.publish(p, contract, []);
    });
  }
  async register(args) {
    if (args.revision) throw new Error('Registration uses the current corpus revision.');
    return this.lock(async () => {
      const snapshot = await this.load(args), p = this.paths(args.experiment, args.corpus);
      return this.publish(p, snapshot.contract, snapshot.entries);
    });
  }
  async resource(id) {
    if (!digest(id)) throw new Error('Invalid resource ID.');
    const filename = path.join(this.root, '.resources', `${id}.zip`);
    const manifest = await readJson(path.join(this.root, '.resources', `${id}.json`));
    if (manifest.resource_id !== id) throw new Error('Resource binding changed.');
    const bytes = await unpackCorpusResource(await regular(filename, L.resourceBytes + 1048576), manifest);
    let labels = []; try { labels = await readJson(path.join(this.root, '.resources', `${id}.labels.json`)); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    return { id, filename, manifest, bytes, label: labels[0] || 'Unlabeled resource', labels };
  }
  // Caller holds the project lock; archives and manifests are immutable.
  async saveResource(bytes, label) {
    const id = hash(bytes), filename = path.join(this.root, '.resources', `${id}.zip`);
    try { await fs.lstat(filename); await this.resource(id); }
    catch (error) {
      if (error.code !== 'ENOENT') throw error;
      const packed = await packCorpusResource(bytes);
      await immutableJson(path.join(this.root, '.resources', `${id}.json`), packed.manifest);
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try { await fs.writeFile(temporary, packed.archive, { flag: 'wx', mode: 0o600 }); await fs.rename(temporary, filename); }
      finally { await fs.rm(temporary, { force: true }); }
    }
    await this.labelResource(id, label);
    return { id, label, bytes: bytes.length };
  }
  async archive(filename, label, sha256) {
    const bytes = await regular(path.resolve(filename), L.resourceBytes);
    if (sha256 && hash(bytes) !== sha256) throw new Error('Resource checksum changed.');
    return this.lock(() => this.saveResource(bytes, label));
  }
  async labelResource(id, label) {
    if (!digest(id) || typeof label !== 'string' || !label.trim() || label.length > 240) throw new Error('Invalid resource label.');
    const filename = path.join(this.root, '.resources', `${id}.labels.json`);
    let labels = []; try { labels = await readJson(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (!digest(id) || typeof label !== 'string' || !label.trim() || label.length > 240) throw new Error('Invalid resource label.');
    if (labels[0] !== label) await replaceJson(filename, [label, ...labels.filter(value => value !== label)].slice(0, 32));
  }
  async attach(args) {
    const p = this.paths(args.experiment, args.corpus);
    if (!Array.isArray(args.entries) || !args.entries.length || args.entries.length > L.batch) throw new Error('Supply 1–100 case/answer references.');
    return this.lock(async () => {
      const current = await this.load({ experiment: args.experiment, corpus: args.corpus });
      if (args.expected_revision && args.expected_revision !== current.revision) throw new Error('Corpus revision changed.');
      const entries = new Map(current.entries.map(entry => [entry.case_id, entry]));
      for (const entry of args.entries) {
        const { item, key } = await this.records(p, entry);
        if (key.expected !== null) scoreCorpusAnswer(current.contract, key.expected, {});
        if (typeof entry.label !== 'string' || !entry.label.trim() || entry.label.length > 240) throw new Error('Referenced cases require a human-readable label.');
        const tags = entry.tags || [], resourceLabels = {};
        if (!Array.isArray(tags) || tags.length > 32 || tags.some(tag => typeof tag !== 'string' || tag.length > 128)) throw new Error('Invalid case tags.');
        for (const [alias, binding] of Object.entries(item.resources)) resourceLabels[alias] = (await this.resource(binding.resource_id)).label;
        const previous = entries.get(entry.case_id);
        if (previous && previous.answer_id !== entry.answer_id) throw new Error('Use update to replace an existing answer reference.');
        entries.set(entry.case_id, { case_id: entry.case_id, answer_id: entry.answer_id, label: entry.label, tags, resource_labels: resourceLabels });
      }
      return this.publish(p, current.contract, [...entries.values()]);
    });
  }
  async annotate(args) {
    const p = this.paths(args.experiment, args.corpus);
    if (!Array.isArray(args.entries) || !args.entries.length || args.entries.length > L.batch) throw new Error('Supply case annotations.');
    return this.lock(async () => {
      const current = await this.load({ experiment: args.experiment, corpus: args.corpus });
      if (args.expected_revision !== current.revision) throw new Error('Corpus revision changed.');
      const entries = structuredClone(current.entries);
      for (const patch of args.entries) {
        if (Object.keys(patch).some(key => !['case_id', 'label', 'tags', 'resource_labels'].includes(key))) throw new Error('Annotations may only change labels and tags.');
        const entry = entries.find(item => item.case_id === patch.case_id);
        if (!entry) throw new Error('Unknown case annotation.');
        if (patch.label !== undefined) { if (typeof patch.label !== 'string' || !patch.label.trim() || patch.label.length > 240) throw new Error('Invalid case label.'); entry.label = patch.label; }
        if (patch.tags !== undefined) { if (!Array.isArray(patch.tags) || patch.tags.length > 32 || patch.tags.some(tag => typeof tag !== 'string' || tag.length > 128)) throw new Error('Invalid case tags.'); entry.tags = patch.tags; }
        if (patch.resource_labels) {
          const { item } = await this.records(p, entry);
          for (const [alias, label] of Object.entries(patch.resource_labels)) {
            if (!Object.hasOwn(item.resources, alias) || typeof label !== 'string' || !label.trim() || label.length > 240) throw new Error('Invalid resource label.');
            entry.resource_labels[alias] = label;
            await this.labelResource(item.resources[alias].resource_id, label);
          }
        }
      }
      return this.publish(p, current.contract, entries);
    });
  }
  async records(p, entry) {
    if (!digest(entry.case_id) || !digest(entry.answer_id)) throw new Error('Invalid case/answer ID.');
    const item = await readJson(path.join(p.items, `${entry.case_id}.json`));
    const key = await readJson(path.join(p.answers, `${entry.answer_id}.json`));
    if (experimentDigest(item) !== entry.case_id || experimentDigest(key) !== entry.answer_id || key.case_id !== entry.case_id
      || item.schema !== EXPERIMENT_CASE_SCHEMA || key.schema !== EXPERIMENT_ANSWER_SCHEMA) throw new Error('Case or answer binding changed.');
    return { item, key };
  }
  async inspect(args) {
    const snapshot = await this.load(args), p = this.paths(args.experiment, args.corpus);
    const entries = [];
    for (const entry of snapshot.entries) {
      const { item, key } = await this.records(p, entry);
      entries.push({ ...entry, profile: item.profile, resources: item.resources, status: key.status, provenance: key.provenance, ...(args.include_answers === true ? { expected: key.expected } : {}) });
    }
    return { ...snapshot, entries, ready: entries.length > 0 && entries.every(e => e.status === 'verified') };
  }
  async import(args, { trustedAnswers = true, inputRoot = null, promoteDrafts = false } = {}) {
    const { experiment, corpus, items, expected_revision } = args;
    if (!Array.isArray(items) || !items.length || items.length > L.batch) throw new Error('Import requires 1–100 cases.');
    const p = this.paths(experiment, corpus), observed = await this.load({ experiment, corpus });
    if (expected_revision && expected_revision !== observed.revision) throw new Error('Corpus revision changed.');
    const prepared = [], resourceCache = new Map(); let importedBytes = 0;
    for (const item of items) {
      if (!item || typeof item.profile !== 'string' || !new RegExp(EXPERIMENT_CORPUS_PROFILE_PATTERN).test(item.profile) || !item.resources || Array.isArray(item.resources)
        || !Object.keys(item.resources).length || Object.keys(item.resources).length > 16) throw new Error('Each case needs a profile and 1–16 named resources.');
      const resources = {}, resourceLabels = {}, blobs = [];
      for (const [role, resource] of Object.entries(item.resources)) {
        if (!/^[a-z][a-z0-9_]{0,63}$/.test(role) || !resource || (!!resource.path === !!resource.id)) throw new Error('Each named resource must supply either path or ID.');
        let bytes, id;
        if (resource.path) {
          const filename = path.resolve(p.root, resource.path);
          if (inputRoot && !filename.startsWith(path.resolve(inputRoot) + path.sep)) throw new Error('Prep imports must come from the inputs directory.');
          bytes = await regular(filename, L.resourceBytes); id = hash(bytes);
        } else ({ bytes, id } = await this.resource(resource.id));
        if (resource.sha256 !== undefined && resource.sha256 !== id) throw new Error('Resource checksum changed.');
        if (!resourceCache.has(id)) { resourceCache.set(id, bytes); importedBytes += bytes.length; }
        bytes = resourceCache.get(id); if (importedBytes > L.importBytes) throw new Error('Batch resource budget exceeded.');
        const inputName = resource.name || `${role}${resource.path ? path.extname(resource.path) || '.bin' : '.bin'}`;
        if (!validCorpusFilename(inputName)) throw new Error('Input alias filename must be a basename.');
        const label = resource.label || (resource.path ? path.basename(resource.path) : item.label || role);
        if (typeof label !== 'string' || !label.trim() || label.length > 240) throw new Error('Resource labels must be 1–240 characters.');
        resourceLabels[role] = label;
        resources[role] = { resource_id: id, file_id: 'payload', name: inputName }; blobs.push({ id, bytes, label });
      }
      const testCase = { schema: EXPERIMENT_CASE_SCHEMA, resources, profile: item.profile, input: item.input ?? {} };
      const caseID = experimentDigest(testCase);
      if (item.expected !== undefined) scoreCorpusAnswer(observed.contract, item.expected, {});
      const key = { schema: EXPERIMENT_ANSWER_SCHEMA, case_id: caseID, expected: item.expected ?? null,
        status: trustedAnswers && item.expected !== undefined ? 'verified' : 'draft',
        provenance: { kind: trustedAnswers ? 'operator-import' : 'prep-draft', ...(item.provenance ? { detail: item.provenance } : {}) } };
      if (Buffer.byteLength(json(testCase)) + Buffer.byteLength(json(key)) > L.jsonBytes) throw new Error('Case/answer metadata is too large.');
      const tags = item.tags || [];
      if (!Array.isArray(tags) || tags.length > 32 || tags.some(tag => typeof tag !== 'string' || tag.length > 128)) throw new Error('Invalid case tags.');
      const label = item.label || Object.values(resourceLabels).join(' + ').slice(0, 200);
      if (typeof label !== 'string' || !label.trim() || label.length > 240) throw new Error('Case labels must be 1–240 characters.');
      prepared.push({ testCase, key, blobs, entry: { case_id: caseID, answer_id: experimentDigest(key), label, resource_labels: resourceLabels, tags } });
    }
    return this.lock(async () => {
      const current = await this.load({ experiment: args.experiment, corpus: args.corpus });
      if (current.revision !== observed.revision) throw new Error('Corpus changed during import; retry against the new revision.');
      const entries = new Map(current.entries.map(e => [e.case_id, e]));
      for (const item of prepared) {
        const previous = entries.get(item.entry.case_id);
        if (previous && previous.answer_id !== item.entry.answer_id) {
          const { key } = await this.records(p, previous);
          if (key.status === item.key.status && experimentDigest(key.expected) === experimentDigest(item.key.expected)) {
            item.key = key; item.entry.answer_id = previous.answer_id;
          } else if (!args.replace && !(promoteDrafts && trustedAnswers && key.status === 'draft' && item.key.status === 'verified')) {
            throw new Error('A case already has a different key; use update to explicitly replace its answer reference.');
          }
        }
        for (const blob of item.blobs) await this.saveResource(blob.bytes, blob.label);
        await immutableJson(path.join(p.items, `${item.entry.case_id}.json`), item.testCase);
        await immutableJson(path.join(p.answers, `${item.entry.answer_id}.json`), item.key);
        entries.set(item.entry.case_id, item.entry);
      }
      const snapshot = await this.publish(p, current.contract, [...entries.values()]);
      return { id: snapshot.id, revision: snapshot.revision, imported: prepared.map(item => ({ resource: { case_id: item.entry.case_id, label: item.entry.label, resource_labels: item.entry.resource_labels, tags: item.entry.tags, ...item.testCase }, answer_key: { answer_id: item.entry.answer_id, ...item.key } })), total_cases: snapshot.entries.length };
    });
  }
  async evaluation(args, metrics) {
    const snapshot = await this.load(args), p = this.paths(args.experiment, args.corpus);
    if (!snapshot.entries.length) throw new Error('Corpus has no test cases.');
    const cases = [], resources = {}, scorers = Object.fromEntries(metrics.map(metric => [metric.id, metric.id]));
    validateCorpusMeasurements(snapshot.contract, metrics);
    const known = new Set(['score', LATENCY, ...snapshot.contract.fields.map(field => field.id)]);
    if (metrics.some(metric => !known.has(metric.id))) throw new Error('Corpus metric IDs must be score, latency_ms or a declared scoring field.');
    for (const entry of snapshot.entries) {
      const { item, key } = await this.records(p, entry);
      if (key.status !== 'verified') throw new Error('Corpus contains draft answer keys; verify or remove those cases before running.');
      const scored = scoreCorpusAnswer(snapshot.contract, key.expected, {});
      if (metrics.some(metric => metric.id !== 'score' && metric.id !== LATENCY && !Object.hasOwn(scored.values, metric.id))) throw new Error('Every selected field metric needs answer coverage in every case; use a narrower corpus or the composite score.');
      for (const binding of Object.values(item.resources)) {
        if (resources[binding.resource_id]) continue;
        const resource = await this.resource(binding.resource_id);
        resources[resource.id] = { archive_path: resource.filename, manifest: resource.manifest };
      }
      cases.push({ id: entry.case_id, label: entry.label, tags: entry.tags, resource_labels: entry.resource_labels, input: item.input, resources: item.resources, profile: item.profile, expected: key.expected });
    }
    return { schema: EXPERIMENT_CORPUS_EVALUATION_SCHEMA, corpus_id: snapshot.id, corpus_revision: snapshot.revision,
      contract: snapshot.contract, cases, resources, scorers };
  }
  async remove(args) {
    const p = this.paths(args.experiment, args.corpus);
    if (!Array.isArray(args.case_ids) || !args.case_ids.length || args.case_ids.some(id => !digest(id))) throw new Error('Supply case_ids to remove from this corpus.');
    return this.lock(async () => {
      const current = await this.load({ experiment: args.experiment, corpus: args.corpus });
      if (args.expected_revision !== current.revision) throw new Error('Corpus revision changed.');
      if (args.case_ids.some(id => !current.entries.some(entry => entry.case_id === id))) throw new Error('Unknown case in removal request.');
      return this.publish(p, current.contract, current.entries.filter(entry => !args.case_ids.includes(entry.case_id)));
    });
  }
}
