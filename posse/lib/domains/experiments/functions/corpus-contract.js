import { EXPERIMENT_CORPUS_CONTEXT_ALIAS_LIMIT as ALIAS_LIMIT } from '../../../catalog/experiment-corpus.js';

// Public usage information only. Resource contents, case settings and answer
// keys are deliberately absent from this bounded agent context.
export function validateCorpusInterface(value) {
  if (value === undefined) return;
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !['resources', 'input', 'prediction', 'requirements'].includes(key)) || Buffer.byteLength(JSON.stringify(value)) > 8192) throw new Error('Invalid corpus interface.');
  for (const key of ['resources', 'input', 'prediction']) {
    if (value[key] === undefined) continue;
    const fields = value[key];
    if (!fields || typeof fields !== 'object' || Array.isArray(fields) || Object.keys(fields).length > 32
      || Object.entries(fields).some(([name, description]) => !/^[a-zA-Z][a-zA-Z0-9_.-]{0,63}$/.test(name) || typeof description !== 'string' || !description.trim() || description.length > 512)) throw new Error('Corpus interface fields require short names and descriptions.');
  }
  if (value.requirements !== undefined && (!Array.isArray(value.requirements) || value.requirements.length > 16 || value.requirements.some(text => typeof text !== 'string' || text.length > 512))) throw new Error('Invalid corpus runtime requirements.');
}
export function publicCorpusContract(evaluation) {
  const aliases = [...new Set(evaluation.cases.flatMap(item => Object.keys(item.resources)))].sort();
  return { id: evaluation.corpus_id, revision: evaluation.corpus_revision, contract: evaluation.contract,
    resource_aliases: aliases.slice(0, ALIAS_LIMIT),
    ...(aliases.length > ALIAS_LIMIT ? { resource_aliases_omitted: aliases.length - ALIAS_LIMIT } : {}) };
}
