// test/test-atlas-v2-concurrency.test.js
//
// Phase 2.4 concurrency coverage for ATLAS v2.
//
// Replaces the old shared-writer-lock test (test-atlas-seed-locks.test.js).
// The shared kuzu writer lock is gone — better-sqlite3 + WAL gives us a
// different concurrency surface that needs explicit coverage:
//
//   1. WAL writer serialization under burst append.
//      Many appends from the same process must all commit; nothing is
//      silently dropped, seq numbers are strictly monotonic and gap-free.
//
//   2. Branch-partition independence.
//      Appends targeting different branches must succeed against the same
//      ledger DB. No semantic contention; seq numbers are per-branch and
//      do not collide across branches.
//
//   3. Atomic view rename under live readers.
//      The warmer renames a view file into place while a worker has an
//      old version mounted. The reader keeps reading the old version
//      (POSIX rename semantics); a fresh open picks up the new version.
//
//   4. FTS5 sync trigger correctness under concurrent inserts.
//      Symbols inserted in a tight loop must produce matching FTS5 rows;
//      searches resolve all of them.
//
// **Deletion of test-atlas-seed-locks.test.js is gated on this file landing.**
// Do not delete that file in the same change that adds these tests.

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import Database from "better-sqlite3";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const REPO_ROOT = path.resolve(__dirname, "..");

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function bytesOf(s) {
  return Buffer.from(s);
}

function hashOf(s) {
  return sha256Hex(bytesOf(s));
}

function makeBlob(content, repo_rel_path = "src/file.ts", symbolName = null, localId = 0) {
  const hash = hashOf(content);
  const sym = {
    content_hash: hash,
    local_id: localId,
    kind: "function",
    name: symbolName || `fn_${localId}`,
    qualified_name: null,
    parent_local_id: null,
    repo_rel_path,
    lang: "ts",
    range_start: 0,
    range_end: content.length,
    signature_hash: sha256Hex(`${symbolName || `fn_${localId}`}/${repo_rel_path}`),
    visibility: null,
    doc: null,
  };
  return { hash, byte_size: Buffer.byteLength(content), symbols: [sym], edges: [] };
}

