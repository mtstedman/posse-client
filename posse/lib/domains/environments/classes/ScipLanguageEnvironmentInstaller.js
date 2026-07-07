// @ts-check

import path from "path";
import {
  DEFAULT_POSSE_ROOT,
  DEFAULT_SCIP_COMMAND_TIMEOUT_MS,
  commandPath,
  expectedCommandPath,
  fileExists,
  findCommandPath,
  normalizeCommandTimeoutMs,
} from "../functions/scip-install-runtime.js";

export class ScipLanguageEnvironmentInstaller {
  /**
   * @param {{
   *   posseRoot?: string | null,
   *   force?: boolean,
   *   dryRun?: boolean,
   *   timeoutMs?: number | string | boolean | null,
   *   harness?: import("./EnvironmentInstallHarness.js").EnvironmentInstallHarness,
   *   platform?: NodeJS.Platform,
   *   arch?: string,
   * }} [input]
   */
  constructor({
    posseRoot = DEFAULT_POSSE_ROOT,
    force = false,
    dryRun = false,
    timeoutMs = DEFAULT_SCIP_COMMAND_TIMEOUT_MS,
    harness = undefined,
    platform = process.platform,
    arch = process.arch,
  } = {}) {
    this.posseRoot = path.resolve(String(posseRoot || DEFAULT_POSSE_ROOT));
    this.force = force === true;
    this.dryRun = dryRun === true;
    this.timeoutMs = normalizeCommandTimeoutMs(timeoutMs, DEFAULT_SCIP_COMMAND_TIMEOUT_MS);
    this.harness = harness;
    this.platform = platform;
    this.arch = arch;
  }

  get language() {
    return "unknown";
  }

  get installKey() {
    return `scip:${this.language}`;
  }

  installPlan() {
    return ["install"];
  }

  async install() {
    return this.failed("installer not implemented");
  }

  status() {
    return this.failed("status not implemented");
  }

  result(status, message) {
    return {
      language: this.language,
      ok: status !== "failed",
      status,
      message,
    };
  }

  ok(status, message) {
    return this.result(status, message);
  }

  failed(message) {
    return this.result("failed", message);
  }

  /**
   * @template T
   * @param {number} stepIndex
   * @param {string} step
   * @param {() => Promise<T> | T} action
   */
  async runStep(stepIndex, step, action) {
    if (!this.harness) return await action();
    return await this.harness.runStep({
      language: this.language,
      step,
      stepIndex,
      totalSteps: this.installPlan().length,
      platform: this.platform,
      action,
    });
  }

  commandPath(segments, command) {
    return commandPath(this.posseRoot, segments, command, this.platform);
  }

  expectedCommandPath(segments, command) {
    return expectedCommandPath(this.posseRoot, segments, command, this.platform);
  }

  findCommandPath(segments, command) {
    return findCommandPath(this.posseRoot, segments, command, this.platform);
  }

  statusForInstalledCommand(segments, command) {
    const found = this.findCommandPath(segments, command);
    if (found && fileExists(found)) return this.ok("ok", "installed");
    return this.failed(`missing ${this.expectedCommandPath(segments, command)}`);
  }
}
