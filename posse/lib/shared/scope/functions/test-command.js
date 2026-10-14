function normalizedRelativeTestScript(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw || raw.startsWith("/") || /^[A-Za-z]:\//.test(raw)) return "";
  const normalized = raw.replace(/^\.\//, "");
  const segments = normalized.split("/");
  if (segments.some((segment) => !segment || segment === "." || segment === "..")) return "";
  return normalized;
}

/**
 * Allow repository-owned executable Node regression modules without opening
 * general `node script.js` execution. The command must contain exactly one
 * relative script under test/ or tests/ and may not carry runtime flags.
 */
export function isSafeDirectNodeTestScriptArgs(args = []) {
  if (!Array.isArray(args) || args.length !== 1) return false;
  const script = normalizedRelativeTestScript(args[0]);
  return /^tests?\/.+\.(?:c|m)?js$/i.test(script);
}

// Split a test command into argv without a shell: whitespace separates
// words, single and double quotes group them, and backslash escapes
// whitespace, quotes and itself.
export function parseCommandArguments(command) {
  const tokens = [];
  let current = "";
  let tokenStarted = false;
  let quote = null;
  const value = String(command || "").trim();
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === quote) {
        quote = null;
      } else if (char === "\\" && quote === "\"" && index + 1 < value.length) {
        const next = value[index + 1];
        if (next === "\"" || next === "\\") {
          current += next;
          index++;
        } else {
          current += char;
        }
      } else {
        current += char;
      }
      continue;
    }
    if (char === "\"" || char === "'") {
      quote = char;
      tokenStarted = true;
      continue;
    }
    if (/\s/.test(char)) {
      if (tokenStarted) {
        tokens.push(current);
        current = "";
        tokenStarted = false;
      }
      continue;
    }
    if (char === "\\" && index + 1 < value.length) {
      const next = value[index + 1];
      if (/\s/.test(next) || next === "\"" || next === "'" || next === "\\") {
        current += next;
        tokenStarted = true;
        index++;
        continue;
      }
    }
    current += char;
    tokenStarted = true;
  }
  if (quote) throw new Error("test command contains an unclosed quote");
  if (tokenStarted) tokens.push(current);
  if (tokens.length === 0) throw new Error("test command is empty");
  return tokens;
}

// Quoted metacharacters are literal argv data under direct spawn (for example
// PHPUnit's --filter 'FirstTest|SecondTest'), not shell operators.
export function hasUnquotedShellOperators(command) {
  let quote = null;
  const value = String(command || "");
  for (let index = 0; index < value.length; index++) {
    const char = value[index];
    if (quote) {
      if (char === quote) quote = null;
      else if (char === "\\" && quote === '"' && ['"', "\\"].includes(value[index + 1])) index++;
    } else if (char === "\\" && /[\s'"\\]/.test(value[index + 1] || "")) {
      index++;
    } else if (char === '"' || char === "'") {
      quote = char;
    } else if (/[;&|<>]/.test(char)) {
      return true;
    }
  }
  return false;
}
