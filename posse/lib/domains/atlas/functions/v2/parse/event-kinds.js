// @ts-check

export const TERMINAL_PARSE_KIND_SUFFIX_RE = /\.(?:completed|failed|skipped)$/;

export function isTerminalParseKind(kind = "") {
  return TERMINAL_PARSE_KIND_SUFFIX_RE.test(String(kind || ""));
}
