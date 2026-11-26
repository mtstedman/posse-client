export function corpusCaseReport(evaluation, observations, { campaignID, runID }) {
  const fields = evaluation.contract.fields.map(field => field.id);
  const byID = new Map(observations.map(item => [item.case_id, item]));
  return { campaign_id: campaignID, run_id: runID, corpus_id: evaluation.corpus_id, corpus_revision: evaluation.corpus_revision,
    columns: ['label', 'tags', 'score', ...fields, 'resources', 'case_id'],
    rows: evaluation.cases.map(item => {
      const observation = byID.get(item.id);
      if (!observation?.detail) throw new Error('Missing verified case details.');
      return [String(item.label || 'Unlabeled case').slice(0, 240), (item.tags || []).slice(0, 16).map(tag => tag.slice(0, 64)),
        observation.detail.score, ...fields.map(field => observation.detail.values[field] ?? null), item.resource_labels || {}, item.id];
    }) };
}
export function corpusCaseSummary(report) {
  if (!report) return null;
  const perfect = report.rows.filter(row => row[2] === 1).length, failed = report.rows.filter(row => row[2] === 0).length;
  const tags = new Map();
  for (const row of report.rows) for (const tag of new Set(row[1])) { const record = tags.get(tag) || { tag, cases: 0, total: 0 }; record.cases++; record.total += row[2]; tags.set(tag, record); }
  const rows = [...report.rows].sort((a, b) => a[2] - b[2]).filter(row => row[2] < 1).slice(0, 20);
  return { run_id: report.run_id, corpus_id: report.corpus_id, corpus_revision: report.corpus_revision,
    total: report.rows.length, perfect, partial: report.rows.length - perfect - failed, failed,
    weakest_cases: { columns: report.columns, rows, omitted: Math.max(0, report.rows.length - perfect - rows.length) },
    tags: [...tags.values()].map(({ tag, cases, total }) => ({ tag, cases, mean_score: total / cases })).sort((a, b) => a.mean_score - b.mean_score).slice(0, 32) };
}
