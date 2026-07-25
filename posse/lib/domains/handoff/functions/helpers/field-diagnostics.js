import { AsyncLocalStorage } from "node:async_hooks";

const MAX_RECORDED_IGNORED_FIELDS = 64;
const diagnosticsStorage = new AsyncLocalStorage();

export function runWithHandoffFieldDiagnostics(fn) {
  const diagnostics = {
    ignoredFields: new Set(),
  };
  const value = diagnosticsStorage.run(diagnostics, fn);
  return {
    value,
    ignoredFieldCount: diagnostics.ignoredFields.size,
    ignoredFields: [...diagnostics.ignoredFields]
      .sort()
      .slice(0, MAX_RECORDED_IGNORED_FIELDS),
  };
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
