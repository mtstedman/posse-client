// @ts-check

import { resolveAgentRoleContract } from "../functions/agent-role-contracts.js";

function dispatchError(code, message, { name = "Error", reason = null } = {}) {
  const error = /** @type {Error & { code: string, reason?: unknown }} */ (new Error(message));
  error.name = name;
  error.code = code;
  if (reason != null) error.reason = reason;
  return error;
}

function dispatchAbortError(signal) {
  const reason = signal?.reason;
  return dispatchError(
    "POSSE_AGENT_DISPATCH_ABORTED",
    reason instanceof Error ? reason.message : "Agent dispatch was aborted",
    { name: "AbortError", reason },
  );
}

function waitForReservationTurn(previous, signal = null) {
  if (!signal) return previous;
  if (signal.aborted) return Promise.reject(dispatchAbortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener?.("abort", onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, dispatchAbortError(signal));
    signal.addEventListener?.("abort", onAbort, { once: true });
    previous.then(
      () => finish(resolve),
      (error) => finish(reject, error),
    );
  });
}

/**
 * Central Agent dispatch owner. A role gate is minted before Agent construction,
 * then the Dispatcher attaches the Agent to the requesting Job. File authority
 * is not part of either transaction; tools resolve it from persisted ownership.
 */
export class AgentDispatcher {
  constructor({
    gateFactory = null,
    agentFactory = null,
    roleContractResolver = resolveAgentRoleContract,
  } = /** @type {any} */ ({})) {
    if (gateFactory != null && typeof gateFactory !== "function") {
      throw new TypeError("AgentDispatcher gateFactory must be a function");
    }
    if (agentFactory != null && typeof agentFactory !== "function") {
      throw new TypeError("AgentDispatcher agentFactory must be a function");
    }
    if (typeof roleContractResolver !== "function") {
      throw new TypeError("AgentDispatcher roleContractResolver must be a function");
    }
    this.gateFactory = gateFactory;
    this.agentFactory = agentFactory;
    this.roleContractResolver = roleContractResolver;
    this.agents = new Map();
    this.pending = new Map();
    this.agentKeyByLogicalKey = new Map();
    this.closed = false;
    this.reservationTails = new Map();
    this.reservationsByLeaseId = new Map();
    this.reservationsByAgentKey = new Map();
    this.reservationClosers = new Set();
    this.releasedLeases = new WeakSet();
  }

  async acquireAgent({
    key,
    logicalKey = key,
    role,
    providerName = null,
    reusable = false,
    agentHandoff = false,
    subAgent = false,
    coordinationChild = false,
  } = /** @type {any} */ ({})) {
    const agentKey = String(key || "").trim();
    const lineageKey = String(logicalKey || agentKey).trim();
    const normalizedRole = String(role || "").trim().toLowerCase();
    const normalizedProvider = String(providerName || "").trim().toLowerCase();
    if (!agentKey) throw new TypeError("AgentDispatcher.acquireAgent requires a key");
    if (!normalizedRole) throw new TypeError("AgentDispatcher.acquireAgent requires a role");
    if (this.closed) {
      throw dispatchError("POSSE_AGENT_DISPATCHER_CLOSED", "AgentDispatcher is closed");
    }
    if (!this.gateFactory || !this.agentFactory) {
      throw new TypeError("AgentDispatcher requires gateFactory and agentFactory to mint agents");
    }

    const existing = this.agents.get(agentKey);
    if (existing?.tainted) {
      await this.destroyAgent(existing, { reason: "agent_scope_release_failed" });
    } else if (existing && !existing.disposed) {
      existing.mcpGate.assertCompatible?.({ role: normalizedRole, providerName: normalizedProvider });
      return existing;
    }
    if (this.pending.has(agentKey)) return await this.pending.get(agentKey);

    const creation = (async () => {
      const previousKey = this.agentKeyByLogicalKey.get(lineageKey);
      if (previousKey && previousKey !== agentKey) {
        await this.destroyAgent(previousKey, { reason: "agent_lineage_replaced" });
      }

      const roleContract = this.roleContractResolver({
        role: normalizedRole,
        providerName: normalizedProvider,
        agentHandoff: agentHandoff === true,
        subAgent: subAgent === true,
        coordinationChild: coordinationChild === true,
      });
      const mcpGate = await this.gateFactory({
        key: agentKey,
        logicalKey: lineageKey,
        ...roleContract,
      });
      if (!mcpGate || !mcpGate.token) {
        throw new Error("AgentDispatcher gate factory did not return an immutable MCP gate");
      }
      if (this.closed) {
        try { mcpGate.dispose?.({ reason: "dispatcher_closed_during_gate_mint" }); } catch { /* best effort */ }
        throw dispatchError(
          "POSSE_AGENT_DISPATCHER_CLOSED",
          "AgentDispatcher closed while minting an MCP gate",
        );
      }
      if (mcpGate.id && String(mcpGate.id) !== agentKey) {
        try { mcpGate.dispose?.({ reason: "agent_gate_identity_mismatch" }); } catch { /* best effort */ }
        throw new Error("AgentDispatcher gate identity must match the dispatcher agent key");
      }
      let agent = null;
      try {
        agent = this.agentFactory({
          id: agentKey,
          key: agentKey,
          role: normalizedRole,
          providerName: normalizedProvider,
          mcpGate,
          reusable,
        });
      } catch (error) {
        try { mcpGate.dispose?.({ reason: "agent_constructor_failed" }); } catch { /* best effort */ }
        throw error;
      }
      if (!agent || agent.mcpGate !== mcpGate) {
        try { mcpGate.dispose?.({ reason: "agent_factory_invalid" }); } catch { /* best effort */ }
        throw new Error("AgentDispatcher agent factory must attach the minted MCP gate");
      }
      this.agents.set(agentKey, agent);
      this.agentKeyByLogicalKey.set(lineageKey, agentKey);
      return agent;
    })();
    this.pending.set(agentKey, creation);
    try {
      return await creation;
    } finally {
      this.pending.delete(agentKey);
    }
  }

