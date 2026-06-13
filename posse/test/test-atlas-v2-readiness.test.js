// test/test-atlas-v2-readiness.test.js
//
// Per-layer ATLAS readiness + readiness-driven self-repair. Readiness is
// computed from on-disk artifacts only (stager meta, view meta, ledger
// blob_layers, keys.db, inflight.json) — there is no global ATLAS boolean.
// Self-repair turns the not-ready layers into coalescing atlas_warm enqueues.

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { LEDGER_DDL, VIEW_DDL } from "../lib/domains/atlas/functions/v2/contracts/ddl/index.js";
import {
  computeAtlasLayerReadiness,
  summarizeAtlasReadiness,
} from "../lib/domains/atlas/functions/v2/readiness.js";
import { enqueueAtlasSelfRepair } from "../lib/domains/atlas/functions/v2/self-repair.js";
import {
  buildFailedStagerMeta,
  buildStagerMeta,
  stagerMetaPathForOutput,
} from "../lib/domains/atlas/functions/v2/scip/stager-meta.js";
import {
  ledgerDbPath,
  mainViewPath,
  embeddingsRoot,
} from "../lib/domains/atlas/functions/v2/runtime-paths.js";
import { closeDb, getDb } from "../lib/shared/storage/functions/index.js";
import { setRuntimePathOverridesForTests } from "../lib/domains/runtime/functions/paths.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function withRuntimeDb(dbPath, fn) {
  closeDb();
  setRuntimePathOverridesForTests({ dbPath });
  try {
    return fn();
  } finally {
    closeDb();
    setRuntimePathOverridesForTests(null);
  }
}

function layer(layers, name) {
  return layers.find((entry) => entry.layer === name) || null;
}

/** Build a ledger.db with parsed blobs and `headSeq` deltas on main. */
function writeLedgerFixture(repoRoot, { indexedBlobs = 2, failedBlobs = 0, headSeq = 3 } = {}) {
  const dbPath = ledgerDbPath(repoRoot);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(LEDGER_DDL);
    db.prepare("INSERT OR IGNORE INTO branches (name, created_at) VALUES ('main', ?)").run(new Date().toISOString());
    db.prepare("INSERT OR IGNORE INTO interned_paths (id, path) VALUES (1, 'src/a.ts')").run();
    const insertBlob = db.prepare(
      "INSERT OR IGNORE INTO blobs (content_hash, lang, byte_size, first_seen_ts) VALUES (?, 'ts', 10, ?)",
    );
    const insertLayer = db.prepare(`
      INSERT INTO blob_layers (content_hash, lang, source, tool_version, parser_spec_version, indexed_at, status)
      VALUES (?, 'ts', 'treesitter', 't1', 's1', ?, ?)
    `);
    const ts = new Date().toISOString();
    for (let i = 0; i < indexedBlobs + failedBlobs; i++) {
      insertBlob.run(`hash-${i}`, ts);
      insertLayer.run(`hash-${i}`, ts, i < indexedBlobs ? "indexed" : "failed");
    }
    const insertDelta = db.prepare(`
      INSERT INTO symbol_deltas (seq, branch, ts, op, path_id, before_content_hash, after_content_hash)
      VALUES (?, 'main', ?, 'modify', 1, 'hash-0', 'hash-0')
    `);
    db.prepare(
      "INSERT INTO symbol_deltas (seq, branch, ts, op, path_id, after_content_hash) VALUES (1, 'main', ?, 'add', 1, 'hash-0')",
    ).run(ts);
    for (let seq = 2; seq <= headSeq; seq++) insertDelta.run(seq, ts);
  } finally {
    db.close();
  }
}

/** Build a main view db with `symbols` rows whose meta says ledger_seq. */
function writeViewFixture(repoRoot, { symbols = 4, ledgerSeq = 3 } = {}) {
  const dbPath = mainViewPath(repoRoot);
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  try {
    db.exec(VIEW_DDL);
    const meta = db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)");
    meta.run("branch", "main");
    meta.run("ledger_seq", String(ledgerSeq));
    meta.run("built_at", new Date().toISOString());
    const insertSymbol = db.prepare(`
      INSERT INTO symbols (content_hash, local_id, kind, name, repo_rel_path, range_start, range_end, signature_hash, lang)
      VALUES (?, ?, 'function', ?, 'src/a.ts', 0, 1, ?, 'ts')
    `);
    for (let i = 0; i < symbols; i++) {
      insertSymbol.run("hash-0", i, `fn_${i}`, `sig-${i}`);
    }
  } finally {
    db.close();
  }
}

