// The session console's roster panel. By default it is a block printed into
// the feed when membership or leases change (the run screen's Session mode is
// the live view). Setting POSSE_SESSION_PANEL=pinned opts in to a few lines
// that stay on screen under the prompt while the feed scrolls above them:
//
// Pinning uses the terminal's scroll region (DECSTBM): the region is every row
// but the last few, so the feed and the prompt scroll inside it, lines that
// scroll off its top still reach the terminal's scrollback, and the rows below
// it never move. The panel sits under the prompt rather than above the feed
// because a region that does not start at the first row discards what scrolls
// off it in most terminals, and the feed's history matters more than where
// the panel hangs.
//
// readline redraws its prompt with "erase from the cursor to the end of the
// screen", which ignores the region and would wipe the panel. readline is
// therefore given an output whose writes repaint the panel right after each
// such erase, in the same write.
//
// Pinning is never used without a TTY on both ends, under TERM=dumb, or in a
// window too small to give rows away; those get the block.

import {
  SESSION_PANEL_ENV,
  SESSION_PANEL_LAYOUT,
  SESSION_PANEL_MODES,
  SESSION_PANEL_MODE_VALUES,
} from "../../../catalog/session-roster.js";

const ESC = "\x1b";
const SAVE_CURSOR = `${ESC}7`;
const RESTORE_CURSOR = `${ESC}8`;
const RESET_REGION = `${ESC}[r`;
const ERASE_LINE = `${ESC}[2K`;
// Exactly what readline.clearScreenDown writes.
const ERASE_BELOW = `${ESC}[0J`;

const { PINNED, BLOCK, OFF } = SESSION_PANEL_MODES;

/** Whether a window of this size can give rows to a pinned panel. */
export function sessionPanelFits({ rows, columns } = {}) {
  return Number.isSafeInteger(rows) && Number.isSafeInteger(columns)
    && rows >= SESSION_PANEL_LAYOUT.MIN_ROWS && columns >= SESSION_PANEL_LAYOUT.MIN_COLUMNS;
}

/** Participant rows a window of `rows` rows can show, under the two header lines. */
export function sessionPanelMaxRows(rows) {
  const share = Math.floor((Number(rows) || 0) * SESSION_PANEL_LAYOUT.MAX_WINDOW_SHARE) - 2;
  return Math.max(1, Math.min(SESSION_PANEL_LAYOUT.MAX_PARTICIPANT_ROWS, share));
}

/**
 * How this terminal shows the panel: the feed block, unless the operator
 * asked for the pinned panel and the terminal can carry one.
 */
export function sessionPanelMode({
  input = process.stdin,
  output = process.stdout,
  env = process.env,
  platform = process.platform,
} = {}) {
  const forced = String(env?.[SESSION_PANEL_ENV] || "").trim().toLowerCase();
  if (forced === OFF) return OFF;
  if (forced !== PINNED || !input?.isTTY || !output?.isTTY) return BLOCK;
  const term = String(env?.TERM || "").toLowerCase();
  if (term === "dumb" || (!term && platform !== "win32")) return BLOCK;
  return PINNED;
}

function sameLines(a, b) {
  return a.length === b.length && a.every((line, index) => line === b[index]);
}

/**
 * @param {object} options
 * @param {object} options.output The terminal stream.
 * @param {string} options.mode One of SESSION_PANEL_MODES.
 * @param {(line: string) => void} options.print Prints a feed line (block mode).
 * @param {(line: string, index: number) => string} [options.style] Colors a line.
 * @param {() => void} [options.onRepaint] Redraw the prompt: the panel moved
 *   the cursor's column while taking or giving back rows.
 */
