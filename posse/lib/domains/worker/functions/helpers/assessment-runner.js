import { spawn, spawnSync } from "child_process";

export function killShellCommandProcessTree(child, {
  platform = process.platform,
  spawnSyncImpl = spawnSync,
  force = false,
} = {}) {
  if (platform === "win32" && child?.pid) {
    try {
      const result = spawnSyncImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      if (!result || result.status === 0) return true;
    } catch { /* fall through */ }
  }
  if (platform !== "win32" && child?.pid) {
    try {
      process.kill(-child.pid, force ? "SIGKILL" : "SIGTERM");
      return true;
    } catch { /* fall through */ }
  }
  try { return !!child?.kill?.(force ? "SIGKILL" : "SIGTERM"); } catch { return false; }
}

export function runShellCommandAsync(command, {
  cwd,
  timeoutMs = 120000,
  idleTimeoutMs = null,
} = {}) {
  return new Promise((resolve, reject) => {
    const wallLimit = Math.max(1000, Number(timeoutMs) || 120000);
    const idleLimit = Number(idleTimeoutMs) > 0
      ? Math.min(wallLimit, Math.max(1000, Number(idleTimeoutMs)))
      : null;
    const child = spawn(command, {
      cwd,
      detached: process.platform !== "win32",
      shell: true,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = ""; let stderr = ""; let settled = false;
    let idleTimer = null;
    let forceTimer = null;
    const clearTimers = () => {
      clearTimeout(timer);
      if (idleTimer) clearTimeout(idleTimer);
      if (forceTimer) clearTimeout(forceTimer);
    };
    const terminate = (kind) => {
      if (settled) return;
      settled = true;
      clearTimers();
      killShellCommandProcessTree(child);
      forceTimer = setTimeout(() => killShellCommandProcessTree(child, { force: true }), 250);
      forceTimer.unref?.();
      const limit = kind === "idle" ? idleLimit : wallLimit;
      const error = new Error(`Command ${kind === "idle" ? "produced no output" : "timed out"} after ${limit}ms`);
      error.code = kind === "idle" ? "EIDLETIMEOUT" : "ETIMEDOUT";
      error.timeout_kind = kind;
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    };
    const armIdle = () => {
      if (!idleLimit || settled) return;
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => terminate("idle"), idleLimit);
      idleTimer.unref?.();
    };
    const timer = setTimeout(() => terminate("wall"), wallLimit);
    armIdle();
    child.stdout?.on("data", (chunk) => { stdout += String(chunk || ""); armIdle(); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk || ""); armIdle(); });
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimers();
      error.stdout = stdout;
      error.stderr = stderr;
      reject(error);
    });
    child.on("close", (code) => {
      if (settled) {
        killShellCommandProcessTree(child, { force: true });
        if (forceTimer) clearTimeout(forceTimer);
        return;
      }
      settled = true;
      clearTimers();
      if (code === 0) return resolve({ stdout, stderr, code });
      const error = new Error(`Command exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : ""}`);
      error.code = code; error.stdout = stdout; error.stderr = stderr; reject(error);
    });
  });
}
