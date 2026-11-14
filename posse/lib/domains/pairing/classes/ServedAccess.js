import fs from "node:fs";
import { SERVED_EVENTS } from "../../../catalog/pairing-wire.js";
import { getBridgeConfig } from "../../bridge/functions/auth.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import { scrubSecrets } from "../../../shared/telemetry/classes/logging/secret-scrub.js";
import { getLivePairingState } from "../functions/state.js";
import { readSessionInviteCode } from "../functions/session-invite.js";
import { createSessionConsole } from "../functions/session-console.js";
import { servedComputeLine } from "../functions/phone-pairing.js";

/** Owns bridge, invitations and terminal input until the Git session takes over. */
export class ServedAccess {
  constructor(options) {
    Object.assign(this, options);
    this.consoleFactory = options.consoleFactory || createSessionConsole;
    this.activeSession = options.activeSession || (() => fs.existsSync(getRuntimeDbPath()) ? getLivePairingState() : null);
    this.shutdownAbort = new AbortController();
    this.closing = false;
    this.hostStarting = false;
    this.phoneTask = null;
    this.session = null;
    this.console = null;
    this.log = (...args) => {
      const text = args.join(" ");
      if (this.console) this.console.print(text);
      else (this.json ? console.error : console.log)(text);
    };
  }

  emit(event) {
    if (this.json) console.log(JSON.stringify(event));
  }

  showBridge() {
    const { C, info } = this;
    this.log(`\n  ${C.green}${C.bold}Posse serving${C.reset} · ${info.label}`);
    this.log(`  Local URL  ${C.cyan}${info.url}${C.reset}`);
    this.emit({ ok: true, event: SERVED_EVENTS.STARTED, url: info.url, instance_id: info.instanceId });
  }

  showInvitation() {
    const state = this.invitation ? null : this.activeSession();
    const code = this.invitation?.code || readSessionInviteCode(state);
    if (code) {
      this.log(`\n  ${this.C.bold}Collaborator${this.C.reset}`);
      this.log(`  Join code  ${this.C.cyan}${code}${this.C.reset}`);
      this.log(`  Command    posse serve join ${code}`);
    } else if (state) {
      this.log(`  Already in a collaborative session as ${state.role}. Use posse serve status or posse serve members to inspect it.`);
    } else {
      this.log("  Clone invitations unavailable. Type invite to retry after fixing the reported error.");
    }
  }

  showHelp() {
    this.log(`\n  ${this.C.bold}Serve commands${this.C.reset}`);
    this.log("  phone      show a fresh phone QR and manual token");
    this.log("  invite     show or retry the collaborator invitation");
    this.log("  help       show this help\n  quit       stop serving (also Ctrl-C)");
    this.log("\n  Share the join command with a collaborator. Git setup starts when they join.");
    this.log("  In the session console: admit <CODE> host uses your compute; admit <CODE> member uses theirs.");
    this.log("  From another terminal: posse serve admit <CODE> host (or member)");
    this.log(`\n  Phone work  ${servedComputeLine()}`);
    this.log("  LAN token   posse serve --show-lan-token\n");
  }

  openConsole() {
    if (!this.interactive || this.json || this.closing || this.hostStarting || this.console) return;
    this.log("\n  help  more commands · quit  stop serving\n");
    this.console = this.consoleFactory({
      prompt: "  serve> ",
      onLine: (line) => {
        const command = String(line).trim().toLowerCase();
        if (!command) return;
        if (command === "quit" || command === "exit") this.shutdownAbort.abort();
        else if (command === "help" || command === "?") this.showHelp();
        else if (command === "phone") void this.pairPhone().catch((error) => this.log(`  Phone pairing failed: ${scrubSecrets(error.message)}`));
        else if (command === "invite") {
          if (this.invitation) this.showInvitation();
          else void this.startInvitation();
        } else this.log("  Type phone to add a phone, invite to add a collaborator, or help for commands.");
      },
      onInterrupt: () => this.shutdownAbort.abort(),
      onHangup: () => this.shutdownAbort.abort(),
    });
  }