/** Build a keys.db model dir with `vectors` rows; optional inflight marker. */
function writeEmbeddingsFixture(repoRoot, { dirName = "stub--v1", vectors = 4, modelVersion = "v1", inflight = false } = {}) {
  const modelDir = path.join(embeddingsRoot(repoRoot), dirName);
  fs.mkdirSync(modelDir, { recursive: true });
  const db = new Database(path.join(modelDir, "keys.db"));
  try {
    db.exec(`
      CREATE TABLE IF NOT EXISTS keys (uid INTEGER PRIMARY KEY, content_hash TEXT NOT NULL, local_id INTEGER NOT NULL, UNIQUE(content_hash, local_id));
      CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS vectors (uid INTEGER PRIMARY KEY, vector BLOB NOT NULL);
    `);
    db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('model_version', ?)").run(modelVersion);
    const insert = db.prepare("INSERT INTO vectors (uid, vector) VALUES (?, x'00')");
    for (let i = 0; i < vectors; i++) insert.run(i + 1);
  } finally {
    db.close();
  }
  if (inflight) {
    fs.writeFileSync(path.join(modelDir, "inflight.json"), JSON.stringify({ started_at: new Date().toISOString(), keys: [{ content_hash: "hash-0", local_id: 0 }] }));
  }
}

async function writeScipFixture(repoRoot, { language = "python", failed = false } = {}) {
  const scipDir = path.join(repoRoot, ".posse", "atlas", "scip");
  fs.mkdirSync(scipDir, { recursive: true });
  const outputPath = path.join(scipDir, `${language}.scip`);
  fs.writeFileSync(outputPath, "scip-bytes");
  const plan = { indexerId: language, label: `scip-${language}`, command: `scip-${language}`, commandSource: "test" };
  const meta = failed
    ? buildFailedStagerMeta(plan, { head: "abc", reason: "stage_failed", error: "exit 1" })
    : buildStagerMeta(plan, { head: "abc" });
  fs.writeFileSync(stagerMetaPathForOutput(outputPath), JSON.stringify(meta, null, 2));
}

