// ATLAS v2 fixture corpus + snapshot tests.
//
// Walks test/fixtures/atlas-v2-corpus, parses every file through the v2
// ParserAdapter, ingests results into a Ledger, materializes a View
// from that ledger, and dispatches every action in ATLAS_TOOL_ACTIONS
// against the view. Each result is compared to a committed snapshot
// under fixtures/.../snapshots/.
//
// Set UPDATE_ATLAS_SNAPSHOTS=1 to rewrite snapshots in place. The test
// fails on drift otherwise.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import { sha256Hex } from "../lib/domains/atlas/functions/v2/hash.js";
import {
  parseBuffer,
  sharedParserAdapter,
} from "../lib/domains/atlas/functions/v2/parser/adapter.js";
import { ATLAS_TOOL_ACTIONS } from "../lib/domains/atlas/functions/v2/contracts/tool-params.js";
import {
  dispatch,
  __resetSliceRegistryForTests,
  __resetBufferRegistryForTests,
} from "../lib/domains/atlas/functions/v2/retrieval/index.js";
import { maskVolatileFields } from "../lib/domains/atlas/functions/v2/retrieval/normalize-result.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.join(__dirname, "fixtures", "atlas-v2-corpus");
const SNAPSHOT_DIR = path.join(CORPUS_ROOT, "snapshots");
const UPDATE = process.env.UPDATE_ATLAS_SNAPSHOTS === "1";
const VERSION_ID = "corpus@v1";

function listSourceFiles(root = CORPUS_ROOT) {
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === "snapshots") continue;
        walk(full);
        continue;
      }
      const ext = path.extname(entry.name).toLowerCase();
      if (!sharedParserAdapter.supports(ext)) continue;
      out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

