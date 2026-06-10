import { describe, it } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";
import {
  HOST_SCHEMA_VERSION,
  __testInstallJsonValidityTriggers,
  __testGetHostSchemaVersion,
  __testRepairAgentCallsExtendedThinkingSchema,
  __testRepairArtifactsTableSchema,
  __testRepairRunInsightsPromotionSchema,
  __testRepairAtlasV2HostSchema,
  __testRepairWorkItemsGovernanceTierSchema,
  __testRunHostMigration,
  getDb,
} from "../lib/shared/storage/functions/index.js";
import { HOST_MIGRATIONS } from "../lib/domains/atlas/functions/v2/contracts/index.js";
import {
  createJob,
  createWorkItem,
  setJobResult,
  getJob,
} from "../lib/domains/queue/functions/index.js";

const POSSE_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RUN_INSIGHTS_PROMOTION_COLUMNS = [
  "memory_type",
  "promotion_status",
  "promotion_reason",
  "promoted_memory_id",
  "rejection_reason",
];

function createLegacyRunInsightsTable(db) {
  db.exec(`
    CREATE TABLE run_insights (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      work_item_id INTEGER,
      job_id INTEGER,
      insight_type TEXT NOT NULL CHECK (
        insight_type IN ('decision','pattern','failure','human_override','scope_issue','performance','information_request')
      ),
      summary TEXT NOT NULL,
      detail TEXT,
      insight_kind TEXT,
      action TEXT,
      confidence TEXT,
      source TEXT,
      evidence TEXT,
      expires_at TEXT,
      file_paths TEXT,
      created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
    );
    INSERT INTO run_insights (
      work_item_id, job_id, insight_type, summary, detail, file_paths
    ) VALUES (
      7, 11, 'pattern', 'legacy insight', 'keep me', '["lib/a.js"]'
    );
  `);
}

function tableColumns(db, tableName) {
  return db.pragma(`table_info(${tableName})`).map((col) => col.name);
}

function indexNames(db) {
  return new Set(db.prepare(
    `SELECT name FROM sqlite_master WHERE type='index'`
  ).all().map((row) => row.name));
}

