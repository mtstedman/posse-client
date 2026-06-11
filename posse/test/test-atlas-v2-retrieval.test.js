// Workstream D retrieval port tests + ledger-backed delta integration.
//
// We populate a real view DB by direct SQL (bypassing the in-progress
// ViewBuilder so this suite has no dependency ordering on Workstream B).
// Dispatcher actions are covered at least once; retrieval behavior is pinned
// by the fixture corpus and native v2 contract tests.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { getRetrievalCache, RetrievalCache } from "../lib/domains/atlas/classes/v2/RetrievalCache.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { refreshGraphDerivedState } from "../lib/domains/atlas/functions/v2/graph-derived.js";
import { readTreeOverview, refreshTreeDerivedState, treeDerivedInputSignature } from "../lib/domains/atlas/functions/v2/tree-derived.js";
import {
  ensureTreeCompressionTables,
  exportTreeCompressionMlSnapshot,
  importTreeCompressionMlSnapshot,
  readLatestTreeCompressionSnapshot,
} from "../lib/domains/atlas/functions/v2/tree-compression.js";
import { readSemanticEnrichmentStatus } from "../lib/domains/atlas/functions/v2/semantic-enrichment.js";
import { recordLiveBufferEvent, liveReconciliationStatus } from "../lib/domains/atlas/functions/v2/live-reconciliation.js";
import { ATLAS_TOOL_ACTIONS } from "../lib/domains/atlas/functions/v2/contracts/tool-params.js";
import { VIEW_SCHEMA_VERSION } from "../lib/domains/atlas/functions/v2/contracts/ddl/index.js";
import { mainViewPath } from "../lib/domains/atlas/functions/v2/runtime-paths.js";
import { indexRefresh, repoStatus } from "../lib/domains/atlas/functions/v2/retrieval/repo.js";
import { isGeneratedPath } from "../lib/domains/atlas/functions/v2/retrieval/hygiene.js";
import {
  dispatch,
  workflowExecute,
  __resetSliceRegistryForTests,
  __resetBufferRegistryForTests,
  __resetRetrievalCacheForTests,
  __resetPrefetchStatsForTests,
  __resetLiveReconciliationForTests,
  __resetCodeLadderForTests,
  lexicalScore,
} from "../lib/domains/atlas/functions/v2/retrieval/index.js";
import { buildAstSkeleton } from "../lib/domains/atlas/functions/v2/retrieval/skeleton.js";
import { buildAstHotPath } from "../lib/domains/atlas/functions/v2/retrieval/hotpath.js";
import { encodeIndex, encodeToolInfo } from "./helpers/scip-encoder.mjs";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `atlas-v2-retrieval-${prefix}-`));
}

function gitAvailable() {
  const probe = spawnSync("git", ["--version"], { stdio: "ignore" });
  return probe.status === 0;
}

