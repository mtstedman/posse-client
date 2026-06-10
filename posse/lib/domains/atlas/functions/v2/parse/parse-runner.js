// @ts-check

import { emitParseEvent } from "./events.js";

export async function runTreeSitterParse({ lang, files = [], parseFiles, commitLayer, dbWriteSemaphore, onEvent }) {
  emitParseEvent(onEvent, { kind: "atlas.parse.parse.started", lang, total: files.length });
  const parsed = await parseFiles(files);
  const committed = dbWriteSemaphore
    ? await dbWriteSemaphore.run(() => commitLayer(parsed))
    : await commitLayer(parsed);
  emitParseEvent(onEvent, {
    kind: "atlas.parse.parse.completed",
    lang,
    durationMs: null,
    blobsIngested: Array.isArray(parsed) ? parsed.length : null,
  });
  return committed;
}
