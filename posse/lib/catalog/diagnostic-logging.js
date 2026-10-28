// Plumbing classes are opt-in. Lifecycle, gates, costs and failures retain
// their ordinary recorders regardless of this setting.
export function isDiagnosticObservation(type) {
  const name = String(type || "");
  if (/(?:^|[._])(error|failed|failure|warning|denied|blocked)(?:$|[._])/.test(name)) return false;
  return /^atlas\.(?:buffer_push|index_refresh)(?:\.|$)/.test(name)
    || name.startsWith("atlas.prefetch.") || name.startsWith("context_meter.")
    || name.startsWith("hash_ref.surface") || name.startsWith("memory.")
    || (name.startsWith("tool.") && name.endsWith(".started"));
}