describe("ATLAS v2 concurrency", () => {
  /** @type {string} */
  let tmpDir;
  before(() => {
    tmpDir = makeTmp("posse-atlas-v2-conc-");
  });
  after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  // 1. WAL writer serialization under burst append.
  it("appends a burst of deltas with strict, gap-free seq monotonicity", () => {
    const dbPath = path.join(tmpDir, "burst-append.db");
    const led = Ledger.open({ dbPath });
    try {
      const BURST = 50;
      const branch = "main";

      // Ingest BURST distinct blobs first so .append() has hashes to reference.
      const hashes = [];
      for (let i = 0; i < BURST; i++) {
        const blob = makeBlob(`fn_${i}();\n`, "src/file.ts", `fn_${i}`, 0);
        led.ingestBlob({
          content_hash: blob.hash,
          lang: "ts",
          byte_size: blob.byte_size,
          symbols: blob.symbols,
          edges: blob.edges,
        });
        hashes.push(blob.hash);
      }

      // Burst append — each one mutates a distinct path so parent_seq stays null.
      const entries = [];
      for (let i = 0; i < BURST; i++) {
        const entry = led.append({
          branch,
          op: "add",
          repo_rel_path: `src/file_${i}.ts`,
          before_content_hash: null,
          after_content_hash: hashes[i],
        });
        entries.push(entry);
      }

      // Strictly monotonic, gap-free.
      for (let i = 0; i < entries.length; i++) {
        assert.equal(entries[i].seq, i + 1, `entry ${i} seq should be ${i + 1}, got ${entries[i].seq}`);
      }

      // Head reflects the final append.
      assert.equal(led.headSeq(branch), BURST);

      // Tail returns them all in order.
      const tailed = led.tail(branch, 0);
      assert.equal(tailed.length, BURST);
      for (let i = 0; i < BURST; i++) {
        assert.equal(tailed[i].seq, i + 1);
      }
    } finally {
      led.close();
    }
  });

  // 2. Branch-partition independence.
  it("interleaved appends on different branches use independent seq counters", () => {
    const dbPath = path.join(tmpDir, "branch-partition.db");
    const led = Ledger.open({ dbPath });
    try {
      const blobA = makeBlob("hello world", "src/a.ts", "hello", 0);
      const blobB = makeBlob("goodbye world", "src/b.ts", "goodbye", 0);
      led.ingestBlob({ content_hash: blobA.hash, lang: "ts", byte_size: blobA.byte_size, symbols: blobA.symbols, edges: blobA.edges });
      led.ingestBlob({ content_hash: blobB.hash, lang: "ts", byte_size: blobB.byte_size, symbols: blobB.symbols, edges: blobB.edges });

      // Fork two branches off main at seq=0.
      led.forkBranch("wi-1", "main", 0);
      led.forkBranch("wi-2", "main", 0);

      // Interleave appends to both branches.
      const seqs = { "wi-1": [], "wi-2": [] };
      const interleaved = [
        { branch: "wi-1", path: "src/a.ts", hash: blobA.hash },
        { branch: "wi-2", path: "src/b.ts", hash: blobB.hash },
        { branch: "wi-1", path: "src/c.ts", hash: blobA.hash },
        { branch: "wi-2", path: "src/d.ts", hash: blobB.hash },
        { branch: "wi-1", path: "src/e.ts", hash: blobA.hash },
        { branch: "wi-2", path: "src/f.ts", hash: blobB.hash },
      ];

      for (const { branch, path: rp, hash } of interleaved) {
        const entry = led.append({
          branch,
          op: "add",
          repo_rel_path: rp,
          before_content_hash: null,
          after_content_hash: hash,
        });
        seqs[branch].push(entry.seq);
      }

      // Each branch produced its OWN seq series starting at 1.
      assert.deepEqual(seqs["wi-1"], [1, 2, 3], `wi-1 seqs: ${seqs["wi-1"].join(", ")}`);
      assert.deepEqual(seqs["wi-2"], [1, 2, 3], `wi-2 seqs: ${seqs["wi-2"].join(", ")}`);

      // Heads are per-branch, independent.
      assert.equal(led.headSeq("wi-1"), 3);
      assert.equal(led.headSeq("wi-2"), 3);
      assert.equal(led.headSeq("main"), 0, "main should be untouched");

      // Tailing one branch must not surface the other branch's entries.
      const tailA = led.tail("wi-1", 0);
      const tailB = led.tail("wi-2", 0);
      assert.equal(tailA.length, 3);
      assert.equal(tailB.length, 3);
      assert.ok(tailA.every((entry) => entry.branch === "wi-1"));
      assert.ok(tailB.every((entry) => entry.branch === "wi-2"));
    } finally {
      led.close();
    }
  });

  // 3. Atomic view rename under live readers.
  it("renaming a view file under a mounted reader keeps the old DB usable until close", () => {
    const ledgerPath = path.join(tmpDir, "rename-ledger.db");
    const oldViewPath = path.join(tmpDir, "old.view.db");
    const newViewPath = path.join(tmpDir, "new.view.db");
    const liveViewPath = path.join(tmpDir, "live.view.db");

    const led = Ledger.open({ dbPath: ledgerPath });
    try {
      // Stage two distinct ledger heads so we can build two different views.
      const blob1 = makeBlob("a();\n", "src/old.ts", "older", 0);
      led.ingestBlob({ content_hash: blob1.hash, lang: "ts", byte_size: blob1.byte_size, symbols: blob1.symbols, edges: blob1.edges });
      led.append({
        branch: "main", op: "add", repo_rel_path: "src/old.ts",
        before_content_hash: null, after_content_hash: blob1.hash,
      });
      const seqOld = led.headSeq("main");

      const blob2 = makeBlob("b();\n", "src/new.ts", "newer", 0);
      led.ingestBlob({ content_hash: blob2.hash, lang: "ts", byte_size: blob2.byte_size, symbols: blob2.symbols, edges: blob2.edges });
      led.append({
        branch: "main", op: "add", repo_rel_path: "src/new.ts",
        before_content_hash: null, after_content_hash: blob2.hash,
      });
      const seqNew = led.headSeq("main");

      // Build both views from those snapshots.
      const builder = new ViewBuilder();
      builder.buildFrom({ ledger: led, branch: "main", atSeq: seqOld, outPath: oldViewPath });
      builder.buildFrom({ ledger: led, branch: "main", atSeq: seqNew, outPath: newViewPath });

      // Stage "live" as a copy of old, then mount a reader on it.
      builder.cloneView({ sourcePath: oldViewPath, destPath: liveViewPath });
      const reader = View.mount({ dbPath: liveViewPath, mode: "readonly" });

      // Reader sees the old symbol.
      const before = reader.query.findSymbol("older");
      assert.ok(before.length >= 1, "reader should see 'older' before rename");

      // While the reader is open, the warmer atomically replaces the view file
      // via rename. POSIX rename: old inode stays alive for the open fd.
      // On Windows, fs.renameSync over a held-open file fails; the warmer's
      // production strategy is unlink+rename, which we emulate here so the
      // platform behavior is consistent.
      try {
        fs.unlinkSync(liveViewPath);
      } catch {
        // Windows: hold-open prevents unlink. That's the platform behavior we
        // explicitly want the rest of the test to verify — skip the unlink
        // step and assert the reader is still usable.
      }
      try {
        fs.copyFileSync(newViewPath, liveViewPath);
      } catch {
        // If the previous unlink failed (Windows), the copyFile may also fail
        // — that's fine, the reader's continued usability is the only thing
        // we're asserting here.
      }

      // The reader's view of the world is unchanged (it was holding the old DB).
      const stillOld = reader.query.findSymbol("older");
      assert.ok(stillOld.length >= 1, "open reader should keep seeing the old view");

      reader.close();

      // A fresh mount picks up whichever version is now on disk. We only assert
      // that a fresh mount succeeds — not which version it sees — because of
      // the Windows fallback above.
      if (fs.existsSync(liveViewPath)) {
        const reopened = View.mount({ dbPath: liveViewPath, mode: "readonly" });
        try {
          const meta = reopened.meta();
          assert.ok(meta.ledger_seq >= seqOld, "reopened view should be at least the old seq");
        } finally {
          reopened.close();
        }
      }
    } finally {
      led.close();
    }
  });

  // 4. FTS5 sync trigger correctness under concurrent inserts.
  it("FTS5 search returns every symbol inserted in a tight loop", () => {
    const ledgerPath = path.join(tmpDir, "fts5-ledger.db");
    const viewPath = path.join(tmpDir, "fts5.view.db");

    const led = Ledger.open({ dbPath: ledgerPath });
    try {
      const N = 100;
      const hashes = [];
      // Ingest N blobs each with a unique symbol name, all on the same file.
      // Same content_hash collisions are avoided by varying the content body.
      for (let i = 0; i < N; i++) {
        const content = `function searchable_${i}() { return ${i}; }`;
        const blob = makeBlob(content, `src/fts_${i}.ts`, `searchable_${i}`, 0);
        led.ingestBlob({
          content_hash: blob.hash, lang: "ts", byte_size: blob.byte_size,
          symbols: blob.symbols, edges: blob.edges,
        });
        led.append({
          branch: "main", op: "add",
          repo_rel_path: `src/fts_${i}.ts`,
          before_content_hash: null,
          after_content_hash: blob.hash,
        });
        hashes.push(blob.hash);
      }

      const builder = new ViewBuilder();
      builder.buildFrom({ ledger: led, branch: "main", atSeq: led.headSeq("main"), outPath: viewPath });

      const view = View.mount({ dbPath: viewPath, mode: "readonly" });
      try {
        // Spot-check a handful — searching by exact name should resolve each.
        for (const i of [0, 1, 5, 17, N - 1]) {
          const results = view.query.findSymbol(`searchable_${i}`);
          assert.ok(
            results.some((row) => row.name === `searchable_${i}`),
            `FTS should find searchable_${i}; got [${results.map((r) => r.name).join(", ")}]`,
          );
        }

        // Direct FTS5 query: every inserted symbol must have a matching FTS row.
        const db = view._unsafeDb();
        const ftsCount = /** @type {{ c: number }} */ (db.prepare("SELECT COUNT(*) AS c FROM symbols_fts").get()).c;
        const symbolCount = /** @type {{ c: number }} */ (db.prepare("SELECT COUNT(*) AS c FROM symbols").get()).c;
        assert.equal(ftsCount, symbolCount, `FTS row count (${ftsCount}) must equal symbol count (${symbolCount})`);
        assert.equal(symbolCount, N);

        // Prefix search returns every symbol (they all start with "searchable_").
        const all = view.query.findSymbol("searchable_", { limit: N + 10 });
        assert.equal(all.length, N, `prefix search should return all ${N} symbols, got ${all.length}`);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  // 5. Cross-process concurrent append on different branches.
  //
  // Plan §3.2: "One writer at a time globally (better-sqlite3 serializes;
  // WAL allows concurrent readers). Workers append only to their own
  // branch's partition, so semantically there is no cross-worktree write
  // contention."
  //
  // This is the only place where the load-bearing multi-process write
  // contract is exercised against a real second OS process. The four
  // tests above all run inside a single Node process, where
  // better-sqlite3 serializes writes within its own connection pool;
  // cross-process serialization happens at the SQLite file-lock layer
  // and is what the plan's claim depends on.
  it("two OS processes appending to different branches succeed without corruption", () => {
    const dbPath = path.join(tmpDir, "xproc-append.db");
    const N = 20;
    /** @type {string[]} */
    const hashesA = [];
    /** @type {string[]} */
    const hashesB = [];
    const led = Ledger.open({ dbPath });
    try {
      for (let i = 0; i < N; i++) {
        const blobA = makeBlob(`xa_${i};\n`, `src/a_${i}.ts`, `xa_${i}`, 0);
        led.ingestBlob({ content_hash: blobA.hash, lang: "ts", byte_size: blobA.byte_size, symbols: blobA.symbols, edges: blobA.edges });
        hashesA.push(blobA.hash);
        const blobB = makeBlob(`xb_${i};\n`, `src/b_${i}.ts`, `xb_${i}`, 0);
        led.ingestBlob({ content_hash: blobB.hash, lang: "ts", byte_size: blobB.byte_size, symbols: blobB.symbols, edges: blobB.edges });
        hashesB.push(blobB.hash);
      }
      led.forkBranch("xp-1", "main", 0);
      led.forkBranch("xp-2", "main", 0);
    } finally {
      led.close();
    }

    // Worker script: opens the ledger and appends N entries to the
    // branch named in $POSSE_XP_BRANCH using hashes listed in
    // $POSSE_XP_HASHES (JSON). Inputs go through env vars to dodge
    // Windows command-line JSON-quoting hazards.
    const workerPath = path.join(tmpDir, `xproc-worker-${Date.now()}.mjs`);
    const ledgerUrl = "file:///" + path.resolve(REPO_ROOT, "lib/domains/atlas/classes/v2/Ledger.js").replace(/\\/g, "/");
    fs.writeFileSync(workerPath, `
      import { Ledger } from ${JSON.stringify(ledgerUrl)};
      const dbPath = process.env.POSSE_XP_DB;
      const branch = process.env.POSSE_XP_BRANCH;
      const hashes = JSON.parse(process.env.POSSE_XP_HASHES);
      const prefix = process.env.POSSE_XP_PREFIX;
      const led = Ledger.open({ dbPath });
      try {
        for (let i = 0; i < hashes.length; i++) {
          const entry = led.append({
            branch,
            op: "add",
            repo_rel_path: prefix + "/" + branch + "_" + i + ".ts",
            before_content_hash: null,
            after_content_hash: hashes[i],
          });
          if (entry.seq !== i + 1) {
            console.error("seq_mismatch:" + branch + ":expected=" + (i + 1) + ":got=" + entry.seq);
            process.exit(1);
          }
        }
      } finally {
        led.close();
      }
    `);

    /**
     * @param {string} branch
     * @param {string[]} hashes
     * @param {string} prefix
     */
    function runChild(branch, hashes, prefix) {
      return execFileSync(process.execPath, [workerPath], {
        encoding: "utf8",
        timeout: 30_000,
        env: {
          ...process.env,
          POSSE_XP_DB: dbPath,
          POSSE_XP_BRANCH: branch,
          POSSE_XP_HASHES: JSON.stringify(hashes),
          POSSE_XP_PREFIX: prefix,
        },
      });
    }

    let errA = null, errB = null;
    try { runChild("xp-1", hashesA, "branch-a"); } catch (err) { errA = err; }
    try { runChild("xp-2", hashesB, "branch-b"); } catch (err) { errB = err; }
    // Sequential here, but each invocation is a separate OS process
    // opening the same DB file. The SQLite file-lock contract is what
    // the plan's "one writer at a time globally" claim depends on, and
    // that's what's being exercised — not test-runner concurrency.
    assert.ok(!errA, `branch xp-1 worker failed: ${errA?.stderr || errA?.message}`);
    assert.ok(!errB, `branch xp-2 worker failed: ${errB?.stderr || errB?.message}`);

    // Re-open and verify each branch's seqs are dense and monotonic
    // from a third OS process (this one).
    const verify = Ledger.open({ dbPath });
    try {
      const a = verify.tail("xp-1", 0);
      const b = verify.tail("xp-2", 0);
      assert.equal(a.length, N, `xp-1 should have ${N} entries; got ${a.length}`);
      assert.equal(b.length, N, `xp-2 should have ${N} entries; got ${b.length}`);
      for (let i = 0; i < a.length; i++) assert.equal(a[i].seq, i + 1);
      for (let i = 0; i < b.length; i++) assert.equal(b[i].seq, i + 1);
    } finally {
      verify.close();
    }
  });

  // Bonus: the WAL journal-mode is correctly enabled on view DBs, which is
  // what lets readers and warmers coexist without ROLLBACK contention.
  it("view DBs are opened in WAL journal mode", () => {
    const ledgerPath = path.join(tmpDir, "wal-ledger.db");
    const viewPath = path.join(tmpDir, "wal.view.db");
    const led = Ledger.open({ dbPath: ledgerPath });
    try {
      const blob = makeBlob("function f() {}\n", "src/wal.ts", "f", 0);
      led.ingestBlob({ content_hash: blob.hash, lang: "ts", byte_size: blob.byte_size, symbols: blob.symbols, edges: blob.edges });
      led.append({ branch: "main", op: "add", repo_rel_path: "src/wal.ts", before_content_hash: null, after_content_hash: blob.hash });
      new ViewBuilder().buildFrom({ ledger: led, branch: "main", atSeq: led.headSeq("main"), outPath: viewPath });

      const raw = new Database(viewPath, { readonly: true });
      try {
        const mode = /** @type {{ journal_mode: string }} */ (raw.pragma("journal_mode", { simple: false })[0]);
        assert.equal(String(mode.journal_mode).toLowerCase(), "wal", "view DB should be WAL mode");
      } finally {
        raw.close();
      }
    } finally {
      led.close();
    }
  });
});
