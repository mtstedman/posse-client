import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { View } from "../../lib/domains/atlas/classes/v2/View.js";
import { dispatch } from "../../lib/domains/atlas/functions/v2/retrieval/index.js";
import { sha256Hex } from "../../lib/domains/atlas/functions/v2/hash.js";

export const RETRIEVAL_PARITY_BASELINE_VERSION = 1;

const PARITY_SOURCE = `export function alpha(user) {
  audit("alpha");
  const literal = "STRING_ONLY_NEEDLE";
  // COMMENT_ONLY_NEEDLE
  return beta(user.id);
}

function beta(id) {
  return id.trim();
}

export class Service {
  start() {
    return alpha({ id: "x" });
  }

  stop() {
    return "stop";
  }
}

export const CONFIG = { enabled: true };
`;

const GRAPH_SOURCE = `export function Entry() {}
export function HighCall() {}
export function LowConfidenceCall() {}
export interface ImplementsPeer {}
export class ExtendsPeer {}
export function ImportPeer() {}
export function ReferencePeer() {}
export function SecondHop() {}
`;

export function createRetrievalParityFixture() {
  const repoRoot = fs.mkdtempSync(path.join(os.tmpdir(), "atlas-v2-parity-"));
  const srcDir = path.join(repoRoot, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, "parity.ts"), PARITY_SOURCE, "utf8");
  fs.writeFileSync(path.join(srcDir, "graph.ts"), GRAPH_SOURCE, "utf8");

  const viewPath = path.join(repoRoot, ".posse", "atlas", "parity.view.db");
  const view = new View({ dbPath: viewPath, mode: "readwrite" });
  seedView(view, repoRoot);
  return {
    repoRoot,
    view,
    versionId: "main@7",
    symbolIds: {
      alpha: `${sha256Hex(PARITY_SOURCE)}:0`,
      Entry: `${sha256Hex(GRAPH_SOURCE)}:0`,
    },
  };
}

export function destroyRetrievalParityFixture(fixture) {
  try { fixture?.view?.close?.(); } catch {}
  if (fixture?.repoRoot) fs.rmSync(fixture.repoRoot, { recursive: true, force: true });
}

export function collectRetrievalParityMetrics(fixture) {
  const ctx = {
    view: fixture.view,
    versionId: fixture.versionId,
    repoRoot: fixture.repoRoot,
  };
  const skeleton = mustOk(dispatch(
    /** @type {any} */ ({
      action: "code.getSkeleton",
      file: "src/parity.ts",
      exportedOnly: true,
      identifiersToFind: ["alpha"],
      maxLines: 100,
    }),
    ctx,
  ));
  const hotPath = mustOk(dispatch(
    /** @type {any} */ ({
      action: "code.getHotPath",
      file: "src/parity.ts",
      identifiersToFind: ["beta", "STRING_ONLY_NEEDLE", "COMMENT_ONLY_NEEDLE"],
      contextLines: 0,
    }),
    ctx,
  ));
  const slice = mustOk(dispatch(
    /** @type {any} */ ({
      action: "slice.build",
      entrySymbols: [fixture.symbolIds.Entry],
      budget: { maxCards: 6, maxEstimatedTokens: 5000 },
      cardDetail: "minimal",
    }),
    ctx,
  ));

  const skeletonLines = String(skeleton.data.content || "").split(/\r?\n/).filter(Boolean);
  const skeletonContent = String(skeleton.data.content || "");
  const hotIdentifiers = [...hotPath.data.identifiersFound].sort();
  const hotLineByIdentifier = Object.fromEntries(
    hotPath.data.matches.map((match) => [match.identifier, match.line]),
  );
  const sliceCardNames = slice.data.cards.map((card) => card.name);

  return {
    baselineVersion: RETRIEVAL_PARITY_BASELINE_VERSION,
    skeleton: {
      lineCount: skeletonLines.length,
      startLine: skeleton.data.startLine,
      endLine: skeleton.data.endLine,
      hasBodyElisionMarker: skeletonLines.some((line) => line.includes("...")),
      identifiersFilterHonored: /\balpha\b/.test(skeletonContent)
        && !/\b(beta|Service|CONFIG)\b/.test(skeletonContent),
      firstLine: skeletonLines[0] || "",
    },
    hotPath: {
      identifiersFound: hotIdentifiers,
      falsePositiveIdentifiers: hotIdentifiers.filter((name) => name.includes("NEEDLE")),
      lineByIdentifier: hotLineByIdentifier,
      matchCount: hotPath.data.matches.length,
    },
    slice: {
      cardNames: sliceCardNames,
      totalCardCount: slice.data.totalCardCount,
      hasFrontier: Array.isArray(slice.data.frontier),
      truncated: slice.data.truncated,
      includesLowConfidenceInTotal: slice.data.totalCardCount > 7,
    },
  };
}

