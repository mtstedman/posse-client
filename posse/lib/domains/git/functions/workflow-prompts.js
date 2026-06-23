// lib/domains/git/functions/workflow-prompts.js
// Terminal prompt helpers used by git workflows.

export async function askSingleKeyYesNo(prompt, {
  stdin = process.stdin,
  stdout = process.stdout,
  fallbackAsk = null,
} = {}) {
  if (!stdin?.isTTY) {
    if (typeof fallbackAsk === "function") return fallbackAsk(prompt);
    stdout.write(prompt);
    return "";
  }

  return new Promise((resolve) => {
    let settled = false;
    const wasRaw = Boolean(stdin.isRaw);
    const wasPaused = typeof stdin.isPaused === "function" ? stdin.isPaused() : false;

    const cleanup = () => {
      try { stdin.off("data", onData); } catch { /* best effort */ }
      try { stdin.setRawMode(wasRaw); } catch { /* best effort */ }
      if (wasPaused) {
        try { stdin.pause(); } catch { /* best effort */ }
      }
    };

    const settle = (answer) => {
      if (settled) return;
      settled = true;
      cleanup();
      stdout.write(`${answer || ""}\n`);
      resolve(answer);
    };

    const onData = (chunk) => {
      const text = Buffer.isBuffer(chunk) ? chunk.toString("utf8") : String(chunk || "");
      if (!text) return;
      const key = text[0].toLowerCase();
      if (key === "y") return settle("y");
      if (key === "n" || key === "\r" || key === "\n" || key === "\u001b" || key === "\u0003") return settle("");
    };

    stdout.write(prompt);
    try { stdin.setRawMode(true); } catch { /* best effort */ }
    stdin.on("data", onData);
    try { stdin.resume(); } catch { /* best effort */ }
  });
}
