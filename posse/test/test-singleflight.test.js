import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createSingleflight } from "../lib/shared/concurrency/functions/singleflight.js";

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

describe("createSingleflight", () => {
  it("coalesces concurrent identical keys onto one execution", async () => {
    const sf = createSingleflight();
    let calls = 0;
    const gate = deferred();
    const factory = () => { calls += 1; return gate.promise; };

    const a = sf.run("k", factory);
    const b = sf.run("k", factory);
    const c = sf.run("k", factory);

    assert.equal(calls, 1, "factory ran exactly once for three concurrent callers");
    assert.equal(sf.has("k"), true);

    gate.resolve("shared-result");
    const [ra, rb, rc] = await Promise.all([a, b, c]);
    assert.equal(ra, "shared-result");
    assert.equal(rb, "shared-result");
    assert.equal(rc, "shared-result");
  });

  it("does not coalesce different keys", async () => {
    const sf = createSingleflight();
    let calls = 0;
    await Promise.all([
      sf.run("a", () => { calls += 1; return Promise.resolve(1); }),
      sf.run("b", () => { calls += 1; return Promise.resolve(2); }),
    ]);
    assert.equal(calls, 2);
  });

  it("clears the key after settle so the next caller re-runs", async () => {
    const sf = createSingleflight();
    let calls = 0;
    await sf.run("k", () => { calls += 1; return Promise.resolve("x"); });
    assert.equal(sf.has("k"), false, "key removed after the shared promise settled");
    assert.equal(sf.size(), 0);
    await sf.run("k", () => { calls += 1; return Promise.resolve("x"); });
    assert.equal(calls, 2, "a fresh call after settle re-executes");
  });

  it("shares rejections with all coalesced callers and then clears the key", async () => {
    const sf = createSingleflight();
    const gate = deferred();
    let calls = 0;
    const factory = () => { calls += 1; return gate.promise; };
    const a = sf.run("k", factory);
    const b = sf.run("k", factory);
    assert.equal(calls, 1);

    const err = new Error("boom");
    gate.reject(err);
    await assert.rejects(a, /boom/);
    await assert.rejects(b, /boom/);
    assert.equal(sf.has("k"), false, "key cleared even after rejection");
  });

  it("turns a synchronous throw in the factory into a rejected shared promise", async () => {
    const sf = createSingleflight();
    const p = sf.run("k", () => { throw new Error("sync-throw"); });
    await assert.rejects(p, /sync-throw/);
    assert.equal(sf.has("k"), false);
  });

  it("never coalesces when key is null (always runs)", async () => {
    const sf = createSingleflight();
    let calls = 0;
    await Promise.all([
      sf.run(null, () => { calls += 1; return Promise.resolve(1); }),
      sf.run(null, () => { calls += 1; return Promise.resolve(1); }),
    ]);
    assert.equal(calls, 2);
    assert.equal(sf.size(), 0);
  });
});
