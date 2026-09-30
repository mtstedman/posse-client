import fs from "node:fs";
import net from "node:net";
import { spawn } from "node:child_process";
import { AUTOMATION_SUPERVISOR_ENTRY, automationDataDir, automationSocketPath, ensureAutomationOperatorToken } from "../functions/paths.js";
import { automationBuildIdentity, automationOwnerDecision, automationOwnerEnv } from "../functions/owner-identity.js";

import { AUTOMATION_MAX_RESPONSE_BYTES, AUTOMATION_OWNER_LAUNCH, AUTOMATION_SUPERVISOR_AD_HOC_ARG } from "../../../catalog/custom-tools.js";

const DEFAULT_TIMEOUT_MS = 5000;
const OWNER_STOP_TIMEOUT_MS = 3000;
const testSupervisors = new Set();
let testCleanupInstalled = false;
let liveReplacementAttempted = false;
let pendingEnsure = null;
const warnedReasons = new Set();
const KEEP_REASONS = Object.freeze({
  service_managed: "it is service-managed; run `posse automation service install` to restart it on this build",
  legacy_service_owner: "the automation service is installed and may be running an older build; restart or re-install it with `posse automation service install`",
  not_ad_hoc: "it was not started by a Posse client",
  owner_busy: "it has automation runs in progress; it will be replaced once idle",
  replacement_already_attempted: "this process already replaced the owner once",
  owner_stop_failed: "it did not stop when asked",
});

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
      if (this.socketPath === automationSocketPath()) {
        // Also for a ready owner: it may be running another build.
        health = await ensureAutomationOwner({ timeoutMs: Math.max(1000, this.timeoutMs), health });
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

// Returns a ready per-user owner, starting one when none is ready and
// replacing a ready ad-hoc owner that runs different code (see
// automationOwnerDecision). Concurrent calls in one process share one attempt.
export function ensureAutomationOwner(options = {}) {
  if (!pendingEnsure) pendingEnsure = ensureOwner(options).finally(() => { pendingEnsure = null; });
  return pendingEnsure;
}

async function ensureOwner({ timeoutMs = 3000, health: observed = undefined, warn = defaultWarn } = {}) {
  const client = new AutomationOwnerClient({ timeoutMs: 300 });
  let health = observed;
  if (health === undefined) { try { health = await client.health(); } catch { health = null; } }
  if (health?.ready === true) {
    const build = await automationBuildIdentity();
    const entry = health.build?.entry;
    const decision = automationOwnerDecision(health, build, {
      entryExists: typeof entry === "string" && entry ? fs.existsSync(entry) : null,
      liveReplacementAttempted,
      serviceInstalled: !health.build || typeof health.build !== "object" || health.launch === AUTOMATION_OWNER_LAUNCH.SERVICE
        ? await automationServiceInstalled()
        : null,
    });
    if (decision.action === "use") return health;
    if (decision.action === "keep") { warnOnce(warn, decision.reason, health, build); return health; }
    if (decision.consumesReplacement) liveReplacementAttempted = true;
    if (!await stopAutomationOwner(health)) {
      let current = null;
      try { current = await client.health(); } catch {}
      if (current?.ready === true) { warnOnce(warn, "owner_stop_failed", current, build); return current; }
    }
  }
  spawnAdHocSupervisor();
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    try { const health = await client.health(); if (health?.ready) return health; } catch {}
  }
  throw Object.assign(new Error("Automation owner did not become ready"), { code: "owner_unavailable" });
}

// Whether a Posse startup service definition is installed for this user
// (AutomationServiceManager's notion of "installed"). Imported lazily: the
// manager depends on this module.
async function automationServiceInstalled() {
  try {
    const { AutomationServiceManager } = await import("./AutomationServiceManager.js");
    return fs.existsSync(new AutomationServiceManager().definition().path);
  } catch {
    return false;
  }
}

function spawnAdHocSupervisor() {
  const dataDir = automationDataDir();
  fs.mkdirSync(dataDir, { recursive: true, mode: 0o700 });
  const testOwned = Boolean(process.env.NODE_TEST_CONTEXT);
  const child = spawn(process.execPath, [AUTOMATION_SUPERVISOR_ENTRY, AUTOMATION_SUPERVISOR_AD_HOC_ARG], {
    cwd: dataDir,
    detached: !testOwned,
    stdio: "ignore",
    windowsHide: true,
    env: automationOwnerEnv(process.env, { dataDir }),
  });
  child.once("error", () => {});
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
}

// Stops the owner described by a health response and waits (bounded) for the
// owner process to exit, which happens after it released the dispatcher
// lease. The supervisor is signalled first so it does not respawn the owner;
// it forwards SIGTERM to the owner. Windows cannot forward a signal, so both
// processes are terminated there.
export async function stopAutomationOwner(health, { timeoutMs = OWNER_STOP_TIMEOUT_MS, platform = process.platform } = {}) {
  const ownerPid = foreignPid(health?.pid), supervisorPid = foreignPid(health?.supervisor_pid);
  const targets = platform === "win32" ? [supervisorPid, ownerPid] : [supervisorPid || ownerPid];
  let signaled = false;
  for (const pid of targets) if (pid && signalProcess(pid)) signaled = true;
  if (!signaled && platform !== "win32" && supervisorPid && ownerPid) signaled = signalProcess(ownerPid);
  if (!signaled) return false;
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, 50));
    if (ownerPid) { if (!processAlive(ownerPid)) return true; continue; }
    try { await new AutomationOwnerClient({ timeoutMs: 100 }).health(); } catch { return true; }
  }
  return false;
}

function foreignPid(value) {
  const pid = Number(value);
  return Number.isInteger(pid) && pid > 0 && pid !== process.pid && pid !== process.ppid ? pid : null;
}
function signalProcess(pid) { try { process.kill(pid, "SIGTERM"); return true; } catch { return false; } }
function processAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (error) { return error?.code === "EPERM"; }
}

function warnOnce(warn, reason, health, build) {
  if (warnedReasons.has(reason)) return;
  warnedReasons.add(reason);
  const running = describeBuild(health?.build);
  try {
    warn(`[posse][automation] Using the running automation owner (pid ${health?.pid ?? "unknown"}, ${running}) although this client is ${describeBuild(build)}: ${KEEP_REASONS[reason] || reason}.`);
  } catch {}
}
function describeBuild(build) {
  if (!build) return "unknown build";
  return `version ${build.package_version || "unknown"}, commit ${String(build.commit || "unknown").slice(0, 12)}, entry ${build.entry || "unknown"}`;
}
function defaultWarn(message) { console.warn(message); }

function requestFrame(socketPath, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(socketPath); let buffer = Buffer.alloc(0), settled = false;
    const finish = (error, value) => { if (settled) return; settled = true; clearTimeout(timer); socket.destroy(); error ? reject(error) : resolve(value); };
    const timer = setTimeout(() => finish(Object.assign(new Error("Automation owner request timed out"), { code: "owner_timeout" })), timeoutMs);
    socket.once("connect", () => socket.write(JSON.stringify(payload) + "\n"));
    socket.on("data", chunk => {
      buffer = Buffer.concat([buffer, chunk]);
      if (buffer.length > AUTOMATION_MAX_RESPONSE_BYTES) return finish(Object.assign(new Error("Automation owner response is too large"), { code: "owner_protocol_error" }));
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
