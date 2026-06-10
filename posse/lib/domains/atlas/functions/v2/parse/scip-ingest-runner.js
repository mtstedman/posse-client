// @ts-check

import { ingestScipFile } from "../scip/ingester.js";
import { emitParseEvent } from "./events.js";

export async function runScipIngest({ ledger, scipPath, repoRoot, branch, dbWriteSemaphore, onEvent, ...rest }) {
  const run = async () => {
    emitParseEvent(onEvent, { kind: "atlas.parse.scip.ingest.started", lang: rest.lang || null, totalDocuments: null });
    const result = await ingestScipFile({
      ledger,
      scipPath,
      repoRoot,
      branch,
      onEvent,
      ...rest,
    });
    emitParseEvent(onEvent, {
      kind: "atlas.parse.scip.ingest.completed",
      lang: rest.lang || null,
      durationMs: null,
      blobsReused: result.blobs_reused,
      externalSymbols: result.external_symbols,
    });
    return result;
  };
  return dbWriteSemaphore ? dbWriteSemaphore.run(run) : run();
}
