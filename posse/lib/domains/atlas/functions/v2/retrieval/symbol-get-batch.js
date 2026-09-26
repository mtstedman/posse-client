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
  // A budget above the per-symbol cap is applied at the cap, not refused: a
  // refusal spends a whole retrieval call on nothing (Atlas533 TS_PATTERN_1
  // asked for 16000). Only a budget that is not a positive integer fails.
  const cap = SYMBOL_GET_BATCH_POLICY.maxTokensPerSymbol;
  const clampedBudgets = [];
  const withinCap = (value, label) => {
    if (value > cap) { clampedBudgets.push(`${label} ${value}`); return cap; }
    return value;
  };
  const requestedBudget = args.maxTokens ?? cap;
  if (!Number.isSafeInteger(requestedBudget) || requestedBudget < 1) {
    return { error: `symbol.get batch maxTokens must be a positive integer (at most ${cap} per symbol)` };
  }
  const perSymbolBudget = withinCap(requestedBudget, "maxTokens");
  const planned = items.slice(0, SYMBOL_GET_BATCH_POLICY.maxItems).map((item, index) => {
    if (!item || typeof item !== "object" || Array.isArray(item) || item.items != null || item.symbols != null || item.invalid) return { invalid: true };
    if (item.maxTokens != null && (!Number.isSafeInteger(item.maxTokens) || item.maxTokens < 1)) return { invalid: true };
    const selected = { ...item, maxTokens: item.maxTokens == null ? perSymbolBudget : withinCap(item.maxTokens, `items[${index}].maxTokens`) };
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
  });
  const overflow = symbolGetBatchOverflow(items);
  if (clampedBudgets.length > 0) {
    const note = `Token budget capped: ${clampedBudgets.join(", ")} exceeds the ${cap}-token per-symbol cap; ${cap} was applied.`;
    overflow.note = overflow.note ? `${note} ${overflow.note}` : note;
  }
  return { items: planned, maxTokensPerSymbol: perSymbolBudget, overflow };
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
// Rebase the content-block pointers in one structured header block. Owner
// notices and ref stubs follow the compact JSON header after a blank line;
// they survive untouched and are not part of the object being rebased.
function rebasedHeaderBlock(block, shift) {
  if (block?.type !== "text" || typeof block.text !== "string") return block;
  const at = block.text.indexOf("\n\n");
  const head = at < 0 ? block.text : block.text.slice(0, at);
  let parsed;
  try {
    parsed = JSON.parse(head);
  } catch {
    return block;
  }
  const rebase = value => {
    if (!value || typeof value !== "object") return;
    for (const [key, child] of Object.entries(value)) {
      if (["content_block", "contentBlock"].includes(key) && Number.isSafeInteger(child)) value[key] = child + shift;
      else rebase(child);
    }
  };
  rebase(parsed);
  return { ...block, text: JSON.stringify(parsed) + (at < 0 ? "" : block.text.slice(at)) };
}

// A child that is itself a combined batch (same-file ambiguity recovery
// answers one selector with several bearers) carries its own
// {"action":"symbol.get","items":[...]} header. Returns the child-local index
// of each nested item's header block, or null for an ordinary child.
function nestedBatchHeaderBlocks(blocks) {
  const first = blocks[0];
  if (first?.type !== "text" || typeof first.text !== "string") return null;
  let parsed;
  try {
    parsed = JSON.parse(first.text.split("\n\n", 1)[0]);
  } catch {
    return null;
  }
  if (parsed?.action !== "symbol.get" || !Array.isArray(parsed.items)) return null;
  return new Set(parsed.items
    .map(item => (item?.contentBlocks ?? item?.content_blocks)?.[0])
    .filter(Number.isSafeInteger));
}

export function combineSymbolGetBatchResults(results, overflow = {}) {
  const content = [{ type: "text", text: "" }];
  const items = results.map((result, index) => {
    const offset = content.length;
    const blocks = Array.isArray(result?.content) ? result.content : [];
    const nestedHeaders = nestedBatchHeaderBlocks(blocks);
    if (nestedHeaders) {
      // Flatten: drop the nested header and rebase each nested item's header
      // by where its blocks now land. Every later block stays byte-identical;
      // JSON-shaped source must not be rewritten.
      const shift = offset - 1;
      for (const [blockIndex, block] of blocks.entries()) {
        if (blockIndex === 0) continue;
        content.push(nestedHeaders.has(blockIndex) ? rebasedHeaderBlock(block, shift) : block);
      }
    } else {
      // The first child block is the structured header. Later blocks contain
      // literal source; even JSON-shaped source must remain byte-identical.
      for (const [blockIndex, block] of blocks.entries()) {
        content.push(blockIndex === 0 ? rebasedHeaderBlock(block, offset) : block);
      }
    }
    const isError = result?.isError === true;
    return {
      index,
      isError,
      ...(isError ? { errorCode: batchItemErrorCode(result) } : {}),
      contentBlocks: Array.from({ length: content.length - offset }, (_, i) => offset + i),
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
