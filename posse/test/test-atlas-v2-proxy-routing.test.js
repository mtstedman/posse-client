// test/test-atlas-v2-proxy-routing.test.js
//
// Verifies the ATLAS v2 cutover wiring inside the deterministic-MCP
// `atlas-proxy`. The high-level routing flow (mode + view availability +
// dispatch + envelope conversion) is exercised end-to-end against a
// small real ledger + main view. Mocking out the legacy upstream
// would shortcut the whole point, so we just don't configure it —
// `_executeV2Call` reads from the ledger/view independently.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { isUsearchAvailable, usearchUnavailableReason } from "../lib/domains/atlas/classes/v2/EmbeddingIndex.js";
import { ingestView } from "../lib/domains/atlas/functions/v2/embeddings/ingest.js";
import { openEmbeddingResources } from "../lib/domains/atlas/functions/v2/embeddings/resources.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { ledgerDbPath, mainViewPath, worktreeViewPath } from "../lib/domains/atlas/functions/v2/runtime-paths.js";
import {
  configureAtlasProxy,
  forwardAtlasCall,
  getAtlasToolSchemas,
  __testV2Helpers,
} from "../lib/domains/integrations/functions/deterministic-mcp/atlas-proxy.js";
import { executeEmbeddedAtlasTool } from "../lib/domains/integrations/functions/atlas-embedded.js";
import { getAtlasIntegrationConfig } from "../lib/domains/integrations/functions/atlas.js";

const {
  resolveAction,
  envelopeToMcp,
  executeV2Call,
  effectiveAtlasV2Mode,
  isDedupeEligible,
  isV2BlockingAction,
  atlasV2ViewWaitMs,
} = __testV2Helpers;

const skipIfNoUsearch = isUsearchAvailable()
  ? undefined
  : `usearch not available: ${usearchUnavailableReason() ?? "missing"}`;

function hashOf(s) { return sha256Hex(Buffer.from(s)); }

describe("ATLAS v2 proxy routing — _resolveV2Action", () => {
  it("strips 'atlas.' and 'atlas_' prefixes and recovers case-folded actions", () => {
    assert.equal(resolveAction("atlas.repo.status"), "repo.status");
    assert.equal(resolveAction("repo.status"), "repo.status");
    assert.equal(resolveAction("atlas_repo_status"), "repo.status");
    // Provider-flat naming arrives lowercase; we recover the canonical case.
    assert.equal(resolveAction("atlas.code.getskeleton"), "code.getSkeleton");
    assert.equal(resolveAction("atlas_symbol_getcard"), "symbol.getCard");
  });

  it("returns null for unknown actions", () => {
    assert.equal(resolveAction("atlas.nope"), null);
    assert.equal(resolveAction(""), null);
    assert.equal(resolveAction(null), null);
  });
});

describe("ATLAS v2 proxy routing — _v2EnvelopeToMcp", () => {
  it("wraps a successful envelope's data into MCP text content", () => {
    const out = envelopeToMcp({
      ok: true,
      action: "repo.status",
      versionId: "v1",
      data: { foo: 1, bar: [2, 3] },
    });
    assert.equal(out.ok, true);
    assert.equal(out.result.isError, false);
    const parsed = JSON.parse(out.result.content[0].text);
    assert.deepEqual(parsed, { foo: 1, bar: [2, 3] });
  });

  it("converts an error envelope into the MCP error payload shape", () => {
    const out = envelopeToMcp({
      ok: false,
      action: "repo.status",
      versionId: "v1",
      error: { code: "broken", message: "something broke", details: { status: "denied", auditHash: "abc123" } },
    });
    assert.equal(out.ok, false);
    assert.equal(out.result.isError, true);
    assert.match(out.result.content[0].text, /something broke/);
    assert.equal(out.result.structuredContent.error.details.auditHash, "abc123");
    assert.equal(out.result._meta.atlasError.details.status, "denied");
  });

  it("handles missing envelope cleanly", () => {
    const out = envelopeToMcp(null);
    assert.equal(out.ok, false);
    assert.equal(out.result.isError, true);
  });
});

