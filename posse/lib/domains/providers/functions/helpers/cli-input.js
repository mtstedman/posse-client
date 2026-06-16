// Interactive CLI input helpers shared by the OpenAI-compatible providers
// (openai, grok). Readline-backed prompts with an EOF / non-interactive
// fallback. Claude and Codex use a different terminator convention (blank
// line vs ".") and keep their own copies.

import readline from "readline";
import { C } from "../../../../shared/format/functions/colors.js";

export function ask(question) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let resolved = false;
    rl.question(question, (answer) => {
      resolved = true;
      rl.close();
      resolve(answer);
    });
    rl.on("close", () => {
      if (!resolved) resolve("");
    });
  });
}

export function askMultiline(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });

    const lines = [];
    let resolved = false;
    console.log(prompt);
    console.log(`${C.dim}(finish with a single "." on its own line)${C.reset}`);

    rl.on("line", (line) => {
      if (line.trim() === ".") {
        resolved = true;
        rl.close();
        resolve(lines.join("\n").trim());
        return;
      }
      lines.push(line);
    });
    rl.on("close", () => {
      if (!resolved) resolve(lines.join("\n").trim());
    });
  });
}
