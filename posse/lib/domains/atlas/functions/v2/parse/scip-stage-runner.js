// @ts-check

import { ensureScipStaged } from "../scip/stager.js";
import { emitParseEvent } from "./events.js";

export async function runScipStage({ lang, repoRoot, scipDir, mode, config, scipStageSemaphore, onEvent }) {
  const run = async () => {
    emitParseEvent(onEvent, { kind: "atlas.parse.scip.stage.started", lang });
    const result = await ensureScipStaged({ repoRoot, scipDir, mode, config, onProgress: onEvent });
    emitParseEvent(onEvent, {
      kind: "atlas.parse.scip.stage.completed",
      lang,
      durationMs: null,
      outputPath: null,
      decision: result.error ? "failed" : "staged",
      reason: result.error || null,
    });
    return result;
  };
  return scipStageSemaphore ? scipStageSemaphore.run(run) : run();
}
