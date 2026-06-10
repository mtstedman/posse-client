import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  FLAG_DESCRIPTORS,
  parsePositiveIntegerFlag,
  parseConcurrency,
  parseStallTimeout,
  unknownArgFlags,
} from "../lib/domains/cli/functions/flags.js";

describe("CLI flag descriptor table", () => {
  it("every descriptor has the required shape", () => {
    const seen = new Set();
    for (const d of FLAG_DESCRIPTORS) {
      assert.ok(typeof d.name === "string" && d.name.length > 0, `name missing on ${JSON.stringify(d)}`);
      assert.ok(d.name.startsWith("-"), `${d.name} must start with a dash`);
      assert.ok(typeof d.takesValue === "boolean", `${d.name}.takesValue must be boolean`);
      assert.ok(["value", "filter-value", "boolean"].includes(d.category), `${d.name}.category invalid: ${d.category}`);
      assert.ok(!seen.has(d.name), `duplicate flag name: ${d.name}`);
      seen.add(d.name);

      if (d.category === "boolean") {
        assert.equal(d.takesValue, false, `boolean flag ${d.name} must have takesValue=false`);
      } else {
        assert.equal(d.takesValue, true, `value flag ${d.name} must have takesValue=true`);
      }
    }
  });

  it("descriptor table covers all flags the CLI documents (smoke check)", () => {
    // Spot-check key flags exist in the table. New flags should be added to
    // FLAG_DESCRIPTORS, not as bare strings inside parsing helpers.
    const names = new Set(FLAG_DESCRIPTORS.map((d) => d.name));
    for (const required of [
      "--mode", "--tier", "--concurrency", "--stall-timeout",
      "--auto-approve", "--auto-merge", "--help", "-h",
      "--by", "--since", "--limit",
      "--no-tui", "--json", "--verbose", "-v",
      "--branch", "--lang", "--all", "--force",
    ]) {
      assert.ok(names.has(required), `descriptor table missing ${required}`);
    }
  });

  it("parsePositiveIntegerFlag handles --flag=N and --flag N forms", () => {
    const err = () => new Error("bad");
    assert.equal(parsePositiveIntegerFlag(["--concurrency=4"], "--concurrency", err), 4);
    assert.equal(parsePositiveIntegerFlag(["--concurrency", "8"], "--concurrency", err), 8);
    assert.equal(parsePositiveIntegerFlag(["other"], "--concurrency", err), null);
  });

  it("parsePositiveIntegerFlag rejects non-positive, missing, or dashed values", () => {
    const err = () => new Error("bad");
    assert.throws(() => parsePositiveIntegerFlag(["--concurrency=0"], "--concurrency", err), /bad/);
    assert.throws(() => parsePositiveIntegerFlag(["--concurrency=-2"], "--concurrency", err), /bad/);
    assert.throws(() => parsePositiveIntegerFlag(["--concurrency=abc"], "--concurrency", err), /bad/);
    assert.throws(() => parsePositiveIntegerFlag(["--concurrency"], "--concurrency", err), /bad/);
    assert.throws(() => parsePositiveIntegerFlag(["--concurrency", "--other"], "--concurrency", err), /bad/);
  });

  it("parseConcurrency uses the shared helper and exposes its error message", () => {
    assert.equal(parseConcurrency(["node", "orch", "--concurrency=6"]), 6);
    assert.throws(
      () => parseConcurrency(["node", "orch", "--concurrency=abc"]),
      /--concurrency requires a positive integer/,
    );
  });

  it("parseStallTimeout uses the shared helper and exposes its error message", () => {
    assert.equal(parseStallTimeout(["node", "orch", "--stall-timeout=120"]), 120);
    assert.throws(
      () => parseStallTimeout(["node", "orch", "--stall-timeout=abc"]),
      /--stall-timeout requires a positive integer/,
    );
  });

  it("documented per-command flags pass the unknown-flag rejection", () => {
    // Each of these is parsed and documented by its command; the global
    // unknown-flag gate must not exit before dispatch reaches it.
    const invocations = [
      ["events", "12", "--session"],
      ["sessions", "--savings"],
      ["cost", "--recycling"],
      ["replay", "123", "--exact-prompt"],
      ["windows-events", "--around", "2026-06-09T10:00:00Z", "--minutes", "30"],
      ["windows-events", "--window-minutes", "60"],
      ["prune", "--yes"],
      ["prune", "-y"],
      ["serve", "--show-lan-token"],
      ["serve", "--pair", "--confirmation-code", "AB23"],
      ["serve", "--pair", "--pair-code", "AB23"],
    ];
    for (const argv of invocations) {
      assert.deepEqual(unknownArgFlags(argv), [], `rejected: ${argv.join(" ")}`);
    }
  });

  it("unknownArgFlags rejects flags not in the descriptor table", () => {
    const unknown = unknownArgFlags(["--mode", "code", "--mysterious-new-flag", "--auto-approve"]);
    assert.deepEqual(unknown, ["--mysterious-new-flag"]);
  });

  it("unknownArgFlags treats every descriptor as known", () => {
    // A run that uses every declared flag in trivial positions should have
    // no "unknown" output.
    const argv = [];
    for (const d of FLAG_DESCRIPTORS) {
      argv.push(d.name);
      if (d.takesValue) argv.push("placeholder");
    }
    assert.deepEqual(unknownArgFlags(argv), []);
  });
});
