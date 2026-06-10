import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { cmdAtlas } from "../lib/domains/cli/functions/diagnostic-commands.js";
import { runAtlasV2Command } from "../lib/domains/cli/functions/commands/atlas-v2.js";
import { ATLAS_V2_HELP_COMMANDS } from "../lib/domains/cli/functions/atlas-v2-help.js";

function withConsoleCapture(fn) {
  const original = console.log;
  const lines = [];
  console.log = (...args) => lines.push(args.join(" "));
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      console.log = original;
    })
    .then((result) => ({ result, output: lines.join("\n") }));
}

describe("Atlas parse CLI boundary", () => {
  it("does not expose posse atlas parse; Atlas mutations stay under system.atlas.*", async () => {
    const originalArgv = process.argv;
    process.argv = ["node", "posse", "atlas", "parse", "onnx", "refresh"];
    try {
      const { result, output } = await withConsoleCapture(() => cmdAtlas({ projectDir: process.cwd() }));

      assert.equal(result, null);
      assert.match(output, /Atlas mutations are system-owned/);
      assert.doesNotMatch(output, /posse atlas parse/);
    } finally {
      process.argv = originalArgv;
    }
  });

  it("does not keep atlas-v2 parse as a public alias", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-parse-cli-removed-"));
    try {
      const { result, output } = await withConsoleCapture(() =>
        runAtlasV2Command({ projectDir, argv: ["parse", "onnx", "refresh"] }));

      assert.equal(result, null);
      assert.match(output, /Unknown atlas-v2 subcommand: parse/);
      assert.doesNotMatch(output, /Alias for .*atlas parse/);
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("prints atlas-v2 status for an empty project directory", async () => {
    const projectDir = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-status-"));
    try {
      const { result, output } = await withConsoleCapture(() =>
        runAtlasV2Command({ projectDir, argv: ["status"] }));

      assert.equal(result.ledger.exists, false);
      assert.equal(result.mainView.exists, false);
      assert.equal(result.warmedCount, 0);
      assert.match(output, /ATLAS v2 Status/);
      assert.match(output, /Ledger:/);
      assert.match(output, /Main view:/);
      assert.match(output, /Warmer queue/);
    } finally {
      try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch {}
    }
  });

  it("prints atlas-v2 help from the shared command list", async () => {
    const { result, output } = await withConsoleCapture(() =>
      runAtlasV2Command({ projectDir: process.cwd(), argv: ["help"] }));

    assert.equal(result, null);
    for (const command of ATLAS_V2_HELP_COMMANDS) {
      assert.match(output, new RegExp(command.usage.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    }
  });
});
