export function selectExecutionModel({ jobModelName = null, globalModelOverride = null, tierModel = null } = {}) {
  // An explicit job/delegator choice is authoritative. Tier routing comes
  // next so a legacy provider-wide default (for example `claude_model=opus`)
  // cannot collapse cheap, standard, and strong work onto one model.
  // Provider-wide settings remain a compatibility fallback when a tier has
  // no configured/catalog model.
  return jobModelName || tierModel || globalModelOverride || null;
}
