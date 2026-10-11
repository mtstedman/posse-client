// Shared view-derived state mechanics. Domain algorithms stay with their owner.

export function recordRun(db, kind, status, durationMs, details) {
  try {
    db.prepare(
      "INSERT INTO derived_state_runs(built_at, kind, status, duration_ms, details_json) VALUES (?, ?, ?, ?, ?)",
    ).run(new Date().toISOString(), kind, status, Math.max(0, Math.round(durationMs)), JSON.stringify(details || {}));
  } catch {
    // Derived-state telemetry must never break the caller's operation.
  }
}

export function rollbackSavepoint(db, name) {
  try { db.exec(`ROLLBACK TO ${name}`); } catch { /* preserve the writer error */ }
  try { db.exec(`RELEASE ${name}`); } catch { /* preserve the writer error */ }
}

export function parseJsonArray(value) {
  try {
    const parsed = JSON.parse(String(value || "[]"));
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function parseJsonObject(value) {
  try {
    const parsed = JSON.parse(String(value || "{}"));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}
