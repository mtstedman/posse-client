import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  AsyncGateBusyError,
  AsyncResourceGate,
  AsyncWorkQueue,
  KeyedAsyncGate,
  ProtectedAssetGate,
} from "../lib/shared/concurrency/functions/async-gate.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitFor(predicate, label = "condition") {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > 1000) {
      throw new Error(`Timed out waiting for ${label}`);
    }
    await sleep(5);
  }
}

describe("ProtectedAssetGate", () => {
  it("makes blocking work wait for already-running non-blocking reads", async () => {
    const gate = new ProtectedAssetGate({ name: "test asset" });
    const events = [];
    let releaseRead;

    const read = gate.runNonBlocking("db", async () => {
      events.push("read-start");
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
      events.push("read-end");
      return "read";
    }, { label: "read" });

    await sleep(10);
    const write = gate.runBlocking("db", async () => {
      events.push("write");
      return "write";
    }, { label: "write", waitMs: 1000 });

    await sleep(25);
    assert.deepEqual(events, ["read-start"]);

    releaseRead();
    assert.equal(await write, "write");
    assert.equal(await read, "read");
    assert.deepEqual(events, ["read-start", "read-end", "write"]);
  });

  it("latches non-blocking reads when blocking work is pending", async () => {
    const gate = new ProtectedAssetGate({ name: "test asset" });
    const events = [];
    let releaseRead;

    const read = gate.runNonBlocking("db", async () => {
      events.push("read-start");
      await new Promise((resolve) => {
        releaseRead = resolve;
      });
      events.push("read-end");
    }, { label: "read" });

    await sleep(10);
    const write = gate.runBlocking("db", async () => {
      events.push("write");
      return "write";
    }, {
      label: "write",
      waitMs: 1000,
    });

    const lateRead = gate.runNonBlocking("db", async () => {
      events.push("late-read");
      return "late-read";
    }, { label: "late-read", waitMs: 1000 });

    await sleep(25);
    assert.deepEqual(events, ["read-start"]);

    releaseRead();
    assert.equal(await write, "write");
    assert.equal(await lateRead, "late-read");
    await read;
    assert.deepEqual(events, ["read-start", "read-end", "write", "late-read"]);
  });

  it("promotes readers queued during an active writer ahead of queued writers", async () => {
    const gate = new ProtectedAssetGate({ name: "test asset" });
    const events = [];
    let releaseWrite1;

    const write1 = gate.runBlocking("db", async () => {
      events.push("write1-start");
      await new Promise((resolve) => {
        releaseWrite1 = resolve;
      });
      events.push("write1-end");
      return "write1";
    }, { label: "write1", waitMs: 1000 });

    await waitFor(() => releaseWrite1, "first writer to start");

    const write2 = gate.runBlocking("db", async () => {
      events.push("write2");
      return "write2";
    }, { label: "write2", waitMs: 1000 });

    const lateRead = gate.runNonBlocking("db", async () => {
      events.push("late-read");
      return "late-read";
    }, { label: "late-read", waitMs: 1000 });

    await sleep(10);
    assert.deepEqual(events, ["write1-start"]);

    releaseWrite1();
    assert.equal(await write1, "write1");
    assert.equal(await lateRead, "late-read");
    assert.equal(await write2, "write2");
    assert.equal(await gate.runNonBlocking("db", async () => "after-writers", { label: "after-writers" }), "after-writers");
    assert.deepEqual(events, [
      "write1-start",
      "write1-end",
      "late-read",
      "write2",
    ]);
  });

  it("fifo policy: a reader arriving after a queued writer waits behind it", async () => {
    const gate = new ProtectedAssetGate({ name: "test asset", policy: "fifo" });
    const events = [];
    let releaseWrite1;

    const write1 = gate.runBlocking("db", async () => {
      events.push("write1-start");
      await new Promise((resolve) => {
        releaseWrite1 = resolve;
      });
      events.push("write1-end");
      return "write1";
    }, { label: "write1", waitMs: 1000 });

    await waitFor(() => releaseWrite1, "first writer to start");

    const write2 = gate.runBlocking("db", async () => {
      events.push("write2");
      return "write2";
    }, { label: "write2", waitMs: 1000 });

    const lateRead = gate.runNonBlocking("db", async () => {
      events.push("late-read");
      return "late-read";
    }, { label: "late-read", waitMs: 1000 });

    await sleep(10);
    assert.deepEqual(events, ["write1-start"]);

    releaseWrite1();
    assert.equal(await write1, "write1");
    assert.equal(await write2, "write2");
    assert.equal(await lateRead, "late-read");
    assert.deepEqual(events, ["write1-start", "write1-end", "write2", "late-read"]);
  });

  it("fifo policy: consecutive readers still run concurrently", async () => {
    const gate = new ProtectedAssetGate({ name: "test asset", policy: "fifo" });
    const events = [];
    let releaseRead1;
    let releaseRead2;

    const read1 = gate.runNonBlocking("db", async () => {
      events.push("read1-start");
      await new Promise((resolve) => {
        releaseRead1 = resolve;
      });
      events.push("read1-end");
      return "read1";
    }, { label: "read1", waitMs: 1000 });

    const read2 = gate.runNonBlocking("db", async () => {
      events.push("read2-start");
      await new Promise((resolve) => {
        releaseRead2 = resolve;
      });
      events.push("read2-end");
      return "read2";
    }, { label: "read2", waitMs: 1000 });

    await waitFor(() => releaseRead1 && releaseRead2, "both readers to start");
    assert.deepEqual(events, ["read1-start", "read2-start"]);

    releaseRead1();
    releaseRead2();
    await Promise.all([read1, read2]);
  });

  it("times out latched readers when writers do not release", async () => {
    const gate = new ProtectedAssetGate({ name: "test asset" });
    let releaseWrite;

    const write = gate.runBlocking("db", async () => {
      await new Promise((resolve) => {
        releaseWrite = resolve;
      });
    }, { label: "write", waitMs: 1000 });

    await waitFor(() => releaseWrite, "writer to start");

    await assert.rejects(
      gate.runNonBlocking("db", async () => "late-read", { label: "late-read", waitMs: 1 }),
      AsyncGateBusyError,
    );

    releaseWrite();
    await write;
  });

  it("awaits onBeforeRelease before the next waiter can acquire the asset", async () => {
    const gate = new ProtectedAssetGate({ name: "test asset" });
    const events = [];
    let releaseCleanup;

    const write = gate.runBlocking(
      "db",
      async () => {
        events.push("write");
        return "write";
      },
      {
        label: "write",
        waitMs: 1000,
        onBeforeRelease: async () => {
          events.push("cleanup-start");
          await new Promise((resolve) => {
            releaseCleanup = resolve;
          });
          events.push("cleanup-end");
        },
      },
    );

    await waitFor(() => releaseCleanup, "cleanup hook to start");

    const read = gate.runNonBlocking("db", async () => {
      events.push("read");
      return "read";
    }, { label: "read", waitMs: 1000 });

    await sleep(10);
    assert.deepEqual(events, ["write", "cleanup-start"]);

    releaseCleanup();
    assert.equal(await write, "write");
    assert.equal(await read, "read");
    assert.deepEqual(events, ["write", "cleanup-start", "cleanup-end", "read"]);
  });
});

