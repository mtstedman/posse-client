import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  evaluateBenchmarkRegression,
  exponentialSmooth,
  smoothBenchmarkBaseline,
} from "../lib/domains/atlas/functions/v2/benchmark/regression.js";

describe("ATLAS v2 benchmark regression helpers", () => {
  it("flags lower-is-better regressions by threshold", () => {
    const result = evaluateBenchmarkRegression({
      current: [{ name: "command:atlas", value: 130, unit: "ms", better: "lower" }],
      baseline: { "command:atlas": 100 },
      warnPercent: 10,
      failPercent: 25,
    });
    assert.equal(result.ok, false);
    assert.equal(result.findings[0].status, "fail");
    assert.equal(result.findings[0].deltaPercent, 30);
  });

  it("handles higher-is-better metrics and new metrics", () => {
    const result = evaluateBenchmarkRegression({
      current: [
        { name: "coverage", value: 95, unit: "ratio", better: "higher" },
        { name: "new-latency", value: 50, unit: "ms", better: "lower" },
      ],
      baseline: { coverage: 90 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.findings[0].status, "pass");
    assert.equal(result.findings[1].status, "new");
  });

  it("treats zero count baselines as valid regression gates", () => {
    const result = evaluateBenchmarkRegression({
      current: [{ name: "errors", value: 5, unit: "count", better: "lower" }],
      baseline: { errors: 0 },
    });
    assert.equal(result.ok, false);
    assert.equal(result.findings[0].status, "fail");
    assert.equal(result.findings[0].baseline, 0);
  });

  it("treats zero ratio baselines as valid passable baselines", () => {
    const result = evaluateBenchmarkRegression({
      current: [{ name: "hit-rate", value: 0.5, unit: "ratio", better: "higher" }],
      baseline: { "hit-rate": 0 },
    });
    assert.equal(result.ok, true);
    assert.equal(result.findings[0].status, "pass");
    assert.equal(result.findings[0].baseline, 0);
  });

  it("smooths baselines deterministically", () => {
    assert.equal(exponentialSmooth(100, 200, 0.25), 125);
    assert.deepEqual(
      smoothBenchmarkBaseline(
        { a: 100 },
        [{ name: "a", value: 200, unit: "ms", better: "lower" }, { name: "b", value: 5, unit: "count", better: "higher" }],
        0.5,
      ),
      { a: 150, b: 5 },
    );
  });
});
