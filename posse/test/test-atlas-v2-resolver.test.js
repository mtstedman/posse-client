// Resolver unit + integration tests.
//
// Unit: each strategy in isolation (qualified-name, import-aware,
// heuristic global match, unresolved).
// Integration: parse the v2 corpus, build a view, verify cross-file
// edges (runner.ts → greeter.ts.Greeter) actually get to_global_id
// bound by the resolver pass.

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  resolveEdges,
  buildNameIndexes,
  lookupByName,
  resolveModuleSpecifier,
  RESOLVABLE_EXTENSIONS,
  calibrateResolutionConfidence,
  toEdgeConfidence,
} from "../lib/domains/atlas/functions/v2/resolver/index.js";
import { Ledger } from "../lib/domains/atlas/classes/v2/Ledger.js";
import { View } from "../lib/domains/atlas/classes/v2/View.js";
import { ViewBuilder } from "../lib/domains/atlas/classes/v2/ViewBuilder.js";
import {
  sharedParserAdapter,
  parseBuffer,
} from "../lib/domains/atlas/functions/v2/parser/adapter.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CORPUS_ROOT = path.join(__dirname, "fixtures", "atlas-v2-corpus");

// ---------------------------------------------------------------------------
// Unit tests — pure resolver logic.
// ---------------------------------------------------------------------------

describe("confidence calibration", () => {
  it("uses strategy-default baselines", () => {
    assert.equal(
      calibrateResolutionConfidence({ isResolved: true, strategy: "scip-resolved" }).confidence,
      0.98,
    );
    assert.equal(
      calibrateResolutionConfidence({ isResolved: true, strategy: "name-resolved" }).confidence,
      0.92,
    );
    assert.equal(
      calibrateResolutionConfidence({ isResolved: true, strategy: "exact" }).confidence,
      0.92,
    );
    assert.equal(
      calibrateResolutionConfidence({ isResolved: true, strategy: "import-direct" }).confidence,
      0.85,
    );
    assert.equal(
      calibrateResolutionConfidence({ isResolved: true, strategy: "heuristic" }).confidence,
      0.72,
    );
    assert.equal(
      calibrateResolutionConfidence({ isResolved: false }).confidence,
      0.2,
    );
  });

  it("applies an ambiguity penalty for multi-candidate matches", () => {
    const single = calibrateResolutionConfidence({ isResolved: true, strategy: "heuristic", candidateCount: 1 });
    const double = calibrateResolutionConfidence({ isResolved: true, strategy: "heuristic", candidateCount: 2 });
    assert.ok(double.confidence < single.confidence);
    // Penalty is 0.04 per candidate, capped at 0.35.
    const many = calibrateResolutionConfidence({ isResolved: true, strategy: "heuristic", candidateCount: 100 });
    assert.equal(many.confidence, Math.max(0, 0.72 - 0.35));
  });

  it("toEdgeConfidence converts to integer 0..100", () => {
    assert.equal(toEdgeConfidence(0.92), 92);
    assert.equal(toEdgeConfidence(0), 0);
    assert.equal(toEdgeConfidence(1), 100);
    assert.equal(toEdgeConfidence(1.5), 100);
    assert.equal(toEdgeConfidence(-0.1), 0);
  });
});

describe("module specifier resolution", () => {
  it("resolves relative paths against the importing file's directory", () => {
    assert.equal(resolveModuleSpecifier("src/runner.ts", "./greeter.js"), "src/greeter.js");
    assert.equal(resolveModuleSpecifier("src/sub/runner.ts", "../greeter.js"), "src/greeter.js");
    assert.equal(resolveModuleSpecifier("src/runner.ts", "./util/text.js"), "src/util/text.js");
  });

  it("returns null for bare package specifiers", () => {
    assert.equal(resolveModuleSpecifier("src/runner.ts", "react"), null);
    assert.equal(resolveModuleSpecifier("src/runner.ts", "node:fs"), null);
    assert.equal(resolveModuleSpecifier("src/runner.ts", "@scope/pkg"), null);
  });

  it("RESOLVABLE_EXTENSIONS includes the common Node + TS extensions", () => {
    for (const expected of [".ts", ".tsx", ".js", ".mjs", ".d.ts", "/index.ts"]) {
      assert.ok(RESOLVABLE_EXTENSIONS.includes(expected), `missing ${expected}`);
    }
  });
});

