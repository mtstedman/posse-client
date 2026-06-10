import {
  it,
  assert,
  path,
  suite,
  runtimeModules,
} from "../support/core-harness.js";

let db;

suite("Artifact manifest freshness", () => {
  it("treats overwritten artifact files as fresh output on retry", () => {
    const { workerMod } = runtimeModules;
    const filtered = workerMod.__testFilterNewOrChangedManifestFiles({
      files: [
        { path: "hero-bg.png", size: 2000, ext: ".png", mtimeMs: 2000 },
        { path: "card-style.png", size: 1500, ext: ".png", mtimeMs: 1000 },
      ],
      totalSize: 3500,
      count: 2,
    }, new Map([
      ["hero-bg.png", { size: 1000, ext: ".png", mtimeMs: 1000 }],
      ["card-style.png", { size: 1500, ext: ".png", mtimeMs: 1000 }],
    ]));

    assert.equal(filtered.count, 1);
    assert.deepEqual(filtered.files.map((file) => file.path), ["hero-bg.png"]);
  });

  it("can reuse unchanged complete artifact output without reporting an empty attempt", async () => {
    const { workerMod } = runtimeModules;
    const assessment = await import("../../../lib/domains/worker/functions/helpers/assessment-pipeline.js");
    const outputRoot = "C:/tmp/project/.posse/resources/artifacts/wi-1/task-01-report";
    const expectedFiles = [`${outputRoot}/vermont.json`];
    const fullManifest = {
      count: 1,
      totalSize: 4096,
      files: [{ path: "vermont.json", size: 4096, ext: ".json" }],
    };

    const completeOutput = [
      "--- ARTIFICER LOG START ---",
      "status: COMPLETE",
      "--- ARTIFICER LOG END ---",
    ].join("\n");

    assert.equal(workerMod.__testArtifactOutputClaimsReusableComplete(completeOutput), true);
    assert.equal(workerMod.__testArtifactOutputClaimsReusableComplete("not reusing existing output"), false);
    assert.equal(assessment.shouldReuseUnchangedArtifactManifest({
      taskMode: "report",
      fullManifest,
      output: completeOutput,
      outputRoot,
      expectedFiles,
      shouldFastPassArtifactAssessment: workerMod.__testShouldFastPassArtifactAssessment,
    }), true);
    assert.equal(assessment.shouldReuseUnchangedArtifactManifest({
      taskMode: "report",
      fullManifest,
      output: completeOutput.replace("COMPLETE", "PARTIAL"),
      outputRoot,
      expectedFiles,
      shouldFastPassArtifactAssessment: workerMod.__testShouldFastPassArtifactAssessment,
    }), false);
  });

  it("describes unchanged existing artifacts instead of saying the output root is empty", async () => {
    const assessment = await import("../../../lib/domains/worker/functions/helpers/assessment-pipeline.js");
    const message = assessment.buildEmptyArtifactOutputMessage({
      taskMode: "image",
      outputRoot: ".posse/resources/artifacts/wi-2/task-01-hero",
      manifest: { count: 0, files: [] },
      fullManifest: {
        count: 1,
        files: [{ path: "hero-bg.png", size: 4096, ext: ".png" }],
      },
      preManifestState: new Map([
        ["hero-bg.png", { size: 4096, ext: ".png", mtimeMs: 1000 }],
      ]),
    });

    assert.match(message, /produced no new or changed files/);
    assert.match(message, /1 existing file\(s\) were present but unchanged this attempt: hero-bg\.png/);
  });
});