  closeConsole() {
    this.console?.close();
    this.console = null;
  }

  startInvitation() {
    if (this.reservationTask) return this.reservationTask;
    this.reservationTask = this.reserveInvitation().finally(() => { this.reservationTask = null; });
    return this.reservationTask;
  }

  async reserveInvitation() {
    if (!this.sessionFactory || this.closing || this.reserving) return;
    this.reserving = true;
    try {
      if (this.activeSession()) {
        this.showInvitation();
        return;
      }
      await this.session?.stop();
      if (this.closing) return;
      const session = this.sessionFactory({
        remoteClient: this.remoteClientFactory(), instanceId: this.config.instanceId, log: this.log,
        host: async (remoteClient, signal) => {
          this.hostStarting = true;
          // The phone prompt and session monitor must never read the same input.
          if (this.phoneTask) this.log("  A collaborator is joining. Phone pairing will pause; type phone in the session console to try again.");
          this.phoneAbort?.abort();
          await this.phoneTask;
          this.closeConsole();
          signal.throwIfAborted();
          const pairPhone = (options) => this.pairPhone(options);
          if (this.host) return this.host(remoteClient, signal, { pairPhone });
          const { prepareServedHost } = await import("../functions/served-host-preflight.js");
          const { runPairingCommand } = await import("../functions/pair-command.js");
          await prepareServedHost({ signal });
          return runPairingCommand(this.sessionArgs, {
            projectDir: this.projectDir, C: this.C, remoteClient, signal,
            sessionScreenFirst: false, pairPhone,
          });
        },
      });
      this.session = session;
      this.invitation = await session.start();
      if (this.closing) return;
      this.emit({ ok: true, event: SERVED_EVENTS.INVITATION, role: "host", code: this.invitation.code,
        session_id: this.invitation.session_id, repository_pending: true });
      this.showInvitation();
      this.sessionEnded = session.done.then(() => "session closed", (error) => {
        this.invitation = null;
        this.hostStarting = false;
        this.log(`  Clone session unavailable: ${scrubSecrets(error?.message || String(error))}`);
        this.openConsole();
        // Phone access continues; invite can reserve a fresh session after repair.
        return new Promise(() => {});
      });
      // A retry's completion must also stop the owner waiting on shutdown.
      void this.sessionEnded.then(() => this.shutdownAbort.abort());
    } catch (error) {
      this.invitation = null;
      this.log(`  Clone invitations unavailable: ${scrubSecrets(error?.message || String(error))}. Phone and LAN access remain available.`);
    } finally {
      this.reserving = false;
    }
  }

  pairPhone({ signal = null, argv = [] } = {}) {
    if (this.closing) return Promise.resolve({ ok: false, reason: "canceled" });
    if (this.phoneTask) return this.phoneTask;
    this.console?.suspend();
    this.phoneAbort = new AbortController();
    const cancel = () => this.phoneAbort?.abort();
    signal?.addEventListener("abort", cancel, { once: true });
    if (signal?.aborted) cancel();
    this.phoneTask = this.linkPhone(argv).then(async (paired) => {
      if (paired.ok && !this.hostStarting) await this.showRelay();
      return paired;
    }).finally(() => {
      signal?.removeEventListener("abort", cancel);
      this.phoneTask = null;
      this.phoneAbort = null;
      if (!this.closing && !this.hostStarting) {
        for (const line of this.console?.resume() || []) this.log(line);
      }
    });
    return this.phoneTask;
  }

