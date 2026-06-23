import readline from "readline";

import {
  RUNTIME_STATUS_KEYS,
  clearRuntimeStatus,
  writeRuntimeStatus,
} from "../../queue/functions/runtime-status.js";
import { renderNeuralNetworkBanner } from "../../ui/functions/display/neural-network-banner.js";
import { fit as fitAnsi } from "../../../shared/format/functions/ansi.js";
import { createBootPanel } from "../functions/boot-panel.js";
import { createTerminalOutputIntercept, firstLine } from "../functions/run-session.js";

const STEP_SECTION_MAP = new Map([
  ["repo setup", "scheduler"],
  ["dependencies", "workspace"],
  ["posse update", "workspace"],
  ["startup work tree", "workspace"],
  ["git ready", "workspace"],
  ["worktree cleanup", "workspace"],
  ["lock acquired", "scheduler"],
  ["orphan recovery", "scheduler"],
  ["pre-loop hooks", "scheduler"],
  ["workspace health", "workspace"],
]);

const TERMINAL_BOOT_LANG_STATES = new Set(["done", "skipped", "deferred", "failed"]);

export class RunBootPanelController {
  constructor({
    C,
    log = null,
    getDisplay = () => null,
  } = {}) {
    this.C = C;
    this.log = log;
    this.getDisplay = getDisplay;
    this.abortController = new AbortController();
    this.monitorTimer = null;
    this.monitorDisposed = false;
    this.renderedRows = 0;
    this.lastRenderAt = 0;
    this.steps = new Map();
    this.providerSteps = new Map();
    this.matrixLanguages = new Set();
    this.footerText = "";
    this.enterAction = null;
    this.inputInstalled = false;
    this.inputWasRaw = false;
    this.inputHandler = null;
    this.bannerState = { atlasPercent: 0, scipPercent: 0, onnxPercent: 0 };
    this.lastBannerRefreshAt = 0;
    this.startedAtIso = new Date().toISOString();
    this.statusTimer = null;
    this.statusPending = null;
    this.terminalOutputIntercept = createTerminalOutputIntercept({
      stdout: process.stdout,
      stderr: process.stderr,
    });
    this.panel = createBootPanel({
      C,
      columns: () => this.renderColumns(),
      onChange: (steps) => this.queueStatusMirror(steps),
    });

    try {
      clearRuntimeStatus(RUNTIME_STATUS_KEYS.SHUTDOWN);
      writeRuntimeStatus(RUNTIME_STATUS_KEYS.BOOT, { steps: [], started_at: this.startedAtIso });
    } catch { /* best-effort */ }
    this.refreshBanner();

    this.abortController.signal.addEventListener("abort", () => {
      try {
        for (const [label, step] of this.steps.entries()) {
          if (step.status === "running") {
            this.updateStep(label, {
              status: "failed",
              detail: "aborted",
              showDetail: true,
              force: true,
            });
          }
        }
        this.stop({ final: true });
      } catch { /* observational */ }
    }, { once: true });
  }

  get signal() {
    return this.abortController.signal;
  }

  get bootPanel() {
    return this.panel;
  }

  get bootSteps() {
    return this.steps;
  }

  get terminalLangStates() {
    return TERMINAL_BOOT_LANG_STATES;
  }

  terminalColumns() {
    const columns = Number(process.stdout?.columns);
    if (Number.isFinite(columns) && columns > 1) return Math.max(1, Math.floor(columns));
    return 120;
  }

  renderColumns() {
    return Math.max(1, this.terminalColumns() - 3);
  }

  queueStatusMirror(steps) {
    this.statusPending = steps;
    if (this.statusTimer) return;
    this.statusTimer = setTimeout(() => this.flushStatusMirror(), 500);
    this.statusTimer.unref?.();
  }

  flushStatusMirror() {
    this.statusTimer = null;
    const steps = this.statusPending;
    this.statusPending = null;
    if (!steps) return;
    try {
      writeRuntimeStatus(RUNTIME_STATUS_KEYS.BOOT, {
        steps: steps.slice(0, 30).map((step) => ({
          ...step,
          label: String(step.label || "").slice(0, 120),
          ...(step.detail ? { detail: String(step.detail).slice(0, 200) } : {}),
        })),
        started_at: this.startedAtIso,
      });
    } catch { /* status mirroring is best-effort */ }
  }

