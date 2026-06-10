import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { ingestScipFile } from "../lib/domains/atlas/functions/v2/scip/ingester.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { encodeIndex, encodeToolInfo } from "./helpers/scip-encoder.mjs";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function hashOf(text) {
  return sha256Hex(Buffer.from(text));
}

function treeBlob(contentHash, text = "export function helper() { return helper(); }\n") {
  return {
    content_hash: contentHash,
    lang: "ts",
    byte_size: Buffer.byteLength(text),
    symbols: [
      {
        content_hash: contentHash,
        local_id: 0,
        kind: "function",
        name: "helper",
        qualified_name: "helper",
        parent_local_id: null,
        repo_rel_path: "src/index.ts",
        lang: "ts",
        range_start: 0,
        range_end: text.length,
        range_start_line: 1,
        range_end_line: 1,
        signature_hash: sha256Hex("function helper"),
        signature_text: "function helper()",
        visibility: "public",
        doc: null,
        source: "treesitter",
      },
    ],
    edges: [],
  };
}

function scipBlob(contentHash, text = "export function helper() { return helper(); }\n") {
  return {
    content_hash: contentHash,
    lang: "ts",
    byte_size: Buffer.byteLength(text),
    symbols: [
      {
        content_hash: contentHash,
        local_id: 0,
        kind: "function",
        name: "helper",
        qualified_name: "helper",
        parent_local_id: null,
        repo_rel_path: "src/index.ts",
        lang: "ts",
        range_start: 0,
        range_end: text.length,
        range_start_line: 1,
        range_end_line: 1,
        signature_hash: sha256Hex("scip helper"),
        signature_text: "helper()",
        visibility: "public",
        doc: "from scip",
        source: "scip",
      },
    ],
    edges: [
      {
        from_content_hash: contentHash,
        edge_id: 0,
        from_local_id: 0,
        to_content_hash: contentHash,
        to_local_id: 0,
        to_name: "helper",
        to_module: null,
        kind: "calls",
        range_start: 32,
        range_end: 38,
        range_start_line: 1,
        range_end_line: 1,
        confidence: 100,
        source: "scip",
      },
    ],
  };
}

function makeScipIndex(documentText) {
  return encodeIndex({
    metadata: {
      tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0", arguments: ["--cwd", "/repo"] }),
      project_root: "file:///repo",
    },
    documents: [
      {
        language: "TypeScript",
        relative_path: "src/index.ts",
        text: documentText,
        occurrences: [
          { range: [0, 16, 22], enclosing_range: [0, 0, documentText.length], symbol: "scip-typescript npm myrepo 1.0.0 src/`index.ts`/helper().", symbol_roles: 0x1 },
          { range: [0, 32, 38], symbol: "scip-typescript npm myrepo 1.0.0 src/`index.ts`/helper()." },
        ],
        symbols: [
          { symbol: "scip-typescript npm myrepo 1.0.0 src/`index.ts`/helper().", display_name: "helper" },
        ],
      },
    ],
  });
}

