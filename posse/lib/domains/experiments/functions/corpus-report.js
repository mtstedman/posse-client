import { EXPERIMENT_LATENCY_METRIC as LATENCY, EXPERIMENT_LATENCY_DEFINITION } from '../../../catalog/experiment-measurement.js';
import { EXPERIMENT_CORPUS_FIELD_STATUSES as STATUSES } from '../../../catalog/experiment-corpus.js';
import { hasLatencyMeasurement } from './evaluation.js';

export function corpusCaseReport(evaluation, observations, { campaignID, runID }) {
  const fields = evaluation.contract.fields.map(field => field.id);
  const timed = hasLatencyMeasurement(evaluation);
  const byID = new Map(observations.map(item => [item.case_id, item]));
  return { campaign_id: campaignID, run_id: runID, corpus_id: evaluation.corpus_id, corpus_revision: evaluation.corpus_revision,
    ...(timed ? { measurement: EXPERIMENT_LATENCY_DEFINITION } : {}),
    field_summary: corpusFieldSummary(evaluation.contract, observations),
    columns: ['label', 'tags', 'score', ...fields, ...(timed ? [LATENCY] : []), 'resources', 'case_id'],
    rows: evaluation.cases.map(item => {
      const observation = byID.get(item.id);
      if (!observation?.detail) throw new Error('Missing verified case details.');
      if (timed && (!Number.isFinite(observation.values?.[LATENCY]) || observation.values[LATENCY] < 0)) throw new Error('Missing verified case latency.');
      return [String(item.label || 'Unlabeled case').slice(0, 240), (item.tags || []).slice(0, 16).map(tag => tag.slice(0, 64)),
        observation.detail.score, ...fields.map(field => observation.detail.values[field] ?? null), ...(timed ? [observation.values[LATENCY]] : []), item.resource_labels || {}, item.id];
    }) };
}
export function corpusCaseSummary(report) {
  if (!report) return null;
  const perfect = report.rows.filter(row => row[2] === 1).length, failed = report.rows.filter(row => row[2] === 0).length;
  const tags = new Map();
  for (const row of report.rows) for (const tag of new Set(row[1])) { const record = tags.get(tag) || { tag, cases: 0, total: 0 }; record.cases++; record.total += row[2]; tags.set(tag, record); }
  const rows = [...report.rows].sort((a, b) => a[2] - b[2]).filter(row => row[2] < 1).slice(0, 20);
  return { run_id: report.run_id, corpus_id: report.corpus_id, corpus_revision: report.corpus_revision,
    field_summary: report.field_summary,
    total: report.rows.length, perfect, partial: report.rows.length - perfect - failed, failed,
    weakest_cases: { columns: report.columns, rows, omitted: Math.max(0, report.rows.length - perfect - rows.length) },
    tags: [...tags.values()].map(({ tag, cases, total }) => ({ tag, cases, mean_score: total / cases })).sort((a, b) => a.mean_score - b.mean_score).slice(0, 32) };
}

// Owner-only aggregate evidence: no predictions, answer strings, labels or images.
export function corpusFieldSummary(contract, observations) {
  return { columns: ['field', 'samples', ...STATUSES, 'mean_score', 'accuracy', 'accuracy_when_returned'],
    rows: contract.fields.map(field => {
      const counts = Object.fromEntries(STATUSES.map(status => [status, 0]));
      let sum = 0, samples = 0;
      for (const observation of observations) {
        const value = observation.detail?.values?.[field.id];
        const status = observation.detail?.diagnostics?.[field.id];
        // Old evidence cannot distinguish a missing reading from an incorrect one.
        if (STATUSES.includes(status)) counts[status]++;
        else counts.unknown++;
        if (Number.isFinite(value)) { samples++; sum += value; }
      }
      const known = counts.correct + counts.partial + counts.incorrect + counts.missing;
      const returned = known - counts.missing;
      return [field.id, samples, ...STATUSES.map(status => counts[status]), samples ? sum / samples : null,
        known ? counts.correct / known : null, returned ? counts.correct / returned : null];
    }) };
}
