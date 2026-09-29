import readline from "node:readline";

// Countersigns use the Remote's pairing alphabet (rust/catalog/pairing.rs
// PAIRING_CODE_SYMBOLS): no 0/O, 1/I/L.
const COUNTERSIGN_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/u;

export const HOST_CONSOLE_HELP = [
  "<CODE>        admit a member: type the 4-character countersign they read to you, then Enter",
  "status        session code, shared branch, and who is connected",
  "members       list members and their states",
  "kick <id>     remove a member (id prefix from `members`)",
  "close         graceful close + integrate",
  "Ctrl+C        force close + integrate",
];

/**
 * Parse one line typed into the host console. Commands are words; anything
 * shaped like a countersign admits. Single keys never act on their own, so a
 * countersign containing G cannot close the session.
 */
export function parseHostConsoleLine(line) {
  const text = String(line ?? "").trim();
  if (!text) return { kind: "empty" };
  const [word, ...rest] = text.split(/\s+/u);
  const command = word.toLowerCase();
  if (["status", "s"].includes(command)) return { kind: "status" };
  if (["members", "m", "who"].includes(command)) return { kind: "members" };
  if (["help", "h", "?"].includes(command)) return { kind: "help" };
  if (command === "close") return { kind: "close" };
  if (command === "kick") {
    return rest[0] ? { kind: "kick", id: rest[0] } : { kind: "invalid", message: "Usage: kick <member id>" };
  }
  if (rest.length === 0 && COUNTERSIGN_PATTERN.test(word.toUpperCase())) {
    return { kind: "admit", code: word.toUpperCase() };
  }
  return { kind: "invalid", message: `Unknown command "${text}". Type help for commands.` };
}

/**
 * Compare the Remote's member list with the last one seen and return what
 * changed: a new pending request, an admission, or a departure. `seen` maps
 * member id -> state and is updated in place. Members first seen already gone
 * (left/kicked) are history, not events.
 */
export function diffPairingMembers(members, seen) {
  const events = [];
  const current = new Map();
  for (const member of Array.isArray(members) ? members : []) {
    if (!member?.id) continue;
    const state = String(member.state || "unknown");
    current.set(member.id, state);
    const before = seen.get(member.id);
    if (before === state) continue;
    if (state === "pending") events.push({ kind: "pending", member });
    else if (state === "admitted") events.push({ kind: "joined", member });
    else if (before !== undefined) events.push({ kind: "left", member });
  }
  for (const [id, state] of seen) {
    if (!current.has(id) && ["pending", "admitted"].includes(state)) {
      events.push({ kind: "left", member: { id, state: "left" } });
    }
  }
  seen.clear();
  for (const [id, state] of current) seen.set(id, state);
  return events;
}

export function shortId(value) {
  return String(value || "").slice(0, 8) || "(unknown)";
}

/**
 * A prompt that stays on the last line while feed output prints above it.
 * Without a TTY it degrades to plain logging and takes no input.
 */
export function createHostConsole({
  input = process.stdin,
  output = process.stdout,
  prompt = "  posse> ",
  onLine = () => {},
  onInterrupt = () => {},
} = {}) {
  if (!input?.isTTY) {
    return {
      interactive: false,
      print: (text = "") => console.log(text),
      close: () => {},
    };
  }
  const rl = readline.createInterface({ input, output, prompt, terminal: true });
  let closed = false;
  rl.on("line", (line) => {
    try {
      onLine(line);
    } finally {
      if (!closed) rl.prompt();
    }
  });
  rl.on("SIGINT", () => onInterrupt());
  rl.prompt();
  return {
    interactive: true,
    print(text = "") {
      if (closed) {
        console.log(text);
        return;
      }
      // Clear the prompt line, print above it, then redraw what was typed.
      readline.clearLine(output, 0);
      readline.cursorTo(output, 0);
      output.write(`${text}\n`);
      rl.prompt(true);
    },
    close() {
      if (closed) return;
      closed = true;
      rl.close();
    },
  };
}
