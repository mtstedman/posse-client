import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { startOnnxRefresh } from "../lib/domains/atlas/functions/v2/parse/onnx-index-runner.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Atlas parse ONNX background refresh", () => {
  it("returns before background embeddings finish and commits changed fingerprints only", async () => {
    const committed = [];
    const embedded = [];
    const startedAt = Date.now();
    const run = startOnnxRefresh({
      mode: "initial",
      modelId: "mini",
      modelVersion: "1",
      batchSize: 1,
      wait: false,
      symbols: [
        { symbol_key: "a", merged_fingerprint: "same", text: "same" },
        { symbol_key: "b", merged_fingerprint: "new", text: "new" },
      ],
      existingFingerprints: { a: "same", b: "old" },
      embedSymbols: async (symbols) => {
        await delay(50);
        embedded.push(...symbols.map((symbol) => symbol.symbol_key));
        return symbols.map((symbol) => ({ symbol_key: symbol.symbol_key, vector: Buffer.from([1, 2, 3]) }));
      },
      commitBatch: async (rows) => {
        committed.push(...rows);
      },
    });

    assert.equal(run.background, true);
    assert.equal(run.changedSymbols, 1);
    assert.ok(Date.now() - startedAt < 40);

    const done = await run.done;
    assert.deepEqual(embedded, ["b"]);
    assert.equal(committed.length, 1);
    assert.equal(committed[0].symbol_key, "b");
    assert.equal(committed[0].merged_fingerprint, "new");
    assert.deepEqual(done, { indexedSymbols: 1, skippedSymbols: 1 });
  });

  it("can be awaited explicitly", async () => {
    const result = await startOnnxRefresh({
      mode: "changed",
      modelId: "mini",
      modelVersion: "1",
      wait: true,
      symbols: [{ symbol_key: "a", merged_fingerprint: "fp", text: "text" }],
      existingFingerprints: {},
      embedSymbols: async (symbols) => symbols.map((symbol) => ({ symbol_key: symbol.symbol_key, vector: Buffer.from([4]) })),
      commitBatch: async () => {},
    });

    assert.deepEqual(result, { indexedSymbols: 1, skippedSymbols: 0 });
  });

  it("rejects background failures without producing an unhandled rejection", async () => {
    const unhandled = [];
    const onUnhandled = (reason) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const events = [];
      const run = startOnnxRefresh({
        mode: "changed",
        modelId: "mini",
        modelVersion: "1",
        wait: false,
        symbols: [{ symbol_key: "a", merged_fingerprint: "fp", text: "text" }],
        existingFingerprints: {},
        embedSymbols: async () => {
          throw new Error("encoder unavailable");
        },
        commitBatch: async () => {},
        onEvent: (event) => events.push(event),
      });

      await assert.rejects(() => run.done, /encoder unavailable/);
      await new Promise((resolve) => setImmediate(resolve));

      assert.deepEqual(unhandled, []);
      assert.equal(events.at(-1)?.kind, "atlas.parse.onnx.failed");
      assert.equal(events.at(-1)?.error, "encoder unavailable");
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("fails closed when the encoder returns a partial vector batch", async () => {
    const committed = [];
    const events = [];

    await assert.rejects(() => startOnnxRefresh({
      mode: "changed",
      modelId: "mini",
      modelVersion: "1",
      wait: true,
      symbols: [
        { symbol_key: "a", merged_fingerprint: "fp-a", text: "a" },
        { symbol_key: "b", merged_fingerprint: "fp-b", text: "b" },
      ],
      existingFingerprints: {},
      embedSymbols: async () => [
        { symbol_key: "a", vector: Buffer.from([1]) },
      ],
      commitBatch: async (rows) => {
        committed.push(...rows);
      },
      onEvent: (event) => events.push(event),
    }), /missing vector for symbol_key 'b'/);

    assert.deepEqual(committed, []);
    assert.equal(events.at(-1)?.kind, "atlas.parse.onnx.failed");
  });
});
