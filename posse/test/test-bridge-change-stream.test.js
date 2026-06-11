import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BRIDGE_EVENT_KINDS } from "../lib/catalog/bridge.js";
import { EVENT_TYPES } from "../lib/catalog/event.js";
import { ChangeStream } from "../lib/domains/bridge/classes/ChangeStream.js";
import { getDb } from "../lib/shared/storage/functions/index.js";
import { redactBridgeValue } from "../lib/domains/bridge/functions/redaction.js";
import { collectStateSnapshot, tailEvents } from "../lib/domains/bridge/functions/state-snapshot.js";
import {
  RUNTIME_STATUS_KEYS,
  markCleanShutdown,
  writeRuntimeStatus,
} from "../lib/domains/queue/functions/runtime-status.js";
import {
  createJob,
  createWorkItem,
  flushEventsNow,
  logEvent,
  setJobResult,
  updateJobPayload,
  updateJobStatus,
  updateWorkItemStatus,
} from "../lib/domains/queue/functions/index.js";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";

describe("bridge change stream", () => {
  it("redacts connection strings and non-JSON containers", () => {
    class SecretCarrier {
      constructor() {
        this.description = "connect with postgres://user:pass@db.example.test/app";
        this.client_secret = "custom-secret";
      }
    }

    const redacted = redactBridgeValue({
      description: "postgres://user:pass@db.example.test/app",
      map: new Map([
        ["authorization", "Bearer map-secret"],
        ["description", "mysql://reader:reader-pass@db.example.test/app"],
      ]),
      set: new Set(["Basic dXNlcjpwYXNz", "sk-test-secret"]),
      bytes: Buffer.from("secret bytes"),
      instance: new SecretCarrier(),
    });

    assert.equal(redacted.description, "postgres://[REDACTED]@db.example.test/app");
    assert.equal(redacted.map.authorization, "[REDACTED]");
    assert.equal(redacted.map.description, "mysql://[REDACTED]@db.example.test/app");
    assert.deepEqual(redacted.set, ["Basic [REDACTED]", "sk-[REDACTED]"]);
    assert.equal(redacted.bytes, "[REDACTED]");
    assert.equal(redacted.instance.description, "connect with postgres://[REDACTED]@db.example.test/app");
    assert.equal(redacted.instance.client_secret, "[REDACTED]");
  });

  it("emits event, work item, and job frames from a read-only DB handle", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Initial item", "before stream starts");
    const job = createJob({ work_item_id: wi.id, job_type: "dev", title: "Initial job" });
    flushEventsNow();

    const stream = new ChangeStream({ pollMs: 100, instanceId: "posse-test" });
    const frames = [];
    stream.on("frame", (frame) => frames.push(frame));
    stream.start();
    try {
      updateWorkItemStatus(wi.id, "running");
      updateJobStatus(job.id, "succeeded");
      flushEventsNow();
      stream.poll();

      assert.equal(frames.some((frame) => frame.kind === BRIDGE_EVENT_KINDS.WORK_ITEM_UPDATED), true);
      assert.equal(frames.some((frame) => frame.kind === BRIDGE_EVENT_KINDS.JOB_UPDATED), true);
      assert.equal(frames.every((frame) => frame.v === 1 && frame.type === "event"), true);
      assert.equal(frames.every((frame) => frame.instance_id === "posse-test"), true);
      assert.equal(frames.every((frame) => typeof frame.kind === "string" && frame.kind.length > 0), true);
      assert.deepEqual(frames.map((frame) => frame.event_id), frames.map((_, index) => index + 1));

      const replay = stream.tailFrames({ sinceEventId: 0, limit: 10 });
      assert.equal(replay.head_event_id, stream.headEventId());
      assert.equal(replay.events.length, frames.length);
      assert.equal(replay.events[0].type, undefined);
      assert.equal(replay.events[0].kind, frames[0].kind);
    } finally {
      stream.close();
    }
  }));

  it("tails global events by id cursor without dropping older backlog", () => withTempRuntimeDb(() => {
    for (let i = 0; i < 5; i += 1) {
      logEvent({
        event_type: `system.bridge_tail.event_${i}`,
        actor_type: "system",
        message: `event ${i}`,
      });
    }
    flushEventsNow();

    const all = tailEvents({ sinceId: 0, limit: 10 });
    assert.equal(all.length, 5);

    const page = tailEvents({ sinceId: all[0].id, limit: 2 });
    assert.deepEqual(page.map((event) => Number(event.id)), all.slice(1, 3).map((event) => Number(event.id)));
  }));

  it("emits same-row job changes when updated_at does not advance", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Cursor item", "same timestamp updates");
    const job = createJob({ work_item_id: wi.id, job_type: "dev", title: "Cursor job" });
    flushEventsNow();

    const stream = new ChangeStream({ pollMs: 100, instanceId: "posse-test" });
    const frames = [];
    stream.on("frame", (frame) => frames.push(frame));
    stream.start();
    try {
      const ts = "2026-05-26T00:00:00.000Z";
      getDb().prepare(`UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify({ step: 1 }), ts, job.id);
      stream.poll();
      getDb().prepare(`UPDATE jobs SET payload_json = ?, updated_at = ? WHERE id = ?`)
        .run(JSON.stringify({ step: 2 }), ts, job.id);
      stream.poll();

      const jobFrames = frames.filter((frame) => (
        frame.kind === BRIDGE_EVENT_KINDS.JOB_UPDATED &&
        Number(frame.payload.id) === Number(job.id)
      ));
      assert.equal(jobFrames.length, 2);
      assert.deepEqual(jobFrames.map((frame) => frame.payload.payload.step), [1, 2]);
    } finally {
      stream.close();
    }
  }));

  it("does not re-emit gate opened while a human input job remains open", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Gate item", "dedupe open gate events");
    flushEventsNow();

    const stream = new ChangeStream({ pollMs: 100, instanceId: "posse-test" });
    const frames = [];
    stream.on("frame", (frame) => frames.push(frame));
    stream.start();
    try {
      const gate = createJob({
        work_item_id: wi.id,
        job_type: "human_input",
        title: "Need input",
        payload_json: JSON.stringify({ prompt: "First question?" }),
      });
      flushEventsNow();
      stream.poll();

      updateJobPayload(gate.id, JSON.stringify({ prompt: "Still open?" }));
      stream.poll();

      const opened = frames.filter((frame) => (
        frame.kind === BRIDGE_EVENT_KINDS.GATE_OPENED &&
        Number(frame.payload.job_id) === Number(gate.id)
      ));
      assert.equal(opened.length, 1);
    } finally {
      stream.close();
    }
  }));

  it("redacts sensitive JSON in streamed job and event frames", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Stream redaction", "mask streamed payloads");
    const job = createJob({
      work_item_id: wi.id,
      job_type: "dev",
      title: "Secret stream job",
      payload_json: JSON.stringify({ step: 0 }),
    });
    flushEventsNow();

    const stream = new ChangeStream({ pollMs: 100, instanceId: "posse-test" });
    const frames = [];
    stream.on("frame", (frame) => frames.push(frame));
    stream.start();
    try {
      updateJobPayload(job.id, JSON.stringify({
        api_key: "sk-stream-secret",
        note: "Bearer stream-secret",
        token_budget_output: 456,
      }));
      setJobResult(job.id, { access_token: "result-stream-token" });
      logEvent({
        work_item_id: wi.id,
        job_id: job.id,
        event_type: EVENT_TYPES.PLAN_APPROVED,
        actor_type: "human",
        message: "stream redaction fixture",
        event_json: JSON.stringify({ authorization: "Bearer event-stream-secret" }),
      });
      flushEventsNow();
      stream.poll();

      const jobFrame = frames.find((frame) => (
        frame.kind === BRIDGE_EVENT_KINDS.JOB_UPDATED &&
        Number(frame.payload.id) === Number(job.id)
      ));
      assert.ok(jobFrame);
      assert.equal(jobFrame.payload.payload.api_key, "[REDACTED]");
      assert.equal(jobFrame.payload.payload.note, "Bearer [REDACTED]");
      assert.equal(jobFrame.payload.payload.token_budget_output, 456);
      assert.equal(jobFrame.payload.result.access_token, "[REDACTED]");

      const eventFrame = frames.find((frame) => frame.kind === BRIDGE_EVENT_KINDS.GATE_CLOSED);
      assert.ok(eventFrame);
      assert.equal(eventFrame.payload.event.authorization, "[REDACTED]");
    } finally {
      stream.close();
    }
  }));

  it("streams instance_status phases from runtime_status rows, emit-on-change", () => withTempRuntimeDb(() => {
    getDb(); // materialize the runtime DB before the readonly stream opens it
    const stream = new ChangeStream({ pollMs: 100, instanceId: "posse-test" });
    const frames = [];
    stream.on("frame", (frame) => frames.push(frame));
    stream.start();
    try {
      let nowMs = Date.now();
      const statusFrames = () => frames.filter((f) => f.kind === BRIDGE_EVENT_KINDS.INSTANCE_STATUS);

      // No runtime rows at all → offline (serve without run).
      stream.pollInstanceStatus(nowMs);
      assert.equal(statusFrames().at(-1)?.payload.phase, "offline");

      // Identical state inside the min interval → no re-emit.
      stream.pollInstanceStatus(nowMs + 1);
      assert.equal(statusFrames().length, 1);

      // Booting: boot row with an unfinished step + fresh heartbeat.
      writeRuntimeStatus(RUNTIME_STATUS_KEYS.BOOT, {
        steps: [
          { label: "lock acquired", status: "ok", section: "scheduler" },
          { label: "workspace health", status: "running", percent: 40, section: "workspace" },
        ],
        started_at: new Date(nowMs).toISOString(),
      });
      nowMs += 5_000;
      stream.pollInstanceStatus(nowMs);
      let latest = statusFrames().at(-1);
      assert.equal(latest.payload.phase, "booting");
      assert.equal(latest.payload.boot_steps.length, 2);

      // Warming: only ATLAS-ish steps still active.
      writeRuntimeStatus(RUNTIME_STATUS_KEYS.BOOT, {
        steps: [
          { label: "lock acquired", status: "ok", section: "scheduler" },
          { label: "ATLAS warmup", status: "running", percent: 43, section: "scheduler" },
        ],
        started_at: new Date(nowMs).toISOString(),
      });
      nowMs += 5_000;
      stream.pollInstanceStatus(nowMs);
      assert.equal(statusFrames().at(-1).payload.phase, "warming");

      // Running: boot settled + fresh scheduler heartbeat with running jobs.
      writeRuntimeStatus(RUNTIME_STATUS_KEYS.BOOT, {
        steps: [{ label: "lock acquired", status: "ok", section: "scheduler" }],
        started_at: new Date(nowMs).toISOString(),
      });
      writeRuntimeStatus(RUNTIME_STATUS_KEYS.SCHEDULER, {
        active_workers: 2,
        running_jobs: 1,
        queued_jobs: 4,
      });
      nowMs += 5_000;
      stream.pollInstanceStatus(nowMs);
      latest = statusFrames().at(-1);
      assert.equal(latest.payload.phase, "running");
      assert.equal(latest.payload.scheduler.active_workers, 2);
      assert.equal(latest.payload.boot_steps.length, 0, "boot steps omitted once past warming");

      // Stalled: heartbeat ages past 90s without a clean shutdown.
      nowMs += 5 * 60 * 1000;
      stream.pollInstanceStatus(nowMs);
      assert.equal(statusFrames().at(-1).payload.phase, "stalled");

      // Clean shutdown → offline.
      markCleanShutdown();
      nowMs += 5_000;
      stream.pollInstanceStatus(nowMs);
      assert.equal(statusFrames().at(-1).payload.phase, "offline");
    } finally {
      stream.close();
    }
  }));

  it("emits throttled job_progress with token sums and evicts terminal jobs", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Progress item", "desc");
    const job = createJob({ work_item_id: wi.id, job_type: "dev", title: "Long dev job" });
    updateJobStatus(job.id, "running");
    getDb().prepare(`
      INSERT INTO agent_calls (work_item_id, job_id, role, provider, model_tier, model_name,
                               input_tokens, output_tokens, status)
      VALUES (?, ?, 'dev', 'claude', 'strong', 'claude-opus-4-8', 48200, 3100, 'succeeded')
    `).run(wi.id, job.id);

    const stream = new ChangeStream({ pollMs: 100, instanceId: "posse-test" });
    const frames = [];
    stream.on("frame", (frame) => frames.push(frame));
    stream.start();
    try {
      let nowMs = Date.now() + 10_000;
      stream.pollJobProgress(nowMs);
      const progress = frames.filter((f) => f.kind === BRIDGE_EVENT_KINDS.JOB_PROGRESS);
      assert.equal(progress.length, 1);
      assert.equal(progress[0].payload.job_id, job.id);
      assert.equal(progress[0].payload.tokens_in, 48200);
      assert.equal(progress[0].payload.tokens_out, 3100);
      assert.ok(progress[0].payload.elapsed_ms >= 0);

      // Unchanged state → no re-emit on the next scan.
      nowMs += 10_000;
      stream.pollJobProgress(nowMs);
      assert.equal(frames.filter((f) => f.kind === BRIDGE_EVENT_KINDS.JOB_PROGRESS).length, 1);

      // New tokens → delta emits.
      getDb().prepare(`
        INSERT INTO agent_calls (work_item_id, job_id, role, provider, model_tier, model_name,
                                 input_tokens, output_tokens, status)
        VALUES (?, ?, 'dev', 'claude', 'strong', 'claude-opus-4-8', 1000, 50, 'succeeded')
      `).run(wi.id, job.id);
      nowMs += 10_000;
      stream.pollJobProgress(nowMs);
      const updated = frames.filter((f) => f.kind === BRIDGE_EVENT_KINDS.JOB_PROGRESS);
      assert.equal(updated.length, 2);
      assert.equal(updated[1].payload.tokens_in, 49200);

      // Terminal job leaves the live set (throttle map evicted, no frames).
      updateJobStatus(job.id, "succeeded");
      nowMs += 10_000;
      stream.pollJobProgress(nowMs);
      assert.equal(frames.filter((f) => f.kind === BRIDGE_EVENT_KINDS.JOB_PROGRESS).length, 2);
      assert.equal(stream.jobProgressLastByJobId.size, 0);
    } finally {
      stream.close();
    }
  }));

  it("emits cost_updated on cadence and immediately after terminal transitions", () => withTempRuntimeDb(() => {
    const wi = createWorkItem("Cost item", "desc");
    const job = createJob({ work_item_id: wi.id, job_type: "dev", title: "Costly job" });
    updateJobStatus(job.id, "running");
    getDb().prepare(`
      INSERT INTO agent_calls (work_item_id, job_id, role, provider, model_tier, model_name,
                               input_tokens, output_tokens, cost_estimate_usd, status)
      VALUES (?, ?, 'dev', 'claude', 'strong', 'claude-opus-4-8', 1000, 100, 0.42, 'succeeded')
    `).run(wi.id, job.id);

    const stream = new ChangeStream({ pollMs: 100, instanceId: "posse-test" });
    const frames = [];
    stream.on("frame", (frame) => frames.push(frame));
    stream.start();
    try {
      let nowMs = Date.now() + 60_000;
      stream.pollCosts(nowMs);
      const costFrames = () => frames.filter((f) => f.kind === BRIDGE_EVENT_KINDS.COST_UPDATED);
      assert.equal(costFrames().length, 1);
      assert.ok(Math.abs(costFrames()[0].payload.usd_total - 0.42) < 1e-9);

      // No change within the cadence → nothing new.
      stream.pollCosts(nowMs + 1_000);
      assert.equal(costFrames().length, 1);

      // Terminal transition marks the WI dirty → immediate recompute even
      // before the 30s cadence elapses.
      getDb().prepare(`
        INSERT INTO agent_calls (work_item_id, job_id, role, provider, model_tier, model_name,
                                 input_tokens, output_tokens, cost_estimate_usd, status)
        VALUES (?, ?, 'dev', 'claude', 'strong', 'claude-opus-4-8', 500, 50, 0.08, 'succeeded')
      `).run(wi.id, job.id);
      updateJobStatus(job.id, "succeeded");
      stream.poll();
      assert.equal(costFrames().length, 2);
      assert.ok(Math.abs(costFrames()[1].payload.usd_delta - 0.08) < 1e-9);
      assert.ok(Math.abs(costFrames()[1].payload.usd_total - 0.5) < 1e-9);
    } finally {
      stream.close();
    }
  }));

  it("includes instance_status in state snapshots", () => withTempRuntimeDb(() => {
    writeRuntimeStatus(RUNTIME_STATUS_KEYS.SCHEDULER, {
      active_workers: 1,
      running_jobs: 0,
      queued_jobs: 0,
    });
    const snapshot = collectStateSnapshot({ headEventId: 0 });
    assert.ok(snapshot.instance_status);
    assert.equal(snapshot.instance_status.phase, "idle");
    assert.equal(snapshot.instance_status.scheduler.active_workers, 1);
  }));
});
