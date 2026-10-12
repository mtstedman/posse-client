import path from "node:path";

import { AGENT_RELEASE_COMMANDS, AGENT_RELEASE_LIMITS, AGENT_RELEASE_SELF_CHECK } from "../../../catalog/agent-release.js";
import { SYSTEM_OWNER_ENV_RESERVED_KEYS, SYSTEM_REGISTERED_AGENT } from "../../../catalog/registered-agent.js";
import { scrubSecretText } from "../../../shared/telemetry/functions/logging/scrub-secret-text.js";
import { childEnv, commandFailure, lookupAccount, lookupGroupId, sandboxedProbeArgs } from "../functions/agent-release-host.js";
import { classifySmokeOutput } from "../functions/agent-release-plan.js";
import { readTrustedConfigFile } from "../functions/system-release-integrity.js";

const SMOKE_MODULE = "lib/domains/automation/functions/agent-release-smoke.js";
const RECEIPTS_MODULE = "lib/domains/automation/functions/agent-release-receipts.js";

/**
 * Every process the release reconciler runs against the owner or a staged
 * release, always as the owner account and never as root: health and
 * restart counts of the live owner, the receipt drain, and the two gates a
 * staged release must pass (its own reconciler loads; a live tool-call chat
 * works). Caches the owner account lookup for one run.
 */
export class AgentReleaseProbes {
  /**
   * @param {{ host: any, paths: { node: string, launcher: string, selfRoot: string, automationDb: string,
   *   ownerEnv: string, ownerHome: string, ownerRuntime: string } }} options
   */
  constructor({ host, paths }) {
    this.host = host;
    this.paths = paths;
    this.owner = null;
  }

  run(command, args, options) { return this.host.run(command, args, options); }

  // Health, probed as the owner account: root has no reason to be a client
  // of the account that runs tool calls.

  ownerRunOptions(timeoutMs) {
    if (!this.owner) {
      const account = lookupAccount(this.run.bind(this), SYSTEM_REGISTERED_AGENT.account);
      this.owner = { account, gid: lookupGroupId(this.run.bind(this), SYSTEM_REGISTERED_AGENT.clientGroup) };
    }
    return { uid: this.owner.account.uid, gid: this.owner.gid, env: childEnv(this.owner.account), cwd: "/", timeoutMs };
  }

  restartCounts() {
    const count = service => {
      const result = this.run(AGENT_RELEASE_COMMANDS.systemctl, ["show", "-p", "NRestarts", "--value", service]);
      const value = Number(String(result.stdout || "").trim());
      return result.status === 0 && Number.isInteger(value) ? value : 0;
    };
    return { owner: count(SYSTEM_REGISTERED_AGENT.ownerService), gateway: count(SYSTEM_REGISTERED_AGENT.gatewayService) };
  }

  probeHealth() {
    const active = service => this.run(AGENT_RELEASE_COMMANDS.systemctl, ["is-active", "--quiet", service]).status === 0;
    const ownerActive = active(SYSTEM_REGISTERED_AGENT.ownerService);
    const gatewayActive = active(SYSTEM_REGISTERED_AGENT.gatewayService);
    let ready = false;
    if (ownerActive && gatewayActive) {
      try {
        const result = this.run(this.paths.launcher, ["health", "--json"], this.ownerRunOptions(AGENT_RELEASE_LIMITS.probeTimeoutMs));
        ready = result.status === 0 && JSON.parse(String(result.stdout).trim().split("\n").pop()).ready === true;
      } catch { ready = false; }
    }
    return { healthy: ownerActive && gatewayActive && ready, owner_active: ownerActive, gateway_active: gatewayActive, ready,
      restarts: this.restartCounts() };
  }

  async health(attempts = AGENT_RELEASE_LIMITS.healthAttempts) {
    let last = this.probeHealth();
    for (let attempt = 1; attempt < attempts && !last.healthy; attempt++) {
      await this.host.sleep(AGENT_RELEASE_LIMITS.healthIntervalMs);
      last = this.probeHealth();
    }
    return last;
  }

