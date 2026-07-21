// @ts-check

/**
 * Shared async harness for environment installers. It owns the observable
 * progress surface while language installers own the actual platform steps.
 */
export class EnvironmentInstallHarness {
  #onProgress;
  #onEvent;

  /**
   * @param {{
   *   onProgress?: ((message: string) => void) | null,
   *   onEvent?: ((event: Record<string, any>) => void) | null,
   * }} [input]
   */
  constructor({ onProgress = null, onEvent = null } = {}) {
    this.#onProgress = typeof onProgress === "function" ? onProgress : null;
    this.#onEvent = typeof onEvent === "function" ? onEvent : null;
  }

  /**
   * @param {Record<string, any>} event
   */
  emit(event) {
    const normalized = /** @type {Record<string, any>} */ ({
      kind: "environment.install.progress",
      ...event,
    });
    if (!normalized.message) normalized.message = formatStepMessage(normalized);
    if (this.#onEvent) {
      try { this.#onEvent(normalized); } catch { /* observational */ }
    }
    if (this.#onProgress && normalized.message) {
      try { this.#onProgress(String(normalized.message)); } catch { /* observational */ }
    }
  }

  /**
   * @template T
   * @param {{
   *   language: string,
   *   step: string,
   *   stepIndex: number,
   *   totalSteps: number,
   *   platform?: string,
   *   action: () => Promise<T> | T,
   * }} input
   * @returns {Promise<T | { ok: false, status: "failed", language: string, message: string }>}
   */
  async runStep({ language, step, stepIndex, totalSteps, platform = process.platform, action }) {
    this.emit({
      kind: "environment.install.step.started",
      language,
      step,
      stepIndex,
      totalSteps,
      platform,
      message: `${language} ${stepIndex}/${totalSteps}: ${step}`,
    });
    try {
      const result = await action();
      if (result && typeof result === "object" && /** @type {any} */ (result).ok === false) {
        this.emit({
          kind: "environment.install.step.failed",
          language,
          step,
          stepIndex,
          totalSteps,
          platform,
          message: `${language} ${stepIndex}/${totalSteps} failed: ${/** @type {any} */ (result).message || step}`,
        });
      } else {
        this.emit({
          kind: "environment.install.step.completed",
          language,
          step,
          stepIndex,
          totalSteps,
          platform,
          message: `${language} ${stepIndex}/${totalSteps} completed: ${step}`,
        });
      }
      return result;
    } catch (err) {
      const message = err?.message || String(err);
      this.emit({
        kind: "environment.install.step.failed",
        language,
        step,
        stepIndex,
        totalSteps,
        platform,
        message: `${language} ${stepIndex}/${totalSteps} failed: ${message}`,
      });
      return { language, ok: false, status: "failed", message };
    }
  }
}

function formatStepMessage(event = {}) {
  const language = String(event.language || "environment");
  const step = String(event.step || event.kind || "install");
  const index = Number(event.stepIndex || 0);
  const total = Number(event.totalSteps || 0);
  return index > 0 && total > 0
    ? `${language} ${index}/${total}: ${step}`
    : `${language}: ${step}`;
}
