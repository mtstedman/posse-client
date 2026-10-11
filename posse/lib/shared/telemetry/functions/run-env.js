// Run identity belongs to one orchestrator run. Service children inherit it;
// independently launched runs must start without the parent's identity.
export const RUN_TELEMETRY_ENV_KEYS = Object.freeze(["POSSE_RUN_ID", "POSSE_RUN_STARTED_AT"]);

export function environmentForNewRun(baseEnv = process.env) {
  const env = { ...baseEnv };
  for (const key of RUN_TELEMETRY_ENV_KEYS) delete env[key];
  return env;
}
