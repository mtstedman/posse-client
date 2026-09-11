// @ts-check

import { createSymbolGetSourceTraversalRef } from "../../../../../shared/tools/functions/hash-adder.js";
import { buildCodeWindowMap, codeNeedWindow } from "./code.js";
import { errorEnvelope } from "./envelope.js";
import { presentSymbolGetAmbiguityChoices } from "./compact-presentation.js";
import { symbolIdOf } from "./cards.js";
import { resolveSymbolBodyTarget, symbolSourceText } from "./symbol-body-resolution.js";
import { selectSymbolRefTarget, selectSymbolTarget } from "./symbol-target.js";
import { resolveRequestedIdentifierSymbols } from "./identifier-resolution.js";

const INTERNAL_SYMBOL_GET_REASON = "symbol.get exact indexed body";
const MAX_SYMBOL_GET_AMBIGUITY_CHOICES = 20;
const MAX_SYMBOL_GET_AMBIGUITY_PATH_CHARS = 3_000;

/**
 * Read one selected symbol location through the existing bounded source path.
 * The file is deliberately passed with the stable ID so duplicate-content
 * locations cannot fall back to the first matching row.
 */
async function readSelectedBody({
  target,
  symbolId,
  view,
  versionId,
  readFile,
  repoRoot,
  ledger,
  repoId,
  config,
  readSymbolBody,
  maxTokens,
  identifiersToFind,
}) {
  return await readSymbolBody({
    view,
    versionId,
    params: {
      symbolId,
      file: target.repo_rel_path,
      reason: INTERNAL_SYMBOL_GET_REASON,
      identifiersToFind: Array.isArray(identifiersToFind) ? identifiersToFind : [],
      ...(maxTokens == null ? {} : { maxTokens }),
      expectedLines: Math.max(
        1,
        Number(target.range_end_line || 0) - Number(target.range_start_line || 0) + 1,
      ),
    },
    readFile,
    repoRoot,
    ledger,
    repoId,
    config,
  });
}

function targetSelectionError(selection, selector, versionId) {
  const action = "symbol.get";
  if (selection.status === "invalid_symbol_id") {
    return errorEnvelope({
      action,
      versionId,
      code: "invalid_symbol_id",
      message: "symbol.get requires a valid symbolId",
    });
  }
  if (selection.status === "invalid_symbol_ref") {
    return errorEnvelope({
      action,
      versionId,
      code: "invalid_symbol_ref",
      message: "symbol.get requires symbolId or symbolRef.name",
    });
  }
  if (selection.status === "invalid_path") {
    return errorEnvelope({
      action,
      versionId,
      code: "invalid_path",
      message: "symbol.get file must be a canonical repository-relative path",
      details: { requestedFile: selection.requestedFile },
    });
  }
  if (selection.status === "symbol_ref_file_mismatch") {
    return errorEnvelope({
      action,
      versionId,
      code: "symbol_ref_file_mismatch",
      message: "symbol.get file and symbolRef.file must identify the same exact repository path",
      details: {
        requestedFile: selection.requestedFile,
        symbolRefFile: selection.symbolRefFile,
      },
    });
  }
  if (selection.status === "symbol_file_mismatch") {
    return errorEnvelope({
      action,
      versionId,
      code: "symbol_file_mismatch",
      message: `Symbol ${selector} is not indexed at ${selection.requestedFile}`,
      details: {
        requestedFile: selection.requestedFile,
        availableFiles: selection.targets.map((target) => target.repo_rel_path),
      },
    });
  }
  if (selection.status === "ambiguous_symbol_ref") {
    return errorEnvelope({
      action,
      versionId,
      code: "ambiguous_symbol",
      message: `Symbol ${selector} matches multiple exact bearers; use one of the qualified names in error.details.bearers.`,
      details: { requested: selector, bearers: selection.bearers || [] },
    });
  }
  return errorEnvelope({
    action,
    versionId,
    code: "symbol_not_found",
    message: selection.bearers?.length > 0 && selection.requestedFile
      ? `No symbol found for ${selector} at ${selection.requestedFile}; exact bearers are listed in error.details.bearers.`
      : `No symbol found for ${selector}`,
    details: selection.bearers?.length > 0
      ? { requested: selector, requestedFile: selection.requestedFile || null, bearers: selection.bearers }
      : undefined,
  });
}

