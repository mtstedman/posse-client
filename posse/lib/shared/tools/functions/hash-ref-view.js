import {
  CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS,
  CONTEXT_FETCH_REF_MAX_LIMIT_CHARS,
} from "../../../catalog/context.js";

const FETCH_REF_SEARCH_MODES = new Set(["auto", "literal", "regex"]);
const FETCH_REF_REGEX_HINT = /[\\^$.*+?()[\]{}|]/;

function positiveInt(value, fallback, max = null) {
  const n = Number.parseInt(String(value ?? ""), 10);
  const parsed = Number.isFinite(n) && n > 0 ? n : fallback;
  return max == null ? parsed : Math.min(parsed, max);
}

function boundedSearchRow({
  line,
  lineNumber,
  matchStart = 0,
  matchLength = 0,
  maxChars,
}) {
  const prefix = `${lineNumber}:`;
  const value = String(line || "");
  const budget = Math.max(0, Number(maxChars) || 0);
  if (budget <= prefix.length) {
    return {
      text: prefix.slice(0, budget),
      truncated: value.length > 0,
    };
  }
  const available = budget - prefix.length;
  if (value.length <= available) {
    return { text: `${prefix}${value}`, truncated: false };
  }

  const marker = "…";
  const rawBudget = Math.max(1, available - (marker.length * 2));
  const safeMatchStart = Math.max(0, Math.min(Number(matchStart) || 0, value.length));
  const safeMatchLength = Math.max(0, Math.min(Number(matchLength) || 0, value.length - safeMatchStart));
  const matchCenter = safeMatchStart + Math.floor(safeMatchLength / 2);
  let start = Math.max(0, matchCenter - Math.floor(rawBudget / 2));
  start = Math.min(start, Math.max(0, value.length - rawBudget));
  let end = Math.min(value.length, start + rawBudget);
  const leading = start > 0 ? marker : "";
  const trailing = end < value.length ? marker : "";
  const exactBudget = Math.max(1, available - leading.length - trailing.length);
  if (end - start > exactBudget) end = start + exactBudget;
  return {
    text: `${prefix}${leading}${value.slice(start, end)}${trailing}`.slice(0, budget),
    truncated: true,
  };
}

/**
 * Deterministically materialize one exact model-visible view of a stored
 * payload. Traversal and terminal handoff both call this function so an
 * evidence capability never needs to duplicate the returned page text.
 */
export function materializeHashRefView(text, args = {}) {
  const limit = positiveInt(
    args.limit,
    CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS,
    CONTEXT_FETCH_REF_MAX_LIMIT_CHARS,
  );
  const search = String(args.search || "").trim();
  if (search) {
    const lines = String(text || "").replace(/\r\n/g, "\n").split("\n");
    const requestedModeValue = String(args.search_mode ?? args.searchMode ?? "auto").trim().toLowerCase();
    const requestedMode = FETCH_REF_SEARCH_MODES.has(requestedModeValue) ? requestedModeValue : "auto";
    const literalNeedle = search.toLowerCase();
    const literalRows = [];
    for (let i = 0; i < lines.length; i += 1) {
      const matchStart = lines[i].toLowerCase().indexOf(literalNeedle);
      if (matchStart >= 0) {
        literalRows.push({
          line: lines[i],
          lineNumber: i + 1,
          matchStart,
          matchLength: search.length,
        });
      }
    }

    let rows = literalRows;
    let searchMode = "literal";
    let searchError = null;
    const shouldTryRegex = requestedMode === "regex"
      || (requestedMode === "auto" && literalRows.length === 0 && FETCH_REF_REGEX_HINT.test(search));
    if (shouldTryRegex) {
      try {
        const expression = new RegExp(search, "i");
        rows = [];
        for (let i = 0; i < lines.length; i += 1) {
          const match = expression.exec(lines[i]);
          if (match) {
            rows.push({
              line: lines[i],
              lineNumber: i + 1,
              matchStart: match.index,
              matchLength: match[0]?.length || 0,
            });
          }
        }
        searchMode = "regex";
      } catch (err) {
        searchError = `invalid_regex: ${err?.message || err}`;
        if (requestedMode === "regex") rows = [];
      }
    }
    const rowOffset = positiveInt(args.offset, 0);
    const selected = [];
    let chars = 0;
    let truncatedMatchRows = 0;
    for (const row of rows.slice(rowOffset)) {
      const separatorChars = selected.length > 0 ? 1 : 0;
      const remaining = limit - chars - separatorChars;
      if (remaining <= 0) break;
      const rendered = boundedSearchRow({ ...row, maxChars: remaining });
      if (!rendered.text) break;
      selected.push(rendered.text);
      if (rendered.truncated) truncatedMatchRows += 1;
      chars += rendered.text.length + separatorChars;
      if (chars >= limit) break;
    }
    const selectedRowCount = selected.length;
    const selectedText = selected.join("\n");
    return {
      text: selectedText,
      page: {
        mode: "search",
        search,
        search_mode: searchMode,
        requested_search_mode: requestedMode,
        search_error: searchError,
        offset: rowOffset,
        limit,
        returned_chars: selectedText.length,
        match_count: rows.length,
        truncated_match_rows: truncatedMatchRows,
        next_offset: rowOffset + selectedRowCount < rows.length ? rowOffset + selectedRowCount : null,
        has_more: rowOffset + selectedRowCount < rows.length,
      },
    };
  }

  const offset = positiveInt(args.offset, 0);
  const page = String(text || "").slice(offset, offset + limit);
  return {
    text: page,
    page: {
      mode: "offset",
      offset,
      limit,
      returned_chars: page.length,
      next_offset: offset + page.length < String(text || "").length ? offset + page.length : null,
      has_more: offset + page.length < String(text || "").length,
    },
  };
}

export function hashRefViewSelector(view, args = {}) {
  const page = view?.page || {};
  if (page.mode === "search") {
    return {
      mode: "search",
      search: String(page.search || args.search || ""),
      search_mode: String(page.requested_search_mode || args.search_mode || args.searchMode || "auto"),
      offset: Math.max(0, Number(page.offset) || 0),
      limit: Math.max(1, Number(page.limit) || Number(args.limit) || CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS),
    };
  }
  return {
    mode: "offset",
    offset: Math.max(0, Number(page.offset) || 0),
    limit: Math.max(1, Number(page.limit) || Number(args.limit) || CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS),
  };
}

export function nextHashRefViewSelector(view) {
  const page = view?.page || {};
  if (page.has_more !== true || page.next_offset == null) return null;
  return {
    mode: page.mode === "search" ? "search" : "offset",
    offset: Math.max(0, Number(page.next_offset) || 0),
    limit: Math.max(1, Number(page.limit) || CONTEXT_FETCH_REF_DEFAULT_LIMIT_CHARS),
    ...(page.mode === "search" ? {
      search: String(page.search || ""),
      search_mode: String(page.requested_search_mode || "auto"),
    } : {}),
  };
}
