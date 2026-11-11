// The Session pane as a manager: which roster row is selected, what the host
// may do to it or to the session, and the session command each action runs.
//
// Pure. Nothing here talks to the Remote or changes a session: every action
// becomes the same typed command the `u` prompt takes (or opens that prompt
// with the command started), so authority stays where it is enforced today:
// the command parser's role list, the command layer's host check, and the
// Remote, which only honours a host's credential. A member's seat gets no
// actions at all; the pane only hides what the command path would refuse.

import {
  SESSION_HOST_MENU_KEYS,
  SESSION_LEASE_PICK_KEYS,
  SESSION_PANE_ACTIONS,
  SESSION_PANE_CONFIRMED_ACTIONS,
  SESSION_PANE_CONFIRM_KEY,
  SESSION_PANE_KEYS,
  SESSION_PANE_PROMPTS,
  sessionPaneKeyCollision,
} from "../../../../catalog/shared-run.js";
import { SESSION_ROSTER_ADMISSIONS } from "../../../../catalog/session-roster.js";

const A = SESSION_PANE_ACTIONS;
const P = SESSION_PANE_PROMPTS;

// A binding that takes a global key would never fire, or would fire twice.
const collision = sessionPaneKeyCollision();
if (collision) throw new Error(`Session pane key "${collision}" collides with a run screen key`);

const ROW_ACTION_KEYS = Object.freeze({
  [SESSION_PANE_KEYS.ADMIT]: A.ADMIT,
  [SESSION_PANE_KEYS.LEASE]: A.LEASE,
  [SESSION_PANE_KEYS.SCOPE]: A.SCOPE,
  [SESSION_PANE_KEYS.REMOVE]: A.REMOVE,
});

function list(value) {
  return Array.isArray(value) ? value : [];
}

function keyFor(map, action) {
  return Object.keys(map).find((key) => map[key] === action) || "";
}

/** The roster rows the pane can select, in display order. */
export function sessionPaneRows(session) {
  return list(session?.participants?.rows).filter((row) => row && row.id != null);
}

/** One name for a keypress: an arrow or Escape or Enter, else the lowercase character. */
export function sessionPaneKeyName(str, key) {
  const name = typeof key?.name === "string" ? key.name.toLowerCase() : "";
  if (["up", "down", "escape", "return", "enter"].includes(name)) return name === "return" ? "enter" : name;
  if (str === "\x1b") return "escape";
  if (key?.ctrl || key?.meta) return "";
  const text = typeof str === "string" && /^[ -~]$/u.test(str) ? str
    : typeof key?.sequence === "string" && /^[ -~]$/u.test(key.sequence) ? key.sequence
      : /^[ -~]$/u.test(name) ? name : "";
  return text.toLowerCase();
}

/**
 * The selected row's id: the one already selected while it is still listed,
 * else the first row that needs the host (a pending request), else the first.
 */
export function resolveSessionSelection(rows, selectedId, { role = "member" } = {}) {
  const all = list(rows);
  if (all.some((row) => row.id === selectedId)) return selectedId;
  const pending = role === "host"
    ? all.find((row) => row.admission === SESSION_ROSTER_ADMISSIONS.PENDING)
    : null;
  return (pending || all[0])?.id ?? null;
}

/**
 * Move the selection by `delta` rows. `moved` is false at either end, where
 * the pane scrolls its content instead.
 */
export function moveSessionSelection(rows, selectedId, delta) {
  const all = list(rows);
  if (all.length === 0) return { selectedId: null, moved: false };
  const index = Math.max(0, all.findIndex((row) => row.id === selectedId));
  const next = Math.max(0, Math.min(all.length - 1, index + (delta < 0 ? -1 : 1)));
  return { selectedId: all[next].id, moved: next !== index || all[index].id !== selectedId };
}

/**
 * The first content line the pane should show so that `selectedLine` is
 * visible in a window of `available` lines.
 */
export function sessionScrollForSelection({ scroll = 0, selectedLine = null, available = 0, total = 0 } = {}) {
  const maxScroll = Math.max(0, total - available);
  let next = Math.max(0, Math.min(scroll, maxScroll));
  if (selectedLine == null || available <= 0) return next;
  if (selectedLine < next) next = selectedLine;
  else if (selectedLine >= next + available) next = selectedLine - available + 1;
  return Math.max(0, Math.min(next, maxScroll));
}

/**
 * What the host may do to a roster row. Nothing for a member's seat, for the
 * host's own row, or for a row the host's member list does not name.
 */
export function sessionRowActions({ role = "member", row = null } = {}) {
  if (role !== "host" || !row || row.self || row.is_host || !row.member_id) return [];
  return row.admission === SESSION_ROSTER_ADMISSIONS.PENDING
    ? [A.ADMIT, A.REMOVE]
    : [A.LEASE, A.SCOPE, A.REMOVE];
}

/** What the host may do to the session as a whole. Nothing for a member. */
export function sessionHostActions({ role = "member" } = {}) {
  return role === "host" ? Object.values(SESSION_HOST_MENU_KEYS) : [];
}