describe("name index", () => {
  it("groups candidates by simple name and qualified name", () => {
    const idx = buildNameIndexes([
      {
        name: "Greeter",
        global_id: 1,
        content_hash: "a".repeat(64),
        local_id: 0,
        repo_rel_path: "src/a.ts",
        kind: "class",
        qualified_name: null,
      },
      {
        name: "Greeter",
        global_id: 2,
        content_hash: "b".repeat(64),
        local_id: 0,
        repo_rel_path: "src/b.go",
        kind: "struct",
        qualified_name: null,
      },
      {
        name: "hello",
        global_id: 3,
        content_hash: "a".repeat(64),
        local_id: 1,
        repo_rel_path: "src/a.ts",
        kind: "method",
        qualified_name: "Greeter.hello",
      },
    ]);
    assert.equal(lookupByName(idx, "Greeter").length, 2);
    assert.equal(lookupByName(idx, "nope").length, 0);
    assert.equal(idx.byQualifiedName.get("Greeter.hello")?.length, 1);
  });
});

// ---------------------------------------------------------------------------
// Strategy unit tests via resolveEdges() — pass tiny synthetic inputs.
// ---------------------------------------------------------------------------

describe("resolveEdges strategies", () => {
  const symbols = [
    {
      name: "Greeter",
      global_id: 10,
      content_hash: "a".repeat(64),
      local_id: 0,
      repo_rel_path: "src/greeter.ts",
      kind: "class",
      qualified_name: null,
    },
    {
      name: "hello",
      global_id: 11,
      content_hash: "a".repeat(64),
      local_id: 1,
      repo_rel_path: "src/greeter.ts",
      kind: "method",
      qualified_name: "Greeter.hello",
    },
    {
      name: "run",
      global_id: 12,
      content_hash: "b".repeat(64),
      local_id: 0,
      repo_rel_path: "src/runner.ts",
      kind: "function",
      qualified_name: null,
    },
  ];
  const pathToBlob = new Map([
    ["src/greeter.ts", "a".repeat(64)],
    ["src/runner.ts", "b".repeat(64)],
  ]);
  const importEdges = [
    {
      repo_rel_path: "src/runner.ts",
      to_name: "Greeter",
      to_module: "./greeter.js",
      kind: "imports",
    },
  ];

  it("NAME-RESOLVED (qualified-name) binds Greeter.hello to global_id 11", () => {
    const resolutions = resolveEdges({
      allSymbols: symbols,
      importEdges,
      pathToBlob,
      unresolved: [
        {
          edge_rowid: 1,
          repo_rel_path: "src/runner.ts",
          to_name: "Greeter.hello",
          to_module: null,
          kind: "calls",
          from_global_id: 12,
        },
      ],
    });
    assert.equal(resolutions.length, 1);
    assert.equal(resolutions[0].to_global_id, 11);
    assert.equal(resolutions[0].strategy, "name-resolved");
    assert.equal(resolutions[0].confidence, 92);
  });

  it("IMPORT-DIRECT binds Greeter in runner.ts via the import map", () => {
    const resolutions = resolveEdges({
      allSymbols: symbols,
      importEdges,
      pathToBlob,
      unresolved: [
        {
          edge_rowid: 2,
          repo_rel_path: "src/runner.ts",
          to_name: "Greeter",
          to_module: null,
          kind: "calls",
          from_global_id: 12,
        },
      ],
    });
    assert.equal(resolutions[0].to_global_id, 10);
    assert.equal(resolutions[0].strategy, "import-direct");
    assert.equal(resolutions[0].confidence, 85);
  });

  it("IMPORT-DIRECT binds aliased named imports through their exported name", () => {
    const resolutions = resolveEdges({
      allSymbols: symbols,
      importEdges: [
        {
          repo_rel_path: "src/runner.ts",
          to_name: "LocalGreeter",
          to_module: "./greeter.js#Greeter",
          kind: "imports",
        },
      ],
      pathToBlob,
      unresolved: [
        {
          edge_rowid: 7,
          repo_rel_path: "src/runner.ts",
          to_name: "LocalGreeter",
          to_module: null,
          kind: "calls",
          from_global_id: 12,
        },
      ],
    });
    assert.equal(resolutions[0].to_global_id, 10);
    assert.equal(resolutions[0].strategy, "import-direct");
    assert.equal(resolutions[0].confidence, 85);
  });

  it("HEURISTIC global match when no import context applies", () => {
    const resolutions = resolveEdges({
      allSymbols: symbols,
      importEdges: [],
      pathToBlob,
      unresolved: [
        {
          edge_rowid: 3,
          repo_rel_path: "src/somewhere-else.ts",
          to_name: "Greeter",
          to_module: null,
          kind: "calls",
          from_global_id: 99,
        },
      ],
    });
    assert.equal(resolutions[0].to_global_id, 10);
    assert.equal(resolutions[0].strategy, "heuristic");
    // Single candidate → no ambiguity penalty.
    assert.equal(resolutions[0].confidence, 72);
  });

  it("UNRESOLVED for names with no candidates anywhere", () => {
    const resolutions = resolveEdges({
      allSymbols: symbols,
      importEdges: [],
      pathToBlob,
      unresolved: [
        {
          edge_rowid: 4,
          repo_rel_path: "src/runner.ts",
          to_name: "NonExistent",
          to_module: null,
          kind: "calls",
          from_global_id: 12,
        },
      ],
    });
    assert.equal(resolutions[0].to_global_id, null);
    assert.equal(resolutions[0].strategy, "unresolved");
    assert.equal(resolutions[0].confidence, 20);
  });

  it("AMBIGUOUS heuristic match drops confidence", () => {
    const dupeSymbols = [
      ...symbols,
      {
        name: "Greeter",
        global_id: 20,
        content_hash: "c".repeat(64),
        local_id: 0,
        repo_rel_path: "src/other.ts",
        kind: "class",
        qualified_name: null,
      },
    ];
    const resolutions = resolveEdges({
      allSymbols: dupeSymbols,
      importEdges: [],
      pathToBlob: new Map([...pathToBlob, ["src/other.ts", "c".repeat(64)]]),
      unresolved: [
        {
          edge_rowid: 5,
          repo_rel_path: "src/somewhere-else.ts",
          to_name: "Greeter",
          to_module: null,
          kind: "calls",
          from_global_id: 99,
        },
      ],
    });
    // 2 candidates → penalty 0.08 → 0.72 - 0.08 = 0.64 → 64.
    assert.equal(resolutions[0].confidence, 64);
    assert.equal(resolutions[0].strategy, "heuristic");
  });

  it("prefers same-file candidate over cross-file when name is ambiguous", () => {
    const dupeSymbols = [
      ...symbols,
      {
        name: "helper",
        global_id: 30,
        content_hash: "a".repeat(64),
        local_id: 9,
        repo_rel_path: "src/greeter.ts",
        kind: "function",
        qualified_name: null,
      },
      {
        name: "helper",
        global_id: 31,
        content_hash: "b".repeat(64),
        local_id: 9,
        repo_rel_path: "src/runner.ts",
        kind: "function",
        qualified_name: null,
      },
    ];
    const resolutions = resolveEdges({
      allSymbols: dupeSymbols,
      importEdges: [],
      pathToBlob,
      unresolved: [
        {
          edge_rowid: 6,
          repo_rel_path: "src/greeter.ts",
          to_name: "helper",
          to_module: null,
          kind: "calls",
          from_global_id: 10,
        },
      ],
    });
    // Same-file candidate (global_id 30) wins.
    assert.equal(resolutions[0].to_global_id, 30);
    assert.equal(resolutions[0].strategy, "name-resolved");
  });
});

