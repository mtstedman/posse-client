// Canonical closed sets for the session participant roster: the one-row-per-
// person model the session console's control panel and the `posse go` session
// dashboard both render. Every value a roster row can carry is registered
// here; the model and the surfaces import it.

// Where a participant stands with the host. Members who left or were removed
// are history and get no row.
export const SESSION_ROSTER_ADMISSIONS = Object.freeze({
  PENDING: "pending",
  ADMITTED: "admitted",
});

// Whether a participant's scheduler (`posse go`) is running. Peers do not
// advertise this, so for a peer only RUNNING can be shown, and only by
// inference; UNKNOWN means "nothing of theirs is executing right now", which a
// stopped scheduler and an idle one look alike.
export const SESSION_ROSTER_SCHEDULER_STATES = Object.freeze({
  RUNNING: "running",
  STOPPED: "stopped",
  UNKNOWN: "unknown",
});

// What a scheduler state rests on: this clone's own scheduler lock (a fact),
// or a peer's advertised jobs in an executing status (an inference: a job only
// executes under a running scheduler).
export const SESSION_ROSTER_SCHEDULER_EVIDENCE = Object.freeze({
  SCHEDULER_LOCK: "scheduler-lock",
  ACTIVE_JOBS: "active-jobs",
  NONE: "none",
});

// How current a row's work counts are.
export const SESSION_ROSTER_PRESENCE = Object.freeze({
  // This clone, or a peer the relay heard from recently.
  LIVE: "live",
  // The relay has not heard from the peer for longer than the stale window.
  AWAY: "away",
  // Admitted, but no heartbeat of theirs has been relayed yet: counts unknown.
  CONNECTING: "connecting",
  // Not admitted yet: no work is exchanged with a pending member.
  WAITING_FOR_HOST: "waiting-for-host",
});

// How the session console shows the roster.
export const SESSION_PANEL_MODES = Object.freeze({
  // Pinned under the prompt in a terminal scroll region (opt-in).
  PINNED: "pinned",
  // Printed into the feed as a block when membership or leases change (default).
  BLOCK: "block",
  // Not shown (JSON output).
  OFF: "off",
});

export const SESSION_PANEL_MODE_VALUES = Object.freeze(Object.values(SESSION_PANEL_MODES));

// `pinned` opts in to the pinned panel, `off` silences the block.
export const SESSION_PANEL_ENV = "POSSE_SESSION_PANEL";

export const SESSION_PANEL_LAYOUT = Object.freeze({
  // Below either bound the terminal is too small to give rows away.
  MIN_ROWS: 12,
  MIN_COLUMNS: 40,
  // Participant rows shown before "+N more"; the panel never takes more than
  // a third of the window.
  MAX_PARTICIPANT_ROWS: 8,
  MAX_WINDOW_SHARE: 1 / 3,
  LABEL_WIDTH_MAX: 24,
});
