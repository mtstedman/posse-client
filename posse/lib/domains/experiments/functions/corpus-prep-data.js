import fs from 'node:fs/promises';
import path from 'node:path';
import { CORPUS_PREP_DATA_LIMITS as L } from '../../../catalog/experiment-corpus-prep.js';
import { EXPERIMENT_CORPUS_LIMITS } from '../../../catalog/experiment-corpus.js';

export function rememberPrepResult(record, tool, result) {
  const value = Buffer.byteLength(JSON.stringify(result)) <= L.bytes ? result : { note: 'Large result omitted from working context; retrieve a smaller page.' };
  const history = record.recent_results ||= [];
  history.push({ tool, result: value });
  while (history.length > L.recentResults || Buffer.byteLength(JSON.stringify(history)) > L.bytes) history.shift();
}

export function prepReadRequest(args) {
  return Object.fromEntries(['id', 'path', 'format', 'view', 'offset', 'limit', 'search', 'array_path', 'fields']
    .filter(key => args[key] !== undefined).map(key => [key, args[key]]));
}

function page(rows, { offset = 0, limit = L.page }, project = row => row, budget = L.bytes) {
  if (!Number.isInteger(offset) || offset < 0 || offset > rows.length || !Number.isInteger(limit) || limit < 1 || limit > 50) throw new Error('Invalid data page.');
  const selected = []; let bytes = 0;
  for (const source of rows.slice(offset, offset + limit)) {
    const row = project(source);
    const size = Buffer.byteLength(JSON.stringify(row));
    if (bytes + size > budget) break;
    selected.push(row); bytes += size;
  }
  if (!selected.length && offset < rows.length) throw new Error('Selected row exceeds preview limit; request fewer/smaller fields.');
  const next = offset + selected.length;
  return { rows: selected, total: rows.length, offset, next_offset: next < rows.length ? next : null };
}
const validPath = parts => Array.isArray(parts) && parts.length <= 8 && parts.every(part => (Number.isInteger(part) && part >= 0 && part <= 1000000) || (typeof part === 'string' && part.length > 0 && part.length <= 128));
const readPath = (value, parts) => parts.reduce((current, key) => current && typeof current === 'object' && Object.hasOwn(current, key) ? current[key] : undefined, value);
const cell = value => {
  if (value === undefined) return null;
  const text = JSON.stringify(value);
  return text.length <= L.cell ? value : { preview: text.slice(0, L.cell), truncated: true };
};

export function corpusPreparationInventory(corpus, args = {}) {
  const base = { id: corpus.id, revision: corpus.revision, ready: corpus.ready, total: corpus.entries.length };
  if (args.view === 'cases') return { ...base, columns: ['case_id', 'label', 'tags', 'profile', 'status', 'resources'],
    ...page(corpus.entries, args, entry => [entry.case_id, entry.label, entry.tags, entry.profile, entry.status,
      Object.fromEntries(Object.entries(entry.resources).map(([alias, binding]) => [alias, { id: binding.resource_id, name: binding.name }]))], L.bytes - 1024) };
  if (args.view !== undefined && args.view !== 'summary') throw new Error('Unknown corpus inventory view.');
  const profiles = new Map(), tags = new Map(); let verified = 0;
  const add = (map, key) => map.set(key, (map.get(key) || 0) + 1);
  for (const entry of corpus.entries) {
    if (entry.status === 'verified') verified++;
    add(profiles, entry.profile);
    for (const tag of new Set(entry.tags)) add(tags, tag);
  }
  const counts = map => {
    const all = [...map].sort(([a], [b]) => a.localeCompare(b)), rows = []; let bytes = 0;
    for (const row of all) {
      const size = Buffer.byteLength(JSON.stringify(row));
      if (rows.length === L.summaryGroups || bytes + size > L.bytes / 3) break;
      rows.push(row); bytes += size;
    }
    return { columns: ['label', 'cases'], rows, total: all.length, omitted: all.length - rows.length };
  };
  return { ...base, verified, draft: corpus.entries.length - verified, profiles: counts(profiles), tags: counts(tags),
    instruction: 'Counts cover the entire corpus. Use view:cases with offset/limit for compact membership and image resource IDs; follow next_offset.' };
}

export function inspectCorpusJson(bytes, args) {
  if (bytes.length > EXPERIMENT_CORPUS_LIMITS.jsonBytes || !validPath(args.array_path) || !args.fields || typeof args.fields !== 'object' || Array.isArray(args.fields)
    || Object.keys(args.fields).length < 1 || Object.keys(args.fields).length > 16 || Object.entries(args.fields).some(([name, parts]) => name.length > 128 || !validPath(parts))) throw new Error('JSON inspection requires bounded data and field paths.');
  let value; try { value = JSON.parse(bytes.toString('utf8')); } catch { throw new Error('Resource is not valid JSON.'); }
  const selected = readPath(value, args.array_path);
  if (selected === undefined || selected === null) throw new Error('JSON array_path does not exist.');
  const rows = Array.isArray(selected) ? selected : [selected];
  return { columns: Object.keys(args.fields), ...page(rows, args, row => Object.values(args.fields).map(parts => cell(readPath(row, parts)))) };
}

export async function corpusDownloadHistory(directory, corpusID, args) {
  const files = (await fs.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() && /^[a-f0-9-]{36}$/.test(entry.name));
  if (files.length > L.reports) throw new Error('Preparation history exceeds its report limit.');
  const records = [];
  for (const entry of files) {
    const filename = path.join(directory, entry.name, 'report.json');
    let info; try { info = await fs.lstat(filename); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
    if (!info.isFile() || info.isSymbolicLink() || info.size > EXPERIMENT_CORPUS_LIMITS.jsonBytes || await fs.realpath(filename) !== filename) throw new Error('Invalid preparation history file.');
    const report = JSON.parse(await fs.readFile(filename, 'utf8'));
    if (report.corpus_id === corpusID) records.push(report);
  }
  records.sort((a, b) => a.started_at - b.started_at || a.id.localeCompare(b.id));
  const seen = new Map();
  for (const record of records) for (const receipt of record.downloads || []) seen.set(`${receipt.id}:${receipt.source_url}`, receipt);
  const search = String(args.search || '').toLowerCase();
  const rows = [...seen.values()].filter(row => `${row.label} ${row.source_url}`.toLowerCase().includes(search))
    .map(row => [row.label, row.id, row.bytes, row.source_url, row.media_type]);
  return { columns: ['label', 'resource_id', 'bytes', 'source_url', 'media_type'], ...page(rows, args) };
}
