// @ts-check
//
// End-to-end coverage for the `posse atlas-v2 scip ...` CLI surface. Drives
// runAtlasV2Command directly (no subprocess) and asserts the side effects
// land in the ledger DB.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { setSetting } from "../lib/domains/queue/functions/index.js";
import { ingestScipFile } from "../lib/domains/atlas/functions/v2/scip/ingester.js";
import { readStagerMeta } from "../lib/domains/atlas/functions/v2/scip/stager-meta.js";
import { runAtlasV2Command } from "../lib/domains/cli/functions/commands/atlas-v2.js";
import { encodeIndex, encodeToolInfo } from "./helpers/scip-encoder.mjs";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeRepoFakeIndexer(projectDir) {
  const binDir = path.join(projectDir, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "fake-indexer.mjs"), [
    "import fs from 'node:fs';",
    "const out = process.argv[process.argv.indexOf('--output') + 1];",
    "fs.writeFileSync(out, `cli-generated:${Date.now()}`);",
  ].join("\n"));
  if (process.platform === "win32") {
    fs.writeFileSync(path.join(binDir, "scip-typescript.cmd"), "@echo off\r\nnode \"%~dp0fake-indexer.mjs\" %*\r\n");
  } else {
    const script = path.join(binDir, "scip-typescript");
    fs.writeFileSync(script, "#!/usr/bin/env sh\nnode \"$(dirname \"$0\")/fake-indexer.mjs\" \"$@\"\n");
    fs.chmodSync(script, 0o755);
  }
}

const ROLE_DEFINITION = 0x1;

function buildFixtureScip({ tool_version = "0.3.0", text = "export const x = 1;\n", path = "src/a.ts" } = {}) {
  return encodeIndex({
    metadata: {
      tool_info: encodeToolInfo({ name: "scip-typescript", version: tool_version }),
      project_root: "/repo",
    },
    documents: [
      {
        language: "TypeScript",
        relative_path: path,
        text,
        occurrences: [
          { range: [0, 13, 14], symbol: `scip-typescript npm pkg 1.0.0 src/\`${path.split("/").pop()}\`/x.`, symbol_roles: ROLE_DEFINITION },
        ],
        symbols: [{ symbol: `scip-typescript npm pkg 1.0.0 src/\`${path.split("/").pop()}\`/x.`, display_name: "x" }],
      },
    ],
  });
}

