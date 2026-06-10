// @ts-check
//
// End-to-end coverage for the SCIP module: synthesize a tiny `.scip` file,
// run it through Ledger via the ingester, and assert the resulting ledger
// rows have source='scip', external_symbols are populated, and the SCIP
// bookkeeping row was recorded.
//
// Synthesized scenario: src/index.ts defines `helper()`. Two reference
// occurrences point at helper from a SCIP-local symbol (so they bind
// in-blob), plus one reference into `@types/node`'s readFile (external
// moniker, must land on external_symbols).

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { ingestScipFile } from "../lib/domains/atlas/functions/v2/scip/ingester.js";
import { encodeIndex, encodeToolInfo, msgField, strField, tag, varint } from "./helpers/scip-encoder.mjs";
import { decodeScipIndex } from "../lib/domains/atlas/functions/v2/scip/decode.js";
import { buildScipIndexCache } from "../lib/domains/atlas/functions/v2/scip/cache.js";
import { createProtoReader } from "../lib/domains/atlas/functions/v2/scip/proto-reader.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

// SCIP roles bitfield positions (mirrored from scip.proto).
const ROLE_DEFINITION = 0x1;
const ROLE_IMPORT = 0x2;

describe("ATLAS v2 SCIP ingester (synthetic fixture)", () => {
  /** @type {string} */
  let tmp;
  before(() => { tmp = makeTmp("atlas-v2-scip-ing-"); });
  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows */ }
  });

  it("decodes a synthesized .scip and ingests rows with source='scip'", async () => {
    const scipPath = path.join(tmp, "ts.scip");
    const documentText = "export function helper() { return helper(); }\n";
    const indexBuf = encodeIndex({
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
            // Definition of helper at line 0, char 16..22.
            { range: [0, 16, 22], enclosing_range: [0, 0, documentText.length], symbol: "scip-typescript npm myrepo 1.0.0 src/`index.ts`/helper().", symbol_roles: ROLE_DEFINITION },
            // Reference: helper() call on the return line, same range column.
            { range: [0, 32, 38], symbol: "scip-typescript npm myrepo 1.0.0 src/`index.ts`/helper()." },
            // External reference: readFile from @types/node.
            { range: [0, 32, 38], symbol: "scip-typescript npm @types/node 20.0.0 fs/promises.readFile()." },
          ],
          symbols: [
            { symbol: "scip-typescript npm myrepo 1.0.0 src/`index.ts`/helper().", display_name: "helper" },
          ],
        },
      ],
      external_symbols: [
        { symbol: "scip-typescript npm @types/node 20.0.0 fs/promises.readFile().", display_name: "readFile" },
      ],
    });
    fs.writeFileSync(scipPath, indexBuf);

    // Sanity check: round-trip through the decoder.
    const decoded = decodeScipIndex(indexBuf);
    assert.equal(decoded.documents.length, 1);
    assert.equal(decoded.documents[0].occurrences.length, 3);
    assert.equal(decoded.documents[0].relative_path, "src/index.ts");
    assert.equal(decoded.metadata.tool_info.name, "scip-typescript");

    const led = Ledger.open({ dbPath: path.join(tmp, "ledger.db") });
    /** @type {string[]} */
    const events = [];
    try {
      const beforeHead = led.headSeq("main");
      const result = await ingestScipFile({
        ledger: led,
        scipPath,
        repoRoot: tmp,
        branch: "main",
        onEvent: (event) => events.push(event.kind),
      });
      assert.equal(result.skipped, false);
      assert.equal(result.documents_ingested, 1);
      assert.equal(result.ledger_entries_appended, 1);
      assert.ok(result.external_symbols >= 1);
      assert.ok(result.scip_index_id !== null);
      assert.ok(led.headSeq("main") > beforeHead);

      // bookkeeping row is in place
      const list = led.listScipIndexes();
      assert.equal(list.length, 1);
      assert.equal(list[0].scheme, "scip-typescript");
      assert.equal(list[0].indexer_version, "0.3.0");
      assert.equal(led.pathSnapshotAt("main", led.headSeq("main")).get("src/index.ts"), result.covered_content_hashes[0]);

      // every blob_symbols / blob_edges row carries source='scip'
      const db = led._unsafeDb();
      const symRows = /** @type {any[]} */ (db.prepare(
        `SELECT ks.value AS kind, ns.value AS name, bs.source
           FROM blob_symbols bs
           JOIN interned_strings ks ON ks.id = bs.kind_id
           JOIN interned_strings ns ON ns.id = bs.name_id
          WHERE bs.content_hash = ?`,
      ).all(result.covered_content_hashes[0]));
      assert.ok(symRows.length > 0);
      for (const r of symRows) assert.equal(r.source, "scip");
      assert.ok(symRows.some((r) => r.name === "helper" && r.kind === "function"));

      const edgeRows = /** @type {any[]} */ (db.prepare(
        "SELECT source, to_external_id FROM blob_edges WHERE from_content_hash = ?",
      ).all(result.covered_content_hashes[0]));
      assert.ok(edgeRows.length >= 2);
      for (const r of edgeRows) assert.equal(r.source, "scip");
      assert.ok(edgeRows.some((r) => r.to_external_id != null), "at least one external edge must be present");

      // external_symbols table got the @types/node moniker
      const ext = /** @type {any[]} */ (db.prepare(
        "SELECT scheme, manager, package_name, package_version, descriptor FROM external_symbols WHERE package_name = ?",
      ).all("@types/node"));
      assert.equal(ext.length, 1);
      assert.equal(ext[0].scheme, "scip-typescript");
      assert.equal(ext[0].manager, "npm");
      assert.equal(ext[0].package_version, "20.0.0");
    } finally {
      led.close();
    }

    assert.ok(events.includes("atlas.scip.ingest.started"));
    assert.ok(events.includes("atlas.scip.ingest.completed"));
  });

  it("does not mint import-role occurrences as phantom definitions", async () => {
    const projectDir = makeTmp("atlas-v2-scip-import-def-");
    try {
      const fooSymbol = "scip-typescript npm myrepo 1.0.0 src/`foo.ts`/Foo#";
      const fooText = "export class Foo {}\n";
      const barText = "import { Foo } from './foo';\nnew Foo();\n";
      const indexBuf = encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: "file:///repo",
        },
        documents: [
          {
            language: "TypeScript",
            relative_path: "src/foo.ts",
            text: fooText,
            occurrences: [
              { range: [0, 13, 16], enclosing_range: [0, 0, fooText.length], symbol: fooSymbol, symbol_roles: ROLE_DEFINITION },
            ],
            symbols: [
              { symbol: fooSymbol, display_name: "Foo" },
            ],
          },
          {
            language: "TypeScript",
            relative_path: "src/bar.ts",
            text: barText,
            occurrences: [
              { range: [0, 9, 12], symbol: fooSymbol, symbol_roles: ROLE_DEFINITION | ROLE_IMPORT },
              { range: [1, 4, 7], symbol: fooSymbol },
            ],
          },
        ],
      });

      const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
      try {
        const result = await ingestScipFile({
          ledger: led,
          bytes: indexBuf,
          repoRoot: projectDir,
          branch: "main",
        });
        assert.equal(result.skipped, false);
        assert.equal(result.documents_ingested, 2);
        const snapshot = led.pathSnapshotAt("main", led.headSeq("main"));
        const fooHash = snapshot.get("src/foo.ts");
        const barHash = snapshot.get("src/bar.ts");
        assert.equal(fooHash, sha256Hex(Buffer.from(fooText)));
        assert.equal(barHash, sha256Hex(Buffer.from(barText)));

        const db = led._unsafeDb();
        const barSymbols = /** @type {any[]} */ (db.prepare(
          `SELECT ns.value AS name
             FROM blob_symbols bs
             JOIN interned_strings ns ON ns.id = bs.name_id
            WHERE bs.content_hash = ?`,
        ).all(barHash));
        assert.equal(barSymbols.some((row) => row.name === "Foo"), false);

        const fooSymbols = /** @type {any[]} */ (db.prepare(
          `SELECT bs.local_id, ns.value AS name
             FROM blob_symbols bs
             JOIN interned_strings ns ON ns.id = bs.name_id
            WHERE bs.content_hash = ?`,
        ).all(fooHash));
        assert.deepEqual(fooSymbols.map((row) => [row.local_id, row.name]), [[0, "Foo"]]);

        const barEdges = /** @type {any[]} */ (db.prepare(
          `SELECT to_content_hash, to_local_id, to_external_id
             FROM blob_edges
            WHERE from_content_hash = ?
            ORDER BY edge_id ASC`,
        ).all(barHash));
        assert.equal(barEdges.length, 2);
        for (const edgeRow of barEdges) {
          assert.equal(edgeRow.to_content_hash, fooHash);
          assert.equal(edgeRow.to_local_id, 0);
          assert.equal(edgeRow.to_external_id, null);
        }
        const externalCount = /** @type {{ n: number }} */ (
          db.prepare("SELECT COUNT(*) AS n FROM external_symbols").get()
        ).n;
        assert.equal(externalCount, 0);
      } finally {
        led.close();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("marks a malformed document decode as a document skip instead of aborting the whole index", () => {
    const badOccurrence = [
      ...tag(1, 2),
      ...varint(1),
      0x80,
    ];
    const badDocument = [
      ...strField(1, "src/bad.ts"),
      ...msgField(2, badOccurrence),
      ...strField(4, "TypeScript"),
    ];
    const goodDocument = [
      ...strField(1, "src/good.ts"),
      ...strField(4, "TypeScript"),
      ...strField(5, "export const ok = true;\n"),
    ];
    const indexBuf = Buffer.from([
      ...msgField(1, [
        ...msgField(2, encodeToolInfo({ name: "scip-typescript", version: "0.3.0" })),
        ...strField(3, "file:///repo"),
      ]),
      ...msgField(2, badDocument),
      ...msgField(2, goodDocument),
    ]);

    const decoded = decodeScipIndex(indexBuf);
    assert.equal(decoded.documents.length, 2);
    assert.equal(decoded.documents[0].relative_path, "src/bad.ts");
    assert.equal(decoded.documents[0].atlas_skip_reason, "scip_decode_error");
    assert.match(decoded.documents[0].atlas_skip_message || "", /varint/);
    assert.equal(decoded.documents[1].relative_path, "src/good.ts");
  });

  it("skips corrupt SCIP metadata and external symbol payloads without losing documents", () => {
    const badMetadata = [
      ...tag(3, 2),
      ...varint(50),
      0x41,
    ];
    const goodDocument = [
      ...strField(1, "src/good.ts"),
      ...strField(4, "TypeScript"),
      ...strField(5, "export const ok = true;\n"),
    ];
    const badExternalSymbol = [
      ...strField(1, "scip-typescript npm bad 1.0.0 bad()."),
      ...tag(3, 2),
      ...varint(50),
      0x41,
    ];
    const goodExternalSymbol = [
      ...strField(1, "scip-typescript npm good 1.0.0 good()."),
      ...strField(6, "good"),
    ];
    const indexBuf = Buffer.from([
      ...msgField(1, badMetadata),
      ...msgField(2, goodDocument),
      ...msgField(3, badExternalSymbol),
      ...msgField(3, goodExternalSymbol),
    ]);

    const decoded = decodeScipIndex(indexBuf);
    assert.equal(decoded.metadata.tool_info.name, "");
    assert.equal(decoded.documents.length, 1);
    assert.equal(decoded.documents[0].relative_path, "src/good.ts");
    assert.equal(decoded.external_symbols.length, 1);
    assert.equal(decoded.external_symbols[0].display_name, "good");
  });

  it("rejects an eleventh protobuf varint byte while accepting the ten-byte uint64 boundary", () => {
    assert.equal(createProtoReader(Buffer.from([0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0xff, 0x01])).readUInt64(), (1n << 64n) - 1n);
    assert.throws(
      () => createProtoReader(Buffer.from([0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x80, 0x00])).readUInt64(),
      /varint too long/,
    );
  });

  it("preserves leading documents when a trailing SCIP document frame overflows", async () => {
    const projectDir = makeTmp("atlas-v2-scip-bad-frame-");
    try {
      const goodDocument = [
        ...strField(1, "src/good.ts"),
        ...strField(4, "TypeScript"),
        ...strField(5, "export const ok = true;\n"),
      ];
      const indexBuf = Buffer.from([
        ...msgField(1, [
          ...msgField(2, encodeToolInfo({ name: "scip-typescript", version: "0.3.0" })),
          ...strField(3, "file:///repo"),
        ]),
        ...msgField(2, goodDocument),
        ...tag(2, 2),
        ...varint(100),
        ...strField(1, "src/bad.ts"),
      ]);
      const decoded = decodeScipIndex(indexBuf);
      assert.equal(decoded.documents.length, 1);
      assert.equal(decoded.documents[0].relative_path, "src/good.ts");

      const events = [];
      const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
      try {
        const result = await ingestScipFile({
          ledger: led,
          bytes: indexBuf,
          repoRoot: projectDir,
          branch: "main",
          onEvent: (event) => events.push(event),
        });

        assert.equal(result.skipped, false);
        assert.equal(result.status, "complete");
        assert.equal(result.documents_failed, 0);
        assert.equal(result.documents_ingested, 1);
        assert.ok(result.scip_index_id !== null);
        assert.equal(led.listScipIndexes().length, 1);
      } finally {
        led.close();
      }

      assert.equal(events.some((event) => event.kind === "atlas.scip.ingest.completed"), true);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("hydrates and ingests empty source files from disk", async () => {
    const projectDir = makeTmp("atlas-v2-scip-empty-file-");
    try {
      fs.mkdirSync(path.join(projectDir, "src", "seed", "profiles"), { recursive: true });
      const emptyRel = "src/seed/profiles/__init__.py";
      const emptyAbs = path.join(projectDir, ...emptyRel.split("/"));
      fs.writeFileSync(emptyAbs, "");
      const scipPath = path.join(projectDir, "python.scip");
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-python", version: "0.6.6", arguments: [] }),
          project_root: pathToFileURL(projectDir).href,
        },
        documents: [{
          language: "Python",
          relative_path: emptyRel,
          occurrences: [],
          symbols: [],
        }],
      }));

      const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
      try {
        const emptyHash = sha256Hex(Buffer.alloc(0));
        const result = await ingestScipFile({ ledger: led, scipPath, repoRoot: projectDir, branch: "main" });

        assert.equal(result.documents_ingested, 1);
        assert.equal(result.documents_failed, 0);
        assert.deepEqual(result.covered_content_hashes, [emptyHash]);
        assert.equal(led.hasBlob(emptyHash), true);
        assert.equal(led.pathSnapshotAt("main", led.headSeq("main")).get(emptyRel), emptyHash);
        const [index] = led.listScipIndexes();
        assert.equal(index.status, "complete");
        assert.equal(index.documents_failed, 0);
      } finally {
        led.close();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("anchors top-level SCIP references to a synthetic file symbol", async () => {
    const projectDir = makeTmp("atlas-v2-scip-file-scope-");
    try {
      const scipPath = path.join(projectDir, "php.scip");
      const text = "<?php header('Content-Type: application/json');\n";
      fs.writeFileSync(path.join(projectDir, "index.php"), text);
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-php", version: "0.0.1", arguments: [] }),
          project_root: pathToFileURL(projectDir).href,
        },
        documents: [{
          language: "PHP",
          relative_path: "index.php",
          text,
          occurrences: [
            { range: [0, 6, 12], symbol: "scip-php composer php 8.5.6 header()." },
          ],
          symbols: [],
        }],
        external_symbols: [
          { symbol: "scip-php composer php 8.5.6 header().", display_name: "header" },
        ],
      }));

      const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
      try {
        const result = await ingestScipFile({ ledger: led, scipPath, repoRoot: projectDir, branch: "main" });

        assert.equal(result.documents_ingested, 1);
        assert.equal(result.documents_failed, 0);
        assert.equal(result.external_symbols, 1);
        const db = led._unsafeDb();
        const moduleSymbol = db.prepare(
          "SELECT s.value AS name, q.value AS qualified_name FROM blob_symbols bs JOIN interned_strings s ON s.id = bs.name_id JOIN interned_strings q ON q.id = bs.qualified_name_id WHERE bs.content_hash = ? AND bs.local_id = 0",
        ).get(result.covered_content_hashes[0]);
        assert.deepEqual(moduleSymbol, { name: "index.php", qualified_name: "index.php" });
        const edge = db.prepare(
          "SELECT from_local_id, to_external_id, source FROM blob_edges WHERE from_content_hash = ?",
        ).get(result.covered_content_hashes[0]);
        assert.equal(edge.from_local_id, 0);
        assert.ok(edge.to_external_id != null);
        assert.equal(edge.source, "scip");
      } finally {
        led.close();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("suppresses unresolved document-local SCIP references", async () => {
    const projectDir = makeTmp("atlas-v2-scip-local-suppress-");
    try {
      const scipPath = path.join(projectDir, "ts.scip");
      const text = "export function render() { return value; }\n";
      const functionSymbol = "scip-typescript npm myrepo 1.0.0 src/`component.tsx`/render().";
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0", arguments: [] }),
          project_root: pathToFileURL(projectDir).href,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/component.tsx",
          text,
          occurrences: [
            { range: [0, 16, 22], enclosing_range: [0, 0, text.length], symbol: functionSymbol, symbol_roles: ROLE_DEFINITION },
            { range: [0, 33, 38], symbol: "local 0" },
          ],
          symbols: [{ symbol: functionSymbol, display_name: "render" }],
        }],
      }));

      const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
      try {
        const result = await ingestScipFile({ ledger: led, scipPath, repoRoot: projectDir, branch: "main" });
        assert.equal(result.documents_ingested, 1);
        assert.equal(result.documents_failed, 0);

        const db = led._unsafeDb();
        const localEdges = db.prepare(
          `SELECT e.edge_id
             FROM blob_edges e
             JOIN interned_strings s ON s.id = e.to_name_id
            WHERE e.from_content_hash = ? AND s.value LIKE 'local-%'`,
        ).all(result.covered_content_hashes[0]);
        assert.equal(localEdges.length, 0);

        const symbols = db.prepare(
          `SELECT s.value AS name
             FROM blob_symbols bs
             JOIN interned_strings s ON s.id = bs.name_id
            WHERE bs.content_hash = ?
            ORDER BY bs.local_id`,
        ).all(result.covered_content_hashes[0]);
        assert.deepEqual(symbols.map((row) => row.name), ["render"]);
      } finally {
        led.close();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("does not report TypeScript when a SCIP document omits language", async () => {
    const projectDir = makeTmp("atlas-v2-scip-empty-lang-");
    try {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      const phpText = "<?php echo 'ok';\n";
      const missingLangText = "<?php echo 'still php';\n";
      fs.writeFileSync(path.join(projectDir, "src", "good.php"), phpText);
      fs.writeFileSync(path.join(projectDir, "src", "missing.php"), missingLangText);
      const scipPath = path.join(projectDir, "langs.scip");
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-php", version: "0.0.1", arguments: [] }),
          project_root: pathToFileURL(projectDir).href,
        },
        documents: [
          {
            language: "PHP",
            relative_path: "src/good.php",
            text: phpText,
            occurrences: [],
            symbols: [],
          },
          {
            language: "",
            relative_path: "src/missing.php",
            text: missingLangText,
            occurrences: [],
            symbols: [],
          },
        ],
      }));

      const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
      try {
        const result = await ingestScipFile({ ledger: led, scipPath, repoRoot: projectDir, branch: "main" });
        assert.equal(result.documents_ingested, 2);
        assert.equal(result.documents_failed, 0);
        const indexes = led.listScipIndexes();
        assert.equal(indexes.length, 1);
        assert.equal(indexes[0].langs, "php");
      } finally {
        led.close();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("routes scip-typescript ingest progress by JS and TS source paths", async () => {
    const projectDir = makeTmp("atlas-v2-scip-js-ts-langs-");
    try {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      const jsText = "export const jsValue = 1;\n";
      const tsText = "export const tsValue: number = 1;\n";
      fs.writeFileSync(path.join(projectDir, "src", "plain.js"), jsText);
      fs.writeFileSync(path.join(projectDir, "src", "typed.ts"), tsText);
      const scipPath = path.join(projectDir, "mixed.scip");
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.0.1", arguments: [] }),
          project_root: pathToFileURL(projectDir).href,
        },
        documents: [
          {
            language: "TypeScript",
            relative_path: "src/plain.js",
            text: jsText,
            occurrences: [],
            symbols: [],
          },
          {
            language: "TypeScript",
            relative_path: "src/typed.ts",
            text: tsText,
            occurrences: [],
            symbols: [],
          },
        ],
      }));

      const events = [];
      const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
      try {
        const result = await ingestScipFile({
          ledger: led,
          scipPath,
          repoRoot: projectDir,
          branch: "main",
          onEvent: (event) => events.push(event),
        });
        assert.equal(result.documents_ingested, 2);
        const started = events.find((event) => event.kind === "atlas.scip.ingest.started");
        assert.deepEqual(started?.source_languages, ["ts", "js"]);
        assert.deepEqual(started?.source_language_current, { ts: 0, js: 0 });
        assert.deepEqual(started?.source_language_total, { ts: 1, js: 1 });
        const completed = events.find((event) => event.kind === "atlas.scip.ingest.completed");
        assert.deepEqual(completed?.source_language_current, { ts: 1, js: 1 });
        assert.deepEqual(completed?.source_language_total, { ts: 1, js: 1 });
        const rows = led._unsafeDb().prepare(
          `SELECT p.path, b.lang
             FROM symbol_deltas d
             JOIN interned_paths p ON p.id = d.path_id
             JOIN blobs b ON b.content_hash = d.after_content_hash
            ORDER BY p.path`,
        ).all();
        assert.deepEqual(rows, [
          { path: "src/plain.js", lang: "js" },
          { path: "src/typed.ts", lang: "ts" },
        ]);
        assert.equal(led.listScipIndexes()[0].langs, "ts,js");
      } finally {
        led.close();
      }
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("short-circuits on a re-ingest with matching identity (skipped: true)", async () => {
    const scipPath = path.join(tmp, "ts-rerun.scip");
    const indexBuf = encodeIndex({
      metadata: {
        tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
        project_root: "/repo",
      },
      documents: [
        {
          language: "TypeScript",
          relative_path: "src/a.ts",
          text: "const a = 1;\n",
          occurrences: [
            { range: [0, 6, 7], symbol: "scip-typescript npm pkg 1.0.0 src/`a.ts`/a.", symbol_roles: ROLE_DEFINITION },
          ],
          symbols: [{ symbol: "scip-typescript npm pkg 1.0.0 src/`a.ts`/a.", display_name: "a" }],
        },
      ],
    });
    fs.writeFileSync(scipPath, indexBuf);
    const led = Ledger.open({ dbPath: path.join(tmp, "ledger-rerun.db") });
    try {
      const first = await ingestScipFile({ ledger: led, scipPath, repoRoot: tmp, branch: "main" });
      assert.equal(first.skipped, false);
      const second = await ingestScipFile({ ledger: led, scipPath, repoRoot: tmp, branch: "main" });
      assert.equal(second.skipped, true);
      assert.equal(second.ledger_entries_appended, 0);
    } finally {
      led.close();
    }
  });

  it("infers scheme from document symbols when ToolInfo.name is absent", async () => {
    const scipPath = path.join(tmp, "ts-missing-tool-info.scip");
    const symbol = "scip-typescript npm pkg 1.0.0 src/`missing-tool.ts`/value.";
    fs.writeFileSync(scipPath, encodeIndex({
      metadata: {
        tool_info: encodeToolInfo({ name: "", version: "" }),
        project_root: "/repo",
      },
      documents: [
        {
          language: "TypeScript",
          relative_path: "src/missing-tool.ts",
          text: "export const value = 1;\n",
          occurrences: [
            { range: [0, 13, 18], symbol, symbol_roles: ROLE_DEFINITION },
          ],
          symbols: [{ symbol, display_name: "value" }],
        },
      ],
    }));

    const led = Ledger.open({ dbPath: path.join(tmp, "ledger-missing-tool-info.db") });
    const events = [];
    try {
      const result = await ingestScipFile({
        ledger: led,
        scipPath,
        repoRoot: tmp,
        branch: "main",
        onEvent: (event) => events.push(event),
      });
      assert.equal(result.scheme, "scip-typescript");
      assert.equal(result.documents_ingested, 1);
      const rows = led.listScipIndexes();
      assert.equal(rows[0].scheme, "scip-typescript");
      assert.equal(rows[0].indexer_version, "unknown");
      assert.ok(events.some((event) => event.kind === "atlas.scip.ingest.warning" && event.reason === "missing_tool_name"));
      assert.ok(events.some((event) => event.kind === "atlas.scip.ingest.warning" && event.reason === "missing_tool_version"));
    } finally {
      led.close();
    }
  });

  it("hydrates missing Document.text from the repo filesystem", async () => {
    const projectDir = makeTmp("atlas-v2-scip-fs-");
    try {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      const source = "export const diskValue = 3;\n";
      fs.writeFileSync(path.join(projectDir, "src", "disk.ts"), source);
      const scipPath = path.join(projectDir, "disk.scip");
      const symbol = "scip-typescript npm pkg 1.0.0 src/`disk.ts`/diskValue.";
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: projectDir,
        },
        documents: [
          {
            language: "TypeScript",
            relative_path: "src/disk.ts",
            occurrences: [
              { range: [0, 13, 22], symbol, symbol_roles: ROLE_DEFINITION },
            ],
            symbols: [{ symbol, display_name: "diskValue" }],
          },
        ],
      }));

      const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
      try {
        const result = await ingestScipFile({ ledger: led, scipPath, repoRoot: projectDir, branch: "main" });
        assert.equal(result.documents_ingested, 1);
        assert.equal(result.ledger_entries_appended, 1);
        assert.equal(result.covered_content_hashes[0], sha256Hex(Buffer.from(source, "utf8")));
      } finally {
        led.close();
      }
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* windows */ }
    }
  });

  it("binds cross-file in-repo SCIP references to the target blob symbol", async () => {
    const scipPath = path.join(tmp, "ts-cross-file.scip");
    const helperSymbol = "scip-typescript npm pkg 1.0.0 src/`helper.ts`/helper().";
    const callerSymbol = "scip-typescript npm pkg 1.0.0 src/`caller.ts`/caller().";
    fs.writeFileSync(scipPath, encodeIndex({
      metadata: {
        tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
        project_root: "/repo",
      },
      documents: [
        {
          language: "TypeScript",
          relative_path: "src/helper.ts",
          text: "export function helper() { return 1; }\n",
          occurrences: [
            { range: [0, 16, 22], enclosing_range: [0, 0, 38], symbol: helperSymbol, symbol_roles: ROLE_DEFINITION },
          ],
          symbols: [{ symbol: helperSymbol, display_name: "helper" }],
        },
        {
          language: "TypeScript",
          relative_path: "src/caller.ts",
          text: "export function caller() { return helper(); }\n",
          occurrences: [
            { range: [0, 16, 22], enclosing_range: [0, 0, 42], symbol: callerSymbol, symbol_roles: ROLE_DEFINITION },
            { range: [0, 34, 40], symbol: helperSymbol },
          ],
          symbols: [{ symbol: callerSymbol, display_name: "caller" }],
        },
      ],
    }));

    const led = Ledger.open({ dbPath: path.join(tmp, "ledger-cross-file.db") });
    try {
      const result = await ingestScipFile({ ledger: led, scipPath, repoRoot: tmp, branch: "main" });
      assert.equal(result.documents_ingested, 2);
      const db = led._unsafeDb();
      const edge = db.prepare(
        `SELECT be.to_content_hash, be.to_local_id, be.to_external_id
         FROM blob_edges be
         JOIN interned_strings s ON s.id = be.to_name_id
         WHERE s.value = 'helper'`,
      ).get();
      const helperHash = sha256Hex(Buffer.from("export function helper() { return 1; }\n", "utf8"));
      assert.equal(edge.to_content_hash, helperHash);
      assert.equal(edge.to_local_id, 0);
      assert.equal(edge.to_external_id, null);
    } finally {
      led.close();
    }
  });

  it("appends SCIP paths to an explicitly supplied non-main branch", async () => {
    const scipPath = path.join(tmp, "ts-master.scip");
    const source = "export const onMaster = 1;\n";
    const symbol = "scip-typescript npm pkg 1.0.0 src/`master.ts`/onMaster.";
    fs.writeFileSync(scipPath, encodeIndex({
      metadata: {
        tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
        project_root: "/repo",
      },
      documents: [{
        language: "TypeScript",
        relative_path: "src/master.ts",
        text: source,
        occurrences: [{ range: [0, 13, 21], symbol, symbol_roles: ROLE_DEFINITION }],
        symbols: [{ symbol, display_name: "onMaster" }],
      }],
    }));

    const led = Ledger.open({ dbPath: path.join(tmp, "ledger-master.db") });
    try {
      led.ensureRootBranch("master");
      const result = await ingestScipFile({ ledger: led, scipPath, repoRoot: tmp, branch: "master" });
      assert.equal(result.documents_ingested, 1);
      assert.equal(result.ledger_entries_appended, 1);
      assert.equal(led.headSeq("main"), 0);
      assert.equal(led.pathSnapshotAt("master", led.headSeq("master")).get("src/master.ts"), result.covered_content_hashes[0]);
    } finally {
      led.close();
    }
  });

  it("canonicalizes absolute SCIP document paths under project_root", async () => {
    const projectDir = makeTmp("atlas-v2-scip-abs-");
    try {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      const source = "export const absValue = 1;\n";
      const absPath = path.join(projectDir, "src", "abs.ts");
      fs.writeFileSync(absPath, source);
      const scipPath = path.join(projectDir, "abs.scip");
      const symbol = "scip-typescript npm pkg 1.0.0 src/`abs.ts`/absValue.";
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: projectDir,
        },
        documents: [{
          language: "TypeScript",
          relative_path: absPath,
          occurrences: [{ range: [0, 13, 21], symbol, symbol_roles: ROLE_DEFINITION }],
          symbols: [{ symbol, display_name: "absValue" }],
        }],
      }));

      const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
      try {
        const result = await ingestScipFile({ ledger: led, scipPath, repoRoot: projectDir, branch: "main" });
        assert.equal(result.documents_ingested, 1);
        assert.equal(result.documents_failed, 0);
        assert.equal(led.pathSnapshotAt("main", led.headSeq("main")).get("src/abs.ts"), sha256Hex(Buffer.from(source, "utf8")));
      } finally {
        led.close();
      }
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* windows */ }
    }
  });

  it("surfaces reused-blob append failures as per-document failures", async () => {
    const scipPath = path.join(tmp, "ts-reused-append-failure.scip");
    const source = "export const reused = 1;\n";
    const hash = sha256Hex(Buffer.from(source, "utf8"));
    const symbol = "scip-typescript npm pkg 1.0.0 src/`reused.ts`/reused.";
    fs.writeFileSync(scipPath, encodeIndex({
      metadata: {
        tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
        project_root: "/repo",
      },
      documents: [{
        language: "TypeScript",
        relative_path: "src/reused.ts",
        text: source,
        occurrences: [{ range: [0, 13, 19], symbol, symbol_roles: ROLE_DEFINITION }],
        symbols: [{ symbol, display_name: "reused" }],
      }],
    }));

    const led = Ledger.open({ dbPath: path.join(tmp, "ledger-reused-append-failure.db") });
    try {
      led.ingestBlob({
        content_hash: hash,
        lang: "ts",
        byte_size: source.length,
        symbols: [{
          content_hash: hash,
          local_id: 0,
          kind: "const",
          name: "reused",
          qualified_name: "reused",
          parent_local_id: null,
          repo_rel_path: "src/reused.ts",
          lang: "ts",
          range_start: 13,
          range_end: 19,
          range_start_line: 1,
          range_end_line: 1,
          signature_hash: sha256Hex("reused"),
          visibility: "public",
          doc: null,
        }],
        edges: [],
      });
      const result = await ingestScipFile({ ledger: led, scipPath, repoRoot: tmp, branch: "missing-branch" });
      assert.equal(result.documents_ingested, 0);
      assert.equal(result.documents_failed, 1);
      assert.equal(result.status, "partial");
    } finally {
      led.close();
    }
  });

  it("updates a partial bookkeeping row to complete after a successful retry", async () => {
    const scipPath = path.join(tmp, "ts-partial-retry.scip");
    const source = "export const retry = 1;\n";
    const symbol = "scip-typescript npm pkg 1.0.0 src/`retry.ts`/retry.";
    fs.writeFileSync(scipPath, encodeIndex({
      metadata: {
        tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
        project_root: "/repo",
      },
      documents: [{
        language: "TypeScript",
        relative_path: "src/retry.ts",
        text: source,
        occurrences: [{ range: [0, 13, 18], symbol, symbol_roles: ROLE_DEFINITION }],
        symbols: [{ symbol, display_name: "retry" }],
      }],
    }));

    const led = Ledger.open({ dbPath: path.join(tmp, "ledger-partial-retry.db") });
    try {
      const first = await ingestScipFile({ ledger: led, scipPath, repoRoot: tmp, branch: "missing-branch" });
      assert.equal(first.status, "partial");
      assert.equal(first.documents_failed, 1);
      const partialRows = led.listScipIndexes();
      assert.equal(partialRows.length, 1);
      assert.equal(partialRows[0].status, "partial");

      const second = await ingestScipFile({ ledger: led, scipPath, repoRoot: tmp, branch: "main", force: true });
      assert.equal(second.skipped, false);
      assert.equal(second.status, "complete");
      assert.equal(second.documents_failed, 0);
      assert.equal(second.scip_index_id, partialRows[0].id);

      const completeRows = led.listScipIndexes();
      assert.equal(completeRows.length, 1);
      assert.equal(completeRows[0].id, partialRows[0].id);
      assert.equal(completeRows[0].status, "complete");
      assert.equal(completeRows[0].documents_failed, 0);
    } finally {
      led.close();
    }
  });

  it("records partial SCIP bookkeeping and short-circuits stable matching failures", async () => {
    const scipPath = path.join(tmp, "ts-partial.scip");
    fs.writeFileSync(scipPath, encodeIndex({
      metadata: {
        tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
        project_root: "/repo",
      },
      documents: [
        {
          language: "TypeScript",
          relative_path: "src/good.ts",
          text: "export const good = 1;\n",
          occurrences: [{ range: [0, 13, 17], symbol: "scip-typescript npm pkg 1.0.0 src/`good.ts`/good.", symbol_roles: ROLE_DEFINITION }],
          symbols: [{ symbol: "scip-typescript npm pkg 1.0.0 src/`good.ts`/good.", display_name: "good" }],
        },
        {
          language: "TypeScript",
          relative_path: "../bad.ts",
          text: "export const bad = 1;\n",
          occurrences: [{ range: [0, 13, 16], symbol: "scip-typescript npm pkg 1.0.0 src/`bad.ts`/bad.", symbol_roles: ROLE_DEFINITION }],
          symbols: [{ symbol: "scip-typescript npm pkg 1.0.0 src/`bad.ts`/bad.", display_name: "bad" }],
        },
      ],
    }));

    const led = Ledger.open({ dbPath: path.join(tmp, "ledger-partial.db") });
    try {
      const first = await ingestScipFile({ ledger: led, scipPath, repoRoot: tmp, branch: "main" });
      assert.equal(first.skipped, false);
      assert.equal(first.documents_ingested, 1);
      assert.equal(first.documents_failed, 1);
      assert.equal(first.status, "partial");
      const rows = led.listScipIndexes();
      assert.equal(rows.length, 1);
      assert.equal(rows[0].status, "partial");
      assert.equal(rows[0].documents_failed, 1);

      const second = await ingestScipFile({ ledger: led, scipPath, repoRoot: tmp, branch: "main" });
      assert.equal(second.skipped, true);
      assert.equal(second.documents_failed, 0);
      assert.equal(second.scip_index_id, rows[0].id);
    } finally {
      led.close();
    }
  });

  it("skips embedded SCIP text that no longer matches on-disk bytes", async () => {
    const projectDir = makeTmp("atlas-v2-scip-stale-");
    try {
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "stale.ts"), "export const stale = 2;\n");
      const scipPath = path.join(projectDir, "stale.scip");
      const symbol = "scip-typescript npm pkg 1.0.0 src/`stale.ts`/stale.";
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: projectDir,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/stale.ts",
          text: "export const stale = 1;\n",
          occurrences: [{ range: [0, 13, 18], symbol, symbol_roles: ROLE_DEFINITION }],
          symbols: [{ symbol, display_name: "stale" }],
        }],
      }));

      const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
      const events = [];
      try {
        const result = await ingestScipFile({
          ledger: led,
          scipPath,
          repoRoot: projectDir,
          branch: "main",
          onEvent: (event) => events.push(event),
        });
        assert.equal(result.documents_ingested, 0);
        assert.equal(result.documents_failed, 1);
        assert.equal(result.ledger_entries_appended, 0);
        assert.ok(events.some((event) => event.kind === "atlas.scip.ingest.failed" && event.reason === "text_mismatch"));
      } finally {
        led.close();
      }
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* windows */ }
    }
  });

  it("treats minified SCIP documents as skipped instead of failed", async () => {
    const projectDir = makeTmp("atlas-v2-scip-minified-");
    try {
      fs.mkdirSync(path.join(projectDir, "dist"), { recursive: true });
      const repoRelPath = "dist/app.bundle.js";
      const bundledText = `function a(){return 1};${"x=1;".repeat(400)}\n`;
      fs.writeFileSync(path.join(projectDir, repoRelPath), bundledText);
      const scipPath = path.join(projectDir, "ts.scip");
      const symbol = "scip-typescript npm pkg 1.0.0 dist/`app.bundle.js`/a().";
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: projectDir,
        },
        documents: [{
          language: "JavaScript",
          relative_path: repoRelPath,
          text: bundledText,
          occurrences: [
            { range: [0, 9, 10], enclosing_range: [0, 0, bundledText.length], symbol, symbol_roles: ROLE_DEFINITION },
          ],
          symbols: [{ symbol, display_name: "a" }],
        }],
      }));

      const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
      /** @type {Array<{ kind: string, [k: string]: any }>} */
      const events = [];
      try {
        const result = await ingestScipFile({
          ledger: led,
          scipPath,
          repoRoot: projectDir,
          branch: "main",
          onEvent: (event) => events.push(event),
        });
        assert.equal(result.documents_ingested, 0);
        assert.equal(result.documents_failed, 0);
        assert.equal(result.documents_skipped, 1);
        assert.equal(result.ledger_entries_appended, 0);
        assert.deepEqual(result.covered_content_hashes, []);

        const indexes = led.listScipIndexes();
        assert.equal(indexes.length, 1);
        assert.equal(indexes[0].status, "complete");
        assert.equal(indexes[0].documents_failed, 0);
        assert.equal(indexes[0].document_count, 1);
        assert.equal(indexes[0].occurrence_count, 0);

        const blobRows = led._unsafeDb().prepare("SELECT COUNT(*) AS count FROM blob_symbols").get();
        assert.equal(blobRows.count, 0);
      } finally {
        led.close();
      }

      assert.ok(events.some((event) => (
        event.kind === "atlas.scip.ingest.progress"
        && event.current === 1
        && event.total === 1
        && event.documents_skipped === 1
        && event.documents_failed === 0
      )));
      assert.ok(events.some((event) => (
        event.kind === "atlas.scip.ingest.completed"
        && event.documents_skipped === 1
        && event.documents_failed === 0
        && event.status === "complete"
      )));
      assert.equal(events.some((event) => event.kind === "atlas.scip.ingest.failed"), false);
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* windows */ }
    }
  });

  it("binds external monikers when a SCIP document reuses an existing blob", async () => {
    const projectDir = makeTmp("atlas-v2-scip-reuse-");
    const led = Ledger.open({ dbPath: path.join(projectDir, "ledger.db") });
    try {
      const scipPath = path.join(projectDir, "ts.scip");
      const text = "export function local() { return readFile(); }\n";
      fs.mkdirSync(path.join(projectDir, "src"), { recursive: true });
      fs.writeFileSync(path.join(projectDir, "src", "index.ts"), text);
      const contentHash = sha256Hex(Buffer.from(text));
      led.ingestBlob({
        content_hash: contentHash,
        lang: "ts",
        byte_size: Buffer.byteLength(text),
        symbols: [{
          content_hash: contentHash,
          local_id: 0,
          kind: "function",
          name: "local",
          qualified_name: "local",
          parent_local_id: null,
          repo_rel_path: "src/index.ts",
          range_start: 0,
          range_end: text.length,
          range_start_line: 1,
          range_end_line: 1,
          signature_hash: sha256Hex("function local"),
          signature_text: "export function local()",
          visibility: null,
          doc: null,
          lang: "ts",
          source: "treesitter",
        }],
        edges: [],
      });
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0", arguments: [] }),
          project_root: projectDir,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/index.ts",
          text,
          occurrences: [
            { range: [0, 16, 21], enclosing_range: [0, 0, text.length], symbol: "scip-typescript npm pkg 1.0.0 src/`index.ts`/local().", symbol_roles: ROLE_DEFINITION },
            { range: [0, 32, 40], symbol: "scip-typescript npm @types/node 20.0.0 fs/promises.readFile()." },
          ],
          symbols: [
            { symbol: "scip-typescript npm pkg 1.0.0 src/`index.ts`/local().", display_name: "local" },
          ],
        }],
        external_symbols: [
          { symbol: "scip-typescript npm @types/node 20.0.0 fs/promises.readFile().", display_name: "readFile" },
        ],
      }));

      const result = await ingestScipFile({
        ledger: led,
        scipPath,
        repoRoot: projectDir,
        branch: "main",
      });
      assert.equal(result.documents_ingested, 0);
      assert.equal(result.blobs_reused, 1);
      assert.equal(result.external_symbols, 1);
      const rows = /** @type {any[]} */ (led._unsafeDb().prepare(
        "SELECT package_name, descriptor FROM external_symbols WHERE package_name = ?",
      ).all("@types/node"));
      assert.equal(rows.length, 1);
      assert.equal(rows[0].descriptor, "fs/promises.readFile().");
    } finally {
      led.close();
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("honors SCIP UTF-8, UTF-16, and UTF-32 position encodings for multibyte source", async () => {
    const cases = [
      { name: "utf8", encoding: 1 },
      { name: "utf16", encoding: 2 },
      { name: "utf32", encoding: 3 },
    ];
    for (const c of cases) {
      const scipPath = path.join(tmp, `ts-${c.name}-position.scip`);
      const source = `const 🚀${c.name}Rocket = 1;\n`;
      const display = `${c.name}Rocket`;
      const start = source.indexOf(display);
      const end = start + display.length;
      const symbol = `scip-typescript npm pkg 1.0.0 src/\`${c.name}.ts\`/${display}.`;
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: "/repo",
        },
        documents: [{
          language: "TypeScript",
          relative_path: `src/${c.name}.ts`,
          text: source,
          position_encoding: c.encoding,
          occurrences: [
            { range: [0, encodedOffset(source, start, c.encoding), encodedOffset(source, end, c.encoding)], symbol, symbol_roles: ROLE_DEFINITION },
          ],
          symbols: [{ symbol, display_name: display }],
        }],
      }));

      const led = Ledger.open({ dbPath: path.join(tmp, `ledger-${c.name}-position.db`) });
      try {
        await ingestScipFile({ ledger: led, scipPath, repoRoot: tmp, branch: "main" });
        const row = led._unsafeDb().prepare(
          "SELECT range_start, range_end FROM blob_symbols WHERE local_id = 0",
        ).get();
        assert.equal(row.range_start, start);
        assert.equal(row.range_end, end);
      } finally {
        led.close();
      }
    }
  });

  it("defaults missing SCIP document position encoding to UTF-16 without using metadata text encoding", () => {
    const source = "const café = 1;\n";
    const display = "café";
    const start = source.indexOf(display);
    const end = start + display.length;
    const symbol = "scip-typescript npm pkg 1.0.0 src/`cafe.ts`/café.";
    const index = decodeScipIndex(encodeIndex({
      metadata: {
        tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
        project_root: "/repo",
        text_document_encoding: 1,
      },
      documents: [{
        language: "TypeScript",
        relative_path: "src/cafe.ts",
        text: source,
        occurrences: [
          { range: [0, start, end], symbol, symbol_roles: ROLE_DEFINITION },
        ],
        symbols: [{ symbol, display_name: display }],
      }],
    }));

    const cache = buildScipIndexCache(index);
    const doc = cache.get("src/cafe.ts");
    assert.equal(doc?.occurrences[0].start, start);
    assert.equal(doc?.occurrences[0].end, end);
  });
});

/**
 * @param {string} source
 * @param {number} jsOffset
 * @param {number} encoding
 * @returns {number}
 */
function encodedOffset(source, jsOffset, encoding) {
  const prefix = source.slice(0, jsOffset);
  if (encoding === 1) return Buffer.byteLength(prefix, "utf8");
  if (encoding === 3) return Array.from(prefix).length;
  return prefix.length;
}
