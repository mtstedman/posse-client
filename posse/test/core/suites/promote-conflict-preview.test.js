import {
  assert,
  fs,
  it,
  path,
  __dirname,
  suite,
} from "../support/core-harness.js";

suite("promote conflict preview", () => {
  it("reports exactly what a promote copy would overwrite", async () => {
    const { buildPromoteConflictPreview, formatPromoteConflictPreview } = await import("../../../lib/domains/worker/functions/execution/promote-job.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-promote-preview-"));

    try {
      const sourceDir = path.join(projectDir, ".posse", "resources", "artifacts", "wi-1", "task-01");
      const destDir = path.join(projectDir, "public");
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(destDir, { recursive: true });
      const source = path.join(sourceDir, "hero.png");
      const destination = path.join(destDir, "hero.png");
      fs.writeFileSync(source, "new image bytes\n");
      fs.writeFileSync(destination, "old image bytes\n");

      const preview = buildPromoteConflictPreview({
        cwd: projectDir,
        copies: [{ source, destination, destinationRel: "public/hero.png" }],
      });

      assert.equal(preview.planned_count, 1);
      assert.equal(preview.existing_count, 1);
      assert.equal(preview.overwrite_count, 1);
      assert.equal(preview.overwrites[0].destination, "public/hero.png");
      assert.equal(preview.overwrites[0].identical, false);
      assert.match(formatPromoteConflictPreview(preview), /overwrite: public\/hero\.png/);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it("blocks changed promote overwrites unless explicitly allowed", async () => {
    const { assertPromoteOverwritePolicy } = await import("../../../lib/domains/worker/functions/execution/promote-job.js");
    const preview = {
      overwrite_count: 1,
      overwrites: [{ destination: "public/hero.png" }],
    };

    assert.throws(
      () => assertPromoteOverwritePolicy(preview),
      /Promote would overwrite 1 existing file\(s\): public\/hero\.png/,
    );
    assert.doesNotThrow(() => assertPromoteOverwritePolicy(preview, { allowOverwrite: true }));
    assert.doesNotThrow(() => assertPromoteOverwritePolicy(preview, { allowedOverwritePaths: ["public/hero.png"] }));
    assert.throws(
      () => assertPromoteOverwritePolicy(preview, { allowedOverwritePaths: ["public/other.png"] }),
      /Promote would overwrite 1 existing file\(s\): public\/hero\.png/,
    );
    assert.doesNotThrow(() => assertPromoteOverwritePolicy({ overwrite_count: 0, overwrites: [] }));
  });

  it("classifies existing exact promote destinations as files_to_modify", async () => {
    const { normalizePromoteMappings } = await import("../../../lib/domains/worker/functions/helpers/plan-routing.js");
    const projectDir = fs.mkdtempSync(path.join(__dirname, "tmp-promote-existing-"));

    try {
      const sourceDir = path.join(projectDir, ".posse", "resources", "artifacts", "wi-1", "task-01");
      const dest = path.join(projectDir, "public", "hero.png");
      fs.mkdirSync(sourceDir, { recursive: true });
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.writeFileSync(dest, "old image bytes\n", "utf-8");

      const payload = normalizePromoteMappings({
        source_dir: sourceDir,
        mappings: [{ pattern: "hero.png", dest: "public/hero.png" }],
      }, sourceDir, { projectDir });

      assert.deepEqual(payload.files_to_modify, ["public/hero.png"]);
      assert.deepEqual(payload.files_to_create, []);
      assert.deepEqual(payload.create_roots, []);
    } finally {
      fs.rmSync(projectDir, { recursive: true, force: true });
    }
  });
});
