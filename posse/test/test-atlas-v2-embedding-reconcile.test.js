// test/test-atlas-v2-embedding-reconcile.test.js
//
// The durable in-flight embedding breadcrumb + reconcile pass. The breadcrumb
// (EmbeddingIndex.markEncoding/clearEncoding/readInflight) records the batch
// being ENCODED before its atomic keys.db commit, so a crash mid-encode leaves
// a KNOWN gap instead of a silent one; reconcileEmbeddings then fills it and
// clears the marker. index.usearch rebuilds from keys.db on load, so making
// keys.db whole is enough.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  EmbeddingIndex,
  isUsearchAvailable,
  usearchUnavailableReason,
} from "../lib/domains/atlas/classes/v2/EmbeddingIndex.js";
import { StubEmbeddingEncoder } from "../lib/domains/atlas/classes/v2/EmbeddingEncoder.js";
import { ingestView } from "../lib/domains/atlas/functions/v2/embeddings/ingest.js";
import { reconcileEmbeddings, resumeEmbeddingsSlice } from "../lib/domains/atlas/functions/v2/embeddings/on-demand.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";

const skip = isUsearchAvailable() ? undefined : `usearch unavailable: ${usearchUnavailableReason() ?? "missing"}`;

function makeSymbols(n) {
  return Array.from({ length: n }, (_, i) => ({
    content_hash: sha256Hex(`recon-${i}`),
    local_id: i,
    kind: "function",
    lang: "ts",
    name: `fn_${i}`,
    qualified_name: `fn_${i}`,
    parent_local_id: null,
    repo_rel_path: `src/f${i}.ts`,
    range_start: 0,
    range_end: 10,
    signature_hash: `sig-${i}`,
    visibility: "public",
    doc: null,
  }));
}

function stubView(symbols, dbPath) {
  return { _dbPath: () => dbPath, query: { allSymbols: () => symbols } };
}

