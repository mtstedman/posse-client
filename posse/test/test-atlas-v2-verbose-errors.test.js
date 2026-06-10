// test/test-atlas-v2-verbose-errors.test.js
//
// atlas_verbose_errors visibility for the ATLAS v2 indexing path.
//
// Default mode (setting false): per-file parse errors land in
// result.skipped[].message as bare strings; the warmer never throws.
// Verbose mode (setting true): the Warmer re-throws top-level errors
// so the executor can attach a stack to the failed attempt, and the
// per-file skipped messages include the stack trace.

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { Warmer } from "../lib/domains/atlas/classes/v2/Warmer.js";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import {
  formatAtlasError,
  isVerboseAtlasErrors,
  logAtlasError,
} from "../lib/domains/atlas/functions/v2/verbose-errors.js";
import {
  closeAccountSettingsDb,
  setAccountSetting,
  setAccountSettingsPathForTests,
} from "../lib/domains/settings/functions/account-settings.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-v2-verbose-${prefix}-`));
}

let accountTmp = null;

beforeEach(() => {
  accountTmp = makeTmp("account");
  setAccountSettingsPathForTests(path.join(accountTmp, "account-settings.db"));
  setAccountSetting("atlas_verbose_errors", "false");
});

afterEach(() => {
  closeAccountSettingsDb();
  setAccountSettingsPathForTests(null);
  if (accountTmp) {
    fs.rmSync(accountTmp, { recursive: true, force: true });
    accountTmp = null;
  }
});

/**
 * Build a real ledger + warmer pointed at a tiny repo, and inject a
 * fake parser whose parseFile throws. That makes #indexPaths take the
 * per-file error path so we can assert what shows up in `skipped`.
 */
function buildEnv({ throwingParser = true, recoveredParser = false } = {}) {
  const tmp = makeTmp("env");
  const repoRoot = tmp;
  const dbPath = path.join(tmp, ".posse", "atlas", "ledger.db");
  const ledger = Ledger.open({ dbPath });

  // Write a file the warmer will try to parse.
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "src/oops.ts"), "// will fail to parse\n");

  const parser = recoveredParser
    ? {
        async parseFile() {
          return {
            repo_rel_path: "src/oops.ts",
            content_hash: "synthetic-recovered-parse",
            lang: "ts",
            symbols: [],
            edges: [],
            hasError: true,
          };
        },
        supports(ext) {
          return ext === ".ts";
        },
        languages() {
          return ["ts"];
        },
      }
    : throwingParser
    ? {
        async parseFile() {
          const e = new Error("Synthetic parse failure from verbose-error test");
          // Throw with a stack we can recognize.
          throw e;
        },
        supports(ext) {
          return ext === ".ts";
        },
        languages() {
          return ["ts"];
        },
      }
    : null;

  const warmer = new Warmer({ ledger, parserAdapter: parser, repoRoot });
  return { tmp, ledger, warmer };
}

describe("verbose-errors helpers", () => {
  it("isVerboseAtlasErrors honors truthy account setting values only", () => {
    setAccountSetting("atlas_verbose_errors", "");
    assert.equal(isVerboseAtlasErrors(), false);
    setAccountSetting("atlas_verbose_errors", "0");
    assert.equal(isVerboseAtlasErrors(), false);
    setAccountSetting("atlas_verbose_errors", "false");
    assert.equal(isVerboseAtlasErrors(), false);
    setAccountSetting("atlas_verbose_errors", "1");
    assert.equal(isVerboseAtlasErrors(), true);
    setAccountSetting("atlas_verbose_errors", "true");
    assert.equal(isVerboseAtlasErrors(), true);
    setAccountSetting("atlas_verbose_errors", "yes");
    assert.equal(isVerboseAtlasErrors(), true);
  });

  it("formatAtlasError returns bare message in default mode, stack in verbose mode", () => {
    const err = new Error("boom");
    setAccountSetting("atlas_verbose_errors", "false");
    assert.equal(formatAtlasError(err), "boom");
    setAccountSetting("atlas_verbose_errors", "true");
    const v = formatAtlasError(err);
    assert.ok(v.includes("boom"));
    assert.ok(v.includes("Error: boom"), "verbose format should include stack header");
    assert.ok(v.length > "boom".length, "verbose format should be longer than message alone");
  });

  it("logAtlasError is silent in default mode, writes to stderr in verbose mode", () => {
    const origErr = console.error;
    /** @type {any[]} */
    const calls = [];
    console.error = (...args) => calls.push(args);
    try {
      setAccountSetting("atlas_verbose_errors", "false");
      logAtlasError("[test]", new Error("quiet"));
      assert.equal(calls.length, 0);

      setAccountSetting("atlas_verbose_errors", "true");
      logAtlasError("[test]", new Error("loud"));
      assert.equal(calls.length, 1);
      assert.equal(calls[0][0], "[test]");
      assert.ok(calls[0][1] instanceof Error);
    } finally {
      console.error = origErr;
    }
  });
});

