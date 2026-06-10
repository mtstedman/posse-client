import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { removeSqliteFile } from "../lib/domains/atlas/functions/v2/view-health.js";
import { VIEW_SCHEMA_VERSION } from "../lib/domains/atlas/functions/v2/contracts/ddl/index.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function bytesOf(s) {
  return Buffer.from(s);
}

function hashOf(s) {
  return sha256Hex(bytesOf(s));
}

/** Build a small repo's worth of ledger content. Returns the ledger. */
function setupBasicRepo(dbPath) {
  // Blob A: src/foo.ts — contains class Foo with method greet
  const aContent = `class Foo { greet() { return "hi"; } }`;
  const aHash = hashOf(aContent);
  const aSymbols = [
    {
      content_hash: aHash, local_id: 0,
      kind: "class", name: "Foo", qualified_name: "Foo",
      parent_local_id: null,
      repo_rel_path: "src/foo.ts", lang: "ts",
      range_start: 0, range_end: 38,
      signature_hash: sha256Hex("class Foo"),
      visibility: "public", doc: null,
    },
    {
      content_hash: aHash, local_id: 1,
      kind: "method", name: "greet", qualified_name: "Foo.greet",
      parent_local_id: 0,
      repo_rel_path: "src/foo.ts", lang: "ts",
      range_start: 12, range_end: 36,
      signature_hash: sha256Hex("Foo.greet()"),
      visibility: "public", doc: null,
    },
  ];

  // Blob B: src/caller.ts — function bar calls foo.greet
  const bContent = `function bar() { return new Foo().greet(); }`;
  const bHash = hashOf(bContent);
  const bSymbols = [
    {
      content_hash: bHash, local_id: 0,
      kind: "function", name: "bar", qualified_name: "bar",
      parent_local_id: null,
      repo_rel_path: "src/caller.ts", lang: "ts",
      range_start: 0, range_end: 44,
      signature_hash: sha256Hex("bar()"),
      visibility: "public", doc: null,
    },
  ];
  // bar -> Foo (uses_type), bar -> greet (calls; resolved)
  const bEdges = [
    {
      from_content_hash: bHash, edge_id: 0, from_local_id: 0,
      to_content_hash: aHash, to_local_id: 0,
      to_name: "Foo", kind: "uses_type",
      range_start: 28, range_end: 31, confidence: 100,
    },
    {
      from_content_hash: bHash, edge_id: 1, from_local_id: 0,
      to_content_hash: aHash, to_local_id: 1,
      to_name: "greet", kind: "calls",
      range_start: 34, range_end: 39, confidence: 100,
    },
    // Unresolved: bar references symbol "ghost" we don't have a blob for
    {
      from_content_hash: bHash, edge_id: 2, from_local_id: 0,
      to_content_hash: null, to_local_id: null,
      to_name: "ghost", kind: "references",
      range_start: 0, range_end: 5, confidence: 50,
    },
  ];

  const led = Ledger.open({ dbPath });
  led.ingestBlob({ content_hash: aHash, lang: "ts", byte_size: aContent.length, symbols: aSymbols, edges: [] });
  led.ingestBlob({ content_hash: bHash, lang: "ts", byte_size: bContent.length, symbols: bSymbols, edges: bEdges });
  led.append({ branch: "main", op: "add", repo_rel_path: "src/foo.ts", before_content_hash: null, after_content_hash: aHash });
  led.append({ branch: "main", op: "add", repo_rel_path: "src/caller.ts", before_content_hash: null, after_content_hash: bHash });
  return { led, aHash, bHash, aContent, bContent };
}

