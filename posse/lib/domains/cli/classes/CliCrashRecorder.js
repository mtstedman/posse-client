// @ts-check
import fs from "node:fs";
import path from "node:path";
import { getRuntimeLogDir } from "../../runtime/functions/base-paths.js";
import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";
import { nativeLoadFailureRemedy } from "../../../shared/platform/functions/native-runtime-floor.js";

function isBrokenPipe(error) {
  return ["EPIPE", "ERR_STREAM_DESTROYED", "ERR_STREAM_WRITE_AFTER_END"].includes(error?.code);
}

// Bootstrap-safe: no database, provider, settings, or native-addon imports.
export class CliCrashRecorder {
  constructor({ logDir = getRuntimeLogDir, stderr = process.stderr, exit = (code) => process.exit(code) } = {}) {
    this.logDir = logDir;
    this.stderr = stderr;
    this.exit = exit;
    this.brokenPipeNoted = false;
  }

  append(line) {
    try {
      const dir = this.logDir();
      fs.mkdirSync(dir, { recursive: true });
      fs.appendFileSync(path.join(dir, "fatal-crashes.log"), line);
    } catch { /* best effort during a crash */ }
  }

  noteBrokenPipeOnce(kind) {
    if (this.brokenPipeNoted) return;
    this.brokenPipeNoted = true;
    this.append(`\n[${new Date().toISOString()}] NOTE broken-pipe swallowed (${kind}) — output consumer detached; run continues\n`);
  }

  record(kind, error) {
    if (isBrokenPipe(error)) { this.noteBrokenPipeOnce(kind); return; }
    const stack = error?.stack || String(error);
    const code = error?.code ? ` code=${error.code}` : "";
    const remedyText = nativeLoadFailureRemedy(`${error?.code || ""} ${error?.message || ""} ${stack}`);
    const remedy = remedyText ? `\nRemedy: ${remedyText}\n` : "";
    const line = scrubSecretText(`\n[${new Date().toISOString()}] FATAL ${kind}${code}\n${stack}\n${remedy}`);
    try { this.stderr.write(`\x1b[?25h\x1b[0m${line}`); } catch { /* best effort */ }
    this.append(line);
    this.exit(1);
  }

  install() {
    for (const stream of [process.stdout, process.stderr]) {
      try {
        stream.on("error", (error) => {
          if (isBrokenPipe(error) || error?.code === "EIO") this.noteBrokenPipeOnce("stream");
          else this.record("stream", error);
        });
      } catch { /* best effort */ }
    }
    process.on("uncaughtException", (error) => this.record("uncaughtException", error));
    process.on("unhandledRejection", (reason) => this.record("unhandledRejection", reason));
  }
}
