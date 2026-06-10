// Functional coverage for the shared researcher chain-read ledger that both the
// embedded OpenAI/Grok runtime and the deterministic MCP server instantiate.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { createChainLedger } from "../lib/functions/tools/chain-ledger.js";

function fakeReader(contentByPath) {
  return (args) => {
    const p = String(args.path || "");
    if (!(p in contentByPath)) return `Error: ${p} not found`;
    return contentByPath[p];
  };
}

describe("chain ledger", () => {
  it("locks after chain_read and unlocks on chain_verdict", () => {
    const ledger = createChainLedger({ readFile: fakeReader({ "a.js": "contents of a" }), cwd: "/repo" });

    const read = ledger.chainRead({ path: "a.js" });
    assert.match(read, /audit ledger: 0 relevant, 0 irrelevant, 1 total reads/);
    assert.match(read, /chain locked/);
    assert.match(read, /contents of a/);

    // Locked: a second read before a verdict is rejected.
    const blocked = ledger.chainRead({ path: "b.js" });
    assert.match(blocked, /AUDIT ERROR: Chain is locked/);

    const verdict = JSON.parse(ledger.chainVerdict({ verdict: "relevant", summary: "useful" }));
    assert.equal(verdict.ok, true);
    assert.equal(verdict.tagged, "a.js");
    assert.equal(verdict.chain, "unlocked");
    assert.equal(verdict.ledger.relevant, 1);
    assert.equal(verdict.evidence.novel_relevant_file, true);
    assert.equal(verdict.evidence.continuation, false);
  });

  it("rejects re-reading an already-tagged file", () => {
    const ledger = createChainLedger({ readFile: fakeReader({ "a.js": "x" }), cwd: "/repo" });
    ledger.chainRead({ path: "a.js" });
    ledger.chainVerdict({ verdict: "irrelevant" });
    const again = ledger.chainRead({ path: "a.js" });
    assert.match(again, /already read and tagged irrelevant/);
  });

  it("requires a pending read before a verdict", () => {
    const ledger = createChainLedger({ readFile: fakeReader({}), cwd: "/repo" });
    assert.match(ledger.chainVerdict({ verdict: "relevant" }), /No file pending verdict/);
  });

  it("does not lock the chain on a read error", () => {
    const ledger = createChainLedger({ readFile: fakeReader({}), cwd: "/repo" });
    const res = ledger.chainRead({ path: "missing.js" });
    assert.match(res, /AUDIT ERROR/);
    // Chain not locked -> a subsequent read of a real file proceeds.
    const ok = createChainLedger({ readFile: fakeReader({ "real.js": "data" }), cwd: "/repo" })
      .chainRead({ path: "real.js" });
    assert.match(ok, /chain locked/);
    assert.equal(ledger.state.currentlyReading, null);
  });

  it("persists through the optional store hook", () => {
    let saved = null;
    const persist = { load: () => saved, save: (data) => { saved = data; } };
    const a = createChainLedger({ readFile: fakeReader({ "a.js": "x" }), cwd: "/repo", persist });
    a.chainRead({ path: "a.js" });
    a.chainVerdict({ verdict: "relevant", summary: "s" });
    assert.ok(saved.relevant["a.js"]);
    // A fresh ledger loading the same store sees the prior verdict.
    const b = createChainLedger({ readFile: fakeReader({ "a.js": "x" }), cwd: "/repo", persist });
    assert.match(b.chainRead({ path: "a.js" }), /already read and tagged relevant/);
  });
});
