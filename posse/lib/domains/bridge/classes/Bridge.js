import { ChangeStream } from "./ChangeStream.js";
import { LocalServer } from "./LocalServer.js";
import { RelayClient } from "./RelayClient.js";
import {
  BRIDGE_PORT_SCAN_END,
  BRIDGE_PORT_SCAN_START,
  getBridgeConfig,
  setBridgePort,
} from "../functions/auth.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";

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
        });
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
      return this.info(address);
    } catch (err) {
      await this.stop();
      throw err;
    }
  }

  /**
   * Bind the local server. A persisted repo port is used as-is; otherwise
   * scan the shared range for a free port and persist the winner so the
   * port stays stable for LAN clients. Two repos serving concurrently land
   * on different ports instead of colliding.
   */
  async startLocalServer() {
    const candidates = this.config.port
      ? [this.config.port]
      : Array.from(
          { length: BRIDGE_PORT_SCAN_END - BRIDGE_PORT_SCAN_START + 1 },
          (_, i) => BRIDGE_PORT_SCAN_START + i,
        );
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
      });
      try {
        const address = await server.start();
        this.localServer = server;
        if (!this.config.port) {
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
      instanceId: this.config.instanceId,
      label: this.config.label,
    };
  }

  async stop() {
    this.relayClient?.stop();
    this.relayClient = null;
    this.changeStream?.close();
    this.changeStream = null;
    await this.localServer?.close();
    this.localServer = null;
  }
}
