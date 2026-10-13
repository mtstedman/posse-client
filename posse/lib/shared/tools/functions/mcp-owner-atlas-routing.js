import { normalizeResearcherTypedActionArgs, researcherWorkflowActions } from "../../../domains/integrations/functions/deterministic-mcp/researcher-dispatcher.js";
import { fetchHashRefEvidenceForContext, issueHashRefTraversalForContext } from "../../../domains/queue/functions/hash-refs.js";
import { atlasDescriptorSchemaForAction } from "../../../domains/atlas/functions/v2/contracts/tool-schemas.js";
import { usesResearcherAtlasReadSurface, sessionToolPolicy, requestedToolPolicyName } from "./mcp-owner-tool-policy.js";
import { resolveAtlasSymbolHandle, atlasSymbolSourcePath } from "./mcp-owner-symbol-handles.js";
import { firstStructuredJsonValue } from "./mcp-owner-source-transport.js";
import { normalizeTypedSymbolBodyRoute, normalizeTypedFilenameWindowAnchor, normalizeTypedFileWindowOrientation, normalizeTypedAnchoredFileWindowBudget } from "./mcp-owner-atlas-window-args.js";
import { hashRefToolContext } from "./mcp-owner-session-support.js";

const ATLAS_RESEARCHER_WORKFLOW_ACTIONS = new Set(researcherWorkflowActions());

function promotedTraversalRefsFor(session) {
  if (!session) return new Set();
  if (!(session?._atlasPromotedTraversalRefs instanceof Set)) {
    session._atlasPromotedTraversalRefs = new Set();
  }
  return session._atlasPromotedTraversalRefs;
}

export function noteResearcherTypedTraversalPromotion(session, toolName, toolArgs = {}, result = null) {
  if (
    !usesResearcherAtlasReadSurface(sessionToolPolicy(session))
    || requestedToolPolicyName(toolName, toolArgs).name !== "traverse_ref"
    || result?.isError === true
    || typeof toolArgs.traversal_ref !== "string"
  ) return;
  const rendered = firstStructuredJsonValue(result?.content?.[0]?.text || "").value;
  if (rendered?.ok !== true || rendered?.evidence_ref?.ref !== toolArgs.traversal_ref) return;
  const refs = promotedTraversalRefsFor(session);
  refs.add(toolArgs.traversal_ref);
  while (refs.size > 512) refs.delete(refs.values().next().value);
}

function normalizePromotedTraversalAlias(session, action, supplied = {}) {
  const ref = typeof supplied.traversal_ref === "string"
    ? supplied.traversal_ref.trim()
    : "";
  const hasAlternateSelector = Number(supplied.offset || 0) > 0
    || (typeof supplied.search === "string" && supplied.search !== "");
  if (
    action !== "traverse_ref"
    || !ref
    || !hasAlternateSelector
    || !promotedTraversalRefsFor(session).has(ref)
    || supplied.reaccessAuthorization != null
  ) {
    return { supplied, transforms: [] };
  }
  const context = hashRefToolContext(session);
  const evidence = fetchHashRefEvidenceForContext(context, ref);
  if (!evidence?.found || !evidence.source || !evidence.capability) {
    return { supplied, transforms: [] };
  }
  const selector = typeof supplied.search === "string" && supplied.search !== ""
    ? {
      mode: "search",
      search: supplied.search,
      search_mode: supplied.search_mode || "auto",
      offset: Math.max(0, Number(supplied.offset) || 0),
      ...(supplied.limit != null ? { limit: Number(supplied.limit) } : {}),
    }
    : {
      mode: "offset",
      offset: Math.max(0, Number(supplied.offset) || 0),
      ...(supplied.limit != null ? { limit: Number(supplied.limit) } : {}),
    };
  const traversalRequest = {
    sourceRef: evidence.source.ref,
    selector,
    sourceContentHash: evidence.source.content_hash || null,
  };
  const issued = issueHashRefTraversalForContext(context, traversalRequest);
  if (!issued?.ok || !issued.capability?.ref) return { supplied, transforms: [] };
  return {
    supplied: { ...supplied, traversal_ref: issued.capability.ref },
    transforms: [{
      kind: "atlas_typed_call_cleanup",
      cleanup: "promoted_traversal_alias_to_authorized_slice",
      selector_mode: selector.mode,
      selector_offset: selector.offset,
    }],
  };
}