  shortText(value, max = 34) {
    const text = String(value || "").replace(/\s+/g, " ").trim();
    if (!text) return "";
    return text.length > max ? `${text.slice(0, Math.max(1, max - 1))}…` : text;
  }

  monitorRows() {
    return this.panel.lines();
  }

  fitMonitorRow(row) {
    return fitAnsi(row, this.renderColumns(), { reset: this.C.reset }).trimEnd();
  }

  render({ final = false, force = false } = {}) {
    if (this.getDisplay() || this.steps.size === 0) return;
    if (this.monitorDisposed && !final) return;
    if (!process.stdout.isTTY) return;
    const now = Date.now();
    if (!final && !force && this.renderedRows > 0 && now - this.lastRenderAt < 90) return;
    this.terminalOutputIntercept.install();
    const rows = this.monitorRows().map((row) => this.fitMonitorRow(row));
    const rowsToWrite = Math.max(rows.length, this.renderedRows || 1);
    let buf = "";
    if (this.renderedRows > 0) {
      const up = this.renderedRows - 1;
      if (up > 0) buf += `\x1b[${up}A`;
      buf += "\r";
    }
    for (let i = 0; i < rowsToWrite; i += 1) {
      if (i > 0) buf += "\n";
      buf += `${rows[i] || ""}\x1b[K`;
    }
    if (final) buf += "\n";
    this.terminalOutputIntercept.writeStdout(buf);
    this.renderedRows = final ? 0 : rows.length;
    this.lastRenderAt = now;
  }

