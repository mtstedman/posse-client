// @ts-check

function positiveAgentCallId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

/**
 * Parent-process signal bus for terminal handoff receipts. The handoff packet
 * remains SQLite-owned; this bus carries only the fact that the provider has
 * received the successful tool receipt and its turn may now be stopped.
 */
export class AgentHandoffTerminator {
  constructor() {
    this.listeners = new Map();
  }

  subscribe(agentCallId, listener) {
    const id = positiveAgentCallId(agentCallId);
    if (!id) throw new TypeError("AgentHandoffTerminator.subscribe requires an agent call id");
    if (typeof listener !== "function") throw new TypeError("AgentHandoffTerminator.subscribe requires a listener");
    let listeners = this.listeners.get(id);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(id, listeners);
    }
    listeners.add(listener);
    let active = true;
    return () => {
      if (!active) return false;
      active = false;
      listeners.delete(listener);
      if (listeners.size === 0) this.listeners.delete(id);
      return true;
    };
  }

  acknowledge(agentCallId, detail = {}) {
    const id = positiveAgentCallId(agentCallId);
    if (!id) return 0;
    const listeners = [...(this.listeners.get(id) || [])];
    if (listeners.length === 0) return 0;
    const event = Object.freeze({
      ...detail,
      agentCallId: id,
      acknowledgedAt: Date.now(),
    });
    for (const listener of listeners) {
      try { listener(event); } catch { /* terminal notification is best effort */ }
    }
    return listeners.length;
  }
}

export const agentHandoffTerminator = new AgentHandoffTerminator();
