import { EXPERIMENT_BUDGET_POLICY } from '../../../catalog/experiment-budget.js';
import { getSetting } from '../../settings/functions/repository-settings.js';

export function experimentBudget(overrides = {}, readSetting = getSetting) {
  if (!overrides || typeof overrides !== 'object' || Array.isArray(overrides) || Object.keys(overrides).some(key => !Object.hasOwn(EXPERIMENT_BUDGET_POLICY, key))) throw new Error('Invalid experiment budget fields.');
  return Object.fromEntries(Object.entries(EXPERIMENT_BUDGET_POLICY).map(([field, rule]) => {
    if (Object.hasOwn(overrides, field) && typeof overrides[field] !== 'number') throw new Error(`Invalid experiment budget: ${field}`);
    const stored = Object.hasOwn(overrides, field) ? overrides[field] : readSetting(rule.key);
    const value = stored == null || stored === '' ? rule.default : Number(stored);
    if (!Number.isFinite(value) || value <= 0 || value > rule.max || (field !== 'spend_usd' && !Number.isInteger(value))) throw new Error(`Invalid experiment budget: ${field}`);
    return [field, value];
  }));
}

export function experimentBudgetNudge(record, now) {
  const budget = record.setup.budget, usage = record.usage;
  if (!['model_calls', 'tokens', 'spend_usd'].some(key => usage[key] >= budget[key] * 0.8) && now < record.started_at + budget.wall_seconds * 800) return '';
  return `Budget nearing its limit: ${Math.max(0, budget.model_calls - usage.model_calls)} calls, ${Math.max(0, budget.tokens - usage.tokens)} tokens, ${Math.max(0, Math.floor((record.deadline_at - now) / 1000))} seconds remain. Reuse supplied source and converge on a supported submission; do not skip review or invent evidence.`;
}
