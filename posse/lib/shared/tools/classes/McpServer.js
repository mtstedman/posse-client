import { spawn } from "child_process";

export class McpServer {
  constructor({
    config,
    spawnImpl = spawn,
  } = {}) {
    this.config = config;
    this._spawn = spawnImpl;
    this._proc = null;
    this._startedAt = null;
    this._lastExit = null;
  }

  start({ stdio = "pipe" } = {}) {
    if (this._proc && this._proc.exitCode == null && !this._proc.killed) return this._proc;
    const spec = this.config?.toSpawnArgs ? this.config.toSpawnArgs() : this.config;
    if (!spec?.ready) {
      throw new Error(`MCP server is not ready: ${spec?.reason || "unknown"}`);
    }
    this._proc = this._spawn(spec.command, spec.args || [], {
      cwd: spec.cwd || process.cwd(),
      env: spec.env || process.env,
      stdio,
      windowsHide: true,
    });
    this._startedAt = Date.now();
    this._proc.on("exit", (code, signal) => {
      this._lastExit = {
        at: Date.now(),
        code,
        signal,
      };
      this._proc = null;
    });
    return this._proc;
  }

  stop({ force = false } = {}) {
    const proc = this._proc;
    if (!proc || proc.exitCode != null || proc.killed) return false;
    if (process.platform === "win32") {
      try {
        const args = ["/pid", String(proc.pid), "/T"];
        if (force) args.push("/F");
        const killer = this._spawn("taskkill", args, {
          stdio: "ignore",
          windowsHide: true,
        });
        killer.unref?.();
        return true;
      } catch {
        // Fall through to process kill.
      }
    }
    try {
      proc.kill(force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch {
      return false;
    }
  }

  restart(opts = {}) {
    this.stop({ force: false });
    return this.start(opts);
  }

  health() {
    const proc = this._proc;
    return {
      running: !!proc && proc.exitCode == null && !proc.killed,
      pid: proc?.pid || null,
      startedAt: this._startedAt,
      uptimeMs: this._startedAt ? Math.max(0, Date.now() - this._startedAt) : 0,
      lastExit: this._lastExit,
      ready: !!this.config?.toSpawnArgs ? !!this.config.toSpawnArgs()?.ready : true,
    };
  }
}
