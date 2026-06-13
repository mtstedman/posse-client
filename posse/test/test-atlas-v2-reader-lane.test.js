// test/test-atlas-v2-reader-lane.test.js
//
// Conductor thread bundle v0 (CONDUCTOR-THREAD-BUNDLE-SPEC.md): retrieval
// dispatch runs in a dedicated reader-lane thread, so reads never queue behind
// the writer lane's long synchronous sections. Covers:
//   - retrieve routing lands in the reader lane (not the writer thread)
//   - the starvation regression: a retrieve completes while the writer lane is
//     synchronously occupied (the job-#1114 class: symbol.search 105s during a
//     warm, handoff downgraded to a session without write tools)
//   - cross-lane invalidation: indexing ops tell the reader to drop cached
//     embedding resources (the writer's in-thread invalidation can't reach it)
//   - the reader host's read-only op allowlist
//   - lifecycle: close() tears the reader lane down with the writer

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { ledgerDbPath, mainViewPath, warmedViewPath } from "../lib/domains/atlas/functions/v2/runtime-paths.js";
import { Daemon, ThreadTransport } from "../lib/classes/tools/daemon/index.js";
import {
  createConductorDaemon,
  getSharedConductor,
  closeSharedConductor,
} from "../lib/domains/atlas/functions/v2/parse/conductor.js";

const READER_HOST_URL = new URL("../lib/domains/atlas/functions/v2/parse/reader-host.mjs", import.meta.url);

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// Same minimal fixture as test-atlas-v2-conductor-warm: one TS file with a
// class + method on main, so warms build a real view without a parser.
function setupRepo(repoRoot) {
  const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
  const content = `class Foo { greet() {} }`;
  const hash = sha256Hex(Buffer.from(content));
  const symbols = [
    {
      content_hash: hash, local_id: 0,
      kind: "class", name: "Foo", qualified_name: "Foo",
      parent_local_id: null, repo_rel_path: "src/foo.ts", lang: "ts",
      range_start: 0, range_end: 24,
      signature_hash: sha256Hex("class Foo"),
      visibility: "public", doc: null,
    },
    {
      content_hash: hash, local_id: 1,
      kind: "method", name: "greet", qualified_name: "Foo.greet",
      parent_local_id: 0, repo_rel_path: "src/foo.ts", lang: "ts",
      range_start: 12, range_end: 22,
      signature_hash: sha256Hex("Foo.greet()"),
      visibility: "public", doc: null,
    },
  ];
  led.ingestBlob({ content_hash: hash, lang: "ts", byte_size: content.length, symbols, edges: [] });
  led.append({
    branch: "main", op: "add", repo_rel_path: "src/foo.ts",
    before_content_hash: null, after_content_hash: hash,
  });
  led.close();
}

function retrievePayload(repoRoot) {
  return {
    call: { action: "symbol.search", query: "Foo", limit: 5 },
    viewPath: mainViewPath(repoRoot),
    ledgerPath: ledgerDbPath(repoRoot),
    versionId: "main@1",
    readRoot: repoRoot,
    repoId: "reader-lane-test",
  };
}

