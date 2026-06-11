import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyAtlasPrefetchRelevance, renderAtlasHandoffSections, resolveAtlasPrefetchPlan } from "../lib/domains/handoff/functions/helpers/atlas-context.js";
import { normalizeResearcherKeySymbols, parseResearcherStructuredOutput } from "../lib/domains/handoff/functions/helpers/researcher-output.js";

function packetWithSlice(taskText, slice) {
  return {
    recipient: "planner",
    atlas: { active: true },
    _raw_payload: { task_spec: taskText },
    atlas_slice_context: {
      ok: true,
      ...slice,
    },
  };
}

describe("ATLAS prefetch relevance classification", () => {
  it("does not treat an unrelated nonempty slice as relevant", () => {
    const packet = packetWithSlice(
      "Trace how a featured-broadcast decision propagates from the PHP backend to the React homepage",
      {
        cardCount: 2,
        filePaths: ["tests/encoder-relay.test.php"],
        cards: [
          {
            name: "EncoderRelayTest",
            file: "tests/encoder-relay.test.php",
            summary: "Covers encoder relay fixture behavior.",
          },
        ],
      },
    );

    assert.equal(classifyAtlasPrefetchRelevance(packet, "planner"), false);
  });

  it("accepts an unscoped slice with task-token overlap", () => {
    const packet = packetWithSlice(
      "Trace how a featured-broadcast decision propagates from the PHP backend to the React homepage",
      {
        cardCount: 2,
        filePaths: ["app/FeaturedBroadcastDecision.php"],
        cards: [
          {
            name: "FeaturedBroadcastDecision",
            file: "app/FeaturedBroadcastDecision.php",
            summary: "Selects the featured broadcast for the homepage.",
          },
        ],
      },
    );

    assert.equal(classifyAtlasPrefetchRelevance(packet, "planner"), true);
  });
});

describe("ATLAS slice section tree-scope rendering", () => {
  it("renders the tree scope areas and compressed-tree matches above the cards", () => {
    const packet = packetWithSlice(
      "Trace the flow upload pipeline",
      {
        sliceHandle: "sl_test",
        cardCount: 1,
        filePaths: ["apps/web/src/flows/upload.ts"],
        cards: [{ name: "uploadFlow", file: "apps/web/src/flows/upload.ts", summary: "Handles uploads." }],
        treeScope: {
          ok: true,
          candidateFiles: ["apps/web/src/flows/upload.ts"],
          candidateDirs: ["apps/web/src/flows"],
          scopeRisk: "low",
          confidence: "high",
          compressionSeeds: [
            { path: "apps/web/src/flows", label: "flow builder and upload pipeline", confidence: "high", hits: 2, entrypoints: ["apps/web/src/flows/upload.ts"] },
          ],
        },
      },
    );

    const text = renderAtlasHandoffSections(packet);
    assert.match(text, /Tree scope \(deterministic candidate scope seeded into this slice; risk=low, confidence=high\)/);
    assert.match(text, /- areas: apps\/web\/src\/flows/);
    assert.match(text, /compressed-tree area matches:/);
    assert.match(text, /apps\/web\/src\/flows — flow builder and upload pipeline \(entry: apps\/web\/src\/flows\/upload.ts\)/);
  });

  it("renders a tree-sourced prefetch as TREE SCOPE PRUNING without slice fields", () => {
    const packet = packetWithSlice(
      "Trace the flow upload pipeline",
      {
        source: "tree.scope",
        sliceHandle: null,
        cardCount: 0,
        cards: [],
        filePaths: ["apps/web/src/flows/upload.ts"],
        treeScope: {
          ok: true,
          candidateFiles: ["apps/web/src/flows/upload.ts"],
          candidateDirs: ["apps/web/src/flows"],
          scopeRisk: "low",
          confidence: "high",
          compressionSeeds: [],
          areaMap: [
            { path: "apps/web/src/flows", label: "flow builder and upload pipeline", confidence: "high" },
            { path: "www/includes/classes/Media", label: "media upload policy", confidence: "high" },
          ],
        },
      },
    );

    const text = renderAtlasHandoffSections(packet);
    assert.match(text, /TREE SCOPE PRUNING/);
    assert.doesNotMatch(text, /Slice handle/);
    assert.match(text, /Repo area map \(compressed tree; drill into a branch with .*tree\.walk.* \{path, maxDepth\}\):/);
    assert.match(text, /- www\/includes\/classes\/Media — media upload policy/);
    assert.match(text, /Tree-ranked candidate files \(not prefetched\):/);
    assert.match(text, /Use the tree scope above before escalating to raw file reads\./);
  });

  it("classifies a tree-sourced prefetch with task-token overlap as relevant", () => {
    const packet = packetWithSlice(
      "Review upload handling in the flows routes",
      {
        source: "tree.scope",
        cards: [],
        filePaths: ["apps/web/src/flows/upload.ts"],
        rankedFiles: ["apps/web/src/flows/upload.ts"],
      },
    );
    assert.equal(classifyAtlasPrefetchRelevance(packet, "planner"), true);
  });

  it("renders a tree.scope failure line without hiding the slice", () => {
    const packet = packetWithSlice(
      "Trace the flow upload pipeline",
      {
        sliceHandle: "sl_test",
        cardCount: 0,
        filePaths: [],
        cards: [],
        treeScope: { ok: false, error: "tree_derived_tables_missing" },
      },
    );

    const text = renderAtlasHandoffSections(packet);
    assert.match(text, /tree\.scope prefetch failed: tree_derived_tables_missing/);
    assert.match(text, /SLICE PRUNING/);
  });

  it("renders brief key-symbol cards and the pre-expanded blurb for planner/dev", () => {
    const packet = packetWithSlice(
      "Trace the flow upload pipeline",
      {
        source: "tree.grow",
        cardCount: 0,
        cards: [],
        filePaths: ["apps/web/src/flows/upload.ts"],
        seedSymbolCards: [
          { name: "uploadFlow", kind: "function", file: "apps/web/src/flows/upload.ts", startLine: 12, summary: "Handles media uploads.", signature: "uploadFlow(input) → Promise<Flow>" },
        ],
        treeScope: { ok: true, action: "tree.grow", candidateFiles: ["apps/web/src/flows/upload.ts"], candidateDirs: [], compressionSeeds: [], areaMap: [] },
      },
    );
    packet.recipient = "dev";

    const text = renderAtlasHandoffSections(packet);
    assert.match(text, /TREE SCOPE PRUNING/);
    assert.match(text, /Brief key symbols \(research-validated, cards prefetched\):/);
    assert.match(text, /uploadFlow/);
    assert.match(text, /The seeds above are pre-expanded from the brief; call tree\.grow only for files you newly validate\./);
  });
});

