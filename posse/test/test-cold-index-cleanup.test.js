import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { clearColdIndex } from "../lib/domains/cli/functions/cold-index.js";
import { atlasDir, embeddingsRoot, ledgerDbPath, viewsDir } from "../lib/domains/atlas/functions/v2/runtime-paths.js";
import { removeTempTree } from "./helpers/regression-test-harness.js";

function withQuietConsole(fn) {
  const originalLog = console.log;
  console.log = () => {};
  try {
    return fn();
  } finally {
    console.log = originalLog;
  }
}

describe("--cold-index cleanup", () => {
  it("clears SCIP staged outputs, metadata, cache dirs, and hidden staging temps", () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "posse-cold-index-"));
    try {
      const root = atlasDir(projectDir);
      const scipDir = path.join(root, "scip");
      const modelDir = path.join(root, "models");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.mkdirSync(path.join(scipDir, "php-vendor"), { recursive: true });
      fs.mkdirSync(embeddingsRoot(projectDir), { recursive: true });
      fs.mkdirSync(viewsDir(projectDir), { recursive: true });
      fs.mkdirSync(modelDir, { recursive: true });

      const ledgerPath = ledgerDbPath(projectDir);
      fs.writeFileSync(ledgerPath, "");
      fs.writeFileSync(`${ledgerPath}-wal`, "");
      fs.writeFileSync(`${ledgerPath}-shm`, "");
      fs.writeFileSync(path.join(embeddingsRoot(projectDir), "main.usearch"), "vectors");
      fs.writeFileSync(path.join(viewsDir(projectDir), "main.view.db"), "");
      fs.writeFileSync(path.join(modelDir, "encoder.onnx"), "model");
      fs.writeFileSync(path.join(scipDir, "python.scip"), "canonical");
      fs.writeFileSync(path.join(scipDir, "python.meta.json"), "{}");
      fs.writeFileSync(path.join(scipDir, ".python.scip.999999.1700000000000.abc123.staging"), "partial");
      fs.writeFileSync(path.join(scipDir, "php-vendor", "composer.lock"), "cache");

      const result = withQuietConsole(() => clearColdIndex(projectDir));

      assert.equal(result.root, root);
      assert.equal(result.removed, 4);
      assert.equal(fs.existsSync(ledgerPath), false);
      assert.equal(fs.existsSync(`${ledgerPath}-wal`), false);
      assert.equal(fs.existsSync(`${ledgerPath}-shm`), false);
      assert.equal(fs.existsSync(embeddingsRoot(projectDir)), false);
      assert.equal(fs.existsSync(scipDir), false);
      assert.equal(fs.existsSync(viewsDir(projectDir)), false);
      assert.equal(fs.readFileSync(path.join(modelDir, "encoder.onnx"), "utf8"), "model");
    } finally {
      removeTempTree(projectDir);
    }
  });
});
