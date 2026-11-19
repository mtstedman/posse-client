// Opaque `before` cursor for work_item.conversation pages, bound to the
// request's filters the same way history cursors are (work-item-history.js):
// a base64url payload plus a digest over a fixed context, payload and query
// identity, so a cursor cannot be replayed against another filter.
import crypto from "node:crypto";

import { AGENT_CONVERSATION_BOUNDS } from "../../../catalog/agent-conversation.js";

const CONTEXT = "posse-conversation-cursor-v1";

function identityHash(identity) {
  return crypto.createHash("sha256").update(identity, "utf8").digest("base64url").slice(0, 24);
}

function signature(payload, identity) {
  return crypto.createHash("sha256")
    .update(`${CONTEXT}\0${payload}\0${identity}`, "utf8")
    .digest("base64url")
    .slice(0, 24);
}

export function encodeConversationCursor(orderKey, identity) {
  const payload = Buffer.from(JSON.stringify({ v: 1, k: String(orderKey), h: identityHash(identity) }), "utf8")
    .toString("base64url");
  return `${payload}.${signature(payload, identity)}`;
}

/** The order_key the cursor names, or null when it is malformed or foreign. */
export function decodeConversationCursor(cursor, identity) {
  const text = String(cursor || "");
  if (!text || Buffer.byteLength(text, "utf8") > AGENT_CONVERSATION_BOUNDS.CURSOR_BYTES) return null;
  const [payload, supplied, extra] = text.split(".");
  if (!payload || !supplied || extra != null) return null;
  const expected = signature(payload, identity);
  if (supplied.length !== expected.length || !crypto.timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return null;
  try {
    const parsed = JSON.parse(Buffer.from(payload, "base64url").toString("utf8"));
    if (parsed?.v !== 1 || parsed?.h !== identityHash(identity)) return null;
    const key = String(parsed.k || "");
    return /^\d{4}-\d{2}-\d{2}T[^|]+\|[a-z_]+:[A-Za-z0-9:_-]+$/u.test(key) ? key : null;
  } catch {
    return null;
  }
}
