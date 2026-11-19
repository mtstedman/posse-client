// @ts-check
//
// The owner side of search symbol hints: resolve the session's Atlas view
// without running a tool, read the symbols the hints need from it, and hand
// them to the pure renderer. A slow or missing index returns the search
// result unchanged.

import { View } from "../../../domains/atlas/classes/v2/View.js";
import { withSearchSymbolHints } from "./search-symbol-hints.js";

const SEARCH_HINT_BUDGET_MS = 1500;

/** Distinct calling symbols over call edges, as symbol.callers counts them. */
async function callerCount(view, symbol) {
  const neighborhood = await view.query.symbolCallers(symbol.global_id, 0);
  const callers = new Set();
  for (const { edge, symbol: from } of neighborhood?.callers || []) {
    if (edge?.kind !== "calls" || !from) continue;
    callers.add(`${from.content_hash}:${from.local_id}`);
  }
  return callers.size;
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    promise,
    new Promise((resolve) => { timer = setTimeout(() => resolve(null), ms); }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * @param {any} result MCP tool result of a successful search_files call.
 * @param {{
 *   executor: { readViewFor?: (request: any) => Promise<{ viewPath: string, readRoot: string | null } | null> } | null,
 *   sessionContext: any,
 *   bootConfig: { cwd?: string, atlasAvailable?: boolean },
 *   args: { pattern?: string, path?: string },
 *   callersIssued: boolean,
 *   budgetMs?: number,
 * }} options
 */
export async function addSearchSymbolHints(result, {
  executor, sessionContext, bootConfig, args, callersIssued, budgetMs = SEARCH_HINT_BUDGET_MS,
}) {
  const first = Array.isArray(result?.content) ? result.content[0] : null;
  if (result?.isError === true || first?.type !== "text" || typeof first.text !== "string") return result;
  if (bootConfig?.atlasAvailable !== true || !bootConfig?.cwd || typeof executor?.readViewFor !== "function") return result;
  if (!/^File:\s/mu.test(first.text) && !args?.pattern) return result;
  /** @type {View | null} */
  let view = null;
  const work = (async () => {
    const resolved = await executor.readViewFor({ session: sessionContext, source: { kind: "search_symbol_hints" } });
    if (!resolved?.viewPath) return null;
    view = View.mount({ dbPath: resolved.viewPath });
    const mounted = view;
    return withSearchSymbolHints(first.text, {
      args,
      cwd: bootConfig.cwd,
      readRoot: resolved.readRoot || bootConfig.cwd,
      callersIssued,
      source: {
        symbolsInFile: (repoRelPath) => mounted.query.symbolsInFile(repoRelPath),
        contentHashForPath: (repoRelPath) => mounted.query.contentHashForPath(repoRelPath),
        findSymbol: (name) => mounted.query.findSymbol(name, { limit: 5, fuzzy: false, scope: "name" }),
        callerCount: (symbol) => callerCount(mounted, symbol),
      },
    });
  })();
  // The view closes when the lookups finish, even after the budget ran out
  // and the plain result was already returned.
  work.catch(() => null).finally(() => {
    try { /** @type {any} */ (view)?.close?.(); } catch { /* best effort */ }
  });
  const text = await withTimeout(work.catch(() => null), budgetMs);
  if (typeof text !== "string" || text === first.text) return result;
  return { ...result, content: [{ ...first, text }, ...result.content.slice(1)] };
}