describe("Atlas parse layers", () => {
  it("stores tree-sitter and SCIP layers without clobbering each other", () => {
    const tmp = makeTmp("atlas-parse-layers-");
    try {
      const text = "export function helper() { return helper(); }\n";
      const contentHash = hashOf(text);
      const ledger = Ledger.open({ dbPath: path.join(tmp, "ledger.db") });
      try {
        ledger.ingestBlob(treeBlob(contentHash, text));
        const scipLayer = ledger.ingestBlobLayer({
          ...scipBlob(contentHash, text),
          source: "scip",
          tool_version: "0.3.0",
          parser_spec_version: "scip-typescript",
          config_hash: "cfg-a",
          deps_hash: "deps-a",
          fileset_hash: "files-a",
        });

        const layers = ledger.listBlobLayers(contentHash);
        assert.deepEqual(layers.map((layer) => layer.source).sort(), ["scip", "treesitter"]);
        assert.equal(scipLayer.source, "scip");
        const scipRows = ledger.blobLayerRows(scipLayer.layer_id);
        assert.equal(scipRows.symbols.length, 1);
        assert.equal(scipRows.edges.length, 1);
        assert.equal(scipRows.symbols[0].detail.source, "scip");
      } finally {
        ledger.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("lets SCIP ingest after tree-sitter wrote layer A for the same content hash", async () => {
    const tmp = makeTmp("atlas-parse-scip-after-tree-");
    try {
      const text = "export function helper() { return helper(); }\n";
      const contentHash = hashOf(text);
      const ledger = Ledger.open({ dbPath: path.join(tmp, "ledger.db") });
      try {
        ledger.ingestBlob(treeBlob(contentHash, text));
        ledger.append({
          branch: "main",
          op: "add",
          repo_rel_path: "src/index.ts",
          before_content_hash: null,
          after_content_hash: contentHash,
        });

        const result = await ingestScipFile({
          ledger,
          bytes: makeScipIndex(text),
          repoRoot: tmp,
          branch: "main",
          configHash: "cfg-a",
          depsHash: "deps-a",
        });

        assert.equal(result.skipped, false);
        assert.equal(result.blobs_reused, 1);
        const layers = ledger.listBlobLayers(contentHash);
        assert.deepEqual(layers.map((layer) => layer.source).sort(), ["scip", "treesitter"]);
        const scip = layers.find((layer) => layer.source === "scip");
        assert.equal(scip?.config_hash, "cfg-a");
        assert.equal(scip?.deps_hash, "deps-a");
        assert.equal(scip?.fileset_hash, result.fileset_hash);
      } finally {
        ledger.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("keys SCIP freshness by config, deps, and fileset hashes", () => {
    const tmp = makeTmp("atlas-parse-scip-freshness-");
    try {
      const text = "export function helper() { return helper(); }\n";
      const contentHash = hashOf(text);
      const ledger = Ledger.open({ dbPath: path.join(tmp, "ledger.db") });
      try {
        ledger.ingestBlob(treeBlob(contentHash, text));
        const one = ledger.ingestBlobLayer({
          ...scipBlob(contentHash, text),
          source: "scip",
          tool_version: "0.3.0",
          parser_spec_version: "scip-typescript",
          config_hash: "cfg-a",
          deps_hash: "deps-a",
          fileset_hash: "files-a",
        });
        const two = ledger.ingestBlobLayer({
          ...scipBlob(contentHash, text),
          source: "scip",
          tool_version: "0.3.0",
          parser_spec_version: "scip-typescript",
          config_hash: "cfg-b",
          deps_hash: "deps-a",
          fileset_hash: "files-a",
        });
        const three = ledger.ingestBlobLayer({
          ...scipBlob(contentHash, text),
          source: "scip",
          tool_version: "0.3.0",
          parser_spec_version: "scip-typescript",
          config_hash: "cfg-b",
          deps_hash: "deps-b",
          fileset_hash: "files-b",
        });

        // Each distinct freshness key (config/deps/fileset) produces a
        // fresh layer row...
        assert.notEqual(one.layer_id, two.layer_id);
        assert.notEqual(two.layer_id, three.layer_id);
        // ...but a fresh indexed layer supersedes the prior one for the
        // same (content_hash, source): only the latest survives, so views
        // never see stale/duplicate scip symbols for a file. (See the
        // mark-stale + prune pass in BlobStore#writeBlobLayerRecord.)
        const scipLayers = ledger.listBlobLayers(contentHash).filter((layer) => layer.source === "scip");
        assert.equal(scipLayers.length, 1);
        assert.deepEqual(
          scipLayers.map((layer) => [layer.config_hash, layer.deps_hash, layer.fileset_hash]),
          [["cfg-b", "deps-b", "files-b"]],
        );
      } finally {
        ledger.close();
      }
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
