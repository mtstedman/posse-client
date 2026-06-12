// @ts-check
//
// Coverage for Ledger.recordScipIndex + listScipIndexes — verifies that the
// (scheme, indexer_version, fileset_hash, config_hash, deps_hash) tuple
// short-circuits a re-ingest, and that listScipIndexes returns the parsed
// JSON-encoded indexer_arguments field.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("ATLAS v2 Ledger scip_indexes", () => {
  /** @type {string} */
  let tmp;
  before(() => { tmp = makeTmp("atlas-v2-scipidx-"); });
  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows */ }
  });

  it("inserts a fresh bookkeeping row and surfaces it via listScipIndexes", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "fresh.db") });
    try {
      const id = led.recordScipIndex({
        scheme: "scip-typescript",
        tool_name: "scip-typescript",
        indexer_version: "0.3.0",
        indexer_arguments: ["--cwd", "/repo"],
        project_root: "/repo",
        langs: ["ts", "tsx"],
        fileset_hash: "f".repeat(64),
        config_hash: "c".repeat(64),
        deps_hash: "d".repeat(64),
        document_count: 12,
        occurrence_count: 5000,
        external_symbol_count: 800,
        produced_at: "2026-05-22T00:00:00.000Z",
      });
      assert.ok(Number.isInteger(id) && id > 0);
      const list = led.listScipIndexes();
      assert.equal(list.length, 1);
      assert.equal(list[0].scheme, "scip-typescript");
      assert.equal(list[0].indexer_version, "0.3.0");
      assert.deepEqual(list[0].indexer_arguments, ["--cwd", "/repo"]);
      assert.equal(list[0].langs, "ts,tsx");
      assert.equal(list[0].document_count, 12);
      assert.equal(list[0].produced_at, "2026-05-22T00:00:00.000Z");
      assert.ok(list[0].ingested_at);
    } finally {
      led.close();
    }
  });

  it("returns null when re-recording an already-ingested SCIP index", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "dedupe.db") });
    try {
      const base = {
        scheme: "scip-typescript",
        tool_name: "scip-typescript",
        indexer_version: "0.3.0",
        indexer_arguments: [],
        project_root: "/repo",
        langs: "ts",
        fileset_hash: "a".repeat(64),
        config_hash: "",
        deps_hash: "",
        document_count: 1,
        occurrence_count: 1,
        external_symbol_count: 0,
      };
      const first = led.recordScipIndex(base);
      assert.ok(Number.isInteger(first) && first > 0);
      const second = led.recordScipIndex(base);
      assert.equal(second, null, "second insert with the same key must report no-op");
      assert.equal(led.listScipIndexes().length, 1);
    } finally {
      led.close();
    }
  });

  it("does not downgrade a complete SCIP index row to partial", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "no-downgrade.db") });
    try {
      const base = {
        scheme: "scip-typescript",
        tool_name: "scip-typescript",
        indexer_version: "0.3.0",
        indexer_arguments: [],
        project_root: "/repo",
        langs: "ts",
        fileset_hash: "d".repeat(64),
        config_hash: "",
        deps_hash: "",
        document_count: 2,
        occurrence_count: 2,
        external_symbol_count: 0,
      };
      const first = led.recordScipIndex({ ...base, status: "complete", documents_failed: 0 });
      assert.ok(Number.isInteger(first) && first > 0);
      const second = led.recordScipIndex({ ...base, status: "partial", documents_failed: 1, return_existing: true });
      assert.equal(second, first);

      const rows = led.listScipIndexes();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "complete");
      assert.equal(led.findScipIndexId(base), first);
    } finally {
      led.close();
    }
  });

  it("findScipIndexId returns matching partial rows so stable failures can short-circuit", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "partial-dedupe.db") });
    try {
      const base = {
        scheme: "scip-typescript",
        tool_name: "scip-typescript",
        indexer_version: "0.3.0",
        indexer_arguments: [],
        project_root: "/repo",
        langs: "ts",
        fileset_hash: "e".repeat(64),
        config_hash: "",
        deps_hash: "",
        document_count: 2,
        occurrence_count: 2,
        external_symbol_count: 0,
      };
      const first = led.recordScipIndex({ ...base, status: "partial", documents_failed: 1 });
      assert.ok(Number.isInteger(first) && first > 0);
      assert.equal(led.findScipIndexId(base), first);
    } finally {
      led.close();
    }
  });

  it("findScipIndexId ignores total-failure rows so the next ingest can retry", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "total-failure-retry.db") });
    try {
      const base = {
        scheme: "scip-typescript",
        tool_name: "scip-typescript",
        indexer_version: "0.3.0",
        indexer_arguments: [],
        project_root: "/repo",
        langs: "ts",
        fileset_hash: "f".repeat(64),
        config_hash: "",
        deps_hash: "",
        document_count: 3,
        occurrence_count: 3,
        external_symbol_count: 0,
      };
      // Every document failed (branch-snapshot error / fully-drifted .scip):
      // the row must NOT mask future ingests as already done.
      const failedAll = led.recordScipIndex({ ...base, status: "partial", documents_failed: 3 });
      assert.ok(Number.isInteger(failedAll) && failedAll > 0);
      assert.equal(led.findScipIndexId(base), null);
      // A later successful run upgrades the row and dedupes normally again.
      led.recordScipIndex({ ...base, status: "complete", documents_failed: 0, return_existing: true });
      assert.equal(led.findScipIndexId(base), failedAll);
    } finally {
      led.close();
    }
  });

  it("distinguishes records that differ by config_hash / deps_hash", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "vary.db") });
    try {
      const base = {
        scheme: "scip-typescript",
        tool_name: "scip-typescript",
        indexer_version: "0.3.0",
        indexer_arguments: [],
        project_root: "/repo",
        langs: "ts",
        fileset_hash: "b".repeat(64),
        document_count: 1,
        occurrence_count: 1,
        external_symbol_count: 0,
      };
      const a = led.recordScipIndex({ ...base, config_hash: "1".repeat(64), deps_hash: "" });
      const b = led.recordScipIndex({ ...base, config_hash: "2".repeat(64), deps_hash: "" });
      const c = led.recordScipIndex({ ...base, config_hash: "1".repeat(64), deps_hash: "3".repeat(64) });
      assert.ok(a && b && c);
      assert.notEqual(a, b);
      assert.notEqual(a, c);
      assert.equal(led.listScipIndexes().length, 3);
    } finally {
      led.close();
    }
  });
});