describe("ATLAS v2 proxy routing — gateway action safety", () => {
  it("dedupes gateway calls by effective inner read-only action only", () => {
    assert.equal(isDedupeEligible("atlas.repo", { gatewayAction: "policy.get" }), true);
    assert.equal(isDedupeEligible("atlas.repo", {}), true);
    assert.equal(isDedupeEligible("atlas.query", {}), true);
    assert.equal(isDedupeEligible("atlas.code", {}), true);
    assert.equal(isDedupeEligible("atlas.agent", {}), true);
    assert.equal(isDedupeEligible("atlas.repo", { gatewayAction: "policy.set" }), false);
    assert.equal(isDedupeEligible("atlas.repo", { action: "scip.ingest" }), false);
    assert.equal(isDedupeEligible("atlas.agent", { action: "memory.query" }), true);
    assert.equal(isDedupeEligible("atlas.agent", { action: "memory.store" }), false);
  });

  it("treats gateway actionName aliases as blocking when they mutate ATLAS state", () => {
    assert.equal(isV2BlockingAction("agent", { actionName: "memory.store" }), true);
    assert.equal(isV2BlockingAction("repo", { actionName: "policy.set" }), true);
    assert.equal(isV2BlockingAction("repo", { actionName: "policy.get" }), false);
    assert.equal(isV2BlockingAction("repo", {}), false);
    assert.equal(isV2BlockingAction("agent", {}), false);
  });

  it("defaults v2 view wait to 2500ms when no wait is configured", () => {
    configureAtlasProxy({ transport: "v2", repoRoot: process.cwd() });
    assert.equal(atlasV2ViewWaitMs(), 2500);
    configureAtlasProxy({ transport: "v2", repoRoot: process.cwd(), viewWaitMs: 0 });
    assert.equal(atlasV2ViewWaitMs(), 0);
  });
});