export function createSessionPanel({
  output,
  mode = BLOCK,
  print = () => {},
  style = (line) => line,
  onRepaint = () => {},
  processRef = process,
} = {}) {
  const requested = SESSION_PANEL_MODE_VALUES.includes(mode) ? mode : BLOCK;
  let installed = false;
  let height = 0;
  let geometry = { rows: 0, columns: 0 };
  let drawn = [];
  // The latest roster: how to render it at a size, and its change key.
  let current = null;
  let lastBlockKey = null;
  let released = false;
  let closed = false;

  const write = (text) => {
    try {
      output.write(text);
      return true;
    } catch {
      // A vanished terminal: the console's own handlers end the session.
      installed = false;
      return false;
    }
  };
  const paintSequence = () => {
    const top = geometry.rows - height + 1;
    return SAVE_CURSOR
      + drawn.map((line, index) => `${ESC}[${top + index};1H${ERASE_LINE}${style(line, index)}`).join("")
      + RESTORE_CURSOR;
  };
  const restoreTerminal = () => {
    if (!installed) return;
    installed = false;
    const top = geometry.rows - height + 1;
    let erase = "";
    for (let row = top; row <= geometry.rows; row += 1) erase += `${ESC}[${row};1H${ERASE_LINE}`;
    write(SAVE_CURSOR + RESET_REGION + erase + RESTORE_CURSOR);
  };
  // A process that ends with the region set leaves the shell confined to it.
  const onExit = () => restoreTerminal();
  const uninstall = () => {
    if (!installed) return;
    restoreTerminal();
    processRef.removeListener?.("exit", onExit);
  };
  const install = (lines) => {
    const { rows } = geometry;
    height = lines.length;
    drawn = lines;
    // Make room under the cursor's line (scrolling the screen if the cursor is
    // near the bottom), fence those rows off, and go back to that line.
    const ok = write(`${"\n".repeat(height)}${SAVE_CURSOR}${ESC}[1;${rows - height}r${RESTORE_CURSOR}${ESC}[${height}A`);
    if (!ok) return;
    installed = true;
    processRef.once?.("exit", onExit);
    write(paintSequence());
    onRepaint();
  };
  const blockUpdate = () => {
    if (!current || current.key === lastBlockKey) return;
    const first = lastBlockKey === null;
    lastBlockKey = current.key;
    // The session screen already listed everyone when the console opened.
    if (first) return;
    for (const [index, line] of current.render({ columns: output?.columns || 100, maxRows: 100 }).entries()) {
      print(style(line, index));
    }
  };
  const refresh = () => {
    if (!current || released || closed || requested === OFF) return;
    if (requested !== PINNED) {
      blockUpdate();
      return;
    }
    const rows = output.rows;
    const columns = output.columns;
    if (!sessionPanelFits({ rows, columns })) {
      const wasInstalled = installed;
      uninstall();
      if (wasInstalled) onRepaint();
      blockUpdate();
      return;
    }
    // While pinned nothing is printed; the block baseline still follows, so a
    // later fallback prints only real changes.
    lastBlockKey = current.key;
    const maxRows = sessionPanelMaxRows(rows);
    // One column short of the edge: a full-width line would wrap in some terminals.
    const lines = current.render({ columns: columns - 1, maxRows }).slice(0, maxRows + 2);
    if (installed && lines.length === height && rows === geometry.rows && columns === geometry.columns) {
      if (sameLines(lines, drawn)) return;
      drawn = lines;
      write(paintSequence());
      return;
    }
    uninstall();
    geometry = { rows, columns };
    install(lines);
  };
  const onResize = () => {
    if (closed || released || requested !== PINNED) return;
    if (installed) {
      // The old geometry is void: drop the region and whatever the terminal
      // left of the old panel under the prompt, then take rows again.
      installed = false;
      processRef.removeListener?.("exit", onExit);
      write(SAVE_CURSOR + RESET_REGION + RESTORE_CURSOR + ERASE_BELOW);
    }
    refresh();
  };
  // Before readline's own resize handler, which redraws the prompt through
  // the output below and must not repaint at the old size.
  if (requested === PINNED) output.prependListener?.("resize", onResize);

  // What readline writes through: the terminal itself, except that every
  // erase-to-end-of-screen is followed by the panel it just erased.
  const readlineOutput = requested === PINNED
    ? new Proxy(output, {
        get(target, property) {
          if (property === "write") {
            return (chunk, ...rest) => target.write(
              installed && typeof chunk === "string" && chunk.includes(ERASE_BELOW)
                ? chunk.replaceAll(ERASE_BELOW, ERASE_BELOW + paintSequence())
                : chunk,
              ...rest,
            );
          }
          const value = Reflect.get(target, property, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      })
    : output;

  return {
    mode: requested,
    output: readlineOutput,
    /** Whether the panel currently holds rows of the terminal. */
    pinned: () => installed,
    /**
     * Show the roster. `render({ columns, maxRows })` returns its plain lines
     * at that size; `key` names what a block reprint is worth (membership,
     * leases, run state). A pinned panel repaints whenever its lines differ.
     */
    update({ render, key }) {
      current = { render, key: String(key) };
      refresh();
    },
    /** Give the whole terminal to someone else (a foreground command, a suspend). */
    release() {
      if (released || closed) return;
      released = true;
      uninstall();
    },
    /** Take the rows back after `release`. */
    restore() {
      if (!released || closed) return;
      released = false;
      refresh();
    },
    close() {
      if (closed) return;
      closed = true;
      uninstall();
      output.removeListener?.("resize", onResize);
    },
  };
}
