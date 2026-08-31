// @ts-check

function nonNegativeInteger(value) {
  if (value == null || value === "") return null;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null;
}

function positiveInteger(value) {
  const parsed = nonNegativeInteger(value);
  return parsed != null && parsed > 0 ? parsed : null;
}

export class ProviderTurnBudgetExceededError extends Error {
  /**
   * @param {{ providerName: string, maxTurns: number, numTurns: number, result: any }} detail
   */
  constructor({ providerName, maxTurns, numTurns, result }) {
    super(
      `provider turn budget exhausted: ${providerName} reported successful completion ` +
      `after ${numTurns}/${maxTurns} turns`,
    );
    this.name = "ProviderTurnBudgetExceededError";
    this.code = "PROVIDER_TURN_BUDGET_EXCEEDED";
    this.provider = providerName;
    this.maxTurns = maxTurns;
    this.numTurns = numTurns;
    // A validated terminal handoff is authoritative. This error may describe
    // a live interruption, but it must never suppress a handoff that was
    // already durably committed before provider shutdown.
    this.terminalHandoffStopCompatible = true;
    const output = typeof result?.output === "string" ? result.output : "";
    this.stats = {
      ...(result?.stats || {}),
      maxTurns,
      numTurns,
      outputChars: result?.stats?.outputChars ?? output.length,
      turnBudgetExceeded: true,
    };
    this.output = output || null;
    this.stdout = output || null;
    this.partialOutput = output || null;
  }
}

/**
 * Provider adapters normalize native telemetry into this shared close-time
 * accounting boundary. Live-enforced providers stop before returning success;
 * providers whose turn count is known only at close can report an overage, but
 * close-time accounting must not retroactively reject completed work.
 */
export class ProviderTurnBudget {
  /** @param {{ providerName?: string, requestedMaxTurns?: unknown }} [opts] */
  constructor({ providerName = "provider", requestedMaxTurns = null } = {}) {
    this.providerName = String(providerName || "provider");
    this.requestedMaxTurns = positiveInteger(requestedMaxTurns);
  }

  /**
   * Annotate a completed result when normalized evidence proves it crossed the
   * configured maximum. Equality is valid: maxTurns is inclusive.
   * @param {any} result
   */
  finalize(result) {
    const numTurns = nonNegativeInteger(result?.stats?.numTurns);
    const maxTurns = this.requestedMaxTurns
      ?? positiveInteger(result?.stats?.maxTurns);
    if (numTurns == null || maxTurns == null || numTurns <= maxTurns) return result;
    return {
      ...result,
      stats: {
        ...(result?.stats || {}),
        maxTurns,
        numTurns,
        turnBudgetExceeded: true,
        turnBudgetStatus: "completed_overage",
      },
    };
  }
}
