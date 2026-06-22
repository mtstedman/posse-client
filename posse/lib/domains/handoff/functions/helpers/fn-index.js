// lib/domains/handoff/functions/helpers/fn-index.js
//
// JS/TS function/class index parser and smart preload builder.

import { SMART_PRELOAD_INDEXABLE_EXTENSIONS } from "../../../../catalog/files.js";

export const INDEXABLE_EXTENSIONS = SMART_PRELOAD_INDEXABLE_EXTENSIONS;
const SMART_PRELOAD_THRESHOLD = 80; // lines — files below this are included whole

const JS_KEYWORD_SKIP = new Set([
  "if", "for", "while", "switch", "catch", "return", "else",
  "new", "super", "this", "typeof", "instanceof", "void", "delete",
  "import", "require", "from", "throw", "yield", "await",
]);

function freshParseState() {
  return {
    inSingle: false,
    inDouble: false,
    inTemplate: false,
    inBlockComment: false,
    inRegex: false,
    regexCharClass: false,
    templateStack: [],
    prevToken: null,
  };
}

function canStartRegex(prevToken) {
  return prevToken == null || [
    "(", "{", "[", "=", ":", ",", ";", "!", "?", "+", "-", "*", "%", "&", "|", "^", "~", "<", ">", "\n",
  ].includes(prevToken);
}

function stripNonCode(text, state) {
  let sanitized = "";

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    const next = text[i + 1];

    if (state.inBlockComment) {
      if (ch === "*" && next === "/") {
        state.inBlockComment = false;
        sanitized += "  ";
        i++;
      } else {
        sanitized += " ";
      }
      continue;
    }

    if (state.inSingle) {
      sanitized += " ";
      if (ch === "\\" && i + 1 < text.length) {
        sanitized += " ";
        i++;
        continue;
      }
      if (ch === "'") state.inSingle = false;
      continue;
    }

    if (state.inDouble) {
      sanitized += " ";
      if (ch === "\\" && i + 1 < text.length) {
        sanitized += " ";
        i++;
        continue;
      }
      if (ch === "\"") state.inDouble = false;
      continue;
    }

    if (state.inRegex) {
      sanitized += " ";
      if (ch === "\\" && i + 1 < text.length) {
        sanitized += " ";
        i++;
        continue;
      }
      if (ch === "[" && !state.regexCharClass) state.regexCharClass = true;
      else if (ch === "]" && state.regexCharClass) state.regexCharClass = false;
      else if (ch === "/" && !state.regexCharClass) state.inRegex = false;
      continue;
    }

    if (state.inTemplate) {
      if (ch === "\\" && i + 1 < text.length) {
        sanitized += "  ";
        i++;
        continue;
      }
      if (ch === "`") {
        state.inTemplate = false;
        sanitized += " ";
        continue;
      }
      if (ch === "$" && next === "{") {
        state.templateStack.push(0);
        state.inTemplate = false;
        sanitized += "  ";
        i++;
        state.prevToken = "{";
        continue;
      }
      sanitized += " ";
      continue;
    }

    if (ch === "/" && next === "/") {
      sanitized += " ".repeat(text.length - i);
      break;
    }
    if (ch === "/" && next === "*") {
      state.inBlockComment = true;
      sanitized += "  ";
      i++;
      continue;
    }
    if (ch === "'") {
      state.inSingle = true;
      sanitized += " ";
      continue;
    }
    if (ch === "\"") {
      state.inDouble = true;
      sanitized += " ";
      continue;
    }
    if (ch === "`") {
      state.inTemplate = true;
      sanitized += " ";
      continue;
    }
    if (ch === "/" && canStartRegex(state.prevToken)) {
      state.inRegex = true;
      state.regexCharClass = false;
      sanitized += " ";
      continue;
    }

    if (ch === "{") {
      if (state.templateStack.length > 0) {
        state.templateStack[state.templateStack.length - 1]++;
      }
      state.prevToken = "{";
    } else if (ch === "}") {
      if (state.templateStack.length > 0) {
        const top = state.templateStack[state.templateStack.length - 1] - 1;
        if (top < 0) {
          state.templateStack.pop();
          state.inTemplate = true;
          sanitized += " ";
          continue;
        }
        state.templateStack[state.templateStack.length - 1] = top;
      }
      state.prevToken = "}";
    } else if (!/\s/.test(ch)) {
      state.prevToken = ch;
    }

    sanitized += ch;
  }

  return sanitized;
}

