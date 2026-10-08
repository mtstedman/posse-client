// Select Remote-owned contract fragments against the final provider surface.
// Conditions disappear before the prompt reaches the model. A fallback is
// supplied by Remote only when that role has a supported non-tool output.
export function selectPromptToolConditions(prompt, { hasTool, hasSuite }) {
  const tokens = /\{\{(#|\/)(tool|suite):([a-zA-Z0-9_.]+)\}\}|\{\{else\}\}/g;
  const root = { enabled: true, parts: [] };
  const stack = [root];
  let offset = 0;
  for (const match of String(prompt).matchAll(tokens)) {
    const current = stack.at(-1);
    if (current.enabled) current.parts.push(prompt.slice(offset, match.index));
    if (match[0] === "{{else}}") {
      if (stack.length === 1 || current.otherwise) throw new Error("Invalid prompt tool condition fallback");
      current.otherwise = true;
      current.enabled = current.parentEnabled && !current.available;
    } else if (match[1] === "#") {
      const available = current.enabled && (match[2] === "tool" ? hasTool(match[3]) : hasSuite(match[3]));
      stack.push({
        key: `${match[2]}:${match[3]}`, available, parentEnabled: current.enabled,
        enabled: current.enabled && available, parts: [], otherwise: false,
      });
    } else {
      if (stack.length === 1 || current.key !== `${match[2]}:${match[3]}`) {
        throw new Error("Mismatched prompt tool condition");
      }
      stack.pop();
      stack.at(-1).parts.push(current.parts.join(""));
    }
    offset = match.index + match[0].length;
  }
  if (stack.length !== 1) throw new Error("Unclosed prompt tool condition");
  root.parts.push(prompt.slice(offset));
  return root.parts.join("");
}