// ---------------------------------------------------------------------------
// Integration: real corpus → real view → check cross-file edge resolution.
// ---------------------------------------------------------------------------

describe("resolver integration with ViewBuilder on the v2 corpus", () => {
  let tmpRoot;
  let ledger;
  let view;
  let viewPath;

  before(() => {
    tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-resolver-int-"));
    const ledgerPath = path.join(tmpRoot, "ledger.db");
    viewPath = path.join(tmpRoot, "view.db");
    ledger = Ledger.open({ dbPath: ledgerPath });

    // Parse + ingest every file in the corpus. Use parseBuffer so the
    // whole setup stays synchronous (cleaner than awaiting parseFile
    // inside a before() hook).
    const results = [];
    const stack = [CORPUS_ROOT];
    while (stack.length > 0) {
      const dir = stack.pop();
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          if (entry.name === "snapshots") continue;
          stack.push(full);
          continue;
        }
        const ext = path.extname(entry.name).toLowerCase();
        if (!sharedParserAdapter.supports(ext)) continue;
        const bytes = fs.readFileSync(full);
        const rel = path.relative(CORPUS_ROOT, full).replace(/\\/g, "/");
        results.push(parseBuffer({ bytes, repo_rel_path: rel }));
      }
    }
    // Ingest blobs + append a single "add" delta per file.
    for (const r of results) {
      ledger.ingestBlob({
        content_hash: r.content_hash,
        lang: r.lang,
        byte_size: 0,
        symbols: r.symbols,
        edges: r.edges,
      });
      ledger.append({
        branch: "main",
        op: "add",
        repo_rel_path: r.repo_rel_path,
        before_content_hash: null,
        after_content_hash: r.content_hash,
      });
    }
    // Build the view.
    const builder = new ViewBuilder();
    builder.buildFrom({
      ledger,
      branch: "main",
      atSeq: ledger.headSeq("main"),
      outPath: viewPath,
    });
    view = View.mount({ dbPath: viewPath });
  });

  after(() => {
    if (view) view.close();
    if (ledger) ledger.close();
    try {
      fs.rmSync(tmpRoot, { recursive: true, force: true });
    } catch {
      // Windows handle release lag.
    }
  });

  it("resolves runner.ts's `new Greeter()` to greeter.ts:Greeter", () => {
    // Find the Greeter symbol from src/greeter.ts.
    const greeterMatches = view.query.findSymbol("Greeter", { fuzzy: false, limit: 10 })
      .filter((s) => s.repo_rel_path === "src/greeter.ts" && s.kind === "class");
    assert.equal(greeterMatches.length, 1);
    const greeter = greeterMatches[0];
    // Find run() in src/runner.ts.
    const runners = view.query.findSymbol("run", { fuzzy: false, limit: 10 })
      .filter((s) => s.repo_rel_path === "src/runner.ts" && s.kind === "function");
    assert.equal(runners.length, 1);
    const run = runners[0];
    // run() should have at least one callee that resolves to Greeter.
    const callees = view.query.callees(run.global_id);
    const resolvedToGreeter = callees.filter((e) => e.to_global_id === greeter.global_id);
    assert.ok(
      resolvedToGreeter.length > 0,
      `expected run() → Greeter, got: ${callees.map((e) => `${e.to_name}#${e.to_global_id}`).join(", ")}`,
    );
  });

  it("Greeter symbol now has callers (run() calls into it)", () => {
    const greeter = view.query
      .findSymbol("Greeter", { fuzzy: false, limit: 10 })
      .filter((s) => s.repo_rel_path === "src/greeter.ts" && s.kind === "class")[0];
    assert.ok(greeter);
    const callers = view.query.callers(greeter.global_id);
    assert.ok(callers.length > 0, "Greeter should have at least one caller after resolution");
    const callerGids = callers.map((c) => c.from_global_id);
    const callerSyms = callerGids.map((g) => view.query.getSymbol(g)?.name).filter(Boolean);
    assert.ok(callerSyms.includes("run"), `expected run() in callers, got ${callerSyms.join(",")}`);
  });

  it("unresolved edges retain to_name and have lower confidence", () => {
    // Pick any edge that didn't bind (e.g. a built-in like `String` in Rust impl).
    const unresolved = view.query.unresolvedReferencesTo("String");
    if (unresolved.length === 0) return; // corpus didn't produce one; not a failure
    for (const e of unresolved) {
      assert.equal(e.to_global_id, null);
      assert.ok(e.confidence <= 20, `unresolved edge should have low confidence, got ${e.confidence}`);
    }
  });
});
