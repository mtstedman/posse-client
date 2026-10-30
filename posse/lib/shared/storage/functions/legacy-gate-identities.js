import { canonicalHumanGatePayload, humanInputChoicesForPayload, HUMAN_GATE_ACTIONS } from "../../../catalog/human-input.js";

// Read old persisted formats exactly once at the storage boundary. These are
// not runtime aliases and must never be used by gate producers or resolvers.
const LEGACY_GATE_IDS = Object.freeze({
  "scope_expansion_request": "file_scope_approval",
  "scope_expansion_required": "file_scope_approval",
  "research_dead_letter_recovery": "dead_letter_recovery",
  "oneshot_dead_letter_recovery": "dead_letter_recovery",
  "assessment_parse_error": "assessment_review",
  "assessment_transport_error": "assessment_transport_recovery",
  "replan_limit": "pipeline_head_recovery",
  "unexecuted_replan_limit": "unexecuted_replan_recovery",
  "oneshot_scope_selection": "one_shot_file_scope",
  "developer_blocked": "blocked_recovery",
  "blocked_cycle_exhausted": "partial_work_recovery",
  "assessor_evidence_unavailable": "assessment_evidence_missing",
  "assessment_transport_unavailable": "assessment_transport_recovery",
  "assessment_retry_exhausted": "assessment_retry_limit",
  "artifact_routing_unavailable": "artifact_routing_admin",
  "repository_recovery": "shared_trunk_provenance",
  "assessment": "assessment_review",
  "needs_review": "assessment_review",
  "unknown_verdict": "assessment_review"
});

function legacyGateRawKind(payload) {
  return (payload.review_type === "planner_clarification" ? payload.review_type : payload.gate_kind)
    || payload.review_type || payload.subtype
    || (payload.file_requests?.length ? "file_scope_approval" : "clarification");
}

export function migrateLegacyGatePayload(payload) {
  const raw = legacyGateRawKind(payload);
  const kind = LEGACY_GATE_IDS[raw] || raw;
  if (!Object.hasOwn(HUMAN_GATE_ACTIONS, kind)) throw new Error(`Cannot migrate unknown gate ID: ${kind}`);
  const canonical = canonicalHumanGatePayload({ ...payload, review_type: kind, gate_kind: kind, question_kind: kind,
    ...(payload.subtype ? { subtype: kind } : {}) });
  if (Array.isArray(payload.choices)) canonical.choices = humanInputChoicesForPayload(canonical);
  return canonical;
}

// Rows the upgrade cannot rewrite are audited and left exactly as stored.
// Data-shape failures (an unknown gate id, an unparseable or self-inconsistent
// payload) are deterministic, and a uniqueness collision means two open
// decisions would merge; neither may hold the whole database closed, and
// neither may discard an operator decision. Other SQLite failures still throw.
function gateIdentityMigrationFailure(error) {
  if (error?.code === "SQLITE_CONSTRAINT_UNIQUE" || /UNIQUE constraint failed/.test(String(error?.message || ""))) {
    return "unique_collision";
  }
  if (typeof error?.code === "string" && error.code.startsWith("SQLITE_")) return null;
  return /unknown gate ID/.test(String(error?.message || "")) ? "unknown_gate_id" : "invalid_payload";
}

export function migrateLegacyGateIdentities(db) {
  return db.transaction(() => {
    const rows = db.prepare("SELECT id, payload_json FROM jobs WHERE job_type = 'human_input'").all();
    const updateJob = db.prepare("UPDATE jobs SET payload_json = ? WHERE id = ?");
    const updateGate = db.prepare("UPDATE human_gates SET gate_kind = ? WHERE gate_job_id = ?");
    // Keep decisions, state, generation, leases and source-state grants
    // untouched. Each row runs in its own savepoint so a failed UPDATE rolls
    // back only that row's payload rewrite and never poisons the upgrade.
    const migrateRow = db.transaction((row) => {
      const canonical = migrateLegacyGatePayload(JSON.parse(row.payload_json || "{}"));
      const serialized = JSON.stringify(canonical);
      const rewritten = serialized !== row.payload_json;
      if (rewritten) updateJob.run(serialized, row.id);
      updateGate.run(canonical.gate_kind, row.id);
      return rewritten;
    });
    let changed = false;
    for (const row of rows) {
      try {
        if (migrateRow(row)) changed = true;
      } catch (error) {
        const reason = gateIdentityMigrationFailure(error);
        if (!reason) throw error;
        let raw = null;
        try { raw = legacyGateRawKind(JSON.parse(row.payload_json || "{}")); } catch { /* unparseable payload */ }
        db.exec(`CREATE TABLE IF NOT EXISTS gate_identity_migration_audit (
          id INTEGER PRIMARY KEY, job_id INTEGER NOT NULL, raw_kind TEXT, canonical_kind TEXT,
          reason TEXT NOT NULL,
          migrated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )`);
        db.prepare("INSERT INTO gate_identity_migration_audit (job_id, raw_kind, canonical_kind, reason) VALUES (?, ?, ?, ?)")
          .run(row.id, raw == null ? null : String(raw), raw == null ? null : (LEGACY_GATE_IDS[raw] || String(raw)),
            `${reason}: ${String(error?.message || error).slice(0, 500)}`);
      }
    }
    return changed;
  })();
}

export function migrateLegacyGatePolicies(db) {
  return db.transaction(() => {
    let changed = false;
    for (const table of ["account_settings", "repo_settings"]) {
      const rows = db.prepare(`SELECT * FROM ${table} WHERE setting_key LIKE 'approval_policy_%'`).all();
      const groups = new Map();
      for (const row of rows) {
        const raw = row.setting_key.slice("approval_policy_".length);
        const kind = LEGACY_GATE_IDS[raw] || raw;
        const id = JSON.stringify([row.repo_path || null, kind]);
        const group = groups.get(id) || [];
        group.push({ ...row, kind });
        groups.set(id, group);
      }
      for (const group of groups.values()) {
        const target = `approval_policy_${group[0].kind}`;
        if (group.every((row) => row.setting_key === target)) continue;
        const explicit = [...new Set(group.map((row) => row.setting_value).filter((value) => value !== "ask"))];
        // Defaults cannot erase a saved decision. Conflicting explicit
        // decisions close authority rather than selecting an auto-approval.
        const selected = explicit.length === 1 ? explicit[0] : explicit.length > 1 ? "fail_closed" : "ask";
        db.exec(`CREATE TABLE IF NOT EXISTS gate_policy_migration_audit (
          id INTEGER PRIMARY KEY, repo_path TEXT, canonical_key TEXT NOT NULL,
          previous_values_json TEXT NOT NULL, selected_value TEXT NOT NULL,
          migrated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        )`);
        db.prepare("INSERT INTO gate_policy_migration_audit (repo_path, canonical_key, previous_values_json, selected_value) VALUES (?, ?, ?, ?)")
          .run(group[0].repo_path || null, target, JSON.stringify(group), selected);
        for (const row of group) {
          if (table === "repo_settings") db.prepare("DELETE FROM repo_settings WHERE repo_path=? AND setting_key=?").run(row.repo_path, row.setting_key);
          else db.prepare("DELETE FROM account_settings WHERE setting_key=?").run(row.setting_key);
        }
        if (table === "repo_settings") db.prepare("INSERT INTO repo_settings (repo_path, setting_key, setting_value) VALUES (?, ?, ?)").run(group[0].repo_path, target, selected);
        else db.prepare("INSERT INTO account_settings (setting_key, setting_value) VALUES (?, ?)").run(target, selected);
        changed = true;
      }
    }
    return changed;
  })();
}
