export class LocalModelProgress {
  constructor(stream, { quiet = false, intervalMs = 100 } = {}) {
    this.stream = stream;
    this.quiet = quiet;
    this.intervalMs = intervalMs;
    this.frame = 0;
    this.label = "Preparing local model";
    this.lastLine = "";
    this.tokens = 0;
  }
  start() {
    this.stop();
    this.active = true;
    this.started = Date.now();
    if (this.quiet) return;
    if (this.stream.isTTY) {
      this.stream.write("\x1b[?25l");
      this.timer = setInterval(() => this.render(), this.intervalMs);
      this.timer.unref?.();
    }
    this.render();
  }
  update(event = {}) {
    if (event.kind === "ml.generation.delta") {
      this.tokens += 1;
      this.label = `Generating text (${this.tokens} updates)`;
      // Non-terminal logs report stage transitions, not every text delta.
      if (!this.stream.isTTY && this.tokens > 1) return;
    } else {
      this.label = String(event.stage || "Working");
      if (Number.isInteger(event.step) && event.totalSteps > 0) this.label += ` ${event.step}/${event.totalSteps}`;
      if (event.totalBytes > 0) this.label += ` ${Math.min(100, 100 * event.downloadedBytes / event.totalBytes).toFixed(1)}%`;
      if (event.file) this.label += ` ${event.file}`;
    }
    this.render();
  }
  render() {
    if (this.quiet) return;
    const label = this.label.replace(/[\u0000-\u001f\u007f-\u009f]/g, " ");
    if (this.stream.isTTY) {
      const seconds = Math.floor((Date.now() - this.started) / 1000);
      const line = `${["|", "/", "-", "\\"][this.frame++ % 4]} ${label} · ${seconds}s`;
      this.stream.write(`\r\x1b[2K${line.slice(0, Math.max(20, (this.stream.columns || 100) - 1))}`);
    } else if (label !== this.lastLine) {
      this.stream.write(`${label}\n`);
      this.lastLine = label;
    }
  }
  stop() {
    clearInterval(this.timer);
    if (this.active && !this.quiet && this.stream.isTTY) this.stream.write("\r\x1b[2K\x1b[?25h");
    this.active = false;
  }
}
