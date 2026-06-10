// @ts-check
//
// Unit coverage for the SCIP symbol-string parser. Each test pins a
// real-world SCIP symbol shape against the parsed-tuple we expect to see;
// if these regress, the cache → to-rows → ingester pipeline produces
// wrong identities for external symbols.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseScipSymbol,
  descriptorsToQualifiedName,
} from "../lib/domains/atlas/functions/v2/scip/symbol-parser.js";
import { monikerFromParsedSymbol } from "../lib/domains/atlas/functions/v2/scip/moniker.js";

describe("SCIP symbol-parser", () => {
  it("parses a typescript term descriptor with package", () => {
    const parsed = parseScipSymbol("scip-typescript npm @types/node 20.0.0 fs/promises.readFile().");
    assert.equal(parsed.local, false);
    assert.equal(parsed.scheme, "scip-typescript");
    assert.equal(parsed.manager, "npm");
    assert.equal(parsed.package_name, "@types/node");
    assert.equal(parsed.package_version, "20.0.0");
    assert.deepEqual(parsed.descriptors.map((d) => d.kind), ["namespace", "term", "method"]);
    assert.equal(parsed.descriptors[0].name, "fs");
    assert.equal(parsed.descriptors[1].name, "promises");
    assert.equal(parsed.descriptors[2].name, "readFile");
    assert.equal(descriptorsToQualifiedName(parsed.descriptors), "fs.promises.readFile");
  });

  it("normalizes the SCIP '.' sentinel for manager / package / version to '' so UNIQUE dedupe works", () => {
    const parsed = parseScipSymbol("scip-typescript . stdlib . Math#abs().");
    assert.equal(parsed.manager, "");
    assert.equal(parsed.package_version, "");
    assert.equal(parsed.package_name, "stdlib");
    assert.equal(parsed.descriptors.length, 2);
    assert.equal(parsed.descriptors[0].kind, "type");
    assert.equal(parsed.descriptors[1].kind, "method");

    const emptyPackage = parseScipSymbol("scip-typescript . . . Math#abs().");
    assert.equal(emptyPackage.package_name, "");
  });

  it("decodes doubled spaces in scheme and package fields", () => {
    const parsed = parseScipSymbol("scip  custom build  manager my  pkg 1.0.0  beta Foo#");
    assert.equal(parsed.scheme, "scip custom");
    assert.equal(parsed.manager, "build manager");
    assert.equal(parsed.package_name, "my pkg");
    assert.equal(parsed.package_version, "1.0.0 beta");
    assert.equal(parsed.descriptors.length, 1);
    assert.equal(parsed.descriptors[0].kind, "type");
    assert.equal(parsed.descriptors[0].name, "Foo");
    assert.equal(monikerFromParsedSymbol(parsed).descriptor, "Foo#");
  });

  it("parses a local symbol shorthand", () => {
    const parsed = parseScipSymbol("local 42");
    assert.equal(parsed.local, true);
    assert.equal(parsed.local_id, "42");
    assert.equal(parsed.scheme, "");
    assert.equal(parsed.descriptors.length, 0);
  });

  it("parses backtick-escaped identifiers and `` `` `` as literal backtick", () => {
    const parsed = parseScipSymbol("scip-typescript npm pkg 1.0.0 `weird name`#`back``tick`.");
    assert.equal(parsed.descriptors.length, 2);
    assert.equal(parsed.descriptors[0].kind, "type");
    assert.equal(parsed.descriptors[0].name, "weird name");
    assert.equal(parsed.descriptors[1].kind, "term");
    assert.equal(parsed.descriptors[1].name, "back`tick");
  });

  it("parses method descriptors with disambiguator", () => {
    const parsed = parseScipSymbol("scip-typescript npm pkg 1.0.0 Cls#m(+1).");
    assert.equal(parsed.descriptors.length, 2);
    assert.equal(parsed.descriptors[1].kind, "method");
    assert.equal(parsed.descriptors[1].name, "m");
    assert.equal(parsed.descriptors[1].disambiguator, "+1");
  });

  it("parses parameter and type-parameter descriptors", () => {
    const parsed = parseScipSymbol("scip-typescript npm pkg 1.0.0 Cls#m().(arg)[T]");
    // namespace-less: type, method, parameter, type_parameter
    assert.deepEqual(parsed.descriptors.map((d) => d.kind), ["type", "method", "parameter", "type_parameter"]);
    assert.equal(parsed.descriptors[2].name, "arg");
    assert.equal(parsed.descriptors[3].name, "T");
  });

  it("parses macro descriptors and rejects empty simple descriptor names", () => {
    const parsed = parseScipSymbol("scip-rust cargo pkg 1.0.0 src/`main.rs`/println!");
    assert.equal(parsed.descriptors.at(-1).kind, "macro");
    assert.equal(parsed.descriptors.at(-1).name, "println");
    assert.throws(() => parseScipSymbol("scip-typescript npm pkg 1.0.0 .Foo#"), /empty identifier/);

    const escapedEmpty = parseScipSymbol("scip-typescript npm pkg 1.0.0 ``.Foo#");
    assert.equal(escapedEmpty.descriptors[0].kind, "term");
    assert.equal(escapedEmpty.descriptors[0].name, "");
  });

  it("rejects malformed input", () => {
    assert.throws(() => parseScipSymbol(""), /non-empty string/);
    assert.throws(() => parseScipSymbol("scip-typescript"), /missing space/);
    assert.throws(() => parseScipSymbol("scip-typescript npm pkg 1.0.0 "), /missing descriptor/);
    assert.throws(() => parseScipSymbol("scip-typescript npm pkg 1.0.0 Cls@"), /unexpected descriptor suffix/);
  });
});
