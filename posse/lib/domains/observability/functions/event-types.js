// lib/domains/observability/functions/event-types.js
//
// Light-touch registry for events.event_type values. The schema column is
// intentionally unconstrained TEXT — events are a high-cardinality namespace
// and adding a CHECK constraint would force migrations every time a new event
// is added. Instead, this module provides:
//
//   - A KNOWN_EVENT_NAMESPACES set listing the top-level namespaces in use.
//     New code is encouraged to use one of these (or extend the set) so that
//     event_type does not silently drift via typos.
//   - A validateEventType(type) helper that classifies a type as valid,
//     warn-eligible (unknown namespace or malformed), or invalid (non-string).
//   - logEvent() in queue/events.js calls this and emits a once-per-process
//     console.warn when something looks off. The write still proceeds so this
//     stays additive — existing freeform writes are not broken.
//
// Format conventions accepted:
//   - Dotted form:    "job.created"  "research.fanout_child_timed_out"
//   - Legacy bare:    "session_acquired"  "skill_inferred"  (kept until
//                     callers can migrate; do not add new bare types)
//
// New event types should always use the dotted form so the namespace check
// surfaces typos.

import { EVENT_TYPES } from "../../../catalog/event.js";

export const KNOWN_EVENT_NAMESPACES = Object.freeze(new Set([
  // Active namespaces observed in the codebase
  "agent_call",
  "agent",
  "agent_interaction",
  "agent_question",
  "artifacts",
  "attempt",
  "bridge",
  "cleanup",
  "git",
  "job",
  "kaizen",
  "packet",
  "pipeline",
  "plan",
  "planner",
  "preflight",
  "research",
  "scheduler",
  "operator_nudge",
  "atlas",
  "wi",
  "work_item",
  "worktree",
  // Reserved for likely future use; harmless if unused
  "assessor",
  "human",
  "merge",
  "system",
  "tool",
  "worker",
]));

// Legacy bare (no-dot) event types that pre-date this registry. Added so the
// validator does not flood logs at boot. Do not extend this list — new code
// should always use a dotted namespace.
const KNOWN_LEGACY_BARE_TYPES = Object.freeze(new Set([
  EVENT_TYPES.SESSION_ACQUIRED,
  EVENT_TYPES.SESSION_ADVANCED,
  EVENT_TYPES.SESSION_EXPIRED,
  EVENT_TYPES.SESSION_FAILED,
  EVENT_TYPES.SESSION_INVALIDATED,
  EVENT_TYPES.SESSION_LANE_LOCKED,
  EVENT_TYPES.SESSION_LEASE_EXPIRED,
  EVENT_TYPES.SKILL_ATTACHED,
  EVENT_TYPES.SKILL_INFERRED,
  EVENT_TYPES.SKILL_SKIPPED_DISABLED,
  EVENT_TYPES.SKILL_SKIPPED_UNKNOWN,
  EVENT_TYPES.SKILL_TRUNCATED,
]));

const SEGMENT_RE = /^[a-z][a-z0-9_]*$/;

/**
 * Validates an event_type value. Returns one of:
 *   { valid: true }                          ← well-known dotted or legacy bare
 *   { valid: false, kind: "non-string" }
 *   { valid: false, kind: "empty" }
 *   { valid: false, kind: "malformed", reason }
 *   { valid: false, kind: "unknown-namespace", namespace, reason }
 *   { valid: false, kind: "unknown-bare", reason }
 *
 * Even when valid: false, the caller may still choose to write the event;
 * the registry is advisory, not enforcing.
 */
export function validateEventType(type) {
  if (typeof type !== "string") return { valid: false, kind: "non-string" };
  if (type.length === 0) return { valid: false, kind: "empty" };

  if (!type.includes(".")) {
    // Bare form. Legacy-allowlist passes; everything else is suspect.
    if (KNOWN_LEGACY_BARE_TYPES.has(type)) return { valid: true };
    return {
      valid: false,
      kind: "unknown-bare",
      reason: `event_type "${type}" has no namespace prefix; prefer "<namespace>.${type}"`,
    };
  }

  const segments = type.split(".");
  for (const seg of segments) {
    if (!SEGMENT_RE.test(seg)) {
      return {
        valid: false,
        kind: "malformed",
        reason: `event_type "${type}" segment "${seg}" must match ${SEGMENT_RE}`,
      };
    }
  }
  const namespace = segments[0];
  if (!KNOWN_EVENT_NAMESPACES.has(namespace)) {
    return {
      valid: false,
      kind: "unknown-namespace",
      namespace,
      reason: `event_type "${type}" uses unknown namespace "${namespace}"; add it to KNOWN_EVENT_NAMESPACES or use one of: ${[...KNOWN_EVENT_NAMESPACES].sort().join(", ")}`,
    };
  }
  return { valid: true };
}

// Track which invalid event types we have already warned about so logs are
// not flooded when the same type fires from a tight loop.
const _warnedEventTypes = new Set();

export function warnOnceForInvalidEventType(type, validation = validateEventType(type)) {
  if (validation.valid) return;
  if (_warnedEventTypes.has(type)) return;
  _warnedEventTypes.add(type);
  const prefix = "[observability] event_type registry:";
  console.warn(`${prefix} ${validation.reason || `event_type "${type}" failed validation (${validation.kind})`}`);
}

export function __resetEventTypeWarningsForTests() {
  _warnedEventTypes.clear();
}