export function routeResearcherDispatcherCall(policy, toolName, toolArgs = {}, session = null) {
  const transforms = [];
  const requested = requestedToolPolicyName(toolName, toolArgs);
  const direct = policy?.atlasResearcherDirect === true
    && requested.suite === "atlas" && ATLAS_RESEARCHER_WORKFLOW_ACTIONS.has(requested.name);
  if (!direct) return { toolName, toolArgs, transforms };
  const action = requested.name;
  let supplied = toolArgs;
  const fieldAliases = normalizeResearcherTypedActionArgs(action, supplied);
  if (fieldAliases.error) {
    return { toolName, toolArgs, transforms, routingError: fieldAliases.error };
  }
  supplied = fieldAliases.args;
  if (fieldAliases.aliases.length > 0) {
    transforms.push({
      kind: "atlas_typed_field_aliases",
      aliases: fieldAliases.aliases,
    });
  }
  const symbolBodyRoute = usesResearcherAtlasReadSurface(policy)
    ? normalizeTypedSymbolBodyRoute(action, supplied)
    : { action, supplied, transforms: [] };
  let routedAction = symbolBodyRoute.action;
  supplied = symbolBodyRoute.supplied;
  transforms.push(...symbolBodyRoute.transforms);
  const filenameAnchorCleanup = normalizeTypedFilenameWindowAnchor(routedAction, supplied);
  supplied = filenameAnchorCleanup.supplied;
  transforms.push(...filenameAnchorCleanup.transforms);
  const fileWindowCleanup = normalizeTypedFileWindowOrientation(routedAction, supplied);
  routedAction = fileWindowCleanup.action;
  supplied = fileWindowCleanup.supplied;
  transforms.push(...fileWindowCleanup.transforms);
  const anchoredWindowBudget = normalizeTypedAnchoredFileWindowBudget(
    session,
    routedAction,
    supplied,
  );
  supplied = anchoredWindowBudget.supplied;
  transforms.push(...anchoredWindowBudget.transforms);
  const traversalCleanup = normalizePromotedTraversalAlias(session, routedAction, supplied);
  supplied = traversalCleanup.supplied;
  transforms.push(...traversalCleanup.transforms);
  const schema = atlasDescriptorSchemaForAction(routedAction);
  const properties = schema?.properties && typeof schema.properties === "object"
    ? schema.properties
    : {};
  const routedArgs = {};
  for (const [key, value] of Object.entries(supplied)) {
    if (!Object.prototype.hasOwnProperty.call(properties, key)) continue;
    // expectedLines is optional retrieval telemetry rather than a selector.
    // Omitting it avoids rejecting qualitative provider guesses while leaving
    // the source selection and canonical action validation unchanged.
    if (routedAction === "code.window" && key === "expectedLines") continue;
    if (key === "symbolId") {
      const resolved = resolveAtlasSymbolHandle(session, value);
      if (!resolved.ok) {
        return {
          toolName: `atlas.${routedAction}`,
          toolArgs: supplied,
          routingError: `Unknown Atlas symbolHandle ${resolved.handle}; reuse only a handle returned in this job-bound agent session`,
          transforms,
        };
      }
      routedArgs[key] = resolved.value;
      if (resolved.repaired) {
        transforms.push({
          kind: "atlas_typed_call_cleanup",
          cleanup: "unique_session_symbol_id_prefix",
        });
      }
    } else if (key === "symbolIds" && Array.isArray(value)) {
      const resolved = value.map((entry) => resolveAtlasSymbolHandle(session, entry));
      const unknown = resolved.find((entry) => !entry.ok);
      if (unknown) {
        return {
          toolName: `atlas.${routedAction}`,
          toolArgs: supplied,
          routingError: `Unknown Atlas symbolHandle ${unknown.handle}; reuse only a handle returned in this job-bound agent session`,
          transforms,
        };
      }
      routedArgs[key] = resolved.map((entry) => entry.value);
      if (resolved.some((entry) => entry.repaired)) {
        transforms.push({
          kind: "atlas_typed_call_cleanup",
          cleanup: "unique_session_symbol_id_prefix",
        });
      }
    } else {
      routedArgs[key] = value;
    }
  }
  if (
    ["code.window", "symbol.get"].includes(routedAction)
    && routedArgs.symbolId
    && !routedArgs.file
  ) {
    const discoveredPath = atlasSymbolSourcePath(session, routedArgs.symbolId);
    if (discoveredPath) {
      routedArgs.file = discoveredPath;
      transforms.push({
        kind: "atlas_typed_call_cleanup",
        cleanup: "restore_discovered_symbol_source_path",
        repo_rel_path: discoveredPath,
      });
    }
  }
  if (
    usesResearcherAtlasReadSurface(policy)
    && routedAction === "code.window"
    && routedArgs.reason == null
  ) {
    // The typed facade itself proves that this is a researcher-owned exact
    // source read. Avoid billing the provider for restating that invariant on
    // every scalar window while retaining the canonical native contract.
    routedArgs.reason = "typed researcher exact-source read";
  }
  return {
    toolName: `atlas.${routedAction}`,
    toolArgs: routedArgs,
    transforms,
  };
}

export function __testRouteResearcherDispatcherCall(policy, toolName, toolArgs = {}, session = null) {
  return routeResearcherDispatcherCall(policy, toolName, toolArgs, session);
}
