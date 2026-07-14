// @ts-check

import crypto from "node:crypto";

function agentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

/**
 * A provider agent. Its MCP gate is a mandatory immutable dependency; the
 * Dispatcher attaches Job identity while tools resolve live file authority.
 */
export class Agent {
  constructor({ id = null, key, role, providerName, mcpGate, reusable = false } = {}) {
    if (!key) throw new TypeError("Agent requires a dispatcher key");
    if (!role) throw new TypeError("Agent requires a role");
    if (!mcpGate || typeof mcpGate.attachJob !== "function" || !mcpGate.token) {
      throw new TypeError("Agent requires an immutable MCP gate dependency");
    }
    const agentId = String(id || mcpGate.id || crypto.randomUUID());
    if (mcpGate.id && String(mcpGate.id) !== agentId) {
      throw new TypeError("Agent identity must match its MCP gate identity");
    }
    const normalizedRole = String(role).trim().toLowerCase();
    const normalizedProvider = String(providerName || "").trim().toLowerCase();
    mcpGate.assertCompatible?.({ role: normalizedRole, providerName: normalizedProvider });
    Object.defineProperties(this, {
      id: { value: agentId, enumerable: true, configurable: false, writable: false },
      key: { value: String(key), enumerable: true, configurable: false, writable: false },
      role: { value: normalizedRole, enumerable: true, configurable: false, writable: false },
      providerName: { value: normalizedProvider, enumerable: true, configurable: false, writable: false },
      reusable: { value: reusable === true, enumerable: true, configurable: false, writable: false },
    });
    this.disposed = false;
    this.tainted = false;
    this._activeLease = null;
    Object.defineProperty(this, "mcpGate", {
      value: mcpGate,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }

  attachJob(attachment = {}) {
    if (this.disposed) throw agentError("POSSE_AGENT_DISPOSED", "Cannot attach a disposed agent");
    if (this.tainted) {
      throw agentError("POSSE_AGENT_TAINTED", "Cannot bind an agent whose prior Job scope failed to clear");
    }
    if (this._activeLease) {
      throw agentError(
        "POSSE_AGENT_ALREADY_BOUND",
        `Agent ${this.id} is already attached to Job ${this._activeLease.jobId ?? "unknown"}`,
      );
    }
    const lease = Object.freeze({
      id: crypto.randomUUID(),
      jobId: attachment.jobId ?? null,
      workItemId: attachment.workItemId ?? null,
    });
    this.mcpGate.attachJob({
      ...attachment,
      role: this.role,
      providerName: this.providerName,
    });
    this._activeLease = lease;
    return lease;
  }

  detachJob(lease, { reason = "provider_attempt_complete" } = {}) {
    if (!this._activeLease) return { cleared: false, reason: "not_bound" };
    if (!lease || lease.id !== this._activeLease.id) {
      throw agentError("POSSE_AGENT_LEASE_MISMATCH", "Only the active Job lease can release an agent scope");
    }
    try {
      return this.mcpGate.detachJob({ reason });
    } catch (error) {
      this.tainted = true;
      throw error;
    } finally {
      this._activeLease = null;
    }
  }

  dispose({ reason = "agent_disposed" } = {}) {
    if (this.disposed) return { released: false, reason: "already_disposed" };
    let scopeClearFailed = false;
    if (this._activeLease) {
      try {
        this.mcpGate.detachJob({ reason: `${reason}_attachment_clear` });
      } catch {
        scopeClearFailed = true;
        this.tainted = true;
      } finally {
        this._activeLease = null;
      }
    }
    this.disposed = true;
    const result = this.mcpGate.dispose({ reason });
    return scopeClearFailed && result && typeof result === "object"
      ? { ...result, scopeClearFailed: true }
      : result;
  }
}
