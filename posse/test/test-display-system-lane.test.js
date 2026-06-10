import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Display } from "../lib/domains/ui/classes/display/Display.js";

const strip = (s) => String(s || "").replace(/\x1b\[[0-9;]*m/g, "");
const logLane = (d) => d.events.map((e) => strip(e.text));
const sysLane = (d) => d._systemEvents.map((e) => strip(e.text));

describe("Display system lane", () => {
  it("routes system, git, and ATLAS reindex chatter out of the main log", () => {
    const d = new Display({ concurrency: 1 });
    d.addEvent("[assessor] WI#5 job #9: assessing");
    d.addEvent("\x1b[2m[system] committed wi-42 (3 files)\x1b[0m");
    d.addEvent("[git] WI#42: merged posse/wi-42 -> main");
    d.addEvent("ATLAS background reindex: complete for repo-a");
    d.addEvent("[atlas] reindex 1.2K symbols");

    assert.deepEqual(logLane(d), [
      "[assessor] WI#5 job #9: assessing",
    ]);
    assert.deepEqual(sysLane(d), [
      "[system] committed wi-42 (3 files)",
      "[git] WI#42: merged posse/wi-42 -> main",
      "ATLAS background reindex: complete for repo-a",
      "[atlas] reindex 1.2K symbols",
    ]);
  });

  it("promotes system/git/ATLAS failures back to the main log so they can't hide", () => {
    const d = new Display({ concurrency: 1 });
    d.addEvent("[system] push failed: remote rejected");
    d.addEvent("[git] push failed: remote rejected");
    d.addEvent("ATLAS background reindex: failed for repo-a — continuing with prior graph");

    assert.deepEqual(logLane(d), [
      "[system] push failed: remote rejected",
      "[git] push failed: remote rejected",
      "ATLAS background reindex: failed for repo-a — continuing with prior graph",
    ]);
    assert.deepEqual(sysLane(d), []);
  });

  it("caps the system ring so chatter can't grow unbounded", () => {
    const d = new Display({ concurrency: 1 });
    for (let i = 0; i < d._maxSystemEvents + 25; i++) {
      d.addEvent(`[system] committed wi-${i}`);
    }
    assert.equal(d._systemEvents.length, d._maxSystemEvents);
    // Oldest dropped, newest retained.
    assert.match(strip(d._systemEvents.at(-1).text), /wi-\d+$/);
    assert.ok(!sysLane(d).some((t) => t.endsWith("wi-0")));
  });

  it("pins a bounded system tail to the bottom of the event pane", () => {
    const d = new Display({ concurrency: 1 });
    for (let i = 0; i < 6; i++) d.addEvent(`[assessor] WI#${i} job: step ${i}`);
    d.addEvent("[system] committed wi-42 (3 files)");
    d.addEvent("[git] WI#42: merged posse/wi-42 -> main");
    d.addEvent("ATLAS background reindex: complete for repo-a");
    d.addEvent("[atlas] reindex 1.2K symbols");

    const rows = d._buildRight(70, 16).map(strip);
    const ruleIdx = rows.findIndex((r) => /╌+ system ╌+/.test(r));
    assert.ok(ruleIdx >= 0, "expected a 'system' rule row");
    // Tail capped at _systemLaneRows and pinned at the very bottom.
    const tail = rows.slice(ruleIdx + 1).filter((r) => r.trim().length > 0);
    assert.equal(tail.length, d._systemLaneRows);
    assert.match(tail.at(-1), /\[atlas\] reindex 1\.2K symbols/);
    // The main job log still shows above the rule.
    assert.ok(rows.slice(0, ruleIdx).some((r) => /WI#5 job: step 5/.test(r)));
  });

  it("hides the system tail entirely when there is no system chatter", () => {
    const d = new Display({ concurrency: 1 });
    d.addEvent("[assessor] WI#5 job #9: assessing");
    const rows = d._buildRight(70, 16).map(strip);
    assert.ok(!rows.some((r) => /╌+ system ╌+/.test(r)), "no system rule when the lane is empty");
  });
});
