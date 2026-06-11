import { afterEach, beforeEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { closeDb, getDb } from "../lib/shared/storage/functions/index.js";
import { purgeRuntimeLogs } from "../lib/domains/ui/functions/admin/purge-runtime-logs.js";
import { cmdWindowsEvents } from "../lib/domains/cli/functions/diagnostic-commands.js";
import { closeLog, jobLog, log } from "../lib/shared/telemetry/functions/logging/logger.js";
import { closeOutputLog, recordOutput } from "../lib/shared/telemetry/functions/logging/output-log.js";
import { closePromptLog, recordPrompt } from "../lib/shared/telemetry/functions/logging/prompt-log.js";
import { closeObservationLog, getRecentToolInvocations, recordObservation } from "../lib/domains/observability/functions/observations.js";
import { flushEventsNow, getEvents, logEvent, _discardPendingEventsForTests } from "../lib/domains/queue/functions/events.js";
import { getArtifact, storeArtifact } from "../lib/domains/queue/functions/artifacts.js";
import * as queueFunctions from "../lib/domains/queue/functions/index.js";
import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";
import { pruneTelemetryTableToTail } from "../lib/shared/telemetry/functions/db-tail.js";
import { recordMemorySample } from "../lib/shared/telemetry/functions/memory.js";
import { recordBootCrashResumeMarker, recordRunHeartbeat } from "../lib/shared/telemetry/functions/run-diagnostics.js";
import { closeRunTelemetry, getRunTelemetryDir, readRunTelemetryEntries, __resetRunTelemetryForTests } from "../lib/shared/telemetry/functions/run-telemetry.js";

let runtimeRoot;

function resetRuntime() {
  closeLog();
  closePromptLog();
  closeOutputLog();
  closeObservationLog();
  closeRunTelemetry({ cleanExit: false });
  __resetRunTelemetryForTests();
  _discardPendingEventsForTests();
  closeDb();
  runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), "posse-run-telemetry-"));
  setRuntimePathOverridesForTests({
    runtimeRoot,
    dbPath: path.join(runtimeRoot, "db", "orchestrator.db"),
    logDir: path.join(runtimeRoot, "logs"),
  });
}

beforeEach(() => {
  resetRuntime();
});

afterEach(() => {
  closeLog();
  closePromptLog();
  closeOutputLog();
  closeObservationLog();
  closeRunTelemetry({ cleanExit: false });
  __resetRunTelemetryForTests();
  _discardPendingEventsForTests();
  closeDb();
  setRuntimePathOverridesForTests(null);
  try { fs.rmSync(runtimeRoot, { recursive: true, force: true }); } catch { /* ignore */ }
});