function braceDepthChange(text, state) {
  const masked = stripNonCode(text, state);
  let delta = 0;
  for (const ch of masked) {
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

function braceDeltaMasked(maskedLine) {
  let delta = 0;
  for (const ch of maskedLine) {
    if (ch === "{") delta++;
    else if (ch === "}") delta--;
  }
  return delta;
}

function normalizeSignatureSnippet(lines) {
  return lines
    .join("\n")
    .replace(/\s+/g, " ")
    .trim();
}

function matchDefinition(snippet) {
  const patterns = [
    /^(?:export\s+(?:default\s+)?)?(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*(?:<[^>{}]*>)?\s*\(/,
    /^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?function\b/,
    /^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:<[^>{}]*>\s*)?\(/,
    /^(?:export\s+(?:default\s+)?)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?[A-Za-z_$][\w$]*\s*=>/,
    /^(?:export\s+(?:default\s+)?)?class\s+([A-Za-z_$][\w$]*)\b/,
  ];
  for (const pattern of patterns) {
    const match = snippet.match(pattern);
    if (match) {
      return {
        kind: pattern.source.includes("class") ? "class" : "function",
        name: match[1],
      };
    }
  }
  return null;
}

function matchClassMember(snippet) {
  const patterns = [
    /^(?:\s*(?:public|private|protected|readonly|declare|abstract|override|final)\s+)*(?:static\s+)?(?:function\s+)(?:&\s*)?(\#?[A-Za-z_$][\w$]*)\s*\(/,
    /^(?:\s*(?:public|private|protected|readonly|declare|abstract|override)\s+)*(?:static\s+)?(?:async\s+)?(?:get\s+|set\s+)?(\#?[A-Za-z_$][\w$]*)\s*(?:<[^>{}]*>)?\s*\(/,
    /^(?:\s*(?:public|private|protected|readonly|declare|abstract|override)\s+)*(?:static\s+)?\*\s*(\#?[A-Za-z_$][\w$]*)\s*\(/,
    /^(?:\s*(?:public|private|protected|readonly|declare|abstract|override)\s+)*(?:static\s+)?(\#?[A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:\([^)]*\)|[A-Za-z_$][\w$]*)\s*=>/,
  ];
  for (const pattern of patterns) {
    const match = snippet.match(pattern);
    if (match && !JS_KEYWORD_SKIP.has(match[1])) {
      return match[1];
    }
  }
  return null;
}

function findOpeningBraceIndex(codeLines, startLineIdx) {
  for (let i = startLineIdx; i < Math.min(startLineIdx + 8, codeLines.length); i++) {
    const idx = codeLines[i].indexOf("{");
    if (idx !== -1) return i;
    if (codeLines[i].includes("=>") && !codeLines[i].includes("{")) return -1;
  }
  return -1;
}

function findDefinitionEnd(lines, braceStart) {
  let depth = 0;
  let endIdx = braceStart;
  const bodyState = freshParseState();
  for (let j = braceStart; j < lines.length; j++) {
    depth += braceDepthChange(lines[j], bodyState);
    if (depth <= 0) { endIdx = j; break; }
    if (j - braceStart > 2000) { endIdx = j; break; }
  }
  return endIdx;
}

function extractClassMembers(lines, codeLines, classStart, classEnd, className) {
  const members = [];
  let depth = 0;

  for (let i = classStart + 1; i < classEnd; i++) {
    const codeLine = codeLines[i];
    if (depth !== 0) {
      depth += braceDeltaMasked(codeLine);
      continue;
    }
    if (!codeLine.trim()) continue;

    const snippet = normalizeSignatureSnippet(codeLines.slice(i, Math.min(i + 6, classEnd)));
    const memberName = matchClassMember(snippet);
    if (!memberName) {
      depth += braceDeltaMasked(codeLine);
      continue;
    }

    const braceStart = findOpeningBraceIndex(codeLines, i);
    const signature = lines[i].trim();

    if (braceStart === -1) {
      members.push({
        name: `${className}.${memberName}`,
        signature,
        startLine: i + 1,
        endLine: i + 1,
        body: lines[i],
      });
      continue;
    }

    const endIdx = findDefinitionEnd(lines, braceStart);
    members.push({
      name: `${className}.${memberName}`,
      signature,
      startLine: i + 1,
      endLine: endIdx + 1,
      body: lines.slice(i, endIdx + 1).join("\n"),
    });
    i = endIdx;
    depth = 0;
  }

  return members;
}

export function parseFunctions(raw) {
  const lines = raw.split("\n");
  const codeLines = [];
  const results = [];
  const scanState = freshParseState();

  for (const line of lines) {
    codeLines.push(stripNonCode(line, scanState));
  }

  for (let i = 0; i < lines.length; i++) {
    if (!codeLines[i].trim()) continue;
    const snippet = normalizeSignatureSnippet(codeLines.slice(i, i + 6));
    const def = matchDefinition(snippet);
    if (!def) continue;
    if (JS_KEYWORD_SKIP.has(def.name)) continue;

    const startLine = i + 1;
    const signature = lines[i].trim();

    const braceStart = findOpeningBraceIndex(codeLines, i);
    if (braceStart === -1) {
      results.push({ name: def.name, signature, startLine, endLine: startLine, body: lines[i] });
      continue;
    }

    const endIdx = findDefinitionEnd(lines, braceStart);
    const endLine = endIdx + 1;
    const body = lines.slice(i, endIdx + 1).join("\n");
    results.push({ name: def.name, signature, startLine, endLine, body });

    if (def.kind === "class") {
      results.push(...extractClassMembers(lines, codeLines, braceStart, endIdx, def.name));
    }

    i = endIdx;
  }

  return results;
}

export function buildSmartPreload(raw, taskSpec) {
  const lines = raw.split("\n");
  if (lines.length < SMART_PRELOAD_THRESHOLD) return null;

  const functions = parseFunctions(raw);
  if (functions.length === 0) return null;

  const specLower = (taskSpec || "").toLowerCase();
  const specTokens = new Set((specLower.match(/[a-z0-9_]+/g) || []).filter(Boolean));

  const firstFuncLine = functions.length > 0 ? functions[0].startLine - 1 : lines.length;
  const importLines = lines.slice(0, Math.min(firstFuncLine, 30));
  const imports = importLines
    .map((ln, i) => `${String(i + 1).padStart(4)}\t${ln}`)
    .join("\n");

  const matched = [];
  const toc = [];

  for (const fn of functions) {
    const fnLower = fn.name.toLowerCase();
    const isMatch = fnLower.length > 2
      ? new RegExp(`\\b${fnLower.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(specLower)
      : specTokens.has(fnLower);

    if (isMatch) {
      const numbered = fn.body.split("\n")
        .map((ln, i) => `${String(fn.startLine + i).padStart(4)}\t${ln}`)
        .join("\n");
      matched.push({ name: fn.name, startLine: fn.startLine, endLine: fn.endLine, content: numbered });
    } else {
      toc.push({ name: fn.name, startLine: fn.startLine, endLine: fn.endLine, signature: fn.signature });
    }
  }

  return { imports, matched, toc, totalLines: lines.length };
}
