import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";

// Proves buildFrom produces an IDENTICAL view whether it sources per-blob rows
// from the legacy flat tables (ingestBlob) or from the order-independent layer
// merge (ingestBlobLayer + buildFrom({ layerMerge: true })). This is the
// no-regression gate before retiring the flat write path.

const HASH_A = sha256Hex(Buffer.from("file-a"));
const HASH_B = sha256Hex(Buffer.from("file-b"));

function tmp() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "atlas-equiv-"));
}

function sym(contentHash, localId, name, opts = {}) {
  const { kind = "function", qualified = name, parent = null, repo = "src/x.ts", doc = null } = opts;
  return {
    content_hash: contentHash,
    local_id: localId,
    kind,
    name,
    qualified_name: qualified,
    parent_local_id: parent,
    repo_rel_path: repo,
    lang: "ts",
    range_start: localId * 10,
    range_end: localId * 10 + 8,
    range_start_line: localId + 1,
    range_end_line: localId + 1,
    signature_hash: sha256Hex(`${name}:${localId}`),
    signature_text: `function ${name}()`,
    body_identifiers: null,
    visibility: "public",
    doc,
    source: "treesitter",
  };
}

function crossEdge(fromHash, edgeId, fromLocal, toHash, toName) {
  return {
    from_content_hash: fromHash,
    edge_id: edgeId,
    from_local_id: fromLocal,
    to_content_hash: toHash,
    to_local_id: 0,
    to_name: toName,
    to_module: null,
    to_external_id: null,
    kind: "calls",
    range_start: 200 + edgeId,
    range_end: 205 + edgeId,
    range_start_line: 5,
    range_end_line: 5,
    confidence: 90,
    source: "treesitter",
  };
}

// Fixture: a.ts defines foo; b.ts defines class Bar { baz() } where baz calls
// foo in a.ts (cross-blob edge → exercises buildFrom's resolver), and baz is
// nested under Bar (→ exercises parent backfill).
function blobA() {
  return {
    content_hash: HASH_A,
    lang: "ts",
    byte_size: 50,
    symbols: [sym(HASH_A, 0, "foo", { repo: "src/a.ts" })],
    edges: [],
  };
}
function blobB() {
  return {
    content_hash: HASH_B,
    lang: "ts",
    byte_size: 80,
    symbols: [
      sym(HASH_B, 0, "Bar", { kind: "class", qualified: "Bar", repo: "src/b.ts" }),
      sym(HASH_B, 1, "baz", { kind: "method", qualified: "Bar.baz", parent: 0, repo: "src/b.ts" }),
    ],
    edges: [crossEdge(HASH_B, 0, 1, HASH_A, "foo")],
  };
}

function appendPaths(ledger) {
  ledger.append({ branch: "main", op: "add", repo_rel_path: "src/a.ts", before_content_hash: null, after_content_hash: HASH_A });
  ledger.append({ branch: "main", op: "add", repo_rel_path: "src/b.ts", before_content_hash: null, after_content_hash: HASH_B });
}

// Stable, global_id-independent snapshot of a view: symbols keyed by name with
// parent resolved to the parent's name, and edges resolved to from/to names.
function summarize(viewPath) {
  const view = View.mount({ dbPath: viewPath, mode: "readonly" });
  try {
    const db = view._unsafeDb();
    const syms = db.prepare(
      "SELECT global_id, repo_rel_path, name, kind, qualified_name, parent_global_id, doc FROM symbols",
    ).all();
    const nameByGid = new Map(syms.map((s) => [s.global_id, s.name]));
    const symbols = syms
      .map((s) => ({
        file: s.repo_rel_path,
        name: s.name,
        kind: s.kind,
        qualified_name: s.qualified_name,
        parent: s.parent_global_id != null ? nameByGid.get(s.parent_global_id) ?? "?" : null,
        doc: s.doc,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    const edges = db.prepare(
      "SELECT from_global_id, to_global_id, to_name, kind FROM edges",
    ).all()
      .map((e) => ({
        from: nameByGid.get(e.from_global_id) ?? "?",
        to: e.to_global_id != null ? nameByGid.get(e.to_global_id) ?? "?" : null,
        to_name: e.to_name,
        kind: e.kind,
      }))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    return { symbols, edges };
  } finally {
    view.close();
  }
}

describe("buildFrom layer-merge equivalence (no regression vs flat)", () => {
  it("produces an identical view from layers as from flat tables", () => {
    const dir = tmp();
    try {
      // --- OLD: flat write + flat buildFrom ---
      const flatViewPath = path.join(dir, "flat.view.db");
      const flatLedger = Ledger.open({ dbPath: path.join(dir, "flat.ledger.db") });
      try {
        flatLedger.ingestBlob(blobA());
        flatLedger.ingestBlob(blobB());
        appendPaths(flatLedger);
        new ViewBuilder().buildFrom({
          ledger: flatLedger,
          branch: "main",
          atSeq: flatLedger.headSeq("main"),
          outPath: flatViewPath,
          options: { repoRoot: dir },
        });
      } finally {
        flatLedger.close();
      }

      // --- NEW: layer write + layer-merge buildFrom ---
      const layerViewPath = path.join(dir, "layer.view.db");
      const layerLedger = Ledger.open({ dbPath: path.join(dir, "layer.ledger.db") });
      try {
        layerLedger.ingestBlobLayer({ ...blobA(), source: "treesitter" });
        layerLedger.ingestBlobLayer({ ...blobB(), source: "treesitter" });
        appendPaths(layerLedger);
        new ViewBuilder().buildFrom({
          ledger: layerLedger,
          branch: "main",
          atSeq: layerLedger.headSeq("main"),
          outPath: layerViewPath,
          options: { repoRoot: dir, layerMerge: true },
        });
      } finally {
        layerLedger.close();
      }

      const flat = summarize(flatViewPath);
      const layer = summarize(layerViewPath);

      // Sanity: the fixture actually exercised what we care about.
      assert.deepEqual(flat.symbols.map((s) => s.name).sort(), ["Bar", "baz", "foo"]);
      const bazFlat = flat.symbols.find((s) => s.name === "baz");
      assert.equal(bazFlat.parent, "Bar", "fixture must have nested baz under Bar");
      const crossFlat = flat.edges.find((e) => e.from === "baz");
      assert.ok(crossFlat, "fixture must have a baz→foo edge");
      assert.equal(crossFlat.to, "foo", "cross-blob edge must resolve in the flat build");

      // The gate: layer-built view is byte-for-byte equivalent to flat-built.
      assert.deepEqual(layer.symbols, flat.symbols, "symbols must match flat build");
      assert.deepEqual(layer.edges, flat.edges, "edges (incl. cross-blob resolution) must match flat build");
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
