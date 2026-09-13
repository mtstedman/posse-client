const tokenFields = ["input_tokens", "output_tokens", "cache_read_input_tokens", "cache_creation_input_tokens"];
const token = (value) => Number.isSafeInteger(value) && value >= 0 ? value : null;

// Claude may finish a terminal tool handoff without emitting a CLI result.
// Keep completed API message usage independently of that CLI closeout. Split
// content rows repeat usage; their message IDs, not rows, own the counters.
export class ClaudeStreamTelemetry {
  constructor() {
    this.messages = new Map();
    this.activeId = null;
    this.thinkingBlocks = new Map();
    this.childUsagePossible = false;
  }

  observe(envelope) {
    if (!envelope || envelope.isSidechain || envelope.parent_tool_use_id) {
      if (envelope?.parent_tool_use_id) this.childUsagePossible = true;
      return [];
    }
    const event = envelope.type === "stream_event" ? envelope.event : envelope;
    if (!event) return [];
    const summaries = [];
    if (event.type === "assistant" || event.type === "message_start") {
      const message = event.message;
      if (!message?.id || message.model === "<synthetic>") return summaries;
      const previous = this.messages.get(message.id) || {};
      this.messages.set(message.id, {
        ...previous, ...message,
        usage: { ...previous.usage, ...message.usage },
      });
      this.activeId = message.id;
      for (const [index, block] of (Array.isArray(message.content) ? message.content : []).entries()) {
        if (block.type === "tool_use" && ["Agent", "Task"].includes(block.name)) this.childUsagePossible = true;
        if (block.type !== "thinking") continue;
        // Signatures identify opaque signed blocks; never decode or display them.
        const key = `${message.id}:${block.signature || index}`;
        const text = typeof block.thinking === "string" ? block.thinking : "";
        const previousText = this.thinkingBlocks.get(key);
        this.thinkingBlocks.set(key, text);
        if (text && text !== previousText) summaries.push(text);
      }
    } else if (event.type === "message_delta" && this.activeId) {
      const previous = this.messages.get(this.activeId);
      this.messages.set(this.activeId, {
        ...previous, ...event.delta,
        usage: { ...previous.usage, ...event.usage },
      });
    } else if (event.type === "message_stop") this.activeId = null;
    return summaries;
  }

  snapshot() {
    const complete = [...this.messages.values()].filter((message) => message.stop_reason
      && tokenFields.every((field) => token(message.usage?.[field]) != null));
    const finalized = complete.length > 0 && complete.length === this.messages.size && !this.childUsagePossible;
    const usage = Object.fromEntries(tokenFields.map((field) => [field, 0]));
    let reasoning = 0;
    let reasoningKnown = true;
    const segments = complete.map((message) => {
      for (const field of tokenFields) usage[field] += message.usage[field];
      const thinking = token(message.usage.output_tokens_details?.thinking_tokens
        ?? message.usage.output_tokens_details?.reasoning_tokens);
      if (thinking == null || thinking > message.usage.output_tokens) reasoningKnown = false;
      else reasoning += thinking;
      return { messageId: message.id, model: message.model, usage: message.usage };
    });
    if (reasoningKnown) usage.output_tokens_details = { thinking_tokens: reasoning };
    const visible = [...this.thinkingBlocks.values()].filter(Boolean);
    return {
      finalized,
      usage: finalized ? usage : {},
      numTurns: finalized ? complete.length : null,
      segments,
      thinking: {
        blocks: this.thinkingBlocks.size,
        visibleBlocks: visible.length,
        visibleChars: visible.reduce((sum, text) => sum + text.length, 0),
      },
    };
  }
}
