// @ts-check

import crypto from "node:crypto";

function agentError(code, message, cause = null) {
  const error = /** @type {Error & { code: string, cause?: unknown }} */ (new Error(message));
  error.code = code;
  if (cause != null) error.cause = cause;
  return error;
}

function normalizedProviderBinding(value = null) {
  if (!value || typeof value !== "object") {
    throw agentError(
      "POSSE_AGENT_PROVIDER_BINDING_REQUIRED",
      "Agent preparation requires a Provider binding",
    );
  }
  const providerName = String(value.providerName || value.name || "").trim().toLowerCase();
  if (!providerName) {
    throw agentError(
      "POSSE_AGENT_PROVIDER_BINDING_REQUIRED",
      "Agent Provider binding requires a provider name",
    );
  }
  return Object.freeze({
    providerName,
    provider: value.provider || value.instance || null,
  });
}

function preparationFailure(results) {
  const rejected = results.find((result) => result.status === "rejected");
  return rejected?.status === "rejected" ? rejected.reason : null;
}

/**
 * A logical Agent. The Agent owns its readiness state; the Dispatcher only
 * creates it, supplies preparation promises, and keeps it in the pool.
 *
 * Provider bindings and MCP gates are replaceable. The handoff request belongs
 * to the Agent lifetime and survives Provider eviction.
 */
export class Agent {
  /** @type {string} */ id;
  /** @type {string} */ key;
  /** @type {string} */ role;
  /** @type {boolean} */ reusable;
  /** @type {any} */ handoffRequest;
  /** @type {string} */ providerName;
  /** @type {any} */ provider;
  /** @type {any} */ mcpGate;
  /** @type {any} */ handoff;
  /** @type {boolean} */ disposed;
  /** @type {string} */ readinessState;

  constructor({
    id = null,
    key,
    role,
    providerName = null,
    provider = null,
    mcpGate = null,
    handoffRequest = null,
    handoff = null,
    reusable = false,
  } = /** @type {any} */ ({})) {
    if (!key) throw new TypeError("Agent requires a dispatcher key");
    if (!role) throw new TypeError("Agent requires a role");

    const agentId = String(id || mcpGate?.id || crypto.randomUUID());
    const normalizedRole = String(role).trim().toLowerCase();
    Object.defineProperties(this, {
      id: { value: agentId, enumerable: true, configurable: false, writable: false },
      key: { value: String(key), enumerable: true, configurable: false, writable: false },
      role: { value: normalizedRole, enumerable: true, configurable: false, writable: false },
      reusable: { value: reusable === true, enumerable: true, configurable: false, writable: false },
      handoffRequest: { value: handoffRequest, enumerable: false, configurable: false, writable: false },
      providerName: {
        get: () => this._providerBinding?.providerName || "",
        enumerable: true,
        configurable: false,
      },
      provider: {
        get: () => this._providerBinding?.provider || null,
        enumerable: false,
        configurable: false,
      },
      mcpGate: {
        get: () => this._mcpGate,
        enumerable: false,
        configurable: false,
      },
      handoff: {
        get: () => this._handoff,
        enumerable: false,
        configurable: false,
      },
      disposed: {
        get: () => this._state === "disposed",
        enumerable: true,
        configurable: false,
      },
      readinessState: {
        get: () => this._state,
        enumerable: true,
        configurable: false,
      },
    });

    this.tainted = false;
    this._state = "preparing";
    this._providerBinding = null;
    this._mcpGate = null;
    this._handoff = handoff;
    this._activeLease = null;
    this._preparationEpoch = 0;
    this._preparationError = null;
    this._componentState = {
      provider: "pending",
      handoff: handoff == null ? "pending" : "ready",
      mcpGate: "pending",
    };
    /** @type {Promise<Agent>} */
    this._readyPromise = Promise.resolve(this);
    /** @type {((error: Error) => void) | null} */
    this._cancelPreparation = null;

    // Backward-compatible direct construction remains useful in focused tests,
    // but production dispatch constructs the visible Agent first and calls
    // beginPreparation() with the three readiness promises.
    if (mcpGate) {
      if (mcpGate.id && String(mcpGate.id) !== agentId) {
        throw new TypeError("Agent identity must match its MCP gate identity");
      }
      const binding = normalizedProviderBinding({ providerName, provider });
      mcpGate.assertCompatible?.({ role: normalizedRole, providerName: binding.providerName });
      this._providerBinding = binding;
      this._mcpGate = mcpGate;
      this._state = "ready";
      this._componentState = { provider: "ready", handoff: "ready", mcpGate: "ready" };
    }
  }

