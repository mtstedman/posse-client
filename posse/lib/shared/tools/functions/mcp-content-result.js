// @ts-check
//
// A deterministic tool normally returns a string, which the MCP gateway sends
// as one text content block. A tool that must also deliver non-text content
// (view_image returns the image itself) returns an MCP content result: the
// text keeps driving outcome classification, telemetry, and owner notices
// exactly like a string result, and the extra blocks ride after it.

const MCP_CONTENT_RESULT = Symbol.for("posse.mcp_content_result");

/**
 * @param {string} text
 * @param {Array<Record<string, unknown>>} [content] extra MCP content blocks
 */
export function mcpContentResult(text, content = []) {
  return Object.freeze({
    [MCP_CONTENT_RESULT]: true,
    text: String(text ?? ""),
    content: Object.freeze(Array.isArray(content) ? content.filter((block) => block && typeof block === "object") : []),
  });
}

/**
 * @param {unknown} value
 * @returns {{ text: string, content: ReadonlyArray<Record<string, unknown>> } | null}
 */
export function asMcpContentResult(value) {
  if (!value || typeof value !== "object") return null;
  // @ts-ignore symbol-branded result
  if (value[MCP_CONTENT_RESULT] !== true) return null;
  // @ts-ignore checked brand
  return value;
}

// Match native string accounting, including every image and metadata string.
export function toolResultStringChars(value) {
  if (typeof value === "string") {
    let count = 0;
    for (const _character of value) count++;
    return count;
  }
  if (!value || typeof value !== "object") return 0;
  return Object.values(value).reduce((total, item) => total + toolResultStringChars(item), 0);
}

export function boundToolResult(result, maxChars) {
  let reason = null;
  for (const block of result?.content || []) {
    if (block?.type === "image" && (typeof block.data !== "string" || !block.data.length
      || block.data.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(block.data))) {
      reason = "Error: image delivery failed: invalid base64 image content.";
    }
  }
  if (toolResultStringChars(result) > maxChars) {
    reason = "Error: tool result delivery failed: content exceeds the dispatch character limit. Request a smaller preview or response.";
  }
  if (!reason) return result;
  return { isError: true, content: maxChars > 4
    ? [{ type: "text", text: reason.slice(0, maxChars - 4) }] : [] };
}