  async linkPhone(argv) {
    const { C, projectDir, json } = this;
    // Use plain output while the enrollment console is suspended for the QR.
    const log = (...args) => (json ? console.error : console.log)(...args);
    log("\n  Phone pairing · Enter to skip · help for commands after skipping");
    const options = { C, argv, projectDir, json, signal: this.phoneAbort.signal };
    let paired;
    try {
      paired = await this.pair(this.config, options);
      if (this.config.relayToken && paired?.reason === "pair_start_failed"
        && paired.status === 401 && paired.body?.error?.code === "bridge_credential_invalid"
        && !options.signal.aborted) {
        log("  The saved bridge credential was rejected; starting fresh phone pairing.");
        paired = await this.pair({ ...this.config, relayToken: null }, options);
      }
      // Confirmation can commit just before cancellation. Always reconcile
      // persisted credentials, even if the ceremony reports canceled.
      const config = getBridgeConfig(projectDir);
      if (config.instanceId !== this.config.instanceId || config.relayToken !== this.config.relayToken) {
        await this.bridge.stop({ restarting: true });
        this.config = config;
        this.bridge.config = config;
        if (!this.closing) {
          try { this.info = await this.bridge.start({ restarting: true }); }
          catch (error) { this.shutdownAbort.abort(); throw error; }
        }
      }
    } catch (error) {
      log(`  Phone pairing failed: ${scrubSecrets(error?.message || String(error))}`);
      paired = { ok: false, reason: "pair_failed" };
    }
    return paired || { ok: false, reason: "pair_failed" };
  }

  async showRelay() {
    if (this.closing) return;
    if (!this.info.relayEnabled) {
      this.log(this.interactive && !this.json
        ? "  Phone/web  Not paired · Type phone to pair"
        : "  Phone/web  Not paired · Run `posse serve --pair` at a terminal");
      return;
    }
    if (!this.wait) return;
    const relay = await this.waitForRelayOutcome(this.bridge, { signal: this.shutdownAbort.signal });
    if (this.closing) return;
    if (relay.state === "online") this.log("  Phone/web  Online");
    else if (relay.state === "unauthorized") this.log("  Phone/web  Credential rejected · Run posse serve --pair to repair");
    else if (relay.state !== "stopped") this.log(`  Phone/web  Offline (${relay.state}) · Retrying in the background`);
  }

  async run() {
    this.bridge = new this.BridgeClass({ projectDir: this.projectDir, config: this.config });
    this.info = await this.bridge.start();
    this.showBridge();
    const shutdown = this.waitForShutdown(this.bridge.stopped, this.shutdownAbort.signal, () => {
      this.closing = true;
      this.phoneAbort?.abort();
      this.session?.abort?.abort();
      this.closeConsole();
    });
    const releaseGuard = this.wait ? this.installCrashGuard(this.bridge, { projectDir: this.projectDir }) : () => {};
    let transferred = false;
    let signal;
    try {
      if (this.wait && !this.closing) {
        await this.startInvitation();
      }
      const explicitPair = this.argv.includes("--pair");
      const automaticPair = this.wait && this.interactive && !this.json;
      let phonePaired = false;
      if ((explicitPair || automaticPair) && !this.hostStarting && !this.closing) {
        const paired = await this.pairPhone({ argv: this.argv });
        phonePaired = paired.ok;
        if (!paired.ok && !["no_confirmation_code", "canceled"].includes(paired.reason)) {
          if (explicitPair) {
            process.exitCode = 1;
            this.emit(paired);
            return paired;
          }
          this.log("  Phone pairing unavailable. Type phone to retry; serving continues.");
        }
      }
      if (!phonePaired) await this.showRelay();
      if (!this.wait) {
        transferred = true;
        return { ok: true, bridge: this.bridge, info: this.info };
      }
      this.openConsole();
      signal = await shutdown;
    } finally {
      this.closing = true;
      this.shutdownAbort.abort();
      this.phoneAbort?.abort();
      this.closeConsole();
      await this.phoneTask?.catch(() => {});
      await this.reservationTask?.catch(() => {});
      try { await this.session?.stop(); }
      catch (error) { this.log(`  Invitation cleanup: ${scrubSecrets(error?.message || String(error))}`); }
      releaseGuard();
      if (!transferred) await this.bridge.stop();
    }
    this.log(`\n  ${this.C.yellow}Posse bridge stopped (${signal})${this.C.reset}\n`);
    this.emit({ ok: true, event: SERVED_EVENTS.STOPPED, signal });
    return { ok: true, signal };
  }
}
