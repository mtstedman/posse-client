import {
  CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS,
  CONTEXT_FETCH_REF_MAX_LIMIT_CHARS,
} from "../../../catalog/context.js";

const VISIBILITY_RANK = Object.freeze({ hidden: 0, partial: 1, full: 2 });

function positiveInt(value, fallback, max = null) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  const resolved = Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
  return max == null ? resolved : Math.min(resolved, max);
}

function normalizedIdentity(context = {}) {
  return {
    attempt_id: Number(context.attempt_id ?? context.attemptId) || null,
    agent_call_id: Number(context.agent_call_id ?? context.agentCallId) || null,
  };
}

function sameVisibleScope(scope = {}, context = {}) {
  const current = normalizedIdentity(context);
  const scopeAttemptId = Number(scope.attempt_id) || null;
  const scopeAgentCallId = Number(scope.agent_call_id) || null;
  if (current.attempt_id && scopeAttemptId && current.attempt_id !== scopeAttemptId) return false;
  if (current.agent_call_id && scopeAgentCallId) return current.agent_call_id === scopeAgentCallId;
  return !!(
    (current.attempt_id && scopeAttemptId && current.attempt_id === scopeAttemptId)
    || (current.agent_call_id && scopeAgentCallId && current.agent_call_id === scopeAgentCallId)
  );
}

function normalizeRange(range, fullSize) {
  const start = Math.max(0, Math.min(fullSize, Number(range?.start) || 0));
  const end = Math.max(start, Math.min(fullSize, Number(range?.end) || 0));
  return end > start ? { start, end } : null;
}

function mergeRanges(ranges = [], fullSize = Number.MAX_SAFE_INTEGER) {
  const sorted = ranges
    .map((range) => normalizeRange(range, fullSize))
    .filter(Boolean)
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const merged = [];
  for (const range of sorted) {
    const prior = merged.at(-1);
    if (!prior || range.start > prior.end) {
      merged.push({ ...range });
    } else {
      prior.end = Math.max(prior.end, range.end);
    }
  }
  return merged;
}

function visibleScope(entry, context) {
  const scopes = Array.isArray(entry?.metadata?.model_visible_scopes)
    ? entry.metadata.model_visible_scopes
    : [];
  const matching = scopes.filter((scope) => sameVisibleScope(scope, context));
  if (matching.length === 0) return { visibility: "hidden", ranges: [] };
  let visibility = "hidden";
  const ranges = [];
  for (const scope of matching) {
    const candidate = String(scope?.visibility || "hidden");
    if ((VISIBILITY_RANK[candidate] ?? 0) > (VISIBILITY_RANK[visibility] ?? 0)) {
      visibility = candidate;
    }
    if (Array.isArray(scope?.ranges)) ranges.push(...scope.ranges);
  }
  return { visibility, ranges };
}

/**
 * Resolve the model-visibility contract attached to a ref for the current
 * agent call. Refs created before visibility tracking have no contract and
 * remain legacy-compatible; refs that do carry scopes are usable as evidence
 * only when this exact model call received the complete payload.
 */
export function hashRefModelVisibleScope(entry, context = {}) {
  const scopes = Array.isArray(entry?.metadata?.model_visible_scopes)
    ? entry.metadata.model_visible_scopes
    : [];
  const resolved = visibleScope(entry, context);
  return {
    ...resolved,
    contracted: scopes.length > 0,
    fully_visible: resolved.visibility === "full",
  };
}

function fetchClassForEntry(entry = {}) {
  const explicit = String(entry?.metadata?.fetch_class || "").trim();
  if (explicit) return explicit;
  const surfacedBy = String(entry?.metadata?.surfaced_by || "");
  if (surfacedBy === "survey_snapshot_pager") return "survey_page";
  if (surfacedBy === "tree_scope_rank_compactor") return "cursor_page";
  if (surfacedBy === "result_ref_paging") return "result_tail";
  if (surfacedBy === "requested_region_continuation") return "result_continuation";
  if (entry?.metadata?.bounded_ingress === true || entry?.metadata?.bounded_ingress === 1) {
    return "bounded_result";
  }
  return "stored_ref";
}

function normalizeSearchSignature(args = {}) {
  const search = String(args.search || "").trim();
  if (!search) return null;
  const requestedMode = String(args.search_mode ?? args.searchMode ?? "auto").trim().toLowerCase();
  return {
    search: search.toLowerCase(),
    requested_search_mode: ["auto", "literal", "regex"].includes(requestedMode)
      ? requestedMode
      : "auto",
    offset: positiveInt(args.offset, 0),
    limit: positiveInt(
      args.limit,
      CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS,
      CONTEXT_FETCH_REF_MAX_LIMIT_CHARS,
    ),
  };
}

function sameSearch(left, right) {
  return !!left && !!right
    && left.search === right.search
    && left.requested_search_mode === right.requested_search_mode
    && left.offset === right.offset
    && left.limit === right.limit;
}

function rejection(code, classification, message, extra = {}) {
  return {
    allowed: false,
    code,
    classification,
    message,
    retryable: false,
    ...extra,
  };
}

function allowed(classification, args, extra = {}) {
  return {
    allowed: true,
    classification,
    args,
    ...extra,
  };
}

/**
 * Return model-visibility metadata for a hash ref stamped into the current
 * tool response. The durable scope prevents another agent that inherited only
 * the ref from being mistaken for the agent that saw the original payload.
 */
export function hashRefModelVisibility(context = {}, {
  visibility = "hidden",
  ranges = [],
} = {}) {
  const identity = normalizedIdentity(context);
  return {
    model_visible_scopes: [{
      ...identity,
      visibility: VISIBILITY_RANK[visibility] == null ? "hidden" : visibility,
      ranges: mergeRanges(ranges),
    }],
  };
}