describe("Schema migrations", () => {
  it("runs host migrations once unless the schema still needs repair", () => {
    const db = new Database(":memory:");
    try {
      let runs = 0;
      const first = __testRunHostMigration(db, {
        version: 2,
        name: "test_migration",
        migrate: () => {
          runs += 1;
          return true;
        },
      });
      assert.equal(first.ran, true);
      assert.equal(first.changed, true);
      assert.equal(__testGetHostSchemaVersion(db), 2);

      const second = __testRunHostMigration(db, {
        version: 2,
        name: "test_migration",
        migrate: () => {
          runs += 1;
          return true;
        },
      });
      assert.equal(second.ran, false);
      assert.equal(runs, 1);

      const forced = __testRunHostMigration(db, {
        version: 2,
        name: "test_migration",
        needs: () => true,
        migrate: () => {
          runs += 1;
          return false;
        },
      });
      assert.equal(forced.ran, true);
      assert.equal(forced.changed, false);
      assert.equal(__testGetHostSchemaVersion(db), 2);
      assert.equal(runs, 2);
    } finally {
      db.close();
    }
  });

  it("advances fresh runtime DBs to the current host schema version", () => withTempRuntimeDb(() => {
    const db = getDb();
    assert.equal(__testGetHostSchemaVersion(db), HOST_SCHEMA_VERSION);
  }));

  it("does not downgrade host schema version during direct ATLAS host schema repair", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        PRAGMA user_version = ${HOST_SCHEMA_VERSION};
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('system')),
          event_json TEXT
        );
      `);

      assert.equal(__testRepairAtlasV2HostSchema(db), true);
      assert.equal(__testGetHostSchemaVersion(db), HOST_SCHEMA_VERSION);
    } finally {
      db.close();
    }
  });

  it("repairs upgraded artifacts schemas without dropping content_json or byte_size data", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE artifacts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          job_id INTEGER,
          attempt_id INTEGER,
          artifact_type TEXT NOT NULL CHECK (artifact_type IN ('prompt','response','task_spec','review','summary','diff','log','human_answer','report','other')),
          storage_kind TEXT NOT NULL DEFAULT 'inline' CHECK (storage_kind IN ('inline','file_path','url')),
          content_long TEXT,
          content_json TEXT,
          sha256 TEXT,
          bytes INTEGER,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO artifacts (artifact_type, storage_kind, content_long, content_json, sha256, bytes)
          VALUES ('summary', 'inline', 'text', '{"ok":true}', 'abc', 123);
      `);

      assert.equal(__testRepairArtifactsTableSchema(db), true);
      const cols = db.pragma(`table_info(artifacts)`).map((c) => c.name);
      assert.ok(cols.includes("content_json"));
      assert.ok(cols.includes("byte_size"));
      assert.equal(cols.includes("bytes"), false);

      const row = db.prepare(`SELECT content_json, byte_size FROM artifacts`).get();
      assert.equal(row.content_json, '{"ok":true}');
      assert.equal(row.byte_size, 123);
      const sql = db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='artifacts'`).get().sql;
      assert.match(sql, /'nudge'/);
      assert.match(sql, /'plan_synthesis'/);
    } finally {
      db.close();
    }
  });

  it("keeps fresh schema supplemental indexes in sync with migrations", () => {
    const db = new Database(":memory:");
    try {
      db.exec(fs.readFileSync(path.join(POSSE_ROOT, "schema.sql"), "utf8"));
      const indexes = new Set(db.prepare(
        `SELECT name FROM sqlite_master WHERE type='index'`
      ).all().map((row) => row.name));
      const triggers = new Set(db.prepare(
        `SELECT name FROM sqlite_master WHERE type='trigger'`
      ).all().map((row) => row.name));
      const tableSql = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'`
      ).get().sql;
      const agentCallsSql = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_calls'`
      ).get().sql;

      assert.ok(indexes.has("idx_jobs_lease_owner"));
      assert.ok(indexes.has("idx_events_created_at"));
      assert.ok(indexes.has("idx_agent_calls_atlas_prefetch"));
      assert.ok(indexes.has("idx_job_sessions_status_lease"));
      assert.ok(indexes.has("idx_job_deps_job_kind"));
      assert.ok(indexes.has("idx_run_insights_promotion_status"));
      assert.ok(indexes.has("idx_run_insights_promoted_memory_id"));
      assert.ok(indexes.has("idx_work_items_bridge_change_seq"));
      assert.ok(indexes.has("idx_jobs_bridge_change_seq"));
      assert.ok(triggers.has("posse_bridge_change_work_items_update"));
      assert.ok(triggers.has("posse_bridge_change_jobs_update"));
      assert.match(tableSql, /merge_state TEXT CHECK/);
      assert.match(tableSql, /plan_approval_state TEXT NOT NULL DEFAULT 'not_required' CHECK/);
      assert.match(agentCallsSql, /extended_thinking INTEGER NOT NULL DEFAULT 0 CHECK/);
      assert.throws(() => db.prepare(
        `INSERT INTO work_items (title, description, merge_state) VALUES ('bad merge', 'invalid', 'stuck')`
      ).run(), /CHECK constraint failed/);
      assert.throws(() => db.prepare(
        `INSERT INTO work_items (title, description, plan_approval_state) VALUES ('bad approval', 'invalid', 'stale')`
      ).run(), /CHECK constraint failed/);
      assert.throws(() => db.prepare(
        `INSERT INTO agent_calls (role, model_tier, extended_thinking) VALUES ('dev', 'standard', 2)`
      ).run(), /CHECK constraint failed/);

      const plan = db.prepare(`
        EXPLAIN QUERY PLAN
        SELECT 1
        FROM job_dependencies jd
        WHERE jd.job_id = ? AND jd.dependency_kind = 'hard'
      `).all(1).map((row) => row.detail).join("\n");
      assert.match(plan, /idx_job_deps_job_kind/i);
    } finally {
      db.close();
    }
  });

  it("rejects malformed JSON text in fresh-schema JSON columns", () => {
    const db = new Database(":memory:");
    try {
      db.exec(fs.readFileSync(path.join(POSSE_ROOT, "schema.sql"), "utf8"));
      const wi = db.prepare(`
        INSERT INTO work_items (title, description, metadata_json)
        VALUES ('json guard', 'valid row', ?)
      `).run(JSON.stringify({ ok: true })).lastInsertRowid;
      db.prepare(`
        INSERT INTO jobs (work_item_id, job_type, title, payload_json)
        VALUES (?, 'dev', 'valid job', ?)
      `).run(wi, JSON.stringify({ task_spec: "ok" }));

      assert.throws(() => db.prepare(`
        INSERT INTO jobs (work_item_id, job_type, title, payload_json)
        VALUES (?, 'dev', 'invalid job', ?)
      `).run(wi, "{not json"), /CHECK constraint failed/);
      assert.throws(() => db.prepare(`
        INSERT INTO events (event_type, actor_type, event_json)
        VALUES ('test.invalid_json', 'system', ?)
      `).run("plain text"), /CHECK constraint failed/);
      assert.throws(() => db.prepare(`
        INSERT INTO job_observations (observation_type, summary, detail_json)
        VALUES ('test.invalid_json', 'bad', ?)
      `).run("{bad"), /CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("stores bare string job results as valid JSON strings", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("string result", "exercise result_json guard");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "artificer",
      title: "Artifact reuse",
      payload_json: JSON.stringify({ task_spec: "reuse existing outputs" }),
    });
    const summary = "Planner reused 2 existing artifact output(s) in artifacts/wi-1/task";

    setJobResult(job.id, summary);

    const fresh = getJob(job.id);
    assert.equal(JSON.parse(fresh.result_json), summary);
    assert.equal(getDb().prepare("SELECT json_valid(result_json) AS ok FROM jobs WHERE id = ?").get(job.id).ok, 1);
  }));

  it("installs JSON validity triggers for migrated databases without rebuilding tables", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          job_type TEXT,
          title TEXT,
          payload_json TEXT,
          result_json TEXT
        );
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          event_type TEXT,
          actor_type TEXT,
          event_json TEXT
        );
      `);
      db.prepare(`
        INSERT INTO jobs (work_item_id, job_type, title, payload_json)
        VALUES (1, 'dev', 'legacy bad row', ?)
      `).run("{legacy bad json");

      __testInstallJsonValidityTriggers(db);

      assert.throws(() => db.prepare(`
        INSERT INTO jobs (work_item_id, job_type, title, payload_json)
        VALUES (1, 'dev', 'new bad row', ?)
      `).run("{new bad json"), /invalid JSON in jobs\.payload_json/);
      assert.throws(() => db.prepare(`
        UPDATE jobs SET payload_json = ? WHERE id = 1
      `).run("{still bad"), /invalid JSON in jobs\.payload_json/);
      db.prepare(`UPDATE jobs SET payload_json = ? WHERE id = 1`).run(JSON.stringify({ repaired: true }));
      assert.equal(JSON.parse(db.prepare(`SELECT payload_json FROM jobs WHERE id = 1`).get().payload_json).repaired, true);
    } finally {
      db.close();
    }
  });

  it("sanitizes legacy invalid event_json during ATLAS host schema repair", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          job_id INTEGER,
          attempt_id INTEGER,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (actor_type IN ('system')),
          actor_id TEXT,
          message TEXT,
          event_json TEXT,
          created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
        );
      `);
      const legacyText = "{legacy malformed event json";
      db.prepare(`
        INSERT INTO events (event_type, actor_type, event_json)
        VALUES ('job.manual_repair', 'system', ?)
      `).run(legacyText);

      assert.equal(__testRepairAtlasV2HostSchema(db), true);
      const row = db.prepare(`
        SELECT event_json, json_valid(event_json) AS valid
        FROM events
        WHERE event_type = 'job.manual_repair'
      `).get();
      assert.equal(row.valid, 1);
      assert.equal(JSON.parse(row.event_json), legacyText);

      const tableSql = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='events'`
      ).get().sql;
      assert.match(tableSql, /json_valid\(event_json\)/);
      assert.match(tableSql, /'atlas'/);
    } finally {
      db.close();
    }
  });

  it("records JSON repair counts and restarts cleanly in ATLAS host migration SQL", () => {
    const db = new Database(":memory:");
    try {
      db.exec(fs.readFileSync(path.join(POSSE_ROOT, "schema.sql"), "utf8"));
      const wi = db.prepare(`
        INSERT INTO work_items (title, description)
        VALUES ('migration audit', 'valid row')
      `).run().lastInsertRowid;
      const job = db.prepare(`
        INSERT INTO jobs (work_item_id, job_type, title, payload_json, result_json)
        VALUES (?, 'dev', 'legacy job', '{}', '{}')
      `).run(wi).lastInsertRowid;
      let legacyWarmJob = null;

      db.pragma("ignore_check_constraints = ON");
      try {
        db.prepare(`UPDATE jobs SET payload_json = ?, result_json = ? WHERE id = ?`)
          .run("{bad payload", "{bad result", job);
        legacyWarmJob = db.prepare(`
          INSERT INTO jobs (work_item_id, job_type, title, payload_json)
          VALUES (?, 'sdl_warm', 'legacy warm job', '{}')
        `).run(wi).lastInsertRowid;
      } finally {
        db.pragma("ignore_check_constraints = OFF");
      }

      db.exec(HOST_MIGRATIONS[0].sql);
      const repairedJob = db.prepare(`
        SELECT payload_json, result_json, json_valid(payload_json) AS payload_ok, json_valid(result_json) AS result_ok
        FROM jobs
        WHERE id = ?
      `).get(job);
      assert.equal(repairedJob.payload_ok, 1);
      assert.equal(repairedJob.result_ok, 1);
      assert.equal(JSON.parse(repairedJob.payload_json), "{bad payload");
      assert.equal(JSON.parse(repairedJob.result_json), "{bad result");
      assert.equal(db.prepare(`SELECT job_type FROM jobs WHERE id = ?`).get(legacyWarmJob).job_type, "atlas_warm");
      const warmAudit = db.prepare(`
        SELECT event_json
        FROM events
        WHERE event_type = 'system.schema_json_repaired'
          AND json_extract(event_json, '$.migration') = '001-add-atlas-warm-job-type'
      `).get();
      assert.equal(JSON.parse(warmAudit.event_json).payload_json, 1);
      assert.equal(JSON.parse(warmAudit.event_json).result_json, 1);
      db.exec(HOST_MIGRATIONS[0].sql);
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM events
        WHERE event_type = 'system.schema_json_repaired'
          AND json_extract(event_json, '$.migration') = '001-add-atlas-warm-job-type'
      `).get().count, 1);

      const eventId = db.prepare(`
        INSERT INTO events (event_type, actor_type, event_json)
        VALUES ('test.legacy_event_json', 'system', '{}')
      `).run().lastInsertRowid;
      let legacySdlEvent = null;
      db.pragma("ignore_check_constraints = ON");
      try {
        db.prepare(`UPDATE events SET event_json = ? WHERE id = ?`)
          .run("{bad event", eventId);
        legacySdlEvent = db.prepare(`
          INSERT INTO events (event_type, actor_type, event_json)
          VALUES ('sdl.legacy_event', 'sdl', '{}')
        `).run().lastInsertRowid;
      } finally {
        db.pragma("ignore_check_constraints = OFF");
      }

      db.exec(HOST_MIGRATIONS[1].sql);
      const repairedEvent = db.prepare(`
        SELECT event_json, json_valid(event_json) AS valid
        FROM events
        WHERE id = ?
      `).get(eventId);
      assert.equal(repairedEvent.valid, 1);
      assert.equal(JSON.parse(repairedEvent.event_json), "{bad event");
      assert.equal(db.prepare(`SELECT actor_type FROM events WHERE id = ?`).get(legacySdlEvent).actor_type, "atlas");
      const actorAudit = db.prepare(`
        SELECT event_json
        FROM events
        WHERE event_type = 'system.schema_json_repaired'
          AND json_extract(event_json, '$.migration') = '002-add-atlas-actor-type'
      `).get();
      assert.equal(JSON.parse(actorAudit.event_json).event_json, 1);
      db.exec(HOST_MIGRATIONS[1].sql);
      assert.equal(db.prepare(`
        SELECT COUNT(*) AS count
        FROM events
        WHERE event_type = 'system.schema_json_repaired'
          AND json_extract(event_json, '$.migration') = '002-add-atlas-actor-type'
      `).get().count, 1);
    } finally {
      db.close();
    }
  });

  it("adds run_insights promotion columns through the registered host migration", () => {
    const db = new Database(":memory:");
    try {
      createLegacyRunInsightsTable(db);
      const migration = HOST_MIGRATIONS.find((m) => m.id === "003-add-run-insights-promotion-columns");
      assert.ok(migration);

      db.exec(migration.sql);

      const cols = tableColumns(db, "run_insights");
      for (const col of RUN_INSIGHTS_PROMOTION_COLUMNS) {
        assert.ok(cols.includes(col), `expected ${col}`);
      }
      const row = db.prepare(`SELECT summary, detail, file_paths FROM run_insights`).get();
      assert.equal(row.summary, "legacy insight");
      assert.equal(row.detail, "keep me");
      assert.equal(row.file_paths, '["lib/a.js"]');

      const indexes = indexNames(db);
      assert.ok(indexes.has("idx_run_insights_promotion_status"));
      assert.ok(indexes.has("idx_run_insights_promoted_memory_id"));
    } finally {
      db.close();
    }
  });

  it("repairs legacy run_insights promotion columns idempotently at startup", () => {
    const db = new Database(":memory:");
    try {
      createLegacyRunInsightsTable(db);

      assert.equal(__testRepairRunInsightsPromotionSchema(db), true);
      const cols = tableColumns(db, "run_insights");
      for (const col of RUN_INSIGHTS_PROMOTION_COLUMNS) {
        assert.ok(cols.includes(col), `expected ${col}`);
      }
      assert.equal(__testRepairRunInsightsPromotionSchema(db), false);

      const indexes = indexNames(db);
      assert.ok(indexes.has("idx_run_insights_promotion_status"));
      assert.ok(indexes.has("idx_run_insights_promoted_memory_id"));
    } finally {
      db.close();
    }
  });

  it("repairs legacy work_items governance_tier schema with fresh-db constraints", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE work_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          external_id TEXT UNIQUE,
          title TEXT NOT NULL,
          description TEXT NOT NULL,
          priority TEXT NOT NULL DEFAULT 'normal',
          status TEXT NOT NULL DEFAULT 'queued',
          mode TEXT NOT NULL DEFAULT 'build',
          governance_tier TEXT NOT NULL DEFAULT 'enterprise',
          merge_state TEXT DEFAULT 'stuck',
          plan_approval_state TEXT NOT NULL DEFAULT 'stale',
          metadata_json TEXT,
          created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z',
          updated_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO work_items (title, description, governance_tier, merge_state, plan_approval_state)
          VALUES ('legacy', 'old db row', 'enterprise', 'stuck', 'stale');
      `);

      assert.equal(__testRepairWorkItemsGovernanceTierSchema(db), true);
      const tableSql = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='work_items'`
      ).get().sql;
      assert.match(tableSql, /governance_tier TEXT NOT NULL DEFAULT 'mvp' CHECK/);
      assert.match(tableSql, /merge_state TEXT CHECK/);
      assert.match(tableSql, /plan_approval_state TEXT NOT NULL DEFAULT 'not_required' CHECK/);

      const row = db.prepare(`SELECT governance_tier, merge_state, plan_approval_state FROM work_items WHERE title = 'legacy'`).get();
      assert.equal(row.governance_tier, "mvp");
      assert.equal(row.merge_state, null);
      assert.equal(row.plan_approval_state, "not_required");
      assert.throws(() => db.prepare(
        `INSERT INTO work_items (title, description, governance_tier) VALUES ('bad', 'invalid tier', 'enterprise')`
      ).run(), /CHECK constraint failed/);
      assert.throws(() => db.prepare(
        `INSERT INTO work_items (title, description, merge_state) VALUES ('bad merge', 'invalid state', 'stuck')`
      ).run(), /CHECK constraint failed/);
      assert.throws(() => db.prepare(
        `INSERT INTO work_items (title, description, plan_approval_state) VALUES ('bad approval', 'invalid state', 'stale')`
      ).run(), /CHECK constraint failed/);
    } finally {
      db.close();
    }
  });

  it("repairs legacy agent_calls extended_thinking values and installs a boolean CHECK", () => {
    const db = new Database(":memory:");
    try {
      db.exec(`
        CREATE TABLE work_items (id INTEGER PRIMARY KEY);
        CREATE TABLE jobs (id INTEGER PRIMARY KEY);
        CREATE TABLE job_attempts (id INTEGER PRIMARY KEY);
        CREATE TABLE agent_calls (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          job_id INTEGER,
          attempt_id INTEGER,
          role TEXT NOT NULL,
          model_tier TEXT NOT NULL,
          provider TEXT DEFAULT 'claude',
          extended_thinking INTEGER DEFAULT 0,
          created_at TEXT NOT NULL DEFAULT '2026-01-01T00:00:00.000Z'
        );
        INSERT INTO agent_calls (role, model_tier, extended_thinking)
          VALUES ('dev', 'standard', 0);
        INSERT INTO agent_calls (role, model_tier, extended_thinking)
          VALUES ('planner', 'cheap', 2);
        INSERT INTO agent_calls (role, model_tier, extended_thinking)
          VALUES ('assessor', 'strong', NULL);
      `);

      assert.equal(__testRepairAgentCallsExtendedThinkingSchema(db), true);
      const tableSql = db.prepare(
        `SELECT sql FROM sqlite_master WHERE type='table' AND name='agent_calls'`
      ).get().sql;
      assert.match(tableSql, /extended_thinking INTEGER NOT NULL DEFAULT 0 CHECK/);
      assert.ok(indexNames(db).has("idx_agent_calls_atlas_prefetch"));
      assert.deepEqual(
        db.prepare(`SELECT role, extended_thinking FROM agent_calls ORDER BY id`).all(),
        [
          { role: "dev", extended_thinking: 0 },
          { role: "planner", extended_thinking: 1 },
          { role: "assessor", extended_thinking: 0 },
        ],
      );
      assert.throws(() => db.prepare(
        `INSERT INTO agent_calls (role, model_tier, extended_thinking) VALUES ('dev', 'standard', 7)`
      ).run(), /CHECK constraint failed/);
    } finally {
      db.close();
    }
  });
});
