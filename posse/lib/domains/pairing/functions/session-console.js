import readline from "node:readline";

import { SESSION_PANEL_MODES } from "../../../catalog/session-roster.js";
import { SESSION_COMPUTE_LEASE_DEFAULT, SESSION_COMPUTE_OWNER_VALUES } from "../../../catalog/session-sync.js";
import { createSessionPanel } from "./session-panel.js";

// Countersigns use the Remote's pairing alphabet (rust/catalog/pairing.rs
// PAIRING_CODE_SYMBOLS): no 0/O, 1/I/L. Every command word below contains a
// symbol outside that alphabet or is not four characters long, so a typed
// countersign can never be read as a command (or the reverse).
const COUNTERSIGN_PATTERN = /^[ABCDEFGHJKMNPQRSTUVWXYZ23456789]{4}$/u;

const HOST_ONLY_COMMANDS = new Set(["members", "m", "close", "kick", "lease", "merge", "deploy", "auto"]);
// Disconnect words. None is four pairing-alphabet symbols (I, L are absent).
const LEAVE_COMMANDS = new Set(["leave", "quit", "exit", "disconnect"]);
// For the host these close the session, as `close` does.
const HOST_QUIT_COMMANDS = new Set(["quit", "exit"]);

const WORK_HELP = Object.freeze([
  "add [task]    queue a task here (the same questions as `posse add`)",
  "go            open the session screen here and run your queue (`posse go`); it stays open until Ctrl+C, which comes back to this console",
  "go window     Windows only: run it in a new PowerShell window instead and keep this console (`go here` is the default now)",
]);

const SHARED_HELP = Object.freeze([
  "status        the session screen: who is here, what they run, what needs you",
  "who           the roster: everyone's role, run state, work counts and compute lease (also: panel)",
  "hold [reason] keep this checkout where it is (fetches continue) until resume",
  "resume        lift the hold; this checkout catches up now",
]);