function copyCorpusSources(destRoot) {
  for (const abs of listSourceFiles(CORPUS_ROOT)) {
    const rel = path.relative(CORPUS_ROOT, abs);
    const dest = path.join(destRoot, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(abs, dest);
  }
}

/**
 * Build the corpus view via the proper Ledger + ViewBuilder pipeline
 * so the resolver pass runs and cross-file edges land bound. Earlier
 * iterations of this test inlined SQL inserts, which bypassed the
 * resolver entirely — that meant callers/callees were always empty
 * in snapshots even when the underlying corpus had clear cross-file
 * references. Run through the real pipeline so snapshots reflect
 * reality.
 */
function buildCorpusView(tmpDir, repoRoot) {
  const ledgerPath = path.join(tmpDir, "ledger.db");
  const viewPath = path.join(tmpDir, "view.db");
  const ledger = Ledger.open({ dbPath: ledgerPath });

  for (const abs of listSourceFiles(repoRoot)) {
    const rel = path.relative(repoRoot, abs).replace(/\\/g, "/");
    const bytes = fs.readFileSync(abs);
    const result = parseBuffer({ bytes, repo_rel_path: rel });
    ledger.ingestBlob({
      content_hash: result.content_hash,
      lang: result.lang,
      byte_size: bytes.length,
      symbols: result.symbols,
      edges: result.edges,
    });
    ledger.append({
      branch: "main",
      op: "add",
      repo_rel_path: rel,
      before_content_hash: null,
      after_content_hash: result.content_hash,
    });
  }

  const builder = new ViewBuilder();
  builder.buildFrom({
    ledger,
    branch: "main",
    atSeq: ledger.headSeq("main"),
    outPath: viewPath,
    options: { repoRoot },
  });
  return { view: View.mount({ dbPath: viewPath }), ledger };
}

// Snapshot normalization delegates to the shared volatile-field util so
// the corpus test and the shadow runner can never disagree about what
// "volatile" means.
function normalizeForSnapshot(value) {
  return maskVolatileFields(value);
}

let view;
let ledger;
let env;

before(() => {
  fs.mkdirSync(SNAPSHOT_DIR, { recursive: true });
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-corpus-"));
  const repoRoot = path.join(tmp, "repo");
  fs.mkdirSync(repoRoot, { recursive: true });
  copyCorpusSources(repoRoot);
  const built = buildCorpusView(tmp, repoRoot);
  view = built.view;
  ledger = built.ledger;
  env = { tmp, repoRoot };
});

after(() => {
  if (view) view.close();
  if (ledger) ledger.close();
  if (env?.tmp) {
    try {
      fs.rmSync(env.tmp, { recursive: true, force: true });
    } catch {
      // Windows handle release lag.
    }
  }
  __resetSliceRegistryForTests();
  __resetBufferRegistryForTests();
});

describe("ATLAS v2 fixture corpus", () => {
  it("dispatches every action via the central handler and matches snapshots", async () => {
    const calls = sampleCallsFor();
    const drift = [];
    for (const action of ATLAS_TOOL_ACTIONS) {
      const call = calls[action];
      const result = await Promise.resolve(
        dispatch(call, {
          view,
          versionId: VERSION_ID,
          repoRoot: env.repoRoot,
          ...(action === "info"
            || action === "repo"
            || action === "agent"
            || String(action).startsWith("agent.feedback")
            || String(action).startsWith("memory.")
            || String(action).startsWith("policy.")
            || String(action).startsWith("runtime.")
            || action === "repo.quality"
            || action === "usage.stats"
            || action === "scip.ingest"
            ? { ledger, repoId: "fixture-corpus" }
            : {}),
          ...(action === "index.refresh" ? { config: { scipMode: "off" } } : {}),
        }),
      );
      const normalized = normalizeForSnapshot(result);
      const snapshotPath = path.join(SNAPSHOT_DIR, `${action}.json`);
      const serialized = JSON.stringify(normalized, null, 2) + "\n";
      if (UPDATE || !fs.existsSync(snapshotPath)) {
        fs.writeFileSync(snapshotPath, serialized);
        continue;
      }
      const expected = fs.readFileSync(snapshotPath, "utf8");
      if (expected !== serialized) drift.push(action);
    }
    if (drift.length > 0) {
      assert.fail(
        `Snapshot drift for: ${drift.join(", ")}.\nRe-run with UPDATE_ATLAS_SNAPSHOTS=1 to refresh.`,
      );
    }
  });

  it("covers every supported language in the corpus", () => {
    const seen = new Set();
    for (const s of view.query.allSymbols({ limit: 5000 })) seen.add(s.lang);
    for (const wanted of ["ts", "py", "rs", "go", "sh"]) {
      assert.ok(seen.has(wanted), `corpus did not produce any ${wanted} symbols`);
    }
  });
});

function sampleCallsFor() {
  const greeterId = pickSymbolId(view, "Greeter");
  const runId = pickSymbolId(view, "run");
  return {
    "query": { action: "query", targetAction: "symbol.search", query: "Greeter", limit: 2 },
    "code": { action: "code", targetAction: "code.getSkeleton", file: "src/greeter.ts" },
    "repo": { action: "repo", targetAction: "info", includePolicy: true, includeCounts: true },
    "agent": { action: "agent", targetAction: "memory.query", query: "fixture", limit: 2 },
    "action.search": { action: "action.search", query: "memory store", limit: 5 },
    "manual": { action: "manual", actions: ["symbol.search", "code.needWindow"], limit: 10 },
    "workflow": {
      action: "workflow",
      steps: [
        { id: "search", action: "symbol.search", args: { query: "Greeter", limit: 1 } },
        { id: "pick", fn: "dataPick", args: { input: "$search.items[0]", fields: { name: "name", file: "location.repo_rel_path" } } },
      ],
      onError: "stop",
    },
    "info": { action: "info", includePolicy: true, includeCounts: true },
    "repo.register": { action: "repo.register", buildEmptyView: false },
    "repo.status": { action: "repo.status", detail: "standard" },
    "index.refresh": { action: "index.refresh", mode: "incremental", paths: ["src/greeter.ts"] },
    "repo.overview": { action: "repo.overview", level: "stats" },
    "repo.quality": { action: "repo.quality", feedbackLimit: 10 },
    "buffer.push": {
      action: "buffer.push",
      filePath: "src/greeter.ts",
      content: "export class Greeter { greet() { return 'draft'; } }\n",
      version: 1,
      eventType: "change",
      language: "typescript",
      dirty: true,
      timestamp: "2026-05-18T00:00:00.000Z",
      cursor: { line: 1, column: 23 },
    },
    "buffer.checkpoint": { action: "buffer.checkpoint", filePath: "src/greeter.ts", clear: true },
    "buffer.status": { action: "buffer.status", filePath: "src/greeter.ts" },
    "symbol.search": { action: "symbol.search", query: "Greeter", limit: 5 },
    "symbol.getCard": { action: "symbol.getCard", symbolId: greeterId },
    "symbol.getCards": { action: "symbol.getCards", symbolIds: [greeterId, runId] },
    "symbol.usages": { action: "symbol.usages", symbolId: greeterId, kind: ["calls"], limit: 5 },
    "tree.overview": { action: "tree.overview", maxDepth: 2, limit: 50 },
    "tree.scope": { action: "tree.scope", taskText: "Greeter", maxFiles: 10 },
    "slice.build": {
      action: "slice.build",
      taskText: "Greeter",
      entrySymbols: [greeterId],
      cardDetail: "compact",
      budget: { maxCards: 5, maxEstimatedTokens: 8000 },
    },
    "slice.refresh": {
      action: "slice.refresh",
      sliceHandle: "sl_unknown",
      knownVersion: VERSION_ID,
    },
    "slice.spillover.get": {
      action: "slice.spillover.get",
      spilloverHandle: "sl_unknown:spill",
      pageSize: 5,
    },
    "code.getSkeleton": { action: "code.getSkeleton", file: "src/greeter.ts" },
    "code.getHotPath": {
      action: "code.getHotPath",
      symbolId: runId || greeterId,
      identifiersToFind: ["Greeter", "hello"],
      contextLines: 1,
    },
    "code.needWindow": {
      action: "code.needWindow",
      symbolId: greeterId,
      reason: "snapshot",
      expectedLines: 5,
      identifiersToFind: ["Greeter"],
      granularity: "symbol",
    },
    "edit.plan": {
      action: "edit.plan",
      targetFiles: ["src/greeter.ts"],
      search: "Greeter",
      replace: "Greeter",
      operation: "inspect",
      maxEdits: 2,
    },
    context: { action: "context", taskText: "explain Greeter", taskType: "explain", focusSymbols: [greeterId] },
    "context.summary": { action: "context.summary", taskText: "explain Greeter", taskType: "explain", focusSymbols: [greeterId], maxEvidence: 3 },
    "agent.feedback": {
      action: "agent.feedback",
      sliceHandle: "sl_unknown",
      usefulSymbols: [],
      missingSymbols: [],
    },
    "agent.feedback.query": { action: "agent.feedback.query", limit: 10, halfLifeDays: 14 },
    "delta.get": {
      action: "delta.get",
      fromVersion: "corpus@v0",
      toVersion: VERSION_ID,
      maxCards: 5,
    },
    "pr.risk.analyze": {
      action: "pr.risk.analyze",
      fromVersion: "corpus@v0",
      toVersion: VERSION_ID,
      riskThreshold: 0,
    },
    "pr.risk": {
      action: "pr.risk",
      fromVersion: "corpus@v0",
      toVersion: VERSION_ID,
      maxCards: 3,
      riskThreshold: 0,
    },
    "file.read": { action: "file.read", filePath: "src/greeter.ts", search: "Greeter" },
    "memory.store": {
      action: "memory.store",
      type: "decision",
      title: "Prefer native ATLAS v2",
      content: "Memory is stored in the ATLAS v2 ledger for the fixture corpus.",
      tags: ["snapshot"],
      symbolIds: [greeterId],
      fileRelPaths: ["src/greeter.ts"],
      confidence: 0.8,
    },
    "memory.query": {
      action: "memory.query",
      query: "ledger",
      tags: ["snapshot"],
      limit: 5,
    },
    "memory.surface": {
      action: "memory.surface",
      symbolIds: [greeterId],
      limit: 5,
    },
    "memory.remove": {
      action: "memory.remove",
      memoryId: "mem_snapshot_missing",
    },
    "policy.get": { action: "policy.get" },
    "policy.set": {
      action: "policy.set",
      policyPatch: { maxWindowLines: 250, budgetCaps: { maxCards: 20 } },
    },
    "usage.stats": { action: "usage.stats", scope: "both", limit: 20 },
    "runtime.execute": { action: "runtime.execute", repoId: "fixture-corpus", runtime: "node", args: ["-e", "console.log('snapshot')"] },
    "runtime.queryOutput": { action: "runtime.queryOutput", artifactHandle: "missing", queryTerms: ["snapshot"] },
    "scip.ingest": { action: "scip.ingest", indexPath: "missing.scip", dryRun: true },
  };
}

function pickSymbolId(view, name) {
  const matches = view.query.findSymbol(name, { fuzzy: false, limit: 1 });
  if (matches.length === 0) return `${sha256Hex("missing")}:0`;
  return `${matches[0].content_hash}:${matches[0].local_id}`;
}