  beginPreparation({
    providerPromise,
    handoffPromise,
    mcpGatePromise,
  } = /** @type {any} */ ({})) {
    if (this.disposed) {
      throw agentError("POSSE_AGENT_DISPOSED", "Cannot prepare a disposed Agent");
    }
    if (this._activeLease) {
      throw agentError("POSSE_AGENT_ALREADY_BOUND", "Cannot prepare an Agent while it holds a lease");
    }
    if (!providerPromise || !mcpGatePromise) {
      throw new TypeError("Agent preparation requires Provider and MCP gate promises");
    }

    this._cancelActivePreparation(agentError(
      "POSSE_AGENT_PREPARATION_STALE",
      "Agent preparation was superseded",
    ));
    const epoch = ++this._preparationEpoch;
    const retainedHandoff = this._handoff;
    const providerReady = Promise.resolve(providerPromise);
    const handoffReady = handoffPromise === undefined
      ? Promise.resolve(retainedHandoff)
      : Promise.resolve(handoffPromise);
    const gateReady = Promise.resolve(mcpGatePromise);

    this._state = "preparing";
    this._preparationError = null;
    this._providerBinding = null;
    this._mcpGate = null;
    this._componentState = {
      provider: "pending",
      handoff: handoffPromise === undefined && retainedHandoff != null ? "ready" : "pending",
      mcpGate: "pending",
    };

    const observe = (promise, component, applyValue = null, discardValue = null) => promise.then((value) => {
      if (this._preparationEpoch === epoch && !this.disposed) {
        applyValue?.(value);
        this._componentState[component] = "ready";
      } else {
        discardValue?.(value);
      }
      return value;
    }).catch((error) => {
        if (this._preparationEpoch === epoch && !this.disposed) {
          this._componentState[component] = "failed";
        }
        throw error;
      });

    const settled = Promise.allSettled([
      observe(providerReady, "provider", (value) => {
        this._providerBinding = normalizedProviderBinding(value);
      }),
      observe(handoffReady, "handoff", (value) => {
        this._handoff = value;
      }),
      observe(gateReady, "mcpGate", (value) => {
        this._mcpGate = value;
      }, (value) => {
        try { value?.dispose?.({ reason: "stale_agent_preparation" }); } catch { /* best effort */ }
      }),
    ]).then((results) => {
      if (this._preparationEpoch === epoch) this._cancelPreparation = null;
      const gateResult = results[2];
      if (this._preparationEpoch !== epoch || this.disposed) {
        throw agentError("POSSE_AGENT_PREPARATION_STALE", "Agent preparation was superseded");
      }

      const failure = preparationFailure(results);
      if (failure) {
        if (gateResult.status === "fulfilled") {
          try { gateResult.value?.dispose?.({ reason: "agent_preparation_failed" }); } catch { /* best effort */ }
        }
        this._mcpGate = null;
        this._state = "failed";
        this._preparationError = failure;
        if (failure?.code === "POSSE_AGENT_DISPATCHER_CLOSED"
          || failure?.code === "POSSE_AGENT_DISPATCH_ABORTED") {
          throw failure;
        }
        throw agentError(
          "POSSE_AGENT_PREPARATION_FAILED",
          `Agent preparation failed: ${failure?.message || String(failure)}`,
          failure,
        );
      }

      const providerResult = results[0];
      const handoffResult = results[1];
      if (
        providerResult.status !== "fulfilled"
        || handoffResult.status !== "fulfilled"
        || gateResult.status !== "fulfilled"
      ) {
        throw agentError(
          "POSSE_AGENT_PREPARATION_FAILED",
          "Agent preparation failed without a rejected component",
        );
      }
      const nextGate = gateResult.value;
      try {
        const binding = normalizedProviderBinding(providerResult.value);
        const nextHandoff = handoffResult.value;
        if (!nextGate || !nextGate.token) {
          throw agentError(
            "POSSE_AGENT_MCP_GATE_REQUIRED",
            "Agent preparation did not resolve an immutable MCP gate",
          );
        }
        if (nextGate.id && String(nextGate.id) !== this.id) {
          throw agentError(
            "POSSE_AGENT_MCP_GATE_IDENTITY_MISMATCH",
            "Agent identity must match its MCP gate identity",
          );
        }
        nextGate.assertCompatible?.({
          role: this.role,
          providerName: binding.providerName,
        });

        this._providerBinding = binding;
        this._mcpGate = nextGate;
        this._handoff = nextHandoff;
        this._componentState = { provider: "ready", handoff: "ready", mcpGate: "ready" };
        this._state = "ready";
        return this;
      } catch (error) {
        try { nextGate?.dispose?.({ reason: "agent_preparation_invalid" }); } catch { /* best effort */ }
        this._mcpGate = null;
        this._state = "failed";
        this._preparationError = error;
        throw error;
      }
    });
    /** @type {((error: Error) => void) | null} */
    let rejectCancellation = null;
    const canceled = new Promise((_, reject) => {
      rejectCancellation = reject;
    });
    this._cancelPreparation = (error) => rejectCancellation?.(error);
    this._readyPromise = Promise.race([settled, canceled]);
    // The pool can poll status without awaiting. Observe rejection here so a
    // failed preparation does not become an unhandled rejection.
    this._readyPromise.catch(() => {});
    return this;
  }

