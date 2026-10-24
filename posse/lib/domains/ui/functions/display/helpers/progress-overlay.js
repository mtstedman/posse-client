import { C } from "../../../../../shared/format/functions/colors.js";
import { displayColumnWidth, fit, stripAnsi, _sanitizeDisplayLine } from "./formatters.js";
import { posseWordmark } from "./brand.js";

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];

function text(value) {
  return stripAnsi(_sanitizeDisplayLine(value)).trim();
}

function elapsedTime(overlay) {
  const now = Date.now();
  const elapsed = Math.max(0, now - Number(overlay.startedAt || now));
  const seconds = Math.floor(elapsed / 1000);
  return {
    clock: `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`,
    tick: Math.floor(elapsed / 250),
  };
}

function panelSize(cols, rows) {
  const width = Math.max(1, Math.min(72, cols - (cols >= 12 ? 4 : 1)));
  const inset = width >= 36 ? 2 : 1;
  return {
    width,
    inset,
    textWidth: Math.max(1, width - 2 - inset * 2),
    maxLines: Math.max(1, rows - 4),
    compact: rows < 16,
  };
}

function heading(left, right, width) {
  const rightWidth = displayColumnWidth(right);
  if (width < rightWidth + 10) return fit(left, width);
  return `${fit(left, width - rightWidth - 2)}  ${C.dim}${right}${C.reset}`;
}

function panel(buf, lines, cols, rows, size) {
  // A tiny terminal gets a single readable status instead of a box that wraps
  // or scrolls the frozen backing frame. Leave the last terminal column free.
  if (cols < 12 || rows < 5) {
    return `${buf}\x1b[1;1H${fit(lines[0] || "Working", Math.max(0, cols - 1))}`;
  }
  const content = lines.slice(0, size.maxLines);
  const innerWidth = size.width - 2;
  const height = content.length + 2;
  const col = Math.max(1, Math.floor((cols - size.width) / 2) + 1);
  const row = Math.max(1, Math.floor((rows - height) / 2) + 1);
  const gutter = " ".repeat(size.inset);
  let out = `${buf}\x1b[${row};${col}H${C.dim}╭${"─".repeat(innerWidth)}╮${C.reset}`;
  for (const [index, line] of content.entries()) {
    out += `\x1b[${row + index + 1};${col}H${C.dim}│${C.reset}${gutter}${fit(line, size.textWidth)}${gutter}${C.dim}│${C.reset}`;
  }
  return `${out}\x1b[${row + height - 1};${col}H${C.dim}╰${"─".repeat(innerWidth)}╯${C.reset}`;
}

export function progressStepIcon(status, tick = 0) {
  if (status === "done") return `${C.green}✓${C.reset}`;
  if (status === "failed") return `${C.red}✗${C.reset}`;
  if (status === "skipped") return `${C.dim}−${C.reset}`;
  if (status === "running") return `${C.cyan}${SPINNER[Math.abs(Number(tick) || 0) % SPINNER.length]}${C.reset}`;
  return `${C.dim}·${C.reset}`;
}

export function renderActionOverlay(buf, overlay, cols, rows) {
  const size = panelSize(cols, rows);
  const { clock, tick } = elapsedTime(overlay);
  const meta = overlay.meta || {};
  const title = text(overlay.title).replace(/[.\u2026]+$/, "");
  const subtitle = text(overlay.subtitle).replace(/\s*[-–—·]?\s*please wait$/i, "");
  const flow = meta.branch ? `${text(meta.branch)} ${C.dim}→${C.reset} ${text(meta.target || "main")}` : subtitle;
  const accent = meta.tone === "warn" ? C.yellow : C.cyan;
  const action = `${accent}${SPINNER[tick % SPINNER.length]}${C.reset} ${C.bold}${title}${C.reset}`;
  const lines = size.compact
    ? [heading(action, clock, size.textWidth), `${C.dim}${flow}${C.reset}`, `${C.dim}${text(meta.item)}${C.reset}`]
    : ["", heading(posseWordmark(), `${clock} elapsed`, size.textWidth), "", action,
      `${C.dim}${flow}${C.reset}`, `${C.dim}${text(meta.item)}${C.reset}`, ""];
  return panel(buf, lines, cols, rows, size);
}

export function renderWrapUpOverlay(buf, overlay, cols, rows) {
  const size = panelSize(cols, rows);
  const { clock, tick } = elapsedTime(overlay);
  const steps = Array.isArray(overlay.steps) ? overlay.steps : [];
  const title = `${C.bold}${text(overlay.title || "Wrapping up")}${C.reset}`;
  const header = size.compact
    ? [heading(title, clock, size.textWidth)]
    : [heading(posseWordmark(), `${clock} elapsed`, size.textWidth), title,
      `${C.dim}${text(overlay.subtitle)}${C.reset}`, ""];
  const interrupt = `${C.dim}Ctrl+C${C.reset} Interrupt`;
  const exit = overlay.earlyExitRequested
    ? `${C.yellow}Exit requested${C.reset}`
    : `${C.cyan}Enter${C.reset} Exit early`;
  const controls = overlay.allowEarlyExit
    ? (size.textWidth < 40 ? [exit, interrupt] : [`${exit}  ${C.dim}·${C.reset}  ${interrupt}`])
    : [interrupt];
  const note = overlay.earlyExitRequested
    ? `${C.yellow}Exit requested${C.reset} ${C.dim}· remaining work stays queued${C.reset}`
    : `${C.dim}${text(overlay.exitHint || "Remaining Atlas work stays queued for next run.")}${C.reset}`;
  const footer = [
    ...(!size.compact ? ["", ...(overlay.allowEarlyExit ? [note] : [])] : []),
    ...controls,
  ];
  // Controls have their own rows. Long details cannot push them off-screen.
  const available = Math.max(0, size.maxLines - header.length - footer.length);
  const rowHeight = !size.compact && available >= steps.length * 2 ? 2 : 1;
  const overflow = steps.length * rowHeight > available;
  const count = Math.max(0, Math.min(steps.length, Math.floor((available - (overflow ? 1 : 0)) / rowHeight)));
  const active = steps.findIndex((step) => step.status === "running");
  const focus = active >= 0 ? active : Math.max(0, steps.findIndex((step) => step.status === "failed"));
  const start = Math.max(0, Math.min(focus - Math.floor(count / 2), steps.length - count));
  const lines = [];
  for (const step of steps.slice(start, start + count)) {
    const label = text(step.label);
    const detail = text(step.detail);
    const color = step.status === "running" ? C.bold : step.status === "pending" ? C.dim : "";
    lines.push(`${progressStepIcon(step.status, tick)} ${color}${label}${C.reset}${rowHeight === 1 && detail ? ` ${C.dim}· ${detail}${C.reset}` : ""}`);
    if (rowHeight === 2) lines.push(detail ? `  ${C.dim}${detail}${C.reset}` : "");
  }
  if (overflow && available > 0) lines.push(`${C.dim}${steps.length - count} more step${steps.length - count === 1 ? "" : "s"}${C.reset}`);
  return panel(buf, [...header, ...lines, ...footer], cols, rows, size);
}
