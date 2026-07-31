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
    providerListResolver = null,
    providerSelector = null,
    providerFactory = null,
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
    if (providerListResolver != null && typeof providerListResolver !== "function") {
      throw new TypeError("AgentDispatcher providerListResolver must be a function");
    }
    if (providerSelector != null && typeof providerSelector !== "function") {
      throw new TypeError("AgentDispatcher providerSelector must be a function");
    }
    if (providerFactory != null && typeof providerFactory !== "function") {
      throw new TypeError("AgentDispatcher providerFactory must be a function");
    }
    this.gateFactory = gateFactory;
    this.agentFactory = agentFactory;
    this.roleContractResolver = roleContractResolver;
    this.providerListResolver = providerListResolver;
    this.providerSelector = providerSelector;
    this.providerFactory = providerFactory;
    this.agents = new Map();
    this.pending = new Map();
    this.agentKeyByLogicalKey = new Map();
    this.closed = false;
    this.reservationTails = new Map();
    this.reservationsByLeaseId = new Map();
    this.reservationsByAgentKey = new Map();
    this.reservationClosers = new Set();
    this.releasedLeases = new WeakSet();
    this.preparationSpecs = new WeakMap();
  }

  providersForRole(role) {
    const normalizedRole = String(role || "").trim().toLowerCase();
    if (!normalizedRole) throw new TypeError("AgentDispatcher.providersForRole requires a role");
    const configured = this.providerListResolver?.(normalizedRole);
    return Object.freeze([
      ...new Set(
        (Array.isArray(configured) ? configured : [])
          .map((provider) => String(provider || "").trim().toLowerCase())
          .filter(Boolean),
      ),
    ]);
  }

  async selectProvider({ role, providerName = null, excludeProviders = [] } = /** @type {any} */ ({})) {
    const normalizedRole = String(role || "").trim().toLowerCase();
    if (!normalizedRole) throw new TypeError("AgentDispatcher.selectProvider requires a role");
    const requested = String(providerName || "").trim().toLowerCase();
    const excluded = new Set(
      (Array.isArray(excludeProviders) ? excludeProviders : [])
        .map((provider) => String(provider || "").trim().toLowerCase())
        .filter(Boolean),
    );
    const configured = this.providersForRole(normalizedRole);
    const eligible = configured.filter((provider) => !excluded.has(provider));
    if (requested && configured.length > 0 && !configured.includes(requested)) {
      throw dispatchError(
        "POSSE_AGENT_PROVIDER_NOT_ALLOWED",
        `Provider ${requested} is not configured for Agent role ${normalizedRole}`,
      );
    }
    if (requested && !excluded.has(requested)) return requested;
    const selected = String(
      await this.providerSelector?.(normalizedRole, {
        eligibleProviders: eligible,
        excludeProviders: [...excluded],
      }) || eligible[0] || "",
    ).trim().toLowerCase();
    if (!selected) {
      throw dispatchError(
        "POSSE_AGENT_PROVIDER_UNAVAILABLE",
        `No Provider is configured for Agent role ${normalizedRole}`,
      );
    }
    if (excluded.has(selected)) {
      throw dispatchError(
        "POSSE_AGENT_PROVIDER_UNAVAILABLE",
        `Agent Provider selector returned excluded Provider ${selected}`,
      );
    }
    return selected;
  }

  async providerFor({ role, providerName = null, excludeProviders = [] } = /** @type {any} */ ({})) {
    const selected = await this.selectProvider({ role, providerName, excludeProviders });
    const provider = this.providerFactory
      ? await this.providerFactory(String(role || "").trim().toLowerCase(), selected)
      : null;
    return Object.freeze({ providerName: selected, provider });
  }

  toolContractFor(identity = {}) {
    const normalizedRole = String(identity?.role || "").trim().toLowerCase();
    const normalizedProvider = String(identity?.providerName || "").trim().toLowerCase();
    return this.roleContractResolver({
      ...identity,
      role: normalizedRole,
      providerName: normalizedProvider,
    });
  }

  listAgents() {
    return [...this.agents.values()].map((agent) => (
      typeof agent?.status === "function"
        ? agent.status()
        : {
            id: agent?.id || null,
            key: agent?.key || null,
            role: agent?.role || null,
            providerName: agent?.providerName || null,
            state: agent?.disposed ? "disposed" : "unknown",
          }
    ));
  }

  getAgentStatus(agentOrKey) {
    const key = typeof agentOrKey === "string" ? agentOrKey : agentOrKey?.key;
    const agent = key ? this.agents.get(key) : null;
    return typeof agent?.status === "function" ? agent.status() : null;
  }

  describeAgent(agentOrKey) {
    const key = typeof agentOrKey === "string" ? agentOrKey : agentOrKey?.key;
    const agent = key ? this.agents.get(key) : null;
    if (!agent) return null;
    const preparation = this.preparationSpecs.get(agent) || {};
    const gateContract = agent.mcpGate?.contractBootConfig || null;
    return Object.freeze({
      ...agent.status(),
      eligibleProviders: this.providersForRole(agent.role),
      provider: {
        name: agent.providerName || null,
        linked: !!agent.provider,
      },
      handoff: {
        requested: agent.handoffRequest != null,
        resolved: agent.status().readiness?.handoff === "ready",
      },
      toolGate: {
        issued: !!agent.mcpGate,
        id: agent.mcpGate?.id || null,
        role: agent.mcpGate?.role || agent.role,
        providerName: agent.mcpGate?.providerName || agent.providerName || null,
        toolAllowlist: gateContract?.toolAllowlist
          ? {
              tools: [...(gateContract.toolAllowlist.tools || [])],
              atlas: [...(gateContract.toolAllowlist.atlas || [])],
            }
          : null,
      },
      requestedPolicy: this.toolContractFor({
        role: agent.role,
        providerName: agent.providerName || preparation.providerName || null,
        agentHandoff: preparation.agentHandoff === true,
        subAgent: preparation.subAgent === true,
        coordinationChild: preparation.coordinationChild === true,
      }),
    });
  }

  createAgent({
    key,
    logicalKey = key,
    role,
    providerName = null,
    reusable = false,
    agentHandoff = false,
    subAgent = false,
    coordinationChild = false,
    coordinationChildPermitId = null,
    remoteToolSurface = null,
    handoffRequest = null,
    handoffFactory = null,
    excludeProviders = [],
  } = /** @type {any} */ ({})) {
    const normalizedRole = String(role || "").trim().toLowerCase();
    const agentKey = String(key || "").trim();
    const lineageKey = String(logicalKey || agentKey).trim();
    const effectiveReusable = coordinationChild === true ? false : reusable === true;
    if (!agentKey) throw new TypeError("AgentDispatcher.createAgent requires a key");
    if (!normalizedRole) throw new TypeError("AgentDispatcher.createAgent requires a role");
    if (handoffFactory != null && typeof handoffFactory !== "function") {
      throw new TypeError("AgentDispatcher handoffFactory must be a function");
    }
    if (this.closed) {
      throw dispatchError("POSSE_AGENT_DISPATCHER_CLOSED", "AgentDispatcher is closed");
    }
    if (!this.gateFactory || !this.agentFactory) {
      throw new TypeError("AgentDispatcher requires gateFactory and agentFactory to mint Agents");
    }
    if (this.agents.has(agentKey)) {
      throw dispatchError(
        coordinationChild === true ? "POSSE_AGENT_CHILD_IDENTITY_REUSED" : "POSSE_AGENT_IDENTITY_REUSED",
        `Agent identity ${agentKey} is already registered`,
      );
    }

    const agent = this.agentFactory({
      id: agentKey,
      key: agentKey,
      role: normalizedRole,
      reusable: effectiveReusable,
      handoffRequest,
    });
    if (!agent || typeof agent.beginPreparation !== "function" || typeof agent.whenReady !== "function") {
      throw new Error("AgentDispatcher agent factory must return an Agent that owns readiness");
    }
    this.agents.set(agentKey, agent);
    this.agentKeyByLogicalKey.set(lineageKey, agentKey);
    const preparation = {
      key: agentKey,
      logicalKey: lineageKey,
      role: normalizedRole,
      providerName,
      agentHandoff: agentHandoff === true,
      subAgent: subAgent === true,
      coordinationChild: coordinationChild === true,
      coordinationChildPermitId,
      remoteToolSurface,
      handoffRequest,
      handoffFactory,
      retainHandoff: false,
      excludeProviders,
    };
    this.preparationSpecs.set(agent, preparation);
    this.#beginAgentPreparation(agent, preparation);
    return agent;
  }

  async rebindAgent(agentOrKey, {
    providerName = null,
    handoffFactory = null,
    excludeProviders = [],
    reason = "provider_rebound",
  } = {}) {
    const key = typeof agentOrKey === "string" ? agentOrKey : agentOrKey?.key;
    const agent = key ? this.agents.get(key) : null;
    if (!agent || (typeof agentOrKey !== "string" && agent !== agentOrKey)) {
      throw dispatchError("POSSE_AGENT_NOT_FOUND", "Cannot rebind an Agent that is not in the dispatch pool");
    }
    const prior = this.preparationSpecs.get(agent);
    if (!prior) {
      throw dispatchError("POSSE_AGENT_PREPARATION_MISSING", "Agent has no dispatcher preparation contract");
    }
    const priorProvider = agent.providerName || null;
    agent.evictProvider({ reason });
    const preparation = {
      ...prior,
      providerName,
      handoffFactory: handoffFactory || prior.handoffFactory || null,
      retainHandoff: !handoffFactory && !prior.handoffFactory,
      excludeProviders: [
        ...new Set([
          ...(Array.isArray(excludeProviders) ? excludeProviders : []),
          ...(providerName ? [] : [priorProvider]),
        ].filter(Boolean)),
      ],
    };
    this.preparationSpecs.set(agent, preparation);
    this.#beginAgentPreparation(agent, preparation);
    return await agent.whenReady();
  }

  async evictProvider(agentOrKey, { reason = "provider_evicted" } = {}) {
    const key = typeof agentOrKey === "string" ? agentOrKey : agentOrKey?.key;
    const agent = key ? this.agents.get(key) : null;
    if (!agent || (typeof agentOrKey !== "string" && agent !== agentOrKey)) {
      return { evicted: false, reason: "not_found" };
    }
    return agent.evictProvider({ reason });
  }

  async dispatchAgent({ agent, attachment = {}, signal = null } = /** @type {any} */ ({})) {
    if (!agent) throw new TypeError("AgentDispatcher.dispatchAgent requires an Agent");
    const registered = this.agents.get(agent.key);
    if (registered !== agent) {
      throw dispatchError("POSSE_AGENT_NOT_FOUND", "Agent is not registered in this dispatch pool");
    }
    const reservation = await this.#reserveDispatchIdentity({
      key: agent.key,
      logicalKey: this.#logicalKeyForAgent(agent),
    }, signal);
    try {
      await agent.whenReady();
      if (signal?.aborted) throw dispatchAbortError(signal);
      const lease = agent.attachJob(attachment);
      reservation.agent = agent;
      reservation.leaseId = lease.id;
      this.reservationsByLeaseId.set(lease.id, reservation);
      this.reservationsByAgentKey.set(agent.key, reservation);
      return Object.freeze({ agent, lease });
    } catch (error) {
      reservation.release();
      throw error;
    }
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
    coordinationChildPermitId = null,
    remoteToolSurface = null,
    handoffRequest = null,
    handoffFactory = null,
    excludeProviders = [],
  } = /** @type {any} */ ({})) {
    const agentKey = String(key || "").trim();
    const lineageKey = String(logicalKey || agentKey).trim();
    const normalizedRole = String(role || "").trim().toLowerCase();
    if (!agentKey) throw new TypeError("AgentDispatcher.acquireAgent requires a key");
    if (!normalizedRole) throw new TypeError("AgentDispatcher.acquireAgent requires a role");
    if (this.closed) {
      throw dispatchError("POSSE_AGENT_DISPATCHER_CLOSED", "AgentDispatcher is closed");
    }
    if (!this.gateFactory || !this.agentFactory) {
      throw new TypeError("AgentDispatcher requires gateFactory and agentFactory to mint agents");
    }

    let existing = this.agents.get(agentKey);
    if (existing?.tainted || existing?.readinessState === "failed") {
      await this.destroyAgent(existing, { reason: "agent_scope_release_failed" });
      existing = null;
    } else if (existing && !existing.disposed) {
      if (coordinationChild === true) {
        throw dispatchError(
          "POSSE_AGENT_CHILD_IDENTITY_REUSED",
          "Citation-child Agent identities are single-use",
        );
      }
      await existing.whenReady();
      existing.mcpGate?.assertCompatible?.({
        role: normalizedRole,
        providerName,
        coordinationChild: coordinationChild === true,
      });
      return existing;
    }

    const previousKey = this.agentKeyByLogicalKey.get(lineageKey);
    if (previousKey && previousKey !== agentKey) {
      await this.destroyAgent(previousKey, { reason: "agent_lineage_replaced" });
    }
    const agent = this.createAgent({
      key: agentKey,
      logicalKey: lineageKey,
      role: normalizedRole,
      providerName,
      reusable,
      agentHandoff,
      subAgent,
      coordinationChild,
      coordinationChildPermitId,
      remoteToolSurface,
      handoffRequest,
      handoffFactory,
      excludeProviders,
    });
    return await agent.whenReady();
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

  #beginAgentPreparation(agent, preparation) {
    const providerPromise = this.providerFor({
      role: preparation.role,
      providerName: preparation.providerName,
      excludeProviders: preparation.excludeProviders,
    });
    const handoffPromise = preparation.retainHandoff === true
      ? undefined
      : providerPromise.then((binding) => (
          preparation.handoffFactory
            ? preparation.handoffFactory({
                agent,
                request: preparation.handoffRequest,
                role: preparation.role,
                providerName: binding.providerName,
                provider: binding.provider,
              })
            : preparation.handoffRequest
        ));
    const mcpGatePromise = providerPromise.then(async (binding) => {
      const roleContract = this.toolContractFor({
        role: preparation.role,
        providerName: binding.providerName,
        agentHandoff: preparation.agentHandoff === true,
        subAgent: preparation.subAgent === true,
        coordinationChild: preparation.coordinationChild === true,
      });
      const gate = await this.gateFactory({
        key: preparation.key,
        logicalKey: preparation.logicalKey,
        ...roleContract,
        ...(preparation.remoteToolSurface && typeof preparation.remoteToolSurface === "object"
          && preparation.coordinationChild === true
          ? {
              remoteToolSurface: preparation.remoteToolSurface,
              coordinationChildPermitId: preparation.coordinationChildPermitId,
            }
          : {}),
      });
      if (this.closed) {
        try { gate?.dispose?.({ reason: "dispatcher_closed_during_gate_mint" }); } catch { /* best effort */ }
        throw dispatchError(
          "POSSE_AGENT_DISPATCHER_CLOSED",
          "AgentDispatcher closed while minting an MCP gate",
        );
      }
      return gate;
    });
    agent.beginPreparation({ providerPromise, handoffPromise, mcpGatePromise });
    const ready = agent.whenReady();
    this.pending.set(agent.key, ready);
    ready.finally(() => {
      if (this.pending.get(agent.key) === ready) this.pending.delete(agent.key);
    }).catch(() => {});
  }

  #logicalKeyForAgent(agent) {
    for (const [logicalKey, agentKey] of this.agentKeyByLogicalKey.entries()) {
      if (agentKey === agent.key) return logicalKey;
    }
    return agent.key;
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

  async destroyAgent(agentOrKey, { reason = "agent_disposed", preparationError = null } = {}) {
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
      this.pending.delete(agent.key);
      this.preparationSpecs.delete(agent);
      for (const [logicalKey, mappedKey] of this.agentKeyByLogicalKey.entries()) {
        if (mappedKey === agent.key) this.agentKeyByLogicalKey.delete(logicalKey);
      }
    }
    return await agent.dispose?.({ reason, preparationError });
  }

  async disposeAll({ reason = "dispatcher_disposed" } = {}) {
    this.closed = true;
    // Wake dispatches queued behind active reusable leases. They re-check the
    // closed state before attachment and fail without touching the live gate.
    for (const release of [...this.reservationClosers]) release();
    this.reservationTails.clear();
    this.reservationsByLeaseId.clear();
    this.reservationsByAgentKey.clear();
    // Readiness sources are external and may never settle. Disposing the Agent
    // cancels its readiness wait immediately; each source remains observed so
    // a gate that resolves after shutdown is still disposed by its preparation
    // observer instead of leaking authority.
    const agents = [...this.agents.values()];
    const results = [];
    const preparationError = dispatchError(
      "POSSE_AGENT_DISPATCHER_CLOSED",
      "AgentDispatcher closed while preparing an Agent",
    );
    for (const agent of agents) {
      results.push(await this.destroyAgent(agent, { reason, preparationError }));
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
