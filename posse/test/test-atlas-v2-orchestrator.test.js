// test/test-atlas-v2-orchestrator.test.js
//
// Hybrid retrieval orchestrator (Item #4 from the parity port plan).
// Covers: RRF math, FTS-only sync path, vector-unavailable fallback,
// feedback boost via the ledger, task-query re-ranking, end-to-end
// integration through symbol.search and agent.feedback.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { VIEW_SCHEMA_VERSION } from "../lib/domains/atlas/functions/v2/contracts/ddl/index.js";
import { hybridSearch, RRF_K } from "../lib/domains/atlas/functions/v2/retrieval/orchestrator/index.js";
import { runEntityFtsBackends } from "../lib/domains/atlas/functions/v2/retrieval/orchestrator/backends/entity-fts.js";
import { rrfFuse, toRanked } from "../lib/domains/atlas/functions/v2/retrieval/orchestrator/rrf.js";
import {
  applyFeedbackBoost,
  buildFeedbackIndex,
} from "../lib/domains/atlas/functions/v2/retrieval/orchestrator/feedback-boost.js";
import { applyTaskQueryRanking } from "../lib/domains/atlas/functions/v2/retrieval/orchestrator/task-query-ranking.js";
import { dispatch } from "../lib/domains/atlas/functions/v2/retrieval/index.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-v2-orch-${prefix}-`));
}

function hashOf(s) {
  return sha256Hex(Buffer.from(s));
}

/**
 * Seed a view + ledger pair. Two TS files with three named symbols
 * each (different names per file). Adequate for ranking-divergence
 * checks without standing up a real parser.
 */