describe("role-graded prefetch plan", () => {
  const basePacket = (recipient, extra = {}) => ({
    recipient,
    cwd: null, // no cwd → lexical scan and on-disk reference checks are inert
    _raw_payload: { task_spec: "Fix the upload flow" },
    ...extra,
  });

  it("researcher gets the broad task-text scope", () => {
    const plan = resolveAtlasPrefetchPlan(basePacket("researcher"));
    assert.equal(plan.mode, "broad");
    assert.equal(plan.action, "tree.scope");
    assert.equal(plan.useTaskText, true);
  });

  it("planner with validated seeds keeps task text but drops lexical guessing", () => {
    const plan = resolveAtlasPrefetchPlan(basePacket("planner", {
      context_hints: { atlas_seed_files: ["apps/web/src/flows/upload.ts"] },
    }));
    assert.equal(plan.mode, "planner-seeded");
    assert.equal(plan.action, "tree.scope");
    assert.equal(plan.useTaskText, true);
    assert.deepEqual(plan.seedFiles, ["apps/web/src/flows/upload.ts"]);
  });

  it("dev with an edit set grows seed-only (no task text)", () => {
    const plan = resolveAtlasPrefetchPlan(basePacket("dev", {
      files_to_modify: ["apps/web/src/flows/upload.ts", "apps/web/src/lib/types.ts"],
    }));
    assert.equal(plan.mode, "dev-grow");
    assert.equal(plan.action, "tree.grow");
    assert.equal(plan.useTaskText, false);
    assert.deepEqual(plan.seedFiles, ["apps/web/src/flows/upload.ts", "apps/web/src/lib/types.ts"]);
  });

  it("dev without any file scope falls back to the broad scope", () => {
    const plan = resolveAtlasPrefetchPlan(basePacket("dev"));
    assert.equal(plan.mode, "broad");
    assert.equal(plan.action, "tree.scope");
    assert.equal(plan.useTaskText, true);
  });
});

describe("researcher key_symbols contract", () => {
  const SYMBOL = `${"a".repeat(64)}:3`;

  it("recognizes a key_symbols-only appendix and normalizes ids", () => {
    const parsed = parseResearcherStructuredOutput(`Brief text.\n\`\`\`json\n${JSON.stringify({ key_symbols: [SYMBOL] })}\n\`\`\``);
    assert.ok(parsed);
    assert.deepEqual(normalizeResearcherKeySymbols(parsed), [SYMBOL]);
  });

  it("drops malformed symbol ids instead of discarding the list", () => {
    const symbols = normalizeResearcherKeySymbols({
      key_symbols: ["not-a-symbol", SYMBOL, { symbolId: SYMBOL }, { symbolId: "also/bad" }],
    });
    assert.deepEqual(symbols, [SYMBOL]);
  });
});
