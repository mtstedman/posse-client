import {
  it,
  assert,
  suite,
  runtimeModules,
} from "../support/core-harness.js";

let db;

suite("Assessor scope inference", () => {
  it("ignores git command snippets when inferring fix file scope", () => {
    const { assessorMod } = runtimeModules;
    const inferred = assessorMod._extractScopedPathsFromInstructions(
      "htdocs/api/workshop.php was never committed (confirmed via `git show HEAD:htdocs/api/workshop.php` -> exists on disk, but not in HEAD).",
    );

    assert.deepEqual(inferred.files_to_modify, []);
    assert.deepEqual(inferred.files_to_create, []);
    assert.deepEqual(inferred.create_roots, []);
  });

  it("ignores Python dotted module names when inferring fix file scope", () => {
    const { assessorMod } = runtimeModules;
    const inferred = assessorMod._extractScopedPathsFromInstructions(
      "Edit `tests/test_trend.py` import list in the `from fiscal_wizard.trend import (...)` block to include `AroonOscillator`.",
    );

    assert.deepEqual(inferred.files_to_modify, ["tests/test_trend.py"]);
    assert.equal(inferred.files_to_modify.includes("fiscal_wizard.trend"), false);
    assert.deepEqual(inferred.files_to_create, []);
    assert.deepEqual(inferred.create_roots, []);
  });
});
