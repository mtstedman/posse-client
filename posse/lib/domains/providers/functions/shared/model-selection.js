export function selectExecutionModel({ jobModelName = null, globalModelOverride = null, tierModel = null } = {}) {
  return jobModelName || globalModelOverride || tierModel || null;
}