describe("ATLAS v2 scip CLI", () => {
  /** @type {string} */
  let projectDir;
  /** @type {string} */
  let scipDir;
  before(() => {
    projectDir = makeTmp("atlas-v2-scip-cli-");
    scipDir = path.join(projectDir, ".posse", "atlas", "scip");
    fs.mkdirSync(scipDir, { recursive: true });
    // Pre-seed the ledger so the CLI has something to talk to.
    const ledger = Ledger.open({ dbPath: path.join(projectDir, ".posse", "atlas", "ledger.db") });
    ledger.close();
  });
  after(() => {
    try { fs.rmSync(projectDir, { recursive: true, force: true }); } catch { /* windows */ }
  });

  it("status reports an empty ledger and the consume directory", async () => {
    const orig = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const out = await runAtlasV2Command({ projectDir, argv: ["scip", "status"] });
      assert.ok(out);
      const joined = lines.join("\n");
      assert.match(joined, /SCIP status/);
      assert.match(joined, /Mode \(atlas_scip_mode\)/);
      assert.match(joined, /Languages \(atlas_scip_languages\)/);
      assert.match(joined, /Consume directory/);
      assert.match(joined, /no ingested SCIP indexes recorded yet/);
    } finally {
      console.log = orig;
    }
  });

  it("ingest writes a bookkeeping row and surfaces it via status", async () => {
    const scipPath = path.join(scipDir, "ts.scip");
    fs.writeFileSync(scipPath, buildFixtureScip());

    const ledgerPath = path.join(projectDir, ".posse", "atlas", "ledger.db");
    const orig = console.log;
    const lines = [];
    console.log = (...args) => lines.push(args.join(" "));
    try {
      const result = /** @type {any} */ (await runAtlasV2Command({ projectDir, argv: ["scip", "ingest", scipPath] }));
      assert.ok(result);
      assert.equal(result.skipped, false);
      assert.ok(result.scip_index_id !== null);
      assert.match(lines.join("\n"), /defaulting SCIP ingest to ledger branch 'main'/);

      // status now shows one row.
      lines.length = 0;
      await runAtlasV2Command({ projectDir, argv: ["scip", "status"] });
      const joined = lines.join("\n");
      assert.match(joined, /Ingested SCIP indexes \(1\)/);
      assert.match(joined, /scip-typescript 0\.3\.0/);

      // Direct DB check.
      const led = Ledger.open({ dbPath: ledgerPath });
      try {
        const rows = led.listScipIndexes();
        assert.equal(rows.length, 1);
      } finally {
        led.close();
      }
    } finally {
      console.log = orig;
    }
  });

  it("ingest honors an explicit --branch target", async () => {
    const projDir = makeTmp("atlas-v2-scip-cli-branch-");
    const scipPath = path.join(projDir, "branch.scip");
    try {
      fs.mkdirSync(path.dirname(path.join(projDir, ".posse", "atlas", "ledger.db")), { recursive: true });
      fs.writeFileSync(scipPath, buildFixtureScip({ path: "src/master.ts", text: "export const z = 3;\n" }));
      const ledgerPath = path.join(projDir, ".posse", "atlas", "ledger.db");
      const led = Ledger.open({ dbPath: ledgerPath });
      led.ensureRootBranch("master");
      led.close();

      const result = /** @type {any} */ (await runAtlasV2Command({ projectDir: projDir, argv: ["scip", "ingest", "--branch", "master", scipPath] }));
      assert.equal(result.skipped, false);
      assert.equal(result.ledger_entries_appended, 1);

      const check = Ledger.open({ dbPath: ledgerPath });
      try {
        assert.equal(check.headSeq("main"), 0);
        assert.equal(check.headSeq("master"), 1);
        assert.ok(check.pathSnapshotAt("master", check.headSeq("master")).has("src/master.ts"));
      } finally {
        check.close();
      }
    } finally {
      try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows */ }
    }
  });

  it("restage stages a selected language and writes sidecar metadata", async () => {
    const projDir = makeTmp("atlas-v2-scip-cli-restage-");
    try {
      fs.mkdirSync(path.join(projDir, ".posse", "atlas"), { recursive: true });
      fs.writeFileSync(path.join(projDir, "package.json"), "{}\n");
      writeRepoFakeIndexer(projDir);
      setSetting("atlas_scip_mode", "on");
      setSetting("atlas_scip_languages", "typescript");
      setSetting("atlas_scip_restage_policy", "missing");
      setSetting("atlas_scip_index_command", path.join(projDir, "node_modules", ".bin", process.platform === "win32" ? "scip-typescript.cmd" : "scip-typescript"));

      const orig = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(" "));
      try {
        const result = /** @type {any} */ (await runAtlasV2Command({ projectDir: projDir, argv: ["scip", "restage", "--lang", "ts", "--force"] }));
        assert.equal(result.staged, true);
        const outputPath = path.join(projDir, ".posse", "atlas", "scip", "configured.scip");
        assert.equal(fs.existsSync(outputPath), true);
        const meta = await readStagerMeta(outputPath);
        assert.equal(meta?.language, "configured");
        assert.match(lines.join("\n"), /policy=always/);
      } finally {
        console.log = orig;
      }
    } finally {
      setSetting("atlas_scip_mode", "off");
      setSetting("atlas_scip_languages", "typescript,python,php,go,rust");
      setSetting("atlas_scip_restage_policy", "missing");
      setSetting("atlas_scip_index_command", "");
      try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows */ }
    }
  });

  it("ingest rejects an explicit --branch typo instead of creating it", async () => {
    const projDir = makeTmp("atlas-v2-scip-cli-branch-typo-");
    const scipPath = path.join(projDir, "branch.scip");
    try {
      fs.mkdirSync(path.dirname(path.join(projDir, ".posse", "atlas", "ledger.db")), { recursive: true });
      fs.writeFileSync(scipPath, buildFixtureScip({ path: "src/typo.ts", text: "export const typo = 3;\n" }));
      const ledgerPath = path.join(projDir, ".posse", "atlas", "ledger.db");
      const led = Ledger.open({ dbPath: ledgerPath });
      led.close();

      const orig = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(" "));
      try {
        const result = await runAtlasV2Command({ projectDir: projDir, argv: ["scip", "ingest", "--branch", "maaster", scipPath] });
        assert.equal(result, null);
        assert.match(lines.join("\n"), /target branch 'maaster' does not exist/);
      } finally {
        console.log = orig;
      }

      const check = Ledger.open({ dbPath: ledgerPath });
      try {
        assert.equal(check.getBranch("maaster"), null);
      } finally {
        check.close();
      }
    } finally {
      try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows */ }
    }
  });

  it("reparse force-replaces existing blob rows", async () => {
    // Prep: pre-ingest a SCIP file once. Then drop the bookkeeping row and
    // simulate a tree-sitter row taking the blob's place so reparse has
    // something to swap.
    const fixturesDir = makeTmp("atlas-v2-scip-reparse-fixtures-");
    const scipPath = path.join(fixturesDir, "ts.scip");
    fs.writeFileSync(scipPath, buildFixtureScip({ path: "src/b.ts", text: "export const y = 2;\n" }));

    const projDir = makeTmp("atlas-v2-scip-cli-reparse-");
    try {
      const ledgerPath = path.join(projDir, ".posse", "atlas", "ledger.db");
      fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });

      const led = Ledger.open({ dbPath: ledgerPath });
      let originalScipIndexId = null;
      let originalIngestedAt = null;
      try {
        // First ingest writes SCIP rows. Mark the bookkeeping; that row's
        // identity is what `force: true` must bypass.
        const first = await ingestScipFile({ ledger: led, scipPath, repoRoot: projDir, branch: "main" });
        assert.equal(first.skipped, false);
        assert.ok(first.scip_index_id !== null);
        originalScipIndexId = first.scip_index_id;
        const beforeRows = led.listScipIndexes();
        assert.equal(beforeRows.length, 1);
        originalIngestedAt = beforeRows[0].ingested_at;
      } finally {
        led.close();
      }
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Reparse: should NOT skip, and should produce another doc.
      const orig = console.log;
      const lines = [];
      console.log = (...args) => lines.push(args.join(" "));
      try {
        await runAtlasV2Command({ projectDir: projDir, argv: ["scip", "reparse", scipPath] });
        const joined = lines.join("\n");
        assert.match(joined, /\[atlas-v2 scip reparse\]/);
        assert.match(joined, /docs=1/);
        const led = Ledger.open({ dbPath: ledgerPath });
        try {
          const rows = led.listScipIndexes();
          assert.equal(rows.length, 1);
          assert.equal(rows[0].id, originalScipIndexId);
          assert.equal(rows[0].status, "complete");
          assert.notEqual(rows[0].ingested_at, originalIngestedAt);
        } finally {
          led.close();
        }
      } finally {
        console.log = orig;
      }
    } finally {
      try { fs.rmSync(fixturesDir, { recursive: true, force: true }); } catch { /* windows */ }
      try { fs.rmSync(projDir, { recursive: true, force: true }); } catch { /* windows */ }
    }
  });
});
