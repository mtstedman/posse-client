import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hashOf(text) {
  return sha256Hex(Buffer.from(text));
}

function symbol(contentHash, localId, name, { source = "treesitter", doc = null } = {}) {
  return {
    content_hash: contentHash,
    local_id: localId,
    kind: "function",
    name,
    qualified_name: name,
    parent_local_id: null,
    repo_rel_path: "src/index.ts",
    lang: "ts",
    range_start: localId * 10,
    range_end: localId * 10 + 8,
    range_start_line: localId + 1,
    range_end_line: localId + 1,
    signature_hash: sha256Hex(`${source}:${name}`),
    signature_text: `function ${name}()`,
    visibility: "public",
    doc,
    source,
  };
}

function edge(contentHash, edgeId, fromLocalId, toLocalId, toName, source = "scip") {
  return {
    from_content_hash: contentHash,
    edge_id: edgeId,
    from_local_id: fromLocalId,
    to_content_hash: contentHash,
    to_local_id: toLocalId,
    to_name: toName,
    to_module: null,
    kind: "calls",
    range_start: 30 + edgeId,
    range_end: 35 + edgeId,
    range_start_line: 3,
    range_end_line: 3,
    confidence: 100,
    source,
  };
}

describe("View.mergeLanguageLayers", () => {
  it("keeps A-only symbols queryable, enriches from B, and skips current watermarks", () => {
    const tmp = makeTmp("atlas-view-merge-layers-");
    try {
      const text = "export function helper() { return helper(); }\n";
      const contentHash = hashOf(text);
      const ledger = Ledger.open({ dbPath: path.join(tmp, "ledger.db") });
      const viewPath = path.join(tmp, "view.db");
      try {
        ledger.ingestBlob({
          content_hash: contentHash,
          lang: "ts",
          byte_size: Buffer.byteLength(text),
          symbols: [
            symbol(contentHash, 0, "helper"),
            symbol(contentHash, 1, "treeOnly"),
          ],
          edges: [],
        });
        ledger.append({
          branch: "main",
          op: "add",
          repo_rel_path: "src/index.ts",
          before_content_hash: null,
          after_content_hash: contentHash,
        });
        new ViewBuilder().buildFrom({
          ledger,
          branch: "main",
          atSeq: ledger.headSeq("main"),
          outPath: viewPath,
          options: { repoRoot: tmp },
        });

        let view = View.mount({ dbPath: viewPath, mode: "readwrite" });
        try {
          const before = view.query.symbolsInFile("src/index.ts").map((row) => row.name).sort();
          assert.deepEqual(before, ["helper", "treeOnly"]);
        } finally {
          view.close();
        }

        ledger.ingestBlobLayer({
          content_hash: contentHash,
          lang: "ts",
          byte_size: Buffer.byteLength(text),
          symbols: [
            symbol(contentHash, 0, "helper", { source: "scip", doc: "compiler helper" }),
            symbol(contentHash, 2, "scipOnly", { source: "scip", doc: "compiler only" }),
          ],
          edges: [edge(contentHash, 0, 0, 2, "scipOnly")],
          source: "scip",
          tool_version: "0.3.0",
          parser_spec_version: "scip-typescript",
          config_hash: "cfg",
          deps_hash: "deps",
          fileset_hash: "files",
        });

        view = View.mount({ dbPath: viewPath, mode: "readwrite" });
        try {
          const merged = view.mergeLanguageLayers({ ledger, lang: "ts" });
          assert.equal(merged.skipped, false);
          assert.equal(merged.status, "enriched");
          assert.deepEqual(merged.sources, ["treesitter", "scip"]);
          const after = view.query.symbolsInFile("src/index.ts");
          assert.deepEqual(after.map((row) => row.name).sort(), ["helper", "scipOnly", "treeOnly"]);
          assert.equal(after.find((row) => row.name === "helper")?.doc, "compiler helper");
          assert.equal(view.query.callees(after.find((row) => row.name === "helper").global_id).length, 1);

          const fingerprinted = view._unsafeDb().prepare(
            "SELECT COUNT(*) AS cnt FROM symbols WHERE merged_fingerprint IS NOT NULL",
          ).get();
          assert.equal(Number(fingerprinted?.cnt || 0), 3);

          const repeat = view.mergeLanguageLayers({ ledger, lang: "ts" });
          assert.equal(repeat.skipped, true);
          assert.equal(repeat.reason, "watermark_current");
        } finally {
          view.close();
        }
      } finally {
        ledger.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
