import {
  it,
  assert,
  suite,
  handoff,
  parseMissingContext,
} from "../support/core-harness.js";

let db;

suite("Missing Context Parser", () => {
  it("accepts extensionless project files and inline file requests", () => {
    assert.deepEqual(
      parseMissingContext("MISSING_CONTEXT:\n- Makefile\n- Dockerfile\n- LICENSE"),
      ["Makefile", "Dockerfile", "LICENSE"]
    );
    assert.deepEqual(parseMissingContext("MISSING_CONTEXT: tmp-context-expand.js"), ["tmp-context-expand.js"]);
  });

  it("filters non-file prose from missing-context bullets", () => {
    assert.equal(parseMissingContext("MISSING_CONTEXT:\n- inspect the repo\n- maybe add tests"), null);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TEST: File Risk Classification (handoff.js)
// ═════════════════════════════════════════════════════════════════════════════
