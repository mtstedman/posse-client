import { EXPERIMENT_RUNNER_ROLES, EXPERIMENT_NUMERIC_SCHEMA } from './experiments.js';

export const EXPERIMENT_WORKSPACE_SCHEMA = 'posse.experiment.workspace.v1';
export const EXPERIMENT_INIT_FIELDS = ['name', 'setup', 'evaluation', 'image', 'runtime_path', 'trunk_branch', 'mapping', 'checks', 'prepare'];
export const EXPERIMENT_WORKSPACE_ACTIONS = ['launch', 'status', 'progress', 'stop'];
export const EXPERIMENT_INIT_DEFAULTS = {
  images: { node: 'node:22-bookworm-slim', python: 'python:3.12-slim' },
  models: Object.fromEntries(EXPERIMENT_RUNNER_ROLES.map(role => [role, { model: 'standard', reasoning_effort: 'medium' }])),
  budget: { model_calls: 100, wall_seconds: 3600, tokens: 1000000, spend_usd: 25 },
  integration_budget: { model_calls: 0, tokens: 0, spend_usd: 0, wall_seconds: 600 },
};
export function experimentInitContract() {
  return { fields: EXPERIMENT_INIT_FIELDS, defaults: EXPERIMENT_INIT_DEFAULTS,
    example: { name: 'algorithm-v1', setup: { plan: {
      objective: 'Reduce prediction error', entrypoint: 'work/main.mjs',
      files: [{ path: 'work/main.mjs', mode: 'read', instructions: 'Frozen JSONL adapter.' }, { path: 'work/src/algorithm.mjs', mode: 'modify', instructions: 'Improve the algorithm while preserving its interface.' }],
      metrics: [{ id: 'error', unit: 'units', role: 'goal', direction: 'lower', aggregation: 'mean', target: 0.01 }],
    } }, evaluation: { schema: EXPERIMENT_NUMERIC_SCHEMA, cases: [{ id: 'case-1', input: 1.2, expected: 1 }], scorers: { error: 'absolute_error' } },
    checks: [{ program: 'node', args: ['--test'], cwd: '.', timeout_seconds: 120 }] },
    note: 'Supply representative evaluation cases, objective, metrics, file scope, and checks. Files default to pinned Git contents at the path after work/. Inline read-only adapters may be supplied in setup.files. Initialization prepares and validates without model calls; launch starts the prepared experiment.' };
}