describe("ATLAS v2 per-layer readiness", () => {
  it("reports warming/off layers for a repo with no artifacts", () => {
    const tmp = makeTmp("atlas-readiness-empty-");
    try {
      const { layers, notReady } = computeAtlasLayerReadiness({
        repoRoot: tmp,
        config: { scipMode: "off", treeCompressionMode: "off" },
      });
      assert.equal(layer(layers, "treesitter")?.status, "warming");
      assert.equal(layer(layers, "views")?.status, "warming");
      assert.equal(layer(layers, "scip")?.status, "off");
      assert.equal(layer(layers, "tree-compression")?.status, "off");
      assert.equal(layer(layers, "embeddings")?.status, "off", "unconfigured embeddings are off, not broken");
      assert.deepEqual(
        notReady.map((entry) => entry.layer).sort(),
        ["treesitter", "views"],
      );
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports ready layers with coverage from real artifacts", async () => {
    const tmp = makeTmp("atlas-readiness-ready-");
    try {
      writeLedgerFixture(tmp, { indexedBlobs: 2, headSeq: 3 });
      writeViewFixture(tmp, { symbols: 4, ledgerSeq: 3 });
      await writeScipFixture(tmp, { language: "python" });
      writeEmbeddingsFixture(tmp, { vectors: 4, modelVersion: "v1" });
      const { layers, notReady } = computeAtlasLayerReadiness({
        repoRoot: tmp,
        config: { scipMode: "on", treeCompressionMode: "off", embeddingProvider: "stub" },
      });
      assert.equal(layer(layers, "treesitter")?.status, "ready");
      assert.equal(layer(layers, "views")?.status, "ready");
      assert.equal(layer(layers, "scip:python")?.status, "ready");
      assert.equal(layer(layers, "embeddings:v1")?.status, "ready");
      assert.equal(layer(layers, "embeddings:v1")?.coverage, 100);
      assert.deepEqual(notReady, []);
      assert.equal(summarizeAtlasReadiness(layers), "all layers ready");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports a stale view, failed scip stage, and below-parity embeddings", async () => {
    const tmp = makeTmp("atlas-readiness-degraded-");
    try {
      writeLedgerFixture(tmp, { indexedBlobs: 2, headSeq: 10 });
      writeViewFixture(tmp, { symbols: 10, ledgerSeq: 5 });
      await writeScipFixture(tmp, { language: "python", failed: true });
      writeEmbeddingsFixture(tmp, { vectors: 3, modelVersion: "v1", inflight: true });
      const { layers } = computeAtlasLayerReadiness({
        repoRoot: tmp,
        config: { scipMode: "on", treeCompressionMode: "off", embeddingProvider: "stub" },
      });
      const views = layer(layers, "views");
      assert.equal(views?.status, "stale");
      assert.equal(views?.coverage, 50);
      assert.equal(layer(layers, "scip:python")?.status, "failed");
      const embeddings = layer(layers, "embeddings:v1");
      assert.equal(embeddings?.status, "warming");
      assert.equal(embeddings?.coverage, 30);
      assert.match(embeddings?.detail || "", /in flight or interrupted/);
      const summary = summarizeAtlasReadiness(layers);
      assert.match(summary, /views stale 50%/);
      assert.match(summary, /scip:python failed/);
      assert.match(summary, /embeddings:v1 warming 30%/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("treats legacy stager metas without a status field as staged", async () => {
    const tmp = makeTmp("atlas-readiness-legacy-scip-");
    try {
      const scipDir = path.join(tmp, ".posse", "atlas", "scip");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(path.join(scipDir, "typescript.scip"), "scip-bytes");
      fs.writeFileSync(
        path.join(scipDir, "typescript.meta.json"),
        JSON.stringify({ schema_version: 1, language: "typescript", head: "abc" }),
      );
      const { layers } = computeAtlasLayerReadiness({ repoRoot: tmp, config: { scipMode: "on" } });
      assert.equal(layer(layers, "scip:typescript")?.status, "ready");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("surfaces a failed stage whose output was never promoted (failed meta, no .scip)", async () => {
    // A failing indexer writes to a temp path that is only promoted on
    // success, so the normal first-failure state is exactly "failed meta,
    // no artifact". This must surface as scip:<lang> failed — it is what
    // self-repair's restage trigger keys on — even when another language
    // staged successfully.
    const tmp = makeTmp("atlas-readiness-failed-noscip-");
    try {
      await writeScipFixture(tmp, { language: "typescript" }); // healthy sibling
      const scipDir = path.join(tmp, ".posse", "atlas", "scip");
      const plan = { indexerId: "python", label: "scip-python", command: "scip-python", commandSource: "test" };
      const failedMeta = buildFailedStagerMeta(plan, { head: "abc", reason: "stage_failed", error: "exit 1" });
      fs.writeFileSync(path.join(scipDir, "python.meta.json"), JSON.stringify(failedMeta, null, 2));

      const { layers } = computeAtlasLayerReadiness({ repoRoot: tmp, config: { scipMode: "on" } });
      assert.equal(layer(layers, "scip:typescript")?.status, "ready");
      const python = layer(layers, "scip:python");
      assert.equal(python?.status, "failed", "meta-only failure must not be invisible");
      assert.match(python?.detail || "", /no staged output/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("reports warming for a non-failed meta whose staged output is missing", async () => {
    const tmp = makeTmp("atlas-readiness-orphan-meta-");
    try {
      const scipDir = path.join(tmp, ".posse", "atlas", "scip");
      fs.mkdirSync(scipDir, { recursive: true });
      fs.writeFileSync(
        path.join(scipDir, "go.meta.json"),
        JSON.stringify({ schema_version: 1, language: "go", head: "abc", status: "staged" }),
      );
      const { layers } = computeAtlasLayerReadiness({ repoRoot: tmp, config: { scipMode: "on" } });
      const go = layer(layers, "scip:go");
      assert.equal(go?.status, "warming", "a staged meta without its artifact must never read as ready");
      assert.match(go?.detail || "", /output missing/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("excludes symbols without language semantics from the embeddings parity denominator", () => {
    // ingest filters by hasLanguageSemantics and skipped symbols never enter
    // keys.db, so counting them as candidates pins parity below threshold
    // forever (perpetual "warming" + futile self-repair resume warms).
    const tmp = makeTmp("atlas-readiness-inelig-parity-");
    try {
      writeLedgerFixture(tmp, { indexedBlobs: 2, headSeq: 3 });
      writeViewFixture(tmp, { symbols: 4, ledgerSeq: 3 });
      // Add ineligible symbols (no semantics adapter for 'sh') beyond parity slack.
      const db = new Database(mainViewPath(tmp));
      try {
        const insert = db.prepare(`
          INSERT INTO symbols (content_hash, local_id, kind, name, repo_rel_path, range_start, range_end, signature_hash, lang)
          VALUES (?, ?, 'function', ?, 'scripts/x.sh', 0, 1, ?, 'sh')
        `);
        for (let i = 0; i < 6; i++) insert.run("hash-sh", 100 + i, `sh_fn_${i}`, `sh-sig-${i}`);
      } finally {
        db.close();
      }
      writeEmbeddingsFixture(tmp, { vectors: 4, modelVersion: "v1" });
      const { layers } = computeAtlasLayerReadiness({
        repoRoot: tmp,
        config: { scipMode: "off", treeCompressionMode: "off", embeddingProvider: "stub" },
      });
      const embeddings = layer(layers, "embeddings:v1");
      assert.equal(embeddings?.status, "ready", "4/4 encodable symbols is parity; 6 shell symbols must not drag it to 40%");
      assert.equal(embeddings?.coverage, 100);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});

describe("ATLAS v2 self-repair", () => {
  it("enqueues a main-full warm when the view layer is missing", () => {
    const tmp = makeTmp("atlas-self-repair-views-");
    try {
      const repoRoot = path.join(tmp, "repo");
      fs.mkdirSync(repoRoot, { recursive: true });
      withRuntimeDb(path.join(tmp, "orchestrator.db"), () => {
        const result = enqueueAtlasSelfRepair({
          repoRoot,
          config: { enabled: true, scipMode: "off", treeCompressionMode: "off" },
          reason: "boot_reindex_failed: test",
        });
        assert.equal(result.ok, true);
        const repairAction = result.actions.find((action) => action.event === "atlas.self_repair");
        assert.ok(repairAction, "structural damage must queue a self-repair warm");

        const db = getDb();
        const job = db.prepare("SELECT * FROM jobs WHERE id = ?").get(repairAction.warmJobId);
        assert.equal(job.job_type, "atlas_warm");
        const payload = JSON.parse(job.payload_json);
        assert.equal(payload.purpose, "main-full");
        assert.equal(payload.trigger_event, "atlas.self_repair");

        // Repeated triggers coalesce onto the queued job instead of stacking.
        const again = enqueueAtlasSelfRepair({
          repoRoot,
          config: { enabled: true, scipMode: "off", treeCompressionMode: "off" },
          reason: "boot_wait_failed: test",
        });
        const againAction = again.actions.find((action) => action.event === "atlas.self_repair");
        assert.equal(againAction?.warmJobId, repairAction.warmJobId);
        assert.equal(againAction?.coalesced, true);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("enqueues scip restage and embeddings resume for non-structural gaps", async () => {
    const tmp = makeTmp("atlas-self-repair-layers-");
    try {
      const repoRoot = path.join(tmp, "repo");
      fs.mkdirSync(repoRoot, { recursive: true });
      writeLedgerFixture(repoRoot, { indexedBlobs: 2, headSeq: 3 });
      writeViewFixture(repoRoot, { symbols: 10, ledgerSeq: 3 });
      await writeScipFixture(repoRoot, { language: "python", failed: true });
      writeEmbeddingsFixture(repoRoot, { vectors: 2, modelVersion: "v1" });
      withRuntimeDb(path.join(tmp, "orchestrator.db"), () => {
        const result = enqueueAtlasSelfRepair({
          repoRoot,
          config: { enabled: true, scipMode: "on", treeCompressionMode: "off", embeddingProvider: "stub" },
          reason: "boot_background_failed: test",
        });
        assert.equal(result.ok, true);
        assert.ok(!result.actions.some((action) => action.event === "atlas.self_repair"), "views are ready — no structural rebuild");

        const db = getDb();
        const scipAction = result.actions.find((action) => action.layer === "scip");
        assert.ok(scipAction, "failed scip meta must queue a restage");
        const scipPayload = JSON.parse(db.prepare("SELECT payload_json FROM jobs WHERE id = ?").get(scipAction.warmJobId).payload_json);
        assert.equal(scipPayload.purpose, "scip-restage");

        const embeddingsAction = result.actions.find((action) => action.layer.startsWith("embeddings"));
        assert.ok(embeddingsAction, "below-parity embeddings must queue a resume warm");
        const embPayload = JSON.parse(db.prepare("SELECT payload_json FROM jobs WHERE id = ?").get(embeddingsAction.warmJobId).payload_json);
        assert.equal(embPayload.purpose, "embeddings");
        assert.equal(embPayload.branch, "main");
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("does nothing when all layers are ready or off", async () => {
    const tmp = makeTmp("atlas-self-repair-noop-");
    try {
      const repoRoot = path.join(tmp, "repo");
      fs.mkdirSync(repoRoot, { recursive: true });
      writeLedgerFixture(repoRoot, { indexedBlobs: 2, headSeq: 3 });
      writeViewFixture(repoRoot, { symbols: 4, ledgerSeq: 3 });
      withRuntimeDb(path.join(tmp, "orchestrator.db"), () => {
        const result = enqueueAtlasSelfRepair({
          repoRoot,
          config: { enabled: true, scipMode: "off", treeCompressionMode: "off" },
          reason: "boot_wait_failed: test",
        });
        assert.equal(result.ok, true);
        assert.deepEqual(result.actions, []);
        const db = getDb();
        const count = db.prepare("SELECT COUNT(*) AS c FROM jobs").get().c;
        assert.equal(count, 0);
      });
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it("skips when atlas is disabled at the config level", () => {
    const tmp = makeTmp("atlas-self-repair-disabled-");
    try {
      const result = enqueueAtlasSelfRepair({
        repoRoot: tmp,
        config: { enabled: false },
        reason: "boot_reindex_failed: test",
      });
      assert.equal(result.ok, false);
      assert.equal(result.skipped, "atlas_disabled");
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
