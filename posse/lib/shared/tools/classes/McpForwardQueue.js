// Bounded Atlas reads and a claim-save lane; other writes and handoffs are barriers.
import { MCP_CONCURRENT_ATLAS_ACTIONS } from "../../../catalog/mcp.js";
import { canonicalToolNameForBatching, getToolBatchingClass, TOOL_BATCHING_CLASSES } from "../../../catalog/tool-surface/batching.js";

const concurrentAtlasActions = new Set(MCP_CONCURRENT_ATLAS_ACTIONS);

export class McpForwardQueue {
  constructor() {
    this.barrier = Promise.resolve();
    this.claimWrites = Promise.resolve();
    this.slots = Array.from({ length: 4 }, () => Promise.resolve());
    this.next = 0;
  }

  enqueue(message, dispatch) {
    const name = String(message?.params?.name || "");
    const action = name === "atlas.query" ? message?.params?.arguments?.action
      : name.startsWith("atlas.") ? name.slice(6) : null;
    if (message?.method === "tools/call" && concurrentAtlasActions.has(action)) {
      const slot = this.next++ % this.slots.length;
      this.slots[slot] = Promise.all([this.barrier, this.slots[slot]]).then(async () => { await dispatch(); });
    } else if (message?.method === "tools/call"
      && getToolBatchingClass(canonicalToolNameForBatching(name)) === TOOL_BATCHING_CLASSES.PARALLEL_WRITE) {
      // Preserve put/revise/remove order while independent source reads run.
      this.claimWrites = Promise.all([this.barrier, this.claimWrites]).then(async () => { await dispatch(); });
    } else {
      this.barrier = Promise.all([this.barrier, this.claimWrites, ...this.slots]).then(async () => { await dispatch(); });
    }
    return Promise.all([this.barrier, this.claimWrites, ...this.slots]).then(() => {});
  }
}
