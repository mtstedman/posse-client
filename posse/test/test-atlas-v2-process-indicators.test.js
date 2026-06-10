import { describe, it, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { Display } from "../lib/domains/ui/classes/display/Display.js";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { JOB_TYPE_ABBR } from "../lib/domains/ui/functions/display/helpers/job-status.js";
import { C } from "../lib/shared/format/functions/colors.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import {
  describeAtlasWarmJob,
  loadAtlasV2ProcessIndicators,
  renderAtlasV2ProcessIndicators,
} from "../lib/domains/atlas/functions/v2/process-indicators.js";
import { ledgerDbPath, mainViewPath } from "../lib/domains/atlas/functions/v2/runtime-paths.js";

const tmpRoots = [];

function tmpDir(name) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), name));
  tmpRoots.push(dir);
  return dir;
}

function stripAnsi(value) {
  return String(value || "").replace(/\x1b\[[0-9;]*m/g, "");
}

function seedIndexedRepo(repoRoot) {
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, "src", "demo.ts"), "export class Demo { run() {} }\n");
  const ledger = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
  const content = "export class Demo { run() {} }\n";
  const hash = sha256Hex(Buffer.from(content));
  const symbols = [
    {
      content_hash: hash,
      local_id: 0,
      kind: "class",
      name: "Demo",
      qualified_name: "Demo",
      parent_local_id: null,
      repo_rel_path: "src/demo.ts",
      lang: "ts",
      range_start: 7,
      range_end: 17,
      signature_hash: sha256Hex("class Demo"),
      visibility: "public",
      doc: null,
    },
    {
      content_hash: hash,
      local_id: 1,
      kind: "method",
      name: "run",
      qualified_name: "Demo.run",
      parent_local_id: 0,
      repo_rel_path: "src/demo.ts",
      lang: "ts",
      range_start: 20,
      range_end: 26,
      signature_hash: sha256Hex("Demo.run()"),
      visibility: "public",
      doc: null,
    },
  ];
  ledger.ingestBlob({
    content_hash: hash,
    lang: "ts",
    byte_size: Buffer.byteLength(content),
    symbols,
    edges: [{
      from_content_hash: hash,
      from_local_id: 1,
      edge_id: 0,
      to_content_hash: hash,
      to_local_id: 0,
      to_name: "Demo",
      to_module: null,
      kind: "references",
      range_start: 20,
      range_end: 24,
      confidence: 100,
    }],
  });
  ledger.append({
    branch: "main",
    op: "add",
    repo_rel_path: "src/demo.ts",
    before_content_hash: null,
    after_content_hash: hash,
  });
  new ViewBuilder().buildFrom({
    ledger,
    branch: "main",
    atSeq: ledger.headSeq("main"),
    outPath: mainViewPath(repoRoot),
    options: { repoRoot },
  });
  ledger.close();
}

function makeHostDb() {
  const db = new Database(":memory:");
  db.exec(`
    CREATE TABLE jobs (
      id INTEGER PRIMARY KEY,
      work_item_id INTEGER,
      job_type TEXT NOT NULL,
      status TEXT NOT NULL,
      payload_json TEXT,
      result_json TEXT,
      last_error TEXT,
      created_at TEXT,
      updated_at TEXT,
      started_at TEXT,
      finished_at TEXT
    );
  `);
  const insert = db.prepare(`
    INSERT INTO jobs (
      id, work_item_id, job_type, status, payload_json, result_json,
      last_error, created_at, updated_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  insert.run(
    1,
    null,
    "atlas_warm",
    "running",
    JSON.stringify({ purpose: "main-full", branch: "main", paths: ["src/demo.ts"] }),
    null,
    null,
    "2026-05-19T00:00:00.000Z",
    "2026-05-19T00:00:01.000Z",
    "2026-05-19T00:00:01.000Z",
    null,
  );
  insert.run(
    2,
    7,
    "atlas_warm",
    "queued",
    JSON.stringify({ purpose: "wi", work_item_id: 7, paths: ["src/demo.ts"], _atlas_event_count: 2 }),
    null,
    null,
    "2026-05-19T00:00:02.000Z",
    "2026-05-19T00:00:02.000Z",
    null,
    null,
  );
  insert.run(
    3,
    null,
    "atlas_warm",
    "succeeded",
    JSON.stringify({ purpose: "main-incremental", branch: "main" }),
    JSON.stringify({
      paths_considered: 1,
      paths_indexed: 1,
      ledger_entries_appended: 1,
      blobs_ingested: 0,
      blobs_reused: 1,
      skipped: [],
      duration_ms: 12,
    }),
    null,
    "2026-05-19T00:00:03.000Z",
    "2026-05-19T00:00:04.000Z",
    "2026-05-19T00:00:03.000Z",
    "2026-05-19T00:00:04.000Z",
  );
  return db;
}

function makeCleanupOnlyHostDb() {
  const db = makeHostDb();
  db.prepare("DELETE FROM jobs").run();
  db.prepare(`
    INSERT INTO jobs (
      id, work_item_id, job_type, status, payload_json, result_json,
      last_error, created_at, updated_at, started_at, finished_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    9,
    41,
    "atlas_warm",
    "queued",
    JSON.stringify({ purpose: "wi-cleanup", work_item_id: 41, branch: "wi-41" }),
    null,
    null,
    "2026-05-19T00:00:05.000Z",
    "2026-05-19T00:00:05.000Z",
    null,
    null,
  );
  return db;
}

after(() => {
  for (const dir of tmpRoots) {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ }
  }
});

