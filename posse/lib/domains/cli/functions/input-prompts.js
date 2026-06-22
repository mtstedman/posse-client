import fs from "fs";
import readline from "readline";
import { C } from "../../../shared/format/functions/colors.js";

// Cached once so multiple prompts consume piped stdin in order.
let nonTtyInputLines = null;

function cachedProcessInputLines() {
  if (nonTtyInputLines == null) {
    let raw = "";
    try { raw = fs.readFileSync(0, "utf8"); } catch { raw = ""; }
    nonTtyInputLines = raw.split(/\r?\n/);
  }
  return nonTtyInputLines;
}

function formatAnswer(value, trim) {
  const text = String(value || "");
  return trim ? text.trim() : text;
}

function writeLine(output, text = "") {
  output.write(`${text}\n`);
}

function defaultCompletionHint(terminator, colors = C) {
  if (terminator === "dot") {
    return `${colors.dim}(finish with a single "." on its own line)${colors.reset}`;
  }
  return `  ${colors.dim}(enter a blank line when done)${colors.reset}`;
}

function lineEndsInput(line, terminator, lineCount) {
  if (terminator === "dot") return line.trim() === ".";
  return line.trim() === "" && lineCount > 0;
}

export function ask(question, {
  trim = true,
  input = process.stdin,
  output = process.stdout,
  terminal = true,
  primeRawMode = true,
} = {}) {
  if (input === process.stdin && !process.stdin.isTTY) {
    output.write(question);
    const lines = cachedProcessInputLines();
    return Promise.resolve(formatAnswer(lines.shift() || "", trim));
  }

  return new Promise((resolve) => {
    if (primeRawMode) {
      try { input.setRawMode?.(false); } catch { /* not in raw mode */ }
      try { input.resume?.(); } catch { /* best effort */ }
    }
    setImmediate(() => {
      const rl = readline.createInterface({ input, output, terminal });
      let resolved = false;
      rl.question(question, (answer) => {
        resolved = true;
        rl.close();
        resolve(formatAnswer(answer, trim));
      });
      rl.on("close", () => {
        if (!resolved) resolve("");
      });
    });
  });
}

export function askMultiline(prompt, {
  terminator = "blank",
  trim = false,
  trimPipedInput = true,
  input = process.stdin,
  output = process.stdout,
  colors = C,
  completionHint = defaultCompletionHint(terminator, colors),
} = {}) {
  if (input === process.stdin && !process.stdin.isTTY) {
    writeLine(output, prompt);
    const lines = cachedProcessInputLines();
    const consumed = [];
    while (lines.length > 0) {
      const line = lines.shift();
      if (lineEndsInput(line, terminator, consumed.length)) break;
      consumed.push(line);
    }
    return Promise.resolve(formatAnswer(consumed.join("\n"), trimPipedInput));
  }

  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output });
    writeLine(output, prompt);
    if (completionHint) writeLine(output, completionHint);
    const lines = [];
    let resolved = false;
    rl.on("line", (line) => {
      if (lineEndsInput(line, terminator, lines.length)) {
        resolved = true;
        rl.close();
        resolve(formatAnswer(lines.join("\n"), trim));
        return;
      }
      lines.push(line);
    });
    rl.on("close", () => {
      if (!resolved) resolve(formatAnswer(lines.join("\n"), trim));
    });
  });
}

export function askDotTerminatedMultiline(prompt, options = {}) {
  const { trim = true, trimPipedInput = true, ...rest } = options;
  return askMultiline(prompt, {
    ...rest,
    terminator: "dot",
    trim,
    trimPipedInput,
  });
}
