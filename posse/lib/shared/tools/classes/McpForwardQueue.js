// Bounded forwarding for read-only Atlas calls; writes and handoffs are barriers.
import { MCP_CONCURRENT_ATLAS_ACTIONS } from "../../../catalog/mcp.js";

const concurrentAtlasActions = new Set(MCP_CONCURRENT_ATLAS_ACTIONS);

export class McpForwardQueue {
  constructor() {
    this.barrier = Promise.resolve();
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
    } else {
      this.barrier = Promise.all([this.barrier, ...this.slots]).then(async () => { await dispatch(); });
    }
    return Promise.all([this.barrier, ...this.slots]).then(() => {});
  }
}