/**
 * The action a key starts while no pane prompt is open, or null: a row action
 * the selected row allows, or the host menu.
 */
export function sessionPaneKeyAction({ role = "member", row = null, key = "" } = {}) {
  if (role !== "host") return null;
  if (key === SESSION_PANE_KEYS.HOST_MENU) return P.HOST_MENU;
  const action = ROW_ACTION_KEYS[key];
  return action && sessionRowActions({ role, row }).includes(action) ? action : null;
}

function rowLabel(row) {
  const label = String(row?.label || "this member");
  return row?.short_id && !label.includes(row.short_id) ? `${label} (${row.short_id})` : label;
}

function confirmQuestion(action, row, session) {
  if (action === A.REMOVE) {
    return row?.admission === SESSION_ROSTER_ADMISSIONS.PENDING
      ? `Decline ${rowLabel(row)}'s request to join?`
      : `Remove ${rowLabel(row)} from the session? Their access is revoked and their runs stop.`;
  }
  if (action === A.DEPLOY) return "Deploy: merge the team's work and push your branch to origin? You approve the exact change next.";
  if (action === A.CLOSE) {
    const others = Math.max(0, Number(session?.peer_count) || 0);
    return `Close the session for everyone${others > 0 ? ` (${others} connected)` : ""}? Its work is frozen for your approval, not published.`;
  }
  return "Are you sure?";
}

function toggleWord(on) {
  return on ? "off" : "on";
}

/**
 * What an action does, as a plan the pane carries out:
 *
 *   { kind: "command", command }   run this session command (the `u` path)
 *   { kind: "prefill", text }      open the `u` prompt with this typed already
 *   { kind: "prompt", prompt }     ask first: a lease choice, a confirmation,
 *                                  or the host menu
 *   null                           refused: not the host, or not for this row
 *
 * `choice` answers a lease prompt; `confirmed` answers a confirmation.
 */
export function sessionActionPlan(action, {
  role = "member", row = null, session = null, choice = null, confirmed = false,
} = {}) {
  if (role !== "host") return null;
  if (action === P.HOST_MENU) return { kind: "prompt", prompt: { kind: P.HOST_MENU } };
  const rowAction = Object.values(ROW_ACTION_KEYS).includes(action);
  if (rowAction && !sessionRowActions({ role, row }).includes(action)) return null;
  if (!rowAction && !sessionHostActions({ role }).includes(action)) return null;
  if (SESSION_PANE_CONFIRMED_ACTIONS.includes(action) && !confirmed) {
    return {
      kind: "prompt",
      prompt: {
        kind: P.CONFIRM,
        action,
        rowId: rowAction ? row.id : null,
        question: confirmQuestion(action, row, session),
      },
    };
  }
  switch (action) {
    // The member list does not carry the countersign: the host types the code
    // the member reads out, optionally followed by host or member.
    case A.ADMIT: return { kind: "prefill", text: "admit " };
    case A.LEASE: {
      if (choice == null) return { kind: "prompt", prompt: { kind: P.LEASE, rowId: row.id, label: rowLabel(row) } };
      if (!Object.values(SESSION_LEASE_PICK_KEYS).includes(choice)) return null;
      return { kind: "command", command: `lease ${row.member_id} ${choice}` };
    }
    case A.SCOPE: return { kind: "prefill", text: `scope ${row.member_id} ` };
    case A.REMOVE: return { kind: "command", command: `kick ${row.member_id}` };
    case A.MERGE: return { kind: "command", command: "merge" };
    case A.DEPLOY: return { kind: "command", command: "deploy" };
    case A.AUTO_MERGE:
    case A.AUTO_DEPLOY: {
      const which = action === A.AUTO_MERGE ? "merge" : "deploy";
      const mode = session?.publish?.[`${which}_mode`];
      // Without the current mode there is nothing to toggle from: let the host type it.
      if (mode !== "auto" && mode !== "ask") return { kind: "prefill", text: `auto ${which} ` };
      return { kind: "command", command: `auto ${which} ${toggleWord(mode === "auto")}` };
    }
    case A.INVITE: return { kind: "command", command: `invite ${session?.enrollment_open ? "close" : "open"}` };
    case A.POLICY: return { kind: "prefill", text: "policy " };
    case A.CLOSE: return { kind: "command", command: "close" };
    default: return null;
  }
}

/**
 * A key pressed while a pane prompt is open. Returns { cancel: true } for
 * Escape, { plan } for a key the prompt answers to (the plan may be another
 * prompt: a confirmation), { gone: true } when the row it was about has left
 * the roster, and null for any other key (the prompt stays).
 */
