import { ChangeStream } from "./ChangeStream.js";
import { LocalServer } from "./LocalServer.js";
import { RelayClient } from "./RelayClient.js";
import { getBridgeConfig } from "../functions/auth.js";
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
        dbPath: getRuntimeDbPath(),
        pollMs: this.pollMs,
        instanceId: this.config.instanceId,
      });
      this.changeStream.start();
      this.localServer = new LocalServer({
        host: this.config.bindHost,
        port: this.config.port,
        token: this.config.token,
        instanceId: this.config.instanceId,
        label: this.config.label,
        projectDir: this.projectDir,
        getHeadEventId: () => this.changeStream?.headEventId() || 0,
        tailBridgeEvents: (args) => this.changeStream?.tailFrames(args) || { events: [], head_event_id: 0 },
      });
      const address = await this.localServer.start();
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
