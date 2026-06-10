import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "fs";
import os from "os";
import path from "path";

import {
  findNodesByType,
  lineForIndex,
  lineRangeForNode,
  nodeText,
  parseRetrievalAst,
  smallestNodeCoveringRange,
  sourceLines,
} from "../lib/domains/atlas/functions/v2/retrieval/ast.js";

describe("ATLAS v2 retrieval AST helpers", () => {
  it("parses a repo file and exposes stable line utilities", (t) => {
    const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-ast-"));
    t.after(() => {
      try { fs.rmSync(repoRoot, { recursive: true, force: true }); } catch { /* Windows may hold handles briefly. */ }
    });
    fs.mkdirSync(path.join(repoRoot, "src"), { recursive: true });
    const source = [
      "export function alpha() {",
      "  return 1;",
      "}",
      "",
      "const beta = alpha();",
      "",
    ].join("\n");
    fs.writeFileSync(path.join(repoRoot, "src", "sample.ts"), source, "utf8");

    const parsed = parseRetrievalAst({ repoRoot, file: "src/sample.ts" });
    if (!parsed.ok && parsed.errorCode === "parser_unavailable") {
      t.skip(parsed.message);
      return;
    }
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
    const doc = parsed.doc;
    assert.equal(doc.repoRelPath, "src/sample.ts");
    assert.equal(doc.lang, "ts");
    assert.equal(doc.hasError, false);
    assert.equal(lineForIndex(doc.lineStarts, source.indexOf("beta")), 5);
    assert.equal(sourceLines(doc, 1, 1), "export function alpha() {");

    const [fn] = findNodesByType(doc, "function_declaration");
    assert.ok(fn);
    assert.deepEqual(lineRangeForNode(doc, fn), { startLine: 1, endLine: 3 });
    assert.match(nodeText(doc, fn), /^function alpha/);
    assert.equal(
      smallestNodeCoveringRange(doc, fn.startIndex, fn.endIndex, { namedOnly: true }).type,
      "function_declaration",
    );
  });

  it("returns structured degradation for unsupported paths", () => {
    const parsed = parseRetrievalAst({ file: "README.txt", source: "plain text" });
    assert.equal(parsed.ok, false);
    assert.equal(parsed.errorCode, "unsupported_language");
  });

  it("surfaces parser error state without throwing", (t) => {
    const parsed = parseRetrievalAst({
      file: "src/broken.ts",
      source: "export function broken( {",
    });
    if (!parsed.ok && parsed.errorCode === "parser_unavailable") {
      t.skip(parsed.message);
      return;
    }
    assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.message);
    assert.equal(parsed.doc.hasError, true);
  });
});
