import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ParseStateRegistry } from "../lib/domains/atlas/classes/v2/ParseStateRegistry.js";
import { renderParseBand } from "../lib/domains/ui/functions/display/parse-band.js";
import { truncateParseProgressLine } from "../lib/domains/ui/functions/display/helpers/parse-progress.js";

describe("Atlas parse display band", () => {
  it("collapses when no parse or ONNX work is active", () => {
    const registry = new ParseStateRegistry();
    registry.record({ kind: "atlas.parse.parse.completed", lang: "ts", status: "indexed" });

    assert.deepEqual(renderParseBand({ rows: registry.active() }), []);
  });

  it("renders parse progress and keeps ONNX as compact background work", () => {
    const registry = new ParseStateRegistry();
    registry.record({ kind: "atlas.parse.parse.progress", lang: "php", current: 208, total: 312, file: "src/A.php" });
    registry.record({ kind: "atlas.parse.onnx.progress", mode: "initial", current: 24, total: 100, file: "src/User.php", symbol: "UserController" });

    const lines = renderParseBand({
      summary: { branch: "main", seq: 292, totals: { php: 312, ts: 248 } },
      rows: registry.active(),
    }, { width: 90, maxRows: 8 });

    assert.match(lines[0], /atlas parse  main@292  560 files  php=312 ts=248/);
    assert.ok(lines.some((line) => /parse-php\s+running\s+67% 208\/312/.test(line)));
    assert.ok(lines.some((line) => /onnx-symbols\s+background\s+24% 24\/100/.test(line)));
    assert.ok(lines.some((line) => /file=src\/User\.php symbol=UserController/.test(line)));
  });

  it("uses one canonical rows input and suppresses empty summary headers", () => {
    const lines = renderParseBand({
      rows: [{ kind: "atlas.parse.parse.progress", lang: "ts", current: 1, total: 2 }],
    }, { width: 80, maxRows: 8 });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /parse-ts\s+running\s+50% 1\/2/);
    assert.deepEqual(renderParseBand({
      events: [{ kind: "atlas.parse.parse.progress", lang: "ts", current: 1, total: 2 }],
    }), []);
  });

  it("labels unmatched parse event stages as other instead of a bare language", () => {
    const lines = renderParseBand({
      summary: { branch: "main" },
      rows: [{ kind: "atlas.parse.future.progress", lang: "ts", current: 1, total: 3 }],
    }, { width: 80, maxRows: 8 });

    assert.ok(lines.some((line) => /other-ts\s+running\s+33% 1\/3/.test(line)));
  });

  it("renders discover and merge stages explicitly", () => {
    const registry = new ParseStateRegistry();
    registry.record({ kind: "atlas.parse.discover.started" });
    registry.record({ kind: "atlas.parse.merge.started", lang: "py", current: 2, total: 4 });

    const lines = renderParseBand({
      summary: { branch: "main" },
      rows: registry.active(),
    }, { width: 80, maxRows: 8 });

    assert.ok(lines.some((line) => /discover\s+scanning/.test(line)));
    assert.ok(lines.some((line) => /merge-py\s+merging\s+50% 2\/4/.test(line)));
  });

  it("filters terminal parse events even when callers pass raw rows", () => {
    const lines = renderParseBand({
      rows: [
        { kind: "atlas.parse.scip.stage.completed", lang: "ts", status: "staged" },
        { kind: "atlas.parse.scip.stage.failed", lang: "py", status: "failed" },
        { kind: "atlas.parse.scip.stage.skipped", lang: "go", status: "skipped" },
        { kind: "atlas.parse.scip.stage.progress", lang: "php", current: 1, total: 2 },
      ],
    }, { width: 80, maxRows: 8 });

    assert.equal(lines.length, 1);
    assert.match(lines[0], /scip-php\s+staging\s+50% 1\/2/);
    assert.doesNotMatch(lines.join("\n"), /scip-ts|scip-py|scip-go/);
  });

  it("truncates parse progress text at edge widths", () => {
    assert.equal(truncateParseProgressLine("abc", 1), "a");
    assert.equal(truncateParseProgressLine("abc", 2), "a~");
    assert.equal(truncateParseProgressLine("abc", 3), "abc");
    assert.equal(truncateParseProgressLine("abc", 0), "abc");
  });
});