function runGit(cwd, args) {
  const result = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });
  if (result.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${result.stderr || result.stdout}`);
  }
  return String(result.stdout || "").trim();
}

/**
 * Seed a freshly-created view with a small fixture corpus. Returns
 * the view and a helper map of symbolId by symbol name.
 */
function buildFixtureView(dbPath, repoRoot) {
  const view = new View({ dbPath, mode: "readwrite" });
  const db = view._unsafeDb();

  // meta
  db.exec("DELETE FROM meta");
  const metaIns = db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)");
  const builtAt = "2026-05-18T00:00:00.000Z";
  for (const [k, v] of [
    ["schema_version", String(VIEW_SCHEMA_VERSION)],
    ["branch", "main"],
    ["parent_branch", ""],
    ["parent_seq", ""],
    ["ledger_seq", "5"],
    ["built_at", builtAt],
    ["warmed_for_files", "[]"],
    ["repo_root", repoRoot],
  ]) {
    metaIns.run(k, v);
  }

  const fileA = "src/greeter.ts";
  const fileB = "src/runner.ts";
  const sourceA = `export class Greeter extends Base implements Greeting {\n  public hello(): string { return "hi"; }\n}\n`;
  const sourceB = `import { Greeter } from "./greeter.js";\nexport function run() { return new Greeter().hello(); }\n`;
  fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
  fs.writeFileSync(path.join(repoRoot, fileA), sourceA);
  fs.writeFileSync(path.join(repoRoot, fileB), sourceB);
  const hashA = sha256Hex(sourceA);
  const hashB = sha256Hex(sourceB);

  db.exec("DELETE FROM path_to_blob");
  db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(fileA, hashA);
  db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(fileB, hashB);

  db.exec("DELETE FROM symbols");
  const symIns = db.prepare(
    `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                          repo_rel_path, range_start, range_end, signature_hash, signature_text, visibility, doc, lang)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const greeterInfo = symIns.run(
    hashA, 0, "class", "Greeter", null, null,
    fileA, sourceA.indexOf("export class"), sourceA.indexOf("{", sourceA.indexOf("class")) + 1,
    sha256Hex("class Greeter"), "export class Greeter extends Base implements Greeting", null, null, "ts",
  );
  const greeterGid = Number(greeterInfo.lastInsertRowid);
  symIns.run(
    hashA, 1, "method", "hello", "Greeter.hello", greeterGid,
    fileA, sourceA.indexOf("public hello"), sourceA.indexOf("}", sourceA.indexOf("hello")) + 1,
    sha256Hex("method hello"), "public hello(): string", "public", null, "ts",
  );
  const runInfo = symIns.run(
    hashB, 0, "function", "run", null, null,
    fileB, sourceB.indexOf("export function"), sourceB.indexOf("}") + 1,
    sha256Hex("function run"), "export function run()", null, null, "ts",
  );

  db.exec("DELETE FROM edges");
  const edgeIns = db.prepare(
    `INSERT INTO edges (from_global_id, to_global_id, to_name, kind, repo_rel_path,
                        range_start, range_end, confidence)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  edgeIns.run(greeterGid, null, "Base", "extends", fileA, 0, 10, 90);
  edgeIns.run(greeterGid, null, "Greeting", "implements", fileA, 0, 10, 90);
  edgeIns.run(Number(runInfo.lastInsertRowid), greeterGid, "Greeter", "calls", fileB, 0, 10, 95);
  refreshGraphDerivedState(db);

  const symbolIdByName = {
    Greeter: `${hashA}:0`,
    hello: `${hashA}:1`,
    run: `${hashB}:0`,
  };
  return { view, repoRoot, symbolIdByName, fileA, fileB };
}

let env;

before(() => {
  const repoRoot = makeTmp("repo");
  const dbPath = path.join(repoRoot, ".posse", "atlas", "view.db");
  env = buildFixtureView(dbPath, repoRoot);
  env.ledger = Ledger.open({ dbPath: path.join(repoRoot, ".posse", "atlas", "ledger.db") });
});

after(() => {
  if (env?.view) env.view.close();
  if (env?.ledger) env.ledger.close();
  if (env?.repoRoot) fs.rmSync(env.repoRoot, { recursive: true, force: true });
  __resetSliceRegistryForTests();
  __resetBufferRegistryForTests();
  __resetRetrievalCacheForTests();
  __resetPrefetchStatsForTests();
  __resetLiveReconciliationForTests();
  __resetCodeLadderForTests();
});

/** Tracks which actions a test touched, so we can assert full coverage. */
/** @type {Set<string>} */
const touched = new Set();
function cover(action) {
  touched.add(action);
}

describe("retrieval dispatcher", () => {
  it("rejects unknown actions with a structured error", () => {
    const result = dispatch(
      /** @type {any} */ ({ action: "made.up" }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "unknown_action");
  });

  it("action.search finds native ATLAS v2 actions", () => {
    cover("action.search");
    const result = dispatch(
      /** @type {any} */ ({ action: "action.search", query: "memory store", limit: 5 }),
      { versionId: "main@5" },
    );
    assert.equal(result.ok, true);
    assert.ok(result.data.actions.some((entry) => entry.action === "memory.store"));
    assert.equal(result.data.offset, 0);
    assert.ok(result.data.total >= result.data.actions.length);
    const memoryStore = result.data.actions.find((entry) => entry.action === "memory.store");
    assert.ok(memoryStore.examples?.length > 0);
    assert.ok(memoryStore.recommendedNextActions.includes("memory.query"));
    assert.equal(memoryStore.recommendedNextActions.includes("memory.surface"), false);
  });

  it("lexical scoring ranks case-insensitive exact names above prefix expansions", () => {
    const exact = lexicalScore("greeter", /** @type {any} */ ({ name: "Greeter", qualified_name: "pkg.Greeter" }));
    const prefix = lexicalScore("greeter", /** @type {any} */ ({ name: "GreeterFactory", qualified_name: "pkg.GreeterFactory" }));
    assert.ok(exact > prefix, `expected exact ${exact} to outrank prefix ${prefix}`);
  });

  it("manual returns compact native ATLAS v2 reference entries", () => {
    cover("manual");
    const result = dispatch(
      /** @type {any} */ ({ action: "manual", actions: ["symbol.search", "code.needWindow"], limit: 10, includeExamples: true }),
      { versionId: "main@5" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.actions.length, 2);
    assert.match(result.data.manual, /symbol\.search/);
    assert.match(result.data.manual, /Examples:/);
    assert.ok(result.data.actions[0].recommendedNextActions.length > 0);
    assert.ok(result.data.tokenEstimate > 0);
  });

  it("workflow executes native ATLAS actions and data transforms with references", async () => {
    cover("workflow");
    const result = await dispatch(
      /** @type {any} */ ({
        action: "workflow",
        steps: [
          { id: "search", action: "symbol.search", args: { query: "Greeter", limit: 1 } },
          { id: "card", action: "symbol.getCard", args: { symbolId: "$search.items[0].symbolId" } },
          { id: "pick", fn: "dataPick", args: { input: "$card", fields: { name: "name", file: "location.repo_rel_path" } } },
          { id: "optional", fn: "dataTemplate", args: { input: { found: "$search.items[0].name", missing: "$search.items[99]?.name" }, template: "{{found}}:{{missing}}" } },
        ],
        onError: "stop",
        trace: { level: "verbose", includeResolvedArgs: true, maxPreviewTokens: 50 },
      }),
      { view: env.view, versionId: "main@5" },
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.results.length, 4);
    assert.equal(result.data.results[2].result.name, "Greeter");
    assert.equal(result.data.results[2].result.file, env.fileA);
    assert.equal(result.data.results[3].result, "Greeter:");
    assert.equal(result.data.trace.steps.length, 4);
  });

  it("workflow treats malformed envelopes as failed steps", async () => {
    const result = await workflowExecute({
      versionId: "main@5",
      params: /** @type {any} */ ({
        action: "workflow",
        steps: [{ id: "bad", action: "repo.status", args: {} }],
        onError: "continue",
      }),
      runAction: () => /** @type {any} */ ({}),
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.results[0].status, "error");
    assert.match(result.data.results[0].error, /ATLAS action failed: repo\.status/);
  });

  it("workflow can continue past denied runtime probes when onError is continue", async () => {
    const result = await workflowExecute({
      versionId: "main@5",
      params: /** @type {any} */ ({
        action: "workflow",
        steps: [
          { id: "probe", action: "runtime.execute", args: { runtime: "node", args: ["-v"] } },
          { id: "after", fn: "dataPick", args: { input: { continued: true }, fields: { continued: "continued" } } },
        ],
        onError: "continue",
      }),
      runAction: () => /** @type {any} */ ({
        ok: false,
        action: "runtime.execute",
        error: {
          code: "runtime_disabled",
          message: "runtime.execute is disabled",
          details: { status: "denied" },
        },
      }),
    });
    assert.equal(result.ok, true);
    assert.equal(result.data.results[0].status, "error");
    assert.match(result.data.results[0].error, /runtime\.execute is disabled/);
    assert.equal(result.data.results[1].status, "ok");
    assert.deepEqual(result.data.results[1].result, { continued: true });
  });

  it("gateway wrappers route to allowed native ATLAS v2 actions", () => {
    for (const action of ["query", "code", "repo", "agent"]) cover(action);
    const query = dispatch(
      /** @type {any} */ ({ action: "query", targetAction: "symbol.search", query: "Greeter", limit: 1 }),
      { view: env.view, versionId: "main@5" },
    );
    assert.equal(query.ok, true);
    assert.equal(query.action, "symbol.search");

    const normalizedQuery = dispatch(
      /** @type {any} */ ({ action: "atlas_query", target_action: "symbol_search", query: "Greeter", limit: 1 }),
      { view: env.view, versionId: "main@5" },
    );
    assert.equal(normalizedQuery.ok, true);
    assert.equal(normalizedQuery.action, "symbol.search");

    const normalizedCard = dispatch(
      /** @type {any} */ ({ action: "query", target_action: "symbol_getCard", symbol_id: env.symbolIdByName.Greeter, include_resolution_metadata: true }),
      { view: env.view, versionId: "main@5" },
    );
    assert.equal(normalizedCard.ok, true);
    assert.equal(normalizedCard.data.symbolId, env.symbolIdByName.Greeter);
    assert.equal(normalizedCard.data.resolution.method, "ast-name");

    const code = dispatch(
      /** @type {any} */ ({ action: "code", targetAction: "code.getSkeleton", file: env.fileA }),
      { view: env.view, versionId: "main@5", repoRoot: env.repoRoot },
    );
    assert.equal(code.ok, true);
    assert.equal(code.action, "code.getSkeleton");

    const repo = dispatch(
      /** @type {any} */ ({ action: "repo", targetAction: "info", includeCounts: true }),
      { view: env.view, versionId: "main@5", repoRoot: env.repoRoot, ledger: env.ledger, repoId: "gateway-repo" },
    );
    assert.equal(repo.ok, true);
    assert.equal(repo.action, "info");

    const agent = dispatch(
      /** @type {any} */ ({ action: "agent", targetAction: "memory.query", query: "anything", limit: 1 }),
      { versionId: "main@5", ledger: env.ledger, repoId: "gateway-repo" },
    );
    assert.equal(agent.ok, true);
    assert.equal(agent.action, "memory.query");

    assert.equal(refreshTreeDerivedState(env.view._unsafeDb()).ok, true);
    const tree = dispatch(
      /** @type {any} */ ({ action: "query", target_action: "tree_overview", path: "src", max_depth: 1, include_aggregates: false }),
      { view: env.view, versionId: "main@5" },
    );
    assert.equal(tree.ok, true);
    assert.equal(tree.action, "tree.overview");
    assert.equal(tree.data.root.kind, "dir");
    assert.ok(tree.data.nodes.some((node) => node.nodeId === `file:${env.fileA}`));

    const denied = dispatch(
      /** @type {any} */ ({ action: "code", targetAction: "runtime.execute" }),
      { versionId: "main@5" },
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error?.code, "gateway_action_not_allowed");
  });

  it("info reports native v2 diagnostics", () => {
    cover("info");
    const result = dispatch(
      /** @type {any} */ ({ action: "info", includePolicy: true, includeCounts: true }),
      {
        view: env.view,
        versionId: "main@5",
        repoRoot: env.repoRoot,
        viewPath: path.join(env.repoRoot, ".posse", "atlas", "view.db"),
        ledger: env.ledger,
        repoId: "diagnostic-repo",
      },
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.version, "atlas-v2");
    assert.equal(result.data.repo.repoId, "diagnostic-repo");
    assert.equal(result.data.storage.ledgerExists, true);
    assert.equal(result.data.view.available, true);
    assert.equal(result.data.policy.memoryEnabled, true);
    assert.ok(result.data.ledger.counts.symbolDeltas >= 0);
    assert.ok(result.data.ledger.counts.feedbackSignals >= 0);
  });

  it("repo.status returns version + indexed counts", () => {
    cover("repo.status");
    const r = dispatch(
      /** @type {any} */ ({ action: "repo.status", detail: "standard" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot, viewPath: path.join(env.repoRoot, ".posse", "atlas", "view.db") },
    );
    assert.equal(r.ok, true);
    assert.ok(r.data.indexedSymbols >= 3);
    assert.ok(r.data.indexedFiles >= 2);
    assert.ok(r.data.languages.includes("ts"));
    assert.equal(r.data.repoRoot, env.repoRoot);
    assert.equal(r.data.branch, "main");
    assert.ok(r.data.health.healthScore > 0);
    assert.equal(r.data.index.byKind.class, 1);
    assert.equal(r.data.features.workflow, true);
    assert.equal(r.data.capabilities.schemaVersion, 1);
    assert.equal(r.data.capabilities.engine, "atlas-v2");
    assert.equal(r.data.capabilities.items.workflow.status, "enabled");
    assert.equal(r.data.capabilities.items.conditionalFetch.status, "enabled");
    assert.equal(r.data.capabilities.items.indexDiagnostics.status, "enabled");
    assert.equal(r.data.capabilities.items.predictivePrefetch.status, "enabled");
    assert.equal(r.data.capabilities.items.graphDerivedState.status, "enabled");
    assert.equal(r.data.capabilities.items.semanticEnrichment.status, "enabled");
    assert.equal(r.data.capabilities.items.codeModeLadder.status, "enabled");
    assert.equal(r.data.capabilities.flags.graphDerivedState, false);
    assert.equal(r.data.health.schemaVersion, 2);
    assert.ok(r.data.health.components.indexedCoverage > 0);
    assert.ok(r.data.health.components.callResolution > 0);
    assert.equal(r.data.watcherHealth.enabled, false);
    assert.equal(r.data.liveIndexStatus.enabled, true);
    assert.equal(r.data.liveIndexStatus.mode, "buffer-reconciliation");
    assert.equal(r.data.liveIndexStatus.reconciliation.mode, "buffer-reconciliation");
    assert.equal(r.data.capabilities.items.liveReconciliation.status, "partial");
    assert.equal(typeof r.data.cacheStats.cards.entries, "number");
    assert.equal(r.data.prefetchStats.strategy, "predictive-card-cache");
    assert.equal(r.data.prefetchStats.predictiveEnabled, true);
    assert.equal(r.data.semanticStatus.dispatchEnabled, false);
    assert.equal(r.data.semanticStatus.enrichment.status, "available");
    assert.equal(r.data.semanticStatus.enrichment.edgeSources.treesitter, 3);
    assert.ok(r.data.semanticStatus.enrichment.symbolResolution.signatures >= 3);
    assert.ok(r.data.semanticStatus.enrichment.providers.some((provider) => provider.id === "scip"));
    assert.equal(r.data.semanticStatus.localOnnx.status, "not_configured");
    assert.equal("availableModels" in r.data.semanticStatus.localOnnx, false);
    assert.equal(r.data.indexProgress.status, "idle");
    assert.equal(r.data.graphDerivedState.available, true);
    assert.ok(r.data.graphDerivedState.clusterCount >= 1);
    assert.ok(r.data.graphDerivedState.centralityRows >= 3);
  });

  it("index.refresh returns diagnostics when setup fails", async () => {
    const repoRoot = makeTmp("refresh-fail");
    try {
      const failingLedger = {
        ensureRootBranch() {},
        getBranch() {
          throw { code: "BRANCH_BUSY" };
        },
      };
      const r = await indexRefresh({
        versionId: "v1",
        params: /** @type {any} */ ({ includeDiagnostics: true }),
        repoRoot,
        ledger: /** @type {any} */ (failingLedger),
      });
      assert.equal(r.ok, false);
      assert.equal(r.error.code, "index_refresh_failed");
      assert.equal(r.error.message, "BRANCH_BUSY");
      assert.equal(r.error.details.operation.status, "failed");
      assert.equal(r.error.details.operation.lastError, "BRANCH_BUSY");
      assert.equal(r.error.details.diagnostics.operationId, r.error.details.operation.operationId);
      assert.equal(typeof r.error.details.diagnostics.totalDurationMs, "number");
      assert.equal(r.meta.operation.status, "failed");
      assert.equal(r.meta.diagnostics.operationId, r.error.details.diagnostics.operationId);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("repo.status keeps the minimal detail path lightweight", () => {
    const minimal = dispatch(
      /** @type {any} */ ({ action: "repo.status", detail: "minimal" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(minimal.ok, true);
    assert.equal("dataQuality" in minimal.data, false);

    const standard = dispatch(
      /** @type {any} */ ({ action: "repo.status", detail: "standard" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(standard.ok, true);
    assert.equal(typeof standard.data.dataQuality.symbols.total, "number");
  });

  it("repo.status counts layered symbol sources from merged local ids", () => {
    const repoRoot = makeTmp("layer-source-counts");
    const ledger = Ledger.open({ dbPath: path.join(repoRoot, ".posse", "atlas", "ledger.db") });
    let view = null;
    try {
      const repoRelPath = "src/layered.ts";
      const source = "export function shared() {}\nexport function compilerOnly() {}\n";
      const contentHash = sha256Hex(source);
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, repoRelPath), source);
      const makeLayerSymbol = (localId, name, extra = {}) => ({
        content_hash: contentHash,
        local_id: localId,
        kind: "function",
        name,
        qualified_name: name,
        parent_local_id: null,
        repo_rel_path: repoRelPath,
        lang: "ts",
        range_start: localId * 32,
        range_end: localId * 32 + 20,
        range_start_line: localId + 1,
        range_end_line: localId + 1,
        signature_hash: sha256Hex(`${name}()`),
        signature_text: `function ${name}()`,
        visibility: "public",
        doc: null,
        ...extra,
      });
      ledger.ingestBlobLayer({
        content_hash: contentHash,
        lang: "ts",
        byte_size: Buffer.byteLength(source),
        source: "treesitter",
        tool_version: "treesitter-test",
        parser_spec_version: "treesitter",
        config_hash: "cfg",
        deps_hash: "deps",
        fileset_hash: "tree",
        symbols: [makeLayerSymbol(0, "shared", { source: "treesitter" })],
        edges: [],
      });
      ledger.ingestBlobLayer({
        content_hash: contentHash,
        lang: "ts",
        byte_size: Buffer.byteLength(source),
        source: "scip",
        tool_version: "scip-test",
        parser_spec_version: "scip",
        config_hash: "cfg",
        deps_hash: "deps",
        fileset_hash: "scip",
        symbols: [
          makeLayerSymbol(0, "shared", { source: "scip", doc: "compiler docs" }),
          makeLayerSymbol(1, "compilerOnly", { source: "scip" }),
        ],
        edges: [],
      });
      ledger.append({
        branch: "main",
        op: "add",
        repo_rel_path: repoRelPath,
        before_content_hash: null,
        after_content_hash: contentHash,
      });
      const viewPath = path.join(repoRoot, ".posse", "atlas", "view.db");
      new ViewBuilder().buildFrom({
        ledger,
        branch: "main",
        atSeq: ledger.headSeq("main"),
        outPath: viewPath,
        options: { layerMerge: true, repoRoot },
      });
      view = View.mount({ dbPath: viewPath, mode: "readonly" });
      const status = repoStatus({
        view,
        ledger,
        versionId: "main@1",
        repoRoot,
        viewPath,
        params: /** @type {any} */ ({ action: "repo.status", detail: "standard" }),
      });
      assert.equal(status.ok, true);
      assert.deepEqual(status.data.dataQuality.symbols.bySource, { treesitter: 1, scip: 1 });
    } finally {
      try { view?.close(); } catch { /* ignore */ }
      try { ledger.close(); } catch { /* ignore */ }
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("graph-derived process paths stay bounded on shared-descendant DAGs", () => {
    const repoRoot = makeTmp("graph-dag");
    const dbPath = path.join(repoRoot, ".posse", "atlas", "view.db");
    const view = new View({ dbPath, mode: "readwrite" });
    try {
      const db = view._unsafeDb();
      const symIns = db.prepare(
        `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                              repo_rel_path, range_start, range_end, signature_hash, signature_text, visibility, doc, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const ids = [];
      for (let i = 0; i < 18; i += 1) {
        const name = i === 0 ? "run" : `step${i}`;
        const source = `export function ${name}() { return ${i}; }\n`;
        const hash = sha256Hex(source);
        const info = symIns.run(
          hash, 0, "function", name, null, null,
          `src/${name}.ts`, 0, source.length,
          sha256Hex(`function ${name}`), `export function ${name}()`, null, null, "ts",
        );
        ids.push(Number(info.lastInsertRowid));
      }
      const edgeIns = db.prepare(
        `INSERT INTO edges (from_global_id, to_global_id, to_name, kind, repo_rel_path,
                            range_start, range_end, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (let i = 0; i < ids.length - 1; i += 1) {
        for (let j = i + 1; j < Math.min(ids.length, i + 4); j += 1) {
          edgeIns.run(ids[i], ids[j], `step${j}`, "calls", `src/step${i}.ts`, 0, 1, 100);
        }
      }
      const result = refreshGraphDerivedState(db);
      assert.equal(result.ok, true);
      const row = db.prepare("SELECT MAX(symbol_count) AS symbolCount, MAX(depth) AS depth FROM process_summaries").get();
      assert.ok(Number(row.symbolCount) <= 8);
      assert.ok(Number(row.depth) <= 7);
    } finally {
      view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("graph-derived failures preserve the previous derived tables", () => {
    const repoRoot = makeTmp("graph-fail");
    const dbPath = path.join(repoRoot, ".posse", "atlas", "view.db");
    const view = new View({ dbPath, mode: "readwrite" });
    try {
      const db = view._unsafeDb();
      const sym = db.prepare(
        `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                              repo_rel_path, range_start, range_end, signature_hash, signature_text, visibility, doc, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sha256Hex("graph-fail"), 0, "function", "run", null, null,
        "src/run.ts", 0, 10, sha256Hex("run"), "function run()", null, null, "ts",
      );
      db.prepare(
        `INSERT INTO edges (from_global_id, to_global_id, to_name, kind, repo_rel_path,
                            range_start, range_end, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(Number(sym.lastInsertRowid), Number(sym.lastInsertRowid), "run", "calls", "src/run.ts", 0, 1, 100);
      const first = refreshGraphDerivedState(db);
      assert.equal(first.ok, true);
      const before = db.prepare("SELECT COUNT(*) AS cnt FROM symbol_centrality").get().cnt;
      db.exec(`
        CREATE TRIGGER fail_symbol_centrality_insert
        BEFORE INSERT ON symbol_centrality
        BEGIN
          SELECT RAISE(FAIL, 'forced graph failure');
        END;
      `);
      const failed = refreshGraphDerivedState(db);
      assert.equal(failed.ok, false);
      const after = db.prepare("SELECT COUNT(*) AS cnt FROM symbol_centrality").get().cnt;
      assert.equal(after, before);
      const latest = db.prepare("SELECT status FROM derived_state_runs ORDER BY id DESC LIMIT 1").get();
      assert.equal(latest.status, "error");
    } finally {
      view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("tree-derived builds stable path and symbol containment with raw aggregates", () => {
    const repoRoot = makeTmp("tree-derived");
    const dbPath = path.join(repoRoot, ".posse", "atlas", "view.db");
    const view = new View({ dbPath, mode: "readwrite" });
    try {
      const db = view._unsafeDb();
      const fileA = "src/domain/greeter.ts";
      const fileB = "src/run.ts";
      const fileC = "src/copy/greeter.ts";
      const sourceA = "export class Greeter { hello() { return 'hi'; } }\n";
      const sourceB = "import { Greeter } from './domain/greeter.js'; export function run() { return new Greeter().hello(); }\n";
      const hashA = sha256Hex(sourceA);
      const hashB = sha256Hex(sourceB);
      db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(fileA, hashA);
      db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(fileB, hashB);
      db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(fileC, hashA);
      const symIns = db.prepare(
        `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                              repo_rel_path, range_start, range_end, signature_hash, signature_text, visibility, doc, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const greeter = symIns.run(
        hashA, 0, "class", "Greeter", null, null,
        fileA, 0, 22, sha256Hex("class Greeter"), "export class Greeter", "export", null, "ts",
      );
      const greeterGid = Number(greeter.lastInsertRowid);
      const hello = symIns.run(
        hashA, 1, "method", "hello", "Greeter.hello", greeterGid,
        fileA, 23, 45, sha256Hex("method hello"), "hello()", null, null, "ts",
      );
      const run = symIns.run(
        hashB, 0, "function", "run", null, null,
        fileB, 48, 95, sha256Hex("function run"), "export function run()", "export", null, "ts",
      );
      const greeterCopy = symIns.run(
        hashA, 0, "class", "Greeter", null, null,
        fileC, 0, 22, sha256Hex("class Greeter"), "export class Greeter", "export", null, "ts",
      );
      const greeterCopyGid = Number(greeterCopy.lastInsertRowid);
      symIns.run(
        hashA, 1, "method", "hello", "Greeter.hello", greeterCopyGid,
        fileC, 23, 45, sha256Hex("method hello"), "hello()", null, null, "ts",
      );
      db.prepare(
        `INSERT INTO edges (from_global_id, to_global_id, to_name, kind, repo_rel_path,
                            range_start, range_end, confidence)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(Number(run.lastInsertRowid), Number(hello.lastInsertRowid), "hello", "calls", fileB, 70, 90, 100);

      assert.equal(refreshGraphDerivedState(db).ok, true);
      const beforeSignature = treeDerivedInputSignature(db);
      const result = refreshTreeDerivedState(db);
      const afterSignature = treeDerivedInputSignature(db);
      assert.equal(result.ok, true);
      assert.equal(beforeSignature, afterSignature);

      const greeterNodeId = `symbol:${fileA}:${hashA}:0`;
      const helloNodeId = `symbol:${fileA}:${hashA}:1`;
      const runNodeId = `symbol:${fileB}:${hashB}:0`;
      const greeterCopyNodeId = `symbol:${fileC}:${hashA}:0`;
      const helloCopyNodeId = `symbol:${fileC}:${hashA}:1`;
      const greeterNode = db.prepare(
        "SELECT node_id AS nodeId, parent_node_id AS parentNodeId, kind, symbol_global_id AS symbolGlobalId FROM atlas_tree_nodes WHERE node_id = ?",
      ).get(greeterNodeId);
      assert.equal(greeterNode.parentNodeId, `file:${fileA}`);
      assert.equal(greeterNode.kind, "class");
      assert.equal(Number(greeterNode.symbolGlobalId), greeterGid);
      const helloNode = db.prepare("SELECT parent_node_id AS parentNodeId FROM atlas_tree_nodes WHERE node_id = ?").get(helloNodeId);
      assert.equal(helloNode.parentNodeId, greeterNodeId);
      assert.ok(db.prepare("SELECT 1 FROM atlas_tree_nodes WHERE node_id = ?").get("dir:src/domain"));
      assert.ok(db.prepare("SELECT 1 FROM atlas_tree_nodes WHERE node_id = ?").get("dir:src/copy"));
      assert.ok(db.prepare("SELECT 1 FROM atlas_tree_nodes WHERE node_id = ?").get(runNodeId));
      const helloCopyNode = db.prepare("SELECT parent_node_id AS parentNodeId FROM atlas_tree_nodes WHERE node_id = ?").get(helloCopyNodeId);
      assert.equal(helloCopyNode.parentNodeId, greeterCopyNodeId);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_nodes WHERE symbol_ref = ?").get(`${hashA}:0`).cnt,
        2,
      );

      const root = db.prepare(
        "SELECT descendant_symbol_count AS symbolCount, descendant_file_count AS fileCount, aggregates_json AS aggregatesJson FROM atlas_tree_nodes WHERE node_id = 'root'",
      ).get();
      assert.equal(Number(root.symbolCount), 5);
      assert.equal(Number(root.fileCount), 3);
      const aggregates = JSON.parse(root.aggregatesJson);
      assert.equal(aggregates.descendantSymbolCount, 5);
      assert.equal(aggregates.descendantFileCount, 3);
      assert.equal(aggregates.callFanOutTotal >= 1, true);
      assert.equal(
        Number(db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_scope_nodes WHERE kind = 'file'").get().cnt),
        3,
      );
      assert.equal(
        Number(db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_scope_symbol_files").get().cnt),
        5,
      );
      assert.ok(
        Number(db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_scope_term_stats WHERE term = 'greeter'").get().cnt) > 0,
      );

      assert.ok(db.prepare("SELECT 1 FROM atlas_tree_refs WHERE node_id = ? AND ref_type = 'cluster'").get(runNodeId));
      assert.ok(db.prepare("SELECT 1 FROM atlas_tree_refs WHERE node_id = ? AND ref_type = 'process'").get(runNodeId));
      const overview = readTreeOverview(db, 5);
      assert.equal(overview.available, true);
      assert.equal(overview.latestRun?.status, "ok");
      cover("tree.overview");
      const tree = dispatch(
        /** @type {any} */ ({ action: "tree.overview", symbolId: `${hashA}:0`, maxDepth: 0, includeRefs: true }),
        { view, versionId: "tree@1" },
      );
      assert.equal(tree.ok, true);
      assert.equal(tree.data.available, true);
      assert.equal(tree.data.matches.length, 2);
      assert.equal(tree.data.nodes.length, 2);
      assert.equal(tree.data.total, 2);
      assert.ok(tree.data.warnings.includes("symbolId maps to multiple tree locations; pass path to disambiguate."));

      const copyTree = dispatch(
        /** @type {any} */ ({ action: "tree.overview", path: fileC, maxDepth: 2, includeTerms: true }),
        { view, versionId: "tree@1" },
      );
      assert.equal(copyTree.ok, true);
      assert.equal(copyTree.data.root.nodeId, `file:${fileC}`);
      assert.ok(copyTree.data.nodes.some((node) => node.nodeId === helloCopyNodeId));

      const invalidPathTree = dispatch(
        /** @type {any} */ ({ action: "tree.overview", path: path.join(repoRoot, fileC), maxDepth: 0 }),
        { view, versionId: "tree@1" },
      );
      assert.equal(invalidPathTree.ok, true);
      assert.equal(invalidPathTree.data.root, null);
      assert.equal(invalidPathTree.data.total, 0);
      assert.deepEqual(invalidPathTree.data.nodes, []);
      assert.ok(invalidPathTree.data.warnings.includes("path must be a canonical repo-relative path."));

      cover("tree.scope");
      const scoped = dispatch(
        /** @type {any} */ ({ action: "tree.scope", taskText: "run Greeter hello", maxFiles: 10, branchFileCap: 4 }),
        { view, versionId: "tree@1" },
      );
      assert.equal(scoped.ok, true);
      assert.equal(scoped.data.available, true);
      assert.equal(scoped.data.sidecar.used, true);
      assert.ok(scoped.data.candidateFiles.some((file) => file.path === fileA));
      assert.ok(scoped.data.candidateFiles.some((file) => file.path === fileB));
      assert.ok(scoped.data.metrics.candidateFileCount <= 10);
      assert.ok(["small_cluster", "multi_area"].includes(scoped.data.metrics.scopeBand));
      assert.ok(["low", "medium"].includes(scoped.data.metrics.scopeRisk));
      assert.equal(scoped.data.metrics.queryTermCount > 0, true);
      assert.ok(scoped.data.metrics.queryTermCoverage > 0);
      assert.ok(scoped.data.metrics.confidence >= 0.6);

      const seededScope = dispatch(
        /** @type {any} */ ({ action: "tree.scope", paths: [fileC], maxFiles: 5, branchFileCap: 5 }),
        { view, versionId: "tree@1" },
      );
      assert.equal(seededScope.ok, true);
      assert.equal(seededScope.data.candidateFiles[0].path, fileC);
      assert.equal(seededScope.data.candidateFiles[0].exactSeed, true);
      assert.equal(seededScope.data.metrics.exactSeedCount, 1);
      assert.equal(seededScope.data.sidecar.used, true);

      const broadSeedScope = dispatch(
        /** @type {any} */ ({ action: "tree.scope", paths: ["src"], maxFiles: 5, branchFileCap: 1 }),
        { view, versionId: "tree@1" },
      );
      assert.equal(broadSeedScope.ok, true);
      assert.deepEqual(broadSeedScope.data.candidateFiles, []);
      assert.equal(broadSeedScope.data.rejectedBroadDirs.length, 1);
      assert.equal(broadSeedScope.data.metrics.broadDirCount, 1);
      assert.ok(broadSeedScope.data.refinementCandidates.some((candidate) => candidate.path === "src/domain"));
      assert.ok(broadSeedScope.data.refinementCandidates.some((candidate) => candidate.path === "src/copy"));
      assert.ok(broadSeedScope.data.refinementCandidates.every((candidate) => candidate.acceptsBranchFileCap === true));

      // Without compression tables the scope pass reports the compressed tree
      // as unavailable rather than failing.
      assert.equal(scoped.data.compression.available, false);
      assert.deepEqual(scoped.data.compression.matchedSeeds, []);

      // Compressed-tree seeds bridge task vocabulary ("salutation pipeline")
      // that never appears in paths or symbol terms to the annotated area, and
      // entrypoints pin its files into the candidate set.
      ensureTreeCompressionTables(db);
      const snapshotRow = db.prepare(
        `INSERT INTO atlas_tree_compression_snapshots (built_at, profile, source_signature, status)
         VALUES (?, ?, ?, ?)`,
      ).run("2026-06-11T00:00:00Z", "quick_dirty_tree_ml_features_v0", "sig", "ok");
      db.prepare(
        `INSERT INTO atlas_tree_compression_seeds
           (snapshot_id, node_id, repo_rel_path, label, confidence, aliases_json,
            entrypoints_json, likely_tests_json, avoid_if_query_only_mentions_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        Number(snapshotRow.lastInsertRowid),
        "dir:src/domain",
        "src/domain",
        "salutation pipeline",
        0.9,
        JSON.stringify(["greeting flow"]),
        JSON.stringify([fileA]),
        "[]",
        JSON.stringify(["generic UI polish"]),
      );
      const compressedScope = dispatch(
        /** @type {any} */ ({ action: "tree.scope", taskText: "trace the salutation pipeline output", maxFiles: 10, branchFileCap: 4 }),
        { view, versionId: "tree@2" },
      );
      assert.equal(compressedScope.ok, true);
      assert.equal(compressedScope.data.compression.available, true);
      assert.equal(compressedScope.data.compression.matchedSeeds.length, 1);
      assert.equal(compressedScope.data.compression.matchedSeeds[0].path, "src/domain");
      assert.equal(compressedScope.data.compression.matchedSeeds[0].label, "salutation pipeline");
      assert.deepEqual(compressedScope.data.compression.areaMap, [
        { path: "src/domain", label: "salutation pipeline", confidence: "high" },
      ]);
      assert.ok(compressedScope.data.candidateFiles.some((file) => file.path === fileA));
      assert.ok(compressedScope.data.candidateFiles.some((file) => (file.reasons || []).some((reason) => String(reason).startsWith("compression:"))));

      // Walking the branch shows the compressed-tree label on the dir node.
      cover("tree.walk");
      const labeledWalk = dispatch(
        /** @type {any} */ ({ action: "tree.walk", path: "src/domain", maxDepth: 1 }),
        { view, versionId: "tree@2" },
      );
      assert.equal(labeledWalk.ok, true);
      const domainNode = labeledWalk.data.nodes.find((node) => node.repoRelPath === "src/domain");
      assert.equal(domainNode?.areaLabel, "salutation pipeline");

      // tree.walk is focused-only; the top-level view belongs to tree.overview.
      const walkWithoutFocus = dispatch(
        /** @type {any} */ ({ action: "tree.walk", maxDepth: 1 }),
        { view, versionId: "tree@2" },
      );
      assert.equal(walkWithoutFocus.ok, false);
      assert.equal(walkWithoutFocus.error?.code, "invalid_params");

      // tree.grow expands validated seeds (no taskText) and requires seeds.
      cover("tree.grow");
      const grown = dispatch(
        /** @type {any} */ ({ action: "tree.grow", paths: [fileC], maxFiles: 5, branchFileCap: 5 }),
        { view, versionId: "tree@2" },
      );
      assert.equal(grown.ok, true);
      assert.equal(grown.action, "tree.grow");
      assert.equal(grown.data.candidateFiles[0].path, fileC);
      assert.equal(grown.data.candidateFiles[0].exactSeed, true);
      const grownWithoutSeeds = dispatch(
        /** @type {any} */ ({ action: "tree.grow", maxFiles: 5 }),
        { view, versionId: "tree@2" },
      );
      assert.equal(grownWithoutSeeds.ok, false);
      assert.equal(grownWithoutSeeds.error?.code, "invalid_params");

      // The top-level overview carries the compressed-tree area map; a legacy
      // focused overview still works but points the caller at tree.walk.
      const topOverview = dispatch(
        /** @type {any} */ ({ action: "tree.overview", maxDepth: 1 }),
        { view, versionId: "tree@2" },
      );
      assert.equal(topOverview.ok, true);
      assert.deepEqual(topOverview.data.areaMap, [
        { path: "src/domain", label: "salutation pipeline", confidence: "high" },
      ]);
      const focusedOverview = dispatch(
        /** @type {any} */ ({ action: "tree.overview", path: "src/domain", maxDepth: 1 }),
        { view, versionId: "tree@2" },
      );
      assert.equal(focusedOverview.ok, true);
      assert.equal(focusedOverview.data.areaMap, undefined);
      assert.ok(focusedOverview.data.warnings.some((warning) => /tree\.walk/.test(warning)));

      // The seed's own avoid-guard: a task made up entirely of avoid terms
      // must not match the area.
      const avoidedScope = dispatch(
        /** @type {any} */ ({ action: "tree.scope", taskText: "generic UI polish", maxFiles: 10, branchFileCap: 4 }),
        { view, versionId: "tree@3" },
      );
      assert.equal(avoidedScope.ok, true);
      assert.deepEqual(avoidedScope.data.compression.matchedSeeds, []);

      // ML snapshot survives a view-file recreation via export/import: this is
      // what keeps the model pass delta-only across full rebuilds.
      const mlSnap = db.prepare(
        `INSERT INTO atlas_tree_compression_snapshots (built_at, profile, source_signature, status)
         VALUES (?, ?, ?, ?)`,
      ).run("2026-06-11T01:00:00Z", "one_time_tree_ml_seed_v0", "ml-sig", "ok");
      db.prepare(
        `INSERT INTO atlas_tree_compression_seeds
           (snapshot_id, node_id, repo_rel_path, label, confidence, aliases_json, deterministic_signature)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ).run(Number(mlSnap.lastInsertRowid), "dir:src/domain", "src/domain", "ML salutation pipeline", 0.95, JSON.stringify(["greeting"]), "det-sig-1");
      const exported = exportTreeCompressionMlSnapshot(db);
      assert.ok(exported?.snapshot);
      assert.equal(exported.sourceSignature, "ml-sig");
      assert.equal(exported.snapshot.seeds[0].deterministicSignature, "det-sig-1");
      db.prepare("DELETE FROM atlas_tree_compression_seeds").run();
      db.prepare("DELETE FROM atlas_tree_compression_snapshots").run();
      const imported = importTreeCompressionMlSnapshot(db, exported);
      assert.equal(imported.ok, true);
      assert.equal(imported.seeds, 1);
      const reread = readLatestTreeCompressionSnapshot(db, { profile: "one_time_tree_ml_seed_v0" });
      assert.equal(reread.available, true);
      assert.equal(reread.snapshot.sourceSignature, "ml-sig");
      assert.equal(reread.seeds[0].label, "ML salutation pipeline");
      assert.equal(reread.seeds[0].deterministicSignature, "det-sig-1");

      const snapshotSql = `SELECT node_id AS nodeId, parent_node_id AS parentNodeId, depth, sort_order AS sortOrder
                           FROM atlas_tree_nodes
                           ORDER BY node_id`;
      const firstSnapshot = db.prepare(snapshotSql).all();
      const second = refreshTreeDerivedState(db);
      assert.equal(second.ok, true);
      assert.deepEqual(db.prepare(snapshotSql).all(), firstSnapshot);
    } finally {
      view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("tree-derived failures preserve the previous tree tables", () => {
    const repoRoot = makeTmp("tree-fail");
    const dbPath = path.join(repoRoot, ".posse", "atlas", "view.db");
    const view = new View({ dbPath, mode: "readwrite" });
    try {
      const db = view._unsafeDb();
      const source = "export function run() { return 1; }\n";
      const hash = sha256Hex(source);
      db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run("src/run.ts", hash);
      db.prepare(
        `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                              repo_rel_path, range_start, range_end, signature_hash, signature_text, visibility, doc, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hash, 0, "function", "run", null, null,
        "src/run.ts", 0, source.length, sha256Hex("run"), "export function run()", null, null, "ts",
      );
      const first = refreshTreeDerivedState(db);
      assert.equal(first.ok, true);
      const before = db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_nodes").get().cnt;
      db.exec(`
        CREATE TRIGGER fail_atlas_tree_nodes_insert
        BEFORE INSERT ON atlas_tree_nodes
        BEGIN
          SELECT RAISE(FAIL, 'forced tree failure');
        END;
      `);
      const failed = refreshTreeDerivedState(db);
      assert.equal(failed.ok, false);
      const after = db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_nodes").get().cnt;
      assert.equal(after, before);
      assert.equal(
        db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_scope_nodes").get().cnt > 0,
        true,
      );
      const latest = db.prepare("SELECT status FROM derived_state_runs WHERE kind = 'tree-derived' ORDER BY id DESC LIMIT 1").get();
      assert.equal(latest.status, "error");
    } finally {
      view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("tree-derived sidecar marks generated code paths consistently", () => {
    const repoRoot = makeTmp("tree-generated");
    const dbPath = path.join(repoRoot, ".posse", "atlas", "view.db");
    const view = new View({ dbPath, mode: "readwrite" });
    try {
      const db = view._unsafeDb();
      db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(
        "apps/web/src/routeTree.gen.ts",
        sha256Hex("export const routeTree = {};\n"),
      );
      db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(
        "src/generated/checkout-api.generated.ts",
        sha256Hex("export class CheckoutApiClient {}\n"),
      );
      db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(
        "www/livevane.com/htdocs/embed/hls-player.js",
        sha256Hex("export function hlsPlayer() { return true; }\n"),
      );

      assert.equal(refreshTreeDerivedState(db).ok, true);
      const generated = db.prepare(
        "SELECT generated FROM atlas_tree_scope_nodes WHERE kind = 'file' AND repo_rel_path = ?",
      ).get("apps/web/src/routeTree.gen.ts");
      const generatedSuffix = db.prepare(
        "SELECT generated FROM atlas_tree_scope_nodes WHERE kind = 'file' AND repo_rel_path = ?",
      ).get("src/generated/checkout-api.generated.ts");
      const ordinary = db.prepare(
        "SELECT generated FROM atlas_tree_scope_nodes WHERE kind = 'file' AND repo_rel_path = ?",
      ).get("www/livevane.com/htdocs/embed/hls-player.js");
      assert.equal(Number(generated.generated), 1);
      assert.equal(Number(generatedSuffix.generated), 1);
      assert.equal(Number(ordinary.generated), 0);
    } finally {
      view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("tree.scope falls back to hot projection when scope sidecar tables are missing", () => {
    const repoRoot = makeTmp("tree-scope-fallback");
    const dbPath = path.join(repoRoot, ".posse", "atlas", "view.db");
    const view = new View({ dbPath, mode: "readwrite" });
    try {
      const db = view._unsafeDb();
      const file = "src/run.ts";
      const source = "export function run() { return 1; }\n";
      const hash = sha256Hex(source);
      db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(file, hash);
      db.prepare(
        `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                              repo_rel_path, range_start, range_end, signature_hash, signature_text, visibility, doc, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        hash, 0, "function", "run", null, null,
        file, 0, source.length, sha256Hex("run"), "export function run()", null, null, "ts",
      );
      assert.equal(refreshTreeDerivedState(db).ok, true);
      db.prepare("DROP TABLE atlas_tree_scope_symbol_files").run();
      db.prepare("DROP TABLE atlas_tree_scope_term_stats").run();
      db.prepare("DROP TABLE atlas_tree_scope_terms").run();
      db.prepare("DROP TABLE atlas_tree_scope_nodes").run();

      const scoped = dispatch(
        /** @type {any} */ ({ action: "tree.scope", taskText: "run", maxFiles: 5 }),
        { view, versionId: "tree@fallback" },
      );
      assert.equal(scoped.ok, true);
      assert.equal(scoped.data.available, true);
      assert.equal(scoped.data.sidecar.used, false);
      assert.ok(scoped.data.warnings.some((warning) => warning.includes("sidecar unavailable")));
      assert.ok(scoped.data.candidateFiles.some((candidate) => candidate.path === file));
    } finally {
      view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("tree.overview reports broad ref focus truncation", () => {
    const repoRoot = makeTmp("tree-ref-truncation");
    const dbPath = path.join(repoRoot, ".posse", "atlas", "view.db");
    const view = new View({ dbPath, mode: "readwrite" });
    try {
      const db = view._unsafeDb();
      const file = "src/broad.ts";
      const source = Array.from({ length: 55 }, (_, idx) => `export const value${idx} = ${idx};`).join("\n");
      const hash = sha256Hex(source);
      db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(file, hash);
      const symIns = db.prepare(
        `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                              repo_rel_path, range_start, range_end, signature_hash, signature_text, visibility, doc, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      const globalIds = [];
      for (let i = 0; i < 55; i += 1) {
        const name = `value${i}`;
        const inserted = symIns.run(
          hash, i, "const", name, name, null,
          file, i * 10, i * 10 + 5, sha256Hex(name), `export const ${name}`, null, null, "ts",
        );
        globalIds.push(Number(inserted.lastInsertRowid));
      }
      assert.equal(refreshGraphDerivedState(db).ok, true);
      db.prepare("DELETE FROM symbol_clusters").run();
      const clusterIns = db.prepare("INSERT INTO symbol_clusters(symbol_global_id, cluster_id, membership_score) VALUES (?, ?, ?)");
      for (const globalId of globalIds) clusterIns.run(globalId, "cluster:wide", 1);
      assert.equal(refreshTreeDerivedState(db).ok, true);

      const tree = dispatch(
        /** @type {any} */ ({ action: "tree.overview", refType: "cluster", refId: "cluster:wide", maxDepth: 0, limit: 500 }),
        { view, versionId: "tree@wide" },
      );
      assert.equal(tree.ok, true);
      assert.equal(tree.data.matchTotal, 55);
      assert.equal(tree.data.matches.length, 50);
      assert.equal(tree.data.nodes.length, 50);
      assert.equal(tree.data.focusTruncated, true);
      assert.equal(tree.data.truncated, true);
      assert.ok(tree.data.warnings.some((warning) => warning.includes("matched 55 tree locations")));

      const scoped = dispatch(
        /** @type {any} */ ({ action: "tree.scope", refType: "cluster", refId: "cluster:wide", maxFiles: 50, refMatchLimit: 50 }),
        { view, versionId: "tree@wide" },
      );
      assert.equal(scoped.ok, true);
      assert.equal(scoped.data.candidateFiles.length, 0);
      assert.equal(scoped.data.rejectedBroadRefs.length, 1);
      assert.equal(scoped.data.rejectedBroadRefs[0].matchCount, 55);
      assert.equal(scoped.data.metrics.scopeRisk, "high");
      assert.equal(scoped.data.metrics.broadRefCount, 1);
    } finally {
      view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("semantic enrichment counts SCIP external edges once", () => {
    const repoRoot = makeTmp("semantic-scip");
    const dbPath = path.join(repoRoot, ".posse", "atlas", "view.db");
    const view = new View({ dbPath, mode: "readwrite" });
    try {
      const db = view._unsafeDb();
      const sym = db.prepare(
        `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                              repo_rel_path, range_start, range_end, signature_hash, signature_text, visibility, doc, lang)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        sha256Hex("semantic-scip"), 0, "function", "run", null, null,
        "src/run.ts", 0, 10, sha256Hex("run"), "function run()", null, null, "ts",
      );
      db.prepare(
        `INSERT INTO edges (from_global_id, to_global_id, to_name, to_external_id, source, kind,
                            repo_rel_path, range_start, range_end, confidence)
         VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(Number(sym.lastInsertRowid), "readFile", 42, "scip", "calls", "src/run.ts", 0, 1, 100);
      const status = readSemanticEnrichmentStatus({ view, edges: { resolved: 0, unresolved: 1, callResolutionRate: 0 } });
      const scip = status.providers.find((provider) => provider.id === "scip");
      assert.equal(status.externalEdges, 1);
      assert.equal(status.edgeSources.scip, 1);
      assert.equal(scip?.edgeCount, 1);
    } finally {
      view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("repo.status reports local ONNX embedding configuration readiness", () => {
    const r = dispatch(
      /** @type {any} */ ({ action: "repo.status", detail: "minimal" }),
      {
        view: env.view,
        versionId: "v1",
        repoRoot: env.repoRoot,
        config: { atlasLocalOnnxEmbeddings: true },
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.capabilities.items.localOnnxEmbeddings.status, "available");
    assert.equal(r.data.capabilities.items.localOnnxEmbeddings.enabled, true);
    assert.equal(r.data.semanticStatus.localOnnx.requested, true);
    assert.equal(r.data.semanticStatus.localOnnx.status, "unavailable");
    assert.equal(r.data.semanticStatus.localOnnx.encoderImplemented, true);
    assert.match(r.data.embeddings.reason, /local_onnx/);
  });

  it("repo.status keeps local ONNX scoped to the Jina provider", () => {
    const r = dispatch(
      /** @type {any} */ ({ action: "repo.status", detail: "minimal" }),
      {
        view: env.view,
        versionId: "v1",
        repoRoot: env.repoRoot,
        config: { embeddingProvider: "jina-v2-code" },
      },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.semanticStatus.localOnnx.requested, true);
    assert.equal(r.data.semanticStatus.localOnnx.model, "jina-v2-code");
    assert.equal("availableModels" in r.data.semanticStatus.localOnnx, false);
  });

  it("live reconciliation reports true frontier cardinality while capping file samples", () => {
    __resetLiveReconciliationForTests();
    const repoRoot = makeTmp("live-frontier");
    try {
      for (let i = 0; i < 120; i += 1) {
        recordLiveBufferEvent({ repoRoot, filePath: `src/file-${i}.ts` });
      }
      const status = liveReconciliationStatus({ repoRoot, dirtyBuffers: 30 });
      assert.equal(status.dependencyFrontier.fileCount, 120);
      assert.equal(status.dependencyFrontier.files.length, 50);
    } finally {
      __resetLiveReconciliationForTests();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("repo.register creates cold ATLAS storage", async () => {
    cover("repo.register");
    const repoRoot = makeTmp("register");
    try {
      const r = await dispatch(
        /** @type {any} */ ({ action: "repo.register", repoId: "cold-repo" }),
        { versionId: "main@0", repoRoot },
      );
      assert.equal(r.ok, true);
      assert.equal(r.data.repoId, "cold-repo");
      assert.equal(r.data.createdLedger, true);
      assert.equal(r.data.createdView, true);
      assert.equal(fs.existsSync(r.data.ledgerPath), true);
      assert.equal(fs.existsSync(r.data.viewPath), true);
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("repo.register rebuilds an invalid existing main view cache", async () => {
    const repoRoot = makeTmp("register-invalid-view");
    try {
      fs.mkdirSync(path.dirname(mainViewPath(repoRoot)), { recursive: true });
      fs.writeFileSync(mainViewPath(repoRoot), "not a sqlite view", "utf8");
      const r = await dispatch(
        /** @type {any} */ ({ action: "repo.register", repoId: "repair-repo" }),
        { versionId: "main@0", repoRoot },
      );
      assert.equal(r.ok, true);
      assert.equal(r.data.createdView, true);
      const view = View.mount({ dbPath: mainViewPath(repoRoot), mode: "readonly" });
      try {
        assert.equal(view.meta().schema_version, VIEW_SCHEMA_VERSION);
      } finally {
        view.close();
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("index.refresh reindexes a cold repo through the Warmer", async () => {
    cover("index.refresh");
    const repoRoot = makeTmp("refresh");
    const filePath = "src/lifecycle.ts";
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, filePath), "export function lifecyclePing() { return 1; }\n", "utf8");
    try {
      const registered = await dispatch(
        /** @type {any} */ ({ action: "repo.register", buildEmptyView: false }),
        { versionId: "main@0", repoRoot },
      );
      assert.equal(registered.ok, true);

      const refreshed = await dispatch(
        /** @type {any} */ ({ action: "index.refresh", mode: "full", includeDiagnostics: true, operationId: "test-refresh-op" }),
        { versionId: "main@0", repoRoot },
      );
      assert.equal(refreshed.ok, true);
      assert.equal(refreshed.data.mode, "full");
      assert.equal(refreshed.data.operation.operationId, "test-refresh-op");
      assert.equal(refreshed.data.operation.status, "completed");
      assert.equal(refreshed.data.operation.detached, false);
      assert.equal(refreshed.data.operation.progress.percent, 100);
      assert.equal(refreshed.data.diagnostics.schemaVersion, 1);
      assert.ok(refreshed.data.diagnostics.totalDurationMs >= 0);
      assert.ok(refreshed.data.diagnostics.phases.initializing.durationMs >= 0);
      assert.equal(refreshed.data.warmResult.paths_considered, 1);
      assert.ok(
        refreshed.data.warmResult.paths_indexed >= 1
          || refreshed.data.warmResult.ledger_entries_appended >= 1,
      );
      assert.equal(fs.existsSync(mainViewPath(repoRoot)), true);

      const view = View.mount({ dbPath: mainViewPath(repoRoot), mode: "readonly" });
      try {
        const matches = view.query.findSymbol("lifecyclePing", { fuzzy: false, limit: 5 });
        assert.equal(matches.length, 1);
        assert.equal(matches[0].repo_rel_path, filePath);
        const db = view._unsafeDb();
        assert.ok(db.prepare("SELECT COUNT(*) AS cnt FROM symbol_centrality").get().cnt >= 1);
        assert.ok(db.prepare("SELECT COUNT(*) AS cnt FROM atlas_tree_nodes").get().cnt >= 1);
        assert.equal(
          db.prepare("SELECT value FROM meta WHERE key = 'tree_derived_input_signature'").get()?.value.length > 0,
          true,
        );
        assert.equal(db.prepare("SELECT COUNT(*) AS cnt FROM cluster_summaries").get().cnt, 0);
      } finally {
        view.close();
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("index.refresh defaults to the checked-out git branch", { skip: !gitAvailable() }, async () => {
    const repoRoot = makeTmp("refresh-git-branch");
    const filePath = "src/on-master.ts";
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    fs.writeFileSync(path.join(repoRoot, filePath), "export function onMaster() { return 1; }\n", "utf8");
    try {
      runGit(repoRoot, ["init"]);
      runGit(repoRoot, ["symbolic-ref", "HEAD", "refs/heads/master"]);
      const refreshed = await dispatch(
        /** @type {any} */ ({ action: "index.refresh", mode: "full", includeDiagnostics: true }),
        { versionId: "cold@0", repoRoot },
      );
      assert.equal(refreshed.ok, true);
      assert.match(refreshed.versionId, /^master@\d+$/);

      const view = View.mount({ dbPath: mainViewPath(repoRoot), mode: "readonly" });
      try {
        assert.equal(view.meta().branch, "master");
        const matches = view.query.findSymbol("onMaster", { fuzzy: false, limit: 5 });
        assert.equal(matches.length, 1);
      } finally {
        view.close();
      }
    } finally {
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("repo.overview includes stats and hotspots when asked", () => {
    cover("repo.overview");
    const r = dispatch(
      /** @type {any} */ ({ action: "repo.overview", level: "full", includeHotspots: true }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.ok(r.data.stats);
    assert.equal(r.data.stats.byKind.class, 1);
    assert.equal(r.data.graph.edges.total, 3);
    assert.equal(r.data.graph.edges.byKind.extends, 1);
    assert.ok(r.data.graph.topByFanIn.some((hit) => hit.name === "Greeter" && hit.score === 1));
    assert.ok(r.data.graph.topByFanOut.some((hit) => hit.name === "Greeter" && hit.score === 2));
    assert.ok(r.data.graph.centrality.some((hit) => hit.name === "Greeter"));
    assert.ok(r.data.graph.clusters.length >= 1);
    assert.ok(r.data.graph.processes.some((process) => process.entryName === "run"));
    assert.equal(r.data.graph.derivedState.available, true);
    assert.ok(r.data.graph.entryPoints.includes(env.fileB));
    assert.ok(r.data.graph.tokenCompression.compressionRatio > 0);
    assert.equal(r.data.capabilities.runtime, "policy-gated");
    assert.ok(Array.isArray(r.data.hotspots));
    assert.ok(r.data.hotspots.some((hotspot) => hotspot.repo_rel_path === env.fileA && hotspot.reason === "high_fanout"));
    assert.ok(r.data.directories.some((dir) => dir.topByFanIn?.some((hit) => hit.name === "Greeter")));
  });

  it("repo.quality reports view, edge, parser, and embedding quality signals", () => {
    cover("repo.quality");
    const r = dispatch(
      /** @type {any} */ ({ action: "repo.quality", feedbackLimit: 10 }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot, viewPath: mainViewPath(env.repoRoot) },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.view.current, true);
    assert.equal(r.data.coverage.symbols, 3);
    assert.equal(r.data.coverage.files, 2);
    assert.equal(r.data.edges.total, 3);
    assert.equal(r.data.edges.resolved, 1);
    assert.equal(r.data.edges.unresolved, 2);
    assert.ok(r.data.treeSitter.knownLanguageCount > 0);
    assert.equal(r.data.embeddings.enabled, false);
    assert.ok(r.data.diagnostics.warnings.some((warning) => /unresolved edge rate/i.test(warning)));
    assert.ok(r.meta?.warnings?.some((warning) => /unresolved edge rate/i.test(warning)));
  });

  it("symbol.search returns ranked hits for a name query", () => {
    cover("symbol.search");
    const r = dispatch(
      /** @type {any} */ ({ action: "symbol.search", query: "Greeter", limit: 10 }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    const names = r.data.items.map((h) => h.name);
    assert.ok(names.includes("Greeter"));
    assert.equal(r.data.items[0]?.relevance, "exact");
    assert.ok((r.data.items[0]?.score ?? 0) > 0);
    assert.equal(r.meta.scoreScheme.score, "raw_rrf");
  });

  it("symbol.search surfaces semantic fallback warnings", async () => {
    const r = await dispatch(
      /** @type {any} */ ({ action: "symbol.search", query: "Greeter", semantic: true, limit: 10 }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.meta.semantic.requested, true);
    assert.equal(r.meta.semantic.available, false);
    assert.ok(r.meta.warnings.some((warning) => /fell back to lexical/i.test(warning)));
  });

  it("symbol.search can search symbol body identifier tokens", () => {
    const db = env.view._unsafeDb();
    const bodyHash = sha256Hex("ifNoneMatch slice body");
    const filePath = "src/slice-cache.ts";
    db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(filePath, bodyHash);
    db.prepare(
      `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                            repo_rel_path, range_start, range_end, signature_hash, signature_text,
                            body_identifiers, visibility, doc, lang)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      bodyHash, 0, "function", "sliceBuild", "sliceBuild", null,
      filePath, 0, 80, sha256Hex("sliceBuild"), "function sliceBuild()",
      "ifNoneMatch cardKey sliceKey cacheKey", null, null, "ts",
    );
    const r = dispatch(
      /** @type {any} */ ({ action: "symbol.search", query: "ifNoneMatch", scope: "body", limit: 5 }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.items[0]?.name, "sliceBuild");
  });

  it("symbol.search hides noisy locals and prefers exact file-path symbols over generated literals", () => {
    const db = env.view._unsafeDb();
    const targetPath = "apps/web/src/routes/admin/settings.tsx";
    const generatedPath = "apps/web/src/routeTree.gen.ts";
    const targetHash = sha256Hex("settings page");
    const generatedHash = sha256Hex("route tree");
    db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(targetPath, targetHash);
    db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run(generatedPath, generatedHash);
    const symIns = db.prepare(
      `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                            repo_rel_path, range_start, range_end, signature_hash, signature_text, visibility, doc, lang)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    symIns.run(
      targetHash, 0, "function", "AdminSettingsPage", "AdminSettingsPage", null,
      targetPath, 0, 10, sha256Hex("AdminSettingsPage"), "function AdminSettingsPage()", "public", null, "ts",
    );
    symIns.run(
      targetHash, 1, "var", "local 10", "local 10", null,
      targetPath, 11, 15, sha256Hex("local 10"), "local 10", null, null, "ts",
    );
    symIns.run(
      generatedHash, 0, "const", "'/admin/settings'", "'/admin/settings'", null,
      generatedPath, 0, 10, sha256Hex("route literal"), "const '/admin/settings'", null, null, "ts",
    );

    const pathSearch = dispatch(
      /** @type {any} */ ({ action: "symbol.search", query: targetPath, limit: 5 }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(pathSearch.ok, true);
    assert.equal(pathSearch.data.items[0]?.name, "AdminSettingsPage");
    assert.equal(pathSearch.data.items[0]?.location.repo_rel_path, targetPath);
    assert.equal(pathSearch.data.items.some((item) => item.name === "'/admin/settings'"), false);

    const literalSearch = dispatch(
      /** @type {any} */ ({ action: "symbol.search", query: "'/admin/settings'", limit: 5 }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(literalSearch.ok, true);
    assert.equal(literalSearch.data.items.some((item) => item.name === "'/admin/settings'"), true);

    const localSearch = dispatch(
      /** @type {any} */ ({ action: "symbol.search", query: "local 10", limit: 5 }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(localSearch.ok, true);
    assert.equal(localSearch.data.items.some((item) => item.name === "local 10"), false);
  });

  it("generated path hygiene keeps normal kebab-case files visible", () => {
    assert.equal(isGeneratedPath("src/auth-middleware.js"), false);
    assert.equal(isGeneratedPath("src/user-profile.js"), false);
    assert.equal(isGeneratedPath("src/email-validator.js"), false);
    assert.equal(isGeneratedPath("src/auth-oauth2.js"), false);
    assert.equal(isGeneratedPath("src/chart-d3utils.js"), false);
    assert.equal(isGeneratedPath("src/crypto-sha256util.js"), false);
    assert.equal(isGeneratedPath("src/api-v2handlers.js"), false);
    assert.equal(isGeneratedPath("src/chunk-a1b2c3.js"), true);
    assert.equal(isGeneratedPath("src/index-DWWWVbQG.js"), true);
    assert.equal(isGeneratedPath("assets/chunk.js"), true);
    assert.equal(isGeneratedPath("dist/index-DWWWVb2G.js"), true);
    assert.equal(isGeneratedPath("src/routeTree.gen.ts"), true);
  });

  it("symbol.search skips non-canonical path hints without degrading FTS", () => {
    const r = dispatch(
      /** @type {any} */ ({ action: "symbol.search", query: "fix ../config.js Greeter", limit: 10 }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.meta.backendHealth.backends.fts.ok, true);
    assert.ok(r.data.items.some((item) => item.name === "Greeter"));
  });

  it("symbol.search schedules likely follow-up cards and reports hits", async () => {
    __resetRetrievalCacheForTests();
    __resetPrefetchStatsForTests();
    try {
      const search = dispatch(
        /** @type {any} */ ({ action: "symbol.search", query: "Greeter", limit: 10 }),
        { view: env.view, versionId: "v1" },
      );
      assert.equal(search.ok, true);
      assert.equal(search.meta.prefetch.scheduled, true);
      assert.ok(search.meta.prefetch.targets >= 1);
      assert.ok(search.meta.prefetch.planned >= 1);
      assert.equal("attempted" in search.meta.prefetch, false);

      await Promise.resolve();

      const card = dispatch(
        /** @type {any} */ ({ action: "symbol.getCard", symbolId: env.symbolIdByName.Greeter, includeResolutionMetadata: true }),
        { view: env.view, versionId: "v1" },
      );
      assert.equal(card.ok, true);

      const status = dispatch(
        /** @type {any} */ ({ action: "repo.status", detail: "minimal" }),
        { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
      );
      assert.equal(status.ok, true);
      assert.ok(status.data.prefetchStats.completed >= 1);
      assert.ok(status.data.prefetchStats.cacheHits >= 1);
      assert.ok(status.data.prefetchStats.hitRate > 0);
      assert.ok(status.data.cacheStats.cards.hits >= 1);
    } finally {
      __resetRetrievalCacheForTests();
      __resetPrefetchStatsForTests();
    }
  });

  it("symbol.search can include ledger memory and feedback entities", async () => {
    const repoId = "entity-search-repo";
    const stored = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        type: "bugfix",
        title: "Auth middleware cookie retry",
        content: "Auth middleware failures should refresh session cookies before retrying the request.",
        tags: ["auth", "middleware"],
        symbolIds: [env.symbolIdByName.Greeter],
      }),
      { versionId: "v1", ledger: env.ledger, repoId },
    );
    assert.equal(stored.ok, true);
    const feedback = await dispatch(
      /** @type {any} */ ({
        action: "agent.feedback",
        sliceHandle: "sl_entity_search",
        usefulSymbols: [env.symbolIdByName.Greeter],
        taskType: "debug",
        taskText: "auth middleware cookie bug",
      }),
      { view: env.view, versionId: "v1", ledger: env.ledger },
    );
    assert.equal(feedback.ok, true);

    const result = await dispatch(
      /** @type {any} */ ({
        action: "symbol.search",
        query: "auth middleware cookie",
        entities: ["symbols", "memories", "feedback"],
        limit: 10,
      }),
      { view: env.view, versionId: "v1", ledger: env.ledger, repoId },
    );
    assert.equal(result.ok, true);
    assert.ok(result.data.entities?.some((item) => item.entity === "memory" && item.ref?.memoryId === stored.data.memoryId));
    assert.ok(result.data.entities?.some((item) => item.entity === "feedback" && item.ref?.symbolId === env.symbolIdByName.Greeter));
  });

  it("symbol.getCard hydrates callers/callees", () => {
    cover("symbol.getCard");
    const r = dispatch(
      /** @type {any} */ ({ action: "symbol.getCard", symbolId: env.symbolIdByName.Greeter }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.name, "Greeter");
    assert.equal(r.data.signature, "export class Greeter extends Base implements Greeting");
    assert.match(r.data.summary, /TypeScript class Greeter/);
    assert.ok(Array.isArray(r.data.callers));
    const callerNames = (r.data.callers || []).map((c) => c.name);
    assert.ok(callerNames.includes("run"));
    assert.equal(r.data.metrics.fanIn, 1);
    assert.equal(r.data.metrics.fanOut, 2);
    assert.equal(r.data.metrics.callFanIn, 1);
    assert.equal(r.data.metrics.unresolvedFanOut, 2);
    assert.deepEqual(r.data.deps.extends, ["Base"]);
    assert.deepEqual(r.data.deps.implements, ["Greeting"]);
  });

  it("symbol.usages returns compact edge sites for a symbol", () => {
    cover("symbol.usages");
    const r = dispatch(
      /** @type {any} */ ({ action: "symbol.usages", symbolId: env.symbolIdByName.Greeter, kind: ["calls"], limit: 10 }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.symbolId, env.symbolIdByName.Greeter);
    assert.equal(r.data.usages.length, 1);
    assert.equal(r.data.usages[0].fromName, "run");
    assert.equal(r.data.usages[0].fromSymbol?.name, "run");
    assert.equal(r.data.usages[0].fromSymbol?.location.repo_rel_path, env.fileB);
    assert.equal(r.data.usages[0].kind, "calls");
    assert.equal(r.data.usages[0].resolved, true);
  });

  it("symbol.getCard and slice.build use policy defaultMinCallConfidence when the call omits an override", () => {
    const repoId = "policy-confidence-retrieval";
    __resetRetrievalCacheForTests();
    __resetSliceRegistryForTests();
    try {
      const policy = dispatch(
        /** @type {any} */ ({
          action: "policy.set",
          repoId,
          policyPatch: { defaultMinCallConfidence: 0.99 },
        }),
        { versionId: "v1", ledger: env.ledger, repoId },
      );
      assert.equal(policy.ok, true);

      const cardDefault = dispatch(
        /** @type {any} */ ({ action: "symbol.getCard", symbolId: env.symbolIdByName.Greeter }),
        { view: env.view, versionId: "v1", ledger: env.ledger, repoId },
      );
      assert.equal(cardDefault.ok, true);
      assert.equal((cardDefault.data.callers || []).some((caller) => caller.name === "run"), false);

      const cardOverride = dispatch(
        /** @type {any} */ ({ action: "symbol.getCard", symbolId: env.symbolIdByName.Greeter, minCallConfidence: 0 }),
        { view: env.view, versionId: "v1", ledger: env.ledger, repoId },
      );
      assert.equal(cardOverride.ok, true);
      assert.equal((cardOverride.data.callers || []).some((caller) => caller.name === "run"), true);

      const sliceDefault = dispatch(
        /** @type {any} */ ({
          action: "slice.build",
          entrySymbols: [env.symbolIdByName.Greeter],
          budget: { maxCards: 5 },
        }),
        { view: env.view, versionId: "v1", ledger: env.ledger, repoId, repoRoot: env.repoRoot },
      );
      assert.equal(sliceDefault.ok, true);
      const defaultCard = sliceDefault.data.cards.find((card) => card.name === "Greeter");
      assert.ok(defaultCard);
      assert.equal((defaultCard.callers || []).some((caller) => caller.name === "run"), false);

      const sliceOverride = dispatch(
        /** @type {any} */ ({
          action: "slice.build",
          entrySymbols: [env.symbolIdByName.Greeter],
          minCallConfidence: 0,
          budget: { maxCards: 5 },
        }),
        { view: env.view, versionId: "v1", ledger: env.ledger, repoId, repoRoot: env.repoRoot },
      );
      assert.equal(sliceOverride.ok, true);
      const overrideCard = sliceOverride.data.cards.find((card) => card.name === "Greeter");
      assert.ok(overrideCard);
      assert.equal((overrideCard.callers || []).some((caller) => caller.name === "run"), true);
    } finally {
      __resetRetrievalCacheForTests();
      __resetSliceRegistryForTests();
    }
  });

  it("symbol.getCard reuses cached cards for identical requests", () => {
    __resetRetrievalCacheForTests();
    try {
      const first = dispatch(
        /** @type {any} */ ({ action: "symbol.getCard", symbolId: env.symbolIdByName.Greeter }),
        { view: env.view, versionId: "v1" },
      );
      assert.deepEqual(getRetrievalCache().stats(), { cards: 1, slices: 0 });
      const second = dispatch(
        /** @type {any} */ ({ action: "symbol.getCard", symbolId: env.symbolIdByName.Greeter }),
        { view: env.view, versionId: "v1" },
      );
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.deepEqual(second.data, first.data);
      assert.deepEqual(getRetrievalCache().stats(), { cards: 1, slices: 0 });
    } finally {
      __resetRetrievalCacheForTests();
    }
  });

  it("retrieval cache keys isolate identical version and symbol IDs by repoId", () => {
    const cache = new RetrievalCache();
    const baseCard = {
      versionId: "main@1",
      symbolId: `${"a".repeat(64)}:0`,
      detail: "compact",
      minCallConfidence: 0.5,
      includeResolutionMetadata: false,
    };
    assert.notEqual(
      cache.cardKey({ ...baseCard, repoId: "repo-a" }),
      cache.cardKey({ ...baseCard, repoId: "repo-b" }),
    );
    const params = { action: "slice.build", taskText: "Greeter" };
    assert.notEqual(
      cache.sliceKey({ versionId: "main@1", repoId: "repo-a", params }),
      cache.sliceKey({ versionId: "main@1", repoId: "repo-b", params }),
    );
  });

  it("retrieval cache peeks do not promote entries in LRU order", () => {
    const cache = new RetrievalCache({ cardCapacity: 2, cardTtlMs: 60_000 });
    cache.setCard("a", { id: "a" });
    cache.setCard("b", { id: "b" });
    assert.deepEqual(cache.peekCard("a"), { id: "a" });
    cache.setCard("c", { id: "c" });
    assert.equal(cache.getCard("a"), null);
    assert.deepEqual(cache.getCard("b"), { id: "b" });
    assert.deepEqual(cache.getCard("c"), { id: "c" });
  });

  it("symbol.getCards batch hydrates cards with partial errors", () => {
    cover("symbol.getCards");
    const r = dispatch(
      /** @type {any} */ ({
        action: "symbol.getCards",
        symbolIds: [env.symbolIdByName.Greeter, `${"0".repeat(64)}:99`],
        symbolRefs: [{ name: "run" }],
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.total, 3);
    assert.equal(r.data.okCount, 2);
    assert.equal(r.data.errorCount, 1);
    assert.equal(r.data.partial, true);
    assert.ok(r.data.cards.some((card) => card.name === "Greeter"));
    assert.ok(r.data.cards.some((card) => card.name === "run"));
  });

  it("symbol.getCard with symbolIds answers in the batch shape (one tool, single or batch)", () => {
    const r = dispatch(
      /** @type {any} */ ({
        action: "symbol.getCard",
        symbolIds: [env.symbolIdByName.Greeter, `${"0".repeat(64)}:99`],
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.action, "symbol.getCard");
    assert.equal(r.data.total, 2);
    assert.equal(r.data.okCount, 1);
    assert.equal(r.data.errorCount, 1);
    assert.ok(r.data.cards.some((card) => card.name === "Greeter"));
  });

  it("symbol.getCards dedupes symbolRefs independent of property order", () => {
    const r = dispatch(
      /** @type {any} */ ({
        action: "symbol.getCards",
        symbolRefs: [
          { name: "run", file: env.fileB },
          { file: env.fileB, name: "run" },
          { file: env.fileB, name: "run", kind: undefined },
        ],
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.total, 1);
    assert.equal(r.data.okCount, 1);
  });

  it("symbol.getCards reports non-plain symbolRefs instead of deduping them", () => {
    class RefWrapper {
      constructor() {
        this.name = "run";
        this.file = env.fileB;
      }
    }
    const r = dispatch(
      /** @type {any} */ ({
        action: "symbol.getCards",
        symbolRefs: [
          new RefWrapper(),
          { name: "run", file: env.fileB },
        ],
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.total, 2);
    assert.equal(r.data.okCount, 1);
    assert.equal(r.data.errorCount, 1);
    assert.equal(r.data.errors[0].code, "invalid_symbol_ref");
  });

  it("symbol.getCards rejects nested non-plain symbolRef values", () => {
    const r = dispatch(
      /** @type {any} */ ({
        action: "symbol.getCards",
        symbolRefs: [
          { name: "run", file: env.fileB, extra: new Date("2026-05-25T00:00:00.000Z") },
          { name: "run", file: env.fileB, extra: new Map([["k", "v"]]) },
          { name: "run", file: env.fileB },
        ],
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.total, 3);
    assert.equal(r.data.okCount, 1);
    assert.equal(r.data.errorCount, 2);
    assert.equal(r.data.errors.every((entry) => entry.code === "invalid_symbol_ref"), true);
  });

  it("symbol.getCard returns notModified when ifNoneMatch matches", () => {
    const firstCall = dispatch(
      /** @type {any} */ ({ action: "symbol.getCard", symbolId: env.symbolIdByName.Greeter }),
      { view: env.view, versionId: "v1" },
    );
    const etag = firstCall.meta?.etag;
    assert.ok(etag);
    const second = dispatch(
      /** @type {any} */ ({ action: "symbol.getCard", symbolId: env.symbolIdByName.Greeter, ifNoneMatch: etag }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(second.ok, true);
    assert.equal(second.meta?.notModified, true);
  });

  it("symbol.getCard reports unresolved when not found", () => {
    const r = dispatch(
      /** @type {any} */ ({ action: "symbol.getCard", symbolId: `${"0".repeat(64)}:99` }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, "unresolved_symbol");
  });

  it("symbol.getCard fuzzy fallback preserves kind and file filters", () => {
    const r = dispatch(
      /** @type {any} */ ({
        action: "symbol.getCard",
        symbolRef: { name: "Greeter", kind: "interface", file: env.fileB },
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, "unresolved_symbol");
  });

  it("slice.build returns cards with budget tracking", () => {
    cover("slice.build");
    const r = dispatch(
      /** @type {any} */ ({
        action: "slice.build",
        taskText: "Greeter",
        entrySymbols: [env.symbolIdByName.Greeter],
        cardDetail: "compact",
        budget: { maxCards: 5, maxEstimatedTokens: 10000 },
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.ok(r.data.cards.length > 0);
    assert.ok(r.data.sliceHandle.startsWith("sl_"));
    assert.equal(r.data.knownVersion, "v1");
  });

  it("slice.build uses lexical taskText-only entry discovery when semantic embeddings are unavailable", () => {
    const r = dispatch(
      /** @type {any} */ ({
        action: "slice.build",
        taskText: "Greeter",
        budget: { maxCards: 5 },
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.ok(r.data.cards.some((card) => card.name === "Greeter"));
  });

  it("slice.build and refresh keep card caller confidence independent from expansion confidence", () => {
    const repoRoot = makeTmp("slice-confidence");
    const viewPath = path.join(repoRoot, ".posse", "atlas", "view.db");
    const fixture = buildFixtureView(viewPath, repoRoot);
    try {
      fixture.view._unsafeDb()
        .prepare("UPDATE edges SET confidence = 40 WHERE kind = 'calls' AND to_name = 'Greeter'")
        .run();
      __resetRetrievalCacheForTests();
      __resetSliceRegistryForTests();

      const build = dispatch(
        /** @type {any} */ ({
          action: "slice.build",
          entrySymbols: [fixture.symbolIdByName.Greeter],
          cardDetail: "compact",
          minConfidence: 0.5,
          minCallConfidence: 0,
          budget: { maxCards: 5 },
        }),
        { view: fixture.view, versionId: "v1", repoRoot },
      );
      assert.equal(build.ok, true);
      const card = build.data.cards.find((item) => item.name === "Greeter");
      assert.ok(card, "expected Greeter card");
      assert.ok(card.callers?.some((caller) => caller.name === "run"), "expected low-confidence caller on card");

      fixture.view._unsafeDb()
        .prepare("UPDATE symbols SET signature_hash = ? WHERE name = 'Greeter'")
        .run(sha256Hex("class Greeter changed"));
      const refresh = dispatch(
        /** @type {any} */ ({
          action: "slice.refresh",
          sliceHandle: build.data.sliceHandle,
          knownVersion: "v1",
        }),
        { view: fixture.view, versionId: "v2", repoRoot },
      );
      assert.equal(refresh.ok, true);
      const changed = refresh.data.changedCards.find((item) => item.name === "Greeter");
      assert.ok(changed, "expected refreshed Greeter card");
      assert.ok(changed.callers?.some((caller) => caller.name === "run"), "expected refreshed card to keep low-confidence caller");
    } finally {
      fixture.view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
      __resetRetrievalCacheForTests();
      __resetSliceRegistryForTests();
    }
  });

  it("slice frontier why strings resolve source symbols by name", () => {
    const greeter = env.view.query.allSymbols({ limit: 10 }).find((symbol) => symbol.name === "Greeter");
    assert.ok(greeter, "expected Greeter fixture symbol");
    const result = env.view.query.sliceWithMetadata?.([greeter.global_id], { maxSymbols: 1, minConfidence: 0.5 });
    assert.ok(result, "expected sliceWithMetadata support");
    const frontier = result.frontier.find((item) => item.symbol.name === "run");
    assert.ok(frontier, `expected run in frontier; got ${JSON.stringify(result.frontier)}`);
    assert.match(frontier.why, /Greeter/);
    assert.doesNotMatch(frontier.why, new RegExp(`from ${greeter.global_id}\\b`));
  });

  it("slice.build reuses cached slices for identical requests", () => {
    __resetRetrievalCacheForTests();
    try {
      const params = /** @type {any} */ ({
        action: "slice.build",
        taskText: "Greeter",
        entrySymbols: [env.symbolIdByName.Greeter],
        budget: { maxCards: 3 },
      });
      const first = dispatch(params, { view: env.view, versionId: "v1" });
      assert.equal(getRetrievalCache().stats().slices, 1);
      const second = dispatch(params, { view: env.view, versionId: "v1" });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(second.data.sliceHandle, first.data.sliceHandle);
      assert.equal(getRetrievalCache().stats().slices, 1);
    } finally {
      __resetRetrievalCacheForTests();
    }
  });

  it("slice.build cache key includes the dispatch task type", () => {
    __resetRetrievalCacheForTests();
    try {
      const params = /** @type {any} */ ({
        action: "slice.build",
        taskText: "Greeter",
        entrySymbols: [env.symbolIdByName.Greeter],
        budget: { maxCards: 3 },
      });
      const first = dispatch(params, { view: env.view, versionId: "v1", taskType: "review" });
      const second = dispatch(params, { view: env.view, versionId: "v1", taskType: "implement" });
      assert.equal(first.ok, true);
      assert.equal(second.ok, true);
      assert.equal(getRetrievalCache().stats().slices, 2);
    } finally {
      __resetRetrievalCacheForTests();
    }
  });

  it("slice.build returns known cards as refs without changing slice identity", () => {
    const first = dispatch(
      /** @type {any} */ ({
        action: "slice.build",
        taskText: "Greeter run hello",
        entrySymbols: [env.symbolIdByName.Greeter],
        cardDetail: "compact",
        budget: { maxCards: 5, maxEstimatedTokens: 10000 },
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(first.ok, true);
    const known = first.data.cards[0];
    assert.ok(known?.symbolId);
    assert.ok(known?.etag);

    const second = dispatch(
      /** @type {any} */ ({
        action: "slice.build",
        taskText: "Greeter run hello",
        entrySymbols: [env.symbolIdByName.Greeter],
        cardDetail: "compact",
        knownCardEtags: { [known.symbolId]: known.etag },
        budget: { maxCards: 5, maxEstimatedTokens: 10000 },
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(second.ok, true);
    assert.equal(second.data.sliceHandle, first.data.sliceHandle);
    assert.equal(second.meta?.etag, first.meta?.etag);
    assert.equal(second.data.totalCardCount, first.data.totalCardCount);
    assert.ok(second.data.cardRefs?.some((ref) => ref.symbolId === known.symbolId && ref.etag === known.etag));
    assert.equal(second.data.cards.some((card) => card.symbolId === known.symbolId), false);
    assert.equal(second.data.budgetUsage.cardRefsReturned, 1);
  });

  it("slice.build supports packed wire format and slice conditional fetch", () => {
    const first = dispatch(
      /** @type {any} */ ({
        action: "slice.build",
        taskText: "Greeter run hello",
        entrySymbols: [env.symbolIdByName.Greeter],
        cardDetail: "compact",
        wireFormat: "packed",
        budget: { maxCards: 5, maxEstimatedTokens: 10000 },
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(first.ok, true);
    assert.equal(first.data.wireFormat.kind, "packed");
    assert.deepEqual(first.data.cards, []);
    assert.ok(first.data.packed.rows.length >= 1);
    assert.equal(first.data.packed.cardCount, first.data.budgetUsage.cardsReturned);
    assert.equal(first.data.budgetUsage.packedRows, first.data.packed.rows.length);
    assert.ok(first.meta?.etag);

    const second = dispatch(
      /** @type {any} */ ({
        action: "slice.build",
        taskText: "Greeter run hello",
        entrySymbols: [env.symbolIdByName.Greeter],
        cardDetail: "compact",
        wireFormat: "packed",
        ifNoneMatch: first.meta.etag,
        budget: { maxCards: 5, maxEstimatedTokens: 10000 },
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(second.ok, true);
    assert.equal(second.meta?.notModified, true);
    assert.equal(second.meta?.etag, first.meta.etag);
    assert.equal("data" in second, false);
  });

  it("slice.build persists a fresh notModified result for refresh", () => {
    __resetSliceRegistryForTests();
    __resetRetrievalCacheForTests();
    try {
      const first = dispatch(
        /** @type {any} */ ({
          action: "slice.build",
          taskText: "Greeter run hello",
          entrySymbols: [env.symbolIdByName.Greeter],
          cardDetail: "compact",
          budget: { maxCards: 5, maxEstimatedTokens: 10000 },
        }),
        { view: env.view, versionId: "v1" },
      );
      assert.equal(first.ok, true);
      __resetSliceRegistryForTests();
      __resetRetrievalCacheForTests();

      const second = dispatch(
        /** @type {any} */ ({
          action: "slice.build",
          taskText: "Greeter run hello",
          entrySymbols: [env.symbolIdByName.Greeter],
          cardDetail: "compact",
          ifNoneMatch: first.meta.etag,
          budget: { maxCards: 5, maxEstimatedTokens: 10000 },
        }),
        { view: env.view, versionId: "v1" },
      );
      assert.equal(second.ok, true);
      assert.equal(second.meta?.notModified, true);

      const refreshed = dispatch(
        /** @type {any} */ ({
          action: "slice.refresh",
          sliceHandle: first.data.sliceHandle,
          knownVersion: "v1",
        }),
        { view: env.view, versionId: "v1" },
      );
      assert.equal(refreshed.ok, true);
      assert.notEqual(refreshed.error?.code, "unknown_slice_handle");
    } finally {
      __resetSliceRegistryForTests();
      __resetRetrievalCacheForTests();
    }
  });

  it("edit.plan returns preview-only symbol-scoped edit candidates", () => {
    cover("edit.plan");
    const r = dispatch(
      /** @type {any} */ ({
        action: "edit.plan",
        taskText: "Rename Greeter greeting",
        targetSymbols: [env.symbolIdByName.Greeter],
        search: "Greeter",
        replace: "FriendlyGreeter",
        operation: "replace",
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.previewOnly, true);
    assert.equal(r.data.edits.length, 1);
    assert.equal(r.data.edits[0].symbolId, env.symbolIdByName.Greeter);
    assert.equal(r.data.edits[0].repo_rel_path, env.fileA);
    assert.equal(r.data.edits[0].precondition.versionId, "v1");
    assert.equal(r.data.nextActions.includes("code.getSkeleton"), true);
  });

  it("slice.refresh reports stillValid when version unchanged", () => {
    cover("slice.refresh");
    const build = dispatch(
      /** @type {any} */ ({ action: "slice.build", taskText: "Greeter", entrySymbols: [env.symbolIdByName.Greeter], budget: { maxCards: 5 } }),
      { view: env.view, versionId: "v1" },
    );
    const refresh = dispatch(
      /** @type {any} */ ({
        action: "slice.refresh",
        sliceHandle: build.data.sliceHandle,
        knownVersion: "v1",
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(refresh.ok, true);
    assert.equal(refresh.data.stillValid, true);
  });

  it("slice.refresh diffs small version drift without forcing a rebuild", () => {
    const repoRoot = makeTmp("refresh-drift");
    const viewPath = path.join(repoRoot, ".posse", "atlas", "view.db");
    const fixture = buildFixtureView(viewPath, repoRoot);
    try {
      const build = dispatch(
        /** @type {any} */ ({
          action: "slice.build",
          entrySymbols: [fixture.symbolIdByName.Greeter],
          budget: { maxCards: 5 },
        }),
        { view: fixture.view, versionId: "v1" },
      );
      assert.equal(build.ok, true);

      const nextHash = sha256Hex("export class Greeter { hello() { return 'changed'; } }\n");
      fixture.view._unsafeDb().prepare(`
        UPDATE symbols
        SET content_hash = ?, signature_hash = ?
        WHERE repo_rel_path = ? AND kind = 'class' AND name = 'Greeter'
      `).run(nextHash, sha256Hex("class Greeter changed"), fixture.fileA);

      const refresh = dispatch(
        /** @type {any} */ ({
          action: "slice.refresh",
          sliceHandle: build.data.sliceHandle,
          knownVersion: "v1",
        }),
        { view: fixture.view, versionId: "v2" },
      );
      assert.equal(refresh.ok, true);
      assert.equal(refresh.data.stillValid, true);
      assert.equal(refresh.data.knownVersion, "v2");
      assert.ok(
        refresh.data.changedCards.some((card) => card.name === "Greeter"),
        `expected Greeter in changedCards; got ${JSON.stringify(refresh.data)}`,
      );
      assert.equal(refresh.data.removedSymbolIds.length, 0);
    } finally {
      fixture.view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
      __resetSliceRegistryForTests();
    }
  });

  it("slice.refresh can reload a durable slice handle after process-memory reset", () => {
    const repoRoot = makeTmp("refresh-durable");
    const viewPath = path.join(repoRoot, ".posse", "atlas", "view.db");
    const fixture = buildFixtureView(viewPath, repoRoot);
    try {
      const build = dispatch(
        /** @type {any} */ ({
          action: "slice.build",
          entrySymbols: [fixture.symbolIdByName.Greeter],
          budget: { maxCards: 5 },
        }),
        { view: fixture.view, versionId: "v1", repoRoot },
      );
      assert.equal(build.ok, true);
      __resetSliceRegistryForTests();

      const refresh = dispatch(
        /** @type {any} */ ({
          action: "slice.refresh",
          sliceHandle: build.data.sliceHandle,
          knownVersion: "v1",
        }),
        { view: fixture.view, versionId: "v1", repoRoot },
      );
      assert.equal(refresh.ok, true);
      assert.equal(refresh.data.stillValid, true);
      assert.equal(refresh.meta?.etag, build.meta?.etag);
    } finally {
      fixture.view.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
      __resetSliceRegistryForTests();
    }
  });

  it("slice.spillover.get walks past the budget cap", () => {
    cover("slice.spillover.get");
    const build = dispatch(
      /** @type {any} */ ({
        action: "slice.build",
        taskText: "Greeter",
        entrySymbols: [env.symbolIdByName.Greeter],
        budget: { maxCards: 1, maxEstimatedTokens: 200 },
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.ok(build.data.spilloverHandle || build.data.truncated || build.data.cards.length <= 1);
    if (build.data.spilloverHandle) {
      const spill = dispatch(
        /** @type {any} */ ({
          action: "slice.spillover.get",
          spilloverHandle: build.data.spilloverHandle,
          pageSize: 25,
        }),
        { view: env.view, versionId: "v1" },
      );
      assert.equal(spill.ok, true);
      assert.ok(Array.isArray(spill.data.cards));

      const firstPage = dispatch(
        /** @type {any} */ ({
          action: "slice.spillover.get",
          spilloverHandle: build.data.spilloverHandle,
          pageSize: 1,
        }),
        { view: env.view, versionId: "v1" },
      );
      const malformedCursor = dispatch(
        /** @type {any} */ ({
          action: "slice.spillover.get",
          spilloverHandle: build.data.spilloverHandle,
          cursor: "not-a-number",
          pageSize: 1,
        }),
        { view: env.view, versionId: "v1" },
      );
      assert.equal(malformedCursor.ok, true);
      assert.deepEqual(malformedCursor.data, firstPage.data);
    }
  });

  it("code.getSkeleton lists the symbols in a file", () => {
    cover("code.getSkeleton");
    const r = dispatch(
      /** @type {any} */ ({ action: "code.getSkeleton", file: env.fileA }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(r.ok, true);
    assert.ok(r.data.content.includes("Greeter"));

    const filtered = dispatch(
      /** @type {any} */ ({
        action: "code.getSkeleton",
        file: env.fileB,
        identifiersToFind: ["run"],
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(filtered.ok, true);
    assert.match(filtered.data.content, /export function run\(\)/);
    assert.match(filtered.data.content, /\/\/ \.\.\./);
    assert.doesNotMatch(filtered.data.content, /Greeter/);

    const missing = dispatch(
      /** @type {any} */ ({ action: "code.getSkeleton", file: "src/missing.ts" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(missing.ok, false);
    assert.equal(missing.error?.code, "file_unreadable");
  });

  it("code.getSkeleton renders member-only selections inside their container", () => {
    const r = dispatch(
      /** @type {any} */ ({
        action: "code.getSkeleton",
        file: env.fileA,
        identifiersToFind: ["Greeter.hello"],
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(r.ok, true);
    assert.match(r.data.content, /export class Greeter[\s\S]*public hello\(\)/);
    assert.match(r.data.content.split(/\r?\n/)[0] || "", /export class Greeter/);

    const classOnly = dispatch(
      /** @type {any} */ ({
        action: "code.getSkeleton",
        file: env.fileA,
        identifiersToFind: ["Greeter"],
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(classOnly.ok, true);
    assert.match(classOnly.data.content, /public hello\(\)/);
  });

  it("code.getSkeleton preserves nested containers around selected members", () => {
    const source = `class Outer {\n  class Inner {\n    void method() {}\n  }\n}\n`;
    const r = buildAstSkeleton({
      file: "src/Outer.java",
      source,
      symbols: /** @type {any[]} */ ([{ name: "method", qualified_name: "Outer.Inner.method" }]),
      identifiersToFind: ["method"],
    });
    assert.equal(r.ok, true);
    assert.match(r.content, /class Outer/);
    assert.match(r.content, /class Inner/);
    assert.match(r.content, /void method\(\)/);
    assert.ok(r.content.indexOf("class Outer") < r.content.indexOf("class Inner"));
    assert.ok(r.content.indexOf("class Inner") < r.content.indexOf("void method()"));
  });

  it("code.getSkeleton renders Python class blocks as member containers", () => {
    const source = `class Outer:\n    class Inner:\n        def method(self):\n            return 1\n`;
    const r = buildAstSkeleton({
      file: "pkg/outer.py",
      source,
      symbols: /** @type {any[]} */ ([{ name: "method", qualified_name: "Outer.Inner.method" }]),
      identifiersToFind: ["method"],
    });
    assert.equal(r.ok, true);
    assert.match(r.content, /class Outer:/);
    assert.match(r.content, /class Inner:/);
    assert.match(r.content, /def method\(self\):/);
  });

  it("code.getHotPath finds identifiers in a file", () => {
    cover("code.getHotPath");
    const r = dispatch(
      /** @type {any} */ ({
        action: "code.getHotPath",
        symbolId: env.symbolIdByName.run,
        identifiersToFind: ["Greeter", "hello", "nope"],
        contextLines: 1,
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(r.ok, true);
    assert.ok(r.data.identifiersFound.includes("Greeter"));
    assert.ok(r.data.identifiersMissing.includes("nope"));
  });

  it("code.getHotPath accepts file fallbacks and scalar identifier lists", () => {
    const r = dispatch(
      /** @type {any} */ ({
        action: "code.getHotPath",
        file: env.fileB,
        identifiersToFind: "Greeter, hello; nope",
        contextLines: 1,
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.symbolId, undefined);
    assert.equal(r.data.repo_rel_path, env.fileB);
    assert.ok(r.data.identifiersFound.includes("Greeter"));
    assert.ok(r.data.identifiersFound.includes("hello"));
    assert.ok(r.data.identifiersMissing.includes("nope"));
  });

  it("code.getHotPath matches PHP tree-sitter name and variable_name nodes", () => {
    const source = `<?php\nfunction brief($title) {\n    render_page_start($title);\n    return true;\n}\n`;
    const r = buildAstHotPath({
      file: "htdocs/brief.php",
      source,
      identifiers: ["brief", "render_page_start", "title", "true"],
      contextLines: 1,
    });
    assert.equal(r.ok, true);
    assert.deepEqual(r.identifiersMissing, []);
    assert.ok(r.matches.some((match) => match.identifier === "title"));
  });

  it("code.needWindow rejects empty reason and serves a window with a reason", () => {
    cover("code.needWindow");
    const noReason = dispatch(
      /** @type {any} */ ({
        action: "code.needWindow",
        symbolId: env.symbolIdByName.Greeter,
        reason: "",
        expectedLines: 5,
        identifiersToFind: [],
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(noReason.ok, false);
    assert.equal(noReason.error?.code, "missing_reason");

    const ok = dispatch(
      /** @type {any} */ ({
        action: "code.needWindow",
        symbolId: env.symbolIdByName.Greeter,
        reason: "investigating call site",
        expectedLines: 5,
        identifiersToFind: ["Greeter"],
        sessionId: "ladder-warning",
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(ok.ok, true);
    assert.ok(ok.data.content.includes("Greeter"));
    assert.ok(ok.meta?.ladderPolicy?.warnings?.some((warning) => /code.getHotPath/.test(warning)));

    const symbolOnly = dispatch(
      /** @type {any} */ ({
        action: "code.needWindow",
        symbolId: env.symbolIdByName.Greeter,
        reason: "checking the symbol body",
        expectedLines: 5,
        identifiersToFind: [],
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot, ledger: env.ledger, repoId: "test-repo" },
    );
    assert.equal(symbolOnly.ok, true);
    assert.ok(symbolOnly.data.content.includes("Greeter"));
  });

  it("code ladder warnings clear after card, skeleton, and hot-path evidence", () => {
    __resetCodeLadderForTests();
    const sessionId = "ladder-ok";
    const card = dispatch(
      /** @type {any} */ ({ action: "symbol.getCard", symbolId: env.symbolIdByName.Greeter, sessionId }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(card.ok, true);
    const skeleton = dispatch(
      /** @type {any} */ ({ action: "code.getSkeleton", symbolId: env.symbolIdByName.Greeter, sessionId }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(skeleton.ok, true);
    assert.equal(skeleton.meta?.ladderPolicy, undefined);
    const hotPath = dispatch(
      /** @type {any} */ ({ action: "code.getHotPath", symbolId: env.symbolIdByName.Greeter, identifiersToFind: ["Greeter"], sessionId }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(hotPath.ok, true);
    assert.equal(hotPath.meta?.ladderPolicy, undefined);
    const window = dispatch(
      /** @type {any} */ ({
        action: "code.needWindow",
        symbolId: env.symbolIdByName.Greeter,
        reason: "need raw confirmation after hot path",
        expectedLines: 5,
        identifiersToFind: ["Greeter"],
        sessionId,
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(window.ok, true);
    assert.equal(window.meta?.ladderPolicy, undefined);
  });

  it("code ladder accepts card evidence when the follow-up uses the file target", () => {
    __resetCodeLadderForTests();
    const sessionId = "ladder-file-ok";
    const card = dispatch(
      /** @type {any} */ ({ action: "symbol.getCard", symbolId: env.symbolIdByName.Greeter, sessionId }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(card.ok, true);
    const skeleton = dispatch(
      /** @type {any} */ ({ action: "code.getSkeleton", file: env.fileA, sessionId }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(skeleton.ok, true);
    assert.equal(skeleton.meta?.ladderPolicy, undefined);
  });

  it("code ladder does not count a warned rung as completed", () => {
    __resetCodeLadderForTests();
    const sessionId = "ladder-warning-does-not-advance";
    const prematureSkeleton = dispatch(
      /** @type {any} */ ({ action: "code.getSkeleton", symbolId: env.symbolIdByName.Greeter, sessionId }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(prematureSkeleton.ok, true);
    assert.ok(prematureSkeleton.meta?.ladderPolicy?.warnings?.some((warning) => /symbol\.getCard/.test(warning)));

    const card = dispatch(
      /** @type {any} */ ({ action: "symbol.getCard", symbolId: env.symbolIdByName.Greeter, sessionId }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(card.ok, true);
    const hotPath = dispatch(
      /** @type {any} */ ({ action: "code.getHotPath", symbolId: env.symbolIdByName.Greeter, identifiersToFind: ["Greeter"], sessionId }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(hotPath.ok, true);
    assert.ok(hotPath.meta?.ladderPolicy?.warnings?.some((warning) => /code\.getSkeleton/.test(warning)));
  });

  it("code.needWindow accepts file fallbacks and JSON-encoded identifiers", () => {
    const ok = dispatch(
      /** @type {any} */ ({
        action: "code.needWindow",
        file: env.fileB,
        reason: "inspecting runner call site",
        expectedLines: "5",
        identifiersToFind: "[\"Greeter\",\"hello\"]",
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(ok.ok, true);
    assert.equal(ok.data.symbolId, undefined);
    assert.equal(ok.data.repo_rel_path, env.fileB);
    assert.ok(ok.data.content.includes("Greeter"));
    assert.ok(ok.data.content.includes("hello"));
  });

  it("context returns a rendered prompt fragment", () => {
    cover("context");
    const r = dispatch(
      /** @type {any} */ ({
        action: "context",
        taskText: "Implement Greeter greeting",
        taskType: "implement",
        focusSymbols: [env.symbolIdByName.Greeter],
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.ok(r.data.generatedContext.includes("Implement Greeter greeting"));
    assert.ok(r.data.estimatedTokens > 0);
    const greeterCard = r.data.cards.find((card) => card.name === "Greeter");
    assert.ok(greeterCard, "expected Greeter context card");
    assert.equal(Object.hasOwn(greeterCard, "qualifiedName"), true);
    assert.equal(Object.hasOwn(greeterCard, "signature"), true);
    assert.equal(Object.hasOwn(greeterCard, "summary"), true);
    assert.equal(greeterCard.qualifiedName, null);
  });

  it("context.summary returns compact evidence and next action guidance", () => {
    cover("context.summary");
    const r = dispatch(
      /** @type {any} */ ({
        action: "context.summary",
        taskText: "Implement Greeter greeting",
        taskType: "implement",
        focusSymbols: [env.symbolIdByName.Greeter],
        maxEvidence: 3,
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.match(r.data.summary, /Implement Greeter greeting/);
    assert.ok(r.data.finalEvidence.length > 0);
    assert.equal(Object.hasOwn(r.data, "retrievedSymbols"), false);
    assert.ok(r.data.contextQuality.evidenceItems >= r.data.finalEvidence.length);
    assert.equal(r.data.nextBestAction, "code.getSkeleton");
  });

  it("agent.feedback acknowledges the recording", async () => {
    cover("agent.feedback");
    const r = await dispatch(
      /** @type {any} */ ({
        action: "agent.feedback",
        sliceHandle: "sl_abc",
        usefulSymbols: ["x"],
        missingSymbols: ["y", "z"],
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.recorded, true);
    assert.equal(r.data.usefulCount, 1);
    assert.equal(r.data.missingCount, 2);
  });

  it("agent.feedback.query returns ledger-backed useful/missing aggregates", async () => {
    cover("agent.feedback.query");
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-feedback-"));
    const ledger = Ledger.open({ dbPath: path.join(tmpRoot, "ledger.db") });
    try {
      const recorded = await dispatch(
        /** @type {any} */ ({
          action: "agent.feedback",
          sliceHandle: "sl_feedback",
          usefulSymbols: [env.symbolIdByName.Greeter],
          missingSymbols: [env.symbolIdByName.run],
          taskType: "implement",
          taskText: "draft search quality",
        }),
        { view: env.view, versionId: "v1", ledger },
      );
      assert.equal(recorded.ok, true);
      assert.equal(recorded.data.recorded, true);
      const ftsCount = /** @type {{ c: number }} */ (
        ledger._unsafeDb().prepare("SELECT COUNT(*) AS c FROM feedback_fts").get()
      ).c;
      assert.equal(ftsCount, 2);

      const queried = dispatch(
        /** @type {any} */ ({
          action: "agent.feedback.query",
          taskType: "implement",
          halfLifeDays: 14,
          limit: 1,
        }),
        { versionId: "v1", ledger },
      );
      assert.equal(queried.ok, true);
      assert.equal(queried.data.feedback.length, 1);
      assert.equal(queried.data.hasMore, true);
      assert.equal(queried.data.aggregatedStats.totalFeedback, 2);
      assert.equal(queried.data.aggregatedStats.usefulFeedback, 1);
      assert.equal(queried.data.aggregatedStats.missingFeedback, 1);
      assert.ok(queried.data.aggregatedStats.topUsefulSymbols.some((row) => row.symbolId === env.symbolIdByName.Greeter));
      assert.ok(queried.data.aggregatedStats.topMissingSymbols.some((row) => row.symbolId === env.symbolIdByName.run));
    } finally {
      ledger.close();
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    }
  });

  it("delta.get returns added cards for the current view", () => {
    cover("delta.get");
    const r = dispatch(
      /** @type {any} */ ({
        action: "delta.get",
        fromVersion: "v0",
        toVersion: "v1",
        maxCards: 10,
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.ok(r.data.cards.length >= 1);
    for (const c of r.data.cards) assert.equal(c.change, "added");
  });

  it("pr.risk.analyze surfaces a blast radius and risk score", () => {
    cover("pr.risk.analyze");
    const r = dispatch(
      /** @type {any} */ ({
        action: "pr.risk.analyze",
        fromVersion: "v0",
        toVersion: "v1",
        riskThreshold: 0,
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.ok(Array.isArray(r.data.blastRadius));
    assert.ok(typeof r.data.riskScore === "number");
  });

  it("pr.risk.analyze does not inflate zero-impact blast radius hits", (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-risk-zero-impact-"));
    const view = new View({ dbPath: path.join(tmpRoot, "view.db"), mode: "readwrite" });
    t.after(() => {
      view.close();
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows may hold handles briefly. */ }
    });
    const db = view._unsafeDb();
    db.exec("DELETE FROM meta");
    for (const [key, value] of [
      ["schema_version", String(VIEW_SCHEMA_VERSION)],
      ["branch", "main"],
      ["ledger_seq", "1"],
      ["built_at", "2026-05-26T00:00:00.000Z"],
    ]) {
      db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run(key, value);
    }
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                            repo_rel_path, range_start, range_end, signature_hash, visibility, doc, lang)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEdge = db.prepare(
      `INSERT INTO edges (from_global_id, to_global_id, to_name, kind, repo_rel_path,
                          range_start, range_end, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const targetHash = sha256Hex("zero-impact-target");
    const targetSignature = sha256Hex("zeroImpactTarget()");
    const targetId = Number(insertSymbol.run(
      targetHash, 0, "function", "zeroImpactTarget", null, null,
      "src/target.ts", 0, 10, targetSignature, null, null, "ts",
    ).lastInsertRowid);
    for (let i = 0; i < 12; i++) {
      const callerId = Number(insertSymbol.run(
        sha256Hex(`zero-impact-caller-${i}`), 0, "function", `zeroImpactCaller${i}`, null, null,
        `src/caller-${i}.ts`, 0, 10, sha256Hex(`zeroImpactCaller${i}()`), null, null, "ts",
      ).lastInsertRowid);
      insertEdge.run(callerId, targetId, "zeroImpactTarget", "calls", "src/target.ts", 0, 10, 0);
    }
    const ledger = {
      pathSnapshotAt: (_branch, seq) => seq === 0
        ? new Map()
        : new Map([["src/target.ts", targetHash]]),
      getBlobSymbols: (hash) => hash === targetHash
        ? [{
          content_hash: targetHash,
          local_id: 0,
          kind: "function",
          name: "zeroImpactTarget",
          qualified_name: null,
          parent_local_id: null,
          range_start: 0,
          range_end: 10,
          signature_hash: targetSignature,
          signature_text: null,
          visibility: null,
          doc: null,
          lang: "ts",
        }]
        : [],
    };

    const r = dispatch(
      /** @type {any} */ ({
        action: "pr.risk.analyze",
        fromVersion: "main@0",
        toVersion: "main@1",
        riskThreshold: 0,
      }),
      { view, ledger, versionId: "main@1" },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.blastRadius.length, 12);
    assert.deepEqual(r.data.findings, []);
    assert.equal(r.data.riskScore, 0);
  });

  it("pr.risk.analyze returns no findings for ledger-backed no-op diffs", () => {
    const ledger = {
      pathSnapshotAt: () => new Map([[env.fileA, "unchanged-hash"]]),
      getBlobSymbols: () => [],
    };
    const r = dispatch(
      /** @type {any} */ ({
        action: "pr.risk.analyze",
        fromVersion: "main@1",
        toVersion: "main@1",
        riskThreshold: 0,
      }),
      { view: env.view, versionId: "main@1", ledger },
    );
    assert.equal(r.ok, true);
    assert.deepEqual(r.data.findings, []);
    assert.deepEqual(r.data.blastRadius, []);
    assert.deepEqual(r.data.recommendedTests, []);
    assert.equal(r.data.riskScore, 0);
  });

  it("pr.risk.analyze applies meaningful severity thresholds", (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-risk-severity-"));
    const view = new View({ dbPath: path.join(tmpRoot, "view.db"), mode: "readwrite" });
    t.after(() => {
      view.close();
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows may hold handles briefly. */ }
    });
    const db = view._unsafeDb();
    db.exec("DELETE FROM meta");
    for (const [key, value] of [
      ["schema_version", String(VIEW_SCHEMA_VERSION)],
      ["branch", "main"],
      ["ledger_seq", "1"],
      ["built_at", "2026-05-26T00:00:00.000Z"],
    ]) {
      db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run(key, value);
    }
    const insertSymbol = db.prepare(
      `INSERT INTO symbols (content_hash, local_id, kind, name, qualified_name, parent_global_id,
                            repo_rel_path, range_start, range_end, signature_hash, visibility, doc, lang)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insertEdge = db.prepare(
      `INSERT INTO edges (from_global_id, to_global_id, to_name, kind, repo_rel_path,
                          range_start, range_end, confidence)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const highHash = sha256Hex("public-entrypoint");
    const mediumHash = sha256Hex("medium-fanin");
    const highId = Number(insertSymbol.run(
      highHash, 0, "function", "publicEntrypoint", null, null,
      "src/index.ts", 0, 10, sha256Hex("publicEntrypoint()"), "public", null, "ts",
    ).lastInsertRowid);
    const mediumId = Number(insertSymbol.run(
      mediumHash, 0, "function", "mediumFanIn", null, null,
      "src/core.ts", 0, 10, sha256Hex("mediumFanIn()"), null, null, "ts",
    ).lastInsertRowid);
    for (let i = 0; i < 50; i++) {
      const caller = Number(insertSymbol.run(
        sha256Hex(`high-caller-${i}`), 0, "function", `highCaller${i}`, null, null,
        `src/high-caller-${i}.ts`, 0, 10, sha256Hex(`highCaller${i}()`), null, null, "ts",
      ).lastInsertRowid);
      insertEdge.run(caller, highId, "publicEntrypoint", "calls", "src/index.ts", 0, 10, 95);
    }
    for (let i = 0; i < 20; i++) {
      const caller = Number(insertSymbol.run(
        sha256Hex(`medium-caller-${i}`), 0, "function", `mediumCaller${i}`, null, null,
        `src/medium-caller-${i}.ts`, 0, 10, sha256Hex(`mediumCaller${i}()`), null, null, "ts",
      ).lastInsertRowid);
      insertEdge.run(caller, mediumId, "mediumFanIn", "calls", "src/core.ts", 0, 10, 95);
    }

    const highOnly = dispatch(
      /** @type {any} */ ({
        action: "pr.risk.analyze",
        fromVersion: "v0",
        toVersion: "v1",
        riskThreshold: 51,
      }),
      { view, versionId: "v1" },
    );
    assert.equal(highOnly.ok, true);
    assert.deepEqual(highOnly.data.findings.map((finding) => finding.severity), ["high"]);

    const defaultThreshold = dispatch(
      /** @type {any} */ ({
        action: "pr.risk.analyze",
        fromVersion: "v0",
        toVersion: "v1",
      }),
      { view, versionId: "v1" },
    );
    assert.equal(defaultThreshold.ok, true);
    assert.ok(defaultThreshold.data.findings.some((finding) => finding.severity === "medium"));
  });

  it("pr.risk combines delta + risk in one envelope", () => {
    cover("pr.risk");
    const r = dispatch(
      /** @type {any} */ ({
        action: "pr.risk",
        fromVersion: "v0",
        toVersion: "v1",
        maxCards: 5,
        riskThreshold: 0,
      }),
      { view: env.view, versionId: "v1" },
    );
    assert.equal(r.ok, true);
    assert.ok(r.data.delta);
    assert.ok(r.data.risk);
  });

  it("file.read returns content + line counts and supports search", () => {
    cover("file.read");
    const r = dispatch(
      /** @type {any} */ ({
        action: "file.read",
        filePath: env.fileA,
        search: "Greeter",
        searchContext: 1,
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(r.ok, true);
    assert.ok(r.data.content.includes("Greeter"));
    assert.ok((r.data.matches || []).length > 0);
  });

  it("file.read honors the search wall-clock budget before scanning the first line", () => {
    const originalNow = Date.now;
    let calls = 0;
    Date.now = () => {
      calls += 1;
      return calls <= 2 ? 0 : 1000;
    };
    try {
      const r = dispatch(
        /** @type {any} */ ({ action: "file.read", filePath: "src/slow.txt", search: "needle" }),
        {
          versionId: "v1",
          readFile: () => "needle on first line\n",
        },
      );
      assert.equal(r.ok, true);
      assert.equal(r.data.searchTimedOut, true);
      assert.equal(r.data.truncated, true);
      assert.deepEqual(r.data.matches, []);
    } finally {
      Date.now = originalNow;
    }
  });

  it("file.read blocks prototype-bearing jsonPath segments", () => {
    fs.mkdirSync(path.join(env.repoRoot, "config"), { recursive: true });
    fs.writeFileSync(
      path.join(env.repoRoot, "config/app.json"),
      JSON.stringify({ safe: { value: 42 }, constructor: { prototype: { leak: true } } }),
    );

    const safe = dispatch(
      /** @type {any} */ ({ action: "file.read", filePath: "config/app.json", jsonPath: "safe.value" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(safe.ok, true);
    assert.equal(safe.data.jsonPathValue, 42);

    const blocked = dispatch(
      /** @type {any} */ ({ action: "file.read", filePath: "config/app.json", jsonPath: "constructor.prototype" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(blocked.ok, true);
    assert.equal(blocked.data.jsonPathValue, undefined);
  });

  it("buffer overlay feeds file reads before checkpoint clear", () => {
    cover("buffer.push");
    cover("buffer.status");
    cover("buffer.checkpoint");
    const overlayContent = `import { Greeter } from "./greeter.js";\nexport function draftOnly() { return "OVERLAY_ONLY_TOKEN"; }\n`;
    const pushed = dispatch(
      /** @type {any} */ ({
        action: "buffer.push",
        filePath: env.fileB,
        content: overlayContent,
        version: 7,
        eventType: "change",
        language: "typescript",
        dirty: true,
        timestamp: "2026-05-18T00:00:01.000Z",
        cursor: { line: 2, column: 16 },
        selections: [{ startLine: 2, startColumn: 0, endLine: 2, endColumn: 42 }],
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(pushed.ok, true);
    assert.equal(pushed.data.parsed, true);
    assert.equal(pushed.data.version, 7);
    assert.equal(pushed.data.persisted, true);
    assert.equal(pushed.data.eventType, "change");
    assert.equal(pushed.data.language, "typescript");
    assert.equal(pushed.data.cursor.line, 2);
    assert.deepEqual(pushed.data.warnings, []);

    const status = dispatch(
      /** @type {any} */ ({ action: "buffer.status", filePath: env.fileB }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(status.ok, true);
    assert.equal(status.data.total, 1);
    assert.equal(status.data.totalBytes, Buffer.byteLength(overlayContent, "utf8"));
    assert.equal(status.data.dirtyCount, 1);
    assert.equal(status.data.parsedCount, 1);
    assert.deepEqual(status.data.warnings, []);
    assert.equal(status.data.buffers[0].diskMatches, false);
    assert.equal(status.data.buffers[0].persisted, true);
    assert.equal(status.data.buffers[0].dirty, true);
    assert.equal(status.data.buffers[0].symbolCount > 0, true);
    assert.equal(status.data.buffers[0].selections.length, 1);

    const liveStatus = dispatch(
      /** @type {any} */ ({ action: "repo.status", detail: "minimal" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(liveStatus.ok, true);
    assert.equal(liveStatus.data.liveIndexStatus.reconciliation.queueDepth, 1);
    assert.ok(liveStatus.data.liveIndexStatus.reconciliation.eventsReceived >= 1);
    assert.ok(liveStatus.data.liveIndexStatus.reconciliation.dependencyFrontier.files.includes(env.fileB));

    __resetBufferRegistryForTests();

    const readOverlay = dispatch(
      /** @type {any} */ ({
        action: "file.read",
        filePath: env.fileB,
        search: "OVERLAY_ONLY_TOKEN",
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(readOverlay.ok, true);
    assert.equal(readOverlay.data.matches.length, 1);

    const search = dispatch(
      /** @type {any} */ ({ action: "symbol.search", query: "draftOnly", limit: 5 }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(search.ok, true);
    const draftHit = search.data.items.find((item) => item.name === "draftOnly");
    assert.ok(draftHit, `expected draftOnly in symbol.search results: ${JSON.stringify(search.data.items)}`);
    assert.equal(draftHit.overlay, true);

    const card = dispatch(
      /** @type {any} */ ({ action: "symbol.getCard", symbolId: draftHit.symbolId, includeResolutionMetadata: true }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(card.ok, true);
    assert.equal(card.data.name, "draftOnly");
    assert.equal(card.data.overlay, true);
    assert.equal(card.data.resolution.method, "buffer-parse");

    const skeleton = dispatch(
      /** @type {any} */ ({ action: "code.getSkeleton", symbolId: draftHit.symbolId }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(skeleton.ok, true);
    assert.match(skeleton.data.content, /draftOnly/);

    const window = dispatch(
      /** @type {any} */ ({
        action: "code.needWindow",
        symbolId: draftHit.symbolId,
        reason: "inspect draft symbol",
        expectedLines: 2,
        identifiersToFind: ["draftOnly"],
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(window.ok, true);
    assert.match(window.data.content, /draftOnly/);

    const checkpoint = dispatch(
      /** @type {any} */ ({ action: "buffer.checkpoint", filePath: env.fileB, clear: true }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(checkpoint.ok, true);
    assert.equal(checkpoint.data.cleared, true);

    const postCheckpointStatus = dispatch(
      /** @type {any} */ ({ action: "repo.status", detail: "minimal" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(postCheckpointStatus.ok, true);
    assert.equal(postCheckpointStatus.data.liveIndexStatus.reconciliation.checkpoints.attempted >= 1, true);
    assert.equal(postCheckpointStatus.data.liveIndexStatus.reconciliation.dependencyFrontier.files.includes(env.fileB), false);

    const readDisk = dispatch(
      /** @type {any} */ ({
        action: "file.read",
        filePath: env.fileB,
        search: "OVERLAY_ONLY_TOKEN",
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(readDisk.ok, true);
    assert.equal(readDisk.data.matches.length, 0);
  });

  it("buffer.status reports unparsable draft diagnostics", () => {
    const pushed = dispatch(
      /** @type {any} */ ({
        action: "buffer.push",
        filePath: "notes/plain.txt",
        content: "not a supported source file",
        dirty: true,
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(pushed.ok, true);
    assert.equal(pushed.data.parsed, false);
    assert.ok(pushed.data.warnings.some((warning) => /parser did not produce/i.test(warning)));

    const status = dispatch(
      /** @type {any} */ ({ action: "buffer.status", filePath: "notes/plain.txt" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(status.ok, true);
    assert.equal(status.data.parsedCount, 0);
    assert.equal(status.data.dirtyCount, 1);
    assert.ok(status.data.warnings.some((warning) => /parser did not produce/i.test(warning)));

    const checkpoint = dispatch(
      /** @type {any} */ ({ action: "buffer.checkpoint", filePath: "notes/plain.txt", clear: true }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(checkpoint.ok, true);
  });

  it("buffer.status marks syntax-error drafts as partial parses", () => {
    const pushed = dispatch(
      /** @type {any} */ ({
        action: "buffer.push",
        filePath: "src/broken-draft.ts",
        content: "export function kept() { return 1; }\nexport function broken(",
        dirty: true,
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(pushed.ok, true);
    assert.equal(pushed.data.parsed, false);
    assert.equal(pushed.data.symbolCount > 0, true);
    assert.ok(pushed.data.warnings.some((warning) => /syntax errors/i.test(warning)));

    const status = dispatch(
      /** @type {any} */ ({ action: "buffer.status", filePath: "src/broken-draft.ts" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(status.ok, true);
    assert.equal(status.data.parsedCount, 0);
    assert.equal(status.data.parseFailureCount, 1);
    assert.equal(status.data.syntaxErrorCount, 1);
    assert.equal(status.data.parseExceptionCount, 0);
    assert.ok(status.data.warnings.some((warning) => /partial/i.test(warning)));

    const checkpoint = dispatch(
      /** @type {any} */ ({ action: "buffer.checkpoint", filePath: "src/broken-draft.ts", clear: true }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(checkpoint.ok, true);
  });

  it("buffer.push rejects stale versions and reports lifecycle counters", () => {
    const repoRoot = makeTmp("buffer-lifecycle");
    try {
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      const first = dispatch(
        /** @type {any} */ ({
          action: "buffer.push",
          filePath: "src/draft.ts",
          content: "export const draft = 1;\n",
          version: 2,
        }),
        { versionId: "v1", repoRoot },
      );
      assert.equal(first.ok, true);

      const sameVersionSameContent = dispatch(
        /** @type {any} */ ({
          action: "buffer.push",
          filePath: "src/draft.ts",
          content: "export const draft = 1;\n",
          version: 2,
          eventType: "save",
          dirty: false,
        }),
        { versionId: "v1", repoRoot },
      );
      assert.equal(sameVersionSameContent.ok, true);
      assert.equal(sameVersionSameContent.data.version, 2);
      assert.equal(sameVersionSameContent.data.dirty, false);

      const sameVersionDifferentContent = dispatch(
        /** @type {any} */ ({
          action: "buffer.push",
          filePath: "src/draft.ts",
          content: "export const draft = 99;\n",
          version: 2,
        }),
        { versionId: "v1", repoRoot },
      );
      assert.equal(sameVersionDifferentContent.ok, false);
      assert.equal(sameVersionDifferentContent.error?.code, "buffer_version_conflict");

      const stale = dispatch(
        /** @type {any} */ ({
          action: "buffer.push",
          filePath: "src/draft.ts",
          content: "export const draft = 0;\n",
          version: 1,
        }),
        { versionId: "v1", repoRoot },
      );
      assert.equal(stale.ok, false);
      assert.equal(stale.error?.code, "stale_buffer_version");
      assert.equal(stale.error?.details?.currentVersion, 2);

      const fresh = dispatch(
        /** @type {any} */ ({
          action: "buffer.push",
          filePath: "src/draft.ts",
          content: "export const draft = 3;\n",
          version: 3,
        }),
        { versionId: "v1", repoRoot },
      );
      assert.equal(fresh.ok, true);
      assert.equal(fresh.data.replaced, true);

      const status = dispatch(
        /** @type {any} */ ({ action: "buffer.status", filePath: "src/draft.ts" }),
        { versionId: "v1", repoRoot },
      );
      assert.equal(status.ok, true);
      assert.equal(status.data.total, 1);
      assert.equal(status.data.buffers[0].version, 3);
      assert.equal(status.data.staleRejectedCount, 1);
      assert.equal(status.data.versionConflictRejectedCount, 1);
      assert.equal(status.data.pendingParseCount, 0);
      assert.equal(status.data.parseFailureCount, 0);
      assert.equal(status.data.syntaxErrorCount, 0);
      assert.equal(status.data.parseExceptionCount, 0);
      assert.equal(status.data.draftLimitReached, false);
      assert.equal(typeof status.data.lastUpdatedAt, "string");
      assert.equal(typeof status.data.lastRejectedAt, "string");
    } finally {
      __resetBufferRegistryForTests();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("buffer.push hard-rejects new drafts after the live buffer cap", () => {
    const repoRoot = makeTmp("buffer-limit");
    try {
      for (let i = 0; i < 200; i += 1) {
        const pushed = dispatch(
          /** @type {any} */ ({
            action: "buffer.push",
            filePath: `notes/draft-${i}.txt`,
            content: `draft ${i}\n`,
            version: i,
          }),
          { versionId: "v1", repoRoot },
        );
        assert.equal(pushed.ok, true, `push ${i} should fit below the cap`);
      }
      const rejected = dispatch(
        /** @type {any} */ ({
          action: "buffer.push",
          filePath: "notes/draft-over.txt",
          content: "too many\n",
          version: 201,
        }),
        { versionId: "v1", repoRoot },
      );
      assert.equal(rejected.ok, false);
      assert.equal(rejected.error?.code, "draft_limit_exceeded");

      const status = dispatch(
        /** @type {any} */ ({ action: "buffer.status" }),
        { versionId: "v1", repoRoot },
      );
      assert.equal(status.ok, true);
      assert.equal(status.data.total, 200);
      assert.equal(status.data.draftLimit, 200);
      assert.equal(status.data.draftLimitReached, true);
      assert.equal(status.data.draftLimitRejectedCount, 1);
    } finally {
      __resetBufferRegistryForTests();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("file.read rejects non-canonical paths", () => {
    const r = dispatch(
      /** @type {any} */ ({ action: "file.read", filePath: "../escape" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(r.ok, false);
    assert.equal(r.error?.code, "invalid_path");
  });

  it("file.read downgrades whole indexed source reads and redacts secrets in bounded reads", () => {
    fs.writeFileSync(
      path.join(env.repoRoot, env.fileA),
      `export const apiKey = "sk-abcdefghijklmnopqrstuvwxyz123456";\nexport class Greeter {}\n`,
    );
    const raw = dispatch(
      /** @type {any} */ ({ action: "file.read", filePath: env.fileA }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(raw.ok, false);
    assert.equal(raw.error?.code, "policy_downgrade");

    const bounded = dispatch(
      /** @type {any} */ ({ action: "file.read", filePath: env.fileA, limit: 1 }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(bounded.ok, true);
    assert.match(bounded.data.content, /<redacted>/);
    assert.doesNotMatch(bounded.data.content, /sk-abcdefghijklmnopqrstuvwxyz/);
  });

  it("memory actions store, query, surface, and remove native v2 memories", () => {
    cover("memory.store");
    cover("memory.query");
    cover("memory.surface");
    cover("memory.remove");
    const store = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        type: "decision",
        title: "Use native ATLAS memory",
        content: "Store memories in the v2 ledger, not the old ATLAS sidecar.",
        tags: ["atlas", "native"],
        confidence: 0.9,
        symbolIds: [env.symbolIdByName.Greeter],
        fileRelPaths: [env.fileA],
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot, ledger: env.ledger, repoId: "test-repo" },
    );
    assert.equal(store.ok, true);
    assert.ok(store.data.memoryId);

    const query = dispatch(
      /** @type {any} */ ({ action: "memory.query", query: "ledger sidecar", tags: ["native"], limit: 5 }),
      { versionId: "v1", ledger: env.ledger, repoId: "test-repo" },
    );
    assert.equal(query.ok, true);
    assert.equal(query.data.total, 1);
    const ftsCount = /** @type {{ c: number }} */ (
      env.ledger._unsafeDb().prepare("SELECT COUNT(*) AS c FROM memories_fts").get()
    ).c;
    assert.ok(ftsCount >= 1);

    const surface = dispatch(
      /** @type {any} */ ({ action: "memory.surface", symbolIds: [env.symbolIdByName.Greeter], limit: 5 }),
      { versionId: "v1", ledger: env.ledger, repoId: "test-repo" },
    );
    assert.equal(surface.ok, true);
    assert.equal(surface.data.memories.length, 1);
    assert.equal(surface.data.memories[0].matchedSymbols[0], env.symbolIdByName.Greeter);

    const remove = dispatch(
      /** @type {any} */ ({ action: "memory.remove", memoryId: store.data.memoryId }),
      { versionId: "v1", ledger: env.ledger, repoId: "test-repo" },
    );
    assert.equal(remove.ok, true);
  });

  it("memory.store rejects cross-repo memoryId takeover", () => {
    const first = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_cross_repo_takeover",
        type: "decision",
        title: "Cross repo owner",
        content: "This row belongs to repo A.",
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "repo-a" },
    );
    assert.equal(first.ok, true);

    const takeover = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_cross_repo_takeover",
        type: "decision",
        title: "Cross repo takeover",
        content: "Repo B must not be able to move repo A's memory.",
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "repo-b" },
    );
    assert.equal(takeover.ok, false);
    assert.equal(takeover.error?.code, "memory_id_conflict");

    const repoA = dispatch(
      /** @type {any} */ ({ action: "memory.query", query: "belongs to repo A", limit: 5 }),
      { versionId: "v1", ledger: env.ledger, repoId: "repo-a" },
    );
    assert.equal(repoA.ok, true);
    assert.equal(repoA.data.total, 1);
  });

  it("memory.store rejects new explicit-id writes that duplicate another memory's content", () => {
    const existing = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_new_duplicate_source",
        type: "decision",
        title: "New duplicate source",
        content: "This content already exists.",
        tags: ["new-dup"],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "new-dup-repo" },
    );
    assert.equal(existing.ok, true);

    const duplicate = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_new_duplicate_target",
        type: "decision",
        title: "New duplicate source",
        content: "This content already exists.",
        tags: ["new-dup"],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "new-dup-repo" },
    );
    assert.equal(duplicate.ok, false);
    assert.equal(duplicate.error?.code, "duplicate_memory_content");
  });

  it("memory.store lets existing ids take over duplicate content in the same repo", () => {
    const one = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_duplicate_content_a",
        type: "decision",
        title: "Duplicate content A",
        content: "Original content stays on A.",
        tags: ["dup-a"],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "dup-repo" },
    );
    assert.equal(one.ok, true);

    const two = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_duplicate_content_b",
        type: "decision",
        title: "Duplicate content B",
        content: "Shared content belongs to B.",
        tags: ["dup-b"],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "dup-repo" },
    );
    assert.equal(two.ok, true);

    const update = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_duplicate_content_a",
        type: "decision",
        title: "Duplicate content B",
        content: "Shared content belongs to B.",
        tags: ["dup-b"],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "dup-repo" },
    );
    assert.equal(update.ok, true);
    assert.equal(update.data.memoryId, "mem_duplicate_content_a");
    assert.equal(update.data.created, false);
    assert.equal(update.data.mergedDuplicateMemoryId, "mem_duplicate_content_b");

    const rows = env.ledger._unsafeDb().prepare(
      "SELECT memory_id, deleted FROM memories WHERE repo_id = ? AND memory_id IN (?, ?) ORDER BY memory_id",
    ).all("dup-repo", "mem_duplicate_content_a", "mem_duplicate_content_b");
    assert.deepEqual(rows.map((row) => [row.memory_id, row.deleted]), [
      ["mem_duplicate_content_a", 0],
      ["mem_duplicate_content_b", 1],
    ]);
  });

  it("memory.store allows same-id idempotent updates even when dedupe is active", () => {
    const first = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_idempotent_update",
        type: "decision",
        title: "Idempotent memory",
        content: "This content is stable.",
        tags: ["stable"],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "idem-repo" },
    );
    assert.equal(first.ok, true);

    const second = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_idempotent_update",
        type: "decision",
        title: "Idempotent memory renamed",
        content: "This content is stable.",
        tags: ["stable"],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "idem-repo" },
    );
    assert.equal(second.ok, true);
    assert.equal(second.data.memoryId, "mem_idempotent_update");
    assert.equal(second.data.created, false);
  });

  it("memory.surface treats taskType as a preference rather than a hard type filter", () => {
    const store = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_surface_soft_task_type",
        type: "architecture",
        title: "Greeter architecture note",
        content: "The Greeter symbol owns the greeting boundary.",
        symbolIds: [env.symbolIdByName.Greeter],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "surface-repo" },
    );
    assert.equal(store.ok, true);

    const surface = dispatch(
      /** @type {any} */ ({
        action: "memory.surface",
        taskType: "bugfix",
        symbolIds: [env.symbolIdByName.Greeter],
        limit: 5,
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "surface-repo" },
    );
    assert.equal(surface.ok, true);
    assert.ok(surface.data.memories.some((memory) => memory.memoryId === "mem_surface_soft_task_type"));
  });

  it("memory.surface matches any provided anchor instead of requiring all of them", () => {
    const store = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_surface_file_only_anchor",
        type: "bugfix",
        title: "File-only anchored memory",
        content: "This memory is anchored to a file but not to any symbol.",
        fileRelPaths: [env.fileA],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "surface-or-repo" },
    );
    assert.equal(store.ok, true);

    const surface = dispatch(
      /** @type {any} */ ({
        action: "memory.surface",
        symbolIds: [env.symbolIdByName.Greeter],
        fileRelPaths: [env.fileA],
        limit: 5,
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "surface-or-repo" },
    );
    assert.equal(surface.ok, true);
    const surfaced = surface.data.memories.find((memory) => memory.memoryId === "mem_surface_file_only_anchor");
    assert.ok(surfaced, "file-anchored memory should surface when symbol and file anchors are both provided");
    assert.deepEqual(surfaced.matchedFiles, [env.fileA]);

    const unrelated = dispatch(
      /** @type {any} */ ({
        action: "memory.surface",
        symbolIds: [env.symbolIdByName.Greeter],
        fileRelPaths: ["src/does-not-exist.ts"],
        limit: 5,
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "surface-or-repo" },
    );
    assert.equal(unrelated.ok, true);
    assert.equal(
      unrelated.data.memories.some((memory) => memory.memoryId === "mem_surface_file_only_anchor"),
      false,
      "memories with no matching anchor must not surface",
    );
  });

  it("memory staleness sweep flags old memories and keeps them out of surface", () => {
    const store = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_stale_candidate",
        type: "decision",
        title: "Old decision",
        content: "This memory has not been touched in a very long time.",
        fileRelPaths: [env.fileA],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "stale-repo" },
    );
    assert.equal(store.ok, true);

    env.ledger._unsafeDb().prepare(
      "UPDATE memories SET updated_at = ? WHERE memory_id = ?",
    ).run("2020-01-01T00:00:00.000Z", "mem_stale_candidate");

    const query = dispatch(
      /** @type {any} */ ({ action: "memory.query", limit: 5 }),
      { versionId: "v1", ledger: env.ledger, repoId: "stale-repo" },
    );
    assert.equal(query.ok, true);
    const queried = query.data.memories.find((memory) => memory.memoryId === "mem_stale_candidate");
    assert.ok(queried, "stale memories must stay queryable");
    assert.equal(queried.stale, true);

    const surface = dispatch(
      /** @type {any} */ ({ action: "memory.surface", fileRelPaths: [env.fileA], limit: 5 }),
      { versionId: "v1", ledger: env.ledger, repoId: "stale-repo" },
    );
    assert.equal(surface.ok, true);
    assert.equal(
      surface.data.memories.some((memory) => memory.memoryId === "mem_stale_candidate"),
      false,
      "stale memories must not surface proactively",
    );

    const refresh = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_stale_candidate",
        type: "decision",
        title: "Old decision",
        content: "This memory has been refreshed with current guidance.",
        fileRelPaths: [env.fileA],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "stale-repo" },
    );
    assert.equal(refresh.ok, true);
    const resurface = dispatch(
      /** @type {any} */ ({ action: "memory.surface", fileRelPaths: [env.fileA], limit: 5 }),
      { versionId: "v1", ledger: env.ledger, repoId: "stale-repo" },
    );
    assert.ok(resurface.data.memories.some((memory) => memory.memoryId === "mem_stale_candidate"));
  });

  it("memory.store folds near-duplicate auto-id writes into the existing memory", () => {
    const first = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        type: "bugfix",
        title: "Worker heartbeat config rebuild",
        content: "The atlas cli worker must rebuild its heartbeat validator whenever heartbeat config changes during long sessions.",
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "near-dup-repo" },
    );
    assert.equal(first.ok, true);
    assert.equal(first.data.created, true);

    const reworded = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        type: "bugfix",
        title: "Worker heartbeat config rebuild",
        content: "The atlas cli worker must rebuild its heartbeat validator whenever heartbeat config changes during long sessions today.",
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "near-dup-repo" },
    );
    assert.equal(reworded.ok, true);
    assert.equal(reworded.data.deduplicated, true);
    assert.equal(reworded.data.nearDuplicate, true);
    assert.equal(reworded.data.memoryId, first.data.memoryId);

    const distinct = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        type: "bugfix",
        title: "Push guard refspec validation",
        content: "Push refspecs are validated against the allowlist before any remote mutation runs.",
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "near-dup-repo" },
    );
    assert.equal(distinct.ok, true);
    assert.equal(distinct.data.created, true);
    assert.notEqual(distinct.data.memoryId, first.data.memoryId);
  });

  it("memory.store enforces the per-repo memory cap by evicting the least valuable rows", () => {
    const policy = dispatch(
      /** @type {any} */ ({ action: "policy.set", policyPatch: { memoryMaxPerRepo: 2 } }),
      { versionId: "v1", ledger: env.ledger, repoId: "cap-repo" },
    );
    assert.equal(policy.ok, true);
    assert.equal(policy.data.policy.memoryMaxPerRepo, 2);

    const seeds = [
      { memoryId: "mem_cap_low", confidence: 0.1, content: "Low confidence row that should be evicted first." },
      { memoryId: "mem_cap_high", confidence: 0.9, content: "High confidence row that should survive the cap." },
      { memoryId: "mem_cap_new", confidence: 0.8, content: "Newest row that should also survive the cap." },
    ];
    for (const seed of seeds) {
      const stored = dispatch(
        /** @type {any} */ ({
          action: "memory.store",
          memoryId: seed.memoryId,
          type: "convention",
          title: `Cap seed ${seed.memoryId}`,
          content: seed.content,
          confidence: seed.confidence,
        }),
        { versionId: "v1", ledger: env.ledger, repoId: "cap-repo" },
      );
      assert.equal(stored.ok, true);
    }

    const rows = env.ledger._unsafeDb().prepare(
      "SELECT memory_id, deleted FROM memories WHERE repo_id = ? ORDER BY memory_id",
    ).all("cap-repo");
    assert.deepEqual(rows.map((row) => [row.memory_id, row.deleted]), [
      ["mem_cap_high", 0],
      ["mem_cap_low", 1],
      ["mem_cap_new", 0],
    ]);
  });

  it("slice.build forwards repoId when enriching slices with memories", () => {
    const store = dispatch(
      /** @type {any} */ ({
        action: "memory.store",
        memoryId: "mem_slice_repo_enrichment",
        type: "decision",
        title: "Slice repo memory",
        content: "Slice enrichment should use the dispatch repo id.",
        symbolIds: [env.symbolIdByName.Greeter],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "slice-repo" },
    );
    assert.equal(store.ok, true);

    const slice = dispatch(
      /** @type {any} */ ({
        action: "slice.build",
        entrySymbols: [env.symbolIdByName.Greeter],
        budget: { maxCards: 5 },
      }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot, ledger: env.ledger, repoId: "slice-repo" },
    );
    assert.equal(slice.ok, true);
    assert.ok(slice.data.memories?.some((memory) => memory.memoryId === "mem_slice_repo_enrichment"));
  });

  it("policy actions get and patch native v2 policy", () => {
    cover("policy.get");
    cover("policy.set");
    const beforePolicy = dispatch(
      /** @type {any} */ ({ action: "policy.get" }),
      { versionId: "v1", ledger: env.ledger, repoId: "test-repo" },
    );
    assert.equal(beforePolicy.ok, true);
    assert.equal(beforePolicy.data.policy.memoryEnabled, true);

    const set = dispatch(
      /** @type {any} */ ({ action: "policy.set", policyPatch: { maxWindowLines: 12, budgetCaps: { maxCards: 7 } } }),
      { versionId: "v1", ledger: env.ledger, repoId: "test-repo" },
    );
    assert.equal(set.ok, true);
    assert.equal(set.data.policy.maxWindowLines, 12);
    assert.equal(set.data.policy.budgetCaps.maxCards, 7);
  });

  it("policy.set rejects array policyPatch values", () => {
    const set = dispatch(
      /** @type {any} */ ({ action: "policy.set", policyPatch: [{ maxWindowLines: 200 }] }),
      { versionId: "v1", ledger: env.ledger, repoId: "test-repo" },
    );
    assert.equal(set.ok, false);
    assert.equal(set.error?.code, "invalid_policy_patch");
  });

  it("runtime actions are policy gated and query persisted output", async () => {
    cover("runtime.execute");
    cover("runtime.queryOutput");

    const denied = await dispatch(
      /** @type {any} */ ({ action: "runtime.execute", repoId: "runtime-repo", runtime: "node", args: ["-e", "console.log('nope')"] }),
      { versionId: "v1", ledger: env.ledger, repoId: "runtime-repo", repoRoot: env.repoRoot },
    );
    assert.equal(denied.ok, false);
    assert.equal(denied.error?.code, "runtime_disabled");
    assert.equal(denied.error?.details?.status, "denied");

    const enabled = dispatch(
      /** @type {any} */ ({ action: "policy.set", repoId: "runtime-repo", policyPatch: { runtimeEnabled: true } }),
      { versionId: "v1", ledger: env.ledger, repoId: "runtime-repo" },
    );
    assert.equal(enabled.ok, true);

    const previousRuntimeSecret = process.env.POSSE_RUNTIME_SECRET;
    process.env.POSSE_RUNTIME_SECRET = "atlas-runtime-secret-value";
    try {
      const envProbe = await dispatch(
        /** @type {any} */ ({
          action: "runtime.execute",
          repoId: "runtime-repo",
          runtime: "node",
          args: ["-e", "console.log(process.env.POSSE_RUNTIME_SECRET || 'missing')"],
          persistOutput: false,
        }),
        { versionId: "v1", ledger: env.ledger, repoId: "runtime-repo", repoRoot: env.repoRoot },
      );
      assert.equal(envProbe.ok, true);
      assert.equal(String(envProbe.data.stdoutPreview || "").trim(), "missing");
      assert.doesNotMatch(JSON.stringify(envProbe.data), /atlas-runtime-secret-value/);
    } finally {
      if (previousRuntimeSecret == null) delete process.env.POSSE_RUNTIME_SECRET;
      else process.env.POSSE_RUNTIME_SECRET = previousRuntimeSecret;
    }

    const executed = await dispatch(
      /** @type {any} */ ({
        action: "runtime.execute",
        repoId: "runtime-repo",
        runtime: "node",
        args: ["-e", "console.log('alpha'); console.log('needle beta');"],
        outputMode: "intent",
        queryTerms: ["needle"],
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "runtime-repo", repoRoot: env.repoRoot },
    );
    assert.equal(executed.ok, true);
    assert.equal(executed.data.status, "success");
    assert.ok(executed.data.artifactHandle);
    assert.ok(executed.data.excerpts.some((entry) => entry.content.includes("needle beta")));

    const queried = dispatch(
      /** @type {any} */ ({
        action: "runtime.queryOutput",
        artifactHandle: executed.data.artifactHandle,
        queryTerms: ["needle"],
      }),
      { versionId: "v1", repoRoot: env.repoRoot },
    );
    assert.equal(queried.ok, true);
    assert.ok(queried.data.excerpts.some((entry) => entry.content.includes("needle beta")));

    const large = await dispatch(
      /** @type {any} */ ({
        action: "runtime.execute",
        repoId: "runtime-repo",
        runtime: "node",
        args: ["-e", "process.stdout.write('x'.repeat(1024 * 1024 + 10))"],
        persistOutput: false,
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "runtime-repo", repoRoot: env.repoRoot },
    );
    assert.equal(large.ok, true);
    assert.equal(large.data.truncation.stdoutTruncated, true);
    assert.equal(large.data.truncation.totalStdoutBytes, 1024 * 1024 + 10);

    const codeA = await dispatch(
      /** @type {any} */ ({
        action: "runtime.execute",
        repoId: "runtime-repo",
        runtime: "node",
        code: "console.log('stable audit');",
        persistOutput: false,
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "runtime-repo", repoRoot: env.repoRoot },
    );
    const codeB = await dispatch(
      /** @type {any} */ ({
        action: "runtime.execute",
        repoId: "runtime-repo",
        runtime: "node",
        code: "console.log('stable audit');",
        persistOutput: false,
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "runtime-repo", repoRoot: env.repoRoot },
    );
    assert.equal(codeA.ok, true);
    assert.equal(codeB.ok, true);
    assert.equal(codeA.data.policyDecision.auditHash, codeB.data.policyDecision.auditHash);
    assert.deepEqual(codeA.data.command.args, ["<code>"]);

    const aliasRuntime = await dispatch(
      /** @type {any} */ ({
        action: "runtime.execute",
        repoId: "runtime-repo",
        runtime: "javascript",
        code: "console.log('alias runtime');",
        persistOutput: false,
      }),
      { versionId: "v1", ledger: env.ledger, repoId: "runtime-repo", repoRoot: env.repoRoot },
    );
    assert.equal(aliasRuntime.ok, true);
    assert.equal(aliasRuntime.data.status, "success");
    assert.equal(aliasRuntime.data.command.runtime, "node");
    assert.deepEqual(aliasRuntime.data.command.args, ["<code>"]);
  });

  it("usage.stats reports native v2 dispatch usage", () => {
    cover("usage.stats");
    dispatch(
      /** @type {any} */ ({ action: "repo.status", detail: "minimal" }),
      { view: env.view, versionId: "v1", repoRoot: env.repoRoot, ledger: env.ledger, repoId: "usage-repo" },
    );
    const stats = dispatch(
      /** @type {any} */ ({ action: "usage.stats", scope: "both", limit: 10 }),
      { versionId: "v1", ledger: env.ledger, repoId: "usage-repo" },
    );
    assert.equal(stats.ok, true);
    assert.ok(stats.data.session.totalCalls >= 1);
    assert.ok(stats.data.session.p95DurationMs >= 0);
    assert.equal(stats.data.session.tokenAccounting.method, "result_bytes/action_multiplier");
    assert.ok(stats.data.session.toolBreakdown.some((entry) => entry.tool === "repo.status" && entry.savingsPercent >= 0));
    assert.ok(stats.data.history.aggregate.totalCalls >= 1);
    assert.ok(stats.data.history.aggregate.topToolsBySavings.length > 0);
  });

  it("usage.stats limits history snapshots without truncating default aggregate totals", () => {
    const db = env.ledger._unsafeDb();
    const ins = db.prepare(
      `INSERT INTO usage_events
         (ts, repo_id, action, ok, duration_ms, result_bytes, version_id, task_type, error_code)
       VALUES (?, ?, ?, 1, 1, 10, 'v1', NULL, NULL)`,
    );
    ins.run("2026-05-18T00:00:01.000Z", "usage-limit-repo", "repo.status");
    ins.run("2026-05-18T00:00:02.000Z", "usage-limit-repo", "memory.query");
    ins.run("2026-05-18T00:00:03.000Z", "usage-limit-repo", "code.getSkeleton");

    const stats = dispatch(
      /** @type {any} */ ({ action: "usage.stats", scope: "both", limit: 2 }),
      { versionId: "v1", ledger: env.ledger, repoId: "usage-limit-repo" },
    );
    assert.equal(stats.ok, true);
    assert.equal(stats.data.session.totalCalls, 3);
    assert.equal(stats.data.history.snapshots.length, 2);
    assert.equal(stats.data.history.aggregate.totalCalls, 3);

    const bounded = dispatch(
      /** @type {any} */ ({ action: "usage.stats", scope: "both", limit: 2, aggregateLimit: 2 }),
      { versionId: "v1", ledger: env.ledger, repoId: "usage-limit-repo" },
    );
    assert.equal(bounded.ok, true);
    assert.equal(bounded.data.session.totalCalls, 3);
    assert.equal(bounded.data.session.sampledCalls, 2);
    assert.equal(bounded.data.session.truncated, true);
    assert.equal(bounded.data.history.aggregate.totalCalls, 3);
  });

  it("info counts real ledger tables and parses branches containing version separators", () => {
    const result = dispatch(
      /** @type {any} */ ({ action: "info", includeCounts: true }),
      { versionId: "release@2026-05-24@v1", repoRoot: env.repoRoot, ledger: env.ledger },
    );
    assert.equal(result.ok, true);
    assert.equal(result.data.ledger.branch, "release@2026-05-24");
    assert.equal(typeof result.data.ledger.counts.symbolDeltas, "number");
    assert.equal(typeof result.data.ledger.counts.usageEvents, "number");
    assert.equal(Object.hasOwn(result.data.ledger.counts, "events"), false);
  });

  it("info does not warn about the canonical ledger path when a live ledger handle is open elsewhere", () => {
    const root = makeTmp("info-live-ledger");
    const ledger = Ledger.open({ dbPath: path.join(root, "custom-ledger.db") });
    try {
      const result = dispatch(
        /** @type {any} */ ({ action: "info" }),
        { versionId: "main@0", repoRoot: root, ledger },
      );
      assert.equal(result.ok, true);
      assert.equal(result.data.storage.ledgerPath, path.join(root, "custom-ledger.db"));
      assert.equal(result.data.warnings.includes("ATLAS v2 ledger file is missing."), false);
    } finally {
      ledger.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it("scip.ingest returns a structured error for missing indexes", async () => {
    cover("scip.ingest");
    const result = await dispatch(
      /** @type {any} */ ({ action: "scip.ingest", indexPath: "missing.scip", dryRun: true }),
      { versionId: "main@0", repoRoot: env.repoRoot, ledger: env.ledger },
    );
    assert.equal(result.ok, false);
    assert.equal(result.error?.code, "not_found");
  });

  it("scip.ingest can refresh an existing main view without manual cleanup", async () => {
    const repoRoot = makeTmp("scip-refresh");
    const ledger = Ledger.open({ dbPath: path.join(repoRoot, ".posse", "atlas", "ledger.db") });
    try {
      const source = "export function helper() { return 1; }\n";
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "src", "index.ts"), source);
      const scipPath = path.join(repoRoot, "index.scip");
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0", arguments: [] }),
          project_root: repoRoot,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/index.ts",
          text: source,
          occurrences: [
            { range: [0, 16, 22], symbol: "scip-typescript npm pkg 1.0.0 src/`index.ts`/helper().", symbol_roles: 0x1 },
          ],
          symbols: [
            { symbol: "scip-typescript npm pkg 1.0.0 src/`index.ts`/helper().", display_name: "helper" },
          ],
        }],
      }));

      const first = await dispatch(
        /** @type {any} */ ({ action: "scip.ingest", indexPath: "index.scip" }),
        { versionId: "main@0", ledger, repoRoot },
      );
      assert.equal(first.ok, true);
      assert.ok(fs.existsSync(mainViewPath(repoRoot)));

      const second = await dispatch(
        /** @type {any} */ ({ action: "scip.ingest", indexPath: "index.scip" }),
        { versionId: "init@0", ledger, repoRoot },
      );
      assert.equal(second.ok, true);
      assert.equal(second.data.rebuiltView, false);
      assert.equal(second.data.versionId, first.data.versionId);
      assert.ok(fs.existsSync(mainViewPath(repoRoot)));
      const refreshed = new View({ dbPath: mainViewPath(repoRoot), mode: "readonly" });
      try {
        assert.equal(refreshed.meta().branch, "main");
        assert.ok(refreshed.query.allSymbols({ limit: 10 }).some((symbol) => symbol.name === "helper"));
      } finally {
        refreshed.close();
      }
    } finally {
      ledger.close();
      fs.rmSync(repoRoot, { recursive: true, force: true });
    }
  });

  it("every action in ATLAS_TOOL_ACTIONS is covered by this suite", () => {
    const missing = ATLAS_TOOL_ACTIONS.filter((a) => !touched.has(a));
    assert.deepEqual(missing, [], `Missing coverage for: ${missing.join(", ")}`);
  });
});

// ---------------------------------------------------------------------------
// Ledger-backed delta integration — exercises the real two-snapshot diff.
// ---------------------------------------------------------------------------

describe("delta.get with ledger history", () => {
  it("emits added / removed / modified cards across two ledger seqs", (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-delta-"));
    const ledgerPath = path.join(tmpRoot, "ledger.db");
    const ledger = Ledger.open({ dbPath: ledgerPath });

    // Two blobs for path "a.ts": v1 has a "foo" function; v2 changes its
    // signature (modify). Path "b.ts" exists at v1 only (will be removed
    // at v2). Path "c.ts" is added at v2.
    const sourceA1 = "function foo() {}\n";
    const sourceA2 = "function foo(x) {}\n";
    const sourceB1 = "export const B = 1;\n";
    const sourceC2 = "export const C = 2;\n";
    const hashA1 = sha256Hex(sourceA1);
    const hashA2 = sha256Hex(sourceA2);
    const hashB1 = sha256Hex(sourceB1);
    const hashC2 = sha256Hex(sourceC2);

    // Ingest blobs.
    const sig1 = sha256Hex("foo()");
    const sig2 = sha256Hex("foo(x)");
    ledger.ingestBlob({
      content_hash: hashA1,
      lang: "ts",
      byte_size: sourceA1.length,
      symbols: [
        {
          content_hash: hashA1,
          local_id: 0,
          kind: "function",
          name: "foo",
          qualified_name: null,
          parent_local_id: null,
          repo_rel_path: "x.ts",
          lang: "ts",
          range_start: 0,
          range_end: 17,
          signature_hash: sig1,
          visibility: null,
          doc: null,
        },
      ],
      edges: [],
    });
    ledger.ingestBlob({
      content_hash: hashA2,
      lang: "ts",
      byte_size: sourceA2.length,
      symbols: [
        {
          content_hash: hashA2,
          local_id: 0,
          kind: "function",
          name: "foo",
          qualified_name: null,
          parent_local_id: null,
          repo_rel_path: "x.ts",
          lang: "ts",
          range_start: 0,
          range_end: 18,
          signature_hash: sig2,
          visibility: null,
          doc: null,
        },
      ],
      edges: [],
    });
    ledger.ingestBlob({
      content_hash: hashB1,
      lang: "ts",
      byte_size: sourceB1.length,
      symbols: [
        {
          content_hash: hashB1,
          local_id: 0,
          kind: "const",
          name: "B",
          qualified_name: null,
          parent_local_id: null,
          repo_rel_path: "x.ts",
          lang: "ts",
          range_start: 0,
          range_end: sourceB1.length,
          signature_hash: sha256Hex("const B"),
          visibility: null,
          doc: null,
        },
      ],
      edges: [],
    });
    ledger.ingestBlob({
      content_hash: hashC2,
      lang: "ts",
      byte_size: sourceC2.length,
      symbols: [
        {
          content_hash: hashC2,
          local_id: 0,
          kind: "const",
          name: "C",
          qualified_name: null,
          parent_local_id: null,
          repo_rel_path: "x.ts",
          lang: "ts",
          range_start: 0,
          range_end: sourceC2.length,
          signature_hash: sha256Hex("const C"),
          visibility: null,
          doc: null,
        },
      ],
      edges: [],
    });

    // Seq 1: add a.ts (v1), b.ts (v1).
    ledger.append({
      branch: "main",
      op: "add",
      repo_rel_path: "a.ts",
      before_content_hash: null,
      after_content_hash: hashA1,
    });
    ledger.append({
      branch: "main",
      op: "add",
      repo_rel_path: "b.ts",
      before_content_hash: null,
      after_content_hash: hashB1,
    });
    const seqV1 = ledger.headSeq("main");

    // Seq 2+: modify a.ts → v2, remove b.ts, add c.ts.
    ledger.append({
      branch: "main",
      op: "modify",
      repo_rel_path: "a.ts",
      before_content_hash: hashA1,
      after_content_hash: hashA2,
    });
    ledger.append({
      branch: "main",
      op: "remove",
      repo_rel_path: "b.ts",
      before_content_hash: hashB1,
      after_content_hash: null,
    });
    ledger.append({
      branch: "main",
      op: "add",
      repo_rel_path: "c.ts",
      before_content_hash: null,
      after_content_hash: hashC2,
    });
    const seqV2 = ledger.headSeq("main");

    // Build a no-op view just so the dispatcher signature is satisfied.
    const viewPath = path.join(tmpRoot, "view.db");
    const view = new View({ dbPath: viewPath, mode: "readwrite" });
    t.after(() => {
      view.close();
      ledger.close();
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        // Windows may need a moment for the file handle to release.
      }
    });
    // Seed minimal meta so View.meta() doesn't trip — we don't read it here.
    const db = view._unsafeDb();
    db.exec("DELETE FROM meta");
    db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run("schema_version", String(VIEW_SCHEMA_VERSION));
    db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run("branch", "main");
    db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run("ledger_seq", String(seqV2));
    db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)").run("built_at", new Date().toISOString());

    const r = dispatch(
      /** @type {any} */ ({
        action: "delta.get",
        fromVersion: `main@${seqV1}`,
        toVersion: `main@${seqV2}`,
        maxCards: 50,
      }),
      { view, versionId: `main@${seqV2}`, ledger },
    );
    assert.equal(r.ok, true);
    assert.equal(r.data.summary.added, 1, `expected 1 added, got ${r.data.summary.added}`);
    assert.equal(r.data.summary.removed, 1);
    assert.equal(r.data.summary.modified, 1);
    assert.deepEqual(r.data.summary.touchedPaths, ["a.ts", "b.ts", "c.ts"]);

    const changes = r.data.cards.map((c) => `${c.change}:${c.after?.name || c.before?.name}`);
    assert.ok(changes.includes("modified:foo"));
    assert.ok(changes.includes("removed:B"));
    assert.ok(changes.includes("added:C"));
  });

  it("pr.risk.analyze emits low severity findings for ledger signature changes", (t) => {
    const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-risk-delta-"));
    const ledger = Ledger.open({ dbPath: path.join(tmpRoot, "ledger.db") });
    const view = new View({ dbPath: path.join(tmpRoot, "view.db"), mode: "readwrite" });
    t.after(() => {
      view.close();
      ledger.close();
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch { /* Windows may hold handles briefly. */ }
    });

    const beforeSource = "function risky() {}\n";
    const afterSource = "function risky(input) {}\n";
    const beforeHash = sha256Hex(beforeSource);
    const afterHash = sha256Hex(afterSource);
    ledger.ingestBlob({
      content_hash: beforeHash,
      lang: "ts",
      byte_size: beforeSource.length,
      symbols: [{
        content_hash: beforeHash,
        local_id: 0,
        kind: "function",
        name: "risky",
        qualified_name: null,
        parent_local_id: null,
        repo_rel_path: "src/risky.ts",
        lang: "ts",
        range_start: 0,
        range_end: beforeSource.length,
        signature_hash: sha256Hex("risky()"),
        visibility: null,
        doc: null,
      }],
      edges: [],
    });
    ledger.ingestBlob({
      content_hash: afterHash,
      lang: "ts",
      byte_size: afterSource.length,
      symbols: [{
        content_hash: afterHash,
        local_id: 0,
        kind: "function",
        name: "risky",
        qualified_name: null,
        parent_local_id: null,
        repo_rel_path: "src/risky.ts",
        lang: "ts",
        range_start: 0,
        range_end: afterSource.length,
        signature_hash: sha256Hex("risky(input)"),
        visibility: null,
        doc: null,
      }],
      edges: [],
    });
    ledger.append({
      branch: "main",
      op: "add",
      repo_rel_path: "src/risky.ts",
      before_content_hash: null,
      after_content_hash: beforeHash,
    });
    const fromSeq = ledger.headSeq("main");
    ledger.append({
      branch: "main",
      op: "modify",
      repo_rel_path: "src/risky.ts",
      before_content_hash: beforeHash,
      after_content_hash: afterHash,
    });
    const toSeq = ledger.headSeq("main");

    const result = dispatch(
      /** @type {any} */ ({
        action: "pr.risk.analyze",
        fromVersion: `main@${fromSeq}`,
        toVersion: `main@${toSeq}`,
        riskThreshold: 25,
      }),
      { view, versionId: `main@${toSeq}`, ledger },
    );
    assert.equal(result.ok, true);
    assert.ok(result.data.findings.some(
      (finding) => finding.severity === "low" && finding.category === "signature_change",
    ));
  });
});
