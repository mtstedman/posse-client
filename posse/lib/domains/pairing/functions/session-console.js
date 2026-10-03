import readline from "node:readline";

// Countersigns use the Remote's pairing alphabet (rust/catalog/pairing.rs
// PAIRING_CODE_SYMBOLS): no 0/O, 1/I/L. Every command word below contains a
// symbol outside that alphabet or is not four characters long, so a typed
// countersign can never be read as a command (or the reverse).
const COUNTERSIGN_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/u;

const HOST_ONLY_COMMANDS = new Set(["members", "m", "who", "close", "kick"]);
// Disconnect words. None is four pairing-alphabet symbols (I, L are absent).
const LEAVE_COMMANDS = new Set(["leave", "quit", "exit", "disconnect"]);

const WORK_HELP = Object.freeze([
  "add [task]    queue a task here (the same questions as `posse add`)",
  "go            run your queue here (`posse go`); you come back to this screen after",
]);

const SHARED_HELP = Object.freeze([
  "status        the session screen: who is here, what they run, what needs you",
  "hold [reason] keep this checkout where it is (fetches continue) until resume",
  "resume        lift the hold; this checkout catches up now",
]);

const HOST_HELP = Object.freeze([
  "<CODE>        admit a member: type the 4-character countersign they read to you, then Enter",
  ...WORK_HELP,
  ...SHARED_HELP,
  "members       list members and their states",
  "kick <id>     remove a member (id prefix from `members`)",
  "close         end the session for everyone; you approve its work before it is published",
]);

const MEMBER_HELP = Object.freeze([
  ...WORK_HELP,
  ...SHARED_HELP,
  "leave         disconnect from the session (this folder keeps its work)",
]);

/**
 * Help lines for the session console. While posse go owns the session the
 * console only observes, so Ctrl+C detaches instead of closing or leaving.
 */
export function sessionConsoleHelp(role, { observing = false } = {}) {
  const lines = [...(role === "host" ? HOST_HELP : MEMBER_HELP)];
  if (observing) {
    lines.push("Ctrl+C        detach this console; posse go keeps the session");
  } else {
    lines.push(role === "host"
      ? "Ctrl+C        force close (its work waits for your approval)"
      : "Ctrl+C        leave the session and switch back");
  }
  return lines;
}

/**
 * Parse one line typed into the session console. Commands are words; for the
 * host, anything shaped like a countersign admits. Single keys never act on
 * their own, so a countersign containing G cannot close the session.
 */