  // Gates. Staged code is unproven: it runs as the owner account in a
  // throwaway sandbox with no view of the live owner's data or sockets.

  probeArgs(timeoutSeconds, environmentFile = "") {
    return sandboxedProbeArgs({ timeoutSeconds, environmentFile, ownerHome: this.paths.ownerHome, ownerRuntime: this.paths.ownerRuntime });
  }

  /**
   * Run the staged release's own reconciler unprivileged. It must refuse
   * with the root-only message, which proves its CLI -> reconciler -> manager
   * import graph loads. Every later reconcile runs from `current`, so a
   * release whose reconciler cannot load must never get there.
   */
  selfCheck(staged) {
    const seconds = AGENT_RELEASE_LIMITS.selfCheckTimeoutSeconds;
    const result = this.run(AGENT_RELEASE_COMMANDS.systemdRun, [...this.probeArgs(seconds), this.paths.node,
      path.join(staged.packageRoot, "orchestrator.js"), ...AGENT_RELEASE_SELF_CHECK.args], { timeoutMs: (seconds + 60) * 1000 });
    const refused = String(result.stderr || "").split("\n").some(line => line.trim() === AGENT_RELEASE_SELF_CHECK.refusal);
    if (result.status !== 0 && refused) return { ok: true, detail: "" };
    return { ok: false, detail: result.status === 0 ? "reconciler self-check ran without refusing a non-root caller"
      : commandFailure("reconciler self-check", result) };
  }

  /**
   * The live tool-call chat, as the owner account with owner.env, through the
   * staged release. A failure is transient when the smoke's structured result
   * blames the provider or the network.
   *
   * @returns {{ ok: boolean, output: string, detail: string, transient: boolean, failureClass: string }}
   */
  smoke(staged) {
    const io = this.host.fs;
    const shipped = path.join(staged.packageRoot, SMOKE_MODULE);
    const script = io.existsSync(shipped) ? shipped : path.join(this.paths.selfRoot, SMOKE_MODULE);
    const ownerEnv = readTrustedConfigFile(this.paths.ownerEnv, { io, label: "System owner environment",
      reservedKeys: SYSTEM_OWNER_ENV_RESERVED_KEYS, trustedUid: this.host.trustedUid });
    const seconds = AGENT_RELEASE_LIMITS.smokeTimeoutSeconds;
    const args = [...this.probeArgs(seconds, ownerEnv === null ? "" : this.paths.ownerEnv), this.paths.node, script, staged.packageRoot];
    const result = this.run(AGENT_RELEASE_COMMANDS.systemdRun, args, { timeoutMs: (seconds + 60) * 1000 });
    const output = scrubSecretText(String(result.stdout || "").trim().split("\n").slice(-3).join(" | ")).slice(0, 600);
    if (result.status === 0) return { ok: true, output, detail: "", transient: false, failureClass: "" };
    return { ok: false, output, detail: commandFailure("smoke", result), ...classifySmokeOutput(result.stdout) };
  }

  /** Wait, bounded, until the owner holds no unfinished registered receipt. */
  async drain(config) {
    const probe = path.join(this.paths.selfRoot, RECEIPTS_MODULE);
    const deadline = this.host.now() + config.drainTimeoutSeconds * 1000;
    let unfinished = null;
    while (true) {
      const result = this.run(this.paths.node, [probe, this.paths.automationDb], this.ownerRunOptions(AGENT_RELEASE_LIMITS.probeTimeoutMs));
      try { unfinished = result.status === 0 ? Number(JSON.parse(String(result.stdout).trim()).unfinished) : null; } catch { unfinished = null; }
      if (unfinished === 0) return { drained: true, unfinished };
      const left = deadline - this.host.now();
      if (left <= 0) return { drained: false, unfinished };
      this.host.log("draining", { unfinished: unfinished ?? "unknown" });
      await this.host.sleep(Math.min(AGENT_RELEASE_LIMITS.drainPollMs, left));
    }
  }
}
