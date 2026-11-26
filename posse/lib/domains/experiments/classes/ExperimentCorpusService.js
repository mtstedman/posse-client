import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { ExperimentCorpora } from './ExperimentCorpora.js';
import { ExperimentCorpusPrep } from './ExperimentCorpusPrep.js';
import { EXPERIMENT_CORPUS_CHOICES, EXPERIMENT_CORPUS_OPERATIONS as O, EXPERIMENT_CORPUS_JOB_OBJECT as K, EXPERIMENT_CORPUS_JOB_STATES as S, EXPERIMENT_CORPUS_EVALUATIONS_OBJECT as E } from '../../../catalog/experiment-corpus.js';
import { experimentDigest } from '../functions/snapshots.js';
import { validateExperimentSetup } from '../functions/setup.js';

// Separate operator-owned preparation jobs. Testing only binds a verified,
// immutable revision; it never starts corpus construction as a side effect.
export class ExperimentCorpusService {
  constructor(service, { open = repo => ExperimentCorpora.open(repo), prep = store => new ExperimentCorpusPrep(store) } = {}) {
    this.service = service; this.store = service.campaigns.store; this.open = open; this.prep = prep; this.active = new Map();
    for (const record of this.store.list(E)) this.service.evaluations[record.id] = record.evaluation;
  }
  async request(operation, args) {
    const fields = { [O.OPTIONS]: ['repo_path', 'offset'], [O.CONTRACT]: ['repo_path', 'corpus'], [O.PREPARE]: ['repo_path', 'mode', 'preparation', 'idempotency_key'], [O.STATUS]: ['id'], [O.BIND]: ['repo_path', 'corpus', 'setup'] }[operation];
    if (!fields || !args || typeof args !== 'object' || Array.isArray(args) || Object.keys(args).some(key => !fields.includes(key))) throw new Error('Invalid corpus operation arguments.');
    if (operation === O.STATUS) return this.status(args.id);
    if (typeof args.repo_path !== 'string' || !path.isAbsolute(args.repo_path)) throw new Error('Choose an absolute project path.');
    const corpus = await this.open(args.repo_path);
    if (operation === O.OPTIONS) return corpus.choices({ offset: args.offset });
    if (operation === O.CONTRACT) {
      const snapshot = await corpus.load(args.corpus);
      return { id: snapshot.id, revision: snapshot.revision, contract: snapshot.contract };
    }
    if (operation === O.BIND) return this.bind(corpus, args);
    return this.prepare(corpus, args);
  }
  status(id) {
    const record = this.store.get(K, id); if (!record) throw new Error('Unknown corpus preparation.');
    return { id, state: record.state, mode: record.mode, corpus: record.corpus, usage: record.usage || null,
      error: record.error || null, report_path: record.report_path || null };
  }
  async bind(corpus, args) {
    if (!args.corpus?.revision || !args.setup?.plan?.metrics) throw new Error('Choose a corpus revision and supply the test setup.');
    const evaluation = await corpus.evaluation(args.corpus, args.setup.plan.metrics);
    const id = `corpus-${experimentDigest({ repo: corpus.repo, id: evaluation.corpus_id, revision: evaluation.corpus_revision, scorers: evaluation.scorers }).slice(0, 40)}`;
    const setup = structuredClone(args.setup); setup.plan.evaluation = { ref: id, digest: experimentDigest(evaluation) };
    const validation = validateExperimentSetup(setup);
    if (!validation.ok) return validation;
    this.service.assertOwner();
    this.store.put(E, id, { id, evaluation }); this.service.evaluations[id] = evaluation;
    return { ...validation, setup, corpus: { id: evaluation.corpus_id, revision: evaluation.corpus_revision, cases: evaluation.cases.length, ready: true } };
  }
  async prepare(corpus, args) {
    if (!EXPERIMENT_CORPUS_CHOICES.slice(1).includes(args.mode) || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(args.idempotency_key || '')) throw new Error('Explicitly choose create or expand and provide an idempotency key.');
    const digest = experimentDigest(args), previous = this.store.list(K).find(item => item.request_key === args.idempotency_key);
    if (previous) { if (previous.digest !== digest) throw new Error('Idempotency conflict.'); return this.status(previous.id); }
    const input = args.preparation;
    if (!input || Array.isArray(input) || Object.keys(input).some(key => !['experiment', 'corpus', 'prompt', 'expected_revision', 'contract', 'model', 'reasoning_effort', 'budget'].includes(key)) || typeof input.prompt !== 'string' || !input.prompt.trim() || input.prompt.length > 16000) throw new Error('Corpus preparation needs a bounded prompt.');
    corpus.paths(input.experiment, input.corpus);
    let current; try { current = await corpus.load({ experiment: input.experiment, corpus: input.corpus }); } catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (args.mode === 'create' && current) throw new Error('Corpus already exists; choose use or expand.');
    if (args.mode === 'expand' && (!current || input.expected_revision !== current.revision)) throw new Error('Choose the current corpus revision before expanding.');
    this.service.assertOwner();
    if (this.service.stopping) throw new Error('Experiment owner is stopping.');
    // Reserve synchronously after the final await; concurrent retries cannot
    // launch duplicate paid prep work.
    const replay = this.store.list(K).find(item => item.request_key === args.idempotency_key);
    if (replay) { if (replay.digest !== digest) throw new Error('Idempotency conflict.'); return this.status(replay.id); }
    if (this.store.list(K).some(item => item.state === S.RUNNING && item.repo === corpus.repo && item.corpus.id === `${input.experiment}/${input.corpus}`)) throw new Error('This corpus already has a preparation in progress.');
    const record = { id: randomUUID(), repo: corpus.repo, request_key: args.idempotency_key, digest, state: S.RUNNING, mode: args.mode,
      corpus: { id: `${input.experiment}/${input.corpus}`, revision: current?.revision || null, ready: false } };
    this.store.put(K, record.id, record);
    const controller = new AbortController(), task = { controller, promise: null };
    this.active.set(record.id, task);
    task.promise = Promise.resolve().then(async () => {
      try {
        const result = await this.prep(corpus).run({ ...input, require_new: args.mode === 'create' }, { signal: controller.signal });
        record.state = result.state === S.COMPLETE ? S.COMPLETE : S.FAILED;
        record.usage = result.usage; record.error = result.error; record.report_path = result.report_path;
        record.corpus = { id: result.corpus?.id || record.corpus.id, revision: result.corpus?.revision || null, ready: result.corpus?.ready === true,
          cases: result.corpus?.entries?.length || 0, drafts: result.corpus?.entries?.filter(entry => entry.status === 'draft').length || 0 };
      } catch (error) { record.state = S.FAILED; record.error = error.message; }
      finally {
        try { this.service.assertOwner(); this.store.put(K, record.id, record); } catch { /* New owner marks the job interrupted. */ }
        this.active.delete(record.id);
      }
    });
    return this.status(record.id);
  }
  recover() {
    for (const record of this.store.list(K)) if (record.state === S.RUNNING) {
      record.state = S.INTERRUPTED; record.error = 'Owner interrupted; no automatic replay of paid preparation.'; this.store.put(K, record.id, record);
    }
  }
  async shutdown() { for (const task of this.active.values()) task.controller.abort(); await Promise.all([...this.active.values()].map(task => task.promise)); }
}
