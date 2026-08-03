import { ChangeStream } from "./ChangeStream.js";
import { LocalServer } from "./LocalServer.js";
import { PosseRunLauncher } from "./PosseRunLauncher.js";
import { RelayClient } from "./RelayClient.js";
import {
  BRIDGE_PORT_SCAN_END,
  BRIDGE_PORT_SCAN_START,
  getBridgeConfig,
  setBridgePort,
} from "../functions/auth.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import {
  RUNTIME_STATUS_KEYS,
  clearRuntimeStatus,
  writeRuntimeStatus,
} from "../../queue/functions/runtime-status.js";

const BRIDGE_PRESENCE_HEARTBEAT_MS = 30_000;
const OPERATOR_ACTIVITY_FRESH_MS = 120_000;

export class Bridge {
  constructor({
    projectDir = process.cwd(),
    config = getBridgeConfig(projectDir),
    pollMs = 500,
  } = {}) {
    this.projectDir = projectDir;
    this.config = config;
    this.pollMs = pollMs;
    this.localServer = null;
    this.changeStream = null;
    this.relayClient = null;
    this.runLauncher = new PosseRunLauncher({ projectDir: this.projectDir });
    this.presenceTimer = null;
    this.lastOperatorActivityAt = 0;
  }

  noteOperatorActivity() {
    this.lastOperatorActivityAt = Date.now();
    this.writeOperatorPresence();
  }

  operatorPresent() {
    if ((this.localServer?.authenticatedClientCount?.() || 0) > 0) return true;
    return Date.now() - this.lastOperatorActivityAt < OPERATOR_ACTIVITY_FRESH_MS;
  }

  writeOperatorPresence() {
    try {
      writeRuntimeStatus(RUNTIME_STATUS_KEYS.BRIDGE, {
        present: this.operatorPresent(),
        at: new Date().toISOString(),
        instance_id: this.config.instanceId,
      });
    } catch {
      // Presence is advisory; a transient DB failure must not crash serve.
    }
  }

  /**
   * Heartbeat "a remote operator can reach this repo" into runtime_status.
   * The detached run reads it (isBridgePresenceFresh) to keep human gates
   * open for the phone instead of applying the headless timeout. Writes are
   * best-effort — presence telemetry must never take the bridge down.
   */
  startPresenceHeartbeat() {
    if (this.presenceTimer) return;
    const beat = () => this.writeOperatorPresence();
    beat();
    this.presenceTimer = setInterval(beat, BRIDGE_PRESENCE_HEARTBEAT_MS);
    this.presenceTimer.unref?.();
  }

  stopPresenceHeartbeat() {
    if (this.presenceTimer) {
      clearInterval(this.presenceTimer);
      this.presenceTimer = null;
    }
    clearRuntimeStatus(RUNTIME_STATUS_KEYS.BRIDGE);
  }

  async start() {
    if (this.localServer) return this.info();
    try {
      this.changeStream = new ChangeStream({
        dbPath: getRuntimeDbPath(this.projectDir),
        pollMs: this.pollMs,
        instanceId: this.config.instanceId,
      });
      this.changeStream.start();
      const address = await this.startLocalServer();
      if (this.config.relayToken) {
        this.relayClient = new RelayClient({
          url: this.config.relayUrl,
          token: this.config.relayToken,
          instanceId: this.config.instanceId,
          label: this.config.label,
          projectDir: this.projectDir,
          tailBridgeEvents: (args) => this.changeStream?.tailFrames(args) || { events: [], head_event_id: 0 },
          getHeadEventId: () => this.changeStream?.headEventId() || 0,
          startPosse: () => this.runLauncher.start(),
        });
        this.relayClient.on("operator_activity", () => this.noteOperatorActivity());
        this.relayClient.on("error", (err) => {
          try {
            console.warn(`[posse][bridge] relay error: ${err?.message || err}`);
          } catch {
            // Best-effort observability only.
          }
        });
        this.relayClient.start();
      }
      this.changeStream.on("frame", (frame) => {
        this.localServer?.broadcast(frame);
        this.relayClient?.send(frame);
      });
      this.startPresenceHeartbeat();
      return this.info(address);
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /**
   * Bind the local server. A persisted repo port is preferred so the port
   * stays stable for LAN clients, but it is only a preference: another
   * repo's bridge (or any process) may hold it, and refusing to rescan
   * would block `posse serve` in this repo entirely. On a busy preferred
   * port, fall back to scanning the shared range and persist the winner.
   */
  async startLocalServer() {
    const scanRange = Array.from(
      { length: BRIDGE_PORT_SCAN_END - BRIDGE_PORT_SCAN_START + 1 },
      (_, i) => BRIDGE_PORT_SCAN_START + i,
    );
    const candidates = this.config.port
      ? [this.config.port, ...scanRange.filter((port) => port !== this.config.port)]
      : scanRange;
    let lastErr = null;
    for (const port of candidates) {
      const server = new LocalServer({
        host: this.config.bindHost,
        port,
        token: this.config.token,
        instanceId: this.config.instanceId,
        label: this.config.label,
        projectDir: this.projectDir,
        getHeadEventId: () => this.changeStream?.headEventId() || 0,
        tailBridgeEvents: (args) => this.changeStream?.tailFrames(args) || { events: [], head_event_id: 0 },
        getRelayStatus: () => this.relayClient?.status() || {
          state: this.config.relayToken ? "connecting" : "disabled",
          authenticated: false,
          last_error: null,
          connected_at: null,
          authenticated_at: null,
        },
        startPosse: () => this.runLauncher.start(),
        onOperatorActivity: () => this.noteOperatorActivity(),
      });
      try {
        const address = await server.start();
        this.localServer = server;
        if (this.config.port !== address.port) {
          this.config.port = address.port;
          try {
            setBridgePort(address.port, this.projectDir);
          } catch {
            // Persisting the port is best-effort; the bridge still runs.
          }
        }
        return address;
      } catch (err) {
        lastErr = err;
        try { await server.close(); } catch { /* ignore */ }
        if (err?.code !== "EADDRINUSE") throw err;
      }
    }
    throw lastErr || new Error("no free bridge port in scan range");
  }

  /** Live relay connection status, or a disabled stub when unpaired. */
  relayStatus() {
    if (this.relayClient) return this.relayClient.status();
    return {
      state: this.config.relayToken ? "connecting" : "disabled",
      authenticated: false,
      last_error: null,
    };
  }

  info(address = null) {
    const resolved = address || this.localServer?.address() || {
      host: this.config.bindHost,
      port: this.config.port,
      url: `http://${this.config.bindHost}:${this.config.port}`,
    };
    return {
      ...resolved,
      token: this.config.token,
      relayUrl: this.config.relayUrl,
      relayEnabled: Boolean(this.config.relayToken),
      relayStatus: this.relayClient?.status() || {
        state: this.config.relayToken ? "connecting" : "disabled",
        authenticated: false,
      },
      instanceId: this.config.instanceId,
      label: this.config.label,
    };
  }

  async stop() {
    this.stopPresenceHeartbeat();
    this.relayClient?.stop();
    this.relayClient = null;
    this.changeStream?.close();
    this.changeStream = null;
    await this.localServer?.close();
    this.localServer = null;
  }
}
