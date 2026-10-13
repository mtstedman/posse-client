import path from "node:path";
import { researcherTypedLanguageLeversForRootEntries } from "../../../domains/integrations/functions/deterministic-mcp/researcher-dispatcher.js";
import fs from "node:fs";

export function normalizeTypedSymbolBodyRoute(action, supplied = {}) {
  if (action !== "code.window" || (supplied.granularity != null && supplied.granularity !== "symbol")) {
    return { action, supplied, transforms: [] };
  }
  const hasSymbolId = typeof supplied.symbolId === "string" && supplied.symbolId.trim() !== "";
  const hasSymbolRef = supplied.symbolRef
    && typeof supplied.symbolRef === "object"
    && !Array.isArray(supplied.symbolRef)
    && typeof supplied.symbolRef.name === "string"
    && supplied.symbolRef.name.trim() !== "";
  if (!hasSymbolId && !hasSymbolRef) return { action, supplied, transforms: [] };
  const {
    reason: _reason,
    granularity: _granularity,
    expectedLines: _expectedLines,
    autoFill: _autoFill,
    ...symbolGetArgs
  } = supplied;
  return {
    action: "symbol.get",
    supplied: symbolGetArgs,
    transforms: [{
      kind: "atlas_symbol_body_route",
      requested_action: "code.window",
      effective_action: "symbol.get",
      selector: hasSymbolId ? "symbolId" : "symbolRef",
    }],
  };
}

export function normalizeTypedFilenameWindowAnchor(action, supplied = {}) {
  if (
    action !== "code.window"
    || typeof supplied.file !== "string"
    || !Array.isArray(supplied.identifiersToFind)
    || supplied.identifiersToFind.length === 0
  ) {
    return { supplied, transforms: [] };
  }
  const basename = path.posix.basename(supplied.file.replace(/\\/g, "/"));
  const filenameAnchors = new Set([basename.toLowerCase()]);
  const identifiers = supplied.identifiersToFind
    .map((value) => String(value || "").trim())
    .filter(Boolean);
  const retained = identifiers.filter((identifier) => !filenameAnchors.has(identifier.toLowerCase()));
  if (retained.length === identifiers.length) return { supplied, transforms: [] };
  return {
    supplied: {
      ...supplied,
      identifiersToFind: retained,
    },
    transforms: [{
      kind: "atlas_typed_call_cleanup",
      cleanup: "drop_filename_as_symbol_anchor",
      repo_rel_path: supplied.file,
      dropped_identifiers: identifiers.filter((identifier) => !retained.includes(identifier)),
    }],
  };
}

export function normalizeTypedFileWindowOrientation(action, supplied = {}) {
  if (
    action !== "code.window"
    || typeof supplied.file !== "string"
    || supplied.file.trim() === ""
    || supplied.granularity !== "fileWindow"
    || supplied.symbolId != null
    || (Array.isArray(supplied.identifiersToFind) && supplied.identifiersToFind.length > 0)
    || Object.keys(supplied).some((field) => ![
      "autoFill",
      "file",
      "granularity",
      "identifiersToFind",
      "maxTokens",
    ].includes(field))
  ) {
    return { action, supplied, transforms: [] };
  }
  return {
    action: "code.skeleton",
    supplied: {
      file: supplied.file,
      ...(supplied.maxTokens == null ? {} : { maxTokens: supplied.maxTokens }),
    },
    transforms: [{
      kind: "atlas_typed_call_cleanup",
      cleanup: "window_file_only_to_skeleton_orientation",
    }],
  };
}

export function researcherTypedLanguageLeversForSession(session) {
  const cwd = String(session?.bootConfig?.cwd || "").trim();
  if (!cwd) return researcherTypedLanguageLeversForRootEntries([]);
  try {
    return researcherTypedLanguageLeversForRootEntries(fs.readdirSync(cwd));
  } catch {
    return researcherTypedLanguageLeversForRootEntries([]);
  }
}

export function normalizeTypedAnchoredFileWindowBudget(session, action, supplied = {}) {
  const maxTokens = researcherTypedLanguageLeversForSession(session).anchoredFileWindowMaxTokens;
  const requestedMaxTokens = Number(supplied.maxTokens);
  if (
    action !== "code.window"
    || !Number.isInteger(maxTokens)
    || maxTokens <= 0
    || typeof supplied.file !== "string"
    || supplied.file.trim() === ""
    || supplied.symbolId != null
    || !Array.isArray(supplied.identifiersToFind)
    || supplied.identifiersToFind.length === 0
    || (Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0 && requestedMaxTokens <= maxTokens)
  ) {
    return { supplied, transforms: [] };
  }
  return {
    supplied: { ...supplied, maxTokens },
    transforms: [{
      kind: "atlas_typed_call_shape",
      shape: "bound_anchored_file_window",
      requested_max_tokens: Number.isFinite(requestedMaxTokens) && requestedMaxTokens > 0
        ? requestedMaxTokens
        : null,
      effective_max_tokens: maxTokens,
    }],
  };
}
