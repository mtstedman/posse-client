export const ADMISSION_BUDGET_SCHEMA = `
CREATE TABLE IF NOT EXISTS work_item_budgets (
  work_item_id INTEGER PRIMARY KEY REFERENCES work_items(id) ON DELETE CASCADE,
  enabled INTEGER NOT NULL DEFAULT 1,
  limit_usd REAL,
  reservation_usd REAL,
  deadline_at INTEGER,
  paused_reason TEXT,
  audit_json TEXT NOT NULL DEFAULT '[]'
);
CREATE TABLE IF NOT EXISTS budget_reservations (
  id TEXT PRIMARY KEY,
  work_item_id INTEGER NOT NULL REFERENCES work_items(id) ON DELETE CASCADE,
  job_id INTEGER REFERENCES jobs(id) ON DELETE SET NULL,
  agent_call_id INTEGER REFERENCES agent_calls(id) ON DELETE SET NULL,
  attempt_id INTEGER REFERENCES job_attempts(id) ON DELETE SET NULL,
  owner_pid INTEGER NOT NULL,
  provider TEXT,
  model TEXT,
  role TEXT,
  reserved_usd REAL,
  cost_usd REAL,
  state TEXT NOT NULL CHECK (state IN ('reserved','settled','unknown')),
  started_at INTEGER NOT NULL,
  finished_at INTEGER,
  reconciliation_reason TEXT
);
CREATE INDEX IF NOT EXISTS idx_budget_reservations_work_item ON budget_reservations(work_item_id, state);
`;

export function installAdmissionBudgetSchema(db) { db.exec(ADMISSION_BUDGET_SCHEMA); }
export function needsAdmissionBudgetSchema(db) {
  return db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('work_item_budgets', 'budget_reservations')").all().length !== 2;
}
