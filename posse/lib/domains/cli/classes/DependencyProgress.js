import { fit, stripAnsi } from "../../../shared/format/functions/ansi.js";

const FRAMES = ["·", "✢", "✺", "✢"];
const FRAME_MS = 150;
const LOG_INTERVAL_MS = 15_000;

// One live row for automatic dependency work. Redirected output gets bounded
// snapshots instead of terminal escapes or every package-manager message.
export class DependencyProgress {
  constructor({ stream = process.stdout, log = console.log, title = "Dependency updates", nowMs = () => Date.now(), silent = false } = {}) {
    this.stream = stream;
    this.log = log;
    this.title = title;
    this.nowMs = nowMs;
    this.silent = silent;
    this.live = Boolean(stream?.isTTY);
    this.timer = null;
    this.active = false;
    this.message = "checking dependencies";
    this.percent = null;
    this.startedAt = 0;
    this.lastLoggedAt = 0;
  }

  start(message = "checking dependencies") {
    this.stop();
    this.active = true;
    this.startedAt = this.nowMs();
    this.lastLoggedAt = this.startedAt;
    this.update(message);
    if (this.silent) return;
    this.render(true);
    this.timer = setInterval(() => this.render(), this.live ? FRAME_MS : LOG_INTERVAL_MS);
    this.timer.unref?.();
  }

  update(event = {}) {
    const value = typeof event === "string" ? { message: event } : event;
    const text = stripAnsi(value.message || [value.language, value.step].filter(Boolean).join(" ")).replace(/\s+/gu, " ").trim();
    if (text) this.message = text;
    const total = Number(value.total ?? value.totalSteps);
    const current = Number(value.current ?? (value.stepIndex == null ? NaN
      : Number(value.stepIndex) - (String(value.kind).endsWith(".started") ? 1 : 0)));
    const percent = value.percent == null ? (total > 0 && Number.isFinite(current) ? current / total * 100 : NaN) : Number(value.percent);
    this.percent = Number.isFinite(percent) ? Math.max(0, Math.min(100, percent)) : null;
  }

  render(force = false) {
    if (!this.active || this.silent) return;
    const elapsed = Math.max(0, this.nowMs() - this.startedAt);
    const seconds = Math.floor(elapsed / 1000);
    const frame = FRAMES[Math.floor(elapsed / FRAME_MS) % FRAMES.length];
    const filled = this.percent == null ? 0 : Math.round(this.percent / 10);
    const bar = this.percent == null ? "" : `[${"#".repeat(filled)}${"-".repeat(10 - filled)}] ${Math.floor(this.percent)}% `;
    const line = `  ${this.live ? frame : "…"} ${this.title} · ${seconds}s · ${bar}${this.message}`;
    if (this.live) {
      this.stream.write(`\r\x1b[2K${fit(line, Math.max(1, (Number(this.stream.columns) || 100) - 1)).trimEnd()}`);
    } else if (force || this.nowMs() - this.lastLoggedAt >= LOG_INTERVAL_MS) {
      this.log(line);
      this.lastLoggedAt = this.nowMs();
    }
  }

  finish(message = "ready", status = "ok") {
    const elapsed = this.active ? Math.max(0, Math.floor((this.nowMs() - this.startedAt) / 1000)) : 0;
    this.stop();
    if (!this.silent) this.log(`  ${status === "ok" ? "✓" : "!"} ${this.title}: ${message} (${elapsed}s)`);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.active && this.live && !this.silent) this.stream.write("\r\x1b[2K");
    this.active = false;
  }
}
