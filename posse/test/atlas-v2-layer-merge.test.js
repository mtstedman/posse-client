import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { mergeLayerRows } from "../lib/domains/atlas/functions/v2/ledger/layer-merge.js";

function makeTmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atlas-layer-merge-"));
}
function hashOf(text) {
  return sha256Hex(Buffer.from(text));
}

const CH = hashOf("blob-one");
const OTHER = hashOf("blob-two");

function sym(localId, name, opts = {}) {
  const {
    kind = "function", qualified = name, parent = null,
    source = "treesitter", doc = null, sig = null, vis = "public",
  } = opts;
  return {
    content_hash: CH,
    local_id: localId,
    kind,
    name,
    qualified_name: qualified,
    parent_local_id: parent,
    repo_rel_path: "src/index.ts",
    lang: "ts",
    range_start: localId * 10,
    range_end: localId * 10 + 8,
    range_start_line: localId + 1,
    range_end_line: localId + 1,
    signature_hash: sha256Hex(`${source}:${name}:${localId}`),
    signature_text: sig ?? `function ${name}()`,
    body_identifiers: null,
    visibility: vis,
    doc,
    source,
  };
}

function edge(edgeId, fromLocal, { toLocal = null, toHash = CH, toName = null, source = "treesitter" } = {}) {
  return {
    from_content_hash: CH,
    edge_id: edgeId,
    from_local_id: fromLocal,
    to_content_hash: toHash,
    to_local_id: toLocal,
    to_name: toName,
    to_module: null,
    to_external_id: null,
    kind: "calls",
    range_start: 100 + edgeId,
    range_end: 105 + edgeId,
    range_start_line: 3,
    range_end_line: 3,
    confidence: 90,
    source,
  };
}

