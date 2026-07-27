import { AsyncLocalStorage } from "node:async_hooks";

const MAX_RECORDED_IGNORED_FIELDS = 64;
const MAX_RECORDED_PROOF_DEGRADATIONS = 64;
const diagnosticsStorage = new AsyncLocalStorage();

export function runWithHandoffFieldDiagnostics(fn) {
  const diagnostics = {
    ignoredFields: new Set(),
    proofDegradations: new Map(),
  };
  const value = diagnosticsStorage.run(diagnostics, fn);
  return {
    value,
    ignoredFieldCount: diagnostics.ignoredFields.size,
    ignoredFields: [...diagnostics.ignoredFields]
      .sort()
      .slice(0, MAX_RECORDED_IGNORED_FIELDS),
    degradedProofCount: diagnostics.proofDegradations.size,
    degradedProofs: [...diagnostics.proofDegradations.values()]
      .sort((left, right) => (
        left.path.localeCompare(right.path)
        || left.selector.localeCompare(right.selector)
      ))
      .slice(0, MAX_RECORDED_PROOF_DEGRADATIONS),
  };
}

export function recordHandoffProofDegradation({
  path,
  selector,
  ref,
  provenance,
} = {}) {
  const diagnostics = diagnosticsStorage.getStore();
  if (!diagnostics) return false;
  const normalized = {
    path: String(path || ""),
    selector: String(selector || ""),
    ref: String(ref || ""),
    provenance: String(provenance || ""),
    from: "proof",
    to: "support",
    reason: "agent_authored_proof",
  };
  const key = `${normalized.path}\0${normalized.selector}`;
  if (!diagnostics.proofDegradations.has(key)) {
    diagnostics.proofDegradations.set(key, Object.freeze(normalized));
  }
  return true;
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
