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
const DEFAULT_HANDSHAKE_TIMEOUT_MS = 20000;
const DEFAULT_MAX_BUFFERED_BYTES = 2 * 1024 * 1024;
// The relay pings every 15s and drops peers idle past 45s, but on a half-open
// socket (laptop sleep/resume, NAT expiry, network switch) that close never
// reaches us — without a local deadline the bridge sits "online" forever while
// the relay reports it offline. Four missed relay pings force a reconnect.
const DEFAULT_IDLE_TIMEOUT_MS = 60000;

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
    startPosse = null,
    WebSocketImpl = globalThis.WebSocket,
    reconnectBaseMs = DEFAULT_RECONNECT_BASE_MS,
    reconnectMaxMs = DEFAULT_RECONNECT_MAX_MS,
    handshakeTimeoutMs = DEFAULT_HANDSHAKE_TIMEOUT_MS,
    maxBufferedBytes = DEFAULT_MAX_BUFFERED_BYTES,
    idleTimeoutMs = DEFAULT_IDLE_TIMEOUT_MS,
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
    this.startPosse = startPosse;
    this.WebSocketImpl = WebSocketImpl;
    this.reconnectBaseMs = Math.max(100, Number(reconnectBaseMs) || DEFAULT_RECONNECT_BASE_MS);
    this.reconnectMaxMs = Math.max(this.reconnectBaseMs, Number(reconnectMaxMs) || DEFAULT_RECONNECT_MAX_MS);
    this.handshakeTimeoutMs = Math.max(10, Number(handshakeTimeoutMs) || DEFAULT_HANDSHAKE_TIMEOUT_MS);
    this.maxBufferedBytes = Math.max(1024, Number(maxBufferedBytes) || DEFAULT_MAX_BUFFERED_BYTES);
    this.idleTimeoutMs = Math.max(50, Number(idleTimeoutMs) || DEFAULT_IDLE_TIMEOUT_MS);
    this.socket = null;
    this.stopped = true;
    this.reconnectTimer = null;
    this.reconnectAttempt = 0;
    this.connectionGeneration = 0;
    this.handshakeTimer = null;
    this.idleTimer = null;
    this.lastFrameAt = 0;
    this.connectionStatus = {
      state: this.token ? "idle" : "disabled",
      authenticated: false,
      last_error: null,
      connected_at: null,
      authenticated_at: null,
    };
  }

  start() {
    if (!this.token) return { ok: false, reason: "missing_relay_token" };
    if (typeof this.WebSocketImpl !== "function") return { ok: false, reason: "websocket_unavailable" };
    if (this.socket) return { ok: true };
    this.stopped = false;
    this.updateStatus("connecting", { last_error: null });
    this.connect();
    return { ok: true };
  }

  connect() {
    if (this.stopped || this.socket) return;
    const generation = ++this.connectionGeneration;
    let ws;
    try {
      ws = new this.WebSocketImpl(this.url);
    } catch (err) {
      this.updateStatus("error", {
        authenticated: false,
        last_error: err?.message || String(err),
      });
      this.emitError(err);
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    this.armHandshakeTimeout(ws, generation);
    this.updateStatus(this.reconnectAttempt > 0 ? "reconnecting" : "connecting", {
      authenticated: false,
      connected_at: null,
    });
    ws.addEventListener("open", () => this.handleOpen(ws, generation));
    ws.addEventListener("message", (event) => this.handleMessage(event.data, ws, generation));
    ws.addEventListener("close", () => this.handleClose(ws, generation));
    ws.addEventListener("error", (event) => this.handleError(event, ws, generation));
  }

  ownsSocket(ws, generation) {
    return this.socket === ws && this.connectionGeneration === generation;
  }

  handleOpen(ws, generation) {
    if (!this.ownsSocket(ws, generation)) return;
    this.lastFrameAt = Date.now();
    this.armIdleWatchdog(ws, generation);
    this.updateStatus("authenticating", {
      authenticated: false,
      connected_at: new Date().toISOString(),
      last_error: null,
    });
    if (!this.send({
      v: BRIDGE_PROTOCOL_VERSION,
      type: BRIDGE_FRAME_TYPES.HELLO,
      role: "bridge",
      bearer: this.token,
      instance_id: this.instanceId,
      label: this.label,
    })) return;
    // Clients now request snapshots explicitly via the `state.snapshot`
    // command after subscribing. We no longer broadcast a free snapshot
    // here because the relay doesn't track which clients are new.
    this.emit("open");
  }

  async handleMessage(data, ws = this.socket, generation = this.connectionGeneration) {
    if (!this.ownsSocket(ws, generation)) return;
    this.lastFrameAt = Date.now();
    const text = typeof data === "string" ? data : Buffer.from(data || "").toString("utf8");
    const frame = safeJsonParse(text);
    if (!frame || typeof frame !== "object") {
      this.send(createErrorAck(null, "invalid_json"));
      return;
    }
    if (Number(frame.v) !== BRIDGE_PROTOCOL_VERSION) {
      this.send(createErrorAck(frame.id ?? frame.command_id ?? null, "unsupported_version"));
      this.failSocket(ws, generation, new Error("relay protocol version mismatch"));
      return;
    }
    if (frame.type === BRIDGE_FRAME_TYPES.ACK && frame.command_id === "hello") {
      if (frame.ok) {
        this.markAuthenticated();
      } else {
        this.clearHandshakeTimeout();
        this.clearIdleWatchdog();
        this.updateStatus("unauthorized", {
          authenticated: false,
          last_error: frame.error?.message || "relay authentication failed",
        });
        const socket = this.socket;
        this.socket = null;
        try { socket?.close?.(); } catch {}
        // A repository owner may have disabled relay access temporarily from
        // the phone. Keep a bounded backoff running so re-enabling does not
        // require restarting `posse serve`.
        this.scheduleReconnect({ preserveStatus: true });
      }
      return;
    }
    if (frame.type === BRIDGE_FRAME_TYPES.PING) {
      this.markAuthenticated();
      this.send({ v: BRIDGE_PROTOCOL_VERSION, type: BRIDGE_FRAME_TYPES.PONG });
      return;
    }
    if (frame.type === BRIDGE_FRAME_TYPES.PONG) {
      this.markAuthenticated();
      return;
    }
    // The relay does not originate hello frames at us, and snapshots are
    // now client-driven via `state.snapshot`. We accept and ignore inbound
    // hellos for forward compatibility but don't broadcast snapshots.
    if (frame.type === BRIDGE_FRAME_TYPES.HELLO) return;
    if (frame.type !== BRIDGE_FRAME_TYPES.COMMAND) return;
    this.markAuthenticated();
    this.emit("operator_activity");
    try {
      const ack = await this.dispatch(frame, {
        projectDir: this.projectDir,
        actor: "bridge-relay",
        tailBridgeEvents: this.tailBridgeEvents,
        getHeadEventId: this.getHeadEventId,
        startPosse: this.startPosse,
      });
      this.send(ack);
    } catch (err) {
      this.send(createErrorAck(frame.id ?? frame.command_id ?? null, "internal"));
    }
  }

  handleClose(ws = this.socket, generation = this.connectionGeneration) {
    if (!this.ownsSocket(ws, generation)) return;
    this.clearHandshakeTimeout();
    this.clearIdleWatchdog();
    this.socket = null;
    this.updateStatus("offline", {
      authenticated: false,
      connected_at: null,
    });
    this.emit("close");
    this.scheduleReconnect();
  }

  handleError(event, ws = this.socket, generation = this.connectionGeneration) {
    if (!this.ownsSocket(ws, generation)) return;
    const err = event?.error || event;
    this.failSocket(ws, generation, err || new Error("relay websocket error"));
  }

  failSocket(ws, generation, err) {
    if (!this.ownsSocket(ws, generation)) return;
    this.clearHandshakeTimeout();
    this.clearIdleWatchdog();
    this.socket = null;
    this.updateStatus("error", {
      authenticated: false,
      connected_at: null,
      last_error: err?.message || String(err),
    });
    this.emitError(err);
    try { ws?.close?.(); } catch {}
    this.scheduleReconnect();
  }

  emitError(err) {
    if (this.listenerCount("error") > 0) this.emit("error", err);
  }

  markAuthenticated() {
    if (this.connectionStatus.authenticated) return;
    this.clearHandshakeTimeout();
    this.reconnectAttempt = 0;
    this.updateStatus("online", {
      authenticated: true,
      authenticated_at: new Date().toISOString(),
      last_error: null,
    });
  }

  status() {
    return { ...this.connectionStatus };
  }

  updateStatus(state, patch = {}) {
    this.connectionStatus = {
      ...this.connectionStatus,
      ...patch,
      state,
    };
    this.emit("status", this.status());
  }

  armHandshakeTimeout(ws, generation) {
    this.clearHandshakeTimeout();
    this.handshakeTimer = setTimeout(() => {
      this.handshakeTimer = null;
      this.failSocket(
        ws,
        generation,
        new Error("relay websocket authentication timed out"),
      );
    }, this.handshakeTimeoutMs);
    this.handshakeTimer.unref?.();
  }

  clearHandshakeTimeout() {
    if (!this.handshakeTimer) return;
    clearTimeout(this.handshakeTimer);
    this.handshakeTimer = null;
  }

  /**
   * Liveness deadline for an established connection. We never originate
   * pings — the relay does — so "no frame of any kind for idleTimeoutMs"
   * is the only local signal that the socket has gone half-open. Retiring
   * it re-enters the normal bounded-backoff reconnect path.
   */
  armIdleWatchdog(ws, generation) {
    this.clearIdleWatchdog();
    const period = Math.max(25, Math.floor(this.idleTimeoutMs / 4));
    this.idleTimer = setInterval(() => {
      if (!this.ownsSocket(ws, generation)) {
        this.clearIdleWatchdog();
        return;
      }
      if (Date.now() - this.lastFrameAt < this.idleTimeoutMs) return;
      this.failSocket(
        ws,
        generation,
        new Error("relay connection went silent past the idle timeout"),
      );
    }, period);
    this.idleTimer.unref?.();
  }

  clearIdleWatchdog() {
    if (!this.idleTimer) return;
    clearInterval(this.idleTimer);
    this.idleTimer = null;
  }

  scheduleReconnect({ preserveStatus = false } = {}) {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(
      this.reconnectMaxMs,
      this.reconnectBaseMs * (2 ** Math.min(this.reconnectAttempt, 8)),
    );
    this.reconnectAttempt += 1;
    if (!preserveStatus) {
      this.updateStatus("reconnecting", { authenticated: false });
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay);
    this.reconnectTimer.unref?.();
  }

  send(frame) {
    const openState = this.WebSocketImpl?.OPEN ?? 1;
    if (!this.socket || this.socket.readyState !== openState) return false;
    const socket = this.socket;
    const generation = this.connectionGeneration;
    try {
      const payload = JSON.stringify(frame);
      const bufferedBytes = Math.max(0, Number(socket.bufferedAmount) || 0);
      if (bufferedBytes + Buffer.byteLength(payload) > this.maxBufferedBytes) {
        this.failSocket(
          socket,
          generation,
          new Error("relay websocket send buffer exceeded the safe limit"),
        );
        return false;
      }
      socket.send(payload);
      return true;
    } catch (err) {
      this.failSocket(socket, generation, err);
      return false;
    }
  }

  close() {
    this.stop();
  }

  stop() {
    this.stopped = true;
    this.clearHandshakeTimeout();
    this.clearIdleWatchdog();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    const socket = this.socket;
    this.socket = null;
    this.connectionGeneration += 1;
    try { socket?.close?.(); } catch {}
    this.updateStatus(this.token ? "stopped" : "disabled", {
      authenticated: false,
      connected_at: null,
    });
  }
}
