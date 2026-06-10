// test/test-atlas-v2-index-filters.test.js
//
// Unit coverage for the walker's pre-parse filters: path-glob skip and
// content-sample minified detection. These keep build outputs out of the
// ATLAS index — without them a single ~500KB bundled JS file dominates the
// vector store with thousands of garbage one-letter symbols.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  isLikelyMinifiedPath,
  isOversizedForParsing,
  inspectSampleForMinified,
  MAX_PARSE_FILE_BYTES,
  MINIFIED_SAMPLE_BYTES,
} from "../lib/domains/atlas/functions/v2/parser/index-filters.js";

describe("ATLAS v2 index filters", () => {
  describe("isLikelyMinifiedPath", () => {
    it("flags well-known minified naming patterns", () => {
      assert.equal(isLikelyMinifiedPath("dist/app.min.js"), true);
      assert.equal(isLikelyMinifiedPath("public/styles.min.css"), true);
      assert.equal(isLikelyMinifiedPath("vendor/foo-min.js"), true);
      assert.equal(isLikelyMinifiedPath("dist/app.bundle.js"), true);
      assert.equal(isLikelyMinifiedPath("build/main-bundle.css"), true);
      assert.equal(isLikelyMinifiedPath("assets/main.bundle.abc123.js"), true);
    });

    it("does not flag normal source files", () => {
      assert.equal(isLikelyMinifiedPath("src/foo.js"), false);
      assert.equal(isLikelyMinifiedPath("lib/utils/helpers.ts"), false);
      assert.equal(isLikelyMinifiedPath("README.md"), false);
      assert.equal(isLikelyMinifiedPath(""), false);
    });

    it("flags Windows-style backslash paths too", () => {
      assert.equal(isLikelyMinifiedPath("dist\\app.min.js"), true);
    });
  });

  describe("inspectSampleForMinified", () => {
    it("flags single-giant-line content", () => {
      const oneLine = "x".repeat(5000) + ";";
      const out = inspectSampleForMinified(oneLine);
      assert.equal(out.minified, true);
      assert.ok(out.maxLineLen >= 5000);
    });

    it("does not flag normal source code", () => {
      const normal = Array.from({ length: 50 }, (_, i) =>
        `function helper${i}(arg) {\n  return arg * 2;\n}\n`).join("\n");
      const out = inspectSampleForMinified(normal);
      assert.equal(out.minified, false);
      assert.ok(out.maxLineLen < 100);
      assert.ok(out.meanLineLen < 50);
    });

    it("flags content whose mean line length is high even without one giant line", () => {
      // 30 lines of 400 chars each → max ~400, mean ~400 — over the 300 mean cap
      const dense = Array.from({ length: 30 }, () => "a".repeat(400)).join("\n");
      const out = inspectSampleForMinified(dense);
      assert.equal(out.minified, true);
    });

    it("respects custom thresholds", () => {
      const text = Array.from({ length: 10 }, () => "x".repeat(100)).join("\n");
      const tightLimit = inspectSampleForMinified(text, { maxLineLength: 50 });
      assert.equal(tightLimit.minified, true);
      const looseLimit = inspectSampleForMinified(text, { maxLineLength: 500, meanLineLength: 500 });
      assert.equal(looseLimit.minified, false);
    });

    it("handles a Buffer sample of the recommended size", () => {
      const buf = Buffer.from("a".repeat(MINIFIED_SAMPLE_BYTES));
      const out = inspectSampleForMinified(buf);
      assert.equal(out.minified, true);
      assert.equal(out.maxLineLen, MINIFIED_SAMPLE_BYTES);
    });

    it("handles empty input without crashing", () => {
      const out = inspectSampleForMinified("");
      assert.equal(out.minified, false);
      assert.equal(out.lineCount, 1); // one empty trailing "line"
    });
  });

  describe("isOversizedForParsing", () => {
    it("flags files above the parser byte ceiling", () => {
      assert.equal(isOversizedForParsing(MAX_PARSE_FILE_BYTES), false);
      assert.equal(isOversizedForParsing(MAX_PARSE_FILE_BYTES + 1), true);
    });
  });
});
