// @ts-check
//
// Preview-only edit planning. This gives agents a structured way to propose
// symbol/file-scoped edits with preconditions before using scoped write tools.

import { sha256Hex } from "../hash.js";
import { isCanonicalRepoPath } from "../paths.js";
import { parseSymbolId, symbolIdOf, etagOf } from "./cards.js";
import { okEnvelope } from "./envelope.js";

/** @typedef {import("../contracts/api.js").View} View */
/** @typedef {import("../contracts/api.js").ViewSymbol} ViewSymbol */
/** @typedef {import("../contracts/tool-params.js").EditPlanParams} EditPlanParams */
/** @typedef {import("../contracts/tool-results.js").EditPlanData} EditPlanData */

/**
 * @param {{ view: View, versionId: string, params: EditPlanParams }} args
 * @returns {ReturnType<typeof okEnvelope<EditPlanData>>}
 */
export function editPlan({ view, versionId, params }) {
  const maxEdits = clampInt(params.maxEdits, 1, 500, 25);
  const operation = normalizeOperation(params.operation, params);
  const warnings = [];
  const symbols = resolveSymbols({ view, params, warnings });
  const explicitFiles = new Set((params.targetFiles || []).filter(isCanonicalRepoPath));
  const files = new Set(explicitFiles);
  for (const symbol of symbols) files.add(symbol.repo_rel_path);
  if (files.size === 0 && params.search) {
    for (const symbol of view.query.findSymbol(params.search, { fuzzy: true, limit: Math.min(maxEdits, 25) })) {
      symbols.push(symbol);
      files.add(symbol.repo_rel_path);
    }
  }
  if (symbols.length === 0 && files.size === 0) {
    warnings.push("No target symbols or files resolved; pass targetSymbols, targetFiles, or a more specific search.");
  }

  const edits = [];
  const seen = new Set();
  for (const symbol of symbols) {
    const key = `sym:${symbol.global_id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    edits.push(editForSymbol({ symbol, operation, search: params.search, replace: params.replace, versionId }));
    if (edits.length >= maxEdits) break;
  }
  if (edits.length < maxEdits) {
    for (const filePath of explicitFiles) {
      const key = `file:${filePath}`;
      if (seen.has(key)) continue;
      seen.add(key);
      edits.push(editForFile({ filePath, operation, search: params.search, replace: params.replace, versionId }));
      if (edits.length >= maxEdits) break;
    }
  }

  const planId = `ep_${sha256Hex(JSON.stringify({
    versionId,
    operation,
    taskText: params.taskText || "",
    search: params.search || "",
    replace: params.replace || "",
    edits: edits.map((edit) => edit.editId),
  })).slice(0, 16)}`;
  return okEnvelope({
    action: "edit.plan",
    versionId,
    data: {
      planId,
      previewOnly: true,
      edits,
      coverage: {
        files: files.size,
        symbols: new Set(symbols.map((symbol) => symbol.global_id)).size,
      },
      warnings,
      nextActions: ["code.skeleton", "code.lens", "file.read"],
    },
  });
}

/**
 * @param {{ view: View, params: EditPlanParams, warnings: string[] }} args
 * @returns {ViewSymbol[]}
 */
function resolveSymbols({ view, params, warnings }) {
  /** @type {ViewSymbol[]} */
  const out = [];
  const seen = new Set();
  const add = (symbol) => {
    if (!symbol || seen.has(symbol.global_id)) return;
    seen.add(symbol.global_id);
    out.push(symbol);
  };
  for (const id of params.targetSymbols || []) {
    const parsed = parseSymbolId(id);
    if (!parsed) {
      warnings.push(`Ignored malformed target symbol: ${id}`);
      continue;
    }
    const symbol = view.query.getByContentLocal(parsed.content_hash, parsed.local_id);
    if (symbol) add(symbol);
    else warnings.push(`Target symbol was not found in the current view: ${id}`);
  }
  for (const filePath of params.targetFiles || []) {
    if (!isCanonicalRepoPath(filePath)) {
      warnings.push(`Ignored non-canonical target file: ${filePath}`);
      continue;
    }
    for (const symbol of view.query.symbolsInFile(filePath)) add(symbol);
  }
  return out;
}

/**
 * @param {{ symbol: ViewSymbol, operation: string, search?: string, replace?: string, versionId: string }} args
 */
function editForSymbol({ symbol, operation, search, replace, versionId }) {
  const symbolId = symbolIdOf(symbol);
  return {
    editId: `ed_${sha256Hex(`${versionId}:${symbolId}:${operation}:${search || ""}:${replace || ""}`).slice(0, 16)}`,
    operation,
    repo_rel_path: symbol.repo_rel_path,
    symbolId,
    symbolName: symbol.name,
    search: search || symbol.signature_text || symbol.name,
    replace: replace || null,
    precondition: {
      versionId,
      symbolEtag: etagOf(symbol),
      contentHash: symbol.content_hash,
      rangeStart: symbol.range_start,
      rangeEnd: symbol.range_end,
    },
    confidence: search ? 0.75 : 0.6,
    rationale: `Preview ${operation} scoped to symbol ${symbol.name}.`,
  };
}

/**
 * @param {{ filePath: string, operation: string, search?: string, replace?: string, versionId: string }} args
 */
function editForFile({ filePath, operation, search, replace, versionId }) {
  return {
    editId: `ed_${sha256Hex(`${versionId}:${filePath}:${operation}:${search || ""}:${replace || ""}`).slice(0, 16)}`,
    operation,
    repo_rel_path: filePath,
    symbolId: null,
    symbolName: null,
    search: search || null,
    replace: replace || null,
    precondition: {
      versionId,
      filePath,
    },
    confidence: search ? 0.55 : 0.35,
    rationale: `Preview ${operation} scoped to file ${filePath}.`,
  };
}

/**
 * @param {unknown} value
 * @param {EditPlanParams} params
 */
function normalizeOperation(value, params) {
  const text = String(value || "").trim();
  if (["replace", "insert", "delete", "inspect"].includes(text)) return text;
  if (params.search && params.replace != null) return "replace";
  if (params.search && params.replace == null) return "inspect";
  return "inspect";
}

function clampInt(value, min, max, fallback) {
  const n = Number.parseInt(String(value ?? ""), 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}
