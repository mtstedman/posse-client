import { validateCorpusInterface } from './corpus-contract.js';
import { EXPERIMENT_LATENCY_METRIC } from '../../../catalog/experiment-measurement.js';
import { EXPERIMENT_CORPUS_FIELD_KINDS as K, EXPERIMENT_CORPUS_LIMITS as L } from '../../../catalog/experiment-corpus.js';

const object = value => value && typeof value === 'object' && !Array.isArray(value);
const identifier = value => typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value);
const finite = value => typeof value === 'number' && Number.isFinite(value);
const read = (value, parts) => parts.reduce((current, key) => object(current) && Object.hasOwn(current, key) ? current[key] : undefined, value);
const equal = (a, b) => (typeof a === 'string' || finite(a) || typeof a === 'boolean' || a === null) && a === b;

export function validateCorpusContract(contract) {
  if (!object(contract) || Object.keys(contract).some(k => !['fields', 'interface'].includes(k)) || !Array.isArray(contract.fields) || !contract.fields.length || contract.fields.length > L.fields) throw new Error('Scoring contract requires 1–32 fields.');
  validateCorpusInterface(contract.interface);
  if (Buffer.byteLength(JSON.stringify(contract)) > 16000) throw new Error('Corpus contract exceeds 16 KiB.');
  const seen = new Set();
  for (const field of contract.fields) {
    if (!object(field) || !identifier(field.id) || field.id === 'score' || field.id === EXPERIMENT_LATENCY_METRIC || seen.has(field.id) || !K.includes(field.kind) || !finite(field.weight) || field.weight < 0 || field.weight > 1000000
      || !Array.isArray(field.path) || !field.path.length || field.path.length > 8 || field.path.some(p => typeof p !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p))) throw new Error('Invalid scoring field.');
    const allowed = ['id', 'path', 'kind', 'weight', 'depends_on', 'tolerance', 'partial_range', 'iou_threshold', 'attributes'];
    if (Object.keys(field).some(k => !allowed.includes(k))) throw new Error('Unknown scoring option.');
    if (field.depends_on && (!Array.isArray(field.depends_on) || field.depends_on.some(id => !seen.has(id)))) throw new Error('Scoring dependencies must name earlier fields.');
    if (field.kind === 'number') {
      if (field.tolerance !== undefined && (!finite(field.tolerance) || field.tolerance < 0)) throw new Error('Numeric tolerance must be nonnegative.');
      if (field.partial_range !== undefined && (!finite(field.partial_range) || field.partial_range <= (field.tolerance || 0))) throw new Error('Partial range must exceed the exact tolerance.');
    } else if (field.tolerance !== undefined || field.partial_range !== undefined) throw new Error('Numeric tolerances only apply to number fields.');
    if (field.kind === 'objects') {
      if (!finite(field.iou_threshold) || field.iou_threshold <= 0 || field.iou_threshold > 1) throw new Error('Object matching requires an IoU threshold in (0,1].');
      if (field.attributes) {
        if (field.attributes.some(a => a.kind === 'objects')) throw new Error('Nested object matching is unsupported.');
        validateCorpusContract({ fields: field.attributes });
      }
    } else if (field.attributes !== undefined || field.iou_threshold !== undefined) throw new Error('Object matching options only apply to object fields.');
    seen.add(field.id);
  }
  if (!contract.fields.some(field => field.weight > 0)) throw new Error('Scoring contract needs a positive-weight field; zero weight is diagnostic only.');
  return contract;
}

function box(value) { return Array.isArray(value) && value.length === 4 && value.every(v => finite(v) && Math.abs(v) <= 1000000000) && value[2] > 0 && value[3] > 0; }
function iou(a, b) {
  const w = Math.max(0, Math.min(a[0] + a[2], b[0] + b[2]) - Math.max(a[0], b[0]));
  const h = Math.max(0, Math.min(a[1] + a[3], b[1] + b[3]) - Math.max(a[1], b[1]));
  return w * h / (a[2] * a[3] + b[2] * b[3] - w * h);
}

