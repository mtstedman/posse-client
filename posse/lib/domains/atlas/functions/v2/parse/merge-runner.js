// @ts-check

import { emitParseEvent } from "./events.js";

export async function runMergeLanguageLayers({ view, ledger, lang, contentHashes = null, dbWriteSemaphore, onEvent }) {
  const run = async () => {
    emitParseEvent(onEvent, { kind: "atlas.parse.merge.started", lang, sources: [] });
    const result = view.mergeLanguageLayers({ ledger, lang, contentHashes });
    emitParseEvent(onEvent, {
      kind: result.skipped ? "atlas.parse.merge.skipped" : "atlas.parse.merge.completed",
      lang,
      sources: result.sources,
      mergedSymbols: result.mergedSymbols,
      mergedEdges: result.mergedEdges,
      status: result.status,
      reason: result.reason || null,
    });
    return result;
  };
  return dbWriteSemaphore ? dbWriteSemaphore.run(run) : run();
}
