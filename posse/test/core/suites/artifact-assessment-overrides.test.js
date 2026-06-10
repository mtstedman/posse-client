import {
  it,
  assert,
  path,
  suite,
  runtimeModules,
} from "../support/core-harness.js";

let db;

suite("Artifact assessment overrides", () => {
  it("overrides missing-file assessor failures when the artifact manifest proves output exists", () => {
    const { workerMod } = runtimeModules;
    const shouldOverride = workerMod.shouldOverrideArtifactMissingFail({
      verdict: "fail",
      reasons: [
        "The output manifest states image.png file should be in the working directory but it is not found there.",
        "Without the actual image file, the image validity and correctness cannot be confirmed.",
      ],
    }, {
      taskMode: "image",
      manifest: { count: 1, files: [{ path: "image.png", size: 2048, ext: ".png" }] },
      contractViolations: null,
      outputRoot: ".posse/resources/artifacts/wi-1",
    });

    assert.equal(shouldOverride, true);
  });

  it("does not override real artifact failures when the manifest is empty", () => {
    const { workerMod } = runtimeModules;
    const shouldOverride = workerMod.shouldOverrideArtifactMissingFail({
      verdict: "fail",
      reasons: ["There is no image.png file present in the specified output directory."],
    }, {
      taskMode: "image",
      manifest: { count: 0, files: [] },
      contractViolations: null,
      outputRoot: ".posse/resources/artifacts/wi-1",
    });

    assert.equal(shouldOverride, false);
  });

  it("fast-passes non-image artifact verification when manifest matches expected files", () => {
    const { workerMod } = runtimeModules;
    const shouldFastPass = workerMod.__testShouldFastPassArtifactAssessment({
      taskMode: "report",
      outputRoot: "C:/tmp/project/.posse/resources/artifacts/wi-1/task-01-report",
      contractViolations: null,
      expectedFiles: [
        "C:/tmp/project/.posse/resources/artifacts/wi-1/task-01-report/vermont.json",
      ],
      manifest: {
        count: 1,
        files: [{ path: "vermont.json", size: 4096, ext: ".json" }],
      },
    });

    assert.equal(shouldFastPass, true);
  });

  it("does not fast-pass non-image artifacts when expected files are missing from the manifest", () => {
    const { workerMod } = runtimeModules;
    const shouldFastPass = workerMod.__testShouldFastPassArtifactAssessment({
      taskMode: "report",
      outputRoot: "C:/tmp/project/.posse/resources/artifacts/wi-1/task-01-report",
      contractViolations: null,
      expectedFiles: [
        "C:/tmp/project/.posse/resources/artifacts/wi-1/task-01-report/vermont.json",
      ],
      manifest: {
        count: 1,
        files: [{ path: "delaware.json", size: 4096, ext: ".json" }],
      },
    });

    assert.equal(shouldFastPass, false);
  });
});