function buildFixture(tmpRoot) {
  const ledgerPath = path.join(tmpRoot, "ledger.db");
  const viewPath = path.join(tmpRoot, "view.db");
  const ledger = Ledger.open({ dbPath: ledgerPath });

  const fileA = "src/login.ts";
  const fileB = "src/logout.ts";
  const sourceA = "export function loginUser() {}\nexport function loginAdmin() {}\n";
  const sourceB = "export function logoutUser() {}\nexport function logoutAdmin() {}\n";
  const hashA = hashOf(sourceA);
  const hashB = hashOf(sourceB);

  // Populate the view via direct SQL — ViewBuilder is not on the
  // critical path for this suite; the corpus suite covers it.
  const view = new View({ dbPath: viewPath, mode: "readwrite" });
  const db = view._unsafeDb();
  db.exec("DELETE FROM meta");
  const m = db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)");
  m.run("schema_version", String(VIEW_SCHEMA_VERSION));
  m.run("branch", "main");
  m.run("ledger_seq", "0");
  m.run("built_at", new Date().toISOString());

  db.exec("DELETE FROM path_to_blob");
  const pIns = db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)");
  pIns.run(fileA, hashA);
  pIns.run(fileB, hashB);

  db.exec("DELETE FROM symbols");
  const symIns = db.prepare(
    `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                          repo_rel_path, range_start, range_end, signature_hash, visibility, doc, lang)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const ids = {};
  ids.loginUser = `${hashA}:0`;
  ids.loginAdmin = `${hashA}:1`;
  ids.logoutUser = `${hashB}:0`;
  ids.logoutAdmin = `${hashB}:1`;
  symIns.run(hashA, 0, "function", "loginUser", "auth.loginUser", null, fileA, 0, 30, sha256Hex("loginUser"), null, null, "ts");
  symIns.run(hashA, 1, "function", "loginAdmin", "auth.loginAdmin", null, fileA, 31, 64, sha256Hex("loginAdmin"), null, null, "ts");
  symIns.run(hashB, 0, "function", "logoutUser", "auth.logoutUser", null, fileB, 0, 32, sha256Hex("logoutUser"), null, null, "ts");
  symIns.run(hashB, 1, "function", "logoutAdmin", "auth.logoutAdmin", null, fileB, 33, 66, sha256Hex("logoutAdmin"), null, null, "ts");

  return { view, ledger, ids, hashA, hashB, fileA, fileB, viewPath, ledgerPath };
}

describe("orchestrator/rrf", () => {
  it("fuses ranked lists with sum 1/(k+rank)", () => {
    const a = toRanked([{ id: "x" }, { id: "y" }, { id: "z" }], (p) => p.id);
    const b = toRanked([{ id: "y" }, { id: "w" }, { id: "x" }], (p) => p.id);
    const fused = rrfFuse({ a, b }, { k: 60 });

    // y appears at rank 2 (a) and rank 1 (b) -> 1/62 + 1/61
    // x appears at rank 1 (a) and rank 3 (b) -> 1/61 + 1/63
    // w appears at rank 2 (b) -> 1/62
    // z appears at rank 3 (a) -> 1/63
    const score = (id) => fused.find((e) => e.id === id)?.score;
    assert.ok(Math.abs(score("y") - (1 / 62 + 1 / 61)) < 1e-12);
    assert.ok(Math.abs(score("x") - (1 / 61 + 1 / 63)) < 1e-12);
    assert.ok(Math.abs(score("w") - 1 / 62) < 1e-12);
    assert.ok(Math.abs(score("z") - 1 / 63) < 1e-12);

    // y should rank first, then x, then w, then z.
    assert.deepEqual(fused.map((e) => e.id), ["y", "x", "w", "z"]);
  });

  it("default k is 60", () => {
    assert.equal(RRF_K, 60);
  });

  it("returns rank-ordered output for a single backend", () => {
    const a = toRanked([{ id: "b" }, { id: "a" }], (p) => p.id);
    const fused = rrfFuse({ a });
    assert.deepEqual(fused.map((e) => e.id), ["b", "a"]);

    // Tied scores break by id collation.
    const lhs = toRanked([{ id: "c" }], (p) => p.id);
    const rhs = toRanked([{ id: "a" }], (p) => p.id);
    const fused2 = rrfFuse({ lhs, rhs });
    assert.deepEqual(fused2.map((e) => e.id), ["a", "c"]);
  });

  it("ignores entries with empty ids", () => {
    const a = toRanked([{ id: "" }, { id: "x" }], (p) => p.id);
    const fused = rrfFuse({ a });
    assert.equal(fused.length, 1);
    assert.equal(fused[0].id, "x");
  });
});

describe("orchestrator/hybridSearch FTS path", () => {
  let env;
  let tmp;

  before(() => {
    tmp = makeTmp("hybrid");
    env = buildFixture(tmp);
  });

  after(() => {
    env.view.close();
    env.ledger.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("returns synchronously when no vector backend is wired", () => {
    const result = hybridSearch({
      view: env.view,
      query: "login",
      options: { limit: 5 },
    });
    assert.ok(!result.then, "expected sync result without encoder");
    assert.ok(result.items.length > 0);
    const names = result.items.map((i) => i.payload.name);
    assert.ok(
      names.indexOf("loginUser") < names.indexOf("logoutUser") ||
        !names.includes("logoutUser"),
    );
  });

  it("degraded report names fts when vector is unavailable", () => {
    const result = hybridSearch({ view: env.view, query: "login" });
    const r = /** @type {any} */ (result);
    assert.equal(r.degraded.backends.fts.ok, true);
    assert.equal(r.degraded.backends.vector.ok, false);
    assert.equal(r.degraded.backends.vector.reason, "unavailable");
    assert.deepEqual(r.degraded.active, ["fts"]);
    assert.deepEqual(r.degraded.unavailable, ["vector"]);
    assert.equal(r.degraded.fullyDegraded, false);
  });

  it("reports index_empty when semantic search is wired but has no hits", async () => {
    const result = await hybridSearch({
      view: env.view,
      query: "login",
      embeddingIndex: {
        dim: 2,
        nearest: async () => [],
      },
      encoder: {
        dim: 2,
        model: "stub",
        encode: async () => [new Float32Array([1, 0])],
      },
      options: { semantic: true, limit: 5 },
    });
    assert.equal(result.degraded.backends.fts.ok, true);
    assert.equal(result.degraded.backends.vector.ok, false);
    assert.equal(result.degraded.backends.vector.reason, "index_empty");
    assert.deepEqual(result.degraded.active, ["fts"]);
  });

  it("degrades to empty result on empty query rather than throwing", () => {
    const result = hybridSearch({ view: env.view, query: "" });
    const r = /** @type {any} */ (result);
    assert.equal(r.items.length, 0);
    assert.equal(r.degraded.fullyDegraded, true);
  });

  it("does not report fullyDegraded when a healthy backend returns zero matches", () => {
    const result = hybridSearch({ view: env.view, query: "noSuchLoginSymbolAnywhere" });
    const r = /** @type {any} */ (result);
    assert.equal(r.items.length, 0);
    assert.equal(r.degraded.backends.fts.ok, true);
    assert.equal(r.degraded.fullyDegraded, false);
  });

  it("recovers symbol hits from natural-language task queries", () => {
    const result = hybridSearch({
      view: env.view,
      query: "fix admin login flow",
      options: { limit: 5, taskText: "fix admin login flow" },
    });
    const r = /** @type {any} */ (result);
    const names = r.items.map((item) => item.payload.name);
    assert.ok(names.includes("loginAdmin"), `expected loginAdmin in ${names.join(",")}`);
    assert.ok(
      names.indexOf("loginAdmin") < names.indexOf("loginUser"),
      `expected loginAdmin above loginUser; got ${names.join(",")}`,
    );
  });
});

describe("orchestrator/feedback-boost", () => {
  let env;
  let tmp;

  before(() => {
    tmp = makeTmp("boost");
    env = buildFixture(tmp);
  });

  after(() => {
    env.view.close();
    env.ledger.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("ledger.recordFeedback persists and recentFeedback aggregates", () => {
    const inserted = env.ledger.recordFeedback({
      sliceHandle: "sl_test",
      usefulSymbolIds: [env.ids.loginAdmin, env.ids.loginAdmin],
      missingSymbolIds: [env.ids.loginUser],
      taskType: "debug",
      taskText: "investigating login admin bug",
    });
    assert.equal(inserted, 3);

    const rows = env.ledger.recentFeedback({ taskType: "debug" });
    const byId = new Map(rows.map((r) => [`${r.content_hash}:${r.local_id}`, r]));
    assert.equal(byId.get(env.ids.loginAdmin).useful_count, 2);
    assert.equal(byId.get(env.ids.loginAdmin).missing_count, 0);
    assert.equal(byId.get(env.ids.loginUser).useful_count, 0);
    assert.equal(byId.get(env.ids.loginUser).missing_count, 1);
  });

  it("malformed symbol ids are skipped", () => {
    const inserted = env.ledger.recordFeedback({
      usefulSymbolIds: ["not-a-hash:0", "deadbeef:0", null, ""],
      missingSymbolIds: [],
    });
    assert.equal(inserted, 0);
  });

  it("applyFeedbackBoost re-ranks fused entries when net signal is positive", () => {
    const a = toRanked(
      [
        { id: env.ids.loginUser, name: "loginUser", payload: 1 },
        { id: env.ids.loginAdmin, name: "loginAdmin", payload: 2 },
      ],
      (p) => p.id,
    );
    const fused = rrfFuse({ a }, { k: 60 });
    // Pre-boost loginUser ranks first (rank 1 in `a`).
    assert.equal(fused[0].id, env.ids.loginUser);

    const feedbackIndex = buildFeedbackIndex({ ledger: env.ledger });
    assert.ok(feedbackIndex);
    applyFeedbackBoost(fused, feedbackIndex);
    // Post-boost loginAdmin wins on the +2 useful_count delta.
    assert.equal(fused[0].id, env.ids.loginAdmin);
  });

  it("buildFeedbackIndex filters unrelated prior task text", () => {
    const t2 = makeTmp("boost-task-text");
    const fresh = buildFixture(t2);
    try {
      fresh.ledger.recordFeedback({
        usefulSymbolIds: [fresh.ids.logoutAdmin],
        missingSymbolIds: [],
        taskType: "debug",
        taskText: "investigate logout admin regression",
      });
      fresh.ledger.recordFeedback({
        usefulSymbolIds: [fresh.ids.loginAdmin],
        missingSymbolIds: [],
        taskType: "debug",
        taskText: "investigate login admin regression",
      });

      const broad = buildFeedbackIndex({ ledger: fresh.ledger, taskType: "debug" });
      assert.ok(broad?.has(fresh.ids.logoutAdmin), "baseline should include same-type feedback");
      assert.ok(broad?.has(fresh.ids.loginAdmin), "baseline should include same-type feedback");

      const filtered = buildFeedbackIndex({
        ledger: fresh.ledger,
        taskType: "debug",
        taskText: "fix login admin flow",
      });
      assert.ok(filtered?.has(fresh.ids.loginAdmin), "matching task text should survive");
      assert.equal(filtered?.has(fresh.ids.logoutAdmin), false);
    } finally {
      fresh.view.close();
      fresh.ledger.close();
      try {
        fs.rmSync(t2, { recursive: true, force: true });
      } catch {}
    }
  });

  it("buildFeedbackIndex tolerates no ledger and returns null", () => {
    const idx = buildFeedbackIndex({ ledger: undefined });
    assert.equal(idx, null);
  });
});

describe("orchestrator/task-query-ranking", () => {
  let env;
  let tmp;

  before(() => {
    tmp = makeTmp("task");
    env = buildFixture(tmp);
  });

  after(() => {
    env.view.close();
    env.ledger.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("promotes symbols whose name tokens overlap with taskText", () => {
    const result = hybridSearch({
      view: env.view,
      query: "login",
      options: { taskText: "fix the admin login flow", limit: 4 },
    });
    const r = /** @type {any} */ (result);
    const names = r.items.map((i) => i.payload.name);
    const adminIdx = names.indexOf("loginAdmin");
    const userIdx = names.indexOf("loginUser");
    assert.ok(adminIdx >= 0);
    assert.ok(userIdx >= 0);
    assert.ok(
      adminIdx < userIdx,
      `expected loginAdmin to rank above loginUser; got ${names.join(",")}`,
    );
  });

  it("is a no-op when taskText is missing", () => {
    const fused = rrfFuse({
      a: toRanked([{ id: "loginAdmin" }, { id: "loginUser" }], (p) => p.id),
    });
    const before = fused.map((e) => ({ id: e.id, score: e.score }));
    applyTaskQueryRanking(/** @type {any} */ (fused), undefined);
    assert.deepEqual(
      fused.map((e) => ({ id: e.id, score: e.score })),
      before,
    );
  });
});

describe("symbol.search integration with orchestrator", () => {
  let env;
  let tmp;

  before(() => {
    tmp = makeTmp("dispatch");
    env = buildFixture(tmp);
  });

  after(() => {
    env.view.close();
    env.ledger.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it("dispatch returns sync result when no encoder is passed", () => {
    const r = dispatch(
      /** @type {any} */ ({ action: "symbol.search", query: "login", limit: 5 }),
      { view: env.view, versionId: "v1" },
    );
    assert.ok(!r.then);
    assert.equal(r.ok, true);
    assert.ok(r.data.items.length > 0);
  });

  it("agent.feedback persists into ledger when ledger is provided", async () => {
    const r = await dispatch(
      /** @type {any} */ ({
        action: "agent.feedback",
        sliceHandle: "sl_x",
        usefulSymbols: [env.ids.loginUser],
        missingSymbols: [env.ids.logoutAdmin],
        taskType: "review",
      }),
      { view: env.view, versionId: "v1", ledger: env.ledger },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.recorded, true);
    assert.equal(r.data.usefulCount, 1);
    assert.equal(r.data.missingCount, 1);
    const rows = env.ledger.recentFeedback({ taskType: "review" });
    const ids = rows.map((row) => `${row.content_hash}:${row.local_id}`);
    assert.ok(ids.includes(env.ids.loginUser));
    assert.ok(ids.includes(env.ids.logoutAdmin));
  });

  it("agent.feedback without a ledger still returns ok=true", async () => {
    const r = await dispatch(
      /** @type {any} */ ({
        action: "agent.feedback",
        sliceHandle: "sl_y",
        usefulSymbols: [env.ids.loginUser],
        missingSymbols: [],
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.recorded, true);
    assert.equal(r.data.usefulCount, 1);
  });

  it("agent.feedback surfaces ledger write failures without failing the envelope", async () => {
    const originalWarn = console.warn;
    const warnings = [];
    console.warn = (message) => { warnings.push(String(message)); };
    try {
      const r = await dispatch(
        /** @type {any} */ ({
          action: "agent.feedback",
          sliceHandle: "sl_z",
          usefulSymbols: [env.ids.loginUser],
          missingSymbols: [],
        }),
        {
          view: env.view,
          versionId: "v1",
          ledger: {
            recordFeedback() {
              throw new Error("feedback store unavailable");
            },
          },
        },
      );
      assert.equal(r.ok, true);
      assert.equal(r.data.recorded, false);
      assert.match(r.data.errorMessage, /feedback store unavailable/);
      assert.ok(warnings.some((line) => line.includes("feedback store unavailable")));
    } finally {
      console.warn = originalWarn;
    }
  });

  it("dispatch threads ledger into symbol.search so prior feedback alters ranking", () => {
    const t2 = makeTmp("dispatch-boost");
    const fresh = buildFixture(t2);
    try {
      for (let i = 0; i < 3; i++) {
        fresh.ledger.recordFeedback({
          usefulSymbolIds: [fresh.ids.loginAdmin],
          missingSymbolIds: [fresh.ids.loginUser],
        });
      }
      const r = dispatch(
        /** @type {any} */ ({ action: "symbol.search", query: "login", limit: 4 }),
        { view: fresh.view, versionId: "v1", ledger: fresh.ledger },
      );
      assert.equal(r.ok, true);
      const names = r.data.items.map((i) => i.name);
      assert.ok(
        names.indexOf("loginAdmin") < names.indexOf("loginUser"),
        `expected loginAdmin above loginUser after feedback; got ${names.join(",")}`,
      );
    } finally {
      fresh.view.close();
      fresh.ledger.close();
      try {
        fs.rmSync(t2, { recursive: true, force: true });
      } catch {}
    }
  });

  it("symbol.search envelope meta carries backendHealth and queryPlan", () => {
    const r = dispatch(
      /** @type {any} */ ({ action: "symbol.search", query: "login", limit: 4 }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    const health = r.meta?.backendHealth;
    assert.ok(health, "expected meta.backendHealth on symbol.search");
    assert.equal(health.backends.fts.ok, true);
    assert.equal(health.backends.vector.ok, false);
    assert.deepEqual(health.active, ["fts"]);
    assert.deepEqual(health.unavailable, ["vector"]);
    assert.equal(health.fullyDegraded, false);
    const plan = r.meta?.queryPlan;
    assert.ok(plan, "expected meta.queryPlan on symbol.search");
    assert.ok(plan.keywords.includes("login"));
    assert.equal(plan.identifierLike, false);
  });
});

describe("orchestrator/entity FTS", () => {
  it("preserves SQLite negative BM25 ordering without quantizing ties", () => {
    const fakeDb = {
      prepare(sql) {
        if (sql.includes("sqlite_master")) {
          return { get: () => ({ name: "memories_fts" }) };
        }
        if (sql.includes("FROM memories_fts")) {
          return {
            all: () => [
              {
                memory_id: "mem_best",
                title: "Best",
                content: "auth middleware cookie",
                repo_id: "repo",
                type: "decision",
                tags_json: "[]",
                updated_at: "2026-05-26T00:00:00.000Z",
                _fts_rank: -0.00000168,
              },
              {
                memory_id: "mem_middle",
                title: "Zulu",
                content: "auth middleware cookie",
                repo_id: "repo",
                type: "decision",
                tags_json: "[]",
                updated_at: "2026-05-26T00:00:00.000Z",
                _fts_rank: -0.00000105,
              },
              {
                memory_id: "mem_weak",
                title: "Alpha",
                content: "auth middleware cookie",
                repo_id: "repo",
                type: "decision",
                tags_json: "[]",
                updated_at: "2026-05-26T00:00:00.000Z",
                _fts_rank: -0.000000768,
              },
            ],
          };
        }
        throw new Error(`unexpected SQL: ${sql}`);
      },
    };
    const hits = runEntityFtsBackends({
      ledger: /** @type {any} */ ({ _unsafeDb: () => fakeDb }),
      query: "auth",
      repoId: "repo",
      entities: ["memories"],
      limit: 10,
    });
    assert.deepEqual(hits.map((hit) => hit.id), ["mem_best", "mem_middle", "mem_weak"]);
    assert.ok(hits[0].score > hits[1].score);
    assert.ok(hits[1].score > hits[2].score);
  });

  it("does not search memory entities without a repo id", () => {
    let memoryQueried = false;
    const fakeDb = {
      prepare(sql) {
        if (sql.includes("sqlite_master")) {
          return { get: () => ({ name: "memories_fts" }) };
        }
        if (sql.includes("FROM memories_fts")) {
          memoryQueried = true;
        }
        return { all: () => [] };
      },
    };
    const hits = runEntityFtsBackends({
      ledger: /** @type {any} */ ({ _unsafeDb: () => fakeDb }),
      query: "auth",
      entities: ["memories"],
      limit: 10,
    });

    assert.deepEqual(hits, []);
    assert.equal(memoryQueried, false);
  });

  it("warns when an entity FTS query fails", () => {
    const warnings = [];
    const originalWarn = console.warn;
    const fakeDb = {
      prepare(sql) {
        if (sql.includes("sqlite_master")) {
          return { get: () => ({ name: "memories_fts" }) };
        }
        return { all: () => { throw new Error("malformed MATCH"); } };
      },
    };
    console.warn = (...args) => { warnings.push(args.join(" ")); };
    try {
      const hits = runEntityFtsBackends({
        ledger: /** @type {any} */ ({ _unsafeDb: () => fakeDb }),
        query: "auth",
        repoId: "repo",
        entities: ["memories"],
        limit: 10,
      });
      assert.deepEqual(hits, []);
    } finally {
      console.warn = originalWarn;
    }
    assert.ok(
      warnings.some((line) => line.includes("[atlas-v2 entity-fts] memories search failed") && line.includes("malformed MATCH")),
      `expected entity FTS warning, got ${JSON.stringify(warnings)}`,
    );
  });
});

describe("orchestrator/feedback decay", () => {
  let env;
  let tmp;

  before(() => {
    tmp = makeTmp("decay");
    env = buildFixture(tmp);
  });

  after(() => {
    env.view.close();
    env.ledger.close();
    try {
      fs.rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  // Inserts a feedback row directly so we can choose its timestamp.
  // recordFeedback() always stamps `now`; the decay path needs older
  // rows to validate.
  function insertSignal({ ledger, symbolId, signal, ts, taskType }) {
    const [content_hash, lidStr] = symbolId.split(":");
    const local_id = Number(lidStr);
    const db = ledger._unsafeDb();
    db.prepare(
      `INSERT INTO feedback_signals
         (ts, slice_handle, content_hash, local_id, signal, task_type, task_text)
       VALUES(?, ?, ?, ?, ?, ?, ?)`,
    ).run(ts, null, content_hash, local_id, signal, taskType ?? null, null);
  }

  it("halfLifeDays: old signals contribute less weight than recent ones", () => {
    const t = makeTmp("decay-old-vs-new");
    const fresh = buildFixture(t);
    try {
      const now = Date.now();
      const oneDay = 86_400_000;
      // loginAdmin: one signal 60 days ago. With a 14-day half-life,
      // weight = exp(-60/14) ≈ 0.0136.
      insertSignal({
        ledger: fresh.ledger,
        symbolId: fresh.ids.loginAdmin,
        signal: "useful",
        ts: new Date(now - 60 * oneDay).toISOString(),
      });
      // loginUser: one signal ~now. Weight ≈ 1.0.
      insertSignal({
        ledger: fresh.ledger,
        symbolId: fresh.ids.loginUser,
        signal: "useful",
        ts: new Date(now - 60_000).toISOString(),
      });

      const equalWeight = fresh.ledger.recentFeedback({
        sinceTs: new Date(now - 365 * oneDay).toISOString(),
      });
      const equalById = new Map(equalWeight.map((r) => [`${r.content_hash}:${r.local_id}`, r]));
      // Equal-weight: both get useful_count=1, no weights present.
      assert.equal(equalById.get(fresh.ids.loginAdmin).useful_count, 1);
      assert.equal(equalById.get(fresh.ids.loginUser).useful_count, 1);
      assert.equal(equalById.get(fresh.ids.loginAdmin).useful_weight, undefined);

      const decayed = fresh.ledger.recentFeedback({
        sinceTs: new Date(now - 365 * oneDay).toISOString(),
        halfLifeDays: 14,
      });
      const decayedById = new Map(decayed.map((r) => [`${r.content_hash}:${r.local_id}`, r]));
      const oldWeight = decayedById.get(fresh.ids.loginAdmin).useful_weight;
      const newWeight = decayedById.get(fresh.ids.loginUser).useful_weight;
      assert.ok(oldWeight < 0.1, `60-day-old signal weight should be small, got ${oldWeight}`);
      assert.ok(newWeight > 0.99, `fresh signal weight should be near 1, got ${newWeight}`);
      assert.ok(
        newWeight > oldWeight * 10,
        `expected fresh signal weight >> old signal weight; got ${newWeight} vs ${oldWeight}`,
      );
    } finally {
      fresh.view.close();
      fresh.ledger.close();
      try {
        fs.rmSync(t, { recursive: true, force: true });
      } catch {}
    }
  });

  it("halfLifeDays: malformed timestamps do not poison decayed feedback buckets", () => {
    const t = makeTmp("decay-malformed-ts");
    const fresh = buildFixture(t);
    try {
      const now = Date.now();
      const validTs = new Date(now - 60_000).toISOString();
      insertSignal({
        ledger: fresh.ledger,
        symbolId: fresh.ids.loginAdmin,
        signal: "useful",
        ts: "not-a-date",
      });
      insertSignal({
        ledger: fresh.ledger,
        symbolId: fresh.ids.loginAdmin,
        signal: "useful",
        ts: validTs,
      });

      const decayed = fresh.ledger.recentFeedback({
        sinceTs: "0000-01-01T00:00:00.000Z",
        halfLifeDays: 14,
      });
      const row = decayed.find((r) => `${r.content_hash}:${r.local_id}` === fresh.ids.loginAdmin);
      assert.ok(row, "expected valid feedback row to remain");
      assert.equal(row.useful_count, 1);
      assert.equal(Number.isFinite(row.useful_weight), true);
      assert.equal(row.last_ts, validTs);
    } finally {
      fresh.view.close();
      fresh.ledger.close();
      try {
        fs.rmSync(t, { recursive: true, force: true });
      } catch {}
    }
  });

  it("decay alters feedback-boost ranking — recent signal beats old one", () => {
    const t = makeTmp("decay-boost");
    const fresh = buildFixture(t);
    try {
      const now = Date.now();
      const oneDay = 86_400_000;
      // loginAdmin: many old useful signals — would dominate without decay.
      for (let i = 0; i < 5; i++) {
        insertSignal({
          ledger: fresh.ledger,
          symbolId: fresh.ids.loginAdmin,
          signal: "useful",
          ts: new Date(now - 90 * oneDay).toISOString(),
        });
      }
      // loginUser: a single recent useful signal.
      insertSignal({
        ledger: fresh.ledger,
        symbolId: fresh.ids.loginUser,
        signal: "useful",
        ts: new Date(now - 30_000).toISOString(),
      });

      // Without decay: 5 vs 1 → loginAdmin wins on count.
      const equalWeight = hybridSearch({
        view: fresh.view,
        query: "login",
        ledger: fresh.ledger,
        options: {
          feedbackSinceTs: new Date(now - 365 * oneDay).toISOString(),
          limit: 4,
        },
      });
      const equalNames = /** @type {any} */ (equalWeight).items.map((i) => i.payload.name);
      assert.ok(
        equalNames.indexOf("loginAdmin") < equalNames.indexOf("loginUser"),
        `equal-weight should favor the high-count loginAdmin; got ${equalNames.join(",")}`,
      );

      // With decay: 5 old signals weight ≈ 5·exp(-90/14) ≈ 0.008, vs
      // 1 fresh signal ≈ 1.0. loginUser should win on freshness.
      const decayed = hybridSearch({
        view: fresh.view,
        query: "login",
        ledger: fresh.ledger,
        options: {
          feedbackSinceTs: new Date(now - 365 * oneDay).toISOString(),
          feedbackHalfLifeDays: 14,
          limit: 4,
        },
      });
      const decayedNames = /** @type {any} */ (decayed).items.map((i) => i.payload.name);
      assert.ok(
        decayedNames.indexOf("loginUser") < decayedNames.indexOf("loginAdmin"),
        `decayed should favor the recent loginUser; got ${decayedNames.join(",")}`,
      );
    } finally {
      fresh.view.close();
      fresh.ledger.close();
      try {
        fs.rmSync(t, { recursive: true, force: true });
      } catch {}
    }
  });
});
