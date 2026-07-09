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

function normalizeSelectorChoices(choices) {
  return (Array.isArray(choices) ? choices : [])
    .map((choice) => {
      if (typeof choice === "string") return { value: choice, label: choice, aliases: [] };
      return {
        value: String(choice?.value ?? choice?.label ?? "").trim(),
        label: String(choice?.label ?? choice?.value ?? "").trim(),
        aliases: (Array.isArray(choice?.aliases) ? choice.aliases : [])
          .map((alias) => String(alias || "").trim().toLowerCase())
          .filter(Boolean),
      };
    })
    .filter((choice) => choice.value && choice.label);
}

function selectorAnswerValue(answer, choices, defaultValue) {
  const raw = String(answer || "").trim().toLowerCase();
  const fallback = choices.find((choice) => choice.value === defaultValue) || choices[0] || null;
  if (!raw) return fallback?.value || "";
  const match = choices.find((choice) => {
    const value = choice.value.toLowerCase();
    const label = choice.label.toLowerCase();
    return raw === value
      || raw === label
      || raw === value[0]
      || raw === label[0]
      || choice.aliases.includes(raw);
  });
  return match?.value || fallback?.value || "";
}

function selectorFallbackPrompt(question, choices, defaultValue) {
  const fallback = choices.find((choice) => choice.value === defaultValue) || choices[0] || null;
  const labels = choices.map((choice) => choice.label).join(" / ");
  const defaultLabel = fallback ? ` [${fallback.label.toLowerCase()}]` : "";
  return `${String(question || "").trimEnd()} ${labels}${defaultLabel}: `;
}

export function askSelectorChoice(question, choices = [], {
  defaultValue = null,
  input = process.stdin,
  output = process.stdout,
  colors = C,
  fallbackAsk = null,
  pauseOnSettle = input === process.stdin,
} = {}) {
  const normalized = normalizeSelectorChoices(choices);
  if (normalized.length === 0) return Promise.resolve("");
  const initialValue = defaultValue || normalized[0].value;
  const defaultIndex = Math.max(0, normalized.findIndex((choice) => choice.value === initialValue));
  const fallbackPrompt = selectorFallbackPrompt(question, normalized, normalized[defaultIndex].value);

  if (!input?.isTTY || !output?.isTTY || typeof input.setRawMode !== "function") {
    const askFallback = typeof fallbackAsk === "function"
      ? fallbackAsk
      : (prompt) => ask(prompt, { input, output });
    return Promise.resolve(askFallback(fallbackPrompt))
      .then((answer) => selectorAnswerValue(answer, normalized, normalized[defaultIndex].value));
  }

  return new Promise((resolve) => {
    let selectedIndex = defaultIndex;
    let renderedRows = 0;
    let settled = false;
    const wasRaw = Boolean(input.isRaw);
    const wasPaused = typeof input.isPaused === "function" ? input.isPaused() : false;

    const clearRendered = () => {
      if (renderedRows <= 0) return;
      output.write(`\x1b[${renderedRows}A\r\x1b[J`);
      renderedRows = 0;
    };

    const render = () => {
      clearRendered();
      const lines = [String(question || "").trimEnd()];
      normalized.forEach((choice, index) => {
        const selected = index === selectedIndex;
        const marker = selected ? `${colors.cyan}${colors.bold}>${colors.reset}` : " ";
        const label = selected ? `${colors.cyan}${colors.bold}${choice.label}${colors.reset}` : choice.label;
        const defaultTag = index === defaultIndex ? ` ${colors.dim}(default)${colors.reset}` : "";
        lines.push(`    ${marker} ${label}${defaultTag}`);
      });
      lines.push(`    ${colors.dim}Use Up/Down, Enter${colors.reset}`);
      output.write(`${lines.join("\n")}\n`);
      renderedRows = lines.length;
    };

    const cleanup = () => {
      try { input.off("data", onData); } catch { /* best effort */ }
      try { input.setRawMode(wasRaw); } catch { /* best effort */ }
      if (wasPaused || pauseOnSettle) {
        try { input.pause(); } catch { /* best effort */ }
      }
    };

    const settle = (index = selectedIndex) => {
      if (settled) return;
      settled = true;
      const choice = normalized[index] || normalized[defaultIndex];
      clearRendered();
      output.write(`${String(question || "").trimEnd()} ${choice.label}\n`);
      cleanup();
      resolve(choice.value);
    };

    const move = (delta) => {
      selectedIndex = (selectedIndex + delta + normalized.length) % normalized.length;
      render();
    };

    const onData = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      if (!text) return;
      if (text.includes("\u0003")) return settle(defaultIndex);
      if (text.includes("\r") || text.includes("\n")) return settle();
      if (text.includes("\u001b[A") || text.includes("\u001b[D")) return move(-1);
      if (text.includes("\u001b[B") || text.includes("\u001b[C")) return move(1);
      if (text.includes("\u001b")) return settle(defaultIndex);
    };

    try { input.setRawMode(true); } catch { return settle(defaultIndex); }
    input.on("data", onData);
    try { input.resume(); } catch { /* best effort */ }
    render();
  });
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
