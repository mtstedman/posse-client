// @ts-check

import { resolveAgentRoleContract } from "../functions/agent-role-contracts.js";

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
  }

  async acquireAgent({
    key,
    logicalKey = key,
    role,
    providerName = null,
    reusable = false,
  } = /** @type {any} */ ({})) {
    const agentKey = String(key || "").trim();
    const lineageKey = String(logicalKey || agentKey).trim();
    const normalizedRole = String(role || "").trim().toLowerCase();
    const normalizedProvider = String(providerName || "").trim().toLowerCase();
    if (!agentKey) throw new TypeError("AgentDispatcher.acquireAgent requires a key");
    if (!normalizedRole) throw new TypeError("AgentDispatcher.acquireAgent requires a role");
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
      });
      const mcpGate = await this.gateFactory({
        key: agentKey,
        logicalKey: lineageKey,
        ...roleContract,
      });
      if (!mcpGate || !mcpGate.token) {
        throw new Error("AgentDispatcher gate factory did not return an immutable MCP gate");
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

  async dispatch({ attachment = {}, ...identity } = /** @type {any} */ ({})) {
    const agent = await this.acquireAgent(identity);
    try {
      const lease = agent.attachJob(attachment);
      return Object.freeze({ agent, lease });
    } catch (error) {
      if (identity.reusable !== true) {
        await this.destroyAgent(agent, { reason: "agent_job_attachment_failed" });
      }
      throw error;
    }
  }

  async release({ agent, lease, retain = false, reason = "provider_attempt_complete" } = {}) {
    if (!agent) return { released: false, reason: "missing_agent" };
    let detached = null;
    try {
      detached = agent.detachJob(lease, { reason });
    } catch (error) {
      await this.destroyAgent(agent, { reason: "agent_job_detachment_failed" });
      throw error;
    }
    if (retain === true && agent.reusable === true && !agent.tainted) {
      return { released: true, retained: true, detached };
    }
    const disposed = await this.destroyAgent(agent, { reason: "provider_agent_complete" });
    return { released: true, retained: false, detached, disposed };
  }

  async destroyAgent(agentOrKey, { reason = "agent_disposed" } = {}) {
    const key = typeof agentOrKey === "string" ? agentOrKey : agentOrKey?.key;
    const agent = key ? this.agents.get(key) : agentOrKey;
    if (!agent) return { released: false, reason: "not_found" };
    this.agents.delete(agent.key);
    for (const [logicalKey, mappedKey] of this.agentKeyByLogicalKey.entries()) {
      if (mappedKey === agent.key) this.agentKeyByLogicalKey.delete(logicalKey);
    }
    return await agent.dispose?.({ reason });
  }

  async disposeAll({ reason = "dispatcher_disposed" } = {}) {
    const agents = [...this.agents.values()];
    const results = [];
    for (const agent of agents) {
      results.push(await this.destroyAgent(agent, { reason }));
    }
    return { disposed: agents.length, results };
  }
}
