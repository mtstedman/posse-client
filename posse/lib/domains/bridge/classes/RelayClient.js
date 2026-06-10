import { EventEmitter } from "node:events";

import {
  BRIDGE_FRAME_TYPES,
  BRIDGE_PROTOCOL_VERSION,
} from "../../../catalog/bridge.js";
import {
  createErrorAck,
  dispatchBridgeCommandFrame,
} from "../functions/command-dispatch.js";

const DEFAULT_RECONNECT_BASE_MS = 1000;
const DEFAULT_RECONNECT_MAX_MS = 30000;

function safeJsonParse(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

export class RelayClient extends EventEmitter {
  constructor({
    url = "wss://app.yourposseai.com/v1/instance",
    token,
    instanceId,
    label,
    projectDir = process.cwd(),
    dispatch = dispatchBridgeCommandFrame,
    tailBridgeEvents = null,
    getHeadEventId = null,
    WebSocketImpl = globalThis.WebSocket,
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
  } = {}) {
    super();
    this.url = url;
    this.token = token;
    this.instanceId = instanceId;
    this.label = label;
    this.projectDir = projectDir;
    this.dispatch = dispatch;
    this.tailBridgeEvents = tailBridgeEvents;
    this.getHeadEventId = getHeadEventId;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectBaseMs = Math.max(100, Number(reconnectBaseMs) || DEFAULT_RECONNECT_BASE_MS);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, Number(reconnectMaxMs) || DEFAULT_RECONNECT_MAX_MS);
    this.socket = null;
    this.stopped = true;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
  }

  start() {
    if (!this.token) return { ok: false, reason: "missing_relay_token" };
    if (typeof this.WebSocketImpl !== "function") return { ok: false, reason: "websocket_unavailable" };
    if (this.socket) return { ok: true };
    this.stopped = false;
    this.connect();
    return { ok: true };
  }

  connect() {
    if (this.stopped || this.socket) return;
    const ws = new this.WebSocketImpl(this.url);
    this.socket = ws;
    ws.addEventListener("open", () => this.handleOpen());
    ws.addEventListener("message", (event) => this.handleMessage(event.data));
    ws.addEventListener("close", () => this.handleClose());
    ws.addEventListener("error", (event) => this.handleError(event));
  }

  handleOpen() {
    this.reconnectAttempt = 0;
    this.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: BRIDGE_FRAME_TYPES.HELLO,
      role: "bridge",
      bearer: this.token,
      instance_id: this.instanceId,
      label: this.label,
    });
    // Clients now request snapshots explicitly via the `state.snapshot`
    // command after subscribing. We no longer broadcast a free snapshot
    // here because the relay doesn't track which clients are new.
    this.emit("open");
  }

  async handleMessage(data) {
    const text = typeof data === "string" ? data : Buffer.from(data || "").toString("utf8");
    const frame = safeJsonParse(text);
    if (!frame || typeof frame !== "object") {
      this.send(createErrorAck(null, "invalid_json"));
      return;
    }
    if (Number(frame.v) !== BRIDGE_PROTOCOL_VERSION) {
      this.send(createErrorAck(frame.id ?? frame.command_id ?? null, "unsupported_version"));
      this.close();
      return;
    }
    if (frame.type === BRIDGE_FRAME_TYPES.PING) {
      this.send({ v: BRIDGE_PROTOCOL_VERSION, type: BRIDGE_FRAME_TYPES.PONG });
      return;
    }
    if (frame.type === BRIDGE_FRAME_TYPES.PONG) return;
    // The relay does not originate hello frames at us, and snapshots are
    // now client-driven via `state.snapshot`. We accept and ignore inbound
    // hellos for forward compatibility but don't broadcast snapshots.
    if (frame.type === BRIDGE_FRAME_TYPES.HELLO) return;
    if (frame.type !== BRIDGE_FRAME_TYPES.COMMAND) return;
    try {
      const ack = await this.dispatch(frame, {
        projectDir: this.projectDir,
        actor: "bridge-relay",
        tailBridgeEvents: this.tailBridgeEvents,
        getHeadEventId: this.getHeadEventId,
      });
      this.send(ack);
    } catch (err) {
      this.send(createErrorAck(frame.id ?? frame.command_id ?? null, "internal"));
    }
  }

  handleClose() {
    this.socket = null;
    this.emit("close");
    this.scheduleReconnect();
  }

  handleError(event) {
    const err = event?.error || event;
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  scheduleReconnect() {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * (2 ** Math.min(this.reconnectAttempt, 8)),
    );
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  send(frame) {
    const openState = this.WebSocketImpl?.OPEN ?? 1;
    if (!this.socket || this.socket.readyState !== openState) return false;
    this.socket.send(JSON.stringify(frame));
    return true;
  }

  close() {
    this.stop();
  }

  stop() {
    this.stopped = true;
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    try { socket?.close?.(); } catch {}
  }
}
