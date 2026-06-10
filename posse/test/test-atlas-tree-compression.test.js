import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { refreshTreeDerivedState } from "../lib/domains/atlas/functions/v2/tree-derived.js";
import {
  TREE_COMPRESSION_ML_PROFILE,
  TREE_COMPRESSION_PROFILE,
  buildTreeCompressionSnapshot,
  readLatestTreeCompressionSnapshot,
  refreshTreeCompressionSnapshot,
  refreshTreeCompressionSnapshotWithModelPass,
  treeCompressionInputSignature,
} from "../lib/domains/atlas/functions/v2/tree-compression.js";
import { runAtlasTreeCompressionModelPass } from "../lib/domains/integrations/functions/atlas/tree-compression.js";
import {
  installNativeHeartbeatForProcess,
  nativeHeartbeatSkipReason,
} from "./core/support/native-heartbeat.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-tree-compression-${prefix}-`));
}

/**
 * Stand up a view with a small scoring/ui/config repo and its tree-derived
 * state, ready for tree-compression. Returns the open view + named fixtures.
 */
function buildFixtureView(prefix) {
  const repoRoot = makeTmp(prefix);
  const view = new View({ dbPath: path.join(repoRoot, ".posse", "atlas", "view.db"), mode: "readwrite" });
  const db = view._unsafeDb();
  const scoringFile = "src/scoring/fundamentals.ts";
  const scoringTest = "src/scoring/fundamentals.test.ts";
  const uiFile = "src/ui/button.tsx";
  const configFile = "config/app.config.ts";
  const scoringSource = "export class ScoreEngine { calculateWeight() { return 1; } }\n";
  const testSource = "import { ScoreEngine } from './fundamentals'; it('scores', () => new ScoreEngine());\n";
  const uiSource = "export function Button() { return null; }\n";
  const configSource = "export const scoringConfig = {};\n";
  const scoringHash = sha256Hex(scoringSource);
  const testHash = sha256Hex(testSource);
  const uiHash = sha256Hex(uiSource);
  const configHash = sha256Hex(configSource);
  const pathInsert = db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)");
  pathInsert.run(scoringFile, scoringHash);
  pathInsert.run(scoringTest, testHash);
  pathInsert.run(uiFile, uiHash);
  pathInsert.run(configFile, configHash);

  const symIns = db.prepare(
    `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                          repo_rel_path, range_start, range_end, signature_hash, signature_text, visibility, doc, lang)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const scoreEngine = symIns.run(
    scoringHash, 0, "class", "ScoreEngine", "ScoreEngine", null,
    scoringFile, 0, 28, sha256Hex("ScoreEngine"), "class ScoreEngine", "export", null, "ts",
  );
  symIns.run(
    scoringHash, 1, "method", "calculateWeight", "ScoreEngine.calculateWeight", Number(scoreEngine.lastInsertRowid),
    scoringFile, 29, 54, sha256Hex("calculateWeight"), "calculateWeight()", null, null, "ts",
  );
  symIns.run(
    testHash, 0, "function", "scores", "scores", null,
    scoringTest, 0, 40, sha256Hex("scores"), "it scores", null, null, "ts",
  );
  symIns.run(
    uiHash, 0, "function", "Button", "Button", null,
    uiFile, 0, 38, sha256Hex("Button"), "function Button", "export", null, "tsx",
  );

  assert.equal(refreshTreeDerivedState(db).ok, true);
  return { repoRoot, view, db, scoringFile, scoringTest };
}

// The entire tree-compression pipeline — deterministic build AND model pass —
// is owned by the posse-atlas binary, which the heartbeat must authorize. There
// is no Node fallback, so the whole suite is gated on a real key. Skip when none.
describe("ATLAS tree compression snapshot", { skip: nativeHeartbeatSkipReason() ?? false }, () => {
  it("builds deterministic seeds through the binary with carry-forward reseed", async () => {
    const { repoRoot, view, db, scoringFile, scoringTest } = buildFixtureView("ml");
    const priorNativeAtlas = process.env.POSSE_NATIVE_ATLAS;
    const restoreHeartbeat = installNativeHeartbeatForProcess(
      path.join(repoRoot, ".posse", "account.db"),
    );
    process.env.POSSE_NATIVE_ATLAS = "1";
    try {
      const signature = treeCompressionInputSignature(db);
      assert.equal(typeof signature, "string");

      // Deterministic build is binary-routed.
      const dry = buildTreeCompressionSnapshot(db, { maxSeeds: 10 });
      assert.equal(dry.available, true);
      assert.equal(dry.profile, TREE_COMPRESSION_PROFILE);
      assert.ok(dry.seeds.some((seed) => seed.path === "src/scoring"));

      // Deterministic snapshot first, so we can prove per-profile retention keeps
      // it alongside the ML snapshot rather than clobbering it.
      const refreshed = refreshTreeCompressionSnapshot(db, { maxSeeds: 10 });
      assert.equal(refreshed.ok, true, refreshed.error || "deterministic refresh failed");
      assert.equal(refreshed.seedCount > 0, true);

      const deterministic = readLatestTreeCompressionSnapshot(db, { seedLimit: 20 });
      assert.equal(deterministic.snapshot.profile, TREE_COMPRESSION_PROFILE);
      const scoringSeed = deterministic.seeds.find((seed) => seed.path === "src/scoring");
      assert.ok(scoringSeed);
      assert.match(scoringSeed.label, /scoring/);
      assert.ok(scoringSeed.aliases.includes("scoring"));
      assert.ok(scoringSeed.entrypoints.includes(scoringFile));
      assert.ok(scoringSeed.likelyTests.includes(scoringTest));
      assert.ok(scoringSeed.mlFeatures.termVector.includes("score"));
      assert.equal(scoringSeed.signals.testFileCount, 1);
      assert.equal(
        db.prepare("SELECT status FROM derived_state_runs WHERE kind = 'tree-compression-snapshot' ORDER BY id DESC LIMIT 1").get().status,
        "ok",
      );

      // Boot seed: no prior ML snapshot, so every seed is a delta (full pass).
      const modelPass = await refreshTreeCompressionSnapshotWithModelPass(db, {
        maxSeeds: 10,
        modelMaxSeeds: 5,
        annotations: {
          seeds: [{
            path: "src/scoring",
            label: "stock scoring and weighting pipeline",
            aliases: ["rating logic"],
            domainTerms: ["fundamentals"],
            tags: ["scoring"],
            entrypoints: [scoringFile, "src/scoring/not-real.ts"],
            likelyTests: [scoringTest],
            avoidIfQueryOnlyMentions: ["generic UI polish"],
            confidence: 0.91,
            rationale: "scoring symbols and adjacent test identify this domain",
          }],
        },
        modelMetadata: { provider: "test", modelTier: "cheap", modelName: "stub-model" },
      });
      assert.equal(modelPass.ok, true, modelPass.error || "model pass failed");
      assert.ok(modelPass.deltaSeeds > 0, "boot seed should treat every seed as a delta");
      assert.equal(modelPass.carriedForwardSeeds, 0);

      const latestMl = readLatestTreeCompressionSnapshot(db, { seedLimit: 20 });
      assert.equal(latestMl.snapshot.profile, TREE_COMPRESSION_ML_PROFILE);
      const mlScoringSeed = latestMl.seeds.find((seed) => seed.path === "src/scoring");
      assert.ok(mlScoringSeed);
      assert.equal(mlScoringSeed.label, "stock scoring and weighting pipeline");
      assert.ok(mlScoringSeed.aliases.includes("rating logic"));
      assert.ok(mlScoringSeed.aliases.includes("fundamentals"));
      assert.ok(mlScoringSeed.avoidIfQueryOnlyMentions.includes("generic UI polish"));
      assert.ok(mlScoringSeed.entrypoints.includes(scoringFile));
      assert.equal(mlScoringSeed.entrypoints.includes("src/scoring/not-real.ts"), false);
      assert.equal(mlScoringSeed.mlFeatures.modelPass.provider, "test");
      assert.equal(mlScoringSeed.mlFeatures.modelPass.annotated, true);
      // The deterministic signature is stamped + persisted so the next reseed can
      // match unchanged seeds against this snapshot.
      assert.equal(typeof mlScoringSeed.deterministicSignature, "string");
      assert.ok(mlScoringSeed.deterministicSignature.length > 0);
      assert.equal(
        db.prepare("SELECT status FROM derived_state_runs WHERE kind = 'tree-compression-ml-pass' ORDER BY id DESC LIMIT 1").get().status,
        "ok",
      );

      // Per-profile retention: both the deterministic and ML snapshots survive.
      const profiles = db.prepare(
        "SELECT DISTINCT profile FROM atlas_tree_compression_snapshots ORDER BY profile",
      ).all().map((row) => row.profile);
      assert.deepEqual(profiles.sort(), [TREE_COMPRESSION_ML_PROFILE, TREE_COMPRESSION_PROFILE].sort());

      // Reseed with unchanged deterministic content and no annotator: every seed
      // matches the prior signature, so there are zero deltas and the prior model
      // enrichment carries forward untouched (no provider call needed).
      const reseed = await refreshTreeCompressionSnapshotWithModelPass(db, {
        maxSeeds: 10,
        modelMaxSeeds: 5,
        modelMetadata: { provider: "test", modelTier: "cheap", modelName: "stub-model" },
      });
      assert.equal(reseed.ok, true, reseed.error || "reseed failed");
      assert.equal(reseed.deltaSeeds, 0, "unchanged content should produce no deltas");
      assert.ok(reseed.carriedForwardSeeds > 0, "unchanged seeds should carry forward");

      const afterReseed = readLatestTreeCompressionSnapshot(db, { seedLimit: 20 });
      const carriedSeed = afterReseed.seeds.find((seed) => seed.path === "src/scoring");
      assert.ok(carriedSeed);
      assert.equal(carriedSeed.label, "stock scoring and weighting pipeline", "enriched label carried forward");
      assert.equal(carriedSeed.mlFeatures.modelPass.annotated, true);

      // The integration entry point (mode=ml) drives the same binary path.
      const configuredPass = await runAtlasTreeCompressionModelPass({
        viewDb: db,
        config: {
          treeCompressionMode: "ml",
          treeCompressionProvider: "missing-provider",
          treeCompressionModelTier: "cheap",
          treeCompressionMaxSeeds: 10,
          treeCompressionModelMaxSeeds: 5,
        },
        annotator: () => JSON.stringify({
          seeds: [{
            path: "src/scoring",
            label: "configured scoring signal",
            aliases: ["configured alias"],
            confidence: 0.88,
          }],
        }),
      });
      assert.equal(configuredPass.ok, true, configuredPass.error || "configured pass failed");
    } finally {
      if (priorNativeAtlas === undefined) delete process.env.POSSE_NATIVE_ATLAS;
      else process.env.POSSE_NATIVE_ATLAS = priorNativeAtlas;
      restoreHeartbeat();
      view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });
});
