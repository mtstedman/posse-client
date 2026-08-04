// @ts-check

/** @typedef {import("./contracts/api.js").View} View */
/** @typedef {import("./contracts/api.js").ViewSymbol} ViewSymbol */

export const DEFAULT_VIEW_SYMBOL_PAGE_SIZE = 1_024;

/**
 * Compatibility wrapper for bounded full-view scans. Production `View`
 * handles expose `allSymbolPages`; the legacy fallback exists for small test
 * doubles and fails closed when a one-shot read cannot prove completeness.
 *
 * @param {{ view: View, limit?: number | null, pageSize?: number, pathPrefix?: string }} args
 * @returns {AsyncGenerator<ViewSymbol[], void, void>}
 */
export async function* iterateViewSymbolPages({
  view,
  limit = null,
  pageSize = DEFAULT_VIEW_SYMBOL_PAGE_SIZE,
  pathPrefix,
}) {
  if (!view?.query) throw new TypeError("iterateViewSymbolPages: view.query is required");
  const totalLimit = positiveInteger(limit);
  const boundedPageSize = Math.min(10_000, positiveInteger(pageSize) ?? DEFAULT_VIEW_SYMBOL_PAGE_SIZE);

  if (typeof view.query.allSymbolPages === "function") {
    yield* view.query.allSymbolPages({
      ...(totalLimit != null ? { limit: totalLimit } : {}),
      pageSize: boundedPageSize,
      ...(pathPrefix ? { pathPrefix } : {}),
    });
    return;
  }

  if (typeof view.query.allSymbols !== "function") {
    throw new TypeError("iterateViewSymbolPages: paged symbol enumeration is unavailable");
  }
  const oneShotLimit = totalLimit ?? boundedPageSize;
  const symbols = await view.query.allSymbols({
    limit: oneShotLimit,
    ...(pathPrefix ? { pathPrefix } : {}),
  });
  if (!Array.isArray(symbols)) {
    throw new Error("iterateViewSymbolPages: legacy allSymbols returned a non-array result");
  }
  if (totalLimit == null && symbols.length >= oneShotLimit) {
    throw new Error(
      `iterateViewSymbolPages: legacy allSymbols reached its ${oneShotLimit}-row cap without pagination metadata`,
    );
  }
  if (symbols.length > 0) yield symbols;
}

function positiveInteger(value) {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0
    ? value
    : null;
}
