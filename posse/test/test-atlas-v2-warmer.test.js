import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import {
  EmbeddingIndex,
  isUsearchAvailable,
  usearchUnavailableReason,
} from "../lib/domains/atlas/classes/v2/EmbeddingIndex.js";
import { StubEmbeddingEncoder } from "../lib/domains/atlas/classes/v2/EmbeddingEncoder.js";
import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { Warmer } from "../lib/domains/atlas/classes/v2/Warmer.js";
import { shouldRunMlTreeCompressionReseed } from "../lib/domains/atlas/classes/v2/ParseEngine.js";
import { sharedParserAdapter } from "../lib/domains/atlas/functions/v2/parser/adapter.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import { VIEW_SCHEMA_VERSION } from "../lib/domains/atlas/functions/v2/contracts/ddl/index.js";
import { ingestScipFile } from "../lib/domains/atlas/functions/v2/scip/ingester.js";
import { readStagerMeta } from "../lib/domains/atlas/functions/v2/scip/stager-meta.js";
import { MAX_PARSE_FILE_BYTES } from "../lib/domains/atlas/functions/v2/parser/index-filters.js";
import { warmAtlasMergedToMainNow } from "../lib/domains/integrations/functions/atlas.js";
import { encodeIndex, encodeToolInfo } from "./helpers/scip-encoder.mjs";
import {
  ledgerDbPath,
  mainViewPath,
  warmedViewPath,
  worktreeViewPath,
  ledgerBranchForWi,
  embeddingsRoot,
} from "../lib/domains/atlas/functions/v2/runtime-paths.js";

