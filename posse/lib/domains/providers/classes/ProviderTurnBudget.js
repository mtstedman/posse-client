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
    // A terminal handoff receipt makes provider shutdown errors expected, but
    // it must not convert a completed over-budget call back into success.
    this.terminalHandoffStopCompatible = false;
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
 * One provider-neutral turn-budget policy. Provider adapters normalize their
 * native telemetry into the shared result stats contract; this manager alone
 * decides whether a reported success is admissible.
 */
export class ProviderTurnBudget {
  /** @param {{ providerName?: string, requestedMaxTurns?: unknown }} [opts] */
  constructor({ providerName = "provider", requestedMaxTurns = null } = {}) {
    this.providerName = String(providerName || "provider");
    this.requestedMaxTurns = positiveInteger(requestedMaxTurns);
  }

  /**
   * Reject a successful result only when normalized evidence proves it crossed
   * the configured maximum. Equality is valid: maxTurns is inclusive.
   * @param {any} result
   */
  finalize(result) {
    const numTurns = nonNegativeInteger(result?.stats?.numTurns);
    const maxTurns = this.requestedMaxTurns
      ?? positiveInteger(result?.stats?.maxTurns);
    if (numTurns == null || maxTurns == null || numTurns <= maxTurns) return result;
    throw new ProviderTurnBudgetExceededError({
      providerName: this.providerName,
      maxTurns,
      numTurns,
      result,
    });
  }
}