describe("ATLAS v2 process indicators", () => {
  it("loads and renders index and edge health from ledger, view, and warm queue", () => {
    const repoRoot = tmpDir("atlas-v2-process-");
    seedIndexedRepo(repoRoot);
    const db = makeHostDb();
    try {
      const indicators = loadAtlasV2ProcessIndicators({ projectDir: repoRoot, db, limit: 6 });
      assert.equal(indicators.state, "warming");
      assert.equal(indicators.ledger.symbols, 2);
      assert.equal(indicators.main_view.edges, 1);
      assert.equal(indicators.queue.by_status.running, 1);
      assert.equal(indicators.queue.by_status.queued, 1);

      const rendered = renderAtlasV2ProcessIndicators(indicators, { colors: C, width: 100 })
        .map(stripAnsi)
        .join("\n");
      assert.match(rendered, /Context health warming/);
      assert.match(rendered, /Index/);
      assert.match(rendered, /Edges/);
      assert.match(rendered, /100% resolved/);
      assert.match(rendered, /code map running=1/);
      assert.match(rendered, /context prep queued=2/);
    } finally {
      db.close();
    }
  });

  it("collapses unattached atlas_warm jobs into the warm queue label", () => {
    assert.equal(JOB_TYPE_ABBR.atlas_warm, "W");
    const display = new Display({ concurrency: 3 });
    display._getQueueData = () => ({
      workItems: [],
      jobs: [{
        id: 44,
        work_item_id: null,
        job_type: "atlas_warm",
        title: "ATLAS warm: main-full",
        status: "queued",
        payload_json: JSON.stringify({ purpose: "main-full", branch: "main", paths: ["src/demo.ts", "src/extra.ts"] }),
      }],
    });
    const lines = display._buildQueue(96, 8).map(stripAnsi).join("\n");
    assert.match(lines, /Context health/);
    assert.match(lines, /Code map/);
    assert.match(lines, /1 queued/);
    assert.doesNotMatch(lines, /\[W\]/);
    assert.doesNotMatch(lines, /main-full main 2 paths/);
  });

  it("keeps cleanup-only ATLAS work out of graph freshness debt", () => {
    const repoRoot = tmpDir("atlas-v2-cleanup-only-");
    seedIndexedRepo(repoRoot);
    const db = makeCleanupOnlyHostDb();
    try {
      const indicators = loadAtlasV2ProcessIndicators({ projectDir: repoRoot, db, limit: 6 });
      assert.equal(indicators.state, "ready");

      const rendered = renderAtlasV2ProcessIndicators(indicators, { colors: C, width: 100 })
        .map(stripAnsi)
        .join("\n");
      assert.match(rendered, /Context health ready/);
      assert.match(rendered, /cleanup queued=1/);
    } finally {
      db.close();
    }
  });

  it("summarizes warm-job payloads for display status tags", () => {
    assert.deepEqual(
      describeAtlasWarmJob({
        payload_json: JSON.stringify({ purpose: "main-merge", work_item_id: 12, paths: ["src/demo.ts"] }),
      }),
      { purpose: "main-merge", target: "wi-12", paths: 1, eventCount: 1 },
    );
  });
});
