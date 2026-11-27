import { EXPERIMENT_READ_TOOL, EXPERIMENT_SEARCH_TOOL, EXPERIMENT_LOOKUP_BATCH_TOOL } from './experiment-runner.js';
import { EXPERIMENT_CORPUS_INSPECTION_TOOLS } from './experiment-inspection.js';
import { AGENT_REASONING_EFFORTS } from './agent.js';
import { CORPUS_PREP_CONTRACT_SCHEMA, CORPUS_PREP_CONTRACT_GUIDANCE } from './experiment-corpus-prep.js';
import { EXPERIMENT_INSTALL_DEPS_TOOL } from './experiment-runtime.js';

const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
const object = (properties, required = Object.keys(properties)) => ({ type: 'object', additionalProperties: false, properties, required });
const digest = { type: 'string', pattern: '^[a-f0-9]{64}$' };
export const SETUP_AGENT_CORPUS = object({ experiment: text(64), corpus: text(64), revision: digest });
export const SETUP_AGENT_DEFAULTS = { model: 'standard', reasoning_effort: 'medium', model_calls: 40, tokens: 500000, spend_usd: 10, wall_seconds: 1800 };
export const SETUP_AGENT_LIMITS = { sourceFiles: 10000, fileBytes: 262144, snapshotBytes: 4194304, page: 50, artifactBytes: 524288, repairs: 3, smokeCases: 3 };
export const SETUP_AGENT_OBJECT = 'experiment_setup_jobs';
export const SETUP_ARTIFACT_SCHEMA = 'posse.experiment.setup-artifact.v1';
export const SETUP_AGENT_OPERATIONS = { PREPARE: 'experiment.setup_prepare', STATUS: 'experiment.setup_status', STOP: 'experiment.setup_stop', LIST: 'experiment.setup_list', GET: 'experiment.setup_get' };
export const SETUP_AGENT_STATES = { RUNNING: 'running', READY: 'ready', BLOCKED: 'blocked', INPUTS: 'needs_inputs', CANCELLED: 'cancelled', INTERRUPTED: 'interrupted', BUDGET: 'budget_exhausted', ERROR: 'error' };
export const SETUP_AGENT_REQUEST = object({ repo_path: text(1024), objective: text(2000), corpus: SETUP_AGENT_CORPUS, contract: CORPUS_PREP_CONTRACT_SCHEMA,
  model: text(128), reasoning_effort: { enum: AGENT_REASONING_EFFORTS }, image: text(240), idempotency_key: { type: 'string', pattern: '^[a-zA-Z0-9_.:-]{1,128}$' },
  budget: object({ model_calls: { type: 'integer', minimum: 1, maximum: 200 }, tokens: { type: 'integer', minimum: 1, maximum: 2000000 },
    spend_usd: { type: 'number', exclusiveMinimum: 0, maximum: 100 }, wall_seconds: { type: 'integer', minimum: 1, maximum: 7200 } }, []),
}, ['repo_path', 'objective', 'idempotency_key']);
const tool = (name, description, properties, required = Object.keys(properties)) => ({ name, description, parameters: object(properties, required) });
export const SETUP_AGENT_TOOLS = [
  EXPERIMENT_INSTALL_DEPS_TOOL,
  tool('setup.files', 'List safe tracked source/config paths at the frozen commit. Filter by path substring; paginate before reading. Paths use work/ prefix.', { query: text(240), offset: { type: 'integer', minimum: 0 } }, []),
  ...[EXPERIMENT_READ_TOOL, EXPERIMENT_SEARCH_TOOL, EXPERIMENT_LOOKUP_BATCH_TOOL],
  tool('setup.corpora', 'List registered corpus summaries without answers. Choose a suitable corpus for the objective; do not ask for a manual choice merely because none was supplied.', { offset: { type: 'integer', minimum: 0 } }, []),
  tool('setup.contract', 'Inspect the public contract for a registered immutable corpus before selecting it.', { corpus: SETUP_AGENT_CORPUS }),
  tool('setup.select_corpus', 'Select a suitable registered corpus with a concise reason. The owner checks readiness and pins its revision. Never replace an explicitly supplied corpus.', { corpus: SETUP_AGENT_CORPUS, reason: text(1000) }),
  tool('setup.prepare_corpus', `When no suitable corpus exists, dispatch the existing corpus-building agent and wait. Creation or explicit expansion has its own receipt within the shared remaining setup budget. Draft answers never authorize an experiment. ${CORPUS_PREP_CONTRACT_GUIDANCE}`, {
    mode: { enum: ['create', 'expand'] }, experiment: text(64), corpus: text(64), prompt: text(16000), reason: text(1000), expected_revision: digest, contract: CORPUS_PREP_CONTRACT_SCHEMA,
  }, ['mode', 'experiment', 'corpus', 'prompt', 'reason']),
  ...EXPERIMENT_CORPUS_INSPECTION_TOOLS,
  tool('setup.artifacts', 'List a bounded page of reusable validated setup artifacts. Prefer a compatible existing artifact over rebuilding the adapter.', { offset: { type: 'integer', minimum: 0 } }, []),
  tool('setup.reuse', 'Reuse a listed validated artifact instead of authoring another adapter. Compatible adapter/runtime/corpus receipts stay vetted. Exact source hashes reuse validation with no smoke; changed source or new corpus inputs get only the affected deterministic boundary smoke. No paid review of reused components.', { artifact: digest, reason: text(1000) }),
  tool('setup.submit', 'Submit a reusable init template for deterministic validation. Required: setup.plan objective/entrypoint/files/metrics, setup.files containing only new read-only JSONL adapter/support files, and repository checks. Declare at least one existing production file mode:modify for FUTURE optimization; declaring this scope does not edit it during setup. Adapters stay mode:read. Omit mapping to derive source/target pairs, or provide a nonempty mapping for all modify files. Repository implementation bytes come from Git, never from generated copies. No source digests or evaluation binding in the template. Imports must use the selected production implementation; never replace an unavailable runtime with a simplified algorithm. Host checks are proposed configuration, not executed here.', { template: { type: 'object' } }),
  tool('setup.blocked', 'Finish honestly when inputs, runtime support, or adapter knowledge are missing. State the concrete prerequisite; do not fabricate a working adapter.', { reason: text(4000), needs_inputs: { type: 'boolean' } }),
].map(t => ({ ...t, parameters: { ...t.parameters, properties: { ...t.parameters.properties, notes: { type: 'string', maxLength: 4000, description: 'Replace concise working notes retained between turns.' } } } }));
