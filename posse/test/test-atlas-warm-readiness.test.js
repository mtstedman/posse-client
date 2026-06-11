// test/test-atlas-warm-readiness.test.js
//
// The live ATLAS/ONNX readiness state behind the two TUI bars: maps streamed
// ParseEngine progress events into atlas% / onnx% / language, rests at
// "ready"/"incomplete", and carries config-derived enablement so "off" is
// only ever shown for genuinely-disabled subsystems.

import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import {
  warmReadinessStarted,
  warmReadinessProgress,
  warmReadinessDone,
  warmReadinessSeed,
  getWarmReadiness,
  __resetWarmReadinessForTests,
} from "../lib/domains/atlas/functions/v2/warm-progress.js";

describe("ATLAS warm readiness state", () => {
  beforeEach(() => {
    __resetWarmReadinessForTests();
  });

  it("non-embedding stages drive ATLAS; embeddings drive ONNX", () => {
    const t = 1_000;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 40, language: "php" }, t + 1);
    let r = getWarmReadiness(t + 2);
    assert.equal(r.active, true);
    assert.equal(r.atlas, 40);
    assert.equal(r.onnx, null, "ONNX untouched by atlas stages");
    assert.equal(r.lang, "php");

    warmReadinessProgress({ stage: "embeddings", percent: 25, language: "ts" }, t + 3);
    r = getWarmReadiness(t + 4);
    assert.equal(r.atlas, 40, "ATLAS held while ONNX advances");
    assert.equal(r.onnx, 25);
    assert.equal(r.lang, "ts");
  });

  it("the encode loop's 'encoding' stage drives ONNX, not ATLAS", () => {
    const t = 1_500;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 60 }, t + 1);
    warmReadinessProgress({ stage: "encoding", percent: 35, language: "js" }, t + 2);
    const r = getWarmReadiness(t + 3);
    assert.equal(r.atlas, 60, "ATLAS untouched by encode-loop events");
    assert.equal(r.onnx, 35, "per-symbol encode progress lands on the ONNX bar");
  });

  it("done(success) rests ATLAS at ready 100; ONNX null when never observed", () => {
    const t = 2_000;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 80 }, t + 1);
    warmReadinessDone(true, t + 2);
    const r = getWarmReadiness(t + 3);
    assert.equal(r.active, false);
    assert.equal(r.atlas, 100);
    assert.equal(r.onnx, null, "no embeddings ever observed — stays unknown");
    assert.equal(r.stage, "ready");
  });

  it("done(success) rests ONNX at 100 when embeddings did run", () => {
    const t = 3_000;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "embeddings", percent: 50 }, t + 1);
    warmReadinessDone(true, t + 2);
    const r = getWarmReadiness(t + 3);
    assert.equal(r.onnx, 100);
  });

  it("ONNX ready state is sticky across warms that skip embeddings", () => {
    const t = 3_500;
    // First warm encodes to completion.
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "encoding", percent: 70 }, t + 1);
    warmReadinessDone(true, t + 2);
    assert.equal(getWarmReadiness(t + 3).onnx, 100);
    // Second warm never touches embeddings (nothing to encode) — the ONNX
    // bar must NOT be downgraded back to unknown/"off".
    warmReadinessStarted(t + 10);
    warmReadinessProgress({ stage: "view", percent: 90 }, t + 11);
    warmReadinessDone(true, t + 12);
    const r = getWarmReadiness(t + 13);
    assert.equal(r.onnx, 100, "previous resting state preserved");
    assert.equal(r.atlas, 100);
  });

  it("done(failure) keeps the partial % (honest incomplete)", () => {
    const t = 4_000;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 55 }, t + 1);
    warmReadinessDone(false, t + 2);
    const r = getWarmReadiness(t + 3);
    assert.equal(r.active, false);
    assert.equal(r.atlas, 55, "partial progress retained on failure");
    assert.equal(r.stage, "incomplete");
  });

  it("an active warm that stops ticking goes stale (reads idle)", () => {
    const t = 5_000;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 30 }, t + 1);
    assert.equal(getWarmReadiness(t + 100).active, true, "fresh tick is active");
    assert.equal(getWarmReadiness(t + 10_000).active, false, "stale tick reads idle");
  });

  it("seed rests the bars from real boot state and records enablement", () => {
    const t = 6_000;
    warmReadinessSeed({ atlas: 100, onnx: 100, atlasEnabled: true, onnxEnabled: true }, t);
    const r = getWarmReadiness(t + 1);
    assert.equal(r.active, false);
    assert.equal(r.atlas, 100);
    assert.equal(r.onnx, 100);
    assert.equal(r.atlasEnabled, true);
    assert.equal(r.onnxEnabled, true);
    assert.equal(r.stage, "seeded");
  });

  it("seed leaves undefined fields untouched (failure path keeps partials)", () => {
    const t = 7_000;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 45 }, t + 1);
    warmReadinessProgress({ stage: "encoding", percent: 20 }, t + 2);
    warmReadinessSeed({ atlasEnabled: true, onnxEnabled: true }, t + 3);
    const r = getWarmReadiness(t + 4);
    assert.equal(r.atlas, 45, "live partial kept");
    assert.equal(r.onnx, 20, "live partial kept");
    assert.equal(r.onnxEnabled, true);
  });

  it("seed can mark both subsystems genuinely off", () => {
    const t = 8_000;
    warmReadinessSeed({ atlas: null, onnx: null, atlasEnabled: false, onnxEnabled: false }, t);
    const r = getWarmReadiness(t + 1);
    assert.equal(r.atlasEnabled, false);
    assert.equal(r.onnxEnabled, false);
    assert.equal(r.atlas, null);
    assert.equal(r.onnx, null);
  });

  it("starting a new warm keeps seeded enablement and ONNX resting state", () => {
    const t = 9_000;
    warmReadinessSeed({ atlas: 100, onnx: 100, atlasEnabled: true, onnxEnabled: true }, t);
    warmReadinessStarted(t + 10);
    const r = getWarmReadiness(t + 11);
    assert.equal(r.active, true);
    assert.equal(r.atlas, 0, "ATLAS sweep restarts");
    assert.equal(r.onnx, 100, "ONNX resting state survives warm start");
    assert.equal(r.onnxEnabled, true, "enablement survives warm start");
  });
});
