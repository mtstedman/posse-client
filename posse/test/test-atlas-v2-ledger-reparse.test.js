// @ts-check
//
// Coverage for Ledger.reingestBlobWithBackend — the opt-in path that
// `posse atlas-v2 scip reparse` uses to migrate an existing tree-sitter
// ledger row to SCIP. The deletion must be transactional; a re-ingest with
// a different backend must succeed.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeBlob(content) {
  return {
    hash: sha256Hex(Buffer.from(content)),
    byte_size: Buffer.byteLength(content),
  };
}

function makeSymbol(content_hash, local_id, name, source) {
  return /** @type {import("../lib/domains/atlas/functions/v2/contracts/schemas.js").SymbolRow} */ ({
    content_hash,
    local_id,
    kind: "function",
    name,
    qualified_name: null,
    parent_local_id: null,
    repo_rel_path: "src/foo.ts",
    lang: "ts",
    range_start: 0,
    range_end: 10,
    range_start_line: 1,
    range_end_line: 1,
    signature_hash: sha256Hex(name),
    visibility: null,
    doc: null,
    source,
  });
}

function makeEdge(from_content_hash, edge_id, source) {
  return /** @type {import("../lib/domains/atlas/functions/v2/contracts/schemas.js").EdgeRow} */ ({
    from_content_hash,
    edge_id,
    from_local_id: 0,
    to_content_hash: null,
    to_local_id: null,
    to_name: "bar",
    kind: "calls",
    range_start: 0,
    range_end: 5,
    range_start_line: 1,
    range_end_line: 1,
    confidence: 100,
    source,
  });
}

describe("ATLAS v2 Ledger reingestBlobWithBackend", () => {
  /** @type {string} */
  let tmp;
  before(() => { tmp = makeTmp("atlas-v2-reparse-"); });
  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows */ }
  });

  it("transactionally drops blob rows then accepts a re-ingest with a new source", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "swap.db") });
    try {
      const { hash, byte_size } = makeBlob("function foo() { bar(); }");
      led.ingestBlob({
        content_hash: hash,
        lang: "ts",
        byte_size,
        symbols: [makeSymbol(hash, 0, "foo", "treesitter")],
        edges: [makeEdge(hash, 0, "treesitter")],
      });
      led.append({
        branch: "main",
        op: "add",
        repo_rel_path: "src/foo.ts",
        before_content_hash: null,
        after_content_hash: hash,
      });
      assert.equal(led.hasBlob(hash), true);

      const counts = led.reingestBlobWithBackend({ content_hash: hash });
      assert.equal(counts.removed_blob, 0);
      assert.equal(counts.removed_symbols, 1);
      assert.equal(counts.removed_edges, 1);
      assert.equal(led.hasBlob(hash), true);
      // reingestBlobWithBackend drops the flat parse rows (the legacy
      // tree-sitter ingest) so a SCIP re-ingest can take over; the A/B
      // layer tables are managed separately by ingestBlob/ingestBlobLayer.
      // Assert against the flat table directly rather than getBlobSymbols,
      // which post-cutover reads the layer set (source of truth).
      const dbAfterReingest = led._unsafeDb();
      assert.equal(
        dbAfterReingest.prepare(
          "SELECT COUNT(*) AS c FROM blob_symbols WHERE content_hash = ?",
        ).get(hash).c,
        0,
        "reingest should clear the flat parse-symbol rows",
      );

      // Re-ingest with source='scip'.
      led.ingestBlob({
        content_hash: hash,
        lang: "ts",
        byte_size,
        symbols: [makeSymbol(hash, 0, "foo", "scip")],
        edges: [makeEdge(hash, 0, "scip")],
      });
      assert.equal(led.hasBlob(hash), true);
      const db = led._unsafeDb();
      const row = db.prepare(
        "SELECT source FROM blob_symbols WHERE content_hash = ? AND local_id = 0",
      ).get(hash);
      assert.equal(row.source, "scip");
      const edgeRow = db.prepare(
        "SELECT source FROM blob_edges WHERE from_content_hash = ? AND edge_id = 0",
      ).get(hash);
      assert.equal(edgeRow.source, "scip");
    } finally {
      led.close();
    }
  });

  it("is a no-op when called for a content_hash that is not present", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "absent.db") });
    try {
      const counts = led.reingestBlobWithBackend({ content_hash: "0".repeat(64) });
      assert.equal(counts.removed_blob, 0);
      assert.equal(counts.removed_symbols, 0);
      assert.equal(counts.removed_edges, 0);
    } finally {
      led.close();
    }
  });

  it("rejects malformed input", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "bad.db") });
    try {
      assert.throws(
        () => led.reingestBlobWithBackend({ content_hash: "notahash" }),
        /SHA-256/,
      );
    } finally {
      led.close();
    }
  });

  it("opens a pre-SCIP ledger whose blob_edges table lacks to_external_id", () => {
    const dbPath = path.join(tmp, "pre-scip.db");
    const db = new Database(dbPath);
    try {
      db.exec(`
        CREATE TABLE blob_symbols (
          content_hash TEXT NOT NULL,
          local_id INTEGER NOT NULL,
          kind_id INTEGER NOT NULL,
          name_id INTEGER NOT NULL,
          qualified_name_id INTEGER,
          parent_local_id INTEGER,
          range_start INTEGER NOT NULL,
          range_end INTEGER NOT NULL,
          range_start_line INTEGER,
          range_end_line INTEGER,
          signature_hash TEXT NOT NULL,
          signature_text TEXT,
          visibility TEXT,
          doc TEXT,
          PRIMARY KEY (content_hash, local_id)
        );
        CREATE TABLE blob_edges (
          from_content_hash TEXT NOT NULL,
          edge_id INTEGER NOT NULL,
          from_local_id INTEGER NOT NULL,
          to_content_hash TEXT,
          to_local_id INTEGER,
          to_name_id INTEGER NOT NULL,
          to_module_id INTEGER,
          kind_id INTEGER NOT NULL,
          range_start INTEGER NOT NULL,
          range_end INTEGER NOT NULL,
          range_start_line INTEGER,
          range_end_line INTEGER,
          confidence INTEGER NOT NULL,
          PRIMARY KEY (from_content_hash, edge_id)
        );
      `);
    } finally {
      db.close();
    }

    const led = Ledger.open({ dbPath });
    try {
      const cols = led._unsafeDb().prepare("PRAGMA table_info(blob_edges)").all();
      assert.ok(cols.some((c) => c.name === "to_external_id"));
    } finally {
      led.close();
    }
  });
});
