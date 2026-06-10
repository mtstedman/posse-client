import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import {
  __testRepairAtlasV2HostSchema,
  closeDb,
  getDb,
} from "../lib/shared/storage/functions/index.js";
import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";
import { createJob, createWorkItem } from "../lib/domains/queue/functions/index.js";
import {
  emitDevCommitted,
  emitDevLeased,
  emitMainAdvanced,
  emitMergedToMain,
  emitResearchComplete,
  emitScipRestageRequested,
  emitWiCleanup,
} from "../lib/domains/atlas/classes/v2/PipelineHooks.js";
import {
  __resetRetrievalCacheForTests,
  getRetrievalCache,
} from "../lib/domains/atlas/classes/v2/RetrievalCache.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withRuntimeDb(dbPath, fn) {
  closeDb();
  setRuntimePathOverridesForTests({ dbPath });
  try {
    return fn();
  } finally {
    closeDb();
    setRuntimePathOverridesForTests(null);
  }
}

describe("ATLAS v2 pipeline hooks", () => {
  it("invalidates process-local retrieval caches on view-mutating events", () => {
    const tmp = makeTmp("atlas-v2-hooks-cache-");
    try {
      const dbPath = path.join(tmp, "orchestrator.db");
      withRuntimeDb(dbPath, () => {
        const cache = getRetrievalCache();
        cache.setCard("main@1:card:test", { symbolId: "abc:1" });
        cache.setSlice("main@1:slice:test", { data: { sliceHandle: "sl_test" }, etag: "slice:test" });
        assert.deepEqual(cache.stats(), { cards: 1, slices: 1 });

        const result = emitMainAdvanced({
          payload: {
            from_sha: "1111111",
            to_sha: "2222222",
            target_branch: "main",
            paths: ["src/a.js"],
            source: "external_pull",
          },
        });
        assert.equal(result.ok, true);
        assert.deepEqual(cache.stats(), { cards: 0, slices: 0 });
      });
    } finally {
      __resetRetrievalCacheForTests();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("enqueues atlas_warm with null routing fields in the host DB", () => {
    const tmp = makeTmp("atlas-v2-hooks-");
    try {
      const dbPath = path.join(tmp, "orchestrator.db");
      withRuntimeDb(dbPath, () => {
        const result = emitMainAdvanced({
          payload: {
            from_sha: "1111111",
            to_sha: "2222222",
            target_branch: "master",
            paths: ["src/a.js"],
            source: "external_pull",
          },
        });
        assert.equal(result.ok, true);
        assert.ok(result.eventId);
        assert.ok(result.warmJobId);

        const db = getDb();
        const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(result.warmJobId);
        assert.equal(job.job_type, "atlas_warm");
        assert.equal(job.work_item_id, null);
        assert.equal(job.model_tier, null);
        assert.equal(job.reasoning_effort, null);
        assert.equal(job.provider, null);
        assert.equal(job.priority, "low");
        assert.equal(JSON.parse(job.payload_json).branch, "master");

        const event = db.prepare("SELECT * FROM events WHERE id = ?").get(result.eventId);
        assert.equal(event.event_type, "atlas.main_advanced");
        assert.equal(event.actor_type, "atlas");
        assert.equal(event.work_item_id, null);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("enqueues SCIP restage warm jobs from pipeline hooks", () => {
    const tmp = makeTmp("atlas-v2-hooks-scip-restage-");
    try {
      const dbPath = path.join(tmp, "orchestrator.db");
      withRuntimeDb(dbPath, () => {
        const result = emitScipRestageRequested({
          payload: {
            to_sha: "2222222",
            target_branch: "main",
            reason: "typescript:head_changed",
            source: "post_commit_hook",
          },
        });
        assert.equal(result.ok, true);
        assert.ok(result.eventId);
        assert.ok(result.warmJobId);

        const db = getDb();
        const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(result.warmJobId);
        assert.equal(job.job_type, "atlas_warm");
        assert.equal(job.work_item_id, null);
        assert.equal(job.priority, "low");
        const payload = JSON.parse(job.payload_json);
        assert.equal(payload.purpose, "scip-restage");
        assert.equal(payload.branch, "main");
        assert.equal(payload.trigger_event, "atlas.scip_restage_requested");

        const event = db.prepare("SELECT * FROM events WHERE id = ?").get(result.eventId);
        assert.equal(event.event_type, "atlas.scip_restage_requested");
        assert.equal(event.actor_type, "atlas");
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("uses ATLAS ledger branch names in WI-scoped warm payloads", () => {
    const tmp = makeTmp("atlas-v2-hooks-wi-branch-");
    try {
      const dbPath = path.join(tmp, "orchestrator.db");
      withRuntimeDb(dbPath, () => {
        const wi = createWorkItem("ATLAS v2 branch payload", "x");
        const dev = createJob({
          work_item_id: wi.id,
          job_type: "dev",
          title: "Dev",
        });
        const result = emitDevLeased({
          payload: {
            wi_id: wi.id,
            branch: `posse/wi-${wi.id}-slug`,
            worktree_path: path.join(tmp, "wi"),
            job_id: dev.id,
          },
        });
        assert.equal(result.ok, true);

        const db = getDb();
        const warm = db.prepare("SELECT * FROM jobs WHERE id = ?").get(result.warmJobId);
        const payload = JSON.parse(warm.payload_json);
        assert.equal(payload.purpose, "wi");
        assert.equal(payload.work_item_id, wi.id);
        assert.equal(payload.branch, `wi-${wi.id}`);
        assert.equal(warm.priority, "high");

        const event = db.prepare("SELECT * FROM events WHERE id = ?").get(result.eventId);
        const eventPayload = JSON.parse(event.event_json);
        assert.equal(eventPayload.branch, `posse/wi-${wi.id}-slug`);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("coalesces queued WI warm jobs by ledger branch", () => {
    const tmp = makeTmp("atlas-v2-hooks-coalesce-");
    try {
      const dbPath = path.join(tmp, "orchestrator.db");
      withRuntimeDb(dbPath, () => {
        const wi = createWorkItem("ATLAS v2 coalesced warm", "x");
        const dev = createJob({
          work_item_id: wi.id,
          job_type: "dev",
          title: "Dev",
        });

        const first = emitResearchComplete({
          payload: {
            wi_id: wi.id,
            branch: `posse/wi-${wi.id}-slug`,
            files: ["src/a.js"],
          },
        });
        const second = emitDevCommitted({
          payload: {
            wi_id: wi.id,
            branch: `posse/wi-${wi.id}-slug`,
            commit_sha: "abc123",
            paths: ["src/b.js"],
            job_id: dev.id,
          },
        });
        const third = emitDevLeased({
          payload: {
            wi_id: wi.id,
            branch: `posse/wi-${wi.id}-slug`,
            worktree_path: path.join(tmp, "wi"),
            job_id: dev.id,
          },
        });

        assert.equal(first.ok, true);
        assert.equal(second.ok, true);
        assert.equal(third.ok, true);
        assert.equal(second.warmJobId, first.warmJobId);
        assert.equal(third.warmJobId, first.warmJobId);
        assert.equal(second.coalesced, true);
        assert.equal(third.coalesced, true);

        const db = getDb();
        const warmJobs = db.prepare("SELECT * FROM jobs WHERE job_type = 'atlas_warm'").all();
        assert.equal(warmJobs.length, 1);
        assert.equal(warmJobs[0].priority, "high");
        const payload = JSON.parse(warmJobs[0].payload_json);
        assert.equal(payload.branch, `wi-${wi.id}`);
        assert.deepEqual(payload.paths, ["src/a.js", "src/b.js"]);
        assert.equal(payload._atlas_event_count, 3);
        assert.deepEqual(payload._atlas_event_types, [
          "atlas.research_complete",
          "atlas.dev_committed",
          "atlas.dev_leased",
        ]);

        const events = db.prepare("SELECT event_type FROM events WHERE actor_type = 'atlas' ORDER BY id").all().map((row) => row.event_type);
        assert.deepEqual(events, ["atlas.research_complete", "atlas.dev_committed", "atlas.dev_leased"]);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("enqueues merge-to-main replay with the WI ledger branch", () => {
    const tmp = makeTmp("atlas-v2-hooks-merge-");
    try {
      const dbPath = path.join(tmp, "orchestrator.db");
      withRuntimeDb(dbPath, () => {
        const wi = createWorkItem("ATLAS v2 merge payload", "x");
        const result = emitMergedToMain({
          payload: {
            wi_id: wi.id,
            source_branch: `posse/wi-${wi.id}-slug`,
            target_branch: "main",
            merge_commit_sha: "abc123",
          },
        });
        assert.equal(result.ok, true);

        const db = getDb();
        const warm = db.prepare("SELECT * FROM jobs WHERE id = ?").get(result.warmJobId);
        assert.equal(warm.work_item_id, wi.id);
        const payload = JSON.parse(warm.payload_json);
        assert.equal(payload.purpose, "main-merge");
        assert.equal(payload.work_item_id, wi.id);
        assert.equal(payload.branch, `wi-${wi.id}`);
        assert.equal(payload.onto_branch, "main");
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("retires queued branch-local WI warm jobs when merge or cleanup starts", () => {
    const tmp = makeTmp("atlas-v2-hooks-retire-wi-");
    try {
      const dbPath = path.join(tmp, "orchestrator.db");
      withRuntimeDb(dbPath, () => {
        const wi = createWorkItem("ATLAS v2 retire branch warm", "x");
        const dev = createJob({
          work_item_id: wi.id,
          job_type: "dev",
          title: "Dev",
        });

        const branchWarm = emitDevCommitted({
          payload: {
            wi_id: wi.id,
            branch: `posse/wi-${wi.id}-slug`,
            commit_sha: "abc123",
            paths: ["src/a.js"],
            job_id: dev.id,
          },
        });
        assert.equal(branchWarm.ok, true);

        const mergeWarm = emitMergedToMain({
          payload: {
            wi_id: wi.id,
            source_branch: `posse/wi-${wi.id}-slug`,
            target_branch: "main",
            merge_commit_sha: "def456",
          },
        });
        assert.equal(mergeWarm.ok, true);
        assert.equal(mergeWarm.canceledWarmJobs, 1);

        const db = getDb();
        const retired = db.prepare("SELECT status, result_json, last_error FROM jobs WHERE id = ?").get(branchWarm.warmJobId);
        assert.equal(retired.status, "canceled");
        assert.equal(retired.last_error, null);
        assert.equal(JSON.parse(retired.result_json).retired_by_atlas, true);

        const mergeJob = db.prepare("SELECT status, payload_json FROM jobs WHERE id = ?").get(mergeWarm.warmJobId);
        assert.equal(mergeJob.status, "queued");
        assert.equal(JSON.parse(mergeJob.payload_json).purpose, "main-merge");

        const cleanupWarm = emitWiCleanup({
          payload: {
            wi_id: wi.id,
            branch: `posse/wi-${wi.id}-slug`,
          },
        });
        assert.equal(cleanupWarm.ok, true);
        assert.equal(cleanupWarm.canceledWarmJobs, 0);
        const cleanupJob = db.prepare("SELECT status, payload_json FROM jobs WHERE id = ?").get(cleanupWarm.warmJobId);
        assert.equal(cleanupJob.status, "queued");
        assert.equal(JSON.parse(cleanupJob.payload_json).purpose, "wi-cleanup");
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("repairs legacy host constraints for atlas_warm and atlas actor rows", () => {
    const tmp = makeTmp("atlas-v2-host-migration-");
    const dbPath = path.join(tmp, "legacy.db");
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE work_items (id INTEGER PRIMARY KEY AUTOINCREMENT);
        CREATE TABLE job_attempts (id INTEGER PRIMARY KEY AUTOINCREMENT);
        CREATE TABLE jobs (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER NOT NULL,
          parent_job_id INTEGER,
          job_type TEXT NOT NULL CHECK (
            job_type IN ('research','plan','delegate','dev','assess','fix','summarize','human_input','artificer','promote','preflight','sdl_warm')
          ),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'queued',
          priority TEXT NOT NULL DEFAULT 'normal',
          model_tier TEXT NOT NULL DEFAULT 'standard' CHECK (model_tier IN ('cheap','standard','strong')),
          model_name TEXT,
          provider TEXT,
          reasoning_effort TEXT NOT NULL DEFAULT 'medium' CHECK (reasoning_effort IN ('low','medium','high')),
          max_attempts INTEGER NOT NULL DEFAULT 3,
          attempt_count INTEGER NOT NULL DEFAULT 0,
          human_escalation_count INTEGER NOT NULL DEFAULT 0,
          payload_json TEXT,
          result_json TEXT,
          context_text TEXT,
          skills TEXT,
          last_error TEXT,
          assessor_verdict TEXT NOT NULL DEFAULT 'not_assessed',
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
          updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO jobs (work_item_id, job_type, title)
        VALUES (1, 'sdl_warm', 'legacy SDL warm');
        CREATE TABLE events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          work_item_id INTEGER,
          job_id INTEGER,
          attempt_id INTEGER,
          event_type TEXT NOT NULL,
          actor_type TEXT NOT NULL CHECK (
            actor_type IN ('system','scheduler','planner','researcher','dev','assessor','human','worker','delegator','artificer','preflight','sdl')
          ),
          actor_id TEXT,
          message TEXT,
          event_json TEXT,
          created_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
        );
        INSERT INTO events (event_type, actor_type, message)
        VALUES ('sdl.legacy_event', 'sdl', 'legacy SDL event');
      `);

      assert.equal(__testRepairAtlasV2HostSchema(db), true);
      // The schema-version bump is owned by runHostMigration (registered at
      // version 5), not the raw repair helper this test invokes directly, so
      // user_version is intentionally not asserted here.
      const migratedWarm = db.prepare("SELECT job_type FROM jobs WHERE title = 'legacy SDL warm'").get();
      assert.equal(migratedWarm.job_type, "atlas_warm");
      const migratedEvent = db.prepare("SELECT actor_type FROM events WHERE event_type = 'sdl.legacy_event'").get();
      assert.equal(migratedEvent.actor_type, "atlas");
      assert.doesNotThrow(() => {
        db.prepare(`
          INSERT INTO jobs (
            work_item_id, job_type, title, priority, model_tier, reasoning_effort, provider, payload_json
          ) VALUES (NULL, 'atlas_warm', 'warm', 'low', NULL, NULL, NULL, '{}')
        `).run();
        db.prepare(`
          INSERT INTO events (event_type, actor_type, event_json)
          VALUES ('atlas.main_advanced', 'atlas', '{}')
        `).run();
      });
    } finally {
      db.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
