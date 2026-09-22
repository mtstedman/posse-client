import { SYMBOL_GET_BATCH_POLICY } from "../../../../../catalog/symbol-get-batch.js";

export function isSymbolGetBatch(args) {
  return args?.items != null || args?.symbols != null;
}

export function planSymbolGetBatch(args, {resolveSymbolId = null, sourcePathForId = null} = {}) {
  const sharedFile = args?.symbols != null;
  const field = sharedFile ? "symbols" : "items";
  if (!Array.isArray(args?.[field])) return { error: `symbol.get ${field} must be an array` };
  if (args[field].length < 1) {
    return { error: `symbol.get ${field} requires at least one selector` };
  }
  if (sharedFile && (typeof args.file !== "string" || !args.file.trim())) {
    return { error: "symbol.get symbols requires a shared file" };
  }
  const incompatible = ["symbolId", "symbolHandle", "symbolRef", "path", "identifiersToFind",
    ...(sharedFile ? ["items"] : ["file"])];
  if (incompatible.some(key => args[key] != null)) {
    return { error: "symbol.get batch cannot be combined with scalar selector fields" };
  }
  // Expand names locally, without lookup or IO. Only the accepted prefix below
  // is resolved/executed; the excluded tail is retained for the existing notice.
  const items = sharedFile ? args.symbols.map(name => (
    typeof name === "string" && name.trim()
      ? { symbolRef: { name, file: args.file } }
      : { invalid: true }
  )) : args.items;
  const perSymbolBudget = args.maxTokens ?? SYMBOL_GET_BATCH_POLICY.maxTokensPerSymbol;
  if (!Number.isSafeInteger(perSymbolBudget) || perSymbolBudget < 1 || perSymbolBudget > SYMBOL_GET_BATCH_POLICY.maxTokensPerSymbol) {
    return { error: `symbol.get batch maxTokens must be between 1 and ${SYMBOL_GET_BATCH_POLICY.maxTokensPerSymbol} per symbol` };
  }
  return { items: items.slice(0, SYMBOL_GET_BATCH_POLICY.maxItems).map(item => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.items != null || item.symbols != null || item.invalid) return { invalid: true };
    if (item.maxTokens != null && (
      !Number.isSafeInteger(item.maxTokens)
      || item.maxTokens < 1
      || item.maxTokens > SYMBOL_GET_BATCH_POLICY.maxTokensPerSymbol
    )) return { invalid: true };
    const selected = { ...item, maxTokens: item.maxTokens ?? perSymbolBudget };
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
  }), maxTokensPerSymbol: perSymbolBudget, overflow: symbolGetBatchOverflow(items) };
}

function symbolGetBatchOverflow(items) {
  const cap = SYMBOL_GET_BATCH_POLICY.maxItems;
  if (items.length <= cap) return {};
  const excluded = items.slice(cap).map((item, offset) => ({
    index: cap + offset,
    selector: Object.fromEntries(["symbolId", "symbolHandle", "symbolRef", "file"]
      .filter(key => item && typeof item === "object" && Object.hasOwn(item, key))
      .map(key => [key, item[key]])),
  }));
  return {
    note: `Batch cap applied: processed the first ${cap} of ${items.length} requested items. Excluded selectors are listed in excluded with zero-based indexes; they were not executed.`,
    excluded,
  };
}

// Each child passed through normal admission, custody, paging and projection.
// Preserve raw source blocks; lift their indexes into the combined MCP response.
export function combineSymbolGetBatchResults(results, overflow = {}) {
  const content = [{ type: "text", text: "" }];
  const items = results.map((result, index) => {
    const offset = content.length;
    const blocks = Array.isArray(result?.content) ? result.content : [];
    for (const [blockIndex, block] of blocks.entries()) {
      // The first child block is the structured header. Later blocks contain
      // literal source; even JSON-shaped source must remain byte-identical.
      if (blockIndex !== 0 || block?.type !== "text" || typeof block.text !== "string") { content.push(block); continue; }
      // Owner notices and ref stubs follow the compact JSON header. Both must
      // survive, but neither is part of the object whose pointers we rebase.
      const at = block.text.indexOf("\n\n");
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
    const isError = result?.isError === true;
    return {
      index,
      isError,
      ...(isError ? { errorCode: batchItemErrorCode(result) } : {}),
      contentBlocks: blocks.map((_, i) => offset + i),
    };
  });
  content[0].text = JSON.stringify({ action: "symbol.get", items, ...overflow });
  return { content, isError: items.every(item => item.isError), _meta: { symbolGetBatch: { count: items.length, failed: items.filter(item => item.isError).length } } };
}

function batchItemErrorCode(result) {
  const direct = result?._meta?.atlasError?.code ?? result?.structuredContent?.error?.code;
  if (direct) return String(direct);
  const first = result?.content?.[0];
  if (first?.type === "text" && typeof first.text === "string") {
    try {
      const parsed = JSON.parse(first.text.split("\n\n", 1)[0]);
      const code = parsed?.error?.code ?? parsed?.code;
      if (code) return String(code);
    } catch { /* unstructured child error */ }
  }
  return "unknown";
}
