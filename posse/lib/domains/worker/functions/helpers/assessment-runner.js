import { spawn, spawnSync } from "child_process";

export function killShellCommandProcessTree(child, { platform = process.platform, spawnSyncImpl = spawnSync } = {}) {
  if (platform === "win32" && child?.pid) {
    try {
      const result = spawnSyncImpl("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      if (!result || result.status === 0) return true;
    } catch { /* fall through */ }
  }
  try { return !!child?.kill?.(); } catch { return false; }
}

export function runShellCommandAsync(command, { cwd, timeoutMs = 120000 } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, { cwd, shell: true, windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = ""; let settled = false;
    const timer = setTimeout(() => {
      if (settled) return; settled = true; killShellCommandProcessTree(child);
      const error = new Error(`Command timed out after ${timeoutMs}ms`);
      error.code = "ETIMEDOUT"; error.stdout = stdout; error.stderr = stderr; reject(error);
    }, Math.max(1000, Number(timeoutMs) || 120000));
    child.stdout?.on("data", (chunk) => { stdout += String(chunk || ""); });
    child.stderr?.on("data", (chunk) => { stderr += String(chunk || ""); });
    child.on("error", (error) => { if (settled) return; settled = true; clearTimeout(timer); error.stdout = stdout; error.stderr = stderr; reject(error); });
    child.on("close", (code) => {
      if (settled) return; settled = true; clearTimeout(timer);
      if (code === 0) return resolve({ stdout, stderr, code });
      const error = new Error(`Command exited with code ${code}${stderr.trim() ? `: ${stderr.trim().split("\n")[0]}` : ""}`);
      error.code = code; error.stdout = stdout; error.stderr = stderr; reject(error);
    });
  });
}
