import { CORPUS_INSPECTION_FORMATS } from './experiment-inspection.js';
const text = { type: 'string' };
const jsonPath = { type: 'array', maxItems: 8, items: { anyOf: [{ type: 'string', minLength: 1, maxLength: 128 }, { type: 'integer', minimum: 0, maximum: 1000000 }] } };
const descriptions = { type: 'object', maxProperties: 32, additionalProperties: { type: 'string', minLength: 1, maxLength: 512 } };
const tool = (name, description, properties, required = []) => ({ name, description, parameters: { type: 'object', properties: { ...properties, notes: { type: 'string', maxLength: 4000, description: 'Replace working notes retained across decisions; keep inspected IDs, findings and next steps.' } }, required, additionalProperties: false } });
export const CORPUS_PREP_DEFAULTS = { model: 'standard', reasoning_effort: 'medium', model_calls: 100, tokens: 1000000, spend_usd: 25, wall_seconds: 3600 };
export const CORPUS_BATCH_DOWNLOAD = { items: 100, concurrency: 4, delayMs: 200 };
export const CORPUS_PREP_DATA_LIMITS = { bytes: 16000, cell: 512, page: 20, reports: 100, recentResults: 4, operationHistory: 12 };
export const CORPUS_PREP_TOOLS = [
  tool('define_contract', 'Create the missing scoring contract. Fields: id, path (array), kind exact|number|set|objects, positive weight, optional depends_on naming earlier fields. Number supports tolerance and partial_range; exact answers can supply accepted alternatives; objects require iou_threshold and optional attribute fields. Interface maps resource/input/prediction names to short STRING descriptions; requirements is an array of strings. Existing contracts cannot change. Unknown answers stay unscored.', { contract: { type: 'object', additionalProperties: false, required: ['fields'], properties: {
    fields: { type: 'array', minItems: 1, maxItems: 32, items: { type: 'object' } },
    interface: { type: 'object', additionalProperties: false, properties: { resources: descriptions, input: descriptions, prediction: descriptions, requirements: { type: 'array', maxItems: 16, items: { type: 'string', maxLength: 512 } } } },
  } } }, ['contract']),
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
  tool('import', 'Batch import up to 100 cases with human labels, tags, profile, input, resources and expected. Path resources are relative to inputs/ and require the SHA256 returned by inspect. Resource IDs can refer to downloads. Inferred answers stay draft. Existing keys cannot be overwritten here.', { items: { type: 'array', minItems: 1, maxItems: 100, items: { type: 'object' } } }, ['items']),
  tool('import_manifest', 'Import an operator-supplied JSON file from inputs/ as verified answers, without modifying its contents. Format: {items:[...]} with expected, profile, input and resources. Resource paths are relative to that manifest and every resource needs sha256. Agent-authored/downloaded manifests cannot be trusted through this tool.', { path: text }, ['path']),
  tool('corpus', 'Inspect current labeled case membership and key verification status, paginated. Reduce limit for cases with many resources.', { offset: { type: 'integer', minimum: 0 }, limit: { type: 'integer', minimum: 1, maximum: 50 } }),
  tool('finish', 'Finish preparation and report remaining draft keys or missing inputs honestly.', { summary: text }, ['summary']),
];
export const CORPUS_RESULT_SELECTORS = ['latest', 'accepted', 'baseline'];
