// Durable snapshot of a job's closed conversation tool groups
// (posse.agent_conversation.v1). job_observations rows are pruned once a job
// is terminal plus a grace window; job closeout snapshots each closed group
// here so finished jobs keep their tool calls. Rows cascade with the job and
// Work Item and are pruned by the admin retention pass.
//
// Additive and unversioned like the hash-ref and handoff-packet tables: the
// installer runs on every open, and the host schema version is unchanged so
// mixed-version fleet readers (Bossy's schema gate) keep managing instances.
export const AGENT_TOOL_GROUPS_SCHEMA = `
CREATE TABLE IF NOT EXISTS agent_tool_groups (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  work_item_id INTEGER REFERENCES work_items(id) ON DELETE CASCADE,
  job_id INTEGER NOT NULL REFERENCES jobs(id) ON DELETE CASCADE,
  attempt_id INTEGER,
  agent_call_id INTEGER,
  parent_agent_call_id INTEGER,
  partition_key TEXT NOT NULL,
  group_seq INTEGER NOT NULL CHECK (group_seq >= 0),
  closed_by TEXT NOT NULL CHECK (closed_by IN ('agent_message','gate','call_end','job_end')),
  closing_entry_id TEXT,
  closed_at TEXT NOT NULL,
  first_observation_id INTEGER,
  last_observation_id INTEGER,
  first_at TEXT,
  last_at TEXT,
  call_count INTEGER NOT NULL DEFAULT 0,
  failed_count INTEGER NOT NULL DEFAULT 0,
  rejected_count INTEGER NOT NULL DEFAULT 0,
  digest_json TEXT NOT NULL CHECK (json_valid(digest_json)),
  created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  UNIQUE (job_id, partition_key, group_seq)
);
CREATE INDEX IF NOT EXISTS idx_agent_tool_groups_work_item
  ON agent_tool_groups(work_item_id, closed_at);
`;

export function installAgentToolGroupsSchema(db) { db.exec(AGENT_TOOL_GROUPS_SCHEMA); }