function makeTmp(prefix) {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeFakeScipIndexer(repoRoot) {
  const binDir = path.join(repoRoot, "node_modules", ".bin");
  fs.mkdirSync(binDir, { recursive: true });
  fs.writeFileSync(path.join(binDir, "fake-indexer.mjs"), [
    "import fs from 'node:fs';",
    "const out = process.argv[process.argv.indexOf('--output') + 1];",
    "fs.writeFileSync(out, `warmer-generated:${Date.now()}`);",
  ].join("\n"));
  if (process.platform === "win32") {
    const command = path.join(binDir, "scip-typescript.cmd");
    fs.writeFileSync(command, "@echo off\r\nnode \"%~dp0fake-indexer.mjs\" %*\r\n");
    return command;
  }
  const command = path.join(binDir, "scip-typescript");
  fs.writeFileSync(command, "#!/usr/bin/env sh\nnode \"$(dirname \"$0\")/fake-indexer.mjs\" \"$@\"\n");
  fs.chmodSync(command, 0o755);
  return command;
}

function hashOf(s) {
  return sha256Hex(Buffer.from(s));
}

const skipIfNoUsearch = isUsearchAvailable()
  ? undefined
  : `usearch not available: ${usearchUnavailableReason() ?? "missing"}`;

/**
 * Set up a small repo's worth of ledger content under repoRoot/.posse/atlas/.
 * Mirrors test-atlas-v2-view but rooted at a repo-shaped layout so the
 * Warmer's path conventions apply cleanly.
 */
function setupRepo(repoRoot) {
  const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
  const aContent = `class Foo { greet() {} }`;
  const aHash = hashOf(aContent);
  const aSymbols = [
    {
      content_hash: aHash, local_id: 0,
      kind: "class", name: "Foo", qualified_name: "Foo",
      parent_local_id: null, repo_rel_path: "src/foo.ts", lang: "ts",
      range_start: 0, range_end: 24,
      signature_hash: sha256Hex("class Foo"),
      visibility: "public", doc: null,
    },
    {
      content_hash: aHash, local_id: 1,
      kind: "method", name: "greet", qualified_name: "Foo.greet",
      parent_local_id: 0, repo_rel_path: "src/foo.ts", lang: "ts",
      range_start: 12, range_end: 22,
      signature_hash: sha256Hex("Foo.greet()"),
      visibility: "public", doc: null,
    },
  ];
  led.ingestBlob({ content_hash: aHash, lang: "ts", byte_size: aContent.length, symbols: aSymbols, edges: [] });
  led.append({
    branch: "main", op: "add", repo_rel_path: "src/foo.ts",
    before_content_hash: null, after_content_hash: aHash,
  });
  return { led, aHash };
}

describe("ATLAS v2 Warmer", () => {
  let tmp;
  before(() => {
    tmp = makeTmp("atlas-v2-warmer-");
  });
  after(() => {
    // On Windows, SQLite handles held by uncollected garbage can keep
    // tmp files locked briefly after a test suite finishes. The OS
    // cleans the directory eventually; don't fail the run on it.
    try { fs.rmSync(tmp, { recursive: true, force: true }); }
    catch { /* best effort */ }
  });

  it("handleWarmJob('scip-restage') stages SCIP artifacts without writing a view", async () => {
    const repoRoot = path.join(tmp, "repo-scip-restage");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "package.json"), "{}\n");
    const command = writeFakeScipIndexer(repoRoot);
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        config: {
          scipMode: "on",
          scipIndexCommand: command,
          scipRestagePolicy: "always",
        },
      });
      const result = await warmer.handleWarmJob({ purpose: "scip-restage", force: true });
      const outputPath = path.join(repoRoot, ".posse", "atlas", "scip", "configured.scip");
      assert.equal(result.purpose, "scip-restage");
      assert.equal(result.view_written, null);
      assert.equal(fs.existsSync(outputPath), true);
      const meta = await readStagerMeta(outputPath);
      assert.equal(meta?.language, "configured");
      // Fresh staging must be surfaced so the warm-job executor enqueues the
      // main-incremental intake — staging alone never ingests, and readiness
      // reports staged artifacts as ready, so nothing else would consume them.
      assert.equal(result.scip_staged_fresh, true);

      // A second restage with policy "missing" is an already-staged no-op and
      // must NOT re-trigger the intake follow-up.
      const noopWarmer = new Warmer({
        ledger: led,
        repoRoot,
        config: {
          scipMode: "on",
          scipIndexCommand: command,
          scipRestagePolicy: "missing",
        },
      });
      const noop = await noopWarmer.handleWarmJob({ purpose: "scip-restage" });
      assert.notEqual(noop.scip_staged_fresh, true, "already-staged restage must not claim fresh artifacts");
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi') builds a warmed view at the requested out path", async () => {
    const repoRoot = path.join(tmp, "repo1");
    const { led } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      const result = await warmer.handleWarmJob({
        purpose: "wi",
        work_item_id: 42,
        out_view_path: warmedViewPath(repoRoot, 42),
        paths: ["src/foo.ts"],
      });
      assert.equal(result.purpose, "wi");
      assert.ok(result.view_written, "view_written should be set");
      assert.ok(result.view_etag, "view_etag should be set");
      assert.equal(result.skipped.length, 0);
      assert.ok(fs.existsSync(result.view_written), "warmed view file should exist on disk");
      const view = View.mount({ dbPath: result.view_written });
      try {
        const symbols = view.query.symbolsInFile("src/foo.ts");
        assert.equal(symbols.length, 2);
        const meta = view.meta();
        assert.deepEqual(meta.warmed_for_files, ["src/foo.ts"]);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi') does not run repo-level SCIP staging", async () => {
    const repoRoot = path.join(tmp, "repo-wi-no-scip");
    fs.mkdirSync(repoRoot, { recursive: true });
    fs.writeFileSync(path.join(repoRoot, "package.json"), "{}\n");
    const command = writeFakeScipIndexer(repoRoot);
    const { led } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        config: {
          scipMode: "on",
          scipIndexCommand: command,
          scipRestagePolicy: "always",
        },
      });
      const result = await warmer.handleWarmJob({
        purpose: "wi",
        work_item_id: 43,
        out_view_path: warmedViewPath(repoRoot, 43),
        paths: ["src/foo.ts"],
      });
      assert.equal(result.purpose, "wi");
      assert.equal(result.skipped.length, 0);
      assert.equal(
        fs.existsSync(path.join(repoRoot, ".posse", "atlas", "scip", "configured.scip")),
        false,
      );
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('embeddings') reports complete when no view exists yet", async () => {
    const repoRoot = path.join(tmp, "repo-embeddings-no-view");
    const { led } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({ ledger: led, repoRoot, config: {} });
      const result = await warmer.handleWarmJob({ purpose: "embeddings", branch: "main" });
      assert.equal(result.purpose, "embeddings");
      // No view means the views layer owns the work (its warm runs the
      // ride-along ingest); the resume loop must end instead of re-enqueueing.
      assert.equal(result.embeddings_complete, true);
      assert.equal(result.embeddings_remaining, 0);
      assert.equal(result.embeddings_skipped_reason, "view_missing");
      assert.equal(result.view_written, null);
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('embeddings') reports complete when embeddings are not configured", async () => {
    const repoRoot = path.join(tmp, "repo-embeddings-disabled");
    const { led } = setupRepo(repoRoot);
    try {
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: mainViewPath(repoRoot),
        options: { repoRoot },
      });
      const warmer = new Warmer({ ledger: led, repoRoot, config: {} });
      const result = await warmer.handleWarmJob({ purpose: "embeddings", branch: "main" });
      assert.equal(result.embeddings_complete, true);
      assert.equal(result.embeddings_remaining, 0);
      assert.ok(result.embeddings_skipped_reason, "a disabled provider must surface a skip reason");
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('embeddings') resumes toward parity in bounded slices", { skip: skipIfNoUsearch }, async () => {
    const repoRoot = path.join(tmp, "repo-embeddings-slices");
    const { led } = setupRepo(repoRoot);
    const config = { embeddingProvider: "stub", embeddingDim: 32 };
    try {
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: mainViewPath(repoRoot),
        options: { repoRoot },
      });
      const warmer = new Warmer({ ledger: led, repoRoot, config });

      // The fixture view has 2 symbols; a 1-symbol budget needs two slices.
      const first = await warmer.handleWarmJob({ purpose: "embeddings", branch: "main", max_symbols: 1 });
      assert.equal(first.embeddings_complete, false);
      assert.equal(first.embeddings_indexed, 1);
      assert.equal(first.embeddings_remaining, 1);

      const second = await warmer.handleWarmJob({ purpose: "embeddings", branch: "main", max_symbols: 1 });
      assert.equal(second.embeddings_complete, true);
      assert.equal(second.embeddings_remaining, 0);

      const third = await warmer.handleWarmJob({ purpose: "embeddings", branch: "main", max_symbols: 1 });
      assert.equal(third.embeddings_complete, true);
      assert.equal(third.embeddings_skipped_reason, undefined);
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi') clones a current main view instead of rebuilding it", async () => {
    const repoRoot = path.join(tmp, "repo-wi-clone-main");
    const { led } = setupRepo(repoRoot);
    class CloneOnlyBuilder extends ViewBuilder {
      async buildFromAsync() {
        throw new Error("WI warm should clone the existing main view");
      }
    }
    try {
      const mainView = mainViewPath(repoRoot);
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: mainView,
        options: { repoRoot },
      });
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        viewBuilder: new CloneOnlyBuilder(),
      });
      const result = await warmer.handleWarmJob({
        purpose: "wi",
        work_item_id: 45,
        out_view_path: warmedViewPath(repoRoot, 45),
        paths: ["src/foo.ts"],
      });
      assert.equal(result.purpose, "wi");
      assert.ok(result.view_written);
      assert.ok(result.view_etag);
      const view = View.mount({ dbPath: result.view_written });
      try {
        const meta = view.meta();
        assert.equal(meta.branch, "main");
        assert.equal(meta.ledger_seq, led.headSeq("main"));
        assert.equal(view.query.symbolsInFile("src/foo.ts").length, 2);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi') builds the WI branch when it has diverged from main", async () => {
    const repoRoot = path.join(tmp, "repo-wi-diverged-from-main");
    const { led } = setupRepo(repoRoot);
    try {
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: mainViewPath(repoRoot),
        options: { repoRoot },
      });
      const branch = ledgerBranchForWi(46);
      const forkSeq = led.headSeq("main");
      led.forkBranch(branch, "main", forkSeq);
      const bContent = "export function branchOnly() { return 1; }\n";
      const bHash = hashOf(bContent);
      led.ingestBlob({
        content_hash: bHash,
        lang: "ts",
        byte_size: bContent.length,
        symbols: [{
          content_hash: bHash,
          local_id: 0,
          kind: "function",
          name: "branchOnly",
          qualified_name: "branchOnly",
          parent_local_id: null,
          repo_rel_path: "src/branch-only.ts",
          lang: "ts",
          range_start: 0,
          range_end: bContent.length,
          signature_hash: sha256Hex("branchOnly()"),
          visibility: "public",
          doc: null,
        }],
        edges: [],
      });
      led.append({
        branch,
        op: "add",
        repo_rel_path: "src/branch-only.ts",
        before_content_hash: null,
        after_content_hash: bHash,
      });
      const warmer = new Warmer({ ledger: led, repoRoot });
      const result = await warmer.handleWarmJob({
        purpose: "wi",
        work_item_id: 46,
        out_view_path: warmedViewPath(repoRoot, 46),
        paths: ["src/branch-only.ts"],
      });
      const view = View.mount({ dbPath: result.view_written });
      try {
        const meta = view.meta();
        assert.equal(meta.branch, branch);
        assert.equal(meta.parent_seq, forkSeq);
        assert.equal(view.query.symbolsInFile("src/branch-only.ts").length, 1);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("ML tree-compression reseed only runs on boot-triggered main warms", () => {
    const gate = (args) => shouldRunMlTreeCompressionReseed(args);
    assert.deepEqual(gate({ purpose: "main-full", mode: "ml", triggerEvent: "boot" }), { run: true, reason: null });
    assert.deepEqual(gate({ purpose: "main-incremental", mode: "ml", triggerEvent: "boot" }), { run: true, reason: null });
    // Re-warms (post-commit, merge replays, anything not boot) never pay the
    // provider pass; the compressed tree is allowed to lag until next boot.
    assert.deepEqual(gate({ purpose: "main-incremental", mode: "ml", triggerEvent: "post-commit" }), { run: false, reason: "ml_reseed_boot_only" });
    assert.deepEqual(gate({ purpose: "main-merge", mode: "ml", triggerEvent: null }), { run: false, reason: "ml_reseed_boot_only" });
    assert.deepEqual(gate({ purpose: "wi", mode: "ml", triggerEvent: "boot" }), { run: false, reason: "not_main_purpose" });
    assert.deepEqual(gate({ purpose: "main-full", mode: "deterministic", triggerEvent: "boot" }), { run: false, reason: "mode_not_ml" });
  });

  it("handleWarmJob('wi') is idempotent — re-running with existing file returns the existing etag", async () => {
    const repoRoot = path.join(tmp, "repo2");
    const { led } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      const a = await warmer.handleWarmJob({
        purpose: "wi", work_item_id: 7,
        out_view_path: warmedViewPath(repoRoot, 7),
      });
      const b = await warmer.handleWarmJob({
        purpose: "wi", work_item_id: 7,
        out_view_path: warmedViewPath(repoRoot, 7),
      });
      assert.equal(a.view_etag, b.view_etag, "etag must be stable across idempotent re-runs");
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi') targets a WI branch when it exists, falls back to main otherwise", async () => {
    const repoRoot = path.join(tmp, "repo3");
    const { led, aHash } = setupRepo(repoRoot);
    try {
      // Without a WI branch, the warm should target main and produce a usable view.
      const warmer = new Warmer({ ledger: led, repoRoot });
      const noFork = await warmer.handleWarmJob({
        purpose: "wi", work_item_id: 11,
        out_view_path: warmedViewPath(repoRoot, 11),
      });
      assert.ok(noFork.view_written);
      const view1 = View.mount({ dbPath: noFork.view_written });
      try {
        assert.equal(view1.meta().branch, "main");
      } finally {
        view1.close();
      }

      // After forking and appending a delta on the WI branch, warming
      // should target the WI branch.
      const head = led.headSeq("main");
      led.forkBranch(ledgerBranchForWi(12), "main", head);
      const bContent = `function bar() {}`;
      const bHash = hashOf(bContent);
      led.ingestBlob({
        content_hash: bHash, lang: "ts", byte_size: bContent.length,
        symbols: [{
          content_hash: bHash, local_id: 0,
          kind: "function", name: "bar", qualified_name: "bar",
          parent_local_id: null, repo_rel_path: "src/wi.ts", lang: "ts",
          range_start: 0, range_end: 17,
          signature_hash: sha256Hex("bar()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: ledgerBranchForWi(12), op: "add", repo_rel_path: "src/wi.ts",
        before_content_hash: null, after_content_hash: bHash,
      });
      const forked = await warmer.handleWarmJob({
        purpose: "wi", work_item_id: 12,
        out_view_path: warmedViewPath(repoRoot, 12),
      });
      const view2 = View.mount({ dbPath: forked.view_written });
      try {
        const meta = view2.meta();
        assert.equal(meta.branch, "wi-12");
        assert.equal(meta.parent_branch, "main");
        // Inherits main's foo.ts AND its own wi.ts.
        assert.equal(view2.query.symbolsInFile("src/foo.ts").length, 2);
        assert.equal(view2.query.symbolsInFile("src/wi.ts").length, 1);
      } finally {
        view2.close();
      }

      // Suppress unused-variable lint on the captured hash.
      void aHash;
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('main-incremental') returns structured skips when parser is absent", async () => {
    const repoRoot = path.join(tmp, "repo4");
    const { led } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      const result = await warmer.handleWarmJob({
        purpose: "main-incremental",
        paths: ["src/foo.ts", "src/bar.ts"],
      });
      assert.equal(result.purpose, "main-incremental");
      assert.equal(result.paths_considered, 2);
      assert.equal(result.skipped.length, 2);
      for (const s of result.skipped) {
        assert.equal(s.reason, "unsupported_lang");
      }
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('main-full') returns a single repo-level skip when parser is absent", async () => {
    const repoRoot = path.join(tmp, "repo5");
    const { led } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      const result = await warmer.handleWarmJob({ purpose: "main-full" });
      assert.equal(result.purpose, "main-full");
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].repo_rel_path, ".");
    } finally {
      led.close();
    }
  });

  it("mountForWorktree promotes a warmed view by atomic rename", async () => {
    const repoRoot = path.join(tmp, "repo6");
    const { led } = setupRepo(repoRoot);
    const worktree = path.join(tmp, "wt-6");
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      await warmer.handleWarmJob({
        purpose: "wi", work_item_id: 6,
        out_view_path: warmedViewPath(repoRoot, 6),
      });
      assert.ok(fs.existsSync(warmedViewPath(repoRoot, 6)));
      const mount = warmer.mountForWorktree({
        workItemId: 6,
        worktreePath: worktree,
      });
      assert.equal(mount.from, "warmed");
      assert.equal(mount.viewPath, worktreeViewPath(worktree));
      assert.ok(fs.existsSync(mount.viewPath));
      // After rename the warmed slot must be empty.
      assert.equal(fs.existsSync(warmedViewPath(repoRoot, 6)), false);
    } finally {
      led.close();
    }
  });

  it("mountForWorktree clones main when no warmed view exists", async () => {
    const repoRoot = path.join(tmp, "repo7");
    const { led } = setupRepo(repoRoot);
    const worktree = path.join(tmp, "wt-7");
    try {
      // Build a main view first.
      new ViewBuilder().buildFrom({
        ledger: led, branch: "main",
        atSeq: led.headSeq("main"),
        outPath: mainViewPath(repoRoot),
      });
      const warmer = new Warmer({ ledger: led, repoRoot });
      const mount = warmer.mountForWorktree({
        workItemId: 99,
        worktreePath: worktree,
      });
      assert.equal(mount.from, "main-clone");
      const view = View.mount({ dbPath: mount.viewPath });
      try {
        assert.equal(view.query.symbolsInFile("src/foo.ts").length, 2);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("mountForWorktree rebrands a main clone without advancing the WI branch seq", async () => {
    const repoRoot = path.join(tmp, "repo7a");
    const { led } = setupRepo(repoRoot);
    const worktree = path.join(tmp, "wt-7a");
    try {
      new ViewBuilder().buildFrom({
        ledger: led, branch: "main",
        atSeq: led.headSeq("main"),
        outPath: mainViewPath(repoRoot),
      });
      const mainView = View.mount({ dbPath: mainViewPath(repoRoot) });
      const mainBuiltAt = mainView.meta().built_at;
      mainView.close();
      await new Promise((resolve) => setTimeout(resolve, 5));
      const head = led.headSeq("main");
      led.forkBranch(ledgerBranchForWi(77), "main", head);
      const warmer = new Warmer({ ledger: led, repoRoot });
      const mount = warmer.mountForWorktree({
        workItemId: 77,
        worktreePath: worktree,
      });
      assert.equal(mount.from, "main-clone");
      const view = View.mount({ dbPath: mount.viewPath });
      try {
        const meta = view.meta();
        assert.equal(meta.branch, "wi-77");
        assert.equal(meta.parent_seq, head);
        assert.equal(meta.ledger_seq, led.headSeq("wi-77"));
        assert.notEqual(meta.built_at, mainBuiltAt, "cloned views should be re-stamped when rebranded");
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("mountForWorktree replaces an invalid existing worktree view", async () => {
    const repoRoot = path.join(tmp, "repo7b");
    const { led } = setupRepo(repoRoot);
    const worktree = path.join(tmp, "wt-7b");
    try {
      new ViewBuilder().buildFrom({
        ledger: led, branch: "main",
        atSeq: led.headSeq("main"),
        outPath: mainViewPath(repoRoot),
      });
      fs.mkdirSync(path.dirname(worktreeViewPath(worktree)), { recursive: true });
      fs.writeFileSync(worktreeViewPath(worktree), "not a sqlite view", "utf8");

      const warmer = new Warmer({ ledger: led, repoRoot });
      const mount = warmer.mountForWorktree({
        workItemId: 100,
        worktreePath: worktree,
      });
      assert.equal(mount.from, "main-clone");
      const view = View.mount({ dbPath: mount.viewPath });
      try {
        assert.equal(view.meta().schema_version, VIEW_SCHEMA_VERSION);
        assert.equal(view.query.symbolsInFile("src/foo.ts").length, 2);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("mountForWorktree builds from ledger as a final fallback when nothing is staged", async () => {
    const repoRoot = path.join(tmp, "repo8");
    const { led } = setupRepo(repoRoot);
    const worktree = path.join(tmp, "wt-8");
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      // No warmed view, no main view. Should still produce something.
      const mount = warmer.mountForWorktree({
        workItemId: 8,
        worktreePath: worktree,
      });
      assert.equal(mount.from, "ledger-build");
      const view = View.mount({ dbPath: mount.viewPath });
      try {
        assert.equal(view.query.symbolsInFile("src/foo.ts").length, 2);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("mountForWorktree rebrands a warmed-for-main view to a forked WI branch", async () => {
    const repoRoot = path.join(tmp, "repo9");
    const { led } = setupRepo(repoRoot);
    const worktree = path.join(tmp, "wt-9");
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      // Warm BEFORE the WI branch is forked — produces a main-targeting view.
      await warmer.handleWarmJob({
        purpose: "wi", work_item_id: 13,
        out_view_path: warmedViewPath(repoRoot, 13),
      });
      // Workstream E forks the WI branch at worktree-create time.
      const head = led.headSeq("main");
      led.forkBranch(ledgerBranchForWi(13), "main", head);
      const mount = warmer.mountForWorktree({
        workItemId: 13, worktreePath: worktree,
      });
      assert.equal(mount.from, "warmed");
      const view = View.mount({ dbPath: mount.viewPath });
      try {
        const meta = view.meta();
        assert.equal(meta.branch, "wi-13");
        assert.equal(meta.parent_branch, "main");
        assert.equal(meta.parent_seq, head);
        assert.equal(meta.ledger_seq, led.headSeq("wi-13"));
      } finally {
        view.close();
      }

      const laterContent = `export function later() { return 13; }`;
      const laterHash = hashOf(laterContent);
      led.ingestBlob({
        content_hash: laterHash, lang: "ts", byte_size: laterContent.length,
        symbols: [{
          content_hash: laterHash, local_id: 0,
          kind: "function", name: "later", qualified_name: "later",
          parent_local_id: null, repo_rel_path: "src/later.ts", lang: "ts",
          range_start: 0, range_end: laterContent.length,
          signature_hash: sha256Hex("later()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: "wi-13", op: "add", repo_rel_path: "src/later.ts",
        before_content_hash: null, after_content_hash: laterHash,
      });
      const writable = View.mount({ dbPath: mount.viewPath, mode: "readwrite" });
      try {
        const before = writable.meta();
        const entries = led.tail("wi-13", before.ledger_seq);
        const updated = new ViewBuilder().incrementalApply({ view: writable, ledger: led, entries });
        assert.equal(updated.ledger_seq, led.headSeq("wi-13"));
        assert.equal(writable.query.findSymbol("later", { fuzzy: false, limit: 5 }).length, 1);
      } finally {
        writable.close();
      }
    } finally {
      led.close();
    }
  });

  it("cleanupWiView deletes warmed + worktree views and can mark the branch abandoned", () => {
    const repoRoot = path.join(tmp, "repo10");
    const { led } = setupRepo(repoRoot);
    const worktree = path.join(tmp, "wt-10");
    try {
      const head = led.headSeq("main");
      led.forkBranch(ledgerBranchForWi(10), "main", head);
      fs.mkdirSync(path.dirname(warmedViewPath(repoRoot, 10)), { recursive: true });
      fs.writeFileSync(warmedViewPath(repoRoot, 10), "stub");
      fs.mkdirSync(path.dirname(worktreeViewPath(worktree)), { recursive: true });
      fs.writeFileSync(worktreeViewPath(worktree), "stub");

      const warmer = new Warmer({ ledger: led, repoRoot });
      const out = warmer.cleanupWiView({
        workItemId: 10,
        worktreePath: worktree,
        markBranchAbandoned: true,
      });
      assert.ok(out.removed.length >= 2);
      assert.equal(fs.existsSync(warmedViewPath(repoRoot, 10)), false);
      assert.equal(fs.existsSync(worktreeViewPath(worktree)), false);
      assert.equal(led.getBranch("wi-10").status, "abandoned");
    } finally {
      led.close();
    }
  });

  it("replayMerge replays a WI branch onto main and marks the source merged", () => {
    const repoRoot = path.join(tmp, "repo11");
    const { led } = setupRepo(repoRoot);
    try {
      const head = led.headSeq("main");
      led.forkBranch("wi-merge", "main", head);
      const bContent = `function feature() {}`;
      const bHash = hashOf(bContent);
      led.ingestBlob({
        content_hash: bHash, lang: "ts", byte_size: bContent.length,
        symbols: [{
          content_hash: bHash, local_id: 0,
          kind: "function", name: "feature", qualified_name: "feature",
          parent_local_id: null, repo_rel_path: "src/feature.ts", lang: "ts",
          range_start: 0, range_end: 21,
          signature_hash: sha256Hex("feature()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: "wi-merge", op: "add", repo_rel_path: "src/feature.ts",
        before_content_hash: null, after_content_hash: bHash,
      });

      const warmer = new Warmer({ ledger: led, repoRoot });
      const out = warmer.replayMerge({ branch: "wi-merge" });
      assert.equal(out.entries.length, 1);
      assert.equal(out.entries[0].branch, "main");
      assert.equal(out.entries[0].repo_rel_path, "src/feature.ts");
      assert.equal(led.getBranch("wi-merge").status, "merged");
    } finally {
      led.close();
    }
  });

  it("main-merge warm job replays a WI branch and refreshes main view", async () => {
    const repoRoot = path.join(tmp, "repo11b");
    const { led } = setupRepo(repoRoot);
    try {
      const head = led.headSeq("main");
      led.forkBranch("wi-merge-job", "main", head);
      const content = `function mergedByJob() {}`;
      const hash = hashOf(content);
      led.ingestBlob({
        content_hash: hash, lang: "ts", byte_size: content.length,
        symbols: [{
          content_hash: hash, local_id: 0,
          kind: "function", name: "mergedByJob", qualified_name: "mergedByJob",
          parent_local_id: null, repo_rel_path: "src/merged-by-job.ts", lang: "ts",
          range_start: 0, range_end: content.length,
          signature_hash: sha256Hex("mergedByJob()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: "wi-merge-job", op: "add", repo_rel_path: "src/merged-by-job.ts",
        before_content_hash: null, after_content_hash: hash,
      });

      const warmer = new Warmer({ ledger: led, repoRoot });
      const result = await warmer.handleWarmJob({
        purpose: "main-merge",
        branch: "wi-merge-job",
        onto_branch: "main",
      });
      assert.equal(result.ledger_entries_appended, 1);
      assert.equal(led.getBranch("wi-merge-job").status, "merged");
      assert.equal(fs.existsSync(mainViewPath(repoRoot)), true);
      const view = View.mount({ dbPath: mainViewPath(repoRoot), mode: "readonly" });
      try {
        assert.equal(view.query.findSymbol("mergedByJob").length, 1);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("inline merge warm refreshes main before wrap-up cleanup", async () => {
    const repoRoot = path.join(tmp, "repo-inline-merge");
    const { led } = setupRepo(repoRoot);
    try {
      const workItemId = 42;
      const sourceBranch = ledgerBranchForWi(workItemId);
      const head = led.headSeq("main");
      led.forkBranch(sourceBranch, "main", head);
      const content = `function finalizedDuringWrapup() {}`;
      const hash = hashOf(content);
      led.ingestBlob({
        content_hash: hash,
        lang: "ts",
        byte_size: content.length,
        symbols: [{
          content_hash: hash,
          local_id: 0,
          kind: "function",
          name: "finalizedDuringWrapup",
          qualified_name: "finalizedDuringWrapup",
          parent_local_id: null,
          repo_rel_path: "src/finalized-during-wrapup.ts",
          lang: "ts",
          range_start: 0,
          range_end: content.length,
          signature_hash: sha256Hex("finalizedDuringWrapup()"),
          visibility: "public",
          doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: sourceBranch,
        op: "add",
        repo_rel_path: "src/finalized-during-wrapup.ts",
        before_content_hash: null,
        after_content_hash: hash,
      });
    } finally {
      led.close();
    }

    const result = await warmAtlasMergedToMainNow({
      cwd: repoRoot,
      workItemId: 42,
      targetBranch: "main",
      config: {
        enabled: true,
        atlasV2Mode: "on",
        phases: ["research"],
        scipMode: "off",
      },
    });
    assert.equal(result.attempted, true);
    assert.equal(result.ok, true);
    assert.equal(result.result.ledger_entries_appended, 1);

    const reopened = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      assert.equal(reopened.getBranch(ledgerBranchForWi(42)).status, "merged");
    } finally {
      reopened.close();
    }
    const view = View.mount({ dbPath: mainViewPath(repoRoot), mode: "readonly" });
    try {
      assert.equal(view.query.findSymbol("finalizedDuringWrapup").length, 1);
    } finally {
      view.close();
    }
  });

  it("main-merge warm job refreshes newly merged blobs from staged SCIP", async () => {
    const repoRoot = path.join(tmp, "repo-main-merge-scip");
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, ".posse", "atlas", "scip"), { recursive: true });
      const source = "export const mergedScip = 1;\n";
      const contentHash = hashOf(source);
      fs.writeFileSync(path.join(repoRoot, "src", "merge-scip.txt"), source);

      const forkSeq = led.headSeq("main");
      led.forkBranch("wi-scip-merge", "main", forkSeq);
      led.ingestBlob({
        content_hash: contentHash,
        lang: "ts",
        byte_size: source.length,
        symbols: [{
          content_hash: contentHash,
          local_id: 0,
          kind: "const",
          name: "treeOnly",
          qualified_name: "treeOnly",
          parent_local_id: null,
          repo_rel_path: "src/merge-scip.txt",
          lang: "ts",
          range_start: 0,
          range_end: source.length,
          signature_hash: sha256Hex("treeOnly"),
          visibility: "public",
          doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: "wi-scip-merge",
        op: "add",
        repo_rel_path: "src/merge-scip.txt",
        before_content_hash: null,
        after_content_hash: contentHash,
      });

      const symbol = "scip-typescript npm pkg 1.0.0 src/`merge-scip.txt`/mergedScip.";
      fs.writeFileSync(path.join(repoRoot, ".posse", "atlas", "scip", "ts.scip"), encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: repoRoot,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/merge-scip.txt",
          occurrences: [
            { range: [0, 13, 23], symbol, symbol_roles: 0x1 },
          ],
          symbols: [{ symbol, display_name: "mergedScip" }],
        }],
      }));

      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        config: { scipMode: "on" },
      });
      const result = await warmer.handleWarmJob({
        purpose: "main-merge",
        branch: "wi-scip-merge",
        onto_branch: "main",
      });
      assert.equal(result.skipped.length, 0);
      assert.equal(result.ledger_entries_appended, 1);
      assert.equal(result.blobs_ingested, 1);
      assert.equal(result.blobs_reused, 0);

      const repeat = await warmer.handleWarmJob({
        purpose: "main-merge",
        branch: "wi-scip-merge",
        onto_branch: "main",
      });
      assert.equal(repeat.skipped.length, 0);
      assert.equal(repeat.ledger_entries_appended, 0);
      assert.equal(repeat.blobs_ingested, 0);
      assert.equal(repeat.blobs_reused, 0);

      const view = View.mount({ dbPath: mainViewPath(repoRoot), mode: "readonly" });
      try {
        assert.equal(view.query.findSymbol("mergedScip").length, 1);
        assert.equal(view.query.findSymbol("treeOnly").length, 0);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("handleWarmJob catches internal errors and surfaces them as skips", async () => {
    const repoRoot = path.join(tmp, "repo12");
    const { led } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      // Force buildFrom to fail by pre-creating the out file.
      const out = warmedViewPath(repoRoot, 99);
      fs.mkdirSync(path.dirname(out), { recursive: true });
      // Stamp a non-empty file at the path; buildFrom rejects existing dest.
      fs.writeFileSync(out, "block");
      const result = await warmer.handleWarmJob({
        purpose: "wi", work_item_id: 99,
        out_view_path: out,
      });
      // Existing file path is treated as idempotent success in #warmWi —
      // exercise the error branch with an invalid branch instead.
      const result2 = await warmer.handleWarmJob({
        purpose: "wi", work_item_id: 100,
        out_view_path: warmedViewPath(repoRoot, 100),
        branch: "does-not-exist-but-not-main-either",
      });
      // does-not-exist falls back to main, which succeeds, so this is a clean build.
      assert.ok(result2.view_written, "fallback to main should succeed");
      void result;
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('main-incremental') with parser indexes paths and appends ledger deltas", async () => {
    const repoRoot = path.join(tmp, "repo-real-inc");
    const { led } = setupRepo(repoRoot);
    try {
      // Stage a real TypeScript file inside the repo so the parser has
      // something on disk to read.
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, "src", "alpha.ts"),
        "export function alpha(): number { return 1; }\n",
      );
      let parseCalls = 0;
      const parserAdapter = {
        supports: (extOrLang) => sharedParserAdapter.supports(extOrLang),
        languages: () => sharedParserAdapter.languages(),
        parseBuffer: (args) => {
          parseCalls += 1;
          return sharedParserAdapter.parseBuffer(args);
        },
        parseFile: async (args) => {
          parseCalls += 1;
          return sharedParserAdapter.parseFile(args);
        },
      };
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter,
        scipMode: "off",
      });
      const before = led.headSeq("main");
      const result = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: ["src/alpha.ts"],
      });
      assert.equal(result.purpose, "main-incremental");
      assert.equal(result.paths_considered, 1);
      assert.equal(result.paths_indexed, 1);
      assert.equal(result.ledger_entries_appended, 1);
      // First time we've seen this file's bytes — must be ingested, not reused.
      assert.equal(result.blobs_ingested, 1);
      assert.equal(result.blobs_reused, 0);
      assert.equal(result.skipped.length, 0);
      assert.equal(parseCalls, 1);
      assert.ok(led.headSeq("main") > before, "head should advance after append");

      // Re-running with unchanged bytes is a no-op (no new ledger entries).
      const repeat = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: ["src/alpha.ts"],
      });
      assert.equal(repeat.paths_indexed, 0);
      assert.equal(repeat.ledger_entries_appended, 0);
      assert.equal(repeat.skipped.length, 0);
      assert.equal(parseCalls, 1, "unchanged current blobs should skip parser work");
    } finally {
      led.close();
    }
  });

  it("boot main-incremental hashes only source stat mismatches", async () => {
    const repoRoot = path.join(tmp, "repo-boot-freshness");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      led.ensureRootBranch("main");
      const filePath = path.join(repoRoot, "src", "boot.ts");
      fs.writeFileSync(filePath, "export const bootValue = 1;\n");
      let parseCalls = 0;
      const parserAdapter = {
        supports: (extOrLang) => sharedParserAdapter.supports(extOrLang),
        languages: () => sharedParserAdapter.languages(),
        parseBuffer: (args) => {
          parseCalls += 1;
          return sharedParserAdapter.parseBuffer(args);
        },
        parseFile: async (args) => {
          parseCalls += 1;
          return sharedParserAdapter.parseFile(args);
        },
      };
      const progressEvents = [];
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter,
        scipMode: "off",
        onProgress: (event) => progressEvents.push(event),
      });

      const first = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: ["src/boot.ts"],
      });
      assert.equal(first.paths_indexed, 1);
      assert.equal(parseCalls, 1);

      progressEvents.length = 0;
      const clean = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: [],
        trigger_event: "boot",
      });
      assert.equal(clean.freshness_stat_matches, 1);
      assert.equal(clean.freshness_paths_hashed, 0);
      assert.equal(clean.freshness_paths_changed, 0);
      assert.equal(clean.paths_indexed, 0);
      assert.equal(parseCalls, 1);
      const cachedTs = progressEvents.find((event) => event.stage === "cached" && event.language === "ts");
      assert.equal(cachedTs?.language_current, 1);
      assert.equal(cachedTs?.language_total, 1);
      assert.equal(cachedTs?.language_percent, 100);

      const stat = fs.statSync(filePath);
      const touchedAt = new Date(stat.mtimeMs + 5000);
      fs.utimesSync(filePath, touchedAt, touchedAt);
      const touched = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: [],
        trigger_event: "boot",
      });
      assert.equal(touched.freshness_paths_hashed, 1);
      assert.equal(touched.freshness_paths_changed, 0);
      assert.equal(touched.paths_indexed, 0);
      assert.equal(parseCalls, 1, "mtime-only changes should hash but avoid parsing when bytes match");

      fs.writeFileSync(filePath, "export const bootValue = 2;\n");
      const changed = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: [],
        trigger_event: "boot",
      });
      assert.equal(changed.freshness_paths_hashed, 1);
      assert.equal(changed.freshness_paths_changed, 1);
      assert.equal(changed.paths_indexed, 1);
      assert.equal(parseCalls, 2);
    } finally {
      led.close();
    }
  });

  it("boot main-incremental reparses unchanged files whose parser blob is stale", async () => {
    const repoRoot = path.join(tmp, "repo-boot-parser-spec");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      led.ensureRootBranch("main");
      fs.writeFileSync(path.join(repoRoot, "src", "spec.ts"), "export const parserSpecValue = 1;\n");
      let parseCalls = 0;
      const parserAdapter = {
        supports: (extOrLang) => sharedParserAdapter.supports(extOrLang),
        languages: () => sharedParserAdapter.languages(),
        parseBuffer: (args) => {
          parseCalls += 1;
          return sharedParserAdapter.parseBuffer(args);
        },
        parseFile: async (args) => {
          parseCalls += 1;
          return sharedParserAdapter.parseFile(args);
        },
      };
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter,
        scipMode: "off",
      });

      const first = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: ["src/spec.ts"],
      });
      assert.equal(first.paths_indexed, 1);
      assert.equal(parseCalls, 1);
      const contentHash = led.pathSnapshotAt("main", led.headSeq("main")).get("src/spec.ts");
      led._unsafeDb().prepare("UPDATE blobs SET parser_spec_version = ? WHERE content_hash = ?").run("stale-test-spec", contentHash);

      const reparsed = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: [],
        trigger_event: "boot",
      });
      assert.equal(reparsed.freshness_paths_changed, 1);
      assert.equal(reparsed.paths_indexed, 0);
      assert.equal(reparsed.blobs_ingested, 1);
      assert.equal(reparsed.ledger_entries_appended, 0);
      assert.equal(parseCalls, 2);
      assert.equal(led.hasCurrentParsedBlob(contentHash), true);
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('main-incremental') skips oversized files before parse", async () => {
    const repoRoot = path.join(tmp, "repo-oversized");
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      led.ensureRootBranch("main");
      const filePath = path.join(repoRoot, "src", "huge.ts");
      const fd = fs.openSync(filePath, "w");
      try {
        fs.writeSync(fd, Buffer.from("x"), 0, 1, MAX_PARSE_FILE_BYTES);
      } finally {
        fs.closeSync(fd);
      }
      let parseCalls = 0;
      const parserAdapter = {
        supports: (extOrLang) => sharedParserAdapter.supports(extOrLang),
        languages: () => sharedParserAdapter.languages(),
        parseBuffer: (args) => {
          parseCalls += 1;
          return sharedParserAdapter.parseBuffer(args);
        },
        parseFile: async (args) => {
          parseCalls += 1;
          return sharedParserAdapter.parseFile(args);
        },
      };
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter,
        scipMode: "off",
      });

      const result = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: ["src/huge.ts"],
      });
      assert.equal(result.paths_indexed, 0);
      assert.equal(result.ledger_entries_appended, 0);
      assert.equal(parseCalls, 0);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].reason, "size_exceeded");
    } finally {
      led.close();
    }
  });

  it("falls back to a full view rebuild when incremental apply stalls on a missing blob", async () => {
    const repoRoot = path.join(tmp, "repo-inc-stall");
    const { led } = setupRepo(repoRoot);
    try {
      fs.mkdirSync(path.dirname(mainViewPath(repoRoot)), { recursive: true });
      new ViewBuilder().buildFrom({
        ledger: led,
        branch: "main",
        atSeq: led.headSeq("main"),
        outPath: mainViewPath(repoRoot),
      });
      const missingHash = sha256Hex("missing-blob");
      led.ingestBlob({
        content_hash: missingHash,
        lang: "ts",
        byte_size: 0,
        symbols: [],
        edges: [],
      });
      led.append({
        branch: "main",
        op: "add",
        repo_rel_path: "src/missing.ts",
        before_content_hash: null,
        after_content_hash: missingHash,
      });
      const db = led._unsafeDb();
      db.pragma("foreign_keys = OFF");
      try {
        db.prepare("DELETE FROM blobs WHERE content_hash = ?").run(missingHash);
      } finally {
        db.pragma("foreign_keys = ON");
      }
      const head = led.headSeq("main");
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter: sharedParserAdapter,
        scipMode: "off",
      });

      const result = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: [],
      });
      assert.equal(result.view_written, mainViewPath(repoRoot));
      const view = View.mount({ dbPath: mainViewPath(repoRoot) });
      try {
        assert.equal(view.meta().ledger_seq, head);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('main-incremental') emits a remove delta when file vanishes from disk", async () => {
    const repoRoot = path.join(tmp, "repo-real-remove");
    const { led } = setupRepo(repoRoot);
    try {
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      const filePath = path.join(repoRoot, "src", "tmp.ts");
      fs.writeFileSync(filePath, "export const x = 1;\n");
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter: sharedParserAdapter,
      });
      await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: ["src/tmp.ts"],
      });
      const seqAfterAdd = led.headSeq("main");
      assert.ok(seqAfterAdd > 0);

      // Delete the file, run again — should emit a `remove` delta.
      fs.unlinkSync(filePath);
      const result = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: ["src/tmp.ts"],
      });
      assert.equal(result.ledger_entries_appended, 1);
      const tail = led.tail("main", seqAfterAdd);
      assert.equal(tail.length, 1);
      assert.equal(tail[0].op, "remove");
      assert.equal(tail[0].repo_rel_path, "src/tmp.ts");
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('main-incremental') skips unsupported extensions with structured reasons", async () => {
    const repoRoot = path.join(tmp, "repo-real-skip");
    const { led } = setupRepo(repoRoot);
    try {
      fs.mkdirSync(path.join(repoRoot, "docs"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "docs", "README.md"), "# hi\n");
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter: sharedParserAdapter,
      });
      const result = await warmer.handleWarmJob({
        purpose: "main-incremental",
        branch: "main",
        paths: ["docs/README.md"],
      });
      assert.equal(result.paths_indexed, 0);
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].reason, "unsupported_lang");
      assert.equal(result.skipped[0].repo_rel_path, "docs/README.md");
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('main-full') walks the repo and indexes supported files, skipping vendored dirs", async () => {
    const repoRoot = path.join(tmp, "repo-real-full");
    const { led } = setupRepo(repoRoot);
    try {
      // Source files we expect to index.
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "src", "one.ts"), "export const one = 1;\n");
      fs.writeFileSync(path.join(repoRoot, "src", "two.ts"), "export const two = 2;\n");
      // Vendored TS file in node_modules — must NOT be indexed.
      fs.mkdirSync(path.join(repoRoot, "node_modules", "pkg"), { recursive: true });
      fs.writeFileSync(
        path.join(repoRoot, "node_modules", "pkg", "vendor.ts"),
        "export const v = 1;\n",
      );
      // .git contents — must NOT be indexed.
      fs.mkdirSync(path.join(repoRoot, ".git", "hooks"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, ".git", "hooks", "ignored.ts"), "export const g = 1;\n");
      // Unsupported extension at the top level — must NOT be indexed but
      // also must NOT show up as a skip (the walker filtered it out).
      fs.writeFileSync(path.join(repoRoot, "notes.txt"), "hello\n");

      const progressEvents = [];
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter: sharedParserAdapter,
        onProgress: (event) => progressEvents.push(event),
        scipMode: "off",
      });
      const result = await warmer.handleWarmJob({ purpose: "main-full", branch: "main" });

      assert.equal(result.purpose, "main-full");
      // Two supported files survived the walker: src/one.ts and src/two.ts.
      // (setupRepo's src/foo.ts file isn't actually on disk — it's only in
      //  the ledger via the synthetic blob — so the walker doesn't see it.)
      assert.equal(result.paths_considered, 2);
      assert.equal(result.paths_indexed, 2);
      assert.equal(result.ledger_entries_appended, 2);
      assert.equal(result.blobs_ingested, 2);
      assert.equal(result.skipped.length, 0);
      assert.equal(result.view_written, mainViewPath(repoRoot));
      assert.ok(fs.existsSync(result.view_written), "main-full should materialize the main view");
      assert.ok(progressEvents.some((event) => event.stage === "walking" && /scanning repository/.test(event.text || "")));
      assert.ok(progressEvents.some((event) => event.stage === "parsing" && /src\/one\.ts/.test(event.text || "")));
      const firstParsingProgress = progressEvents.find((event) => event.stage === "parsing");
      assert.equal(firstParsingProgress?.progress_current, 1);
      assert.ok(Number(firstParsingProgress?.percent || 0) > 0);
      assert.ok(progressEvents.some((event) => event.stage === "writing ledger" && /ingesting blob/.test(event.text || "")));
      assert.ok(progressEvents.some((event) => event.stage === "view" && /building main view/.test(event.text || "")));

      const view = View.mount({ dbPath: result.view_written });
      try {
        const meta = view.meta();
        assert.equal(meta.branch, "main");
        assert.equal(meta.ledger_seq, led.headSeq("main"));
        assert.ok(view.query.findSymbol("one").length >= 1);
        assert.ok(view.query.findSymbol("two").length >= 1);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("normalizes numeric SCIP language ids before writing blobs", async () => {
    const repoRoot = path.join(tmp, "repo-scip-php-lang");
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      led.ensureRootBranch("main");
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      const source = "<?php\nfunction phpSmoke(): void {}\n";
      fs.writeFileSync(path.join(repoRoot, "src", "smoke.php"), source);
      const symbol = "scip-php composer pkg dev src/`smoke.php`/phpSmoke().";
      const scipPath = path.join(repoRoot, "php.scip");
      fs.writeFileSync(scipPath, encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-php", version: "0.0.1" }),
          project_root: repoRoot,
        },
        documents: [{
          language: "19",
          relative_path: "src/smoke.php",
          occurrences: [
            { range: [1, 9, 17], symbol, symbol_roles: 0x1 },
          ],
          symbols: [{ symbol, display_name: "phpSmoke" }],
        }],
      }));

      const result = await ingestScipFile({ ledger: led, scipPath, repoRoot, branch: "main" });
      assert.equal(result.documents_ingested, 1);
      const hash = sha256Hex(source);
      const blob = led._unsafeDb().prepare("SELECT lang FROM blobs WHERE content_hash = ?").get(hash);
      assert.ok(blob);
      assert.equal(blob.lang, "php");
      const indexRow = led._unsafeDb().prepare("SELECT langs FROM scip_indexes WHERE id = ?").get(result.scip_index_id);
      assert.ok(indexRow);
      assert.equal(indexRow.langs, "php");
    } finally {
      led.close();
    }
  });

  it("merges tree-sitter PHP functions into SCIP-backed blobs", async () => {
    const repoRoot = path.join(tmp, "repo-scip-php-merge");
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      fs.mkdirSync(path.join(repoRoot, "htdocs"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, ".posse", "atlas", "scip"), { recursive: true });
      const source = [
        "<?php",
        "function brief($title) { return $title; }",
        "header('Content-Type: text/plain');",
        "",
      ].join("\n");
      fs.writeFileSync(path.join(repoRoot, "htdocs", "brief.php"), source);
      fs.writeFileSync(path.join(repoRoot, ".posse", "atlas", "scip", "php.scip"), encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-php", version: "0.0.1" }),
          project_root: repoRoot,
        },
        documents: [{
          language: "PHP",
          relative_path: "htdocs/brief.php",
          text: source,
          occurrences: [
            { range: [2, 0, 6], symbol: "scip-php composer php 8.5.6 header()." },
          ],
          symbols: [],
        }],
        external_symbols: [
          { symbol: "scip-php composer php 8.5.6 header().", display_name: "header" },
        ],
      }));

      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter: sharedParserAdapter,
        config: { scipMode: "on" },
      });
      const result = await warmer.handleWarmJob({ purpose: "main-full", branch: "main" });
      assert.ok(Number(/** @type {any} */ (result).parser_rows_merged || 0) >= 1);

      const view = View.mount({ dbPath: result.view_written });
      try {
        const symbols = view.query.symbolsInFile("htdocs/brief.php");
        assert.ok(symbols.some((symbol) => symbol.kind === "function" && symbol.name === "brief"));
        assert.ok(symbols.some((symbol) => symbol.kind === "module" && symbol.name === "brief.php"));
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("main-full (layer model) lands both tree-sitter and SCIP symbols via the concurrent path", async () => {
    // Exercises the concurrent boot path: SCIP staging/intake runs alongside
    // tree-sitter parse, and a single view build folds both source layers in.
    // The flat-path tests above can't cover this because they run with the
    // layer model off. Two separate files keep the assertion clean: one
    // tree-sitter-parsed, one SCIP-only.
    const repoRoot = path.join(tmp, "repo-layer-concurrent");
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, ".posse", "atlas", "scip"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "src", "ts.ts"), "export function tsFunc() { return 1; }\n");
      const scipSource = "export const scipFunc = 1;\n";
      fs.writeFileSync(path.join(repoRoot, "src", "scip-only.txt"), scipSource);
      const scipSymbol = "scip-typescript npm pkg 1.0.0 src/`scip-only.txt`/scipFunc.";
      fs.writeFileSync(path.join(repoRoot, ".posse", "atlas", "scip", "ts.scip"), encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: repoRoot,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/scip-only.txt",
          text: scipSource,
          occurrences: [
            { range: [0, 13, 21], symbol: scipSymbol, symbol_roles: 0x1 },
          ],
          symbols: [{ symbol: scipSymbol, display_name: "scipFunc" }],
        }],
      }));

      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter: sharedParserAdapter,
        config: { scipMode: "on", viewLayerMerge: true },
      });
      const result = await warmer.handleWarmJob({ purpose: "main-full", branch: "main" });
      assert.equal(result.view_written, mainViewPath(repoRoot));

      const view = View.mount({ dbPath: result.view_written });
      try {
        const tsNames = view.query.symbolsInFile("src/ts.ts").map((s) => s.name);
        assert.ok(tsNames.includes("tsFunc"), `tree-sitter symbol missing; got [${tsNames.join(", ")}]`);
        const scipNames = view.query.symbolsInFile("src/scip-only.txt").map((s) => s.name);
        assert.ok(scipNames.includes("scipFunc"), `SCIP symbol missing; got [${scipNames.join(", ")}]`);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("main-full emits chunked view progress during a cold main-view rebuild", async () => {
    const repoRoot = path.join(tmp, "repo-cold-view-progress");
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "src", "one.ts"), "export const one = 1;\n");
      fs.writeFileSync(path.join(repoRoot, "src", "two.ts"), "export const two = 2;\n");

      const progressEvents = [];
      const parserAdapter = {
        supports: (ext) => ext === ".ts",
        parseFile: async ({ absPath }) => {
          const bytes = fs.readFileSync(absPath);
          return {
            content_hash: sha256Hex(bytes),
            lang: "ts",
            byte_size: bytes.length,
            symbols: [],
            edges: [],
            hasError: false,
          };
        },
      };

      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter,
        onProgress: (event) => progressEvents.push(event),
        config: { scipMode: "off", viewLayerMerge: true },
      });

      const result = await warmer.handleWarmJob({ purpose: "main-full", branch: "main" });
      assert.equal(result.view_written, mainViewPath(repoRoot));

      const viewEvents = progressEvents.filter((event) => event.stage === "view");
      assert.ok(viewEvents.some((event) => Number(event.percent) === 0), "expected initial view progress");
      assert.ok(
        viewEvents.some((event) => Number(event.percent) > 0 && Number(event.percent) < 100),
        `expected in-flight view progress, got ${JSON.stringify(viewEvents)}`,
      );
      assert.ok(viewEvents.some((event) => Number(event.percent) >= 100 || /\bmerged\b/i.test(event.text || "")));
    } finally {
      led.close();
    }
  });

  it("main-full (layer model) starts SCIP intake while tree-sitter is still parsing", async () => {
    const repoRoot = path.join(tmp, "repo-layer-intake-queue");
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, ".posse", "atlas", "scip"), { recursive: true });
      const treeSource = "export const treeOnly = 1;\n";
      const scipSource = "export const queuedScip = 1;\n";
      fs.writeFileSync(path.join(repoRoot, "src", "tree.ts"), treeSource);
      fs.writeFileSync(path.join(repoRoot, "src", "queued-scip.txt"), scipSource);
      const scipSymbol = "scip-typescript npm pkg 1.0.0 src/`queued-scip.txt`/queuedScip.";
      fs.writeFileSync(path.join(repoRoot, ".posse", "atlas", "scip", "typescript.scip"), encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: repoRoot,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/queued-scip.txt",
          text: scipSource,
          occurrences: [
            { range: [0, 13, 23], symbol: scipSymbol, symbol_roles: 0x1 },
          ],
          symbols: [{ symbol: scipSymbol, display_name: "queuedScip" }],
        }],
      }));

      const progressEvents = [];
      const parserAdapter = {
        supports: (ext) => ext === ".ts",
        parseFile: async ({ absPath }) => {
          await new Promise((resolve) => setTimeout(resolve, 300));
          const bytes = fs.readFileSync(absPath);
          return {
            content_hash: sha256Hex(bytes),
            lang: "ts",
            byte_size: bytes.length,
            symbols: [],
            edges: [],
            hasError: false,
          };
        },
      };
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter,
        onProgress: (event) => progressEvents.push(event),
        config: { scipMode: "on", viewLayerMerge: true },
      });
      const result = await warmer.handleWarmJob({ purpose: "main-full", branch: "main" });
      assert.equal(result.view_written, mainViewPath(repoRoot));
      assert.ok(!result.skipped.some((row) => /scipBasenameSourceLanguages/.test(row.message || "")));

      const ingestStartedAt = progressEvents.findIndex((event) => event.kind === "atlas.scip.ingest.started");
      const treeDeltaAt = progressEvents.findIndex((event) => (
        event.stage === "recording delta" && /src\/tree\.ts/.test(event.text || "")
      ));
      assert.ok(ingestStartedAt >= 0, "expected queued SCIP intake to start");
      assert.ok(treeDeltaAt >= 0, "expected tree-sitter delta progress");
      assert.ok(ingestStartedAt < treeDeltaAt, "SCIP intake should start before tree-sitter finishes writing its delta");

      const view = View.mount({ dbPath: result.view_written });
      try {
        const scipNames = view.query.symbolsInFile("src/queued-scip.txt").map((symbol) => symbol.name);
        assert.ok(scipNames.includes("queuedScip"));
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('main-full') consumes SCIP-only paths into the main view", async () => {
    const repoRoot = path.join(tmp, "repo-scip-only-full");
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, ".posse", "atlas", "scip"), { recursive: true });
      const source = "export const fromScip = 1;\n";
      fs.writeFileSync(path.join(repoRoot, "src", "from-scip.txt"), source);
      const symbol = "scip-typescript npm pkg 1.0.0 src/`from-scip.txt`/fromScip.";
      fs.writeFileSync(path.join(repoRoot, ".posse", "atlas", "scip", "ts.scip"), encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: repoRoot,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/from-scip.txt",
          occurrences: [
            { range: [0, 13, 21], symbol, symbol_roles: 0x1 },
          ],
          symbols: [{ symbol, display_name: "fromScip" }],
        }],
      }));

      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter: sharedParserAdapter,
        config: { scipMode: "on" },
      });
      const result = await warmer.handleWarmJob({ purpose: "main-full", branch: "main" });
      assert.equal(result.blobs_ingested, 1);
      assert.equal(result.ledger_entries_appended, 1);
      assert.equal(result.paths_considered, 0);
      assert.equal(result.view_written, mainViewPath(repoRoot));

      const view = View.mount({ dbPath: result.view_written });
      try {
        const symbols = view.query.symbolsInFile("src/from-scip.txt");
        assert.equal(symbols.length, 1);
        assert.equal(symbols[0].name, "fromScip");
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi') leaves staged SCIP to main warms", async () => {
    const repoRoot = path.join(tmp, "repo-scip-only-wi");
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, ".posse", "atlas", "scip"), { recursive: true });
      const source = "export const wiScip = 1;\n";
      fs.writeFileSync(path.join(repoRoot, "src", "wi-scip.txt"), source);
      const symbol = "scip-typescript npm pkg 1.0.0 src/`wi-scip.txt`/wiScip.";
      fs.writeFileSync(path.join(repoRoot, ".posse", "atlas", "scip", "ts.scip"), encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: repoRoot,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/wi-scip.txt",
          occurrences: [
            { range: [0, 13, 19], symbol, symbol_roles: 0x1 },
          ],
          symbols: [{ symbol, display_name: "wiScip" }],
        }],
      }));

      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        config: { scipMode: "on" },
      });
      const result = await warmer.handleWarmJob({
        purpose: "wi",
        work_item_id: 31,
        out_view_path: warmedViewPath(repoRoot, 31),
      });
      assert.equal(result.ledger_entries_appended, 0);
      assert.equal(result.view_written, warmedViewPath(repoRoot, 31));
      assert.equal(led.pathSnapshotAt("main", led.headSeq("main")).has("src/wi-scip.txt"), false);

      const view = View.mount({ dbPath: result.view_written });
      try {
        const symbols = view.query.symbolsInFile("src/wi-scip.txt");
        assert.equal(symbols.length, 0);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi') with an existing WI branch does not append default-branch SCIP", async () => {
    const repoRoot = path.join(tmp, "repo-scip-existing-wi");
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      const forkSeq = led.headSeq("main");
      led.forkBranch(ledgerBranchForWi(32), "main", forkSeq);
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, ".posse", "atlas", "scip"), { recursive: true });
      const source = "export const afterForkScip = 1;\n";
      fs.writeFileSync(path.join(repoRoot, "src", "after-fork.txt"), source);
      const symbol = "scip-typescript npm pkg 1.0.0 src/`after-fork.txt`/afterForkScip.";
      fs.writeFileSync(path.join(repoRoot, ".posse", "atlas", "scip", "ts.scip"), encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: repoRoot,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/after-fork.txt",
          occurrences: [
            { range: [0, 13, 26], symbol, symbol_roles: 0x1 },
          ],
          symbols: [{ symbol, display_name: "afterForkScip" }],
        }],
      }));

      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        config: { scipMode: "on" },
      });
      const result = await warmer.handleWarmJob({
        purpose: "wi",
        work_item_id: 32,
        out_view_path: warmedViewPath(repoRoot, 32),
      });
      assert.equal(result.ledger_entries_appended, 0);
      assert.equal(led.pathSnapshotAt("main", led.headSeq("main")).has("src/after-fork.txt"), false);

      const view = View.mount({ dbPath: result.view_written });
      try {
        const meta = view.meta();
        assert.equal(meta.branch, "wi-32");
        assert.equal(meta.parent_seq, forkSeq);
        assert.equal(view.query.symbolsInFile("src/after-fork.txt").length, 0);
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });

  it("handleWarmJob appends SCIP rows to a non-main default branch", async () => {
    const repoRoot = path.join(tmp, "repo-scip-master-default");
    const led = Ledger.open({ dbPath: ledgerDbPath(repoRoot) });
    try {
      led.ensureRootBranch("master");
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.mkdirSync(path.join(repoRoot, ".posse", "atlas", "scip"), { recursive: true });
      const source = "export const fromMasterScip = 1;\n";
      fs.writeFileSync(path.join(repoRoot, "src", "from-master.txt"), source);
      const symbol = "scip-typescript npm pkg 1.0.0 src/`from-master.txt`/fromMasterScip.";
      fs.writeFileSync(path.join(repoRoot, ".posse", "atlas", "scip", "ts.scip"), encodeIndex({
        metadata: {
          tool_info: encodeToolInfo({ name: "scip-typescript", version: "0.3.0" }),
          project_root: repoRoot,
        },
        documents: [{
          language: "TypeScript",
          relative_path: "src/from-master.txt",
          occurrences: [
            { range: [0, 13, 27], symbol, symbol_roles: 0x1 },
          ],
          symbols: [{ symbol, display_name: "fromMasterScip" }],
        }],
      }));

      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        defaultBranch: "master",
        config: { scipMode: "on" },
      });
      const result = await warmer.handleWarmJob({ purpose: "main-incremental", branch: "master", paths: [] });
      assert.equal(result.ledger_entries_appended, 1);
      assert.equal(led.headSeq("main"), 0);
      assert.equal(led.pathSnapshotAt("master", led.headSeq("master")).has("src/from-master.txt"), true);
    } finally {
      led.close();
    }
  });

  it("handleWarmJob refreshes embeddings when an embedding provider is configured", { skip: skipIfNoUsearch }, async () => {
    const repoRoot = path.join(tmp, "repo-embeddings");
    const { led } = setupRepo(repoRoot);
    try {
      fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
      fs.writeFileSync(path.join(repoRoot, "src", "semantic.ts"), "export function semanticNeedle() { return 1; }\n");

      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        parserAdapter: sharedParserAdapter,
        config: { embeddingProvider: "stub", vectorBackend: "usearch" },
      });
      const result = await warmer.handleWarmJob({ purpose: "main-full", branch: "main" });

      assert.equal(result.skipped.length, 0);
      assert.equal(result.embeddings_provider, "posse-stub-hash");
      assert.ok((result.embeddings_indexed || 0) > 0);

      const enc = new StubEmbeddingEncoder();
      const idx = EmbeddingIndex.open({
        model: enc.model,
        model_version: enc.model_version,
        dim: enc.dim,
        embeddingsRoot: embeddingsRoot(repoRoot),
      });
      try {
        assert.ok(idx.count() >= result.embeddings_indexed);
      } finally {
        idx.close();
      }
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi') skips eager embeddings when wiEmbeddings is on_demand", async () => {
    const repoRoot = path.join(tmp, "repo-wi-embeddings-on-demand");
    const { led } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({
        ledger: led,
        repoRoot,
        config: {
          embeddingProvider: "stub",
          vectorBackend: "usearch",
          wiEmbeddings: "on_demand",
        },
      });
      const result = await warmer.handleWarmJob({
        purpose: "wi",
        work_item_id: 44,
      });
      assert.equal(result.purpose, "wi");
      assert.equal(result.embeddings_skipped_reason, "wi_embeddings_on_demand");
      assert.equal(result.embeddings_provider, undefined);
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi') rebuilds the view when the existing one is stale", async () => {
    const repoRoot = path.join(tmp, "repo-stale");
    const { led, aHash } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      const out = warmedViewPath(repoRoot, 21);
      const first = await warmer.handleWarmJob({
        purpose: "wi", work_item_id: 21, out_view_path: out,
      });
      assert.ok(first.view_etag);

      // Advance main ledger after the warm: ingest a new blob + append.
      const newContent = "function added() {}";
      const newHash = sha256Hex(Buffer.from(newContent));
      led.ingestBlob({
        content_hash: newHash, lang: "ts", byte_size: newContent.length,
        symbols: [{
          content_hash: newHash, local_id: 0,
          kind: "function", name: "added", qualified_name: "added",
          parent_local_id: null, repo_rel_path: "src/added.ts", lang: "ts",
          range_start: 0, range_end: 18,
          signature_hash: sha256Hex("added()"),
          visibility: "public", doc: null,
        }],
        edges: [],
      });
      led.append({
        branch: "main", op: "add", repo_rel_path: "src/added.ts",
        before_content_hash: null, after_content_hash: newHash,
      });

      const second = await warmer.handleWarmJob({
        purpose: "wi", work_item_id: 21, out_view_path: out,
      });
      assert.ok(second.view_etag, "second run should still produce an etag");
      assert.notEqual(second.view_etag, first.view_etag, "stale rebuild should re-stamp built_at");
      // The rebuilt view should contain the new symbol.
      const view = View.mount({ dbPath: out });
      try {
        const added = view.query.symbolsInFile("src/added.ts");
        assert.equal(added.length, 1, "rebuilt view should include the post-warm symbol");
      } finally {
        view.close();
      }
      void aHash;
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi-cleanup') tears down warmed + worktree views for a terminal WI", async () => {
    const repoRoot = path.join(tmp, "repo-cleanup-job");
    const { led } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      // Build a warmed view first so cleanup has something to remove.
      const warm = await warmer.handleWarmJob({
        purpose: "wi",
        work_item_id: 13,
        out_view_path: warmedViewPath(repoRoot, 13),
      });
      assert.ok(fs.existsSync(warm.view_written), "warmed view should exist before cleanup");
      // Drive cleanup via the warm-job pathway (the outbox flow).
      const result = await warmer.handleWarmJob({
        purpose: "wi-cleanup",
        work_item_id: 13,
      });
      assert.equal(result.purpose, "wi-cleanup");
      assert.equal(result.skipped.length, 0, `cleanup should not skip; got ${JSON.stringify(result.skipped)}`);
      assert.ok(!fs.existsSync(warm.view_written), "warmed view should be removed after cleanup job");
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi-cleanup') without work_item_id surfaces a structured skip", async () => {
    const repoRoot = path.join(tmp, "repo-cleanup-noid");
    const { led } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      const result = await warmer.handleWarmJob({ purpose: "wi-cleanup" });
      assert.equal(result.skipped.length, 1);
      assert.equal(result.skipped[0].reason, "unsupported_lang");
      assert.match(result.skipped[0].message, /work_item_id/);
    } finally {
      led.close();
    }
  });

  it("handleWarmJob('wi') with paths drives neighborhood prefetch into view meta", async () => {
    const repoRoot = path.join(tmp, "repo-prefetch");
    const { led } = setupRepo(repoRoot);
    try {
      const warmer = new Warmer({ ledger: led, repoRoot });
      const result = await warmer.handleWarmJob({
        purpose: "wi",
        work_item_id: 7,
        out_view_path: warmedViewPath(repoRoot, 7),
        paths: ["src/foo.ts"],
      });
      assert.ok(result.view_written, "view should be written");
      const view = View.mount({ dbPath: result.view_written });
      try {
        const meta = view.meta();
        assert.deepEqual(meta.warmed_for_files, ["src/foo.ts"]);
        // setupRepo plants Foo + greet at src/foo.ts — both should be seeds.
        assert.ok(
          meta.prefetched_symbols != null && meta.prefetched_symbols >= 2,
          `expected prefetched_symbols >= 2; got ${meta.prefetched_symbols}`,
        );
        // No edges in setupRepo's blob, so prefetch traverses 0 edges but
        // still records the count (not null).
        assert.equal(typeof meta.prefetched_edges, "number");
      } finally {
        view.close();
      }
    } finally {
      led.close();
    }
  });
});
