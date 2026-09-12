// Source batches share one transport bound; scalar repository limits still apply.
export const SYMBOL_GET_BATCH_POLICY = Object.freeze({ maxItems: 3, maxTokens: 8000 });
