import net from "node:net";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { automationSocketPath, ensureAutomationOperatorToken } from "../functions/paths.js";

const DEFAULT_TIMEOUT_MS = 5000;
const testSupervisors = new Set();
let testCleanupInstalled = false;

export class AutomationOwnerClient {
  constructor({ socketPath = automationSocketPath(), operator = false, token = "", timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    this.socketPath = socketPath; this.operator = operator; this.token = token; this.timeoutMs = timeoutMs;
  }
  request(operation, args = {}) {
    const payload = this.operator
      ? { kind: "operator", token: this.token || ensureAutomationOperatorToken(), operation, args }
      : operation === "health" ? { kind: "health" } : { kind: "agent", token: this.token, args };
    return requestFrame(this.socketPath, payload, this.timeoutMs);
  }
  health() { return this.request("health"); }
  async hasAvailableTools(principal) {
    try {
      let health = null;
      try { health = await this.health(); } catch {}
      if (health?.ready !== true && this.socketPath === automationSocketPath()) {
        health = await ensureAutomationOwner({ timeoutMs: Math.max(1000, this.timeoutMs) });
      }
      if (health?.ready !== true) return false;
      const operator = new AutomationOwnerClient({
        socketPath: this.socketPath, operator: true, token: this.token, timeoutMs: this.timeoutMs,
      });
      return (await operator.request("tools.available", { principal }))?.available === true;
    } catch {
      return false;
    }
  }
}

export async function ensureAutomationOwner({ timeoutMs = 3000 } = {}) {
  const client = new AutomationOwnerClient({ timeoutMs: 300 });
  try { const health = await client.health(); if (health?.ready) return health; } catch {}
  const entry = fileURLToPath(new URL("../functions/automation-supervisor-entry.js", import.meta.url));
  const testOwned = Boolean(process.env.NODE_TEST_CONTEXT);
  const child = spawn(process.execPath, [entry], { detached: !testOwned, stdio: "ignore", windowsHide: true, env: { ...process.env } });
  if (testOwned) {
    testSupervisors.add(child);
    child.once("exit", () => testSupervisors.delete(child));
    if (!testCleanupInstalled) {
      testCleanupInstalled = true;
      process.once("exit", () => {
        for (const supervisor of testSupervisors) {
          try { supervisor.kill("SIGTERM"); } catch {}
        }
      });
    }
  }
  child.unref();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    try { const health = await client.health(); if (health?.ready) return health; } catch {}
  }
  throw Object.assign(new Error("Automation owner did not become ready"), { code: "owner_unavailable" });
}

function requestFrame(socketPath, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let buffer = Buffer.alloc(0), settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(Object.assign(new Error("Automation owner request timed out"), { code: "owner_timeout" })), timeoutMs);
    socket.once("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > 1024 * 1024) return finish(Object.assign(new Error("Automation owner response is too large"), { code: "owner_protocol_error" }));
      const newline = buffer.indexOf(10); if (newline < 0) return;
      try {
        const response = JSON.parse(buffer.subarray(0, newline).toString("utf8"));
        if (!response.ok) return finish(Object.assign(new Error(response.error || "Automation owner request failed"), { code: response.code || "automation_error" }));
        finish(null, response.result);
      } catch (error) { finish(error); }
    });
    socket.once("error", error => finish(error)); socket.once("end", () => { if (!settled) finish(new Error("Automation owner closed without a response")); });
  });
}
