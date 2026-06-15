// @ts-check

import { isTerminalParseKind } from "../../functions/v2/parse/event-kinds.js";

export class ParseStateRegistry {
  /** @type {Map<string, Record<string, unknown>>} */
  #rows = new Map();

  record(event) {
    if (!event || typeof event !== "object") return null;
    const kind = String(event.kind || "");
    const lang = String(event.lang || event.mode || "repo");
    const key = keyFor(kind, lang);
    const current = this.#rows.get(key) || {};
    const next = {
      ...current,
      ...event,
      updatedAt: new Date().toISOString(),
    };
    if (isTerminalParseKind(kind)) next.active = false;
    else next.active = true;
    this.#rows.set(key, next);
    return next;
  }

  snapshot() {
    return [...this.#rows.values()]
      .map((row) => ({ ...row }))
      .sort((a, b) => String(a.kind || "").localeCompare(String(b.kind || "")));
  }

  active() {
    return this.snapshot().filter((row) => row.active !== false);
  }

  clearInactive() {
    for (const [key, row] of this.#rows.entries()) {
      if (row.active === false) this.#rows.delete(key);
    }
  }
}

function keyFor(kind, lang) {
  const parts = String(kind || "").split(".").filter(Boolean);
  let family;
  if (parts[0] === "atlas" && parts[1] === "parse") {
    family = parts[2] === "scip" && parts[3]
      ? parts.slice(0, 4).join(".")
      : parts.slice(0, 3).join(".");
  } else {
    family = parts.slice(0, Math.max(0, parts.length - 1)).join(".");
  }
  return `${family}:${lang}`;
}
