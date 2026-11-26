import path from 'node:path';
import { EXPERIMENT_CORPUS_EVALUATION_SCHEMA } from '../../../catalog/experiment-corpus.js';
import { validateCorpusContract, scoreCorpusAnswer } from './corpus-scoring.js';
import { validResourceBinding } from './corpus-inputs.js';
import { experimentDigest } from "./snapshots.js";
import { EXPERIMENT_NUMERIC_SCHEMA, EXPERIMENT_NUMERIC_SCORERS, EXPERIMENT_SANDBOX_LIMITS as L } from "../../../catalog/experiments.js";

// This first executor supports numeric prediction experiments. Expected values
// stay with the owner; only inputs and case IDs go into the payload sandbox.
export function validateNumericEvaluation(plan, evaluation) {
  if (evaluation?.schema === EXPERIMENT_CORPUS_EVALUATION_SCHEMA) return validateCorpusEvaluation(plan, evaluation);
  if (!evaluation || experimentDigest(evaluation) !== plan.evaluation.digest || evaluation.schema !== EXPERIMENT_NUMERIC_SCHEMA
    || !Array.isArray(evaluation.cases) || evaluation.cases.length < 1 || evaluation.cases.length > L.cases
    || Buffer.byteLength(JSON.stringify(evaluation)) > L.evaluationBytes) throw new Error("Evaluation identity or size is invalid.");
  const ids = new Set();
  for (const item of evaluation.cases) {
    if (!item || !/^[a-zA-Z0-9_.:-]{1,128}$/.test(item.id || "") || ids.has(item.id) || !Number.isFinite(item.expected) || !Object.hasOwn(item, "input")) throw new Error("Invalid evaluation case.");
    ids.add(item.id);
  }
  const scorers = evaluation.scorers;
  if (!scorers || Array.isArray(scorers) || Object.keys(scorers).length !== plan.metrics.length || plan.metrics.some(m => !Object.hasOwn(scorers, m.id) || !EXPERIMENT_NUMERIC_SCORERS.includes(scorers[m.id]))) throw new Error("Evaluation scorers must cover the declared metrics.");
  return evaluation;
}

export function scorePrediction(evaluation, message) {
  if (evaluation?.schema === EXPERIMENT_CORPUS_EVALUATION_SCHEMA) {
    if (!message || Object.keys(message).length !== 2 || !message.prediction || typeof message.prediction !== "object" || Array.isArray(message.prediction)) throw new Error("Invalid structured prediction.");
    const item = evaluation.cases.find(row => row.id === message.case_id);
    if (!item) throw new Error("Unknown evaluation case.");
    const result = scoreCorpusAnswer(evaluation.contract, item.expected, message.prediction);
    return { case_id: item.id, detail: result, values: Object.fromEntries(Object.entries(evaluation.scorers).map(([id, field]) => [id, field === "score" ? result.score : result.values[field]])) };
  }
  if (!message || Object.keys(message).length !== 2 || !Object.hasOwn(message, "case_id") || !Object.hasOwn(message, "prediction") || !Number.isFinite(message.prediction)) throw new Error("Invalid prediction message.");
  const item = evaluation.cases.find(row => row.id === message.case_id);
  if (!item) throw new Error("Unknown evaluation case.");
  const error = message.prediction - item.expected;
  const values = Object.fromEntries(Object.entries(evaluation.scorers).map(([id, scorer]) => [id,
    scorer === "exact_match" ? Number(message.prediction === item.expected) : scorer === "absolute_error" ? Math.abs(error) : error * error]));
  if (Object.values(values).some(value => !Number.isFinite(value))) throw new Error("Nonfinite score.");
  return { case_id: item.id, values };
}

function validateCorpusEvaluation(plan, evaluation) {
  if (experimentDigest(evaluation) !== plan.evaluation.digest || !Array.isArray(evaluation.cases) || !evaluation.cases.length || evaluation.cases.length > L.cases
    || Buffer.byteLength(JSON.stringify(evaluation)) > L.evaluationBytes || !evaluation.resources || typeof evaluation.resources !== 'object') throw new Error('Invalid corpus evaluation identity or size.');
  validateCorpusContract(evaluation.contract);
  const fields = new Set(['score', ...evaluation.contract.fields.map(field => field.id)]);
  if (!evaluation.scorers || Object.keys(evaluation.scorers).length !== plan.metrics.length || plan.metrics.some(metric => !Object.hasOwn(evaluation.scorers, metric.id) || !fields.has(evaluation.scorers[metric.id]))) throw new Error('Corpus scorers must cover the declared metrics.');
  const ids = new Set();
  for (const item of evaluation.cases) {
    if (!/^[a-f0-9]{64}$/.test(item.id || '') || ids.has(item.id) || !Object.hasOwn(item, 'input') || !item.resources || typeof item.resources !== 'object' || Array.isArray(item.resources) || !Object.keys(item.resources).length) throw new Error('Invalid corpus case.');
    ids.add(item.id);
    const scored = scoreCorpusAnswer(evaluation.contract, item.expected, {});
    for (const field of Object.values(evaluation.scorers)) if (field !== 'score' && !Object.hasOwn(scored.values, field)) throw new Error('Missing answer coverage for a selected metric.');
    for (const [alias, binding] of Object.entries(item.resources)) {
      if (!/^[a-z][a-z0-9_]{0,63}$/.test(alias) || !validResourceBinding(binding)) throw new Error('Invalid resource binding.');
      const resource = evaluation.resources[binding.resource_id];
      if (!resource || !path.isAbsolute(resource.archive_path || '') || resource.manifest?.resource_id !== binding.resource_id) throw new Error('Missing corpus archive binding.');
    }
  }
  return evaluation;
}
