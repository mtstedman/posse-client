// Canonical closed sets for a shared run: `posse go` started while this clone
// is in a live session. A shared run does not end when its queue empties; it
// stays on the session screen until the operator stops it or the session ends.
// It also registers the session pane's key bindings next to the run screen's
// global ones, so a new binding cannot take a key that is already in use.

// Why a shared run was asked to stop while it could have stayed open.
export const SHARED_RUN_END_REASONS = Object.freeze({
  // The host closed the session (or it expired): the relay reports it as no
  // longer active.
  SESSION_CLOSED: "session-closed",
  // The relay refused this clone's credential or the session changed
  // identity: a member the host removed lands here.
  ACCESS_REVOKED: "access-revoked",
  // A local `posse session close` asked this scheduler to drain.
  CLOSE_REQUESTED: "close-requested",
});

// Exit code of `posse session merge|deploy` when the operator declined the
// typed approval: nothing was published and nothing failed. Callers that ran
// the command for the operator report it as canceled, not as an error.
export const SESSION_PUBLISH_DECLINED_EXIT_CODE = 3;

export const SHARED_RUN_END_REASON_VALUES = Object.freeze(Object.values(SHARED_RUN_END_REASONS));

// Set to 1 to make `posse session host` / `join` stay in the session console
// instead of opening the session screen once the session is ready.
export const SESSION_CONSOLE_FIRST_ENV = "POSSE_SESSION_CONSOLE";

// Keys the run screen acts on in every right-panel mode while no input is
// open (input-controller.js). Digits 1-9 pick a waiting question.
export const RUN_DISPLAY_GLOBAL_KEYS = Object.freeze({
  ACTIVITY: "l",
  AGENTS: "m",
  PIPELINE: "p",
  TOOLS: "t",
  SESSION: "o",
  QUESTIONS: "q",
  INJECT: "i",
  SESSION_COMMAND: "u",
  KILL: "k",
  CANCEL_WORK_ITEM: "x",
  SKIP: "s",
  REVIEW: "r",
  NUDGE: "n",
  ASK: "?",
  IMAGE: "g",
});

// Keys that act only while the Session pane is showing and no prompt of its
// own is open. None may be a global key.
export const SESSION_PANE_KEYS = Object.freeze({
  ADMIT: "a",
  LEASE: "e",
  SCOPE: "c",
  REMOVE: "z",
  HOST_MENU: "h",
});

// What the host can do to a selected roster row, and to the session.
export const SESSION_PANE_ACTIONS = Object.freeze({
  ADMIT: "admit",
  LEASE: "lease",
  SCOPE: "scope",
  REMOVE: "remove",
  MERGE: "merge",
  DEPLOY: "deploy",
  AUTO_MERGE: "auto-merge",
  AUTO_DEPLOY: "auto-deploy",
  INVITE: "invite",
  POLICY: "policy",
  CLOSE: "close",
});

// The pane's own prompts. While one is open it takes every key, so its keys
// are free to repeat global ones.
export const SESSION_PANE_PROMPTS = Object.freeze({
  LEASE: "lease",
  CONFIRM: "confirm",
  HOST_MENU: "host-menu",
});

// The lease picker: whose computer runs the selected member's work.
export const SESSION_LEASE_PICK_KEYS = Object.freeze({
  h: "host",
  m: "member",
  d: "default",
});

// The host menu: session-level actions.
export const SESSION_HOST_MENU_KEYS = Object.freeze({
  m: SESSION_PANE_ACTIONS.MERGE,
  d: SESSION_PANE_ACTIONS.DEPLOY,
  a: SESSION_PANE_ACTIONS.AUTO_MERGE,
  b: SESSION_PANE_ACTIONS.AUTO_DEPLOY,
  i: SESSION_PANE_ACTIONS.INVITE,
  p: SESSION_PANE_ACTIONS.POLICY,
  c: SESSION_PANE_ACTIONS.CLOSE,
});

export const SESSION_PANE_CONFIRM_KEY = "y";

// Actions that remove access, publish, or end the session ask first.
export const SESSION_PANE_CONFIRMED_ACTIONS = Object.freeze([
  SESSION_PANE_ACTIONS.REMOVE,
  SESSION_PANE_ACTIONS.DEPLOY,
  SESSION_PANE_ACTIONS.CLOSE,
]);

/** A session pane key that is also a global key, or null when none is. */
export function sessionPaneKeyCollision({
  globalKeys = RUN_DISPLAY_GLOBAL_KEYS,
  paneKeys = SESSION_PANE_KEYS,
} = {}) {
  const taken = new Set(Object.values(globalKeys));
  const seen = new Set();
  for (const key of Object.values(paneKeys)) {
    if (taken.has(key) || seen.has(key) || /^[1-9]$/u.test(key)) return key;
    seen.add(key);
  }
  return null;
}