describe("ATLAS v2 proxy routing — _executeV2Call end-to-end", () => {
  /** @type {string} */
  let tmpRepo;
  before(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-proxy-route-"));

    // Seed a minimal ledger + main view so dispatch has something real.
    const ledPath = ledgerDbPath(tmpRepo);
    fs.mkdirSync(path.dirname(ledPath), { recursive: true });
    const led = Ledger.open({ dbPath: ledPath });
    try {
      const content = "function hello() { return 1; }";
      fs.mkdirSync(path.join(tmpRepo, "src"), { recursive: true });
      fs.writeFileSync(path.join(tmpRepo, "src", "hello.ts"), content, "utf8");
      const hash = hashOf(content);
      led.ingestBlob({
        content_hash: hash, lang: "ts", byte_size: content.length,
        symbols: [{
          content_hash: hash, local_id: 0,
          kind: "function", name: "hello", qualified_name: "hello",
          parent_local_id: null, repo_rel_path: "src/hello.ts", lang: "ts",
          range_start: 0, range_end: content.length,
          signature_hash: sha256Hex("hello()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: "main", op: "add", repo_rel_path: "src/hello.ts",
        before_content_hash: null, after_content_hash: hash,
      });
      const viewPath = mainViewPath(tmpRepo);
      fs.mkdirSync(path.dirname(viewPath), { recursive: true });
      new ViewBuilder().buildFrom({
        ledger: led, branch: "main", atSeq: led.headSeq("main"), outPath: viewPath,
      });
    } finally {
      led.close();
    }

    configureAtlasProxy({ transport: "v2", cwd: tmpRepo });
  });
  after(() => {
    configureAtlasProxy({});
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); }
    catch { /* windows lock lag */ }
  });

  it("dispatches atlas.repo.status and returns an MCP-shaped result with real data", async () => {
    const outcome = await executeV2Call("atlas.repo.status", {});
    assert.ok(outcome, "v2 call should succeed when ledger + view are present");
    assert.equal(outcome.ok, true, `expected ok; got errorMsg=${outcome.errorMsg}`);
    assert.equal(outcome.result.isError, false);
    const parsed = JSON.parse(outcome.result.content[0].text);
    assert.equal(parsed.indexedSymbols, 1);
    assert.equal(parsed.indexedFiles, 1);
    assert.ok(parsed.languages.includes("ts"));
  });

  it("initializes in v2-native transport without a sidecar command", async () => {
    configureAtlasProxy({ transport: "v2", cwd: tmpRepo });
    const schemas = await getAtlasToolSchemas();
    assert.ok(schemas.some((schema) => schema.name === "atlas.repo.overview"));
    assert.ok(schemas.some((schema) => schema.name === "atlas.symbol.search"));
    assert.equal(schemas.some((schema) => schema.name === "atlas.repo.status"), false);
    assert.equal(schemas.some((schema) => schema.name === "atlas.file.write"), false);
    const outcome = await executeV2Call("atlas.repo.status", {});
    assert.ok(outcome);
    assert.equal(outcome.ok, true);
  });

  it("executes repo.register through v2 before a view exists", async () => {
    const coldRepo = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-proxy-cold-"));
    try {
      configureAtlasProxy({ transport: "v2", cwd: coldRepo });
      const outcome = await executeV2Call("atlas.repo.register", { repoId: "cold-proxy" });
      assert.ok(outcome);
      assert.equal(outcome.ok, true, outcome.errorMsg || "");
      const parsed = JSON.parse(outcome.result.content[0].text);
      assert.equal(parsed.repoId, "cold-proxy");
      assert.equal(parsed.createdLedger, true);
      assert.equal(parsed.createdView, true);
      assert.equal(fs.existsSync(ledgerDbPath(coldRepo)), true);
      assert.equal(fs.existsSync(mainViewPath(coldRepo)), true);
    } finally {
      configureAtlasProxy({ transport: "v2", cwd: tmpRepo });
      fs.rmSync(coldRepo, { recursive: true, force: true });
    }
  });

  it("does not enter dual/parity mode when native v2 transport is configured", async () => {
    configureAtlasProxy({ transport: "v2", cwd: tmpRepo, atlasV2Mode: "preferred" });
    assert.equal(effectiveAtlasV2Mode(), "on");
    const out = await forwardAtlasCall({ toolName: "atlas.repo.status", args: {} });
    assert.equal(out.isError, false);
    const parsed = JSON.parse(out.content[0].text);
    assert.equal(parsed.indexedSymbols, 1);

    configureAtlasProxy({ transport: "v2", cwd: tmpRepo, atlasV2Mode: "required" });
    assert.equal(effectiveAtlasV2Mode(), "required");
  });

  it("coerces path-like symbolId arguments before v2 dispatch", async () => {
    configureAtlasProxy({ transport: "v2", cwd: tmpRepo });
    const out = await forwardAtlasCall({
      toolName: "atlas.code.getSkeleton",
      args: { symbolId: "src/hello.ts" },
    });
    assert.equal(out.isError, false);
    const parsed = JSON.parse(out.content[0].text);
    assert.equal(parsed.repo_rel_path, "src/hello.ts");
    assert.match(parsed.content, /function hello/);
  });

  it("normalizes path aliases for v2 code hot-path calls", async () => {
    configureAtlasProxy({ transport: "v2", cwd: tmpRepo });
    const out = await forwardAtlasCall({
      toolName: "atlas.code.getHotPath",
      args: { path: "src/hello.ts", identifiersToFind: "hello,missing" },
    });
    assert.equal(out.isError, false);
    const parsed = JSON.parse(out.content[0].text);
    assert.equal(parsed.repo_rel_path, "src/hello.ts");
    assert.ok(parsed.identifiersFound.includes("hello"));
    assert.ok(parsed.identifiersMissing.includes("missing"));
    assert.equal(parsed.symbolId, undefined);
  });

  it("returns null when the action is unknown so the caller can fall back", async () => {
    const outcome = await executeV2Call("atlas.not_a_real_tool", {});
    assert.equal(outcome, null);
  });

  it("preserves runtime denial details through MCP and embedded v2 transports", async () => {
    const outcome = await executeV2Call("atlas.runtime.execute", {
      repoId: "fixture",
      runtime: "node",
      args: ["-e", "console.log('blocked')"],
    });
    assert.ok(outcome);
    assert.equal(outcome.ok, false);
    assert.equal(outcome.result.structuredContent.error.code, "runtime_disabled");
    assert.equal(outcome.result.structuredContent.error.details.status, "denied");
    assert.ok(outcome.result.structuredContent.error.details.policyDecision.auditHash);

    const embedded = await executeEmbeddedAtlasTool("runtime.execute", {
      repoId: "fixture",
      runtime: "node",
      args: ["-e", "console.log('blocked')"],
    }, {
      cwd: tmpRepo,
      config: {
        enabled: true,
        mode: "preferred",
        normalizedMode: "on",
        atlasV2Mode: "v2",
        requestedRepoPath: tmpRepo,
        requestedRepoId: "fixture",
      },
      execFileImpl: () => {
        throw new Error("external ATLAS process should not spawn");
      },
    });
    assert.match(embedded, /runtime_disabled/);
    assert.match(embedded, /auditHash/);
    assert.match(embedded, /"status": "denied"/);
  });

  it("routes runtime.execute on a cold repo without requiring a mounted view", async () => {
    const coldRepo = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-runtime-cold-"));
    try {
      configureAtlasProxy({ transport: "v2", cwd: coldRepo, viewWaitMs: 0 });
      const outcome = await executeV2Call("atlas.runtime.execute", {
        repoId: "fixture",
        runtime: "node",
        args: ["-e", "console.log('blocked')"],
      });
      assert.ok(outcome);
      assert.equal(outcome.ok, false);
      assert.equal(outcome.result.structuredContent.error.code, "runtime_disabled");

      const embedded = await executeEmbeddedAtlasTool("runtime.execute", {
        repoId: "fixture",
        runtime: "node",
        args: ["-e", "console.log('blocked')"],
      }, {
        cwd: coldRepo,
        config: {
          enabled: true,
          mode: "preferred",
          normalizedMode: "on",
          atlasV2Mode: "v2",
          requestedRepoPath: coldRepo,
          requestedRepoId: "fixture",
          viewWaitMs: 0,
        },
        execFileImpl: () => {
          throw new Error("external ATLAS process should not spawn");
        },
      });
      assert.match(embedded, /runtime_disabled/);
      assert.doesNotMatch(embedded, /view is not available/);
    } finally {
      configureAtlasProxy({});
      fs.rmSync(coldRepo, { recursive: true, force: true });
    }
  });

  it("routes embedded ATLAS calls through v2 without spawning an external process", async () => {
    const out = await executeEmbeddedAtlasTool("repo.status", {}, {
      cwd: tmpRepo,
      config: {
        enabled: true,
        mode: "preferred",
        normalizedMode: "on",
        atlasV2Mode: "v2",
        requestedRepoPath: tmpRepo,
        requestedRepoId: "fixture",
      },
      execFileImpl: () => {
        throw new Error("external ATLAS process should not spawn");
      },
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.indexedSymbols, 1);
  });

  it("routes embedded ATLAS v2 when atlas_mode is off but atlas_v2 is on", async () => {
    const config = getAtlasIntegrationConfig({
      POSSE_ATLAS_MODE: "off",
      POSSE_ATLAS_V2: "v2",
      POSSE_ATLAS_REPO_PATH: tmpRepo,
      POSSE_ATLAS_REPO_ID: "fixture",
    });
    assert.equal(config.enabled, true);
    assert.equal(config.normalizedMode, "on");

    const out = await executeEmbeddedAtlasTool("repo.status", {}, {
      cwd: tmpRepo,
      config,
      execFileImpl: () => {
        throw new Error("external ATLAS process should not spawn");
      },
    });
    const parsed = JSON.parse(out);
    assert.equal(parsed.indexedSymbols, 1);
  });

  it("uses the resolved repo branch for optional embedded v2 calls without a view", async () => {
    const branchRepo = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-embedded-branch-"));
    try {
      execFileSync("git", ["init", "-b", "feature/foo"], { cwd: branchRepo, stdio: "ignore" });
      execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: branchRepo, stdio: "ignore" });
      execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: branchRepo, stdio: "ignore" });
      fs.writeFileSync(path.join(branchRepo, "README.md"), "base\n", "utf8");
      execFileSync("git", ["add", "README.md"], { cwd: branchRepo, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], { cwd: branchRepo, stdio: "ignore" });

      const led = Ledger.open({ dbPath: ledgerDbPath(branchRepo) });
      led.close();
      const out = await executeEmbeddedAtlasTool("memory.store", {
        type: "decision",
        title: "branch probe",
        content: "record the resolved branch version",
      }, {
        cwd: branchRepo,
        config: {
          enabled: true,
          mode: "preferred",
          normalizedMode: "on",
          atlasV2Mode: "v2",
          requestedRepoPath: branchRepo,
          requestedRepoId: "branch-fixture",
        },
        execFileImpl: () => {
          throw new Error("external ATLAS process should not spawn");
        },
      });
      const parsed = JSON.parse(out);
      assert.equal(parsed.ok, true);

      const inspect = Ledger.open({ dbPath: ledgerDbPath(branchRepo) });
      try {
        const row = inspect._unsafeDb().prepare(
          "SELECT version_id FROM usage_events WHERE action = 'memory.store' ORDER BY id DESC LIMIT 1",
        ).get();
        assert.equal(row.version_id, "feature/foo@0");
      } finally {
        inspect.close();
      }
    } finally {
      fs.rmSync(branchRepo, { recursive: true, force: true });
    }
  });

  it("wires semantic search resources through the v2 proxy path", { skip: skipIfNoUsearch }, async () => {
    const view = View.mount({ dbPath: mainViewPath(tmpRepo), mode: "readonly" });
    const resources = openEmbeddingResources({
      repoRoot: tmpRepo,
      config: { embeddingProvider: "stub" },
    });
    try {
      assert.equal(resources.enabled, true, resources.reason || "");
      await ingestView({
        view,
        index: /** @type {any} */ (resources.index),
        encoder: /** @type {any} */ (resources.encoder),
      });
    } finally {
      await resources.close();
      view.close();
    }

    configureAtlasProxy({
      transport: "v2",
      cwd: tmpRepo,
      // Semantic dispatch is opt-in (see lib/.../embeddings/resources.js
      // semanticDispatchEnabled). This test exercises the opt-in path, so we
      // explicitly enables semantic dispatch in addition to providing an
      // embedding provider.
      semanticEnabled: true,
      embeddingProvider: "stub",
    });
    const outcome = await executeV2Call("atlas.symbol.search", {
      query: "hello",
      semantic: true,
      limit: 5,
    });
    assert.ok(outcome);
    assert.equal(outcome.ok, true, outcome.errorMsg || "");
    const parsed = JSON.parse(outcome.result.content[0].text);
    assert.ok(parsed.items.some((item) => item.name === "hello"));
    assert.equal(parsed._meta?.semantic?.available, true);
    assert.equal(parsed._meta?.semantic?.provider, "posse-stub-hash");
  });
});

