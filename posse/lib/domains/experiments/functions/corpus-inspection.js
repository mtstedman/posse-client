import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CORPUS_INSPECTION_FORMATS, CORPUS_INSPECTION_LIMITS as L } from '../../../catalog/experiment-inspection.js';
import { readCorpusResource, validResourceBinding } from './corpus-inputs.js';
import { viewImageWithinScope } from '../../../shared/tools/functions/toolkit/view-image.js';
import { asMcpContentResult } from '../../../shared/tools/functions/mcp-content-result.js';

export function corpusInspectionCases(evaluation, { offset = 0 }) {
  if (!Number.isInteger(offset) || offset < 0 || offset > evaluation.cases.length) throw new Error('Invalid corpus page.');
  const selected = evaluation.cases.slice(offset, offset + L.page);
  return { columns: ['case_index', 'label', 'resources'], rows: selected.map((item, index) => [offset + index,
    String(item.label || 'Unlabeled case').slice(0, 120), Object.keys(item.resources)]),
  total: evaluation.cases.length, next_offset: offset + selected.length < evaluation.cases.length ? offset + selected.length : null };
}

// Select only from the frozen resource bindings. Never expose owner manifests,
// answer keys, arbitrary filesystem paths, or base64 as model text.
export async function inspectCorpusResource(evaluation, args, { signal, viewImage = viewImageWithinScope, tempRoot = os.tmpdir() } = {}) {
  signal?.throwIfAborted();
  const { case_index: index, alias, format, offset = 0 } = args;
  if (!Number.isInteger(index) || index < 0 || index >= evaluation.cases.length || !CORPUS_INSPECTION_FORMATS.includes(format)
    || !Number.isInteger(offset) || offset < 0 || !/^[a-z][a-z0-9_]{0,63}$/.test(alias || '')) throw new Error('Invalid corpus inspection.');
  const item = evaluation.cases[index], binding = Object.hasOwn(item.resources, alias) && item.resources[alias];
  if (!validResourceBinding(binding)) throw new Error('Unknown corpus resource alias.');
  const resource = evaluation.resources[binding.resource_id];
  if (!resource || resource.manifest?.resource_id !== binding.resource_id) throw new Error('Missing corpus resource.');
  let bytes;
  try { bytes = await readCorpusResource(resource); } catch { throw new Error('Corpus resource is unavailable or failed integrity checks.'); }
  signal?.throwIfAborted();
  if (offset > bytes.length || (format === 'image' && offset !== 0)) throw new Error('Invalid resource offset.');
  const result = { case_index: index, alias, label: String(item.resource_labels?.[alias] || item.label || alias).slice(0, 120), bytes: bytes.length };
  if (format !== 'image') {
    const end = Math.min(bytes.length, offset + (format === 'hex' ? L.hexBytes : L.textBytes));
    return { result: { ...result, format, offset, content: bytes.subarray(offset, end).toString(format === 'hex' ? 'hex' : 'utf8'), next_offset: end < bytes.length ? end : null }, images: [] };
  }
  const directory = await fs.mkdtemp(path.join(tempRoot, 'posse-corpus-preview-'));
  try {
    await fs.writeFile(path.join(directory, 'resource.image'), bytes, { flag: 'wx', mode: 0o400 });
    const viewed = await viewImage({ path: 'resource.image' }, { cwd: directory });
    signal?.throwIfAborted();
    const content = asMcpContentResult(viewed);
    if (!content) throw new Error('Resource cannot be previewed as an image. Use text/hex for other formats.');
    const images = content.content.filter(block => block.type === 'image').map(({ data, mimeType }) => ({ data, mimeType }));
    if (images.length !== 1) throw new Error('Image preview returned no pixels.');
    return { result: { ...result, format, preview: JSON.parse(content.text) }, images };
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
}