  clearRenderedPanel() {
    if (!process.stdout?.isTTY || this.renderedRows <= 0) return;
    const up = Math.max(0, this.renderedRows - 1);
    const buf = `${up > 0 ? `\x1b[${up}A` : ""}\r\x1b[J`;
    this.terminalOutputIntercept.writeStdout(buf);
    this.renderedRows = 0;
    this.lastRenderAt = Date.now();
  }

  ensureMonitor() {
    if (this.getDisplay() || this.monitorTimer || this.monitorDisposed) return;
    this.monitorTimer = setInterval(() => this.render({ force: true }), 120);
    this.monitorTimer.unref?.();
  }

  updateStep(label, patch = {}) {
    const { force = false, ...stepPatch } = patch;
    const previous = this.steps.get(label) || { status: "running", detail: "", percent: null };
    const wasPending = this.steps.get(label)?.status === "pending";
    if ((!this.steps.has(label) || wasPending) && (stepPatch.status === "running" || stepPatch.status == null)) {
      this.log?.info?.("run", "Boot step started", { label, section: stepPatch.section || STEP_SECTION_MAP.get(label) || "internal" });
    }
    this.steps.set(label, { ...previous, ...stepPatch, updatedAt: Date.now() });
    const section = stepPatch.section || STEP_SECTION_MAP.get(label);
    if (section && section !== "internal") {
      const resolvedStatus = stepPatch.status || previous.status || "running";
      const terminalDetail = (stepPatch.showDetail || resolvedStatus === "failed") && resolvedStatus !== "running";
      const panelDetail = terminalDetail
        ? this.shortText(stepPatch.detail || "", 40)
        : resolvedStatus === "running"
          ? this.shortText(stepPatch.detail ?? previous.detail ?? "", 28)
          : "";
      this.panel.updateStep(label, {
        status: stepPatch.status || previous.status || "running",
        detail: panelDetail,
        percent: stepPatch.percent ?? null,
        section,
      });
    }
    if (this.getDisplay()) return;
    this.ensureMonitor();
    this.render({
      force: force || this.renderedRows === 0 || patch.status === "ok" || patch.status === "failed",
    });
  }

  normalizeProviderStepName(value) {
    return String(value || "").trim().toLowerCase();
  }

  updateProviderStep(label, patch = {}) {
    const rawName = this.normalizeProviderStepName(label);
    if (!rawName || rawName === "usage") return;
    const fromImageCapability = /-images?$/.test(rawName);
    const providerName = rawName.replace(/-images?$/, "");
    if (!providerName) return;
    if (fromImageCapability && this.providerSteps.has(providerName)) return;
    const { force = false, ...stepPatch } = patch;
    const previous = this.providerSteps.get(providerName) || { status: "running", detail: "" };
    const next = {
      ...previous,
      ...stepPatch,
      section: "providers",
      detail: this.shortText(stepPatch.detail ?? previous.detail ?? "", 40),
    };
    this.providerSteps.set(providerName, next);
    const showPanelDetail = next.status === "ok"
      || next.status === "failed"
      || next.status === "skipped"
      || next.status === "deferred";
    this.panel.updateStep(providerName, { ...next, detail: showPanelDetail ? next.detail : "" });
    if (this.getDisplay()) return;
    this.ensureMonitor();
    this.render({
      force: force || next.status === "ok" || next.status === "failed" || next.status === "deferred",
    });
  }

  providerStatusFromHealth(status) {
    const value = String(status || "").trim().toLowerCase();
    if (value === "available") return "ok";
    if (value === "unavailable") return "failed";
    return "deferred";
  }

  hasProviderStep(label) {
    return this.providerSteps.has(this.normalizeProviderStepName(label));
  }

  finalizeRunningProviderSteps(status, detail = "") {
    for (const [providerName, step] of this.providerSteps.entries()) {
      if (step.status !== "running") continue;
      this.updateProviderStep(providerName, {
        status,
        detail,
        force: true,
      });
    }
  }

  addMatrixLanguage(language) {
    const lang = String(language || "").trim().toLowerCase();
    if (lang) this.matrixLanguages.add(lang);
  }

  updateLang(language, side, patch = {}) {
    const bootLanguageKey = String(language || "").trim().toLowerCase();
    if (!bootLanguageKey || (side !== "atlas" && side !== "scip")) return;
    if (this.matrixLanguages.size > 0 && !this.matrixLanguages.has(bootLanguageKey)) return;
    this.panel.updateLang(bootLanguageKey, side, patch);
    this.refreshBanner();
    if (this.getDisplay()) return;
    this.ensureMonitor();
    this.render({ force: patch.state === "done" || patch.state === "failed" });
  }

  installInput() {
    if (this.inputInstalled) return;
    if (!process.stdin?.isTTY || !process.stdout?.isTTY) return;
    if (typeof process.stdin.setRawMode !== "function") return;
    try { readline.emitKeypressEvents(process.stdin); } catch { return; }
    this.inputWasRaw = !!process.stdin.isRaw;
    this.inputHandler = (str, key = {}) => {
      if (key?.ctrl && key?.name === "c") {
        process.emit("SIGINT");
        return;
      }
      if (key?.name === "return" || key?.name === "enter" || str === "\r" || str === "\n") {
        try { this.enterAction?.(); } catch (err) {
          this.log?.warn?.("run", "Boot footer action failed", { error: firstLine(err?.message || err) });
        }
      }
    };
    try { process.stdin.setRawMode(true); } catch { return; }
    try { process.stdin.resume?.(); } catch { /* best effort */ }
    process.stdin.on("keypress", this.inputHandler);
    this.inputInstalled = true;
  }

  releaseInput() {
    if (!this.inputInstalled) {
      this.enterAction = null;
      return;
    }
    if (this.inputHandler) process.stdin.off("keypress", this.inputHandler);
    try { process.stdin.setRawMode(this.inputWasRaw); } catch { /* terminal may already be closed */ }
    try { process.stdin.pause?.(); } catch { /* best effort */ }
    this.inputInstalled = false;
    this.inputHandler = null;
    this.enterAction = null;
  }

  setEnterAction(handler = null) {
    this.enterAction = typeof handler === "function" ? handler : null;
    if (this.enterAction) this.installInput();
    else this.releaseInput();
  }

  updateFooter(text) {
    const next = String(text || "").trim();
    if (next === this.footerText) return;
    this.footerText = next;
    this.panel.setFooter(next);
    if (this.getDisplay()) return;
    this.ensureMonitor();
    this.render({ force: true });
  }

  canPromptForBackground() {
    return !!process.stdin?.isTTY
      && !!process.stdout?.isTTY
      && typeof process.stdin?.setRawMode === "function";
  }

  aggregatePanelProgress() {
    let atlasSum = 0, atlasCounted = 0, atlasTotal = 0;
    let scipSum = 0, scipCounted = 0, scipTotal = 0;
    for (const [, entry] of this.panel.languageEntries()) {
      const sides = [["atlas", entry?.atlas], ["scip", entry?.scip]];
      for (const [name, side] of sides) {
        if (!side) continue;
        const isAtlas = name === "atlas";
        if (isAtlas) atlasTotal += 1; else scipTotal += 1;
        if (side.state === "skipped" || side.state === "failed" || side.state === "deferred") continue;
        const percent = side.state === "done"
          ? 100
          : Number.isFinite(Number(side.percent)) ? Number(side.percent) : 0;
        if (isAtlas) { atlasSum += percent; atlasCounted += 1; }
        else { scipSum += percent; scipCounted += 1; }
      }
    }
    this.bannerState.atlasPercent = atlasCounted > 0
      ? atlasSum / atlasCounted
      : (atlasTotal > 0 ? 100 : 0);
    this.bannerState.scipPercent = scipCounted > 0
      ? scipSum / scipCounted
      : (scipTotal > 0 ? 100 : 0);
  }

  refreshBanner() {
    const now = Date.now();
    if (now - this.lastBannerRefreshAt < 100) return;
    this.lastBannerRefreshAt = now;
    this.aggregatePanelProgress();
    this.panel.setFooter(renderNeuralNetworkBanner(this.bannerState));
  }

  seedChecklist() {
    for (const [stepLabel, stepSection] of STEP_SECTION_MAP) {
      if (!this.steps.has(stepLabel)) {
        this.updateStep(stepLabel, { status: "pending", section: stepSection });
      }
    }
  }

  preserveRenderedPanel() {
    if (!process.stdout?.isTTY || this.renderedRows <= 0) return;
    this.terminalOutputIntercept.writeStdout("\n");
    this.renderedRows = 0;
    this.lastRenderAt = Date.now();
  }

  stop({ final = false, clear = false, preserve = false } = {}) {
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    if (final) {
      if (this.monitorDisposed) {
        this.terminalOutputIntercept.release();
        return;
      }
      this.releaseInput();
      if (preserve) this.preserveRenderedPanel();
      else if (clear) this.clearRenderedPanel();
      else this.render({ final: true, force: true });
      this.monitorDisposed = true;
      this.terminalOutputIntercept.release();
    }
  }

  async runWithTerminalPassthrough(fn) {
    const shouldResumeTimer = !!this.monitorTimer;
    if (this.monitorTimer) {
      clearInterval(this.monitorTimer);
      this.monitorTimer = null;
    }
    this.releaseInput();

    const passthroughStartsWithPanel = this.renderedRows > 0 && !!process.stdout?.isTTY;
    let passthroughWrote = false;
    const breakBeforePassthroughOutput = (writeNewline) => {
      if (!passthroughStartsWithPanel || passthroughWrote) return;
      passthroughWrote = true;
      try {
        const up = Math.max(0, this.renderedRows - 1);
        writeNewline(`\r${up > 0 ? `\x1b[${up}A` : ""}\x1b[J`);
      } catch { /* observational */ }
      this.renderedRows = 0;
    };

    if (passthroughStartsWithPanel && this.terminalOutputIntercept.bufferedCount > 0) {
      breakBeforePassthroughOutput(this.terminalOutputIntercept.writeStdout);
    }
    this.terminalOutputIntercept.release();

    const restoreWrites = [];
    const installLazyBreak = (stream) => {
      if (!passthroughStartsWithPanel || !stream?.isTTY || typeof stream.write !== "function") return;
      const originalWrite = stream.write;
      stream.write = function passthroughWrite(...args) {
        breakBeforePassthroughOutput((text) => originalWrite.call(stream, text));
        return originalWrite.apply(stream, args);
      };
      restoreWrites.push(() => { stream.write = originalWrite; });
    };

    installLazyBreak(process.stdout);
    installLazyBreak(process.stderr);

    if (!passthroughStartsWithPanel && this.renderedRows > 0) {
      this.terminalOutputIntercept.writeStdout("\n");
      this.renderedRows = 0;
    }
    try {
      return await fn();
    } finally {
      for (let i = restoreWrites.length - 1; i >= 0; i -= 1) {
        try { restoreWrites[i](); } catch { /* observational */ }
      }
      if (!this.getDisplay() && !this.monitorDisposed) {
        this.lastRenderAt = 0;
        if (shouldResumeTimer) this.ensureMonitor();
        this.render({ force: true });
      }
    }
  }

  handleSchedulerBootEvent(event = {}) {
    if (!event.label) return;
    this.updateStep(event.label, {
      section: event.section,
      status: event.status,
      detail: event.detail || "",
      force: true,
    });
  }
}
