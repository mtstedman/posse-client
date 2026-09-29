// Claude Code refuses a tool name it was not given before the call reaches
// MCP and answers the model with a tool_result error ("No such tool
// available: <name>"). Those refusals never reach the Posse gateway, so the
// provider stream is the only place they can be observed.

const UNKNOWN_TOOL_RE = /No such tool available(?::\s*([^\s<>"'`]+))?/i;
const MCP_PREFIX_RE = /^mcp__.+?__/i;

function toolResultText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (typeof part === "string" ? part : (typeof part?.text === "string" ? part.text : "")))
    .filter(Boolean)
    .join("\n");
}

/**
 * Unknown-tool refusals carried by one Claude stream-json message.
 * @param {object} message
 * @returns {{ toolUseId: string | null, attempted: string | null }[]}
 */
export function extractClaudeUnknownToolResults(message) {
  if (message?.type !== "user") return [];
  const content = message?.message?.content;
  if (!Array.isArray(content)) return [];
  const refusals = [];
  for (const block of content) {
    if (block?.type !== "tool_result") continue;
    const text = toolResultText(block.content);
    // A successful read can quote the phrase; only a refusal is an error.
    if (block.is_error !== true && !/^\s*<tool_use_error>/i.test(text)) continue;
    const match = UNKNOWN_TOOL_RE.exec(text);
    if (!match) continue;
    refusals.push({
      toolUseId: typeof block.tool_use_id === "string" && block.tool_use_id.trim()
        ? block.tool_use_id.trim()
        : null,
      attempted: match[1] ? match[1].trim() : null,
    });
  }
  return refusals;
}

function coreToolName(name) {
  let core = String(name || "").trim();
  // Double-prefixed guesses repeat the server namespace.
  while (MCP_PREFIX_RE.test(core)) core = core.replace(MCP_PREFIX_RE, "");
  return core
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "");
}

function editDistance(a, b) {
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
  for (let i = 1; i <= a.length; i += 1) {
    let diagonal = previous[0];
    previous[0] = i;
    for (let j = 1; j <= b.length; j += 1) {
      const above = previous[j];
      previous[j] = Math.min(
        previous[j] + 1,
        previous[j - 1] + 1,
        diagonal + (a[i - 1] === b[j - 1] ? 0 : 1),
      );
      diagonal = above;
    }
  }
  return previous[b.length];
}

/**
 * The issued callable name the attempted name most plausibly meant, or null.
 * Matches ignore the MCP server namespace, punctuation, and a missing suite
 * prefix (read_file -> tools_read_file); otherwise a small edit distance.
 * @param {string} attempted
 * @param {Iterable<string>} issuedNames
 * @returns {string | null}
 */
export function nearestIssuedClaudeToolName(attempted, issuedNames = []) {
  const target = coreToolName(attempted);
  if (!target) return null;
  const candidates = [...new Set([...(issuedNames || [])].map((name) => String(name || "").trim()).filter(Boolean))]
    .map((name) => ({ name, core: coreToolName(name) }))
    .filter((candidate) => candidate.core);
  const exact = candidates.find((candidate) => candidate.core === target);
  if (exact) return exact.name;
  const suffix = candidates.find((candidate) => candidate.core.endsWith(`_${target}`)
    || target.endsWith(`_${candidate.core}`));
  if (suffix) return suffix.name;
  let best = null;
  for (const candidate of candidates) {
    const distance = editDistance(target, candidate.core);
    if (!best || distance < best.distance) best = { name: candidate.name, distance };
  }
  const tolerance = Math.max(2, Math.floor(target.length / 4));
  return best && best.distance <= tolerance ? best.name : null;
}
