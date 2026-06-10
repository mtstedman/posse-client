import {
  it,
  assert,
  path,
  suite,
  parseFileRequest,
  splitFileRequestsByRisk,
} from "../support/core-harness.js";

let db;

suite("File Request Splitting", () => {
  it("splits mixed risk levels", () => {
    const requests = [
      { path: "public/logo.png", risk: "low" },
      { path: "src/app.js", risk: "high" },
      { path: "styles/main.css", risk: "mid" },
    ];
    const result = splitFileRequestsByRisk(requests);
    assert.ok(result.autoApproved);
    assert.ok(result.needsApproval);
    // Low and mid go to autoApproved, high goes to needsApproval
    assert.equal(result.needsApproval.length, 1);
    assert.equal(result.needsApproval[0].path, "src/app.js");
  });

  it("routes sensitive config file requests through human approval", () => {
    const requests = parseFileRequest([
      "FILE_REQUEST:",
      "- .github/workflows/ci.yml -- CI workflow",
      "- package.json -- new package manifest",
      "- styles/theme.css -- styling",
      "FILE_REQUEST_END",
    ].join("\n"));

    const result = splitFileRequestsByRisk(requests);
    assert.deepEqual(result.autoApproved.map((entry) => entry.path), ["styles/theme.css"]);
    assert.deepEqual(result.needsApproval.map((entry) => entry.path), [".github/workflows/ci.yml", "package.json"]);
  });

  it("handles empty input", () => {
    const result = splitFileRequestsByRisk([]);
    assert.equal(result.autoApproved.length, 0);
    assert.equal(result.needsApproval.length, 0);
  });
});