// Maximum-weight one-to-one assignment (Hungarian), padded with unmatched
// objects. A duplicated prediction cannot earn credit for two expected objects.
function assignment(weights) {
  const n = weights.length, m = Math.max(n, ...weights.map(row => row.length));
  const u = Array(n + 1).fill(0), v = Array(m + 1).fill(0), p = Array(m + 1).fill(0), way = Array(m + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i; let j0 = 0;
    const min = Array(m + 1).fill(Infinity), used = Array(m + 1).fill(false);
    do {
      used[j0] = true; const i0 = p[j0]; let delta = Infinity, j1 = 0;
      for (let j = 1; j <= m; j++) if (!used[j]) {
        const cost = -(weights[i0 - 1][j - 1] || 0) - u[i0] - v[j];
        if (cost < min[j]) { min[j] = cost; way[j] = j0; }
        if (min[j] < delta) { delta = min[j]; j1 = j; }
      }
      for (let j = 0; j <= m; j++) { if (used[j]) { u[p[j]] += delta; v[j] -= delta; } else min[j] -= delta; }
      j0 = j1;
    } while (p[j0]);
    do { const j1 = way[j0]; p[j0] = p[j1]; j0 = j1; } while (j0);
  }
  return p.slice(1).flatMap((row, column) => row ? [[row - 1, column]] : []);
}

function fieldScore(field, expected, prediction) {
  if (field.kind === 'exact') {
    const accepted = object(expected) && Array.isArray(expected.accepted) ? expected.accepted : [expected];
    if (!accepted.length || accepted.some(value => !equal(value, value))) throw new Error(`Invalid exact key: ${field.id}`);
    return accepted.some(value => equal(value, prediction)) ? 1 : 0;
  }
  if (field.kind === 'number') {
    if (!finite(expected)) throw new Error(`Invalid numeric key: ${field.id}`);
    if (!finite(prediction)) return 0;
    const error = Math.abs(prediction - expected), tolerance = field.tolerance || 0;
    return error <= tolerance ? 1 : field.partial_range ? Math.max(0, 1 - (error - tolerance) / (field.partial_range - tolerance)) : 0;
  }
  if (field.kind === 'set') {
    if (!Array.isArray(expected) || expected.length > L.objects || expected.some(v => !equal(v, v)) || new Set(expected).size !== expected.length) throw new Error(`Invalid set key: ${field.id}`);
    if (!Array.isArray(prediction) || prediction.length > L.objects || prediction.some(v => !equal(v, v))) return 0;
    const received = new Set(prediction), hits = expected.filter(v => received.has(v)).length;
    return !expected.length && !prediction.length ? 1 : 2 * hits / (expected.length + prediction.length);
  }
  if (!Array.isArray(expected) || expected.length > L.objects || expected.some(v => !object(v) || !box(v.box))) throw new Error(`Invalid object key: ${field.id}`);
  if (field.attributes) for (const item of expected) scoreFields(field.attributes, item, {}, true);
  if (!Array.isArray(prediction) || prediction.length > L.objects || prediction.some(v => !object(v) || !box(v.box))) return 0;
  if (!expected.length) return prediction.length ? 0 : 1;
  const weights = expected.map(a => prediction.map(b => { const overlap = iou(a.box, b.box); return overlap >= field.iou_threshold ? overlap : 0; }));
  const matches = assignment(weights).filter(([a, b]) => weights[a][b] > 0);
  const credit = matches.reduce((sum, [a, b]) => sum + (field.attributes ? scoreFields(field.attributes, expected[a], prediction[b], true).score : 1), 0);
  return credit / Math.max(expected.length, prediction.length);
}

function scoreFields(fields, expected, prediction, allowUnknownAttributes = false) {
  const values = {}, diagnostics = {}; let total = 0, weight = 0;
  for (const field of fields) {
    const answer = read(expected, field.path);
    if (answer === undefined) { diagnostics[field.id] = 'unknown'; continue; }
    if (object(answer) && answer.not_applicable === true && Object.keys(answer).length === 1) {
      diagnostics[field.id] = 'not_applicable'; continue;
    }
    const received = read(prediction, field.path);
    const scored = fieldScore(field, answer, received);
    values[field.id] = field.depends_on?.some(id => values[id] !== 1) ? 0 : scored;
    diagnostics[field.id] = values[field.id] === 1 ? 'correct'
      : received === undefined || received === null || received === '' ? 'missing'
      : values[field.id] > 0 ? 'partial' : 'incorrect';
    total += values[field.id] * field.weight; weight += field.weight;
  }
  if (!weight) {
    if (allowUnknownAttributes) return { score: 1, values, diagnostics }; // The matched box is known; its attributes are not.
    throw new Error('Answer key has no scoreable fields.');
  }
  return { score: total / weight, values, diagnostics };
}

export function scoreCorpusAnswer(contract, expected, prediction) {
  validateCorpusContract(contract);
  if (!object(expected)) throw new Error('Answer key must be an object.');
  return scoreFields(contract.fields, expected, prediction);
}