/**
 * Content-aware admission for one stored ref. `history` contains prior
 * hash_ref.fetch observation details for this content hash and model scope.
 */
export function admitHashRefFetch({
  entry,
  args = {},
  history = [],
  context = {},
  enforce = false,
} = {}) {
  if (!entry) return allowed("fetch_miss", args);
  const fetchClass = fetchClassForEntry(entry);
  const fullSize = Math.max(0, String(entry.payload_text || "").length || Number(entry.size_chars || 0));
  const initial = visibleScope(entry, context);
  const searchSignature = normalizeSearchSignature(args);

  if (enforce && initial.visibility === "full") {
    return rejection(
      "fetch_ref_duplicate_visible",
      "duplicate_visible",
      "This ref's complete payload was already present in this agent's tool response. Use the visible evidence; do not fetch the ref.",
      { fetch_class: fetchClass, initial_visibility: initial.visibility },
    );
  }

  if (searchSignature) {
    const priorEmptySearch = history.find((item) => (
      item?.empty === true
      && !item?.search_error
      && item?.search_signature?.search === searchSignature.search
      && item?.search_signature?.requested_search_mode === searchSignature.requested_search_mode
    ));
    const priorSearch = history.find((item) => sameSearch(item?.search_signature, searchSignature));
    if (enforce && priorEmptySearch) {
      return rejection(
        "fetch_ref_empty_search_repeat",
        "empty_search_repeat",
        "This stored-ref search already returned no matches. Change the query materially or continue without retrying it.",
        { fetch_class: fetchClass, initial_visibility: initial.visibility, search_signature: searchSignature },
      );
    }
    if (enforce && priorSearch) {
      return rejection(
        "fetch_ref_duplicate_search",
        "duplicate_search",
        "This stored-ref search page was already delivered. Follow its next offset, change the query materially, or continue without retrying it.",
        { fetch_class: fetchClass, initial_visibility: initial.visibility, search_signature: searchSignature },
      );
    }
    return allowed(fetchClass === "survey_page" ? "survey_search" : "stored_search", args, {
      fetch_class: fetchClass,
      initial_visibility: initial.visibility,
      search_signature: searchSignature,
    });
  }

  if (entry.entry_kind !== "materialized") {
    const priorUnavailable = history.some((item) => item?.classification === "descriptor_unavailable");
    if (enforce && priorUnavailable) {
      return rejection(
        "fetch_ref_unavailable_repeat",
        "unavailable_repeat",
        "This ref was already reported as unavailable in the current runtime. Do not retry it.",
        { fetch_class: fetchClass, initial_visibility: initial.visibility },
      );
    }
    return allowed("descriptor_unavailable", args, {
      fetch_class: fetchClass,
      initial_visibility: initial.visibility,
    });
  }

  const deliveredRanges = history
    .filter((item) => item?.admission !== "rejected")
    .map((item) => ({ start: item?.delivered_range_start, end: item?.delivered_range_end }));
  const coverage = mergeRanges([
    ...(initial.visibility === "partial" ? initial.ranges : []),
    ...deliveredRanges,
  ], fullSize);
  const requestedOffset = positiveInt(args.offset, 0);
  const requestedLimit = positiveInt(
    args.limit,
    CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS,
    CONTEXT_FETCH_REF_MAX_LIMIT_CHARS,
  );
  let start = Math.min(requestedOffset, fullSize);
  let nextCoveredStart = fullSize;
  for (const range of coverage) {
    if (start >= range.start && start < range.end) start = range.end;
    if (range.start > start) {
      nextCoveredStart = range.start;
      break;
    }
  }
  for (const range of coverage) {
    if (range.start > start) {
      nextCoveredStart = Math.min(nextCoveredStart, range.start);
      break;
    }
  }
  if (enforce && start >= fullSize) {
    return rejection(
      "fetch_ref_duplicate_visible",
      "duplicate_visible",
      "The requested stored-ref content is already visible in this agent's ledger. Continue without fetching it again.",
      { fetch_class: fetchClass, initial_visibility: initial.visibility },
    );
  }
  const end = Math.min(fullSize, start + requestedLimit, nextCoveredStart);
  if (enforce && end <= start) {
    return rejection(
      "fetch_ref_duplicate_visible",
      "duplicate_visible",
      "The requested stored-ref content is already visible in this agent's ledger. Continue without fetching it again.",
      { fetch_class: fetchClass, initial_visibility: initial.visibility },
    );
  }
  const effectiveArgs = enforce
    ? { ...args, offset: start, limit: Math.max(1, end - start) }
    : args;
  const classification = fetchClass === "result_tail"
    ? "tail_traversal"
    : (fetchClass === "result_continuation"
      ? "continuation_traversal"
      : (fetchClass === "survey_page" || fetchClass === "cursor_page"
        ? "cursor_traversal"
        : (fetchClass === "bounded_result" ? "bounded_continuation" : "stored_ref")));
  return allowed(classification, effectiveArgs, {
    fetch_class: fetchClass,
    initial_visibility: initial.visibility,
    requested_offset: requestedOffset,
    requested_limit: requestedLimit,
    effective_offset: enforce ? start : requestedOffset,
    effective_limit: enforce ? Math.max(1, end - start) : requestedLimit,
    skipped_visible_chars: enforce ? Math.max(0, start - requestedOffset) : 0,
  });
}

export const __testFetchRefPolicyInternals = Object.freeze({
  mergeRanges,
  normalizeSearchSignature,
  sameVisibleScope,
});
