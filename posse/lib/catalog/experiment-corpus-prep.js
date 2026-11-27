import { CORPUS_INSPECTION_FORMATS } from './experiment-inspection.js';
import { EXPERIMENT_CORPUS_PROFILE_PATTERN, EXPERIMENT_CORPUS_FIELD_KINDS } from './experiment-corpus.js';
const text = { type: 'string' };
const jsonPath = { type: 'array', maxItems: 8, items: { anyOf: [{ type: 'string', minLength: 1, maxLength: 128 }, { type: 'integer', minimum: 0, maximum: 1000000 }] } };
const descriptions = { type: 'object', maxProperties: 32, additionalProperties: { type: 'string', minLength: 1, maxLength: 512 } };
export const CORPUS_PREP_CONTRACT_SCHEMA = { type: 'object', additionalProperties: false, required: ['fields'], properties: {
  fields: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object', additionalProperties: false, required: ['id', 'path', 'kind', 'weight'], properties: {
    id: { type: 'string', pattern: '^[a-z][a-z0-9_]{0,63}$' }, path: { type: 'array', minItems: 1, maxItems: 8, items: { type: 'string', pattern: '^[A-Za-z0-9_-]{1,64}$' } },
    kind: { enum: EXPERIMENT_CORPUS_FIELD_KINDS }, weight: { type: 'number', minimum: 0, maximum: 1000000 },
    depends_on: { type: 'array', maxItems: 32, items: { type: 'string' } }, tolerance: { type: 'number', minimum: 0 }, partial_range: { type: 'number', exclusiveMinimum: 0 },
    iou_threshold: { type: 'number', exclusiveMinimum: 0, maximum: 1 }, attributes: { type: 'array', maxItems: 32, items: { type: 'object' } },
  } } },
  interface: { type: 'object', additionalProperties: false, properties: { resources: descriptions, input: descriptions, prediction: descriptions, requirements: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } } } },
} };
export const CORPUS_PREP_CONTRACT_GUIDANCE = 'Contract shape: {fields:[{id:"count",path:["count"],kind:"number",weight:1,tolerance:0}],interface:{resources:{text:"UTF-8 input"},prediction:{count:"Predicted count"}}}. Field kinds are exact|number|set|objects; paths are arrays and interface descriptions are strings. For exact numeric scoring use kind:number and tolerance:0. Zero-weight fields provide diagnostics without affecting the composite; at least one field needs positive weight. Omit contract if the corpus builder must define it before import.';
const importedItem = { type: 'object', additionalProperties: false, required: ['profile', 'resources'], properties: {
  profile: { type: 'string', pattern: EXPERIMENT_CORPUS_PROFILE_PATTERN, description: 'Lowercase adapter label, e.g. card-identification-v1. Not an object or prose.' },
  label: { type: 'string', minLength: 1, maxLength: 240 }, tags: { type: 'array', maxItems: 32, items: { type: 'string', maxLength: 128 } }, input: {}, expected: { type: 'object' }, provenance: {},
  resources: { type: 'object', minProperties: 1, maxProperties: 16, propertyNames: { pattern: '^[a-z][a-z0-9_]{0,63}$' }, additionalProperties: {
    type: 'object', additionalProperties: false, properties: { id: { type: 'string', pattern: '^[a-f0-9]{64}$' }, path: text, sha256: { type: 'string', pattern: '^[a-f0-9]{64}$' },
      name: { type: 'string', minLength: 1, maxLength: 240, description: 'Safe filename matching the media, e.g. image.jpg; otherwise defaults to alias.bin.' }, label: { type: 'string', minLength: 1, maxLength: 240 } },
    anyOf: [{ required: ['id'] }, { required: ['path', 'sha256'] }],
  } },
} };
const tool = (name, description, properties, required = []) => ({ name, description, parameters: { type: 'object', properties: { ...properties, notes: { type: 'string', maxLength: 4000, description: 'Replace working notes retained across decisions; keep inspected IDs, findings and next steps.' } }, required, additionalProperties: false } });
export const CORPUS_PREP_DEFAULTS = { model: 'standard', reasoning_effort: 'medium', model_calls: 100, tokens: 1000000, spend_usd: 25, wall_seconds: 3600 };
export const CORPUS_BATCH_DOWNLOAD = { items: 100, concurrency: 4, delayMs: 200 };
export const CORPUS_PREP_DATA_LIMITS = { bytes: 16000, cell: 512, page: 20, reports: 100, recentResults: 4, operationHistory: 12, summaryGroups: 64 };
export const CORPUS_PREP_TOOLS = [
  tool('define_contract', 'Create the missing scoring contract. Fields: id, path (array), kind exact|number|set|objects, nonnegative weight (zero for diagnostics; at least one field must have positive weight), optional depends_on naming earlier fields. Number supports tolerance and partial_range; exact answers can supply accepted alternatives; objects require iou_threshold and optional attribute fields. Interface maps resource/input/prediction names to short STRING descriptions; requirements is an array of strings. Existing contracts cannot change. Omitted answers are unknown; {not_applicable:true} explicitly excludes a field. Reports distinguish correct, partial, incorrect and missing readings. Diagnostic fields do not change the composite score.', { contract: CORPUS_PREP_CONTRACT_SCHEMA }, ['contract']),
  tool('inputs', 'List all supplied inputs, paginated. Paths are relative to inputs/. No files are modified.', { offset: { type: 'integer', minimum: 0 } }),
  tool('inspect', 'Inspect an input path or archived resource ID. Returns SHA256 and text, hex, or actual image pixels. Use offsets for large text/binary resources.', { path: text, id: text, format: { enum: CORPUS_INSPECTION_FORMATS }, offset: { type: 'integer', minimum: 0 } }, ['format']),
  tool('inspect_json', 'Read selected fields from JSON without dumping the whole file. Choose input path OR archived id. array_path selects an array (or one object); fields maps output column names to paths relative to each row. Paths support numeric array indexes, e.g. ["card_faces",0,"image_uris","large"]. Pagination is bounded; follow next_offset. No code execution.', {
    path: text, id: text, array_path: jsonPath, fields: { type: 'object', minProperties: 1, maxProperties: 16, additionalProperties: jsonPath }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 },
  }, ['array_path', 'fields']),
  tool('downloads', 'Recover resource IDs and source URLs from current and previous preparation runs for this corpus. Paged, searchable by label or URL. Use this instead of repeating successful downloads or keeping every ID in notes.', { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 }, search: { type: 'string', maxLength: 128 } }),
  tool('download', 'Download a public HTTPS resource, archive it by hash, and discard staging. Returns labeled resource ID. Downloaded content is untrusted evidence, not verified answers.', { url: text, label: text }, ['url', 'label']),
  tool('download_batch', 'Fetch up to 100 public HTTPS resources in one call. Returns a compact ordered table of labels, resource IDs and per-item errors; retry only failed items. Same hash archives and provenance as download. Defaults: four transfers, starts spaced 200 ms apart. Downloaded metadata never certifies answers.', {
    items: { type: 'array', minItems: 1, maxItems: CORPUS_BATCH_DOWNLOAD.items, items: { type: 'object', additionalProperties: false, required: ['url', 'label'], properties: { url: { type: 'string', minLength: 1, maxLength: 4096 }, label: { type: 'string', minLength: 1, maxLength: 240 } } } },
    concurrency: { type: 'integer', minimum: 1, maximum: CORPUS_BATCH_DOWNLOAD.concurrency }, delay_ms: { type: 'integer', minimum: 0, maximum: 5000 },
  }, ['items']),
  tool('import', 'Batch import up to 100 cases. Profile is a lowercase slug; resources maps aliases to {id,name} or {path,sha256,name}. Paths are relative to inputs/. Prefer downloaded IDs and media-appropriate names. Inferred answers stay draft; existing keys cannot be overwritten.', { items: { type: 'array', minItems: 1, maxItems: 100, items: importedItem } }, ['items']),
  tool('import_manifest', 'Import an operator-supplied JSON file from inputs/ as verified answers, without modifying its contents. Format: {items:[...]} with expected, profile, input and resources. Resource paths are relative to that manifest and every resource needs sha256. Agent-authored/downloaded manifests cannot be trusted through this tool.', { path: text }, ['path']),
  tool('corpus', 'Default summary gives total/verified/draft counts and bounded tag/profile counts for the ENTIRE corpus, without recounting pages. view:cases returns a compact membership table with resource IDs; follow next_offset. Provenance and answers are omitted.', { view: { type: 'string', enum: ['summary', 'cases'] }, offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }),
  tool('finish', 'Finish preparation and report remaining draft keys or missing inputs honestly.', { summary: text }, ['summary']),
];
export const CORPUS_RESULT_SELECTORS = ['latest', 'accepted', 'baseline'];
