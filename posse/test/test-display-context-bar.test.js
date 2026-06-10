import { describe, it, afterEach } from "node:test";
import assert from "node:assert/strict";

import { Display } from "../lib/domains/ui/classes/display/Display.js";
import { setOnnxWarmState, resetOnnxWarmState } from "../lib/domains/atlas/functions/v2/embeddings/onnx-warm-state.js";

const strip = (s) => String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
let jobSeq = 1;
const warmJob = (purpose, status) => ({
  id: jobSeq++,
  job_type: "atlas_warm",
  status,
  payload_json: JSON.stringify({ purpose }),
});

function contextBar(jobs, onnx) {
  const display = new Display({ concurrency: 1 });
  display._getQueueData = () => ({ workItems: [], jobs });
  resetOnnxWarmState();
  if (onnx) setOnnxWarmState(onnx);
  const lines = display._buildContextStatusBar(80);
  return lines.length ? strip(lines[0]).trim() : null;
}

describe("Display context status bar", () => {
  afterEach(() => resetOnnxWarmState());

  it("hides the bar when ATLAS is idle and the encoder never warmed", () => {
    assert.equal(contextBar([], null), null);
  });

  it("reads ready when there is no warm work and the encoder is warm", () => {
    assert.equal(
      contextBar([], { phase: "ready", startedAt: 1, finishedAt: 6001 }),
      "✓ context ready · encoder ready",
    );
  });

  it("reads warming with families and encoder percent while work is in flight", () => {
    const bar = contextBar(
      [warmJob("main-incremental", "running"), warmJob("scip-restage", "queued"), warmJob("scip-restage", "queued")],
      { phase: "loading", startedAt: Date.now() - 3700 },
    );
    assert.match(bar, /^. context warming/);
    assert.match(bar, /Code map 1↻/);
    assert.match(bar, /SCIP restage 2⏳/);
    assert.match(bar, /encoder \d+%/);
  });

  it("reads queued when warm work is pending but nothing is running", () => {
    assert.equal(contextBar([warmJob("main-incremental", "queued")], null), "· context queued · Code map 1⏳");
  });

  it("flags attention and explains the degraded mode when the encoder warm fails", () => {
    const bar = contextBar([], { phase: "failed", error: "onnxruntime load error\nstack trace" });
    assert.match(bar, /^✗ context attention/);
    assert.match(bar, /encoder warm failed/);
    assert.match(bar, /lexical-only/);
    // Only the first line of a multi-line error is shown.
    assert.doesNotMatch(bar, /stack trace/);
  });
});