  _cancelActivePreparation(error) {
    const cancel = this._cancelPreparation;
    this._cancelPreparation = null;
    cancel?.(error);
  }

  whenReady() {
    if (this._state === "ready" || this._state === "leased") return Promise.resolve(this);
    if (this._state === "failed") {
      return Promise.reject(agentError(
        "POSSE_AGENT_PREPARATION_FAILED",
        `Agent preparation failed: ${this._preparationError?.message || String(this._preparationError || "unknown")}`,
        this._preparationError,
      ));
    }
    if (this.disposed) {
      return Promise.reject(agentError("POSSE_AGENT_DISPOSED", "Agent has been disposed"));
    }
    return this._readyPromise;
  }

  status() {
    return Object.freeze({
      id: this.id,
      key: this.key,
      role: this.role,
      state: this._state,
      providerName: this.providerName || null,
      reusable: this.reusable,
      tainted: this.tainted,
      lease: this._activeLease
        ? {
            id: this._activeLease.id,
            jobId: this._activeLease.jobId,
            workItemId: this._activeLease.workItemId,
          }
        : null,
      readiness: { ...this._componentState },
      error: this._preparationError
        ? {
            code: this._preparationError.code || null,
            message: this._preparationError.message || String(this._preparationError),
          }
        : null,
    });
  }

  attachJob(attachment = {}) {
    if (this.disposed) throw agentError("POSSE_AGENT_DISPOSED", "Cannot attach a disposed Agent");
    if (this.tainted) {
      throw agentError("POSSE_AGENT_TAINTED", "Cannot bind an Agent whose prior Job scope failed to clear");
    }
    if (this._state !== "ready") {
      throw agentError(
        "POSSE_AGENT_NOT_READY",
        `Agent ${this.id} cannot accept a lease while ${this._state}`,
      );
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
    this._mcpGate.attachJob({
      ...attachment,
      role: this.role,
      providerName: this.providerName,
    });
    this._activeLease = lease;
    this._state = "leased";
    return lease;
  }

  detachJob(lease, { reason = "provider_attempt_complete" } = {}) {
    if (!this._activeLease) return { cleared: false, reason: "not_bound" };
    if (!lease || lease.id !== this._activeLease.id) {
      throw agentError("POSSE_AGENT_LEASE_MISMATCH", "Only the active Job lease can release an Agent scope");
    }
    try {
      return this._mcpGate.detachJob({ reason });
    } catch (error) {
      this.tainted = true;
      this._state = "failed";
      this._preparationError = error;
      throw error;
    } finally {
      this._activeLease = null;
      if (!this.tainted && !this.disposed) this._state = "ready";
    }
  }

  evictProvider({ reason = "provider_evicted" } = {}) {
    if (this.disposed) return { evicted: false, reason: "disposed" };
    if (this._activeLease) {
      throw agentError(
        "POSSE_AGENT_ALREADY_BOUND",
        "Cannot evict an Agent Provider while its lease is active",
      );
    }
    const priorProviderName = this.providerName || null;
    const gate = this._mcpGate;
    this._preparationEpoch += 1;
    this._providerBinding = null;
    this._mcpGate = null;
    this._state = "preparing";
    this._preparationError = null;
    this._componentState = {
      provider: "pending",
      handoff: this._handoff == null ? "pending" : "ready",
      mcpGate: "pending",
    };
    let gateResult = null;
    try {
      gateResult = gate?.dispose?.({ reason }) || null;
    } catch (error) {
      gateResult = { released: false, error };
    }
    return {
      evicted: true,
      providerName: priorProviderName,
      handoffRetained: this._handoff != null,
      gate: gateResult,
    };
  }

  dispose({ reason = "agent_disposed", preparationError = null } = {}) {
    if (this.disposed) return { released: false, reason: "already_disposed" };
    let scopeClearFailed = false;
    this._preparationEpoch += 1;
    this._cancelActivePreparation(preparationError instanceof Error
      ? preparationError
      : agentError("POSSE_AGENT_DISPOSED", "Agent has been disposed"));
    if (this._activeLease) {
      try {
        this._mcpGate?.detachJob?.({ reason: `${reason}_attachment_clear` });
      } catch {
        scopeClearFailed = true;
        this.tainted = true;
      } finally {
        this._activeLease = null;
      }
    }
    const gate = this._mcpGate;
    this._providerBinding = null;
    this._mcpGate = null;
    this._state = "disposed";
    const result = gate?.dispose?.({ reason }) || { released: false, reason: "no_gate" };
    return scopeClearFailed && result && typeof result === "object"
      ? { ...result, scopeClearFailed: true }
      : result;
  }
}