export function resolveSessionPrompt(prompt, key, { role = "member", rows = [], session = null } = {}) {
  if (!prompt || role !== "host") return { cancel: true };
  if (key === "escape") return { cancel: true };
  const row = prompt.rowId == null ? null : list(rows).find((item) => item.id === prompt.rowId) || null;
  if (prompt.rowId != null && !row) return { gone: true };
  let plan = null;
  if (prompt.kind === P.LEASE) {
    const choice = SESSION_LEASE_PICK_KEYS[key];
    if (!choice) return null;
    plan = sessionActionPlan(A.LEASE, { role, row, session, choice });
  } else if (prompt.kind === P.CONFIRM) {
    if (key !== SESSION_PANE_CONFIRM_KEY) return null;
    plan = sessionActionPlan(prompt.action, { role, row, session, confirmed: true });
  } else if (prompt.kind === P.HOST_MENU) {
    const action = SESSION_HOST_MENU_KEYS[key];
    if (!action) return null;
    plan = sessionActionPlan(action, { role, row: null, session });
  }
  return plan ? { plan } : { cancel: true };
}

function hint(key, label) {
  return `[${String(key).toUpperCase()}] ${label}`;
}

const ROW_ACTION_LABELS = Object.freeze({
  [A.ADMIT]: "admit (type their code)",
  [A.LEASE]: "lease",
  [A.SCOPE]: "write scope",
});

function hostMenuLabel(action, session) {
  const publish = session?.publish || {};
  switch (action) {
    case A.MERGE: return "merge";
    case A.DEPLOY: return "deploy";
    case A.AUTO_MERGE: return `auto merge ${publish.merge_mode ? toggleWord(publish.merge_mode === "auto") : "on/off"}`;
    case A.AUTO_DEPLOY: return `auto deploy ${publish.deploy_mode ? toggleWord(publish.deploy_mode === "auto") : "on/off"}`;
    case A.INVITE: return session?.enrollment_open ? "close invites" : "open invites";
    case A.POLICY: return "policy";
    case A.CLOSE: return "close session";
    default: return action;
  }
}

/**
 * The pane's hint line for the selected row, as plain text: the open prompt's
 * choices, else the actions the selected row allows from this seat.
 */
export function sessionPaneHintLine({ role = "member", row = null, prompt = null, session = null } = {}) {
  const host = role === "host";
  if (host && prompt?.kind === P.LEASE) {
    return `Lease for ${prompt.label || rowLabel(row)}: ${hint(keyFor(SESSION_LEASE_PICK_KEYS, "host"), "your computer and account")}  `
      + `${hint(keyFor(SESSION_LEASE_PICK_KEYS, "member"), "their own")}  ${hint(keyFor(SESSION_LEASE_PICK_KEYS, "default"), "session default")}  [Esc] cancel`;
  }
  if (host && prompt?.kind === P.CONFIRM) {
    return `${prompt.question}  ${hint(SESSION_PANE_CONFIRM_KEY, "yes")}  [Esc] cancel`;
  }
  if (host && prompt?.kind === P.HOST_MENU) {
    const items = Object.entries(SESSION_HOST_MENU_KEYS).map(([key, action]) => hint(key, hostMenuLabel(action, session)));
    return `Session: ${items.join("  ")}  [Esc] cancel`;
  }
  // The roster is advisory: without it there is no row to act on.
  if (!row) return "";
  if (!host) return `▸ ${rowLabel(row)} · view only`;
  const actions = sessionRowActions({ role, row });
  if (actions.length === 0) {
    return row.self ? "▸ you · no actions on your own row" : `▸ ${rowLabel(row)} · no actions on this row`;
  }
  const pending = row.admission === SESSION_ROSTER_ADMISSIONS.PENDING;
  const parts = actions.map((action) => (action === A.REMOVE
    ? hint(SESSION_PANE_KEYS.REMOVE, pending ? "decline" : "remove")
    : hint(keyFor(ROW_ACTION_KEYS, action), ROW_ACTION_LABELS[action])));
  return `▸ ${rowLabel(row)}: ${parts.join("  ")}`;
}

/** The pane's title hints: what the seat can do without a row selected. */
export function sessionPaneTitleHints({ role = "member", canInject = false, canCommand = false, injectKey = "i", commandKey = "u" } = {}) {
  const host = role === "host";
  const parts = ["[↑↓] select"];
  if (host && canCommand) parts.push(hint(SESSION_PANE_KEYS.HOST_MENU, "session actions"));
  if (canInject) parts.push(hint(injectKey, "add task"));
  if (canCommand) parts.push(hint(commandKey, host ? "command" : "hold · resume · status"));
  return parts.join("  ");
}

/**
 * Wrap a hint (parts separated by two spaces) to `width` columns, breaking
 * only between parts: a choice is never cut off the end of the pane. A single
 * part wider than the pane is broken between words.
 */
export function wrapSessionPaneHint(text, width) {
  const limit = Math.max(8, Math.floor(Number(width) || 0));
  const lines = [];
  let line = "";
  const push = (part, joiner) => {
    if (!line) line = part;
    else if (line.length + joiner.length + part.length <= limit) line += joiner + part;
    else {
      lines.push(line);
      line = part;
    }
  };
  for (const part of String(text || "").split(/ {2,}/u).filter(Boolean)) {
    if (part.length <= limit) {
      push(part, "  ");
      continue;
    }
    for (const word of part.split(" ")) push(word, " ");
  }
  if (line) lines.push(line);
  return lines;
}