export function parseSessionConsoleLine(line, { role = "host" } = {}) {
  const text = String(line ?? "").trim();
  if (!text) return { kind: "empty" };
  const [word, ...rest] = text.split(/\s+/u);
  const command = word.toLowerCase();
  const host = role === "host";
  if (["status", "s"].includes(command)) return { kind: "status" };
  if (["help", "h", "?"].includes(command)) return { kind: "help" };
  if (command === "hold") {
    const reason = text.slice(word.length).trim();
    return reason ? { kind: "hold", reason } : { kind: "hold" };
  }
  if (command === "resume") return { kind: "resume" };
  if (command === "add") {
    const task = text.slice(word.length).trim();
    return task ? { kind: "add", task } : { kind: "add" };
  }
  if (command === "go" && rest.length === 0) return { kind: "go" };
  if (LEAVE_COMMANDS.has(command) && rest.length === 0) {
    return host
      ? { kind: "invalid", message: "You are hosting: type close to end the session for everyone (you approve its work before it is published), or Ctrl+C to force it." }
      : { kind: "leave" };
  }
  if (!host && (HOST_ONLY_COMMANDS.has(command) || (rest.length === 0 && COUNTERSIGN_PATTERN.test(word.toUpperCase())))) {
    return { kind: "invalid", message: "Only the session host can admit, list, remove members or close the session." };
  }
  if (["members", "m", "who"].includes(command)) return { kind: "members" };
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

// Instance ids read "posse-<uuid>": the prefix carries no information, so the
// display keeps the first eight characters of the part that differs.
export function shortInstanceId(value) {
  return shortId(String(value || "").replace(/^posse-/u, ""));
}

/** How the console and the run screen name a session member. */
export function sessionMemberLabel(member) {
  return `member ${shortId(member?.id)}${member?.instance_id ? ` (machine ${shortInstanceId(member.instance_id)})` : ""}`;
}

/** What a member's session scope lets them change, in one line. */
export function describeSessionWriteScope(scopeSet) {
  const write = scopeSet && typeof scopeSet === "object" ? scopeSet.write : null;
  const files = Array.isArray(write?.files) ? write.files : [];
  const roots = Array.isArray(write?.roots) ? write.roots : [];
  if (roots.includes("*")) return "any file";
  const paths = [...roots.map((root) => `${String(root).replace(/\/$/u, "")}/`), ...files];
  if (paths.length === 0) return "nothing yet (the host grants access with `posse session scope`)";
  const shown = paths.slice(0, 4).join(", ");
  return paths.length > 4 ? `${shown} and ${paths.length - 4} more` : shown;
}

/**
 * A prompt that stays on the last line while feed output prints above it.
 * Without a TTY it degrades to plain logging and takes no input.
 */
// A closed terminal window makes every read, write and mode change on it fail
// with one of these; none of them may crash the session's shutdown.
const TERMINAL_GONE_CODES = new Set(["EIO", "ENXIO", "EBADF", "EPIPE", "ENOTTY"]);

function terminalGone(error) {
  return TERMINAL_GONE_CODES.has(String(error?.code || ""));
}

export function createSessionConsole({
  input = process.stdin,
  output = process.stdout,
  prompt = "  posse> ",
  onLine = () => {},
  onInterrupt = () => {},
  // The terminal went away (window closed, or end of input): the caller
  // treats it like SIGHUP.
  onHangup = () => {},
} = {}) {
  if (!input?.isTTY) {
    return {
      interactive: false,
      print: (text = "") => console.log(text),
      setPrompt: () => {},
      suspend: () => {},
      resume: () => {},
      close: () => {},
    };
  }
  // readline restores cooked mode when it closes, including when a vanished
  // terminal ends the input stream; on a dead TTY that throws EIO from inside
  // readline and would kill the process before the hangup close runs.
  if (typeof input.setRawMode === "function") {
    const setRawMode = input.setRawMode.bind(input);
    input.setRawMode = (mode) => {
      try {
        return setRawMode(mode);
      } catch (error) {
        if (terminalGone(error)) return input;
        throw error;
      }
    };
  }
  let closed = false;
  let hungUp = false;
  // While another command owns the terminal (`add`, `go`), feed lines wait.
  let suspended = false;
  let held = [];
  const HELD_LINES_MAX = 200;
  const hangup = () => {
    if (hungUp) return;
    hungUp = true;
    closed = true;
    onHangup();
  };
  input.on?.("error", (error) => {
    if (terminalGone(error)) hangup();
  });
  output.on?.("error", () => { /* writes to a closed terminal are dropped */ });
  const rl = readline.createInterface({ input, output, prompt, terminal: true });
  let rlClosed = false;
  // The input ended without close() being asked for: the terminal is gone
  // (or the operator sent end-of-input).
  rl.on("close", () => {
    rlClosed = true;
    if (!closed) hangup();
  });
  const write = (text) => {
    try {
      // Clear the prompt line, print above it, then redraw what was typed.
      readline.clearLine(output, 0);
      readline.cursorTo(output, 0);
      output.write(`${text}\n`);
      rl.prompt(true);
    } catch (error) {
      if (!terminalGone(error)) throw error;
      hangup();
    }
  };
  rl.on("line", (line) => {
    try {
      onLine(line);
    } finally {
      if (!closed && !suspended) rl.prompt();
    }
  });
  rl.on("SIGINT", () => onInterrupt());
  rl.prompt();
  return {
    interactive: true,
    print(text = "") {
      if (closed) {
        if (!hungUp) console.log(text);
        return;
      }
      if (suspended) {
        if (held.length < HELD_LINES_MAX) held.push(String(text));
        return;
      }
      write(text);
    },
    /** Show live session state in the prompt itself. */
    setPrompt(text) {
      const next = String(text || prompt);
      if (closed || rl.getPrompt() === next) return;
      rl.setPrompt(next);
      if (suspended) return;
      try {
        rl.prompt(true);
      } catch (error) {
        if (!terminalGone(error)) throw error;
        hangup();
      }
    },
    /**
     * Hand the terminal to another command: stop reading, leave raw mode (the
     * command starts in the terminal's normal mode) and hold feed lines.
     */
    suspend() {
      if (closed || suspended) return;
      suspended = true;
      rl.pause();
      try {
        readline.clearLine(output, 0);
        readline.cursorTo(output, 0);
      } catch { /* a vanished terminal is handled by its error events */ }
      input.setRawMode?.(false);
    },
    /** Take the terminal back; returns the feed lines held meanwhile. */
    resume() {
      if (closed || !suspended) return [];
      suspended = false;
      input.setRawMode?.(true);
      rl.resume();
      const lines = held;
      held = [];
      rl.prompt();
      return lines;
    },
    close() {
      closed = true;
      if (rlClosed) return;
      try {
        rl.close();
      } catch (error) {
        if (!terminalGone(error)) throw error;
      }
    },
  };
}
