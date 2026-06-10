// test/test-atlas-warm-readiness.test.js
//
// The live ATLAS/ONNX readiness state behind the two TUI bars: maps streamed
// ParseEngine progress events into atlas% / onnx% / language, and rests at
// "ready" (ONNX "off" when embeddings never fired) when idle.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  warmReadinessStarted,
  warmReadinessProgress,
  warmReadinessDone,
  getWarmReadiness,
} from "../lib/domains/atlas/functions/v2/warm-progress.js";

describe("ATLAS warm readiness state", () => {
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

  it("done(success) rests ATLAS at ready 100 and ONNX 'off' when embeddings never ran", () => {
    const t = 2_000;
    warmReadinessStarted(t);
    warmReadinessProgress({ stage: "view", percent: 80 }, t + 1);
    warmReadinessDone(true, t + 2);
    const r = getWarmReadiness(t + 3);
    assert.equal(r.active, false);
    assert.equal(r.atlas, 100);
    assert.equal(r.onnx, null, "ONNX stays off — embeddings never fired");
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
});