  async dispatch({ attachment = {}, signal = null, ...identity } = /** @type {any} */ ({})) {
    const reservation = await this.#reserveDispatchIdentity(identity, signal);
    let agent = null;
    try {
      if (this.closed) {
        throw dispatchError(
          "POSSE_AGENT_DISPATCHER_CLOSED",
          "AgentDispatcher closed before Job attachment",
        );
      }
      agent = await this.acquireAgent(identity);
      if (signal?.aborted) throw dispatchAbortError(signal);
      if (agent.disposed) {
        throw dispatchError("POSSE_AGENT_DISPOSED", "AgentDispatcher selected a disposed Agent");
      }
      const lease = agent.attachJob(attachment);
      reservation.agent = agent;
      reservation.leaseId = lease.id;
      this.reservationsByLeaseId.set(lease.id, reservation);
      this.reservationsByAgentKey.set(agent.key, reservation);
      return Object.freeze({ agent, lease });
    } catch (error) {
      reservation.release();
      // Any attachment failure makes this gate unsafe to retain. In
      // particular, an expired or failed-to-rotate reusable gate must not
      // poison its session lane and fail every later dispatch. An already-bound
      // error is different: another caller owns the live lease, so destroying
      // that Agent would revoke authority underneath active provider work.
      if (agent && error?.code !== "POSSE_AGENT_ALREADY_BOUND" && !this.closed) {
        await this.destroyAgent(agent, { reason: "agent_job_attachment_failed" });
      }
      throw error;
    }
  }

  /** @param {Record<string, any>} [options] */
  async release({ agent, lease, retain = false, reason = "provider_attempt_complete" } = {}) {
    if (!agent) return { released: false, reason: "missing_agent" };
    const registered = this.agents.get(agent.key);
    if (registered && registered !== agent) {
      return { released: false, retained: false, reason: "agent_identity_mismatch" };
    }
    if (!registered) {
      return { released: false, retained: false, reason: agent.disposed ? "agent_disposed" : "agent_not_registered" };
    }
    const leaseId = String(lease?.id || "");
    if (lease && typeof lease === "object" && this.releasedLeases.has(lease)) {
      return { released: false, retained: false, reason: "lease_already_released" };
    }
    const agentReservation = this.reservationsByAgentKey.get(agent.key) || null;
    const leaseReservation = leaseId ? this.reservationsByLeaseId.get(leaseId) || null : null;
    if (leaseReservation && leaseReservation.agent !== agent) {
      // Never let a lease copied from another Agent release that Agent's
      // reservation. The passed Agent still owns a suspect lifecycle and is
      // torn down through its own reservation below.
      const error = dispatchError("POSSE_AGENT_LEASE_MISMATCH", "Job lease belongs to a different Agent");
      await this.destroyAgent(agent, { reason: "agent_job_lease_mismatch" });
      throw error;
    }
    const reservation = leaseReservation || agentReservation;
    this.#forgetReservation(agent.key, reservation);
    try {
      let detached = null;
      try {
        detached = agent.detachJob(lease, { reason });
        if (leaseId && reservation?.leaseId === leaseId && reservation?.agent === agent) {
          this.releasedLeases.add(lease);
        }
      } catch (error) {
        await this.destroyAgent(agent, { reason: "agent_job_detachment_failed" });
        throw error;
      }
      if (retain === true && agent.reusable === true && !agent.tainted && !agent.disposed && !this.closed) {
        return { released: true, retained: true, detached };
      }
      const disposed = await this.destroyAgent(agent, { reason: "provider_agent_complete" });
      return { released: true, retained: false, detached, disposed };
    } finally {
      reservation?.release();
    }
  }