describe("AsyncWorkQueue", () => {
  it("runs work FIFO with a single worker", async () => {
    const queue = new AsyncWorkQueue({ name: "test queue" });
    const events = [];

    const first = queue.run(async () => {
      events.push("first");
      return "first";
    }, { label: "first", waitMs: 1000 });
    const second = queue.run(async () => {
      events.push("second");
      return "second";
    }, { label: "second", waitMs: 1000 });

    assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
    assert.deepEqual(events, ["first", "second"]);
  });

  it("rejects waitMs 0 immediately when work cannot start", async () => {
    const queue = new AsyncWorkQueue({ name: "test queue" });
    let releaseFirst;
    let cancelled = false;

    const first = queue.run(async () => {
      await new Promise((resolve) => {
        releaseFirst = resolve;
      });
    }, { label: "first", waitMs: 1000 });

    await waitFor(() => releaseFirst, "first task to start");

    await assert.rejects(
      queue.run(async () => "second", {
        label: "second",
        waitMs: 0,
        onCancel: () => {
          cancelled = true;
        },
      }),
      AsyncGateBusyError,
    );
    assert.equal(cancelled, true);

    releaseFirst();
    await first;
  });
});

describe("KeyedAsyncGate", () => {
  it("serializes matching keys and lets different keys run independently", async () => {
    const gate = new KeyedAsyncGate({ name: "test keyed gate" });
    const events = [];
    let releaseA1;
    let releaseB1;

    const a1 = gate.run("a", async () => {
      events.push("a1-start");
      await new Promise((resolve) => {
        releaseA1 = resolve;
      });
      events.push("a1-end");
    }, { label: "a1", waitMs: 1000 });

    const a2 = gate.run("a", async () => {
      events.push("a2");
    }, { label: "a2", waitMs: 1000 });

    const b1 = gate.run("b", async () => {
      events.push("b1-start");
      await new Promise((resolve) => {
        releaseB1 = resolve;
      });
      events.push("b1-end");
    }, { label: "b1", waitMs: 1000 });

    await waitFor(() => releaseA1 && releaseB1, "first tasks for each key to start");
    assert.deepEqual(events, ["a1-start", "b1-start"]);

    releaseB1();
    await b1;
    assert.deepEqual(events, ["a1-start", "b1-start", "b1-end"]);

    releaseA1();
    await Promise.all([a1, a2]);
    assert.deepEqual(events, ["a1-start", "b1-start", "b1-end", "a1-end", "a2"]);
  });

  it("cleans up idle key queues after work drains", async () => {
    const gate = new KeyedAsyncGate({ name: "test keyed gate" });

    assert.equal(await gate.run("db", async () => "ok", { label: "work", waitMs: 1000 }), "ok");
    await waitFor(() => gate.snapshot().keys.length === 0, "idle keyed queue cleanup");
    assert.deepEqual(gate.snapshot().keys, []);
  });
});

