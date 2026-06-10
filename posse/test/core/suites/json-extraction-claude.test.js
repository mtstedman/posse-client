import {
  it,
  assert,
  suite,
  extractJson,
} from "../support/core-harness.js";
import { extractJsonResult } from "../../../lib/shared/format/functions/json.js";

let db;

suite("JSON Extraction (claude)", () => {
  it("extracts from fenced code block", () => {
    const text = 'Here is the result:\n```json\n{"key": "value"}\n```\nDone.';
    assert.deepEqual(extractJson(text), { key: "value" });
  });

  it("extracts bare JSON object", () => {
    const text = 'Some text {"a": 1, "b": 2} more text';
    assert.deepEqual(extractJson(text), { a: 1, b: 2 });
  });

  it("extracts bare JSON array", () => {
    const text = 'Result: [1, 2, 3]';
    assert.deepEqual(extractJson(text), [1, 2, 3]);
  });

  it("handles nested braces", () => {
    const text = '{"outer": {"inner": true}}';
    assert.deepEqual(extractJson(text), { outer: { inner: true } });
  });

  it("preserves caller-visible falsy JSON values", () => {
    assert.equal(extractJson("false"), false);
    assert.equal(extractJson("0"), 0);
    assert.equal(extractJson('```json\n""\n```'), "");
  });

  it("returns null for no JSON", () => {
    assert.equal(extractJson("No JSON here"), null);
  });

  it("distinguishes JSON null from no JSON for callers that need it", () => {
    assert.deepEqual(extractJsonResult("null"), { found: true, value: null });
    assert.deepEqual(extractJsonResult("No JSON here"), { found: false, value: null });
    assert.equal(extractJson("null"), null);
  });

  it("returns null for malformed JSON", () => {
    assert.equal(extractJson("{not: valid json}"), null);
  });

  it("handles trailing commas in arrays", () => {
    const text = '```json\n[{"title": "a"}, {"title": "b"},]\n```';
    assert.deepEqual(extractJson(text), [{ title: "a" }, { title: "b" }]);
  });

  it("handles trailing commas in objects", () => {
    const text = '{"a": 1, "b": 2,}';
    assert.deepEqual(extractJson(text), { a: 1, b: 2 });
  });

  it("strips single-line JS comments", () => {
    const text = '[\n  // first item\n  {"v": 1},\n  {"v": 2}\n]';
    assert.deepEqual(extractJson(text), [{ v: 1 }, { v: 2 }]);
  });

  it("strips block comments", () => {
    const text = '[{"v": 1}, /* second */ {"v": 2}]';
    assert.deepEqual(extractJson(text), [{ v: 1 }, { v: 2 }]);
  });

  it("repairs truncated JSON array", () => {
    const text = '[{"title": "task 1"}, {"title": "task 2"}, {"title": "tas';
    const result = extractJson(text);
    assert.ok(Array.isArray(result), "should return an array");
    assert.ok(result.length >= 2, "should recover at least 2 complete items");
    assert.equal(result[0].title, "task 1");
    assert.equal(result[1].title, "task 2");
  });

  it("returns null for empty/null input", () => {
    assert.equal(extractJson(null), null);
    assert.equal(extractJson(""), null);
    assert.equal(extractJson(undefined), null);
  });

  it("handles nested backtick fences inside JSON string values", () => {
    // task_spec contains ```sql blocks — the inner ``` must not break extraction
    // The JSON string has literal \n and ``` characters (escaped as \\n in JSON)
    const jsonContent = JSON.stringify([{
      title: "DB schema",
      task_spec: "Run this:\n```sql\nCREATE TABLE foo (id INT);\n```\nDone.",
      job_type: "dev",
      model_tier: "cheap",
      files_to_modify: ["db.js"],
      success_criteria: ["table exists"],
      depends_on_index: [],
    }]);
    const text = "Here is the plan:\n```json\n" + jsonContent + "\n```";
    const result = extractJson(text);
    assert.ok(Array.isArray(result), "should parse as array");
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "DB schema");
    assert.match(result[0].task_spec, /CREATE TABLE/);
  });

  it("handles multiple separate ```json blocks (picks the valid one)", () => {
    const text = [
      "Here is an example:",
      "```json",
      '{"example": true}',
      "```",
      "And here is the actual plan:",
      "```json",
      '[{"title":"Real task","task_spec":"Do it","job_type":"dev","model_tier":"cheap","files_to_modify":[],"success_criteria":["done"],"depends_on_index":[]}]',
      "```",
    ].join("\n");
    const result = extractJson(text);
    assert.ok(Array.isArray(result), "should pick the array block, not the example object");
    assert.equal(result.length, 1);
    assert.equal(result[0].title, "Real task");
  });

  it("bounds fenced JSON candidate attempts to the largest few blocks", () => {
    const longInvalidBlocks = Array.from({ length: 5 }, (_, index) => [
      "```json",
      `not json candidate ${index} ${"x".repeat(50 - index)}`,
      "```",
    ].join("\n"));
    const text = [
      ...longInvalidBlocks,
      "```json",
      "true",
      "```",
    ].join("\n");

    assert.deepEqual(extractJsonResult(text), { found: false, value: null });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST: Error Backoff Parsing (claude.js)
// ═════════════════════════════════════════════════════════════════════════════