  async #reserveDispatchIdentity(identity = {}, signal = null) {
    const agentKey = String(identity?.key || "").trim();
    const logicalKey = String(identity?.logicalKey || agentKey).trim();
    const keys = [...new Set([`agent:${agentKey}`, `logical:${logicalKey}`])].sort();
    const reservations = [];
    try {
      for (const key of keys) {
        if (this.closed) throw Object.assign(new Error("AgentDispatcher is closed"), { code: "POSSE_AGENT_DISPATCHER_CLOSED" });
        if (signal?.aborted) throw dispatchAbortError(signal);
        reservations.push(await this.#reserveKey(key, signal));
        if (this.closed) throw Object.assign(new Error("AgentDispatcher is closed"), { code: "POSSE_AGENT_DISPATCHER_CLOSED" });
        if (signal?.aborted) throw dispatchAbortError(signal);
      }
    } catch (error) {
      for (const reservation of reservations.reverse()) reservation.release();
      throw error;
    }
    let released = false;
    return {
      release: () => {
        if (released) return;
        released = true;
        for (const reservation of reservations.reverse()) reservation.release();
      },
    };
  }

  async #reserveKey(key, signal = null) {
    const previous = this.reservationTails.get(key) || Promise.resolve();
    let resolveCurrent = null;
    const current = new Promise((resolve) => { resolveCurrent = resolve; });
    this.reservationTails.set(key, current);
    let released = false;
    const reservation = {
      release: () => {
        if (released) return;
        released = true;
        this.reservationClosers.delete(reservation.release);
        resolveCurrent();
        if (this.reservationTails.get(key) === current) this.reservationTails.delete(key);
      },
    };
    this.reservationClosers.add(reservation.release);
    try {
      await waitForReservationTurn(previous, signal);
      return reservation;
    } catch (error) {
      // A canceled FIFO node must remain in the chain until its predecessor
      // releases. Resolving it immediately would let a later waiter overlap
      // the still-active predecessor. Once its turn arrives it hands off
      // automatically without requiring the canceled caller to linger.
      previous.then(reservation.release, reservation.release);
      throw error;
    }
  }

  async destroyAgent(agentOrKey, { reason = "agent_disposed" } = {}) {
    const key = typeof agentOrKey === "string" ? agentOrKey : agentOrKey?.key;
    const registered = key ? this.agents.get(key) : null;
    if (typeof agentOrKey !== "string" && registered && registered !== agentOrKey) {
      return { released: false, reason: "agent_identity_mismatch" };
    }
    const agent = typeof agentOrKey === "string" ? registered : agentOrKey;
    if (!agent) return { released: false, reason: "not_found" };
    const ownsRegistration = this.agents.get(agent.key) === agent;
    const reservation = ownsRegistration ? this.reservationsByAgentKey.get(agent.key) || null : null;
    this.#forgetReservation(agent.key, reservation);
    reservation?.release();
    if (ownsRegistration) {
      this.agents.delete(agent.key);
      for (const [logicalKey, mappedKey] of this.agentKeyByLogicalKey.entries()) {
        if (mappedKey === agent.key) this.agentKeyByLogicalKey.delete(logicalKey);
      }
    }
    return await agent.dispose?.({ reason });
  }

  async disposeAll({ reason = "dispatcher_disposed" } = {}) {
    this.closed = true;
    // Wake dispatches queued behind active reusable leases. They re-check the
    // closed state before attachment and fail without touching the live gate.
    for (const release of [...this.reservationClosers]) release();
    this.reservationTails.clear();
    this.reservationsByLeaseId.clear();
    this.reservationsByAgentKey.clear();
    // Gate creation is asynchronous. Wait for every in-flight creation to
    // observe `closed` and dispose its newly minted gate before sweeping the
    // completed registry.
    while (this.pending.size > 0) {
      await Promise.allSettled([...this.pending.values()]);
    }
    const agents = [...this.agents.values()];
    const results = [];
    for (const agent of agents) {
      results.push(await this.destroyAgent(agent, { reason }));
    }
    return { disposed: agents.length, results };
  }

  #forgetReservation(agentKey, reservation) {
    if (!reservation) return;
    if (this.reservationsByAgentKey.get(agentKey) === reservation) {
      this.reservationsByAgentKey.delete(agentKey);
    }
    for (const [leaseId, candidate] of this.reservationsByLeaseId.entries()) {
      if (candidate === reservation) this.reservationsByLeaseId.delete(leaseId);
    }
  }

}
