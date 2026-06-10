import { describe, it } from "node:test";
import assert from "node:assert/strict";

import { classifyAtlasPrefetchRelevance } from "../lib/domains/handoff/functions/helpers/atlas-context.js";

function packetWithSlice(taskText, slice) {
  return {
    recipient: "planner",
    atlas: { active: true },
    _raw_payload: { task_spec: taskText },
    atlas_slice_context: {
      ok: true,
      ...slice,
    },
  };
}

describe("ATLAS prefetch relevance classification", () => {
  it("does not treat an unrelated nonempty slice as relevant", () => {
    const packet = packetWithSlice(
      "Trace how a featured-broadcast decision propagates from the PHP backend to the React homepage",
      {
        cardCount: 2,
        filePaths: ["tests/encoder-relay.test.php"],
        cards: [
          {
            name: "EncoderRelayTest",
            file: "tests/encoder-relay.test.php",
            summary: "Covers encoder relay fixture behavior.",
          },
        ],
      },
    );

    assert.equal(classifyAtlasPrefetchRelevance(packet, "planner"), false);
  });

  it("accepts an unscoped slice with task-token overlap", () => {
    const packet = packetWithSlice(
      "Trace how a featured-broadcast decision propagates from the PHP backend to the React homepage",
      {
        cardCount: 2,
        filePaths: ["app/FeaturedBroadcastDecision.php"],
        cards: [
          {
            name: "FeaturedBroadcastDecision",
            file: "app/FeaturedBroadcastDecision.php",
            summary: "Selects the featured broadcast for the homepage.",
          },
        ],
      },
    );

    assert.equal(classifyAtlasPrefetchRelevance(packet, "planner"), true);
  });
});