describe("ATLAS v2 Conductor reader lane", () => {
  let tmp;
  let repoRoot;
  let conductor;

  before(async () => {
    tmp = makeTmp("atlas-v2-reader-lane-");
    repoRoot = path.join(tmp, "repo");
    setupRepo(repoRoot);
    conductor = createConductorDaemon();
    await conductor.warm({
      ledgerPath: ledgerDbPath(repoRoot),
      dbPath: mainViewPath(repoRoot),
      repoRoot,
      branch: "main",
      config: {},
      job: { purpose: "main-full", out_view_path: mainViewPath(repoRoot), paths: [] },
    });
  });

  after(async () => {
    await closeSharedConductor();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("routes retrieve to the reader lane", async () => {
    // The reader is lazy: a warm alone must not have spawned it.
    assert.equal(await conductor.readerInfo(), null, "reader must not spawn for warm-only use");

    const envelope = await conductor.retrieve(retrievePayload(repoRoot));
    assert.equal(envelope.ok, true);
    assert.equal(envelope.action, "symbol.search");
    assert.ok(envelope.data.items.some((item) => item.name === "Foo"));

    const readerInfo = await conductor.readerInfo();
    assert.equal(readerInfo.lane, "reader");
    assert.equal(readerInfo.retrieves, 1, "the retrieve must have dispatched in the reader lane");

    const info = await conductor.info();
    assert.equal(info.readerAlive, true);
  });

  it("completes retrieves while the writer lane is synchronously blocked", async () => {
    // Baseline: what one unblocked reader-lane retrieve costs on this machine
    // (a retrieve is not cheap — ~1s observed — so absolute thresholds would
    // measure dispatch cost, not queuing).
    const b0 = Date.now();
    await conductor.retrieve(retrievePayload(repoRoot));
    const baseline = Date.now() - b0;

    // Occupy the writer thread's event loop with a sync busy-wait — the
    // deterministic stand-in for a warm's SCIP ingest transaction. Anything
    // routed to the writer queues behind it for the full duration, so size the
    // block to several baselines: a writer-routed retrieve waits out the whole
    // block (elapsed >= blockMs) while a reader-lane retrieve pays roughly one
    // baseline regardless of the block.
    const blockMs = Math.min(15_000, Math.max(3_000, baseline * 4));
    const blockPromise = conductor.daemon.request({ op: "debug.block", ms: blockMs });

    const t0 = Date.now();
    const envelope = await conductor.retrieve(retrievePayload(repoRoot));
    const elapsed = Date.now() - t0;
    assert.equal(envelope.ok, true);

    const block = await blockPromise;
    assert.equal(block.ok, true);
    assert.ok(block.data.blockedMs >= blockMs, "the writer lane must actually have been occupied");
    // 0.6 leaves generous headroom for CPU contention with the spinning
    // writer while staying unreachable for a writer-queued retrieve.
    assert.ok(
      elapsed < blockMs * 0.6,
      `retrieve must not queue behind the writer block (took ${elapsed}ms of a ${blockMs}ms block; unblocked baseline ${baseline}ms)`,
    );
  });

  it("delivers invalidate to the reader after an indexing op", async () => {
    const beforeWarm = await conductor.readerInfo();
    await conductor.warm({
      ledgerPath: ledgerDbPath(repoRoot),
      dbPath: mainViewPath(repoRoot),
      repoRoot,
      branch: "main",
      config: {},
      job: { purpose: "wi", work_item_id: 7, out_view_path: warmedViewPath(repoRoot, 7), paths: ["src/foo.ts"] },
    });
    const afterWarm = await conductor.readerInfo();
    assert.ok(
      afterWarm.invalidations > beforeWarm.invalidations,
      "a warm must invalidate the reader lane's cached embedding resources",
    );
  });

  it("tears the reader lane down with close()", async () => {
    assert.equal((await conductor.info()).readerAlive, true);
    await conductor.close();
    assert.equal((await conductor.info()).readerAlive, false, "close must dispose the reader lane");
    await conductor.daemon.dispose();
  });

  it("reader host refuses write ops", async () => {
    const reader = new Daemon({
      transportFactory: () => ThreadTransport({ moduleUrl: READER_HOST_URL }),
      label: "atlas-reader-test",
    });
    try {
      for (const op of ["warm", "merge", "ingest", "stage"]) {
        const res = await reader.request({ op });
        assert.equal(res.ok, false, `${op} must be refused by the reader lane`);
        assert.match(String(res.error?.message || ""), /read-only/);
      }
    } finally {
      await reader.dispose();
    }
  });

  it("shared conductor retrieves through the reader lane", async () => {
    const shared = getSharedConductor();
    const envelope = await shared.retrieve(retrievePayload(repoRoot));
    assert.equal(envelope.ok, true);
    const readerInfo = await shared.readerInfo();
    assert.equal(readerInfo.lane, "reader");
    assert.ok(readerInfo.retrieves >= 1);
    await closeSharedConductor();
  });
});
