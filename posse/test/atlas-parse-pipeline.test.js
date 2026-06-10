import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { ParseSemaphore } from "../lib/domains/atlas/functions/v2/parse/semaphore.js";
import { runParsePipeline } from "../lib/domains/atlas/functions/v2/parse/pipeline.js";
import { atlasParseEvent, legacyAtlasWarmAlias } from "../lib/domains/atlas/functions/v2/parse/events.js";
import { bucketPathsByLanguage } from "../lib/domains/atlas/functions/v2/parse/language-buckets.js";

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("Atlas parse pipeline primitives", () => {
  it("serializes DB writes while allowing SCIP stage concurrency to be capped separately", async () => {
    const db = new ParseSemaphore(1);
    const scip = new ParseSemaphore(2);
    let dbActive = 0;
    let dbMax = 0;
    let scipActive = 0;
    let scipMax = 0;

    await Promise.all([
      ...[0, 1, 2].map(() => db.run(async () => {
        dbActive++;
        dbMax = Math.max(dbMax, dbActive);
        await delay(20);
        dbActive--;
      })),
      ...[0, 1, 2, 3].map(() => scip.run(async () => {
        scipActive++;
        scipMax = Math.max(scipMax, scipActive);
        await delay(20);
        scipActive--;
      })),
    ]);

    assert.equal(dbMax, 1);
    assert.equal(scipMax, 2);
  });

  it("runs per-language parse, stage, ingest, and merge through the expected semaphores", async () => {
    const db = new ParseSemaphore(1);
    const scip = new ParseSemaphore(2);
    const calls = [];
    const events = [];

    await runParsePipeline({
      languages: ["ts", "py"],
      dbWriteSemaphore: db,
      scipStageSemaphore: scip,
      onEvent: (event) => events.push(event.kind),
      parseLanguage: async (lang) => {
        calls.push(`parse:${lang}`);
      },
      stageScip: async (lang) => {
        calls.push(`stage:${lang}`);
        return `${lang}.scip`;
      },
      ingestScip: async (lang, staged) => {
        calls.push(`ingest:${lang}:${staged}`);
      },
      mergeLanguage: async (lang, sources) => {
        calls.push(`merge:${lang}:${sources.join("+")}`);
      },
    });

    assert.ok(calls.includes("parse:ts"));
    assert.ok(calls.includes("stage:py"));
    assert.ok(calls.includes("ingest:ts:ts.scip"));
    assert.ok(calls.includes("merge:py:treesitter+scip"));
    assert.ok(events.includes("atlas.parse.parse.started"));
    assert.ok(events.includes("atlas.parse.scip.stage.completed"));
  });

  it("emits atlas.parse events with one-release atlas.warm aliases", () => {
    const event = atlasParseEvent("atlas.parse.parse.completed", { lang: "ts" });
    const legacy = legacyAtlasWarmAlias(event);
    assert.equal(event.kind, "atlas.parse.parse.completed");
    assert.equal(legacy?.kind, "atlas.warm.parse.completed");
    assert.equal(legacy?.aliasedFrom, "atlas.parse.parse.completed");
  });

  it("buckets paths by language", () => {
    const buckets = bucketPathsByLanguage(["src/a.ts", "lib/b.py", "README.md"]);
    assert.deepEqual(buckets.get("ts"), ["src/a.ts"]);
    assert.deepEqual(buckets.get("py"), ["lib/b.py"]);
    assert.deepEqual(buckets.get("unknown"), ["README.md"]);
  });
});
