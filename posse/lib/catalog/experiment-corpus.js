// Resource bytes are independent of their interpretation. A case binds named
// resources, adapter settings and a scoring contract; keys bind that whole case.
export const EXPERIMENT_CORPUS_EVALUATION_SCHEMA = 'posse.experiment.corpus-evaluation.v1';
export const EXPERIMENT_CORPUS_PAYLOAD_API = { protocol: 'jsonl.corpus.v1', input: { case_id: 'opaque case identifier', input: 'JSON scenario settings', files: 'logical alias to a read-only path under /input-files/' }, output: { case_id: 'same case identifier', prediction: 'structured JSON object matching the scoring contract' }, rules: 'Read resources using files.<alias>; never hardcode archive or download filenames. One prediction per case on stdout. When latency_ms is selected, cases arrive one at a time: respond and flush a newline before reading the next input; never wait for stdin EOF. Owner timing covers the full response including transport and first-case startup; payload telemetry is not used. Answer keys and archive manifests are not mounted. Diagnostics go to stderr.' };
export const EXPERIMENT_CORPUS_SCHEMA = 'posse.experiment.corpus.v1';
export const EXPERIMENT_CASE_SCHEMA = 'posse.experiment.case.v1';
export const EXPERIMENT_ANSWER_SCHEMA = 'posse.experiment.answer.v1';
export const EXPERIMENT_CORPUS_REGISTRY_SCHEMA = 'posse.experiment.corpora.v1';
export const EXPERIMENT_CORPUS_FIELD_KINDS = ['exact', 'number', 'set', 'objects'];
export const EXPERIMENT_CORPUS_FIELD_STATUSES = ['correct', 'partial', 'incorrect', 'missing', 'not_applicable', 'unknown'];
export const EXPERIMENT_CORPUS_KEY_STATUSES = ['draft', 'verified'];
export const EXPERIMENT_CORPUS_PROFILE_PATTERN = '^[a-z0-9][a-z0-9._-]{0,127}$';
export const EXPERIMENT_CORPUS_LIMITS = { items: 1000, batch: 100, resourceBytes: 64 * 1024 * 1024, importBytes: 256 * 1024 * 1024, jsonBytes: 4 * 1024 * 1024, fields: 32, objects: 128 };
export const EXPERIMENT_CORPUS_ACTIONS = ['schema', 'choices', 'create', 'register', 'list', 'inspect', 'import', 'update', 'remove', 'score', 'prep'];
export const EXPERIMENT_CORPUS_EXAMPLE = {
  experiment: 'cards', corpus: 'printing-smoke',
  contract: { fields: [
    { id: 'identity', path: ['identity'], kind: 'exact', weight: 0.7 },
    { id: 'printing', path: ['printing'], kind: 'exact', weight: 0.3, depends_on: ['identity'] },
  ] },
  items: [{ label: 'Selected card — printing check', resources: { image: { path: 'inputs/card.jpg', label: 'Selected card photograph' } }, profile: 'card-identification-v1', input: {},
    expected: { identity: 'canonical-card-id', printing: 'canonical-printing-id' }, tags: ['selected'] }],
};

export const EXPERIMENT_CORPUS_CONTEXT_ALIAS_LIMIT = 32;
export const EXPERIMENT_CORPUS_CHOICES = ['use', 'create', 'expand'];
export const EXPERIMENT_CORPUS_JOB_STATES = { RUNNING: 'running', COMPLETE: 'complete', FAILED: 'failed', INTERRUPTED: 'interrupted' };
export const EXPERIMENT_CORPUS_JOB_OBJECT = 'experiment_corpus_preparations';
export const EXPERIMENT_CORPUS_OPERATIONS = { OPTIONS: 'experiment.corpus_options', CONTRACT: 'experiment.corpus_contract', PREPARE: 'experiment.corpus_prepare', STATUS: 'experiment.corpus_status', BIND: 'experiment.corpus_bind' };

export const EXPERIMENT_CORPUS_EVALUATIONS_OBJECT = 'experiment_corpus_evaluations';
