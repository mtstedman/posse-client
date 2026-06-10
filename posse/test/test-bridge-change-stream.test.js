import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { BRIDGE_EVENT_KINDS } from "../lib/catalog/bridge.js";
import { EVENT_TYPES } from "../lib/catalog/event.js";
import { ChangeStream } from "../lib/domains/bridge/classes/ChangeStream.js";
import { getDb } from "../lib/shared/storage/functions/index.js";
import { redactBridgeValue } from "../lib/domains/bridge/functions/redaction.js";
import { tailEvents } from "../lib/domains/bridge/functions/state-snapshot.js";
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
});