describe("Warmer per-file error visibility", () => {
  it("default mode: parse error becomes a skipped record with bare message", async () => {
    setAccountSetting("atlas_verbose_errors", "false");
    const { tmp, ledger, warmer } = buildEnv();
    try {
      const r = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: ["src/oops.ts"],
      });
      assert.ok(r.skipped.length >= 1);
      const oops = r.skipped.find((s) => s.repo_rel_path === "src/oops.ts");
      assert.ok(oops, "expected skipped entry for src/oops.ts");
      assert.equal(oops.reason, "parse_error");
      assert.equal(oops.message, "Synthetic parse failure from verbose-error test");
      assert.ok(
        !oops.message.includes("at "),
        "default mode message should not include stack",
      );
    } finally {
      ledger.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("default mode: recovered syntax errors are skipped instead of ingested as trusted parses", async () => {
    setAccountSetting("atlas_verbose_errors", "false");
    const { tmp, ledger, warmer } = buildEnv({ recoveredParser: true });
    try {
      const r = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: ["src/oops.ts"],
      });
      const oops = r.skipped.find((s) => s.repo_rel_path === "src/oops.ts");
      assert.ok(oops, "expected skipped entry for recovered syntax error");
      assert.equal(oops.reason, "parse_error");
      assert.match(oops.message, /tree-sitter parse error/);
      assert.equal(r.paths_indexed, 0);
    } finally {
      ledger.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("verbose mode: parse error skipped record carries stack trace", async () => {
    setAccountSetting("atlas_verbose_errors", "true");
    // Swallow the console.error noise the helper emits.
    const origErr = console.error;
    console.error = () => {};
    const { tmp, ledger, warmer } = buildEnv();
    try {
      const r = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: ["src/oops.ts"],
      });
      const oops = r.skipped.find((s) => s.repo_rel_path === "src/oops.ts");
      assert.ok(oops);
      assert.ok(oops.message.includes("Synthetic parse failure"));
      assert.ok(
        oops.message.includes("at ") || oops.message.includes("Error:"),
        `verbose message should include stack; got: ${oops.message.slice(0, 200)}`,
      );
    } finally {
      console.error = origErr;
      ledger.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("verbose mode: top-level handleWarmJob error re-throws", async () => {
    setAccountSetting("atlas_verbose_errors", "true");
    const origErr = console.error;
    console.error = () => {};
    const tmp = makeTmp("rethrow");
    const ledger = Ledger.open({ dbPath: path.join(tmp, "ledger.db") });
    try {
      // No parser configured AND we trigger main-full, which will hit a
      // catchable internal path. But the cleanest way to force a
      // top-level throw is to break the ledger from under the warmer.
      // Easiest: pass an unknown purpose that DOES fall into the
      // switch's default branch (which doesn't throw). So instead we
      // induce throws via the wi-cleanup path with a broken work_item_id
      // by mocking the ledger to throw.
      const brokenLedger = /** @type {any} */ ({
        ...ledger,
        getBranch: () => { throw new Error("Synthetic top-level failure"); },
      });
      const warmer = new Warmer({
        ledger: brokenLedger,
        parserAdapter: null,
        repoRoot: tmp,
      });
      await assert.rejects(
        () => warmer.handleWarmJob({
          purpose: "main-merge",
          branch: "wi-1",
          onto_branch: "main",
        }),
        /Synthetic top-level failure/,
      );
    } finally {
      console.error = origErr;
      ledger.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("default mode: top-level error degrades to skipped, never throws", async () => {
    setAccountSetting("atlas_verbose_errors", "false");
    const tmp = makeTmp("no-rethrow");
    const ledger = Ledger.open({ dbPath: path.join(tmp, "ledger.db") });
    try {
      const brokenLedger = /** @type {any} */ ({
        ...ledger,
        getBranch: () => { throw new Error("Synthetic top-level failure"); },
      });
      const warmer = new Warmer({
        ledger: brokenLedger,
        parserAdapter: null,
        repoRoot: tmp,
      });
      const r = await warmer.handleWarmJob({
        purpose: "main-merge",
        branch: "wi-1",
        onto_branch: "main",
      });
      assert.ok(r.skipped.length >= 1);
      assert.ok(r.skipped[0].message.includes("Synthetic top-level failure"));
    } finally {
      ledger.close();
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