function seedView(view, repoRoot) {
  const db = view._unsafeDb();
  db.exec("DELETE FROM meta");
  const meta = db.prepare("INSERT INTO meta(key, value) VALUES(?, ?)");
  for (const [key, value] of [
    ["schema_version", "1"],
    ["branch", "main"],
    ["ledger_seq", "7"],
    ["built_at", "2026-05-26T00:00:00.000Z"],
    ["repo_root", repoRoot],
  ]) {
    meta.run(key, value);
  }

  db.exec("DELETE FROM path_to_blob");
  db.exec("DELETE FROM symbols");
  db.exec("DELETE FROM edges");

  const parityHash = sha256Hex(PARITY_SOURCE);
  const graphHash = sha256Hex(GRAPH_SOURCE);
  db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run("src/parity.ts", parityHash);
  db.prepare("INSERT INTO path_to_blob(repo_rel_path, content_hash) VALUES(?, ?)").run("src/graph.ts", graphHash);

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

  const alpha = symbol(insertSymbol, parityHash, 0, "function", "alpha", null, null, "src/parity.ts", "export function alpha", "}", "public");
  symbol(insertSymbol, parityHash, 1, "function", "beta", null, null, "src/parity.ts", "function beta", "}", "private");
  const service = symbol(insertSymbol, parityHash, 2, "class", "Service", null, null, "src/parity.ts", "export class Service", "}", "public");
  symbol(insertSymbol, parityHash, 3, "method", "start", "Service.start", service, "src/parity.ts", "start()", "}", "public");
  symbol(insertSymbol, parityHash, 4, "method", "stop", "Service.stop", service, "src/parity.ts", "stop()", "}", "public");
  symbol(insertSymbol, parityHash, 5, "const", "CONFIG", null, null, "src/parity.ts", "export const CONFIG", ";", "public");

  const entry = symbol(insertSymbol, graphHash, 0, "function", "Entry", null, null, "src/graph.ts", "Entry", "{}", "public");
  const highCall = symbol(insertSymbol, graphHash, 1, "function", "HighCall", null, null, "src/graph.ts", "HighCall", "{}", "public");
  const low = symbol(insertSymbol, graphHash, 2, "function", "LowConfidenceCall", null, null, "src/graph.ts", "LowConfidenceCall", "{}", "public");
  const impl = symbol(insertSymbol, graphHash, 3, "interface", "ImplementsPeer", null, null, "src/graph.ts", "ImplementsPeer", "{}", "public");
  const ext = symbol(insertSymbol, graphHash, 4, "class", "ExtendsPeer", null, null, "src/graph.ts", "ExtendsPeer", "{}", "public");
  const imp = symbol(insertSymbol, graphHash, 5, "function", "ImportPeer", null, null, "src/graph.ts", "ImportPeer", "{}", "public");
  const ref = symbol(insertSymbol, graphHash, 6, "function", "ReferencePeer", null, null, "src/graph.ts", "ReferencePeer", "{}", "public");
  const secondHop = symbol(insertSymbol, graphHash, 7, "function", "SecondHop", null, null, "src/graph.ts", "SecondHop", "{}", "public");

  insertEdge.run(alpha, null, "beta", "calls", "src/parity.ts", 0, 10, 95);
  insertEdge.run(entry, highCall, "HighCall", "calls", "src/graph.ts", 0, 10, 95);
  insertEdge.run(entry, low, "LowConfidenceCall", "calls", "src/graph.ts", 0, 10, 20);
  insertEdge.run(entry, impl, "ImplementsPeer", "implements", "src/graph.ts", 0, 10, 90);
  insertEdge.run(entry, ext, "ExtendsPeer", "extends", "src/graph.ts", 0, 10, 85);
  insertEdge.run(entry, imp, "ImportPeer", "imports", "src/graph.ts", 0, 10, 60);
  insertEdge.run(entry, ref, "ReferencePeer", "references", "src/graph.ts", 0, 10, 50);
  insertEdge.run(highCall, secondHop, "SecondHop", "calls", "src/graph.ts", 0, 10, 95);
}

function symbol(stmt, hash, localId, kind, name, qualified, parentGlobalId, file, startNeedle, endNeedle, visibility) {
  const source = file.endsWith("graph.ts") ? GRAPH_SOURCE : PARITY_SOURCE;
  const start = Math.max(0, source.indexOf(startNeedle));
  const endAt = source.indexOf(endNeedle, start);
  const end = endAt >= 0 ? endAt + endNeedle.length : start + name.length;
  const result = stmt.run(
    hash,
    localId,
    kind,
    name,
    qualified,
    parentGlobalId,
    file,
    start,
    end,
    sha256Hex(`${kind}:${name}:${localId}`),
    visibility,
    null,
    "ts",
  );
  return Number(result.lastInsertRowid);
}

function mustOk(result) {
  if (!result || result.ok !== true) {
    throw new Error(result?.error?.message || result?.error?.code || "ATLAS parity harness call failed");
  }
  return result;
}