const HOST_HELP = Object.freeze([
  "<CODE>        admit a member (same as <CODE> member): type the 4-character countersign they read to you, then Enter",
  "<CODE> host   admit them and run their work on your computer and provider account",
  "<CODE> member admit them and let them run and pay for their own work",
  ...WORK_HELP,
  ...SHARED_HELP,
  "members       list members with their full states and ids",
  "kick <id>     remove a member (id prefix from `members`)",
  "lease <id> host|member|default   change whose computer runs a member's work",
  "merge         squash the team's work into your branch; the session keeps running",
  "deploy        push your branch to origin (merging first); the session keeps running",
  "auto merge|deploy on|off   trusted teams: run it as work lands, without asking",
  "close         end the session for everyone; you approve its work before it is published (also: quit)",
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
      ? "Ctrl+C        close now without waiting for members' running jobs; you are asked before its work is published"
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
  if (command === "admit" && rest[0]?.toLowerCase() !== "admit") {
    const admission = parseSessionConsoleLine(rest.join(" "), { role });
    return admission.kind === "admit"
      ? admission
      : { kind: "invalid", message: "Usage: admit <CODE> [host|member] (host only)" };
  }
  if (["status", "s"].includes(command)) return { kind: "status" };
  if (["who", "panel"].includes(command) && rest.length === 0) return { kind: "panel" };
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
  // The session screen opens in this terminal on every platform; `here` is
  // kept as a word for that default.
  if (command === "go" && rest.length === 0) return { kind: "go" };
  if (command === "go" && rest.length === 1 && ["here", "inline"].includes(rest[0].toLowerCase())) return { kind: "go", here: true };
  if (command === "go" && rest.length === 1 && rest[0].toLowerCase() === "window") return { kind: "go", window: true };
  if (LEAVE_COMMANDS.has(command) && rest.length === 0) {
    if (!host) return { kind: "leave" };
    // Quitting the console is how a host ends the session: the same close
    // that asks before the session's work is published.
    if (HOST_QUIT_COMMANDS.has(command)) return { kind: "close" };
    return { kind: "invalid", message: "You are hosting: type close (or quit) to end the session for everyone; you approve its work before it is published." };
  }
  // A countersign may carry the lease the host issues with the admission.
  const admitLease = rest.length === 1 && SESSION_COMPUTE_OWNER_VALUES.includes(rest[0].toLowerCase())
    ? rest[0].toLowerCase()
    : null;
  const countersign = COUNTERSIGN_PATTERN.test(word.toUpperCase()) && (rest.length === 0 || admitLease);
  if (!host && (HOST_ONLY_COMMANDS.has(command) || countersign)) {
    return { kind: "invalid", message: "Only the session host can admit, list or remove members, change their lease, merge, deploy or close the session." };
  }
  if (["members", "m"].includes(command)) return { kind: "members" };
  if (command === "close") return { kind: "close" };
  if ((command === "merge" || command === "deploy") && rest.length === 0) return { kind: command };
  if (command === "auto") {
    if (rest.length === 0) return { kind: "auto" };
    const [which, value] = rest.map((word) => word.toLowerCase());
    return rest.length === 2 && ["merge", "deploy"].includes(which) && ["on", "off"].includes(value)
      ? { kind: "auto", which, value }
      : { kind: "invalid", message: "Usage: auto <merge|deploy> <on|off>" };
  }
  if (command === "kick") {
    return rest[0] ? { kind: "kick", id: rest[0] } : { kind: "invalid", message: "Usage: kick <member id>" };
  }
  if (command === "lease") {
    const owner = String(rest[1] || "").toLowerCase();
    if (rest.length !== 2 || !(SESSION_COMPUTE_OWNER_VALUES.includes(owner) || owner === SESSION_COMPUTE_LEASE_DEFAULT)) {
      return { kind: "invalid", message: "Usage: lease <member id> host|member|default" };
    }
    return { kind: "lease", id: rest[0], computeOwner: owner === SESSION_COMPUTE_LEASE_DEFAULT ? null : owner };
  }
  if (countersign) {
    return admitLease
      ? { kind: "admit", code: word.toUpperCase(), computeOwner: admitLease }
      : { kind: "admit", code: word.toUpperCase() };
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
 * Without a TTY it degrades to plain logging and takes no input. With a
 * `panelMode` it also carries the roster panel (see session-panel.js):
 * printed into the feed when it changes, or pinned under the prompt on request.
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
  panelMode = SESSION_PANEL_MODES.OFF,
  panelStyle = (line) => line,
} = {}) {
  if (!input?.isTTY) {
    const print = (text = "") => console.log(text);
    // Never pinned without a terminal to read from.
    const panel = createSessionPanel({
      output,
      mode: panelMode === SESSION_PANEL_MODES.OFF ? SESSION_PANEL_MODES.OFF : SESSION_PANEL_MODES.BLOCK,
      print,
      style: panelStyle,
    });
    return {
      interactive: false,
      panelMode: panel.mode,
      print,
      setPanel: (view) => panel.update(view),
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
  const redrawPrompt = () => {
    if (closed || suspended) return;
    try {
      rl.prompt(true);
    } catch (error) {
      if (!terminalGone(error)) throw error;
      hangup();
    }
  };
  // Created before readline so its resize handling runs first, and so
  // readline writes through the panel's output (see session-panel.js).
  const panel = createSessionPanel({
    output,
    mode: panelMode,
    print: (text) => api.print(text),
    style: panelStyle,
    onRepaint: redrawPrompt,
  });
  const rl = readline.createInterface({ input, output: panel.output, prompt, terminal: true });
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
  // Ctrl+Z: the shell must get the whole terminal back, not the scroll
  // region. readline leaves the suspend to a listener when one exists.
  if (panel.mode === SESSION_PANEL_MODES.PINNED && process.platform !== "win32") {
    rl.on("SIGTSTP", () => {
      panel.release();
      input.setRawMode?.(false);
      process.once("SIGCONT", () => {
        if (closed) return;
        input.setRawMode?.(true);
        // The stream must be paused and resumed to read keys again.
        rl.pause();
        rl.resume();
        panel.restore();
        redrawPrompt();
      });
      process.kill(process.pid, "SIGTSTP");
    });
  }
  rl.prompt();
  const api = {
    interactive: true,
    panelMode: panel.mode,
    /** Show the roster; see createSessionPanel().update. */
    setPanel(view) {
      if (!closed) panel.update(view);
    },
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
      panel.release();
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
      panel.restore();
      return lines;
    },
    close() {
      closed = true;
      panel.close();
      if (rlClosed) return;
      try {
        rl.close();
      } catch (error) {
        if (!terminalGone(error)) throw error;
      }
    },
  };
  return api;
}
