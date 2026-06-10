import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { Display } from "../lib/domains/ui/classes/display/Display.js";

function plainEvents(display) {
  return display.events.map((event) => event.text.replace(/\x1b\[[0-9;]*m/g, ""));
}

describe("Display event filtering", () => {
  it("suppresses routine system and promote lifecycle noise", () => {
    const display = new Display({ concurrency: 1 });

    display.addEvent("[system] WI#127 job #195: started - ATLAS warm: refresh WI view");
    display.addEvent("[system] [atlas-warm initializing] warming wi");
    display.addEvent("[system] [atlas-warm scip] ingesting SCIP php.scip");
    display.addEvent("[system] WI#127 job #195: succeeded (4.1s)");
    display.addEvent("[promote] WI#127 job #191: started - Promote images for UI");
    display.addEvent("[promote] WI#127 job #191: copied 2 file(s) -> abc1234");
    display.addEvent("[assessor] WI#127 job #185: assessing polish");

    assert.deepEqual(plainEvents(display), [
      "[assessor] WI#127 job #185: assessing polish",
    ]);
  });

  it("keeps system and promote failures visible", () => {
    const display = new Display({ concurrency: 1 });

    display.addEvent("[system] WI#127 job #195: failed - ATLAS warm timeout");
    display.addEvent("[promote] WI#127 job #191 failed: Source directory missing");

    assert.deepEqual(plainEvents(display), [
      "[system] WI#127 job #195: failed - ATLAS warm timeout",
      "[promote] WI#127 job #191 failed: Source directory missing",
    ]);
  });
});
