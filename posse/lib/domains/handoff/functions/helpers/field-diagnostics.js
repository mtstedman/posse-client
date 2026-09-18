import { AsyncLocalStorage } from "node:async_hooks";

const MAX_RECORDED_IGNORED_FIELDS = 64;
const MAX_RECORDED_SOFTENINGS = 64;
const diagnosticsStorage = new AsyncLocalStorage();

export function runWithHandoffFieldDiagnostics(fn) {
  const diagnostics = {
    ignoredFields: new Set(),
    softenings: [],
  };
  const value = diagnosticsStorage.run(diagnostics, fn);
  return {
    value,
    ignoredFieldCount: diagnostics.ignoredFields.size,
    ignoredFields: [...diagnostics.ignoredFields]
      .sort()
      .slice(0, MAX_RECORDED_IGNORED_FIELDS),
    softenings: diagnostics.softenings.slice(0, MAX_RECORDED_SOFTENINGS),
  };
}

// A documented cap that was exceeded and applied in place (text truncated,
// list trimmed, aggregate budget noted) instead of rejecting the handoff.
// Rejection costs the producer a whole extra turn on its full context; the
// cap only ever protected downstream context, so applying it is cheaper.
export function recordHandoffSoftening(fieldPath, rule, detail = null) {
  const diagnostics = diagnosticsStorage.getStore();
  if (!diagnostics || diagnostics.softenings.length >= MAX_RECORDED_SOFTENINGS) return;
  diagnostics.softenings.push({
    path: String(fieldPath),
    rule: String(rule),
    ...(detail == null ? {} : { detail }),
  });
}

export function filterKnownHandoffFields(object, allowed, label) {
  const diagnostics = diagnosticsStorage.getStore();
  if (!diagnostics) return null;

  const allowedSet = new Set(allowed);
  const filtered = {};
  for (const [key, value] of Object.entries(object)) {
    if (allowedSet.has(key)) {
      filtered[key] = value;
      continue;
    }
    diagnostics.ignoredFields.add(`${label}.${key}`);
  }
  return filtered;
}