describe("run telemetry file storage", () => {
  it("keeps only the DB event tail while getEvents can read file-backed history", () => {
    for (let i = 0; i < 75; i += 1) {
      logEvent({
        event_type: "system.test_event",
        actor_type: "system",
        message: `event ${i}`,
      });
    }
    flushEventsNow();

    const dbCount = getDb().prepare(`SELECT COUNT(*) AS count FROM events`).get().count;
    assert.equal(dbCount, 20);

    const events = getEvents(null, 75);
    assert.equal(events.length, 75);
    assert.equal(events[0].message, "event 74");
    assert.equal(events[74].message, "event 0");
  });

  it("keeps only the DB observation tail while recent tool invocations can read file-backed history", () => {
    for (let i = 0; i < 75; i += 1) {
      assert.equal(recordObservation({
        observation_type: "tool.search",
        summary: `search ${i}`,
        detail: { index: i },
      }), true);
    }

    const dbCount = getDb().prepare(`SELECT COUNT(*) AS count FROM job_observations`).get().count;
    assert.equal(dbCount, 20);

    const recent = getRecentToolInvocations({ limit: 75 });
    assert.equal(recent.length, 75);
    assert.equal(recent[0].summary, "search 74");
    assert.equal(recent[74].summary, "search 0");
  });

  it("prunes pre-run DB telemetry without archiving historical backlog into the current run", () => {
    const db = getDb();
    const oldAt = "2000-01-01T00:00:00.000Z";
    const insertOldEvent = db.prepare(`
      INSERT INTO events (work_item_id, job_id, attempt_id, event_type, actor_type, actor_id, message, event_json, created_at)
      VALUES (NULL, NULL, NULL, 'system.old_event', 'system', NULL, ?, NULL, ?)
    `);
    const insertOldObservation = db.prepare(`
      INSERT INTO job_observations (work_item_id, job_id, attempt_id, observation_type, summary, detail_json, created_at)
      VALUES (NULL, NULL, NULL, 'tool.old', ?, NULL, ?)
    `);
    for (let i = 0; i < 40; i += 1) {
      insertOldEvent.run(`old event ${i}`, oldAt);
      insertOldObservation.run(`old observation ${i}`, oldAt);
    }

    logEvent({
      event_type: "system.new_event",
      actor_type: "system",
      message: "new event",
    });
    flushEventsNow();
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM events`).get().count, 20);

    const events = readRunTelemetryEntries("events", { limit: 100 });
    assert.equal(events.some((entry) => String(entry.message || "").startsWith("old event")), false);
    assert.equal(events.some((entry) => entry.message === "new event"), true);

    assert.equal(recordObservation({
      observation_type: "tool.search",
      summary: "new observation",
      detail: { ok: true },
    }), true);
    assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM job_observations`).get().count, 20);

    const observations = readRunTelemetryEntries("observations", { limit: 100 });
    assert.equal(observations.some((entry) => String(entry.summary || "").startsWith("old observation")), false);
    assert.equal(observations.some((entry) => entry.summary === "new observation"), true);
  });

  it("keeps job-scoped observations alive past the tail until the job is terminal", () => {
    const { createWorkItem, createJob } = queueFunctions;
    const wi = createWorkItem("Telemetry tail test", "desc");
    const job = createJob({ work_item_id: wi.id, job_type: "dev", title: "tail-protected job" });

    const db = getDb();
    const oldAt = "2000-01-01T00:00:00.000Z";
    const insertJobObservation = db.prepare(`
      INSERT INTO job_observations (work_item_id, job_id, attempt_id, observation_type, summary, detail_json, created_at)
      VALUES (?, ?, NULL, 'tool.atlas.prefetch', ?, NULL, ?)
    `);
    for (let i = 0; i < 5; i += 1) {
      insertJobObservation.run(wi.id, job.id, `prefetch evidence ${i}`, oldAt);
    }
    // Push far past the tail limit with job-less rows; the job-scoped rows
    // must survive because the job is not terminal (the auto-feedback
    // finalizer reads them after the job completes).
    for (let i = 0; i < 40; i += 1) {
      recordObservation({ observation_type: "tool.search", summary: `filler ${i}`, detail: { i } });
    }
    const survivors = db.prepare(
      `SELECT COUNT(*) AS count FROM job_observations WHERE job_id = ?`,
    ).get(job.id).count;
    assert.equal(survivors, 5);

    // Once the job is terminal (and the rows are older than the grace
    // window), the same rows become prunable.
    db.prepare(`UPDATE jobs SET status = 'succeeded' WHERE id = ?`).run(job.id);
    pruneTelemetryTableToTail(db, "job_observations", 20);
    const afterTerminal = db.prepare(
      `SELECT COUNT(*) AS count FROM job_observations WHERE job_id = ?`,
    ).get(job.id).count;
    assert.equal(afterTerminal, 0);
  });

  it("does not treat previous run files with the same epoch as current-run telemetry", () => {
    const runsRoot = path.dirname(getRunTelemetryDir());
    const oldRunDir = path.join(runsRoot, "2000-01-01T00-00-00-000Z-pid1-oldrun");
    fs.mkdirSync(oldRunDir, { recursive: true });
    fs.writeFileSync(path.join(oldRunDir, "events.jsonl"), `${JSON.stringify({
      t: "2000-01-01T00:00:00.000Z",
      run_id: "old-run",
      telemetry_epoch: 0,
      event_type: "system.old_event",
      actor_type: "system",
      message: "old run leaked",
    })}\n`, "utf8");

    logEvent({
      event_type: "system.new_event",
      actor_type: "system",
      message: "current run only",
    });
    flushEventsNow();

    const currentEvents = readRunTelemetryEntries("events", { limit: 10 });
    assert.equal(currentEvents.some((entry) => entry.message === "old run leaked"), false);
    assert.equal(currentEvents.some((entry) => entry.message === "current run only"), true);

    const allEvents = readRunTelemetryEntries("events", { limit: 10, currentEpochOnly: false });
    assert.equal(allEvents.some((entry) => entry.message === "old run leaked"), true);
  });

  it("stores artifact payloads in durable resources and hydrates after log purge", () => {
    const stored = storeArtifact({
      artifact_type: "response",
      content_long: "large response body",
      content_json: { ok: true },
    });

    assert.equal(stored.storage_kind, "file_path");
    assert.equal(stored.content_long, "large response body");
    assert.equal(stored.content_json, "{\"ok\":true}");

    const dbRow = getDb().prepare(`SELECT storage_kind, file_path, content_long, content_json FROM artifacts WHERE id = ?`).get(stored.id);
    assert.equal(dbRow.storage_kind, "file_path");
    assert.equal(dbRow.content_long, null);
    assert.equal(dbRow.content_json, null);
    assert.equal(fs.existsSync(dbRow.file_path), true);
    assert.equal(dbRow.file_path.includes(`${path.sep}resources${path.sep}artifacts${path.sep}_payloads${path.sep}`), true);

    purgeRuntimeLogs({ projectDir: runtimeRoot });
    assert.equal(fs.existsSync(path.join(runtimeRoot, "logs")), true);
    assert.equal(fs.existsSync(dbRow.file_path), true);

    const hydrated = getArtifact(stored.id);
    assert.equal(hydrated.content_long, "large response body");
    assert.equal(hydrated.content_json, "{\"ok\":true}");
  });

  it("surfaces missing artifact payloads instead of silently returning empty content", () => {
    const stored = storeArtifact({
      artifact_type: "response",
      content_long: "payload to delete",
    });
    const dbRow = getDb().prepare(`SELECT file_path FROM artifacts WHERE id = ?`).get(stored.id);
    fs.rmSync(dbRow.file_path, { force: true });

    const hydrated = getArtifact(stored.id);
    assert.equal(hydrated.content_long, null);
    assert.equal(hydrated.content_missing, true);
    assert.match(hydrated.content_error, /missing or unreadable/);
  });

  it("keeps DB telemetry when file archival is unavailable", () => {
    const db = getDb();
    const insert = db.prepare(`
      INSERT INTO events (work_item_id, job_id, attempt_id, event_type, actor_type, actor_id, message, event_json, created_at)
      VALUES (NULL, NULL, NULL, 'system.archive_failure', 'system', NULL, ?, NULL, ?)
    `);
    for (let i = 0; i < 30; i += 1) {
      insert.run(`archive unavailable ${i}`, new Date(Date.now() + i).toISOString());
    }

    const logDirAsFile = path.join(runtimeRoot, "log-dir-is-file");
    fs.writeFileSync(logDirAsFile, "not a directory", "utf8");
    setRuntimePathOverridesForTests({
      runtimeRoot,
      dbPath: path.join(runtimeRoot, "db", "orchestrator.db"),
      logDir: logDirAsFile,
    });
    try {
      const pruned = pruneTelemetryTableToTail(db, "events", 20);
      assert.equal(pruned, 0);
      assert.equal(db.prepare(`SELECT COUNT(*) AS count FROM events`).get().count, 30);
    } finally {
      setRuntimePathOverridesForTests({
        runtimeRoot,
        dbPath: path.join(runtimeRoot, "db", "orchestrator.db"),
        logDir: path.join(runtimeRoot, "logs"),
      });
    }
  });

  it("recreates run telemetry files after close and log purge", () => {
    logEvent({
      event_type: "system.before_purge",
      actor_type: "system",
      message: "before purge",
    });
    flushEventsNow();
    const runDir = getRunTelemetryDir();
    assert.equal(fs.existsSync(path.join(runDir, "events.jsonl")), true);

    closeRunTelemetry({ cleanExit: true });
    fs.rmSync(runDir, { recursive: true, force: true });

    logEvent({
      event_type: "system.after_purge",
      actor_type: "system",
      message: "after purge",
    });
    flushEventsNow();

    const events = readRunTelemetryEntries("events", { limit: 10 });
    assert.equal(events.some((entry) => entry.message === "after purge"), true);
  });

  it("mirrors runtime, job, prompt, and output logs into the run directory", () => {
    log.info("test", "runtime mirror", { jobId: 7, wiId: 3, provider: "stub" });
    jobLog("START", { wi: 3, job: 7, detail: "job mirror" });
    recordPrompt({
      agent_call_id: 11,
      job_id: 7,
      work_item_id: 3,
      role: "dev",
      provider: "stub",
      model: "stub-model",
      prompt: "secret prompt body",
    });
    recordOutput({
      agent_call_id: 11,
      job_id: 7,
      work_item_id: 3,
      role: "dev",
      provider: "stub",
      model: "stub-model",
      output: "tool output",
      status: "succeeded",
    });

    assert.equal(fs.existsSync(path.join(getRunTelemetryDir(), "runtime.jsonl")), true);
    assert.equal(fs.existsSync(path.join(getRunTelemetryDir(), "jobs.jsonl")), true);
    assert.equal(fs.existsSync(path.join(getRunTelemetryDir(), "prompts.jsonl")), true);
    assert.equal(fs.existsSync(path.join(getRunTelemetryDir(), "outputs.jsonl")), true);

    assert.equal(readRunTelemetryEntries("runtime", { limit: 10 }).some((entry) => entry.msg === "runtime mirror"), true);
    assert.equal(readRunTelemetryEntries("jobs", { limit: 10 }).some((entry) => entry.detail === "job mirror"), true);
    assert.equal(readRunTelemetryEntries("prompts", { limit: 10 }).some((entry) => entry.agent_call_id === 11 && entry.prompt_redacted === true), true);
    assert.equal(readRunTelemetryEntries("outputs", { limit: 10 }).some((entry) => entry.agent_call_id === 11 && entry.output === "tool output"), true);
  });

  it("writes boot, heartbeat, and memory diagnostics into the run directory", () => {
    recordBootCrashResumeMarker({ ownerId: "scheduler-test" });
    recordMemorySample("test.memory", { marker: "diagnostic-test" });
    recordRunHeartbeat({
      ownerId: "scheduler-test",
      reason: "test",
      activeWorkers: new Map([[42, {
        job: { id: 42, work_item_id: 9, job_type: "dev", status: "running" },
        startTime: Date.now() - 1000,
      }]]),
    });

    const diagnostics = readRunTelemetryEntries("diagnostics", { limit: 10 });
    const memory = readRunTelemetryEntries("memory", { limit: 10 });
    const heartbeats = readRunTelemetryEntries("heartbeats", { limit: 10 });
    assert.equal(diagnostics.some((entry) => entry.kind === "boot.start" && entry.ownerId === "scheduler-test"), true);
    assert.equal(memory.some((entry) => entry.phase === "test.memory" && entry.marker === "diagnostic-test"), true);
    assert.equal(heartbeats.some((entry) => entry.kind === "heartbeat" && entry.active_workers?.count === 1), true);

    const manifest = JSON.parse(fs.readFileSync(path.join(getRunTelemetryDir(), "manifest.json"), "utf8"));
    assert.equal(manifest.boot_owner_id, "scheduler-test");
    assert.equal(typeof manifest.last_heartbeat_at, "string");
  });

  it("writes Windows event probe results into the run directory", () => {
    const rawEventJson = JSON.stringify([{
      time_created: "2026-06-02T20:20:00.0000000Z",
      log_name: "System",
      ProviderName: "Microsoft-Windows-Resource-Exhaustion-Detector",
      Id: 2004,
      LevelDisplayName: "Warning",
      Message: "Windows successfully diagnosed a low virtual memory condition.",
    }]);
    const output = [];
    const result = cmdWindowsEvents({
      args: ["--around", "2026-06-02T20:20:00.000Z", "--minutes", "5"],
      platform: "win32",
      execFileSyncFn: () => rawEventJson,
      stdout: (line) => output.push(line),
    });

    assert.equal(result.ok, true);
    assert.equal(result.count, 1);
    const events = readRunTelemetryEntries("windows-events", { limit: 10 });
    assert.equal(events.length, 1);
    assert.equal(events[0].event_id, 2004);
    assert.equal(events[0].provider_name, "Microsoft-Windows-Resource-Exhaustion-Detector");
    assert.equal(output.some((line) => String(line).includes("Windows Event Probe")), true);
  });
});
