const text = maxLength => ({ type: 'string', minLength: 1, maxLength });
export const EXPERIMENT_CANDIDATE_CHECK_LIMITS = Object.freeze({ checks: 8, timeoutSeconds: 120, totalSeconds: 300,
  outputBytes: 65536, diagnosticBytes: 6000, repairs: 2, entrypoint: 'work/posse-candidate-check', cache: 16 });
export const EXPERIMENT_CANDIDATE_CHECKS_SCHEMA = { type: 'array', maxItems: EXPERIMENT_CANDIDATE_CHECK_LIMITS.checks,
  items: { type: 'object', additionalProperties: false, required: ['program', 'args', 'cwd', 'timeout_seconds', 'when_nonempty'], properties: {
    program: text(1024), args: { type: 'array', maxItems: 64, items: { type: 'string', maxLength: 8000 } }, cwd: text(240),
    timeout_seconds: { type: 'integer', minimum: 1, maximum: EXPERIMENT_CANDIDATE_CHECK_LIMITS.timeoutSeconds },
    when_nonempty: { type: 'array', maxItems: 8, uniqueItems: true, items: text(240) },
  } } };
