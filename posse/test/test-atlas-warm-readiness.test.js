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

  // The ATLAS composite is stage-anchored: the "view" stage owns the 70–90
  // slice of the bar, so view@40% renders as 70 + 0.4·20 = 78 composite.
  it("non-embedding stages drive ATLAS; embeddings drive ONNX", () => {
    const t = 1_000;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 40, language: "php" }, t + 1);
    let r = getWarmReadiness(t + 2);
    assert.equal(r.active, true);
    assert.equal(r.atlas, 78);
    assert.equal(r.onnx, null, "ONNX untouched by atlas stages");
    assert.equal(r.lang, "php");

    warmReadinessProgress({ stage: "embeddings", percent: 25, language: "ts" }, t + 3);
    r = getWarmReadiness(t + 4);
    // Encode runs after the parse/view/tree pipeline, so the first
    // embeddings event completes the ATLAS bar instead of pinning it at the
    // last bucket (it sat at 97% for the whole multi-minute encode pass).
    assert.equal(r.atlas, 100, "ATLAS completes once encode begins");
    assert.equal(r.onnx, 25);
    assert.equal(r.lang, "ts");
  });

  it("the encode loop's 'encoding' stage drives ONNX and completes ATLAS", () => {
    const t = 1_500;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 60 }, t + 1);
    warmReadinessProgress({ stage: "encoding", percent: 35, language: "js" }, t + 2);
    const r = getWarmReadiness(t + 3);
    assert.equal(r.atlas, 100, "encode-loop events mark the ATLAS side complete");
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

  it("a second language starting at 0% never drags the composite backwards", () => {
    const t = 1_700;
    warmReadinessStarted(t);
    const samples = [];
    const tick = (event, offset) => {
      warmReadinessProgress(event, t + offset);
      samples.push(getWarmReadiness(t + offset).atlas);
    };
    tick({ stage: "parsing", percent: 50, language: "php" }, 1);   // parse slice 25–70 → 47.5
    tick({ stage: "parsing", percent: 100, language: "php" }, 2);  // → 70
    tick({ stage: "parsing", percent: 0, language: "typescript" }, 3);   // mean drops; ratchet holds 70
    tick({ stage: "parsing", percent: 60, language: "typescript" }, 4);  // still under the ratchet
    tick({ stage: "view", percent: 50, language: null }, 5);       // view slice 70–90 → 80
    for (let i = 1; i < samples.length; i++) {
      assert.ok(samples[i] >= samples[i - 1], `composite regressed at sample ${i}: ${samples.join(", ")}`);
    }
    assert.equal(samples[1], 70, "php parse completion fills the parse slice");
    assert.equal(samples[2], 70, "typescript@0% plateaus instead of resetting to 0");
    assert.equal(samples[4], 80, "view progress resumes the sweep");
  });

  it("the composite never reads 100 while the warm is still active", () => {
    const t = 1_800;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 100 }, t + 1);
    warmReadinessProgress({ stage: "tree", percent: 100 }, t + 2);
    assert.ok(getWarmReadiness(t + 3).atlas < 100, "done()/seed() own the 100");
    warmReadinessDone(true, t + 4);
    assert.equal(getWarmReadiness(t + 5).atlas, 100);
  });

  it("unknown stages tick liveness but do not move the bar", () => {
    const t = 1_900;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 50 }, t + 1);
    const before = getWarmReadiness(t + 2).atlas;
    warmReadinessProgress({ stage: "mystery-stage", percent: 5 }, t + 3);
    const r = getWarmReadiness(t + 4);
    assert.equal(r.atlas, before, "unweighted stage left the composite alone");
    assert.equal(r.active, true);
    assert.equal(r.stage, "mystery-stage");
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
    assert.equal(r.atlas, 81, "partial progress retained on failure");
    assert.equal(r.stage, "incomplete");
  });

  it("an active warm that stops ticking goes stale (reads idle)", () => {
    const t = 5_000;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 30 }, t + 1);
    assert.equal(getWarmReadiness(t + 100).active, true, "fresh tick is active");
    // Legitimately-quiet phases (view merge, ONNX model load) can go tens of
    // seconds without a percent — they must NOT flash the resting label.
    assert.equal(getWarmReadiness(t + 10_000).active, true, "quiet phase stays active");
    assert.equal(getWarmReadiness(t + 60_000).active, false, "stale tick reads idle");
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
    assert.equal(r.atlas, 100, "encode began, so the ATLAS side is complete");
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