describe("ATLAS v2 embedding breadcrumb + reconcile", { skip }, () => {
  let tmp;
  before(() => { tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-emb-recon-")); });
  after(() => { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ } });

  function openIndex(name) {
    const enc = new StubEmbeddingEncoder({ dim: 32 });
    const index = EmbeddingIndex.open({
      model: enc.model, model_version: enc.model_version, dim: enc.dim,
      embeddingsRoot: path.join(tmp, name),
    });
    return { enc, index };
  }

  it("markEncoding/readInflight/clearEncoding round-trips the durable marker", () => {
    const { index } = openIndex("mech");
    try {
      assert.equal(index.readInflight(), null);
      index.markEncoding([{ content_hash: "h1", local_id: 0 }, { content_hash: "h2", local_id: 1 }], { batch: 1 });
      const inflight = index.readInflight();
      assert.ok(inflight, "marker should exist after markEncoding");
      assert.equal(inflight.keys.length, 2);
      assert.equal(inflight.batch, 1);
      index.clearEncoding();
      assert.equal(index.readInflight(), null, "marker should be gone after clearEncoding");
    } finally { index.close?.(); }
  });

  it("ingestView clears the breadcrumb on success but leaves it on encoder failure", async () => {
    const symbols = makeSymbols(3);

    const { enc, index } = openIndex("happy");
    try {
      await ingestView({ view: stubView(symbols, "v-happy"), index, encoder: enc });
      assert.equal(index.readInflight(), null, "clean ingest must leave no breadcrumb");
      for (const s of symbols) assert.ok(index.contains(s.content_hash, s.local_id));
    } finally { index.close?.(); }

    const { index: idx2 } = openIndex("fail");
    const boomEncoder = {
      model: "stub-boom", model_version: "v1", dim: 32,
      buildSymbolText: (s) => `${s.kind} ${s.name}`,
      encode: async () => { throw new Error("boom-encode"); },
    };
    try {
      await assert.rejects(
        () => ingestView({ view: stubView(symbols, "v-fail"), index: idx2, encoder: boomEncoder }),
        /boom-encode/,
      );
      const inflight = idx2.readInflight();
      assert.ok(inflight, "an interrupted encode must leave a breadcrumb");
      assert.equal(inflight.keys.length, 3, "breadcrumb records the in-flight batch's symbols");
    } finally { idx2.close?.(); }
  });

  it("reconcileEmbeddings fills the gap, flags the interrupted batch, and clears the breadcrumb", async () => {
    const symbols = makeSymbols(4);
    const { enc, index } = openIndex("recon");
    try {
      // Simulate a crash that left an in-flight marker with nothing committed.
      index.markEncoding(symbols.map((s) => ({ content_hash: s.content_hash, local_id: s.local_id })), { batch: 1 });
      assert.ok(index.readInflight());
      for (const s of symbols) assert.equal(index.contains(s.content_hash, s.local_id), false);

      const res = await reconcileEmbeddings({ view: stubView(symbols, "v-recon"), index, encoder: enc });
      assert.equal(res.hadInterruptedBatch, true);
      assert.equal(res.interruptedKeys, 4);
      assert.equal(res.encoded, 4);
      assert.equal(index.readInflight(), null, "breadcrumb cleared after a complete reconcile");
      for (const s of symbols) assert.ok(index.contains(s.content_hash, s.local_id), "gap filled");
    } finally { index.close?.(); }
  });

  it("reconcileEmbeddings is a no-op when fully indexed and no breadcrumb", async () => {
    const symbols = makeSymbols(2);
    const { enc, index } = openIndex("noop");
    try {
      await ingestView({ view: stubView(symbols, "v-noop"), index, encoder: enc });
      const res = await reconcileEmbeddings({ view: stubView(symbols, "v-noop"), index, encoder: enc });
      assert.equal(res.hadInterruptedBatch, false);
      assert.equal(res.skipped, true);
      assert.equal(res.reason, "fully_indexed");
    } finally { index.close?.(); }
  });

  it("resumeEmbeddingsSlice closes a gap across bounded slices and clears the breadcrumb at parity", async () => {
    const symbols = makeSymbols(5);
    const { enc, index } = openIndex("slice");
    try {
      // Simulate a gone owner: breadcrumb present, nothing committed.
      index.markEncoding(symbols.map((s) => ({ content_hash: s.content_hash, local_id: s.local_id })), { batch: 1 });

      const first = await resumeEmbeddingsSlice({ view: stubView(symbols, "v-slice"), index, encoder: enc, maxEncode: 2 });
      assert.equal(first.hadInterruptedBatch, true);
      assert.equal(first.candidates, 5);
      assert.equal(first.missing, 5);
      assert.equal(first.encoded, 2);
      assert.equal(first.remaining, 3);
      assert.equal(first.complete, false);

      const second = await resumeEmbeddingsSlice({ view: stubView(symbols, "v-slice"), index, encoder: enc, maxEncode: 2 });
      assert.equal(second.encoded, 2);
      assert.equal(second.remaining, 1);
      assert.equal(second.complete, false);

      const third = await resumeEmbeddingsSlice({ view: stubView(symbols, "v-slice"), index, encoder: enc, maxEncode: 2 });
      assert.equal(third.encoded, 1);
      assert.equal(third.remaining, 0);
      assert.equal(third.complete, true);
      assert.equal(index.readInflight(), null, "breadcrumb cleared once the index reached parity");
      for (const s of symbols) assert.ok(index.contains(s.content_hash, s.local_id));

      const done = await resumeEmbeddingsSlice({ view: stubView(symbols, "v-slice"), index, encoder: enc, maxEncode: 2 });
      assert.equal(done.skipped, true);
      assert.equal(done.reason, "fully_indexed");
      assert.equal(done.complete, true);
    } finally { index.close?.(); }
  });

  it("resumeEmbeddingsSlice never treats unsupported-language symbols as remaining work", async () => {
    // Ingest permanently excludes symbols without language semantics from
    // keys.db, so counting them as "missing" makes the gap unclosable: each
    // slice would re-discover the same ineligible symbols, report remaining>0
    // at zero progress, and re-enqueue the next slice forever.
    const eligible = makeSymbols(2);
    const ineligible = Array.from({ length: 5 }, (_, i) => ({
      content_hash: sha256Hex(`shell-${i}`),
      local_id: 100 + i,
      kind: "function",
      lang: "sh",
      name: `sh_fn_${i}`,
      qualified_name: `sh_fn_${i}`,
      parent_local_id: null,
      repo_rel_path: `scripts/s${i}.sh`,
      range_start: 0,
      range_end: 10,
      signature_hash: `sh-sig-${i}`,
      visibility: "public",
      doc: null,
    }));
    // Ineligible first: the old behavior sliced these 5 ahead of the slice
    // budget of 2 and could never make progress.
    const symbols = [...ineligible, ...eligible];
    const { enc, index } = openIndex("ineligible");
    try {
      const first = await resumeEmbeddingsSlice({ view: stubView(symbols, "v-inelig"), index, encoder: enc, maxEncode: 2 });
      assert.equal(first.missing, 2, "only encodable symbols may count as missing");
      assert.equal(first.encoded, 2);
      assert.equal(first.remaining, 0, "ineligible symbols are not remaining work");
      assert.equal(first.complete, true);

      const again = await resumeEmbeddingsSlice({ view: stubView(symbols, "v-inelig"), index, encoder: enc, maxEncode: 2 });
      assert.equal(again.skipped, true);
      assert.equal(again.reason, "fully_indexed", "no zero-progress re-enqueue chain may survive parity");
    } finally { index.close?.(); }
  });

  it("resumeEmbeddingsSlice reports an interrupted slice without claiming parity", async () => {
    const symbols = makeSymbols(3);
    const { index } = openIndex("slice-fail");
    const boomEncoder = {
      model: "stub-boom", model_version: "v1", dim: 32,
      buildSymbolText: (s) => `${s.kind} ${s.name}`,
      encode: async () => { throw new Error("boom-encode"); },
    };
    try {
      const res = await resumeEmbeddingsSlice({ view: stubView(symbols, "v-slice-fail"), index, encoder: boomEncoder, maxEncode: 2 });
      assert.equal(res.complete, false);
      assert.equal(res.encoded, 0);
      assert.equal(res.remaining, 3, "an errored slice retires nothing");
      assert.match(String(res.reason || ""), /boom-encode|encode_error/);
    } finally { index.close?.(); }
  });
});
