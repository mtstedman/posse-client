// @ts-check

import { createDbWriteSemaphore, createScipStageSemaphore } from "./semaphore.js";
import { emitParseEvent } from "./events.js";
import { startOnnxRefresh } from "./onnx-index-runner.js";

/**
 * @param {{
 *   dbWriteSemaphore?: import("./semaphore.js").ParseSemaphore,
 *   scipStageSemaphore?: import("./semaphore.js").ParseSemaphore,
 *   onEvent?: ((event: { kind: string, [k: string]: unknown }) => void) | null,
 * }} [opts]
 */
export function createParsePipeline({
  dbWriteSemaphore = createDbWriteSemaphore(),
  scipStageSemaphore = createScipStageSemaphore(1),
  onEvent,
} = {}) {
  return {
    dbWriteSemaphore,
    scipStageSemaphore,
    runDbWrite: (fn) => dbWriteSemaphore.run(fn),
    runScipStage: (fn) => scipStageSemaphore.run(fn),
    emit: (event) => emitParseEvent(onEvent, event),
  };
}

/**
 * Thin per-language orchestration scaffold. CPU work happens in caller-supplied
 * functions; all durable mutations pass through the DB semaphore.
 *
 * @param {{
 *   languages: string[],
 *   parseLanguage: (lang: string) => Promise<unknown> | unknown,
 *   stageScip?: (lang: string) => Promise<unknown> | unknown,
 *   ingestScip?: (lang: string, staged: unknown) => Promise<unknown> | unknown,
 *   mergeLanguage?: (lang: string, sources: string[]) => Promise<unknown> | unknown,
 *   onnx?: Parameters<typeof startOnnxRefresh>[0] | null,
 *   dbWriteSemaphore?: import("./semaphore.js").ParseSemaphore,
 *   scipStageSemaphore?: import("./semaphore.js").ParseSemaphore,
 *   onEvent?: (event: { kind: string, [k: string]: unknown }) => void,
 * }} opts
 */
export async function runParsePipeline(opts) {
  const pipeline = createParsePipeline({
    dbWriteSemaphore: opts.dbWriteSemaphore || createDbWriteSemaphore(),
    scipStageSemaphore: opts.scipStageSemaphore || createScipStageSemaphore(1),
    onEvent: opts.onEvent,
  });
  await Promise.all((opts.languages || []).map(async (lang) => {
    emitParseEvent(opts.onEvent, { kind: "atlas.parse.parse.started", lang, total: null });
    await opts.parseLanguage(lang);
    if (opts.mergeLanguage) {
      await pipeline.runDbWrite(() => opts.mergeLanguage(lang, ["treesitter"]));
    }
    emitParseEvent(opts.onEvent, { kind: "atlas.parse.parse.completed", lang, durationMs: null, blobsIngested: null });

    if (opts.stageScip && opts.ingestScip) {
      emitParseEvent(opts.onEvent, { kind: "atlas.parse.scip.stage.started", lang });
      const staged = await pipeline.runScipStage(() => opts.stageScip(lang));
      emitParseEvent(opts.onEvent, { kind: "atlas.parse.scip.stage.completed", lang, durationMs: null, outputPath: null });
      await pipeline.runDbWrite(() => opts.ingestScip(lang, staged));
      if (opts.mergeLanguage) {
        await pipeline.runDbWrite(() => opts.mergeLanguage(lang, ["treesitter", "scip"]));
      }
    }
  }));
  return opts.onnx ? startOnnxRefresh(opts.onnx) : null;
}
