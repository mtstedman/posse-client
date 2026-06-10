// test/test-atlas-v2-conductor-warm.test.js
//
// Validates the Atlas-Conductor `warm` op end-to-end and proves parity with a
// direct in-process Warmer. This is the path the production atlas_warm executor
// (runRealWarmer) now drives instead of spawning a per-job worker thread, so the
// conductor result must match the Warmer's byte-for-byte on the fields the job
// records, and must write a real, mountable view.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { Warmer } from "../lib/domains/atlas/classes/v2/Warmer.js";
import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import {
  ledgerDbPath,
  mainViewPath,
  warmedViewPath,
} from "../lib/domains/atlas/functions/v2/runtime-paths.js";
import {
  createConductorDaemon,
  getSharedConductor,
  closeSharedConductor,
} from "../lib/domains/atlas/functions/v2/parse/conductor.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hashOf(s) {
  return sha256Hex(Buffer.from(s));
}

// Seed a small repo-shaped ledger: one TS file (class Foo { greet() {} }) on
// the main branch. Mirrors test-atlas-v2-warmer's setup so a `wi` warm builds a
// view from ledger content without needing a parser/disk source.
function setupRepo(repoRoot) {
  const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
  const content = `class Foo { greet() {} }`;
  const hash = hashOf(content);
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

function warmJobPayload(repoRoot, wiId) {
  return {
    purpose: "wi",
    work_item_id: wiId,
    out_view_path: warmedViewPath(repoRoot, wiId),
    paths: ["src/foo.ts"],
  };
}

function assertWarmedView(result) {
  assert.equal(result.purpose, "wi");
  assert.ok(result.view_written, "view_written should be set");
  assert.ok(result.view_etag, "view_etag should be set");
  assert.equal(result.skipped.length, 0);
  assert.ok(fs.existsSync(result.view_written), "warmed view file should exist on disk");
  const view = View.mount({ dbPath: result.view_written });
  try {
    assert.equal(view.query.symbolsInFile("src/foo.ts").length, 2);
    assert.deepEqual(view.meta().warmed_for_files, ["src/foo.ts"]);
  } finally {
    view.close();
  }
}

describe("ATLAS v2 Conductor warm op", () => {
  let tmp;
  before(() => { tmp = makeTmp("atlas-v2-conductor-warm-"); });
  after(async () => {
    await closeSharedConductor();
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
  });

  it("conductor.warm matches a direct Warmer for a wi warm", async () => {
    // Direct Warmer (the oracle).
    const repoA = path.join(tmp, "repoA");
    setupRepo(repoA);
    const ledA = Ledger.open({ dbPath: ledgerDbPath(repoA) });
    let direct;
    try {
      direct = await new Warmer({ ledger: ledA, repoRoot: repoA }).handleWarmJob(warmJobPayload(repoA, 42));
    } finally {
      ledA.close();
    }
    assertWarmedView(direct);

    // Same warm via the conductor daemon (separate thread, its own handles).
    const repoB = path.join(tmp, "repoB");
    setupRepo(repoB);
    const conductor = createConductorDaemon();
    let viaConductor;
    try {
      viaConductor = await conductor.warm({
        ledgerPath: ledgerDbPath(repoB),
        dbPath: mainViewPath(repoB),
        repoRoot: repoB,
        branch: "main",
        config: {},
        job: warmJobPayload(repoB, 42),
      });
    } finally {
      await conductor.close();
      await conductor.daemon.dispose();
    }
    assertWarmedView(viaConductor);

    // Parity on the fields the atlas_warm job records (durations excepted).
    for (const key of ["purpose", "paths_considered", "paths_indexed", "blobs_ingested", "blobs_reused", "ledger_entries_appended"]) {
      assert.deepEqual(viaConductor[key], direct[key], `mismatch on ${key}`);
    }
    assert.equal(viaConductor.skipped.length, direct.skipped.length);
  });

  it("streams per-stage progress over the daemon channel during warm", async () => {
    const repo = path.join(tmp, "repoProgress");
    setupRepo(repo);
    const conductor = createConductorDaemon();
    const events = [];
    try {
      const res = await conductor.warm({
        ledgerPath: ledgerDbPath(repo),
        dbPath: mainViewPath(repo),
        repoRoot: repo,
        branch: "main",
        config: {},
        job: warmJobPayload(repo, 99),
      }, { onProgress: (e) => events.push(e) });
      assertWarmedView(res);
    } finally {
      await conductor.close();
      await conductor.daemon.dispose();
    }
    assert.ok(events.length > 0, "warm should stream at least one progress event");
    // Progress events carry a stage (ParseEngine #emitStage shape).
    assert.ok(events.some((e) => typeof e?.stage === "string"), "progress events should carry a stage");
  });

  it("getSharedConductor returns a reusable singleton that warms", async () => {
    const a = getSharedConductor();
    const b = getSharedConductor();
    assert.equal(a, b, "getSharedConductor must return the same instance");

    const repo = path.join(tmp, "repoShared");
    setupRepo(repo);
    const result = await a.warm({
      ledgerPath: ledgerDbPath(repo),
      dbPath: mainViewPath(repo),
      repoRoot: repo,
      branch: "main",
      config: {},
      job: warmJobPayload(repo, 7),
    });
    assertWarmedView(result);

    // After close, the next get creates a fresh instance.
    await closeSharedConductor();
    assert.notEqual(getSharedConductor(), a, "a closed singleton must not be reused");
  });
});
