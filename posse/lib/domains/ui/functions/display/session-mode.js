// The run screen's Session mode: the right-panel view a run inside a live
// session opens on: who is in the session, their lease, what each is working
// on and whether it runs. A roster row can be selected; the host's seat is a
// manager (session-pane.js holds its actions), a member's only shows.

import { ACTIVE_LEASE_STATUSES } from "../../../../catalog/job.js";
import { TERMINAL_WORK_ITEM_STATUSES } from "../../../../catalog/work-item.js";
import { C } from "../../../../shared/format/functions/colors.js";
import { fit, _sanitizeDisplayLine } from "./helpers/formatters.js";
import { brandRule } from "./helpers/brand.js";
import { RUN_DISPLAY_GLOBAL_KEYS } from "../../../../catalog/shared-run.js";
import { peerWorkSummary, sessionPairingDashboardLines } from "./session-presentation.js";
import { sessionPaneHintLine, sessionPaneTitleHints, wrapSessionPaneHint } from "./session-pane.js";

export const SESSION_RIGHT_MODE = "session";

const EXECUTING = new Set(ACTIVE_LEASE_STATUSES);
const TERMINAL_WORK_ITEMS = new Set(TERMINAL_WORK_ITEM_STATUSES);

/** The live session's summary row in a pipeline snapshot, or null. */
export function sessionSummaryRow(data) {
  return (Array.isArray(data) ? data : []).find((row) => row?.session_summary) || null;
}

/**
 * Which right-panel mode the display should be in, given whether the run is in
 * a live session. A session that appears selects Session mode once, whatever
 * was showing; the operator's later choice stands. A session that ends takes
 * its mode with it and returns the one that was showing before.
 *
 * @returns {{ mode: string, offered: boolean, previous: string|null }}
 */
export function resolveSessionRightMode({ mode, live, offered = false, previous = null } = {}) {
  if (live && !offered) return { mode: SESSION_RIGHT_MODE, offered: true, previous: mode };
  if (!live && offered) {
    return { mode: mode === SESSION_RIGHT_MODE ? previous || "log" : mode, offered: false, previous: null };
  }
  return { mode, offered, previous };
}

// This clone's own open work items, in the shape of a peer's.
function localWorkLines(data, width) {
  return (Array.isArray(data) ? data : [])
    .filter((row) => !row?.session_summary && !row?.peer_read_only && !TERMINAL_WORK_ITEMS.has(row?.status))
    .map((wi) => {
      const job = (Array.isArray(wi.jobs) ? wi.jobs : []).find((item) => EXECUTING.has(item?.status));
      const detail = job ? ` — ${job.job_type}/${job.status}: ${job.title}` : "";
      return ` ${C.cyan}│${C.reset} ${fit(_sanitizeDisplayLine(`you WI#${wi.id} ${wi.status}: ${wi.title}${detail}`), Math.max(8, width - 4))}`;
    });
}

/**
 * The body of Session mode: the session dashboard with the roster, then
 * everyone's open work items (this clone's and, read-only, the others').
 * `selectedLine` is the index of the selected roster row's line, or null.
 *
 * @returns {{ lines: string[], selectedLine: number|null }}
 */
export function sessionModeView(data, width, { selectedId = null } = {}) {
  const session = sessionSummaryRow(data);
  if (!session) return { lines: [` ${C.dim}○ This run is not in a live session${C.reset}`], selectedLine: null };
  const peerRows = (Array.isArray(data) ? data : []).filter((row) => row?.peer_read_only);
  let selectedLine = null;
  const lines = sessionPairingDashboardLines(session, peerRows, width, {
    roster: true,
    selectedId,
    onSelectedLine: (index) => { selectedLine = index; },
  });
  // The host hands the code out for as long as the session runs.
  if (session.role === "host" && session.invite_code) {
    lines.push(fit(` ${C.dim}INVITE${C.reset} posse session join ${_sanitizeDisplayLine(session.invite_code)}`, width));
  }
  if (session.role === "host" && session.publish) {
    const mode = (value) => (value === "auto" ? "auto" : "you approve");
    lines.push(fit(` ${C.dim}PUBLISH${C.reset} merge: ${mode(session.publish.merge_mode)} ${C.dim}\u00b7${C.reset} deploy: ${mode(session.publish.deploy_mode)}`
      + (session.publish.auto_paused_reason ? ` ${C.yellow}\u00b7 auto paused: ${_sanitizeDisplayLine(session.publish.auto_paused_reason)}${C.reset}` : ""), width));
  }
  if (session.trunk_health?.provenance_gate_job_id) {
    lines.push(` ${C.yellow}Provenance review: gate #${session.trunk_health.provenance_gate_job_id}${C.reset}`);
  }
  lines.push("");
  lines.push(brandRule({ label: "work in this session", color: C.magenta, width }));
  const work = [
    ...localWorkLines(data, width),
    ...peerRows.map((wi) => ` ${C.magenta}│${C.reset} ${fit(_sanitizeDisplayLine(peerWorkSummary(wi)), Math.max(8, width - 4))}`),
  ];
  lines.push(...(work.length > 0 ? work : [` ${C.dim}○ Nobody has an open work item${C.reset}`]));
  return { lines, selectedLine };
}

/** The body of Session mode as lines (see sessionModeView). */
export function sessionModeLines(data, width, options = {}) {
  return sessionModeView(data, width, options).lines;
}

/**
 * The pane's title line: whose seat this is and what it can do from here.
 * A member's seat is read-only; the host's is a manager.
 */
export function sessionModeTitle(session, { canInject = false, canCommand = false } = {}) {
  const host = session?.role === "host";
  const seat = host ? "host · manager" : "member · read-only";
  const hints = sessionPaneTitleHints({
    role: host ? "host" : "member",
    canInject,
    canCommand,
    injectKey: RUN_DISPLAY_GLOBAL_KEYS.INJECT,
    commandKey: RUN_DISPLAY_GLOBAL_KEYS.SESSION_COMMAND,
  });
  return ` ${C.bold}${C.magenta}│ Session${C.reset} ${C.dim}(${seat})  ${hints}${C.reset}`;
}

/**
 * The lines under the title: the open pane prompt, or the selected row's
 * actions. Wrapped, never cut: every choice stays readable in a narrow pane.
 */
export function sessionModeHintLines(session, { row = null, prompt = null, width = 80 } = {}) {
  const role = session?.role === "host" ? "host" : "member";
  const text = sessionPaneHintLine({ role, row, prompt, session });
  if (!text) return [];
  const color = prompt ? `${C.yellow}${C.bold}` : C.cyan;
  return wrapSessionPaneHint(_sanitizeDisplayLine(text), Math.max(8, width - 2))
    .map((line) => ` ${color}${line}${C.reset}`);
}
