// @ts-check
//
// Coverage for Ledger.upsertExternalSymbol — exercises the SQLite NULL-vs-''
// sentinel rule that makes UNIQUE actually dedupe across rows whose moniker
// has missing manager/package_version fields.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

describe("ATLAS v2 Ledger external_symbols", () => {
  /** @type {string} */
  let tmp;
  before(() => {
    tmp = makeTmp("atlas-v2-extsym-");
  });
  after(() => {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* windows tempdir lock */ }
  });

  it("inserts a fresh moniker and returns a stable id", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "fresh.db") });
    try {
      const id = led.upsertExternalSymbol({
        scheme: "scip-typescript",
        manager: "npm",
        package_name: "@types/node",
        package_version: "20.0.0",
        descriptor: "fs/promises#readFile().",
        display_name: "readFile",
      });
      assert.ok(Number.isInteger(id) && id > 0);
      const again = led.upsertExternalSymbol({
        scheme: "scip-typescript",
        manager: "npm",
        package_name: "@types/node",
        package_version: "20.0.0",
        descriptor: "fs/promises#readFile().",
      });
      assert.equal(again, id, "second call must dedupe to the same id");
    } finally {
      led.close();
    }
  });

  it("treats null manager / package_version as the '' sentinel for UNIQUE dedupe", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "sentinel.db") });
    try {
      const a = led.upsertExternalSymbol({
        scheme: "scip-typescript",
        manager: null,
        package_name: "stdlib",
        package_version: null,
        descriptor: "Math#abs().",
      });
      const b = led.upsertExternalSymbol({
        scheme: "scip-typescript",
        manager: "",
        package_name: "stdlib",
        package_version: "",
        descriptor: "Math#abs().",
      });
      assert.equal(a, b, "null and '' must collapse to the same row");
      // And a distinct manager produces a distinct row.
      const c = led.upsertExternalSymbol({
        scheme: "scip-typescript",
        manager: "npm",
        package_name: "stdlib",
        package_version: "",
        descriptor: "Math#abs().",
      });
      assert.notEqual(a, c);
    } finally {
      led.close();
    }
  });

  it("accepts empty package_name but rejects empty scheme / descriptor", () => {
    const led = Ledger.open({ dbPath: path.join(tmp, "reject.db") });
    try {
      assert.throws(() => led.upsertExternalSymbol({
        scheme: "",
        package_name: "p",
        descriptor: "d",
      }), /scheme is required/);
      const emptyPackageId = led.upsertExternalSymbol({
        scheme: "scip-typescript",
        package_name: "",
        descriptor: "d",
      });
      assert.ok(Number.isInteger(emptyPackageId) && emptyPackageId > 0);
      assert.throws(() => led.upsertExternalSymbol({
        scheme: "scip-typescript",
        package_name: "p",
        descriptor: "",
      }), /descriptor is required/);
    } finally {
      led.close();
    }
  });
});
