import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { LEDGER_SCHEMA_VERSION } from "../lib/domains/atlas/functions/v2/contracts/index.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function makeBlob(content) {
  const hash = sha256Hex(Buffer.from(content));
  return { hash, byte_size: Buffer.byteLength(content) };
}

function makeSymbol(content_hash, local_id, name, extra = {}) {
  return {
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
    signature_hash: sha256Hex(name),
    visibility: null,
    doc: null,
    ...extra,
  };
}

function makeEdge(from_content_hash, edge_id, from_local_id, to_name, extra = {}) {
  return {
    from_content_hash,
    edge_id,
    from_local_id,
    to_content_hash: null,
    to_local_id: null,
    to_name,
    kind: "calls",
    range_start: 0,
    range_end: 5,
    confidence: 100,
    ...extra,
  };
}

describe("ATLAS v2 Ledger", () => {
  /** @type {string} */
  let tmp;
  /** @type {string} */
  let dbPath;
  before(() => {
    tmp = makeTmp("atlas-v2-ledger-");
    dbPath = path.join(tmp, "ledger.db");
  });
  after(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it("creates the DB and auto-seeds the 'main' branch", () => {
    const led = Ledger.open({ dbPath });
    try {
      const main = led.getBranch("main");
      assert.ok(main, "main branch should exist after open");
      assert.equal(main.parent_branch, null);
      assert.equal(main.parent_seq, null);
      assert.equal(main.status, "active");
      assert.equal(led.headSeq("main"), 0);
    } finally {
      led.close();
    }
  });

  it("opens an existing DB without re-initializing main", () => {
    const led1 = Ledger.open({ dbPath });
    const ts1 = led1.getBranch("main").created_at;
    led1.close();
    const led2 = Ledger.open({ dbPath });
    try {
      const ts2 = led2.getBranch("main").created_at;
      assert.equal(ts2, ts1, "main.created_at must be stable across re-opens");
    } finally {
      led2.close();
    }
  });

  it("flushes stale on-disk formats before preparing SCIP-aware statements", () => {
    const stalePath = path.join(tmp, "stale-format.db");
    const stale = new Database(stalePath);
    try {
      stale.exec(`
        CREATE TABLE meta (
          key TEXT PRIMARY KEY,
          value TEXT
        );
        INSERT INTO meta(key, value) VALUES('schema_version', '1');

        CREATE TABLE blob_edges (
          from_content_hash TEXT NOT NULL,
          edge_id INTEGER NOT NULL,
          to_external_id INTEGER,
          source TEXT NOT NULL DEFAULT 'treesitter',
          PRIMARY KEY (from_content_hash, edge_id)
        );

        CREATE TABLE branches (
          name TEXT PRIMARY KEY,
          created_at TEXT NOT NULL,
          status TEXT NOT NULL
        );
        INSERT INTO branches(name, created_at, status)
          VALUES('legacy-branch', '2026-05-01T00:00:00.000Z', 'active');
      `);
    } finally {
      stale.close();
    }

    const led = Ledger.open({ dbPath: stalePath });
    try {
      const db = led._unsafeDb();
      const version = /** @type {{ value: string }} */ (
        db.prepare("SELECT value FROM meta WHERE key = 'schema_version'").get()
      );
      const edgeColumns = new Set(
        /** @type {Array<{ name: string }>} */ (
          db.prepare("PRAGMA table_info(blob_edges)").all()
        ).map((c) => c.name),
      );
      assert.equal(Number(version.value), LEDGER_SCHEMA_VERSION);
      assert.equal(led.getBranch("legacy-branch"), null);
      assert.ok(led.getBranch("main"));
      assert.ok(edgeColumns.has("to_module_id"));
    } finally {
      led.close();
    }
  });

  it("ingestBlob is idempotent and stores symbols + edges", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "ingest.db") });
    try {
      const { hash, byte_size } = makeBlob("function foo() {}");
      const symbols = [makeSymbol(hash, 0, "foo")];
      const edges = [makeEdge(hash, 0, 0, "bar")];
      led.ingestBlob({ content_hash: hash, lang: "ts", byte_size, symbols, edges });
      assert.equal(led.hasBlob(hash), true);
      // Second call is a no-op.
      led.ingestBlob({ content_hash: hash, lang: "ts", byte_size, symbols, edges });
      const db = led._unsafeDb();
      const symRows = db.prepare("SELECT COUNT(*) AS c FROM blob_symbols WHERE content_hash = ?").get(hash);
      const edgeRows = db.prepare("SELECT COUNT(*) AS c FROM blob_edges WHERE from_content_hash = ?").get(hash);
      assert.equal(symRows.c, 1);
      assert.equal(edgeRows.c, 1);
    } finally {
      led.close();
    }
  });

  it("rejects malformed blob ingest inputs", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "ingest-bad.db") });
    try {
      assert.throws(
        () => led.ingestBlob({ content_hash: "nothex", lang: "ts", byte_size: 0, symbols: [], edges: [] }),
        /SHA-256/,
      );
      const { hash } = makeBlob("x");
      assert.throws(
        () =>
          led.ingestBlob({
            content_hash: hash,
            lang: "ts",
            byte_size: 1,
            symbols: [makeSymbol(hash, 0, "a"), makeSymbol(hash, 0, "b")],
            edges: [],
          }),
        /duplicate local_id/,
      );
    } finally {
      led.close();
    }
  });

  it("append: add/modify/remove with correct seqs and parent_seq", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "append.db") });
    try {
      const a = makeBlob("v1");
      const b = makeBlob("v2");
      led.ingestBlob({ content_hash: a.hash, lang: "ts", byte_size: a.byte_size, symbols: [], edges: [] });
      led.ingestBlob({ content_hash: b.hash, lang: "ts", byte_size: b.byte_size, symbols: [], edges: [] });

      const e1 = led.append({
        branch: "main",
        op: "add",
        repo_rel_path: "src/x.ts",
        before_content_hash: null,
        after_content_hash: a.hash,
      });
      assert.equal(e1.seq, 1);
      assert.equal(e1.parent_seq, null);

      const e2 = led.append({
        branch: "main",
        op: "modify",
        repo_rel_path: "src/x.ts",
        before_content_hash: a.hash,
        after_content_hash: b.hash,
      });
      assert.equal(e2.seq, 2);
      assert.equal(e2.parent_seq, 1, "parent_seq must point at the previous delta on this path");

      const e3 = led.append({
        branch: "main",
        op: "remove",
        repo_rel_path: "src/x.ts",
        before_content_hash: b.hash,
        after_content_hash: null,
      });
      assert.equal(e3.seq, 3);
      assert.equal(e3.parent_seq, 2);

      assert.equal(led.headSeq("main"), 3);
    } finally {
      led.close();
    }
  });

  it("append validates op/hash constraints", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "append-bad.db") });
    try {
      const a = makeBlob("v1");
      led.ingestBlob({ content_hash: a.hash, lang: "ts", byte_size: a.byte_size, symbols: [], edges: [] });

      assert.throws(
        () =>
          led.append({
            branch: "main",
            op: "add",
            repo_rel_path: "src/x.ts",
            before_content_hash: a.hash,
            after_content_hash: a.hash,
          }),
        /op='add'/,
      );
      assert.throws(
        () =>
          led.append({
            branch: "main",
            op: "remove",
            repo_rel_path: "src/x.ts",
            before_content_hash: null,
            after_content_hash: null,
          }),
        /op='remove'/,
      );
      assert.throws(
        () =>
          led.append({
            branch: "ghost",
            op: "add",
            repo_rel_path: "src/x.ts",
            before_content_hash: null,
            after_content_hash: a.hash,
          }),
        /unknown branch/,
      );
      assert.throws(
        () =>
          led.append({
            branch: "main",
            op: "add",
            repo_rel_path: "/absolute/bad",
            before_content_hash: null,
            after_content_hash: a.hash,
          }),
        /canonical/,
      );
    } finally {
      led.close();
    }
  });

  it("forkBranch records lineage and rejects bad inputs", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "fork.db") });
    try {
      const a = makeBlob("a");
      led.ingestBlob({ content_hash: a.hash, lang: "ts", byte_size: a.byte_size, symbols: [], edges: [] });
      led.append({
        branch: "main",
        op: "add",
        repo_rel_path: "src/x.ts",
        before_content_hash: null,
        after_content_hash: a.hash,
      });
      const fork = led.forkBranch("wi-1", "main", 1);
      assert.equal(fork.parent_branch, "main");
      assert.equal(fork.parent_seq, 1);
      assert.throws(() => led.forkBranch("wi-1", "main", 1), /already exists/);
      assert.throws(() => led.forkBranch("wi-2", "main", 99), /exceeds parent head/);
      assert.throws(() => led.forkBranch("wi-3", "ghost", 0), /unknown parent/);
      assert.throws(() => led.forkBranch("main", "main", 0), /cannot fork onto 'main'/);
    } finally {
      led.close();
    }
  });

  it("tail respects fromSeq, limit, and upToSeq", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "tail.db") });
    try {
      const blobs = ["a", "b", "c", "d"].map((s) => makeBlob(s));
      for (const b of blobs) {
        led.ingestBlob({ content_hash: b.hash, lang: "ts", byte_size: b.byte_size, symbols: [], edges: [] });
      }
      for (let i = 0; i < blobs.length; i++) {
        led.append({
          branch: "main",
          op: "add",
          repo_rel_path: `src/${i}.ts`,
          before_content_hash: null,
          after_content_hash: blobs[i].hash,
        });
      }

      const all = led.tail("main", 0);
      assert.equal(all.length, 4);
      assert.deepEqual(all.map((e) => e.seq), [1, 2, 3, 4]);

      const fromTwo = led.tail("main", 2);
      assert.deepEqual(fromTwo.map((e) => e.seq), [3, 4]);

      const limited = led.tail("main", 0, 2);
      assert.equal(limited.length, 2);

      const bounded = led.tail("main", 0, { upToSeq: 2 });
      assert.deepEqual(bounded.map((e) => e.seq), [1, 2]);

      const boundedLimited = led.tail("main", 0, { upToSeq: 3, limit: 2 });
      assert.deepEqual(boundedLimited.map((e) => e.seq), [1, 2]);
    } finally {
      led.close();
    }
  });

  it("replayPartition copies a branch's deltas onto another branch with fresh seqs", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "replay.db") });
    try {
      const a = makeBlob("a");
      const b = makeBlob("b");
      led.ingestBlob({ content_hash: a.hash, lang: "ts", byte_size: a.byte_size, symbols: [], edges: [] });
      led.ingestBlob({ content_hash: b.hash, lang: "ts", byte_size: b.byte_size, symbols: [], edges: [] });
      // main gets one delta first
      led.append({
        branch: "main",
        op: "add",
        repo_rel_path: "src/main.ts",
        before_content_hash: null,
        after_content_hash: a.hash,
      });
      led.forkBranch("wi-1", "main", 1);
      led.append({
        branch: "wi-1",
        op: "add",
        repo_rel_path: "src/feature.ts",
        before_content_hash: null,
        after_content_hash: b.hash,
      });

      const replayed = led.replayPartition("wi-1", "main", 0);
      assert.equal(replayed.length, 1);
      assert.equal(replayed[0].seq, 2, "destination seq should be next after main's existing 1");
      assert.equal(replayed[0].branch, "main");
      assert.equal(replayed[0].repo_rel_path, "src/feature.ts");
    } finally {
      led.close();
    }
  });

  it("replayPartition rejects a conflict when destination head diverged from before_content_hash", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "replay-conflict.db") });
    try {
      const a = makeBlob("a");
      const b = makeBlob("b");
      const c = makeBlob("c");
      for (const blob of [a, b, c]) {
        led.ingestBlob({
          content_hash: blob.hash,
          lang: "ts",
          byte_size: blob.byte_size,
          symbols: [],
          edges: [],
        });
      }
      // main has src/x.ts at hash=a.
      led.append({
        branch: "main", op: "add", repo_rel_path: "src/x.ts",
        before_content_hash: null, after_content_hash: a.hash,
      });
      led.forkBranch("wi-1", "main", led.headSeq("main"));
      // wi-1 modifies src/x.ts from a → b. At fork time main also had a.
      led.append({
        branch: "wi-1", op: "modify", repo_rel_path: "src/x.ts",
        before_content_hash: a.hash, after_content_hash: b.hash,
      });
      // Meanwhile someone else updated main's src/x.ts from a → c.
      led.append({
        branch: "main", op: "modify", repo_rel_path: "src/x.ts",
        before_content_hash: a.hash, after_content_hash: c.hash,
      });
      // wi-1's modify expects main to still have 'a'; main has 'c'. Conflict.
      assert.throws(
        () => led.replayPartition("wi-1", "main", 0),
        /conflict at 'src\/x\.ts'/,
      );
      // Conflict aborted inside the transaction — main is unchanged.
      assert.equal(led.headSeq("main"), 2, "main head should not advance on aborted replay");
    } finally {
      led.close();
    }
  });

  it("replayPartition rejects an add when destination already has the path", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "replay-double-add.db") });
    try {
      const a = makeBlob("a");
      const b = makeBlob("b");
      for (const blob of [a, b]) {
        led.ingestBlob({
          content_hash: blob.hash, lang: "ts", byte_size: blob.byte_size, symbols: [], edges: [],
        });
      }
      led.forkBranch("wi-1", "main", 0);
      // Both branches independently add src/x.ts (forked at seq=0, so wi-1
      // didn't see main's later add).
      led.append({
        branch: "wi-1", op: "add", repo_rel_path: "src/x.ts",
        before_content_hash: null, after_content_hash: a.hash,
      });
      led.append({
        branch: "main", op: "add", repo_rel_path: "src/x.ts",
        before_content_hash: null, after_content_hash: b.hash,
      });
      // Replay onto main: wi-1's add expects path absent (before=null), but
      // main now has the path → conflict.
      assert.throws(
        () => led.replayPartition("wi-1", "main", 0),
        /conflict at 'src\/x\.ts'/,
      );
    } finally {
      led.close();
    }
  });

  it("setBranchStatus moves a branch through merged / abandoned", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "status.db") });
    try {
      led.forkBranch("wi-9", "main", 0);
      led.setBranchStatus("wi-9", "merged");
      assert.equal(led.getBranch("wi-9").status, "merged");
      assert.throws(() => led.setBranchStatus("ghost", "merged"), /unknown branch/);
      assert.throws(
        () => led.setBranchStatus("wi-9", /** @type {any} */ ("garbage")),
        /invalid status/,
      );
    } finally {
      led.close();
    }
  });

  it("rewrites SCIP flat edges idempotently when merging into an existing blob", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "merge-scip-idempotent.db") });
    try {
      const source = "export function root() { helper(); }\n";
      const { hash, byte_size } = makeBlob(source);
      led.ingestBlob({
        content_hash: hash,
        lang: "ts",
        byte_size,
        symbols: [makeSymbol(hash, 0, "root", { kind: "function", source: "treesitter" })],
        edges: [],
      });
      const scipRows = {
        content_hash: hash,
        lang: "ts",
        byte_size,
        symbols: [makeSymbol(hash, 0, "root", { kind: "function", source: "scip" })],
        edges: [makeEdge(hash, 0, 0, "helper", { source: "scip" })],
      };

      led.mergeBlobParseRows(scipRows);
      led.mergeBlobParseRows(scipRows);

      const rows = /** @type {Array<{ source: string, c: number }>} */ (
        led._unsafeDb().prepare(
          "SELECT source, COUNT(*) AS c FROM blob_edges WHERE from_content_hash = ? GROUP BY source",
        ).all(hash)
      );
      assert.deepEqual(rows.map((row) => [row.source, row.c]), [["scip", 1]]);
    } finally {
      led.close();
    }
  });

  it("concurrent appends on different branches do not corrupt seqs (seed-locks replacement)", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "concurrent.db") });
    try {
      const N = 20;
      // Pre-ingest N blobs.
      const blobs = Array.from({ length: N }, (_, i) => makeBlob(`v${i}`));
      for (const b of blobs) {
        led.ingestBlob({ content_hash: b.hash, lang: "ts", byte_size: b.byte_size, symbols: [], edges: [] });
      }
      led.forkBranch("wi-a", "main", 0);
      led.forkBranch("wi-b", "main", 0);

      // Interleave appends on three branches in a tight loop. better-sqlite3
      // serializes at the file lock; this verifies seq numbering remains
      // monotonic per-branch and that no two appends share a (branch, seq)
      // primary key.
      const branches = ["main", "wi-a", "wi-b"];
      for (let i = 0; i < N; i++) {
        const branch = branches[i % branches.length];
        led.append({
          branch,
          op: "add",
          repo_rel_path: `src/${branch}-${i}.ts`,
          before_content_hash: null,
          after_content_hash: blobs[i].hash,
        });
      }

      const mainSeqs = led.tail("main", 0).map((e) => e.seq);
      const aSeqs = led.tail("wi-a", 0).map((e) => e.seq);
      const bSeqs = led.tail("wi-b", 0).map((e) => e.seq);
      // Each branch's seqs must be a strictly-increasing prefix of integers.
      for (const seqs of [mainSeqs, aSeqs, bSeqs]) {
        for (let i = 0; i < seqs.length; i++) {
          assert.equal(seqs[i], i + 1, "per-branch seq must be monotonic 1..n");
        }
      }
      assert.equal(mainSeqs.length + aSeqs.length + bSeqs.length, N);
    } finally {
      led.close();
    }
  });
});