function withLedger(fn) {
  const tmp = makeTmp();
  const ledger = Ledger.open({ dbPath: path.join(tmp, "ledger.db") });
  try {
    return fn(ledger);
  } finally {
    try { ledger.close(); } catch { /* ignore */ }
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

function ingestLayer(ledger, source, symbols, edges = [], opts = {}) {
  ledger.ingestBlobLayer({
    content_hash: CH,
    lang: "ts",
    byte_size: 100,
    symbols,
    edges,
    source,
    tool_version: source === "scip" ? "0.3.0" : "ts",
    parser_spec_version: source === "scip" ? "scip-typescript" : "treesitter",
    config_hash: "cfg",
    deps_hash: "deps",
    fileset_hash: opts.filesetHash ?? "files",
    indexed_at: opts.indexedAt,
  });
}

function names(symbols) {
  return symbols.map((s) => s.name).sort();
}

describe("mergeLayerRows — fidelity-preserving A+B merge", () => {
  it("does NOT collapse distinct base symbols sharing (kind, qualified_name) — the regression guard", () => {
    withLedger((ledger) => {
      // Two tree-sitter overloads: same kind+qualified_name, distinct local_ids.
      ingestLayer(ledger, "treesitter", [
        sym(0, "overload", { qualified: "overload" }),
        sym(1, "overload", { qualified: "overload" }),
        sym(2, "other"),
      ]);
      const { symbols } = mergeLayerRows(ledger._unsafeDb(), CH, "ts");
      // Old materializeLayeredPath would collapse to 2 (one "overload"). We keep all 3.
      assert.equal(symbols.length, 3, "all three base symbols must survive");
      assert.equal(symbols.filter((s) => s.name === "overload").length, 2);
      // local_ids stay distinct.
      assert.equal(new Set(symbols.map((s) => s.local_id)).size, 3);
    });
  });

  it("threads parent_local_id through the id remap (nesting survives)", () => {
    withLedger((ledger) => {
      ingestLayer(ledger, "treesitter", [
        sym(0, "MyClass", { kind: "class", qualified: "MyClass" }),
        sym(1, "method", { kind: "method", qualified: "MyClass.method", parent: 0 }),
      ]);
      const { symbols } = mergeLayerRows(ledger._unsafeDb(), CH, "ts");
      const cls = symbols.find((s) => s.name === "MyClass");
      const method = symbols.find((s) => s.name === "method");
      assert.equal(method.parent_local_id, cls.local_id, "method parent must point at the class");
    });
  });

  it("enriches a base symbol from the matching SCIP overlay (A first, B enriches)", () => {
    withLedger((ledger) => {
      ingestLayer(ledger, "treesitter", [sym(0, "helper", { doc: null, sig: "function helper()" })]);
      ingestLayer(ledger, "scip", [sym(0, "helper", { source: "scip", doc: "compiler helper", sig: "helper(): void" })]);
      const { symbols, sources } = mergeLayerRows(ledger._unsafeDb(), CH, "ts");
      assert.deepEqual(sources, ["treesitter", "scip"]);
      assert.equal(symbols.length, 1, "matching symbol merges into one");
      assert.equal(symbols[0].doc, "compiler helper", "scip doc applied");
      assert.equal(symbols[0].signature_text, "helper(): void", "scip signature applied");
      assert.equal(symbols[0].source, "treesitter", "merged symbol keeps structural source");
    });
  });

  it("adds SCIP-only symbols that have no base match", () => {
    withLedger((ledger) => {
      ingestLayer(ledger, "treesitter", [sym(0, "treeOnly")]);
      ingestLayer(ledger, "scip", [sym(0, "treeOnly", { source: "scip" }), sym(1, "scipOnly", { source: "scip" })]);
      const { symbols } = mergeLayerRows(ledger._unsafeDb(), CH, "ts");
      assert.deepEqual(names(symbols), ["scipOnly", "treeOnly"]);
      assert.equal(new Set(symbols.map((s) => s.local_id)).size, 2, "added symbol gets a fresh id");
    });
  });

  it("supports A-alone and B-alone (either covers on its own)", () => {
    withLedger((ledger) => {
      ingestLayer(ledger, "treesitter", [sym(0, "a"), sym(1, "b")]);
      assert.deepEqual(names(mergeLayerRows(ledger._unsafeDb(), CH, "ts").symbols), ["a", "b"]);
    });
    withLedger((ledger) => {
      ingestLayer(ledger, "scip", [sym(0, "x", { source: "scip" }), sym(1, "y", { source: "scip" })]);
      const { symbols } = mergeLayerRows(ledger._unsafeDb(), CH, "ts");
      assert.deepEqual(names(symbols), ["x", "y"]);
      assert.equal(symbols.every((s) => s.source === "scip"), true);
    });
  });

  it("is order-independent — same merged shape whether SCIP or tree-sitter lands first", () => {
    const aFirst = withLedger((ledger) => {
      ingestLayer(ledger, "treesitter", [sym(0, "helper"), sym(1, "treeOnly")]);
      ingestLayer(ledger, "scip", [sym(0, "helper", { source: "scip", doc: "d" }), sym(1, "scipOnly", { source: "scip" })]);
      return mergeLayerRows(ledger._unsafeDb(), CH, "ts").symbols;
    });
    const bFirst = withLedger((ledger) => {
      ingestLayer(ledger, "scip", [sym(0, "helper", { source: "scip", doc: "d" }), sym(1, "scipOnly", { source: "scip" })]);
      ingestLayer(ledger, "treesitter", [sym(0, "helper"), sym(1, "treeOnly")]);
      return mergeLayerRows(ledger._unsafeDb(), CH, "ts").symbols;
    });
    const shape = (rows) => rows
      .map((s) => ({ name: s.name, kind: s.kind, qualified_name: s.qualified_name, source: s.source, doc: s.doc }))
      .sort((x, y) => x.name.localeCompare(y.name));
    assert.deepEqual(shape(aFirst), shape(bFirst), "ingest order must not change the merged result");
  });

  it("remaps same-blob edges and preserves cross-blob targets for the resolver", () => {
    withLedger((ledger) => {
      ingestLayer(
        ledger,
        "treesitter",
        [sym(0, "caller"), sym(1, "callee")],
        [
          edge(0, 0, { toLocal: 1, toName: "callee" }),                 // same-blob
          edge(1, 0, { toLocal: null, toHash: OTHER, toName: "Ext" }),  // cross-blob
        ],
      );
      const { symbols, edges } = mergeLayerRows(ledger._unsafeDb(), CH, "ts");
      const caller = symbols.find((s) => s.name === "caller");
      const callee = symbols.find((s) => s.name === "callee");
      const same = edges.find((e) => e.to_content_hash === CH);
      assert.equal(same.from_local_id, caller.local_id);
      assert.equal(same.to_local_id, callee.local_id, "same-blob edge target remapped");
      const cross = edges.find((e) => e.to_content_hash === OTHER);
      assert.ok(cross, "cross-blob edge retained");
      assert.equal(cross.to_name, "Ext", "cross-blob target name kept for buildFrom resolver");
    });
  });

  it("keeps cross-blob edges distinct when only the remote local_id differs", () => {
    withLedger((ledger) => {
      const e1 = edge(0, 0, { toLocal: 4, toHash: OTHER, toName: "Ext" });
      const e2 = edge(1, 0, { toLocal: 7, toHash: OTHER, toName: "Ext" });
      e2.range_start = e1.range_start;
      e2.range_end = e1.range_end;
      e2.range_start_line = e1.range_start_line;
      e2.range_end_line = e1.range_end_line;
      ingestLayer(ledger, "treesitter", [sym(0, "caller")], [e1, e2]);
      const { edges } = mergeLayerRows(ledger._unsafeDb(), CH, "ts");
      const cross = edges.filter((row) => row.to_content_hash === OTHER);
      assert.equal(cross.length, 2, "remote local_id must participate in cross-blob dedup");
      assert.deepEqual(cross.map((row) => row.to_local_id).sort((a, b) => a - b), [4, 7]);
    });
  });

  it("keeps source-distinct edge rows when tree-sitter and SCIP share a range", () => {
    withLedger((ledger) => {
      ingestLayer(
        ledger,
        "treesitter",
        [sym(0, "caller"), sym(1, "callee")],
        [edge(0, 0, { toLocal: 1, toName: "callee", source: "treesitter" })],
      );
      ingestLayer(
        ledger,
        "scip",
        [sym(0, "caller", { source: "scip" }), sym(1, "callee", { source: "scip" })],
        [edge(0, 0, { toLocal: 1, toName: "callee", source: "scip" })],
      );
      const { edges } = mergeLayerRows(ledger._unsafeDb(), CH, "ts");
      assert.deepEqual(edges.map((row) => row.source).sort(), ["scip", "treesitter"]);
    });
  });

  it("prunes stale indexed layer rows when a newer same-source layer lands", () => {
    withLedger((ledger) => {
      ingestLayer(
        ledger,
        "treesitter",
        [sym(0, "oldHelper")],
        [],
        { filesetHash: "files-old", indexedAt: "2026-05-01T00:00:00.000Z" },
      );
      ingestLayer(
        ledger,
        "treesitter",
        [sym(0, "newHelper")],
        [],
        { filesetHash: "files-new", indexedAt: "2026-05-01T00:00:01.000Z" },
      );
      const rows = ledger._unsafeDb().prepare(
        "SELECT fileset_hash, status FROM blob_layers WHERE content_hash = ? AND source = ? ORDER BY id ASC",
      ).all(CH, "treesitter");
      assert.deepEqual(rows, [{ fileset_hash: "files-new", status: "indexed" }]);
      assert.deepEqual(names(mergeLayerRows(ledger._unsafeDb(), CH, "ts").symbols), ["newHelper"]);
    });
  });
});
