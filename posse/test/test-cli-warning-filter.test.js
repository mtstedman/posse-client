import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";

import { installCliWarningFilter, __testWarningFilterInstalledSymbol } from "../lib/domains/cli/functions/warnings.js";

describe("CLI warning filter", () => {
  it("suppresses configured warning codes without removing existing listeners", () => {
    const processLike = new EventEmitter();
    let existingCalls = 0;
    const forwarded = [];
    processLike.on("warning", () => { existingCalls += 1; });

    assert.equal(installCliWarningFilter({
      processLike,
      suppressedCodes: ["DEP0040"],
      warn: (warning) => forwarded.push(warning),
    }), true);
    assert.equal(installCliWarningFilter({ processLike }), false);
    assert.equal(processLike[__testWarningFilterInstalledSymbol], true);

    processLike.emit("warning", { code: "DEP0040", message: "punycode" });
    processLike.emit("warning", { code: "OTHER", message: "keep me" });

    assert.equal(existingCalls, 2);
    assert.deepEqual(forwarded, [{ code: "OTHER", message: "keep me" }]);
  });
});
