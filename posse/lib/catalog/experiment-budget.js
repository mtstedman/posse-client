// Account defaults are resolved once during initialization; approved runs stay fixed.
export const EXPERIMENT_BUDGET_POLICY = Object.freeze({
  model_calls: { key: 'experiment_default_model_calls', default: 125, max: 1000, label: 'Experiment model calls' },
  tokens: { key: 'experiment_default_tokens', default: 1500000, max: 10000000, label: 'Experiment tokens' },
  wall_seconds: { key: 'experiment_default_wall_seconds', default: 3600, max: 14400, label: 'Experiment duration (seconds)' },
  spend_usd: { key: 'experiment_default_spend_usd', default: 25, max: 100, label: 'Experiment spend (USD)' },
});
export const EXPERIMENT_BUDGET_DEFAULTS = Object.freeze(Object.fromEntries(Object.entries(EXPERIMENT_BUDGET_POLICY).map(([field, rule]) => [field, rule.default])));
export const EXPERIMENT_BUDGET_SCHEMA = { type: 'object', additionalProperties: false, required: Object.keys(EXPERIMENT_BUDGET_POLICY),
  properties: Object.fromEntries(Object.entries(EXPERIMENT_BUDGET_POLICY).map(([field, rule]) => [field,
    { type: field === 'spend_usd' ? 'number' : 'integer', exclusiveMinimum: 0, maximum: rule.max }])) };
export const EXPERIMENT_BUDGET_SETTINGS = Object.values(EXPERIMENT_BUDGET_POLICY).map(rule => ({ key: rule.key, default: String(rule.default), label: rule.label,
  numeric: { integer: rule.key !== 'experiment_default_spend_usd', min: rule.key === 'experiment_default_spend_usd' ? 0.01 : 1, max: rule.max },
  description: 'Default for newly initialized experiment runners. setup.budget overrides this value per experiment. Existing initialized runs keep their approved budget.' }));
