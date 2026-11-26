// Resource bytes are independent of their interpretation. A case binds named
// resources, adapter settings and a scoring contract; keys bind that whole case.
export const EXPERIMENT_CORPUS_EVALUATION_SCHEMA = 'posse.experiment.corpus-evaluation.v1';
export const EXPERIMENT_CORPUS_PAYLOAD_API = { protocol: 'jsonl.corpus.v1', input: { case_id: 'opaque case identifier', input: 'JSON scenario settings', files: 'logical alias to a read-only path under /input-files/' }, output: { case_id: 'same case identifier', prediction: 'structured JSON object matching the scoring contract' }, rules: 'Read resources using files.<alias>; never hardcode archive or download filenames. One prediction per case on stdout. Answer keys and archive manifests are not mounted. Diagnostics go to stderr.' };
export const EXPERIMENT_CORPUS_SCHEMA = 'posse.experiment.corpus.v1';
export const EXPERIMENT_CASE_SCHEMA = 'posse.experiment.case.v1';
export const EXPERIMENT_ANSWER_SCHEMA = 'posse.experiment.answer.v1';
export const EXPERIMENT_CORPUS_REGISTRY_SCHEMA = 'posse.experiment.corpora.v1';
export const EXPERIMENT_CORPUS_FIELD_KINDS = ['exact', 'number', 'set', 'objects'];
export const EXPERIMENT_CORPUS_KEY_STATUSES = ['draft', 'verified'];
export const EXPERIMENT_CORPUS_LIMITS = { items: 1000, batch: 100, resourceBytes: 64 * 1024 * 1024, importBytes: 256 * 1024 * 1024, jsonBytes: 4 * 1024 * 1024, fields: 32, objects: 128 };
export const EXPERIMENT_CORPUS_ACTIONS = ['schema', 'create', 'register', 'list', 'inspect', 'import', 'update', 'remove', 'score', 'prep'];
export const EXPERIMENT_CORPUS_EXAMPLE = {
  experiment: 'cards', corpus: 'printing-smoke',
  contract: { fields: [
    { id: 'identity', path: ['identity'], kind: 'exact', weight: 0.7 },
    { id: 'printing', path: ['printing'], kind: 'exact', weight: 0.3, depends_on: ['identity'] },
  ] },
  items: [{ label: 'Selected card — printing check', resources: { image: { path: 'inputs/card.jpg', label: 'Selected card photograph' } }, profile: 'card-identification-v1', input: {},
    expected: { identity: 'canonical-card-id', printing: 'canonical-printing-id' }, tags: ['selected'] }],
};
