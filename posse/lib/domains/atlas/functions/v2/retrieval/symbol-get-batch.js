import { SYMBOL_GET_BATCH_POLICY } from "../../../../../catalog/symbol-get-batch.js";

export function planSymbolGetBatch(args, {resolveSymbolId = null, sourcePathForId = null} = {}) {
  if (!Array.isArray(args?.items)) return { error: "symbol.get items must be an array" };
  if (args.items.length < 1 || args.items.length > SYMBOL_GET_BATCH_POLICY.maxItems) {
    return { error: `symbol.get items requires 1-${SYMBOL_GET_BATCH_POLICY.maxItems} selectors` };
  }
  if (["symbolId", "symbolHandle", "symbolRef", "file", "path", "identifiersToFind"].some(key => args[key] != null)) {
    return { error: "symbol.get batch cannot be combined with scalar selector fields" };
  }
  const budget = args.maxTokens ?? SYMBOL_GET_BATCH_POLICY.maxTokens;
  if (!Number.isSafeInteger(budget) || budget < args.items.length || budget > SYMBOL_GET_BATCH_POLICY.maxTokens) {
    return { error: `symbol.get batch maxTokens must be between item count and ${SYMBOL_GET_BATCH_POLICY.maxTokens}` };
  }
  const share = Math.floor(budget / args.items.length);
  return { items: args.items.map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.items != null) return { invalid: true };
    if (item.maxTokens != null && (!Number.isSafeInteger(item.maxTokens) || item.maxTokens < 1)) return { invalid: true };
    const selected = { ...item, maxTokens: Math.min(item.maxTokens ?? share, share) };
    if (selected.symbolId && resolveSymbolId) {
      const resolved = resolveSymbolId(selected.symbolId);
      if (!resolved.ok) return {invalid: true, error: "Unknown session-bound symbol handle in batch item"};
      selected.symbolId = resolved.value;
      if (!selected.file && sourcePathForId) {
        const file = sourcePathForId(resolved.value);
        if (file) selected.file = file;
      }
    }
    return selected;
  }), maxTokens: budget };
}

// Each child passed through normal admission, custody, paging and projection.
// Preserve raw source blocks; lift their indexes into the combined MCP response.
export function combineSymbolGetBatchResults(results) {
  const content = [{ type: "text", text: "" }];
  const items = results.map((result, index) => {
    const offset = content.length;
    const blocks = Array.isArray(result?.content) ? result.content : [];
    for (const block of blocks) {
      if (block?.type !== "text" || typeof block.text !== "string") { content.push(block); continue; }
      const at = block.text.indexOf("\n\n[");
      const head = at < 0 ? block.text : block.text.slice(0, at);
      try {
        const parsed = JSON.parse(head);
        const shift = value => {
          if (!value || typeof value !== "object") return;
          for (const [key, child] of Object.entries(value)) {
            if (["content_block", "contentBlock"].includes(key) && Number.isSafeInteger(child)) value[key] = child + offset;
            else shift(child);
          }
        };
        shift(parsed);
        content.push({ ...block, text: JSON.stringify(parsed) + (at < 0 ? "" : block.text.slice(at)) });
      } catch { content.push(block); }
    }
    return { index, isError: result?.isError === true, contentBlocks: blocks.map((_, i) => offset + i) };
  });
  content[0].text = JSON.stringify({ action: "symbol.get", items });
  return { content, isError: items.every(item => item.isError), _meta: { symbolGetBatch: { count: items.length, failed: items.filter(item => item.isError).length } } };
}