describe("ATLAS v2 View / ViewBuilder", () => {
  let tmp;
  before(() => {
    tmp = makeTmp("atlas-v2-view-");
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("removeSqliteFile surfaces locked primary view deletion failures", () => {
    const dbPath = path.join(tmp, "locked-view.db");
    fs.writeFileSync(dbPath, "");
    const originalUnlinkSync = fs.unlinkSync;
    fs.unlinkSync = (target) => {
      if (String(target) === dbPath) {
        const err = new Error("file is locked");
        err.code = "EPERM";
        throw err;
      }
      return originalUnlinkSync(target);
    };
    try {
      assert.throws(
        () => removeSqliteFile(dbPath),
        /removeSqliteFile: failed to remove SQLite file/,
      );
      assert.equal(fs.existsSync(dbPath), true);
    } finally {
      fs.unlinkSync = originalUnlinkSync;
      fs.rmSync(dbPath, { force: true });
    }
  });

  it("buildFrom main creates a view with all symbols + edges and correct meta", () => {
    const ledPath = path.join(tmp, "ledger-basic.db");
    const viewPath = path.join(tmp, "view-basic.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      const builder = new ViewBuilder();
      const meta = builder.buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
        options: { repoRoot: "/fake/repo" },
      });
      assert.equal(meta.branch, "main");
      assert.equal(meta.parent_branch, null);
      assert.equal(meta.parent_seq, null);
      assert.equal(meta.ledger_seq, 2);
      assert.equal(meta.schema_version, VIEW_SCHEMA_VERSION);
      assert.equal(meta.repo_root, "/fake/repo");
      assert.equal(meta.warmed_for_files, null);
    } finally {
      led.close();
    }

    const view = View.mount({ dbPath: viewPath });
    try {
      const symbols = view.query.symbolsInFile("src/foo.ts");
      assert.equal(symbols.length, 2);
      const fooClass = symbols.find((s) => s.name === "Foo");
      const greetMethod = symbols.find((s) => s.name === "greet");
      assert.ok(fooClass && greetMethod);
      assert.equal(fooClass.kind, "class");
      assert.equal(greetMethod.kind, "method");
      assert.equal(greetMethod.qualified_name, "Foo.greet");
      // greet's parent should resolve to Foo
      const greetFull = view.query.getSymbol(greetMethod.global_id);
      assert.ok(greetFull);

      // findSymbol — FTS prefix
      const fuzzyHits = view.query.findSymbol("gre");
      assert.ok(fuzzyHits.some((s) => s.name === "greet"));

      // findSymbol — exact, non-fuzzy
      const exact = view.query.findSymbol("greet", { fuzzy: false });
      assert.equal(exact.length, 1);
      assert.equal(exact[0].name, "greet");

      // callers/callees of greet
      const callers = view.query.callers(greetMethod.global_id);
      assert.equal(callers.length, 1);
      assert.equal(callers[0].kind, "calls");

      const barSymbols = view.query.symbolsInFile("src/caller.ts");
      const bar = barSymbols.find((s) => s.name === "bar");
      assert.ok(bar);
      const callees = view.query.callees(bar.global_id);
      // bar has 3 edges (uses_type Foo, calls greet, references ghost)
      assert.equal(callees.length, 3);
      const resolved = callees.filter((e) => e.to_global_id != null);
      assert.equal(resolved.length, 2);

      // Unresolved references
      const ghosts = view.query.unresolvedReferencesTo("ghost");
      assert.equal(ghosts.length, 1);
      assert.equal(ghosts[0].kind, "references");
    } finally {
      view.close();
    }
  });

  it("buildFrom normalizes legacy numeric SCIP language tags", () => {
    const ledPath = path.join(tmp, "ledger-legacy-lang.db");
    const viewPath = path.join(tmp, "view-legacy-lang.db");
    const content = `<?php class LegacyStream {}`;
    const contentHash = hashOf(content);
    const led = Ledger.open({ dbPath: ledPath });
    try {
      led.ingestBlob({
        content_hash: contentHash,
        lang: "19",
        byte_size: content.length,
        symbols: [{
          content_hash: contentHash,
          local_id: 0,
          kind: "class",
          name: "LegacyStream",
          qualified_name: "LegacyStream",
          parent_local_id: null,
          repo_rel_path: "src/LegacyStream.php",
          lang: "19",
          range_start: 6,
          range_end: 25,
          signature_hash: sha256Hex("LegacyStream"),
          visibility: "public",
          doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: "main",
        op: "add",
        repo_rel_path: "src/LegacyStream.php",
        before_content_hash: null,
        after_content_hash: contentHash,
      });

      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
      });
    } finally {
      led.close();
    }

    const view = View.mount({ dbPath: viewPath });
    try {
      const symbols = view.query.symbolsInFile("src/LegacyStream.php");
      assert.equal(symbols.length, 1);
      assert.equal(symbols[0].lang, "php");
    } finally {
      view.close();
    }
  });

  it("read-write open resets stale schema-version view DBs", () => {
    const viewPath = path.join(tmp, "view-stale-schema.db");
    const stale = new View({ dbPath: viewPath, mode: "readwrite" });
    try {
      const db = stale._unsafeDb();
      db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run("schema_version", "0");
      db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run("branch", "main");
      db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run("ledger_seq", "7");
      db.exec("CREATE TABLE stale_marker(value TEXT)");
      db.prepare("INSERT INTO stale_marker(value) VALUES(?)").run("old-cache");
    } finally {
      stale.close();
    }

    const reset = new View({ dbPath: viewPath, mode: "readwrite" });
    try {
      const db = reset._unsafeDb();
      const marker = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'stale_marker'").get();
      assert.equal(marker, undefined);
      assert.equal(reset.query.allSymbols().length, 0);
      assert.throws(() => reset.meta(), /missing or invalid schema_version/);
    } finally {
      reset.close();
    }
  });

  it("buildFrom supports duplicate blobs at different repo paths", () => {
    const ledPath = path.join(tmp, "ledger-duplicate-blob.db");
    const viewPath = path.join(tmp, "view-duplicate-blob.db");
    const { led, aHash } = setupBasicRepo(ledPath);
    try {
      led.append({
        branch: "main",
        op: "add",
        repo_rel_path: "src/foo-copy.ts",
        before_content_hash: null,
        after_content_hash: aHash,
      });
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
      });
    } finally {
      led.close();
    }

    const view = View.mount({ dbPath: viewPath });
    try {
      const original = view.query.symbolsInFile("src/foo.ts");
      const duplicate = view.query.symbolsInFile("src/foo-copy.ts");
      assert.equal(original.length, 2);
      assert.equal(duplicate.length, 2);
      assert.deepEqual(duplicate.map((s) => s.name), original.map((s) => s.name));
      assert.notEqual(duplicate[0].global_id, original[0].global_id);
      const sameBlobRows = view.query.allSymbols().filter((s) => s.content_hash === aHash);
      assert.equal(sameBlobRows.length, 4);
    } finally {
      view.close();
    }
  });

  it("surfaces SCIP external edges through the view query API", () => {
    const ledPath = path.join(tmp, "ledger-scip-external-query.db");
    const viewPath = path.join(tmp, "view-scip-external-query.db");
    const content = "export async function load() { return readFile('x'); }\n";
    const hash = hashOf(content);
    const led = Ledger.open({ dbPath: ledPath });
    try {
      const externalId = led.upsertExternalSymbol({
        scheme: "scip-typescript",
        manager: "npm",
        package_name: "@types/node",
        package_version: "20.0.0",
        descriptor: "fs/promises.readFile().",
        display_name: "readFile",
      });
      led.ingestBlob({
        content_hash: hash,
        lang: "ts",
        byte_size: content.length,
        symbols: [{
          content_hash: hash,
          local_id: 0,
          kind: "function",
          name: "load",
          qualified_name: "load",
          parent_local_id: null,
          repo_rel_path: "src/load.ts",
          lang: "ts",
          range_start: 0,
          range_end: content.length,
          signature_hash: sha256Hex("load()"),
          visibility: "public",
          doc: null,
          source: "scip",
        }],
        edges: [{
          from_content_hash: hash,
          edge_id: 0,
          from_local_id: 0,
          to_content_hash: null,
          to_local_id: null,
          to_external_id: externalId,
          to_name: "readFile",
          kind: "references",
          range_start: 39,
          range_end: 47,
          confidence: 95,
          source: "scip",
        }],
      });
      led.append({ branch: "main", op: "add", repo_rel_path: "src/load.ts", before_content_hash: null, after_content_hash: hash });
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
      });
    } finally {
      led.close();
    }

    const view = View.mount({ dbPath: viewPath });
    try {
      const [load] = view.query.symbolsInFile("src/load.ts");
      assert.ok(load);
      const callees = view.query.callees(load.global_id);
      assert.equal(callees.length, 1);
      assert.equal(callees[0].to_global_id, null);
      assert.equal(callees[0].to_external_id, 1);
      assert.equal(callees[0].external_descriptor, "fs/promises.readFile().");
      assert.equal(callees[0].source, "scip");
      assert.equal(view.query.unresolvedReferencesTo("readFile").length, 0);
    } finally {
      view.close();
    }
  });

  it("incrementalApply rebinds previously unresolved edges when a target symbol appears", () => {
    const ledPath = path.join(tmp, "ledger-rebind.db");
    const viewPath = path.join(tmp, "view-rebind.db");
    const { led } = setupBasicRepo(ledPath);
    const builder = new ViewBuilder();
    builder.buildFrom({
      ledger: led,
      branch: "main",
      atSeq: led.headSeq("main"),
      outPath: viewPath,
    });

    const view = View.mount({ dbPath: viewPath, mode: "readwrite" });
    try {
      assert.equal(view.query.unresolvedReferencesTo("ghost").length, 1);

      const ghostContent = "export function ghost() {}\n";
      const ghostHash = hashOf(ghostContent);
      led.ingestBlob({
        content_hash: ghostHash,
        lang: "ts",
        byte_size: ghostContent.length,
        symbols: [
          {
            content_hash: ghostHash,
            local_id: 0,
            kind: "function",
            name: "ghost",
            qualified_name: "ghost",
            parent_local_id: null,
            repo_rel_path: "src/ghost.ts",
            lang: "ts",
            range_start: 0,
            range_end: ghostContent.length,
            signature_hash: sha256Hex("ghost()"),
            visibility: "public",
            doc: null,
          },
        ],
        edges: [],
      });
      const entry = led.append({
        branch: "main",
        op: "add",
        repo_rel_path: "src/ghost.ts",
        before_content_hash: null,
        after_content_hash: ghostHash,
      });

      builder.incrementalApply({ view, ledger: led, entries: [entry] });

      const ghost = view.query.findSymbol("ghost", { fuzzy: false, limit: 5 })
        .find((s) => s.repo_rel_path === "src/ghost.ts");
      assert.ok(ghost);
      assert.equal(view.query.unresolvedReferencesTo("ghost").length, 0);
      const callers = view.query.callers(ghost.global_id).filter((e) => e.kind === "references");
      assert.equal(callers.length, 1);
      assert.equal(view.query.getSymbol(callers[0].from_global_id)?.name, "bar");
    } finally {
      view.close();
      led.close();
    }
  });

  it("findSymbol applies pathPrefix, kinds, and langs filters", () => {
    const ledPath = path.join(tmp, "ledger-filters.db");
    const viewPath = path.join(tmp, "view-filters.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      const builder = new ViewBuilder();
      builder.buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
      });
    } finally {
      led.close();
    }

    const view = View.mount({ dbPath: viewPath });
    try {
      // Path prefix filter
      const inFoo = view.query.findSymbol("Foo", { pathPrefix: "src/foo.ts" });
      assert.ok(inFoo.every((s) => s.repo_rel_path === "src/foo.ts"));

      const inSrc = view.query.findSymbol("bar", { pathPrefix: "src" });
      assert.ok(inSrc.some((s) => s.name === "bar"));

      // Kinds filter
      const onlyClasses = view.query.findSymbol("Foo", { kinds: ["class"] });
      assert.ok(onlyClasses.every((s) => s.kind === "class"));

      // Langs filter
      const onlyTs = view.query.findSymbol("bar", { langs: ["ts"] });
      assert.ok(onlyTs.every((s) => s.lang === "ts"));
      const onlyPy = view.query.findSymbol("bar", { langs: ["py"] });
      assert.equal(onlyPy.length, 0);
    } finally {
      view.close();
    }
  });

  it("buildFrom on a forked branch walks lineage and applies overlay deltas", () => {
    const ledPath = path.join(tmp, "ledger-fork.db");
    const viewPath = path.join(tmp, "view-fork.db");
    const { led, aHash } = setupBasicRepo(ledPath);
    try {
      // Fork wi-1 off main at current head
      const mainHead = led.headSeq("main");
      led.forkBranch("wi-1", "main", mainHead);

      // On wi-1, add a new file and remove src/caller.ts
      const newContent = "function added() {}";
      const newHash = hashOf(newContent);
      led.ingestBlob({
        content_hash: newHash,
        lang: "ts",
        byte_size: newContent.length,
        symbols: [
          {
            content_hash: newHash, local_id: 0,
            kind: "function", name: "added", qualified_name: "added",
            parent_local_id: null,
            repo_rel_path: "src/new.ts", lang: "ts",
            range_start: 0, range_end: 18,
            signature_hash: sha256Hex("added()"),
            visibility: "public", doc: null,
          },
        ],
        edges: [],
      });
      led.append({
        branch: "wi-1", op: "add", repo_rel_path: "src/new.ts",
        before_content_hash: null, after_content_hash: newHash,
      });
      // Need the previous content_hash for the remove op
      const callerBlob = led.tail("main", 0).find((e) => e.repo_rel_path === "src/caller.ts");
      led.append({
        branch: "wi-1", op: "remove", repo_rel_path: "src/caller.ts",
        before_content_hash: callerBlob.after_content_hash, after_content_hash: null,
      });

      const builder = new ViewBuilder();
      builder.buildFrom({
        ledger: led,
        branch: "wi-1",
        atSeq: led.headSeq("wi-1"),
        outPath: viewPath,
      });
    } finally {
      led.close();
    }

    const view = View.mount({ dbPath: viewPath });
    try {
      const meta = view.meta();
      assert.equal(meta.branch, "wi-1");
      assert.equal(meta.parent_branch, "main");
      assert.equal(meta.parent_seq, 2);

      // src/foo.ts inherited from main
      const fooSyms = view.query.symbolsInFile("src/foo.ts");
      assert.equal(fooSyms.length, 2);

      // src/new.ts added on wi-1
      const newSyms = view.query.symbolsInFile("src/new.ts");
      assert.equal(newSyms.length, 1);
      assert.equal(newSyms[0].name, "added");

      // src/caller.ts removed on wi-1 — view must NOT contain it
      const removed = view.query.symbolsInFile("src/caller.ts");
      assert.equal(removed.length, 0);
    } finally {
      view.close();
    }
  });

  it("incrementalApply updates the view in place when new deltas land", () => {
    const ledPath = path.join(tmp, "ledger-incr.db");
    const viewPath = path.join(tmp, "view-incr.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      const builder = new ViewBuilder();
      builder.buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
      });

      // Add a new path on main after view was built.
      const extraContent = "function helper() {}";
      const extraHash = hashOf(extraContent);
      led.ingestBlob({
        content_hash: extraHash,
        lang: "ts",
        byte_size: extraContent.length,
        symbols: [
          {
            content_hash: extraHash, local_id: 0,
            kind: "function", name: "helper", qualified_name: "helper",
            parent_local_id: null,
            repo_rel_path: "src/helper.ts", lang: "ts",
            range_start: 0, range_end: 18,
            signature_hash: sha256Hex("helper()"),
            visibility: "public", doc: null,
          },
        ],
        edges: [],
      });
      const newEntry = led.append({
        branch: "main", op: "add", repo_rel_path: "src/helper.ts",
        before_content_hash: null, after_content_hash: extraHash,
      });

      const view = View.mount({ dbPath: viewPath, mode: "readwrite" });
      try {
        const before = view.query.symbolsInFile("src/helper.ts");
        assert.equal(before.length, 0);
        const newMeta = builder.incrementalApply({ view, ledger: led, entries: [newEntry] });
        assert.equal(newMeta.ledger_seq, newEntry.seq);
        const after = view.query.symbolsInFile("src/helper.ts");
        assert.equal(after.length, 1);
        assert.equal(after[0].name, "helper");
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("incrementalApply remove erases a path's symbols", () => {
    const ledPath = path.join(tmp, "ledger-remove.db");
    const viewPath = path.join(tmp, "view-remove.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      const builder = new ViewBuilder();
      builder.buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
      });
      const callerEntry = led.tail("main", 0).find((e) => e.repo_rel_path === "src/caller.ts");
      const remove = led.append({
        branch: "main", op: "remove", repo_rel_path: "src/caller.ts",
        before_content_hash: callerEntry.after_content_hash, after_content_hash: null,
      });
      const view = View.mount({ dbPath: viewPath, mode: "readwrite" });
      try {
        assert.equal(view.query.symbolsInFile("src/caller.ts").length, 1);
        builder.incrementalApply({ view, ledger: led, entries: [remove] });
        assert.equal(view.query.symbolsInFile("src/caller.ts").length, 0);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("slice traverses edges from seed symbols bounded by depth and size", () => {
    const ledPath = path.join(tmp, "ledger-slice.db");
    const viewPath = path.join(tmp, "view-slice.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
      });
    } finally {
      led.close();
    }
    const view = View.mount({ dbPath: viewPath });
    try {
      const greet = view.query.findSymbol("greet", { fuzzy: false })[0];
      assert.ok(greet);
      const slice = view.query.slice([greet.global_id], { depth: 2, maxSymbols: 10 });
      // From greet -> reachable via inbound caller (bar)
      assert.ok(slice.some((s) => s.name === "bar"));
    } finally {
      view.close();
    }
  });

  it("blastRadius returns transitive callers of symbols in a file", () => {
    const ledPath = path.join(tmp, "ledger-blast.db");
    const viewPath = path.join(tmp, "view-blast.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
      });
    } finally {
      led.close();
    }
    const view = View.mount({ dbPath: viewPath });
    try {
      // Changing src/foo.ts should flag bar in src/caller.ts as affected
      const affected = view.query.blastRadius(["src/foo.ts"]);
      assert.ok(affected.some((s) => s.name === "bar"));
    } finally {
      view.close();
    }
  });

  it("blastRadius ranks high-confidence direct impact ahead of weak/distant impact", () => {
    const ledPath = path.join(tmp, "ledger-blast-weighted.db");
    const viewPath = path.join(tmp, "view-blast-weighted.db");
    const led = Ledger.open({ dbPath: ledPath });
    const core = "export function target() { return 1; }\n";
    const high = "export function highCaller() { return target(); }\n";
    const low = "export function lowCaller() { return target(); }\n";
    const indirect = "export function indirectCaller() { return lowCaller(); }\n";
    const coreHash = hashOf(core);
    const highHash = hashOf(high);
    const lowHash = hashOf(low);
    const indirectHash = hashOf(indirect);
    try {
      led.ingestBlob({
        content_hash: coreHash,
        lang: "ts",
        byte_size: core.length,
        symbols: [{
          content_hash: coreHash, local_id: 0,
          kind: "function", name: "target", qualified_name: "target",
          parent_local_id: null, repo_rel_path: "src/core.ts", lang: "ts",
          range_start: 0, range_end: core.length,
          signature_hash: sha256Hex("target()"), visibility: "public", doc: null,
        }],
        edges: [],
      });
      led.ingestBlob({
        content_hash: highHash,
        lang: "ts",
        byte_size: high.length,
        symbols: [{
          content_hash: highHash, local_id: 0,
          kind: "function", name: "highCaller", qualified_name: "highCaller",
          parent_local_id: null, repo_rel_path: "src/high.ts", lang: "ts",
          range_start: 0, range_end: high.length,
          signature_hash: sha256Hex("highCaller()"), visibility: "public", doc: null,
        }],
        edges: [{
          from_content_hash: highHash, edge_id: 0, from_local_id: 0,
          to_content_hash: coreHash, to_local_id: 0,
          to_name: "target", kind: "calls", range_start: 0, range_end: 10, confidence: 100,
        }],
      });
      led.ingestBlob({
        content_hash: lowHash,
        lang: "ts",
        byte_size: low.length,
        symbols: [{
          content_hash: lowHash, local_id: 0,
          kind: "function", name: "lowCaller", qualified_name: "lowCaller",
          parent_local_id: null, repo_rel_path: "src/low.ts", lang: "ts",
          range_start: 0, range_end: low.length,
          signature_hash: sha256Hex("lowCaller()"), visibility: "public", doc: null,
        }],
        edges: [{
          from_content_hash: lowHash, edge_id: 0, from_local_id: 0,
          to_content_hash: coreHash, to_local_id: 0,
          to_name: "target", kind: "calls", range_start: 0, range_end: 10, confidence: 10,
        }],
      });
      led.ingestBlob({
        content_hash: indirectHash,
        lang: "ts",
        byte_size: indirect.length,
        symbols: [{
          content_hash: indirectHash, local_id: 0,
          kind: "function", name: "indirectCaller", qualified_name: "indirectCaller",
          parent_local_id: null, repo_rel_path: "src/indirect.ts", lang: "ts",
          range_start: 0, range_end: indirect.length,
          signature_hash: sha256Hex("indirectCaller()"), visibility: "public", doc: null,
        }],
        edges: [{
          from_content_hash: indirectHash, edge_id: 0, from_local_id: 0,
          to_content_hash: lowHash, to_local_id: 0,
          to_name: "lowCaller", kind: "calls", range_start: 0, range_end: 10, confidence: 100,
        }],
      });
      for (const [repo_rel_path, after_content_hash] of [
        ["src/core.ts", coreHash],
        ["src/high.ts", highHash],
        ["src/low.ts", lowHash],
        ["src/indirect.ts", indirectHash],
      ]) {
        led.append({ branch: "main", op: "add", repo_rel_path, before_content_hash: null, after_content_hash });
      }
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
      });
    } finally {
      led.close();
    }
    const view = View.mount({ dbPath: viewPath });
    try {
      const affected = view.query.blastRadius(["src/core.ts"]);
      assert.equal(affected[0]?.name, "highCaller");
      assert.ok(affected.some((s) => s.name === "lowCaller"));
      assert.ok(affected.some((s) => s.name === "indirectCaller"));
    } finally {
      view.close();
    }
  });

  it("cloneView produces a byte-equivalent view file at the destination", () => {
    const ledPath = path.join(tmp, "ledger-clone.db");
    const sourcePath = path.join(tmp, "view-clone-src.db");
    const destPath = path.join(tmp, "view-clone-dst.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: sourcePath,
      });
    } finally {
      led.close();
    }
    const liveSource = new View({ dbPath: sourcePath, mode: "readwrite" });
    try {
      liveSource._unsafeDb()
        .prepare("INSERT OR REPLACE INTO meta(key, value) VALUES(?, ?)")
        .run("clone_test", "checkpointed");
      assert.equal(fs.existsSync(sourcePath + "-wal"), true);
      new ViewBuilder().cloneView({ sourcePath, destPath });
      assert.equal(fs.existsSync(destPath + "-wal"), false);
      assert.equal(fs.existsSync(destPath + "-shm"), false);
    } finally {
      liveSource.close();
    }
    const clonedView = View.mount({ dbPath: destPath });
    try {
      assert.equal(clonedView.query.symbolsInFile("src/foo.ts").length, 2);
      assert.equal(clonedView.meta().branch, "main");
      assert.deepEqual(
        clonedView._unsafeDb().prepare("SELECT value FROM meta WHERE key = ?").get("clone_test"),
        { value: "checkpointed" },
      );
    } finally {
      clonedView.close();
    }
  });

  it("incrementalApply skips graph-derived rebuild when the graph signature is unchanged", () => {
    const ledPath = path.join(tmp, "ledger-graph-skip.db");
    const viewPath = path.join(tmp, "view-graph-skip.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      const builder = new ViewBuilder();
      builder.buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
      });

      const noteContent = "notes only\n";
      const noteHash = hashOf(noteContent);
      led.ingestBlob({
        content_hash: noteHash,
        lang: "txt",
        byte_size: noteContent.length,
        symbols: [],
        edges: [],
      });
      const entry = led.append({
        branch: "main",
        op: "add",
        repo_rel_path: "docs/notes.txt",
        before_content_hash: null,
        after_content_hash: noteHash,
      });

      const view = View.mount({ dbPath: viewPath, mode: "readwrite" });
      try {
        const before = view._unsafeDb().prepare(
          "SELECT COUNT(*) AS count FROM derived_state_runs WHERE kind = 'graph-derived'",
        ).get();
        assert.equal(Number(before.count), 1);

        builder.incrementalApply({ view, ledger: led, entries: [entry] });

        const after = view._unsafeDb().prepare(
          "SELECT COUNT(*) AS count FROM derived_state_runs WHERE kind = 'graph-derived'",
        ).get();
        assert.equal(Number(after.count), 1);
        assert.equal(view.meta().ledger_seq, entry.seq);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("buildFrom with hint records neighborhood prefetch stats in meta", () => {
    const ledPath = path.join(tmp, "ledger-hint.db");
    const viewPath = path.join(tmp, "view-hint.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      const builder = new ViewBuilder();
      builder.buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
        options: {
          repoRoot: "/fake/repo",
          hint: { paths: ["src/foo.ts"], depth: 2, maxSymbols: 500 },
        },
      });
    } finally {
      led.close();
    }

    const view = View.mount({ dbPath: viewPath });
    try {
      const meta = view.meta();
      assert.ok(
        Array.isArray(meta.warmed_for_files) && meta.warmed_for_files.includes("src/foo.ts"),
        `warmed_for_files should record hint paths; got ${JSON.stringify(meta.warmed_for_files)}`,
      );
      // src/foo.ts contains Foo + greet → at least 2 seeds.
      assert.ok(
        meta.prefetched_symbols != null && meta.prefetched_symbols >= 2,
        `expected prefetched_symbols >= 2; got ${meta.prefetched_symbols}`,
      );
      // greet is a seed; bar -> greet is an inbound edge that should be
      // traversed at hop 1.
      assert.ok(
        meta.prefetched_edges != null && meta.prefetched_edges >= 1,
        `expected prefetched_edges >= 1; got ${meta.prefetched_edges}`,
      );
    } finally {
      view.close();
    }
  });

  it("buildFrom without hint leaves prefetch stats null", () => {
    const ledPath = path.join(tmp, "ledger-no-hint.db");
    const viewPath = path.join(tmp, "view-no-hint.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
      });
    } finally {
      led.close();
    }

    const view = View.mount({ dbPath: viewPath });
    try {
      const meta = view.meta();
      assert.equal(meta.prefetched_symbols, null);
      assert.equal(meta.prefetched_edges, null);
      assert.equal(meta.warmed_for_files, null);
    } finally {
      view.close();
    }
  });

  it("buildFrom hint ignores non-canonical paths and tolerates empty path list", () => {
    const ledPath = path.join(tmp, "ledger-hint-empty.db");
    const viewPath = path.join(tmp, "view-hint-empty.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: viewPath,
        options: {
          // All non-canonical: absolute, parent escape, trailing slash —
          // every entry should be filtered out and the prefetch is a no-op
          // that still records zero counts.
          hint: { paths: ["/abs/path", "../escape", "trailing/"], depth: 2 },
        },
      });
    } finally {
      led.close();
    }

    const view = View.mount({ dbPath: viewPath });
    try {
      const meta = view.meta();
      // Hint was supplied (non-empty array), so stats are recorded — but
      // every path is filtered out, so counts are zero.
      assert.equal(meta.prefetched_symbols, 0);
      assert.equal(meta.prefetched_edges, 0);
    } finally {
      view.close();
    }
  });

  it("buildFrom rejects invalid inputs", () => {
    const ledPath = path.join(tmp, "ledger-reject.db");
    const viewPath = path.join(tmp, "view-reject.db");
    const { led } = setupBasicRepo(ledPath);
    try {
      const builder = new ViewBuilder();
      assert.throws(
        () => builder.buildFrom({ ledger: led, branch: "ghost", atSeq: 0, outPath: viewPath }),
        /unknown branch/,
      );
      assert.throws(
        () => builder.buildFrom({ ledger: led, branch: "main", atSeq: 999, outPath: viewPath }),
        /exceeds branch head/,
      );
      builder.buildFrom({
        ledger: led, branch: "main", atSeq: led.headSeq("main"), outPath: viewPath,
      });
      // Same outPath now exists — second call should refuse
      assert.throws(
        () =>
          builder.buildFrom({
            ledger: led, branch: "main", atSeq: led.headSeq("main"), outPath: viewPath,
          }),
        /already exists/,
      );
    } finally {
      led.close();
    }
  });
});
