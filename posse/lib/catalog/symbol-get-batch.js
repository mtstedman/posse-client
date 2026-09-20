// Each requested symbol receives its own bounded source allowance. Oversized
// bodies continue through the normal traversal-ref paging path.
export const SYMBOL_GET_BATCH_POLICY = Object.freeze({ maxItems: 10, maxTokensPerSymbol: 8000 });
