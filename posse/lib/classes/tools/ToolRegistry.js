// ToolRegistry — the single class every execution runtime attaches its tool
// handlers to. Tool *metadata* (suite, roles, mutatesWorktree, advertisement
// per transport) is declared once and shared; each runtime (the embedded
// OpenAI/Grok function loop and the deterministic MCP server for Claude/Codex)
// builds a registry instance and attaches the executor it owns for each id.
// Parity between the shared metadata and the attached executors is what keeps
// the transports in sync (asserted by the tool-parity test).
//
// Canonical id is `<suite>.<name>` (e.g. tools.read_file, atlas.symbol_search).
// Executors are still keyed/dispatched by bare name within a transport, so
// `handlerMap()` returns a bare-name -> execute map compatible with the
// existing provider/MCP dispatch.

const TRANSPORTS = new Set(["function", "mcp"]);

function normId(suite, name) {
  return `${suite}.${name}`;
}

export class ToolRegistry {
  constructor() {
    this._byId = new Map();
  }

  /**
   * Declare a tool's shared metadata (no executor). Idempotent per id.
   * @param {object} meta
   * @param {string} meta.suite      - e.g. "tools" or "atlas"
   * @param {string} meta.name       - bare tool name (dispatch key)
   * @param {string[]} [meta.roles]  - roles allowed to use the tool
   * @param {boolean} [meta.mutatesWorktree] - can mutate the working tree
   * @param {string[]} [meta.advertise] - transports the tool is offered on
   *        as a callable schema (subset of {"function","mcp"})
   */
  declare({ suite, name, roles = [], mutatesWorktree = false, advertise = [] } = {}) {
    const s = String(suite || "").trim();
    const n = String(name || "").trim();
    if (!s || !n) throw new Error("ToolRegistry.declare requires suite and name");
    for (const t of advertise) {
      if (!TRANSPORTS.has(t)) throw new Error(`ToolRegistry: unknown transport "${t}" for ${normId(s, n)}`);
    }
    const id = normId(s, n);
    const existing = this._byId.get(id) || {};
    this._byId.set(id, {
      id,
      suite: s,
      name: n,
      roles: [...roles].map(String).sort(),
      mutatesWorktree: !!mutatesWorktree,
      advertise: [...new Set(advertise)],
      execute: existing.execute || null,
    });
    return this;
  }

  /** Attach an executor for an already-declared id (or bare name). */
  attach(idOrName, execute) {
    if (typeof execute !== "function") throw new Error(`ToolRegistry.attach requires a function for ${idOrName}`);
    const entry = this._resolve(idOrName);
    if (!entry) throw new Error(`ToolRegistry.attach: no declared tool "${idOrName}"`);
    entry.execute = execute;
    return this;
  }

  _resolve(idOrName) {
    const key = String(idOrName || "").trim();
    if (this._byId.has(key)) return this._byId.get(key);
    for (const entry of this._byId.values()) {
      if (entry.name === key) return entry;
    }
    return null;
  }

  get(idOrName) {
    return this._resolve(idOrName);
  }

  has(idOrName) {
    return !!this._resolve(idOrName);
  }

  all() {
    return [...this._byId.values()];
  }

  ids() {
    return [...this._byId.keys()];
  }

  /** Bare-name -> execute map for every id that has an attached executor. */
  handlerMap() {
    const map = {};
    for (const entry of this._byId.values()) {
      if (typeof entry.execute === "function") map[entry.name] = entry.execute;
    }
    return map;
  }

  /** Bare names advertised (offered as callable schemas) on a transport. */
  advertisedNames(transport) {
    return this.all()
      .filter((e) => e.advertise.includes(transport))
      .map((e) => e.name);
  }

  /** Names with an attached executor in this registry instance. */
  executableNames() {
    return this.all().filter((e) => typeof e.execute === "function").map((e) => e.name);
  }
}
