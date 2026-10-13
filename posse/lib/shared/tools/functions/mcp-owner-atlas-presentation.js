import { COMPACT_STRUCTURE_DEFAULT_MAX_CHARS, COMPACT_STRUCTURE_DEFAULT_MAX_FILES, COMPACT_STRUCTURE_PROJECTION } from "../../../catalog/atlas-presentation.js";
import { ATLAS_COMPACT_STRUCTURE_GATED_MAX_CHARS, ATLAS_COMPACT_STRUCTURE_GATED_ROLES, ATLAS_COMPACT_STRUCTURE_ROLES } from "../../../catalog/atlas.js";
import { getAccountSetting } from "../../../domains/settings/functions/account-settings.js";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { compactSkeletonSymbolHandles, compactResearcherTypedAtlasText, normalizeResearcherTypedAtlasFieldNames } from "./researcher-typed-result-compaction.js";
import { usesResearcherAtlasReadSurface, sessionToolPolicy, requestedToolPolicyName } from "./mcp-owner-tool-policy.js";
import { atlasSymbolHandleForId, rememberAtlasSymbolSourcePaths } from "./mcp-owner-symbol-handles.js";
import { annotateOwnerResultTransform, preserveOwnerModelControlNotices } from "./mcp-owner-source-transport.js";
import { researcherTypedLanguageLeversForSession } from "./mcp-owner-atlas-window-args.js";

// P0.4: the researcher facade defaults code.structure to a small directory
// inventory. An explicit maxFiles is honored unchanged (the canonical schema
// still bounds it); non-researcher callers keep the native default.
/** @param {any} session @param {string} requestedName @param {Record<string, any>} args */
export function researcherStructureExecutorArgs(session, requestedName, args = {}) {
  if (requestedName !== "code.structure") return args;
  if (!usesResearcherAtlasReadSurface(sessionToolPolicy(session))) return args;
  if (args?.maxFiles != null) return args;
  return { ...args, maxFiles: COMPACT_STRUCTURE_DEFAULT_MAX_FILES };
}

/** @param {any} session */
export function researcherStructureProjection(session) {
  const role = String(session?.bootConfig?.role || "");
  if (ATLAS_COMPACT_STRUCTURE_ROLES.includes(role)) return COMPACT_STRUCTURE_PROJECTION;
  if (!ATLAS_COMPACT_STRUCTURE_GATED_ROLES.includes(role)) return null;
  try {
    return getAccountSetting(SETTING_KEYS.ATLAS_COMPACT_STRUCTURE_DEV_ASSESSOR) === "on"
      ? COMPACT_STRUCTURE_PROJECTION : null;
  } catch { return null; }
}

export function structureMaxChars(session) {
  return ATLAS_COMPACT_STRUCTURE_ROLES.includes(String(session?.bootConfig?.role || ""))
    ? COMPACT_STRUCTURE_DEFAULT_MAX_CHARS : ATLAS_COMPACT_STRUCTURE_GATED_MAX_CHARS;
}

export const __testResearcherStructureExecutorArgs = researcherStructureExecutorArgs;

export const __testResearcherStructureProjection = researcherStructureProjection;

export const __testStructureMaxChars = structureMaxChars;
export function appendResearcherSymbolHandles(result, session, action) {
  if (!usesResearcherAtlasReadSurface(sessionToolPolicy(session)) || result?.isError === true) {
    return result;
  }
  const first = result?.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;
  let issued = 0;
  let text = first.text;
  if (action === "code.skeleton") {
    const skeleton = compactSkeletonSymbolHandles(text, (symbolId, file) => {
      const handle = atlasSymbolHandleForId(session, symbolId);
      if (handle) rememberAtlasSymbolSourcePaths(session, [{ symbol_id: symbolId, repo_rel_path: file }]);
      return handle;
    });
    if (skeleton) {
      text = skeleton.text;
      issued += skeleton.issued;
    }
  }
  text = text.replace(
    /("symbolId"\s*:\s*")([0-9a-f]{64}:[0-9]+)(")/g,
    (match, prefix, symbolId, suffix) => {
      const handle = atlasSymbolHandleForId(session, symbolId);
      if (!handle) return match;
      issued += 1;
      return `${prefix}${symbolId}${suffix},"symbolHandle":"${handle}"`;
    },
  );
  text = text.replace(/"([0-9a-f]{64}:[0-9]+)"\s*:/gu, (match, symbolId) => {
    const handle = atlasSymbolHandleForId(session, symbolId);
    if (!handle) return match;
    issued += 1;
    return `"${handle}":`;
  });
  if (text === first.text) return result;
  return annotateOwnerResultTransform({
    ...result,
    content: [{ ...first, text }, ...result.content.slice(1)],
  }, {
    kind: "atlas_symbol_handles",
    issued,
    scope: "job_bound_agent_session",
    before_chars: first.text.length,
    after_chars: text.length,
  });
}

