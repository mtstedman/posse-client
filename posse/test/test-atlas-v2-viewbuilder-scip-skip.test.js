// @ts-check
//
// Coverage for ViewBuilder's resolver-pass skip of SCIP-bound edges.
//
// The view builder runs three layers when materializing edges:
//   1. populate the view's edges table from the ledger,
//   2. resolve `to_global_id` against the import context + global name index,
//   3. NEVER touch rows whose `source='scip'` or whose `to_external_id` is
//      populated — SCIP is compiler-precise, so heuristic rebinding must be
//      a no-op for those rows.
//
// This test stages two edges that share `to_name='bar'`:
//   - a tree-sitter edge with confidence=20 (resolver target), and
//   - a scip-bound edge with confidence=98 (must NOT be rewritten).
// A defining symbol `bar` is present at a peer path so the resolver has a
// candidate to bind to. We then assert that the SCIP row's confidence and
// external pointer survive the resolver pass.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}
function hashOf(s) {
  return sha256Hex(Buffer.from(s));
}

describe("ATLAS v2 ViewBuilder: SCIP edges are not touched by the resolver", () => {
  /** @type {string} */
  let tmp;
  before(() => { tmp = makeTmp("atlas-v2-vb-scip-"); });
  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows */ }
  });

  it("preserves source='scip' and to_external_id; resolver only rebinds tree-sitter rows", () => {
    const dbPath = path.join(tmp, "ledger.db");
    const viewPath = path.join(tmp, "view.db");

    const defContent = `function bar() { return 1; }`;
    const defHash = hashOf(defContent);
    const callerContent = `function caller() { bar(); }`;
    const callerHash = hashOf(callerContent);

    const led = Ledger.open({ dbPath });
    try {
      // Two definitions of bar: one in-repo (`util.ts`) plus a SCIP external
      // moniker registered in external_symbols.
      const extId = led.upsertExternalSymbol({
        scheme: "scip-typescript",
        manager: "npm",
        package_name: "left-pad",
        package_version: "1.0.0",
        descriptor: "bar().",
      });
      assert.ok(extId > 0);

      // Blob A: defines bar in-repo. Tree-sitter origin.
      led.ingestBlob({
        content_hash: defHash, lang: "ts", byte_size: defContent.length,
        symbols: [{
          content_hash: defHash, local_id: 0,
          kind: "function", name: "bar", qualified_name: "bar",
          parent_local_id: null,
          repo_rel_path: "src/util.ts", lang: "ts",
          range_start: 0, range_end: defContent.length,
          range_start_line: 1, range_end_line: 1,
          signature_hash: sha256Hex("bar()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });

      // Blob B: caller has TWO edges pointing at "bar".
      //  - edge 0: tree-sitter, unresolved (low confidence) → resolver should bind to in-repo bar.
      //  - edge 1: scip, bound to an external moniker (high confidence) → resolver must NOT touch.
      led.ingestBlob({
        content_hash: callerHash, lang: "ts", byte_size: callerContent.length,
        symbols: [{
          content_hash: callerHash, local_id: 0,
          kind: "function", name: "caller", qualified_name: "caller",
          parent_local_id: null,
          repo_rel_path: "src/caller.ts", lang: "ts",
          range_start: 0, range_end: callerContent.length,
          range_start_line: 1, range_end_line: 1,
          signature_hash: sha256Hex("caller()"),
          visibility: "public", doc: null,
          source: "treesitter",
        }],
        edges: [
          {
            from_content_hash: callerHash, edge_id: 0, from_local_id: 0,
            to_content_hash: null, to_local_id: null,
            to_name: "bar", kind: "calls",
            range_start: 19, range_end: 22,
            range_start_line: 1, range_end_line: 1,
            confidence: 20,
            source: "treesitter",
          },
          {
            from_content_hash: callerHash, edge_id: 1, from_local_id: 0,
            to_content_hash: null, to_local_id: null,
            to_external_id: extId,
            to_name: "bar", kind: "calls",
            range_start: 19, range_end: 22,
            range_start_line: 1, range_end_line: 1,
            confidence: 98,
            source: "scip",
          },
        ],
      });

      led.append({ branch: "main", op: "add", repo_rel_path: "src/util.ts",   before_content_hash: null, after_content_hash: defHash });
      led.append({ branch: "main", op: "add", repo_rel_path: "src/caller.ts", before_content_hash: null, after_content_hash: callerHash });

      const builder = new ViewBuilder();
      builder.buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
        options: { repoRoot: "/fake/repo" },
      });
    } finally {
      led.close();
    }

    // Inspect the view's edges table directly via a read-only handle.
    const db = new Database(viewPath, { readonly: true });
    try {
      const rows = db.prepare(
        `SELECT to_name, source, to_external_id, to_global_id, confidence,
                external_descriptor
         FROM edges
         WHERE to_name = ?
         ORDER BY confidence ASC`,
      ).all("bar");
      assert.equal(rows.length, 2, "should have one tree-sitter and one scip edge to 'bar'");

      const tsEdge = rows.find((r) => r.source === "treesitter");
      const scipEdge = rows.find((r) => r.source === "scip");
      assert.ok(tsEdge, "tree-sitter edge must exist");
      assert.ok(scipEdge, "scip edge must exist");

      // Tree-sitter edge: resolver bound it to the in-repo `bar`.
      assert.ok(tsEdge.to_global_id != null, "resolver should have bound tree-sitter edge to in-repo bar");
      assert.equal(tsEdge.to_external_id, null);

      // SCIP edge: confidence preserved at 98, external pointer intact,
      // global pointer left null (no in-repo binding for an external moniker).
      assert.equal(scipEdge.confidence, 98, "resolver must not rewrite SCIP confidence");
      assert.ok(scipEdge.to_external_id != null, "SCIP edge must still carry external pointer");
      assert.equal(scipEdge.to_global_id, null, "SCIP external moniker must not get rebound to an in-repo symbol");
      assert.equal(scipEdge.external_descriptor, "bar().");
    } finally {
      db.close();
    }
  });
});
