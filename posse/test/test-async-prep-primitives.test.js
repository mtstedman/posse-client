import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  acquireWorktreeLockAsync,
} from "../lib/domains/git/functions/worktree.js";
import { isAbortError, yieldNow } from "../lib/domains/runtime/functions/yield.js";

describe("async prep primitives", () => {
  it("waits for a contended worktree lock without blocking timer ticks", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-async-lock-"));
    const lockPath = path.join(tmpDir, "held.lock");
    const held = await acquireWorktreeLockAsync(lockPath);
    assert.equal(held.acquired, true);

    let ticks = 0;
    const ticker = setInterval(() => { ticks++; }, 20);
    setTimeout(() => {
      held.releaseAsync().catch(() => {});
    }, 180);

    try {
      const waited = await acquireWorktreeLockAsync(lockPath, { waitMs: 1000, pollMs: 25 });
      assert.equal(waited.acquired, true);
      await waited.releaseAsync();
      assert.ok(ticks >= 3, `expected timer ticks during async lock wait, saw ${ticks}`);
    } finally {
      clearInterval(ticker);
      await held.releaseAsync();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("recovers stale async worktree locks by age", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-stale-lock-"));
    const lockPath = path.join(tmpDir, "stale.lock");
    fs.writeFileSync(lockPath, "{bad json", "utf8");
    const old = new Date(Date.now() - 10_000);
    fs.utimesSync(lockPath, old, old);

    try {
      const lock = await acquireWorktreeLockAsync(lockPath, { waitMs: 500, pollMs: 10, staleMs: 1 });
      assert.equal(lock.acquired, true);
      await lock.releaseAsync();
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not reclaim lock files whose filesystem mtime is in the future", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-future-lock-"));
    const lockPath = path.join(tmpDir, "future.lock");
    fs.writeFileSync(lockPath, "{bad json", "utf8");
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(lockPath, future, future);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("future lock still held")), 40);

    try {
      await assert.rejects(
        acquireWorktreeLockAsync(lockPath, { pollMs: 10, staleMs: 1, signal: controller.signal }),
        (err) => isAbortError(err) && err.message === "future lock still held",
      );
      assert.equal(fs.existsSync(lockPath), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("does not reclaim same-process worktree locks without an owner token", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-live-owner-lock-"));
    const lockPath = path.join(tmpDir, "live-owner.lock");
    fs.writeFileSync(lockPath, JSON.stringify({ pid: process.pid, createdAt: new Date(Date.now() - 60_000).toISOString() }), "utf8");
    const old = new Date(Date.now() - 60_000);
    fs.utimesSync(lockPath, old, old);

    try {
      const lock = await acquireWorktreeLockAsync(lockPath, { waitMs: 500, pollMs: 10, staleMs: 1 });
      assert.equal(lock.acquired, false);
      assert.equal(fs.existsSync(lockPath), true);
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("aborts async worktree lock waits and releases no new lock", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-abort-lock-"));
    const lockPath = path.join(tmpDir, "abort.lock");
    const held = await acquireWorktreeLockAsync(lockPath);
    const controller = new AbortController();
    setTimeout(() => controller.abort(new Error("stop waiting")), 30);

    try {
      await assert.rejects(
        acquireWorktreeLockAsync(lockPath, { waitMs: 1000, pollMs: 25, signal: controller.signal }),
        (err) => isAbortError(err) && err.message === "stop waiting",
      );
      assert.equal(fs.existsSync(lockPath), true);
    } finally {
      await held.releaseAsync();
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("aborts async worktree lock acquisition after open before metadata write", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-abort-open-lock-"));
    const lockPath = path.join(tmpDir, "abort-open.lock");
    const controller = new AbortController();
    const originalOpen = fs.promises.open;
    let writes = 0;

    fs.promises.open = async (...args) => {
      const handle = await originalOpen(...args);
      const originalWriteFile = handle.writeFile.bind(handle);
      handle.writeFile = async (...writeArgs) => {
        writes++;
        return originalWriteFile(...writeArgs);
      };
      controller.abort(new Error("abort after open"));
      return handle;
    };

    try {
      await assert.rejects(
        acquireWorktreeLockAsync(lockPath, { signal: controller.signal }),
        (err) => isAbortError(err) && err.message === "abort after open",
      );
      assert.equal(writes, 0);
      assert.equal(fs.existsSync(lockPath), false);
    } finally {
      fs.promises.open = originalOpen;
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("normalizes plain Error abort reasons to AbortError", async () => {
    const controller = new AbortController();
    controller.abort(new Error("plain stop"));

    assert.throws(
      () => yieldNow({ signal: controller.signal }),
      (err) => isAbortError(err) && err.message === "plain stop" && err.cause === controller.signal.reason,
    );
  });

  // ATLAS v2 seeds work-item graphs from ledger views rather than copying
  // sidecar graph DB files, so seedWorkItemAtlasGraphFromPrimaryAsync is a
  // no-op that performs no fs.copyFile and has no abortable copy loop. The
  // earlier "normalizes falsy ATLAS seed abort reasons" case asserted the
  // removed copy/abort behavior and was dropped; abort-reason normalization is
  // still covered by the yieldNow case above.
});