export function compactResearcherTypedAtlasResult(result, session, toolName, toolArgs = {}) {
  const requested = requestedToolPolicyName(toolName, toolArgs);
  if (
    !usesResearcherAtlasReadSurface(sessionToolPolicy(session))
    || result?.isError === true
  ) {
    return result;
  }
  const first = result?.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;
  const compacted = compactResearcherTypedAtlasText(first.text, {
    action: requested.suite === "atlas" ? requested.name : null,
    args: toolArgs,
    metadataOnly: researcherTypedLanguageLeversForSession(session).resultCompaction !== true,
  });
  if (!compacted) return result;
  const projected = {
    ...result,
    content: [{ ...first, text: compacted.text }, ...result.content.slice(1)],
  };
  return annotateOwnerResultTransform(
    preserveOwnerModelControlNotices(result, projected),
    {
      kind: "atlas_typed_result_compaction",
      action: requested.name || toolName,
      removed_canonical_symbol_ids: compacted.removedCanonicalSymbolIds,
      removed_digest_fields: compacted.removedDigestFields,
      removed_default_fields: compacted.removedDefaultFields,
      before_chars: first.text.length,
      after_chars: compacted.text.length,
    },
  );
}

export function normalizeResearcherTypedAtlasResultFieldNames(result, session, toolName, toolArgs = {}) {
  // Error results are model-visible too: an all-failed symbol.get batch is
  // isError at the envelope and still carries a structured header.
  if (!usesResearcherAtlasReadSurface(sessionToolPolicy(session))) return result;
  const first = result?.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return result;
  const requested = requestedToolPolicyName(toolName, toolArgs);
  const normalized = normalizeResearcherTypedAtlasFieldNames(first.text, {
    action: requested.suite === "atlas" ? requested.name : null,
  });
  if (!normalized) return result;
  const content = [{ ...first, text: normalized.text }, ...result.content.slice(1)];
  let renamedFields = normalized.renamedFields;
  // A batched result carries one child header per item in its own block. Those
  // headers are model-visible facade payload too; every other block is source
  // custody and is left byte-identical.
  for (const index of batchChildHeaderBlocks(normalized.text)) {
    const block = content[index];
    if (!block || block.type !== "text" || typeof block.text !== "string") continue;
    const childNormalized = normalizeResearcherTypedAtlasFieldNames(block.text, {
      action: requested.suite === "atlas" ? requested.name : null,
    });
    if (!childNormalized) continue;
    content[index] = { ...block, text: childNormalized.text };
    renamedFields += childNormalized.renamedFields;
  }
  const projected = { ...result, content };
  return annotateOwnerResultTransform(
    preserveOwnerModelControlNotices(result, projected),
    {
      kind: "atlas_typed_field_names",
      action: requested.name || toolName,
      renamed_fields: renamedFields,
      before_chars: first.text.length,
      after_chars: normalized.text.length,
    },
  );
}

/**
 * Block indexes holding a batched result's per-item headers.
 *
 * @param {string} headerText
 * @returns {number[]}
 */
function batchChildHeaderBlocks(headerText) {
  let parsed;
  try {
    parsed = JSON.parse(headerText.split("\n\n")[0]);
  } catch {
    return [];
  }
  if (!parsed || !Array.isArray(parsed.items)) return [];
  return parsed.items
    .map(item => (Array.isArray(item?.content_blocks) ? item.content_blocks[0] : null))
    .filter(index => Number.isSafeInteger(index) && index > 0);
}
