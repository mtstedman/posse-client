import { experimentDigest } from "./snapshots.js";
import { EXPERIMENT_NUMERIC_SCHEMA, EXPERIMENT_NUMERIC_SCORERS, EXPERIMENT_SANDBOX_LIMITS as L } from "../../../catalog/experiments.js";

// This first executor supports numeric prediction experiments. Expected values
// stay with the owner; only inputs and case IDs go into the payload sandbox.
export function validateNumericEvaluation(plan, evaluation) {
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
  if (!message || Object.keys(message).length !== 2 || !Object.hasOwn(message, "case_id") || !Object.hasOwn(message, "prediction") || !Number.isFinite(message.prediction)) throw new Error("Invalid prediction message.");
  const item = evaluation.cases.find(row => row.id === message.case_id);
  if (!item) throw new Error("Unknown evaluation case.");
  const error = message.prediction - item.expected;
  const values = Object.fromEntries(Object.entries(evaluation.scorers).map(([id, scorer]) => [id,
    scorer === "exact_match" ? Number(message.prediction === item.expected) : scorer === "absolute_error" ? Math.abs(error) : error * error]));
  if (Object.values(values).some(value => !Number.isFinite(value))) throw new Error("Nonfinite score.");
  return { case_id: item.id, values };
}