async function selectedBodyResolution({ view, target, readFile }) {
  if (typeof view?.query?.symbolsInFile !== "function" || typeof readFile !== "function") {
    return { target, bodyKind: null, implementationCandidates: [], source: null, symbols: [] };
  }
  let source;
  let symbols;
  try {
    source = readFile(target.repo_rel_path);
    if (source == null) return { target, bodyKind: null, implementationCandidates: [], source: null, symbols: [] };
    symbols = await view.query.symbolsInFile(target.repo_rel_path);
  } catch {
    return { target, bodyKind: null, implementationCandidates: [], source: null, symbols: [] };
  }
  return { ...resolveSymbolBodyTarget(target, symbols, source), source, symbols };
}

function mergeUnique(...values) {
  return [...new Set(values.flat().map((value) => String(value || "").trim()).filter(Boolean))];
}

function identifierAppears(text, identifier) {
  const source = String(text || "");
  const requested = String(identifier || "").trim();
  if (!source || !requested) return false;
  const tail = requested.split(/[.:/#\\]/u).at(-1) || "";
  return [requested, tail].some((value) => {
    if (!value) return false;
    const escaped = value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    return new RegExp(`(^|[^\\p{L}\\p{N}_$])${escaped}(?=$|[^\\p{L}\\p{N}_$])`, "iu").test(source);
  });
}

function symbolBodyIdentifierCoverage(body, resolution, identifiersToFind) {
  const requested = mergeUnique(Array.isArray(identifiersToFind) ? identifiersToFind : []);
  if (requested.length === 0 || !body?.data) return {};
  const data = body.data;
  const symbols = Array.isArray(resolution.symbols) ? resolution.symbols : [];
  const targetStart = Math.max(1, Number(resolution.target?.range_start_line) || 1);
  const targetEnd = Math.max(targetStart, Number(resolution.target?.range_end_line) || targetStart);
  const returnedStart = Math.max(1, Number(data.startLine) || 1);
  const returnedEnd = Math.max(returnedStart, Number(data.endLine) || returnedStart);
  const targetText = resolution.source == null ? String(data.content || "") : symbolSourceText(resolution.source, resolution.target);
  const found = [];
  const returned = [];
  for (const identifier of requested) {
    const matches = resolveRequestedIdentifierSymbols(symbols, identifier).matches;
    const withinTarget = matches.some((symbol) => (
      Number(symbol.range_start_line || 0) >= targetStart
      && Number(symbol.range_end_line || 0) <= targetEnd
    ));
    const withinReturned = matches.some((symbol) => (
      Number(symbol.range_start_line || 0) >= returnedStart
      && Number(symbol.range_end_line || 0) <= returnedEnd
    ));
    if (withinTarget || identifierAppears(targetText, identifier)) found.push(identifier);
    if (withinReturned || identifierAppears(data.content, identifier)) returned.push(identifier);
  }
  const identifiersFound = mergeUnique(data.identifiersFound || [], found);
  const identifiersReturned = mergeUnique(data.identifiersReturned || [], returned);
  const identifiersMissing = requested.filter((identifier) => !identifiersFound.includes(identifier));
  const identifiersOmitted = identifiersFound.filter((identifier) => !identifiersReturned.includes(identifier));
  const map = resolution.source != null
    ? buildCodeWindowMap({
      source: resolution.source,
      symbols,
      identifiers: requested,
      identifiersFound,
      identifiersReturned,
      inlineWindows: [{
        content: String(data.content || ""),
        startLine: returnedStart,
        endLine: returnedEnd,
      }],
    })
    : null;
  return {
    identifiersFound,
    identifiersReturned,
    identifiersMissing,
    identifiersOmitted,
    ...(map ? { map } : {}),
  };
}

function annotateSymbolBody(body, resolution, identifiersToFind = []) {
  if (body?.ok === false || !body?.data) return body;
  return {
    ...body,
    data: {
      ...body.data,
      ...symbolBodyIdentifierCoverage(body, resolution, identifiersToFind),
      ...(resolution.bodyKind ? { bodyKind: resolution.bodyKind } : {}),
      ...(resolution.implementationResolution
        ? { implementationResolution: resolution.implementationResolution }
        : {}),
      ...(resolution.bodyKind === "declaration" && resolution.implementationCandidates?.length > 0
        ? { implementationCandidates: resolution.implementationCandidates }
        : {}),
    },
  };
}

/**
 * Exact symbol body retrieval for the compact Atlas surface.
 *
 * @param {{
 *   view: import("../contracts/api.js").View,
 *   versionId: string,
 *   params: import("../contracts/tool-params.js").SymbolGetParams,
 *   readFile: (path:string) => string|null,
 *   repoRoot?: string,
 *   ledger?: import("../contracts/api.js").Ledger,
 *   repoId?: string|null,
 *   config?: Record<string, any>,
 *   hashRefContext?: Record<string, unknown>,
 *   readSymbolBody?: typeof codeNeedWindow,
 *   storeSourceTraversalRef?: (candidate:{file:string,source:unknown}) => string|{ref:string}|Promise<string|{ref:string}>,
 * }} request
 */
export async function symbolGet({
  view,
  versionId,
  params,
  readFile,
  repoRoot,
  ledger,
  repoId,
  config,
  hashRefContext = {},
  readSymbolBody = codeNeedWindow,
  storeSourceTraversalRef = null,
}) {
  const selection = params.symbolId
    ? await selectSymbolTarget({
      view,
      symbolId: params.symbolId,
      file: params.file,
    })
    : await selectSymbolRefTarget({
      view,
      symbolRef: params.symbolRef,
      file: params.file,
    });
  const selector = params.symbolId || params.symbolRef?.name || "";
  if (selection.status !== "selected" && selection.status !== "ambiguous") {
    return targetSelectionError(selection, selector, versionId);
  }

  if (selection.status === "selected") {
    const resolution = await selectedBodyResolution({ view, target: selection.target, readFile });
    const body = await readSelectedBody({
      target: resolution.target,
      symbolId: symbolIdOf(resolution.target),
      view,
      versionId,
      readFile,
      repoRoot,
      ledger,
      repoId,
      config,
      readSymbolBody,
      maxTokens: params.maxTokens,
      identifiersToFind: params.identifiersToFind,
    });
    return { ...annotateSymbolBody(body, resolution, params.identifiersToFind), action: "symbol.get" };
  }

  const ambiguityPathChars = selection.targets.reduce((total, target) => (
    total + String(target.repo_rel_path || "").length
  ), 0);
  if (selection.targets.length > MAX_SYMBOL_GET_AMBIGUITY_CHOICES
    || ambiguityPathChars > MAX_SYMBOL_GET_AMBIGUITY_PATH_CHARS) {
    return errorEnvelope({
      action: "symbol.get",
      versionId,
      code: "symbol_ambiguity_too_large",
      message: "This symbol ID has too many indexed file copies to return safely; call symbol.get again with an exact file path.",
      details: {
        matchCount: selection.targets.length,
        maxChoices: MAX_SYMBOL_GET_AMBIGUITY_CHOICES,
      },
    });
  }

  const candidates = [];
  for (const target of selection.targets) {
    const resolution = await selectedBodyResolution({ view, target, readFile });
    const body = await readSelectedBody({
      target: resolution.target,
      symbolId: symbolIdOf(resolution.target),
      view,
      versionId,
      readFile,
      repoRoot,
      ledger,
      repoId,
      config,
      readSymbolBody,
      maxTokens: params.maxTokens,
      identifiersToFind: params.identifiersToFind,
    });
    if (body?.ok === false || !body?.data) return { ...body, action: "symbol.get" };
    candidates.push({
      file: target.repo_rel_path,
      source: annotateSymbolBody(body, resolution, params.identifiersToFind).data,
    });
  }

  try {
    const choices = await presentSymbolGetAmbiguityChoices(candidates, {
      storeSourceTraversalRef: storeSourceTraversalRef || ((choice) => {
        const ref = createSymbolGetSourceTraversalRef(choice, {
          context: hashRefContext,
          symbolId: params.symbolId || null,
        });
        return ref || "";
      }),
    });
    return { ok: true, action: "symbol.get", versionId, data: choices };
  } catch (error) {
    return errorEnvelope({
      action: "symbol.get",
      versionId,
      code: String(error?.code || "source_traversal_unavailable"),
      message: String(error?.message || "Could not store ambiguous symbol source choices"),
    });
  }
}