describe("AsyncResourceGate", () => {
  it("exposes a release promise for blocking work", async () => {
    const gate = new AsyncResourceGate({ name: "test resource" });
    const events = [];
    let releaseWrite;

    const handle = gate.writeWithRelease(
      "repo",
      async () => {
        events.push("write-start");
        await new Promise((resolve) => {
          releaseWrite = resolve;
        });
        events.push("write-end");
        return "merged";
      },
      { label: "git.merge", barrierName: "git merge main", releaseWaitMs: 1000 },
    );

    await waitFor(() => releaseWrite, "writer to start");
    assert.equal(handle.barrier.name, "git merge main");
    assert.equal(handle.released.waitingOn?.[0]?.name, "git merge main");
    let released = false;
    const releasedProbe = handle.released.then((info) => {
      released = true;
      events.push("released");
      return info;
    });

    await sleep(10);
    assert.equal(released, false);

    releaseWrite();
    assert.equal(await handle.result, "merged");
    const info = await releasedProbe;
    assert.equal(info.idle, false);
    assert.equal(info.releases.length, 1);
    assert.equal(info.releases[0].name, "git merge main");
    assert.equal(info.releases[0].status, "fulfilled");
    assert.deepEqual(events, ["write-start", "write-end", "released"]);
  });

  it("lets consumers await a received barrier handle or resource key", async () => {
    const gate = new AsyncResourceGate({ name: "test resource" });
    const events = [];
    let releaseWrite;

    const handle = gate.writeWithRelease("repo", async () => {
      events.push("write-start");
      await new Promise((resolve) => {
        releaseWrite = resolve;
      });
      events.push("write-end");
    }, { label: "resource.write", releaseWaitMs: 1000 });

    await waitFor(() => releaseWrite, "writer to start");
    let handleDone = false;
    let resourceDone = false;
    const byHandle = gate.awaitBarrier(handle.barrier, { waitMs: 1000 }).then(() => {
      handleDone = true;
      events.push("handle-release");
    });
    const byResource = gate.awaitBarrier("repo", { waitMs: 1000 }).then(() => {
      resourceDone = true;
      events.push("resource-release");
    });

    await sleep(10);
    assert.equal(handleDone, false);
    assert.equal(resourceDone, false);

    releaseWrite();
    await handle.result;
    await Promise.all([byHandle, byResource]);
    assert.deepEqual(events, ["write-start", "write-end", "handle-release", "resource-release"]);
  });

  it("release promises resolve when blocking work throws", async () => {
    const gate = new AsyncResourceGate({ name: "test resource" });
    const handle = gate.writeWithRelease(
      "repo",
      async () => {
        throw new Error("merge failed");
      },
      { label: "git.merge", barrierKey: "git.merge:repo:main", releaseWaitMs: 1000 },
    );

    await assert.rejects(handle.result, /merge failed/);
    const info = await handle.released;
    assert.equal(info.releases.length, 1);
    assert.equal(info.releases[0].status, "rejected");
    assert.match(String(info.releases[0].error?.message || info.releases[0].error), /merge failed/);
  });

  it("releases barriers if the underlying enqueue throws synchronously", () => {
    const enqueueErr = new Error("enqueue failed");
    const gate = new AsyncResourceGate({
      name: "test resource",
      gate: {
        runBlocking() {
          throw enqueueErr;
        },
        runNonBlocking() {
          throw new Error("not used");
        },
        snapshot() {
          return { name: "fake gate", keys: [] };
        },
      },
    });

    assert.throws(
      () => gate.write("repo", async () => "never", { label: "write" }),
      /enqueue failed/,
    );
    assert.deepEqual(gate.snapshot().barriers, []);
  });

  it("waitForRelease resolves immediately when no blocking work is registered", async () => {
    const gate = new AsyncResourceGate({ name: "test resource" });
    const info = await gate.waitForRelease("idle-resource", { waitMs: 1000 });
    assert.equal(info.idle, true);
    assert.deepEqual(info.releases, []);
  });

  it("clears the waitForRelease timeout after blocking work releases", async () => {
    const gate = new AsyncResourceGate({ name: "test resource" });
    const originalSetTimeout = globalThis.setTimeout;
    const originalClearTimeout = globalThis.clearTimeout;
    const timers = [];

    globalThis.setTimeout = (fn, ms, ...args) => {
      const timer = {
        fn,
        ms,
        args,
        cleared: false,
        unref() {},
      };
      timers.push(timer);
      return /** @type {any} */ (timer);
    };
    globalThis.clearTimeout = (timer) => {
      if (timer && typeof timer === "object") timer.cleared = true;
    };

    try {
      const handle = gate.writeWithRelease("repo", async () => "done", {
        label: "write",
        waitMs: 1000,
        releaseWaitMs: 1234,
      });

      assert.equal(await handle.result, "done");
      await handle.released;

      const releaseTimer = timers.find((timer) => timer.ms === 1234);
      assert.ok(releaseTimer, "expected waitForRelease to create a timeout");
      assert.equal(releaseTimer.cleared, true);
    } finally {
      globalThis.setTimeout = originalSetTimeout;
      globalThis.clearTimeout = originalClearTimeout;
    }
  });
});
