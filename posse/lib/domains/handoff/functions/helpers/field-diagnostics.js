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

// A decorated spelling of a known key ("#evidence", "evidence:", " Evidence")
// is that key. Atlas531 JS_UNDICI_2 sent every claim's refs under "#evidence";
// ignoring them staged a report with no cited evidence on any claim.
function undecoratedHandoffKey(key) {
  return String(key).trim().replace(/^[^A-Za-z0-9_]+|[^A-Za-z0-9_]+$/g, "").toLowerCase();
}

export function filterKnownHandoffFields(object, allowed, label) {
  const diagnostics = diagnosticsStorage.getStore();
  if (!diagnostics) return null;

  const allowedSet = new Set(allowed);
  const filtered = {};
  const repaired = [];
  for (const [key, value] of Object.entries(object)) {
    if (allowedSet.has(key)) {
      filtered[key] = value;
      continue;
    }
    const known = allowed.find((name) => name.toLowerCase() === undecoratedHandoffKey(key));
    if (known) {
      repaired.push([key, known, value]);
      continue;
    }
    diagnostics.ignoredFields.add(`${label}.${key}`);
  }
  // The exact key always wins; a decorated duplicate of a key already given,
  // or of one another decorated key already claimed, stays ignored.
  for (const [key, known, value] of repaired) {
    if (Object.hasOwn(filtered, known)) {
      diagnostics.ignoredFields.add(`${label}.${key}`);
      continue;
    }
    filtered[known] = value;
    // A handoff object can pass through this filter more than once (compact
    // then canonical shape); one repair is one note.
    const path = `${label}.${known}`;
    const noted = diagnostics.softenings.some((note) => note.path === path
      && note.rule === "field_key_repaired" && note.detail?.received === key);
    if (!noted) recordHandoffSoftening(path, "field_key_repaired", { received: key });
  }
  return filtered;
}
