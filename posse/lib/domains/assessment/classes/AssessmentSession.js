import { assessResult } from "../../worker/functions/helpers/assessment-pipeline.js";

export class AssessmentSession {
  constructor({
    job = null,
    output = "",
    scope = null,
    providerClient = null,
    worker = null,
    options = {},
  } = {}) {
    this.job = job || null;
    this.output = output || "";
    this.scope = scope || null;
    this.providerClient = providerClient || null;
    this.worker = worker || null;
    this.options = options || {};
    this._history = [];
    this._last = null;
  }

  async assess() {
    const result = await assessResult(this.job, this.output, {
      ...this.options,
      ...(this.providerClient ? { trackedCall: this.providerClient.trackedCall?.bind(this.providerClient) } : {}),
    });
    this._last = result;
    this._history.push({
      at: new Date().toISOString(),
      verdict: result?.verdict || result?.status || null,
      result,
    });
    return result;
  }

  applyVerdict() {
    return this._last;
  }

  retryCount() {
    return this._history.length;
  }

  history() {
    return [...this._history];
  }
}