describe("ATLAS v2 proxy routing — worktree-mounted view", () => {
  /** @type {string} */
  let tmpRepo;
  /** @type {string} */
  let worktree;
  before(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-proxy-wt-repo-"));
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-proxy-wt-"));
    const led = Ledger.open({ dbPath: ledgerDbPath(tmpRepo) });
    try {
      const baseContent = "function baseOnly() { return 1; }";
      const wtContent = "function worktreeOnly() { return 2; }";
      const baseHash = hashOf(baseContent);
      const wtHash = hashOf(wtContent);
      led.ingestBlob({
        content_hash: baseHash, lang: "ts", byte_size: baseContent.length,
        symbols: [{
          content_hash: baseHash, local_id: 0,
          kind: "function", name: "baseOnly", qualified_name: "baseOnly",
          parent_local_id: null, repo_rel_path: "src/base.ts", lang: "ts",
          range_start: 0, range_end: baseContent.length,
          signature_hash: sha256Hex("baseOnly()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      led.ingestBlob({
        content_hash: wtHash, lang: "ts", byte_size: wtContent.length,
        symbols: [{
          content_hash: wtHash, local_id: 0,
          kind: "function", name: "worktreeOnly", qualified_name: "worktreeOnly",
          parent_local_id: null, repo_rel_path: "src/worktree.ts", lang: "ts",
          range_start: 0, range_end: wtContent.length,
          signature_hash: sha256Hex("worktreeOnly()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: "main", op: "add", repo_rel_path: "src/base.ts",
        before_content_hash: null, after_content_hash: baseHash,
      });
      led.forkBranch("wi-1", "main", led.headSeq("main"));
      led.append({
        branch: "wi-1", op: "add", repo_rel_path: "src/worktree.ts",
        before_content_hash: null, after_content_hash: wtHash,
      });
      fs.mkdirSync(path.dirname(worktreeViewPath(worktree)), { recursive: true });
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "wi-1",
        atSeq: led.headSeq("wi-1"),
        outPath: worktreeViewPath(worktree),
        options: { repoRoot: tmpRepo },
      });
    } finally {
      led.close();
    }
    configureAtlasProxy({ transport: "v2", cwd: worktree });
  });
  after(() => {
    configureAtlasProxy({});
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("uses the mounted worktree view instead of main.view.db", async () => {
    const outcome = await executeV2Call("atlas.symbol.search", { query: "worktreeOnly", limit: 5 });
    assert.ok(outcome);
    assert.equal(outcome.ok, true, `expected ok; got errorMsg=${outcome.errorMsg}`);
    const parsed = JSON.parse(outcome.result.content[0].text);
    assert.ok(JSON.stringify(parsed).includes("worktreeOnly"));
  });

  it("does not let an incomplete worktree-local ledger poison the mounted WI view", async () => {
    const localLedger = Ledger.open({ dbPath: ledgerDbPath(worktree) });
    try {
      localLedger.ensureRootBranch("master");
      assert.equal(localLedger.getBranch("wi-1"), null);
    } finally {
      localLedger.close();
    }

    const outcome = await executeV2Call("atlas.symbol.search", { query: "worktreeOnly", limit: 5 });
    assert.ok(outcome);
    assert.equal(outcome.ok, true, `expected ok; got errorMsg=${outcome.errorMsg}`);
    const parsed = JSON.parse(outcome.result.content[0].text);
    assert.ok(JSON.stringify(parsed).includes("worktreeOnly"));
  });
});

describe("ATLAS v2 proxy routing — stale main view refresh queue", () => {
  it("queues one async refresh worker and lets concurrent readers await the current view", async () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-proxy-refresh-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: tmpRepo, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, "README.md"), "base\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmpRepo, stdio: "ignore" });
    const ledger = Ledger.open({ dbPath: ledgerDbPath(tmpRepo) });
    const logs = [];
    try {
      fs.mkdirSync(path.join(tmpRepo, "src"), { recursive: true });
      const baseContent = "export function baseReady() { return 1; }\n";
      const freshContent = "export function queuedFresh() { return 2; }\n";
      fs.writeFileSync(path.join(tmpRepo, "src", "base.ts"), baseContent, "utf8");
      fs.writeFileSync(path.join(tmpRepo, "src", "fresh.ts"), freshContent, "utf8");
      const baseHash = hashOf(baseContent);
      const freshHash = hashOf(freshContent);
      ledger.ingestBlob({
        content_hash: baseHash, lang: "ts", byte_size: baseContent.length,
        symbols: [{
          content_hash: baseHash, local_id: 0,
          kind: "function", name: "baseReady", qualified_name: "baseReady",
          parent_local_id: null, repo_rel_path: "src/base.ts", lang: "ts",
          range_start: 0, range_end: baseContent.length,
          signature_hash: sha256Hex("baseReady()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      ledger.append({
        branch: "main", op: "add", repo_rel_path: "src/base.ts",
        before_content_hash: null, after_content_hash: baseHash,
      });
      new ViewBuilder().buildFrom({
        ledger,
        branch: "main",
        atSeq: ledger.headSeq("main"),
        outPath: mainViewPath(tmpRepo),
        options: { repoRoot: tmpRepo },
      });

      ledger.ingestBlob({
        content_hash: freshHash, lang: "ts", byte_size: freshContent.length,
        symbols: [{
          content_hash: freshHash, local_id: 0,
          kind: "function", name: "queuedFresh", qualified_name: "queuedFresh",
          parent_local_id: null, repo_rel_path: "src/fresh.ts", lang: "ts",
          range_start: 0, range_end: freshContent.length,
          signature_hash: sha256Hex("queuedFresh()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      ledger.append({
        branch: "main", op: "add", repo_rel_path: "src/fresh.ts",
        before_content_hash: null, after_content_hash: freshHash,
      });
      assert.equal(ledger.headSeq("main"), 2);
      ledger.close();

      configureAtlasProxy({
        transport: "v2",
        cwd: tmpRepo,
        viewWaitMs: 5000,
        logger: (entry) => logs.push(entry),
      });

      const [first, second] = await Promise.all([
        executeV2Call("atlas.symbol.search", { query: "queuedFresh", limit: 5 }),
        executeV2Call("atlas.symbol.search", { query: "queuedFresh", limit: 5 }),
      ]);
      for (const outcome of [first, second]) {
        assert.ok(outcome);
        assert.equal(outcome.ok, true, outcome.errorMsg || "");
        const parsed = JSON.parse(outcome.result.content[0].text);
        assert.ok(parsed.items.some((item) => item.name === "queuedFresh"));
      }
      // The coalescing guarantee: two concurrent stale reads trigger exactly
      // one refresh between them (the queue keys on branch+view+head, and a
      // settled entry is retained until a newer head supersedes it).
      assert.equal(logs.filter((entry) => entry.event === "atlas_v2_auto_refresh_queued").length, 1);
      assert.equal(logs.filter((entry) => entry.event === "atlas_v2_auto_refresh_completed" && entry.ok).length, 1);
      // The second reader is served by that single refresh without spawning its
      // own — either by joining it in flight or by observing the view it
      // produced. Which path it takes depends on scheduler timing, so assert it
      // never started a competing refresh rather than requiring a join event.
      assert.equal(logs.filter((entry) => entry.event === "atlas_v2_auto_refresh_joined").length <= 1, true);
    } finally {
      configureAtlasProxy({});
      try { ledger.close(); } catch { /* already closed in the happy path */ }
      try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it("refreshes the main view for the current branch after a branch switch", async () => {
    const tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-proxy-branch-refresh-"));
    execFileSync("git", ["init", "-b", "main"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "posse-test@example.com"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Posse Test"], { cwd: tmpRepo, stdio: "ignore" });
    fs.writeFileSync(path.join(tmpRepo, "README.md"), "base\n", "utf8");
    execFileSync("git", ["add", "README.md"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: tmpRepo, stdio: "ignore" });
    execFileSync("git", ["checkout", "-b", "feature/x"], { cwd: tmpRepo, stdio: "ignore" });
    const ledger = Ledger.open({ dbPath: ledgerDbPath(tmpRepo) });
    const logs = [];
    try {
      fs.mkdirSync(path.join(tmpRepo, "src"), { recursive: true });
      const baseContent = "export function mainOnly() { return 1; }\n";
      const featureContent = "export function featureOnly() { return 2; }\n";
      fs.writeFileSync(path.join(tmpRepo, "src", "main.ts"), baseContent, "utf8");
      fs.writeFileSync(path.join(tmpRepo, "src", "feature.ts"), featureContent, "utf8");
      const baseHash = hashOf(baseContent);
      const featureHash = hashOf(featureContent);
      ledger.ingestBlob({
        content_hash: baseHash, lang: "ts", byte_size: baseContent.length,
        symbols: [{
          content_hash: baseHash, local_id: 0,
          kind: "function", name: "mainOnly", qualified_name: "mainOnly",
          parent_local_id: null, repo_rel_path: "src/main.ts", lang: "ts",
          range_start: 0, range_end: baseContent.length,
          signature_hash: sha256Hex("mainOnly()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      ledger.ingestBlob({
        content_hash: featureHash, lang: "ts", byte_size: featureContent.length,
        symbols: [{
          content_hash: featureHash, local_id: 0,
          kind: "function", name: "featureOnly", qualified_name: "featureOnly",
          parent_local_id: null, repo_rel_path: "src/feature.ts", lang: "ts",
          range_start: 0, range_end: featureContent.length,
          signature_hash: sha256Hex("featureOnly()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      ledger.append({
        branch: "main", op: "add", repo_rel_path: "src/main.ts",
        before_content_hash: null, after_content_hash: baseHash,
      });
      new ViewBuilder().buildFrom({
        ledger,
        branch: "main",
        atSeq: ledger.headSeq("main"),
        outPath: mainViewPath(tmpRepo),
        options: { repoRoot: tmpRepo },
      });
      ledger.forkBranch("feature/x", "main", ledger.headSeq("main"));
      ledger.append({
        branch: "feature/x", op: "add", repo_rel_path: "src/feature.ts",
        before_content_hash: null, after_content_hash: featureHash,
      });
      ledger.close();

      configureAtlasProxy({
        transport: "v2",
        cwd: tmpRepo,
        viewWaitMs: 5000,
        logger: (entry) => logs.push(entry),
      });

      const outcome = await executeV2Call("atlas.symbol.search", { query: "featureOnly", limit: 5 });
      assert.ok(outcome);
      assert.equal(outcome.ok, true, outcome.errorMsg || "");
      const parsed = JSON.parse(outcome.result.content[0].text);
      assert.ok(parsed.items.some((item) => item.name === "featureOnly"));
      assert.ok(logs.some((entry) => entry.event === "atlas_v2_view_branch_mismatch"));
      assert.ok(logs.some((entry) => entry.event === "atlas_v2_auto_refresh_queued"));
    } finally {
      configureAtlasProxy({});
      try { ledger.close(); } catch { /* already closed on the happy path */ }
      try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

describe("ATLAS v2 proxy routing — invalid worktree view", () => {
  /** @type {string} */
  let tmpRepo;
  /** @type {string} */
  let worktree;

  before(() => {
    tmpRepo = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-proxy-invalid-view-"));
    worktree = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-proxy-invalid-wt-"));
    const ledgerPath = ledgerDbPath(tmpRepo);
    fs.mkdirSync(path.dirname(ledgerPath), { recursive: true });
    const led = Ledger.open({ dbPath: ledgerPath });
    try {
      const baseContent = "export function mainOnly() { return 1; }\n";
      const baseHash = sha256Hex(baseContent);
      led.ingestBlob({
        content_hash: baseHash, lang: "ts", byte_size: baseContent.length,
        symbols: [{
          content_hash: baseHash, local_id: 0,
          kind: "function", name: "mainOnly", qualified_name: "mainOnly",
          parent_local_id: null, repo_rel_path: "src/main.ts", lang: "ts",
          range_start: 0, range_end: baseContent.length,
          signature_hash: sha256Hex("mainOnly()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: "main", op: "add", repo_rel_path: "src/main.ts",
        before_content_hash: null, after_content_hash: baseHash,
      });
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: mainViewPath(tmpRepo),
        options: { repoRoot: tmpRepo },
      });
      fs.mkdirSync(path.dirname(worktreeViewPath(worktree)), { recursive: true });
      fs.writeFileSync(worktreeViewPath(worktree), "not a sqlite view", "utf8");
    } finally {
      led.close();
    }
    configureAtlasProxy({
      transport: "v2",
      cwd: worktree,
      repoRoot: tmpRepo,
      viewWaitMs: 10,
    });
  });

  after(() => {
    configureAtlasProxy({});
    try { fs.rmSync(tmpRepo, { recursive: true, force: true }); } catch { /* ignore */ }
    try { fs.rmSync(worktree, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it("waits on an invalid mounted view instead of falling back to main", async () => {
    const outcome = await executeV2Call("atlas.symbol.search", { query: "mainOnly", limit: 5 });
    assert.ok(outcome);
    assert.equal(outcome.ok, false);
    assert.match(outcome.errorMsg || "", /view is not current after 10ms|view is not ready|no such table/i);
  });

  it("runs lifecycle actions against the configured repo root, not the worktree cwd", async () => {
    const outcome = await executeV2Call("atlas.repo.register", { repoId: "primary" });
    assert.ok(outcome);
    assert.equal(outcome.ok, true, outcome.errorMsg || "");
    const parsed = JSON.parse(outcome.result.content[0].text);
    assert.equal(parsed.repoRoot, tmpRepo);
    assert.equal(fs.existsSync(ledgerDbPath(worktree)), false);
  });
});

describe("ATLAS v2 proxy routing — _executeV2Call missing backend", () => {
  /** @type {string} */
  let tmpRepoNoLedger;
  before(() => {
    tmpRepoNoLedger = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-proxy-noledger-"));
    configureAtlasProxy({ command: "noop", cwd: tmpRepoNoLedger });
  });
  after(() => {
    configureAtlasProxy({});
    try { fs.rmSync(tmpRepoNoLedger, { recursive: true, force: true }); }
    catch { /* ignore */ }
  });

  it("returns null when the ledger doesn't exist and the v2 proxy is not configured", async () => {
    const outcome = await executeV2Call("atlas.repo.status", {});
    assert.equal(outcome, null);
  });
});
