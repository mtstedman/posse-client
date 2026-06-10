import crypto from "node:crypto";
import http from "node:http";

import {
  BRIDGE_EVENT_KINDS,
  BRIDGE_FRAME_TYPES,
  BRIDGE_PROTOCOL_VERSION,
} from "../../../catalog/bridge.js";
import { createBridgeEventFrame } from "./ChangeStream.js";
import {
  createErrorAck,
  dispatchBridgeCommandFrame,
  listAllowedBridgeCommands,
} from "../functions/command-dispatch.js";
import {
  isAuthorizedRequest,
  timingSafeTokenEqual,
} from "../functions/auth.js";
import {
  collectStateSnapshot,
  listQueueState,
  tailEventsEnvelope,
} from "../functions/state-snapshot.js";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";
const MAX_BODY_BYTES = 1024 * 1024;
const DEFAULT_MAX_WS_FRAME_BYTES = 1024 * 1024;
const DEFAULT_WS_HELLO_TIMEOUT_MS = 5000;
const WS_CLOSE_REASON_MAX_BYTES = 123;

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

function queryObject(url) {
  return Object.fromEntries(url.searchParams.entries());
}

async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_BODY_BYTES) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("invalid_json");
  }
}

function websocketAccept(key) {
  return crypto.createHash("sha1").update(`${key}${WS_GUID}`).digest("base64");
}

function encodeWsFrame(frame, opcode = 0x1) {
  const payload = Buffer.isBuffer(frame)
    ? frame
    : Buffer.from(typeof frame === "string" ? frame : JSON.stringify(frame), "utf8");
  const length = payload.length;
  let header;
  if (length < 126) {
    header = Buffer.alloc(2);
    header[1] = length;
  } else if (length <= 0xffff) {
    header = Buffer.alloc(4);
    header[1] = 126;
    header.writeUInt16BE(length, 2);
  } else {
    header = Buffer.alloc(10);
    header[1] = 127;
    header.writeBigUInt64BE(BigInt(length), 2);
  }
  header[0] = 0x80 | opcode;
  return Buffer.concat([header, payload]);
}

function wsCloseCodeForReason(reason = "") {
  switch (String(reason || "")) {
    case "":
      return 1000;
    case "ws_frame_too_large":
      return 1009;
    case "ws_protocol_error":
    case "ws_unsupported_extensions":
    case "ws_unsupported_opcode":
      return 1002;
    case "invalid_json":
      return 1007;
    case "internal":
      return 1011;
    default:
      return 1008;
  }
}

function encodeWsCloseFrame(reason = "", code = wsCloseCodeForReason(reason)) {
  const reasonBytes = Buffer.from(String(reason || ""), "utf8").subarray(0, WS_CLOSE_REASON_MAX_BYTES);
  const payload = Buffer.alloc(2 + reasonBytes.length);
  payload.writeUInt16BE(code, 0);
  reasonBytes.copy(payload, 2);
  return encodeWsFrame(payload, 0x8);
}

function decodeClientFrames(buffer, maxPayloadBytes = DEFAULT_MAX_WS_FRAME_BYTES) {
  const frames = [];
  let offset = 0;
  while (buffer.length - offset >= 2) {
    const first = buffer[offset];
    const second = buffer[offset + 1];
    const fin = (first & 0x80) !== 0;
    const rsv = first & 0x70;
    const opcode = first & 0x0f;
    const masked = (second & 0x80) !== 0;
    let length = second & 0x7f;
    let headerLength = 2;
    if (rsv !== 0) throw new Error("ws_unsupported_extensions");
    if (!masked) throw new Error("ws_protocol_error");
    if (length === 126) {
      if (buffer.length - offset < 4) break;
      length = buffer.readUInt16BE(offset + 2);
      headerLength = 4;
    } else if (length === 127) {
      if (buffer.length - offset < 10) break;
      const bigLength = buffer.readBigUInt64BE(offset + 2);
      if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error("ws_frame_too_large");
      length = Number(bigLength);
      headerLength = 10;
    }
    if (opcode >= 0x8 && (!fin || length > 125)) throw new Error("ws_protocol_error");
    if (length > maxPayloadBytes) throw new Error("ws_frame_too_large");
    const maskLength = masked ? 4 : 0;
    const frameLength = headerLength + maskLength + length;
    if (buffer.length - offset < frameLength) break;
    const mask = masked ? buffer.subarray(offset + headerLength, offset + headerLength + 4) : null;
    const payloadStart = offset + headerLength + maskLength;
    const payload = Buffer.from(buffer.subarray(payloadStart, payloadStart + length));
    if (mask) {
      for (let i = 0; i < payload.length; i += 1) payload[i] ^= mask[i % 4];
    }
    frames.push({ fin, opcode, payload });
    offset += frameLength;
  }
  return { frames, rest: buffer.subarray(offset) };
}

export class LocalServer {
  constructor({
    host = "127.0.0.1",
    port = 7531,
    token,
    instanceId,
    label,
    projectDir = process.cwd(),
    dispatch = dispatchBridgeCommandFrame,
    getHeadEventId = () => 0,
    tailBridgeEvents = null,
    maxWsFrameBytes = DEFAULT_MAX_WS_FRAME_BYTES,
    wsHelloTimeoutMs = DEFAULT_WS_HELLO_TIMEOUT_MS,
  } = {}) {
    this.host = host;
    this.port = port;
    this.token = token;
    this.instanceId = instanceId;
    this.label = label;
    this.projectDir = projectDir;
    this.dispatch = dispatch;
    this.getHeadEventId = getHeadEventId;
    this.tailBridgeEvents = tailBridgeEvents;
    this.maxWsFrameBytes = Math.max(1024, Number(maxWsFrameBytes) || DEFAULT_MAX_WS_FRAME_BYTES);
    this.wsHelloTimeoutMs = Math.max(1000, Number(wsHelloTimeoutMs) || DEFAULT_WS_HELLO_TIMEOUT_MS);
    this.server = null;
    this.clients = new Set();
  }

  start() {
    if (this.server) return Promise.resolve(this.address());
    this.server = http.createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        const status = err.message === "request_body_too_large" ? 413 : err.message === "invalid_json" ? 400 : 500;
        sendJson(res, status, { error: status === 500 ? "internal" : err.message || String(err) });
      });
    });
    this.server.on("upgrade", (req, socket, head) => this.handleUpgrade(req, socket, head));
    return new Promise((resolve, reject) => {
      const onError = (err) => {
        this.server?.off("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        this.server?.off("error", onError);
        resolve(this.address());
      };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      this.server.listen(this.port, this.host);
    });
  }

  address() {
    const address = this.server?.address?.();
    if (address && typeof address === "object") {
      return { host: address.address, port: address.port, url: `http://${address.address}:${address.port}` };
    }
    return { host: this.host, port: this.port, url: `http://${this.host}:${this.port}` };
  }

  async handleRequest(req, res) {
    const url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    if (url.pathname === "/healthz") {
      sendJson(res, 200, { ok: true });
      return;
    }
    if (!url.pathname.startsWith("/v1/")) {
      sendJson(res, 404, { error: "not_found" });
      return;
    }
    if (!isAuthorizedRequest(req, this.token)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }

    if (req.method === "GET" && url.pathname === "/v1/instance") {
      sendJson(res, 200, {
        protocol_version: BRIDGE_PROTOCOL_VERSION,
        instance_id: this.instanceId,
        label: this.label,
        project_dir: this.projectDir,
        commands: listAllowedBridgeCommands(),
      });
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/work-items") {
      sendJson(res, 200, listQueueState(queryObject(url)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/state") {
      sendJson(res, 200, collectStateSnapshot(queryObject(url)));
      return;
    }
    if (req.method === "GET" && url.pathname === "/v1/events") {
      const query = queryObject(url);
      if (typeof this.tailBridgeEvents === "function") {
        sendJson(res, 200, this.tailBridgeEvents({
          sinceEventId: query.since_event_id ?? query.sinceEventId ?? query.since_id ?? query.sinceId ?? null,
          limit: query.limit,
        }));
      } else {
        sendJson(res, 200, tailEventsEnvelope({
          workItemId: query.work_item_id ?? query.workItemId ?? null,
          sinceId: query.since_event_id ?? query.sinceEventId ?? query.since_id ?? query.sinceId ?? null,
          limit: query.limit,
        }));
      }
      return;
    }
    if (req.method === "POST" && url.pathname === "/v1/command") {
      const frame = await readJsonBody(req);
      const ack = await this.dispatch(frame, this.dispatchContext());
      sendJson(res, 200, ack);
      return;
    }

    sendJson(res, 404, { error: "not_found" });
  }

  handleUpgrade(req, socket, head) {
    let url;
    try {
      url = new URL(req.url || "/", `http://${this.host}:${this.port}`);
    } catch {
      socket.destroy();
      return;
    }
    if (url.pathname !== "/v1/stream") {
      socket.write("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    // Per protocol, authentication happens in the `hello` frame — not the
    // upgrade request. Browsers can't set Authorization headers on
    // WebSocket(), and putting tokens in the URL leaks them into proxy
    // access logs. Connections that don't send a valid hello within
    // `wsHelloTimeoutMs` are dropped (see helloTimer below).
    const key = req.headers["sec-websocket-key"];
    if (!key) {
      socket.write("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    socket.write([
      "HTTP/1.1 101 Switching Protocols",
      "Upgrade: websocket",
      "Connection: Upgrade",
      `Sec-WebSocket-Accept: ${websocketAccept(key)}`,
      "",
      "",
    ].join("\r\n"));
    const client = {
      socket,
      buffer: Buffer.from(head || ""),
      authenticated: false,
      fragment: null,
      closeDestroyTimer: null,
      helloTimer: null,
      closing: false,
    };
    client.helloTimer = setTimeout(() => {
      if (!client.authenticated) this.closeWs(client, "hello_timeout");
    }, this.wsHelloTimeoutMs);
    client.helloTimer.unref?.();
    this.clients.add(client);
    socket.on("data", (chunk) => this.handleWsData(client, chunk));
    socket.on("close", () => this.removeClient(client));
    socket.on("error", () => this.removeClient(client));
    if (client.buffer.length > 0) this.handleWsData(client, Buffer.alloc(0));
  }

  handleWsData(client, chunk) {
    if (client?.closing || client?.socket?.destroyed) return;
    if (client.buffer.length + chunk.length > this.maxWsFrameBytes + 14) {
      this.sendWs(client, createErrorAck(null, "ws_frame_too_large"));
      this.closeWs(client, "ws_frame_too_large");
      return;
    }
    client.buffer = Buffer.concat([client.buffer, chunk]);
    let decoded;
    try {
      decoded = decodeClientFrames(client.buffer, this.maxWsFrameBytes);
    } catch (err) {
      this.sendWs(client, createErrorAck(null, err.message || String(err)));
      this.closeWs(client, err.message || String(err));
      return;
    }
    client.buffer = decoded.rest;
    for (const frame of decoded.frames) {
      if (frame.opcode === 0x8) {
        this.closeWs(client, "");
      } else if (frame.opcode === 0x9) {
        client.socket.write(encodeWsFrame(frame.payload, 0xA));
      } else if (frame.opcode === 0xA) {
        continue;
      } else if (frame.opcode === 0x0) {
        this.handleWsContinuation(client, frame);
      } else if (frame.opcode === 0x1) {
        this.handleWsTextFrame(client, frame);
      } else {
        this.failWsProtocol(client, "ws_unsupported_opcode");
      }
    }
  }

  failWsProtocol(client, reason) {
    this.sendWs(client, createErrorAck(client.authenticated ? null : "hello", reason));
    this.closeWs(client, reason);
  }

  handleWsTextFrame(client, frame) {
    if (client.fragment) {
      this.failWsProtocol(client, "ws_protocol_error");
      return;
    }
    if (frame.fin) {
      void this.handleWsText(client, frame.payload.toString("utf8"));
      return;
    }
    client.fragment = {
      opcode: frame.opcode,
      chunks: [frame.payload],
      length: frame.payload.length,
    };
  }

  handleWsContinuation(client, frame) {
    if (!client.fragment) {
      this.failWsProtocol(client, "ws_protocol_error");
      return;
    }
    client.fragment.chunks.push(frame.payload);
    client.fragment.length += frame.payload.length;
    if (client.fragment.length > this.maxWsFrameBytes) {
      this.sendWs(client, createErrorAck(client.authenticated ? null : "hello", "ws_frame_too_large"));
      this.closeWs(client, "ws_frame_too_large");
      return;
    }
    if (!frame.fin) return;
    const fragment = client.fragment;
    client.fragment = null;
    const payload = Buffer.concat(fragment.chunks, fragment.length);
    if (fragment.opcode === 0x1) {
      void this.handleWsText(client, payload.toString("utf8"));
    }
  }

  dispatchContext() {
    return {
      projectDir: this.projectDir,
      actor: "bridge",
      tailBridgeEvents: typeof this.tailBridgeEvents === "function" ? this.tailBridgeEvents : null,
      getHeadEventId: typeof this.getHeadEventId === "function" ? this.getHeadEventId : null,
    };
  }

  async handleWsText(client, text) {
    let frame;
    try {
      frame = JSON.parse(text);
    } catch {
      this.sendWs(client, createErrorAck(client.authenticated ? null : "hello", "invalid_json"));
      if (!client.authenticated) this.closeWs(client, "invalid_json");
      return;
    }
    if (!frame || typeof frame !== "object" || Array.isArray(frame)) {
      this.sendWs(client, createErrorAck(client.authenticated ? null : "hello", "invalid_args"));
      if (!client.authenticated) this.closeWs(client, "invalid_args");
      return;
    }
    if (Number(frame.v) !== BRIDGE_PROTOCOL_VERSION) {
      this.sendWs(client, createErrorAck(frame.id ?? frame.command_id ?? "hello", "unsupported_version"));
      this.closeWs(client, "unsupported_version");
      return;
    }
    if (!client.authenticated) {
      this.handleHelloFrame(client, frame);
      return;
    }
    if (frame.type === BRIDGE_FRAME_TYPES.PING) {
      this.sendWs(client, { v: BRIDGE_PROTOCOL_VERSION, type: BRIDGE_FRAME_TYPES.PONG });
      return;
    }
    if (frame.type === BRIDGE_FRAME_TYPES.PONG) return;
    if (frame.type !== BRIDGE_FRAME_TYPES.COMMAND) {
      this.sendWs(client, createErrorAck(frame.id ?? frame.command_id ?? null, "unknown_command"));
      return;
    }
    try {
      const ack = await this.dispatch(frame, this.dispatchContext());
      this.sendWs(client, ack);
    } catch (err) {
      this.sendWs(client, createErrorAck(frame?.id ?? frame?.command_id ?? null, "internal"));
    }
  }

  handleHelloFrame(client, frame) {
    if (frame.type !== BRIDGE_FRAME_TYPES.HELLO) {
      this.sendWs(client, createErrorAck("hello", "unauthorized", "hello_required"));
      this.closeWs(client, "hello_required");
      return;
    }
    if (!timingSafeTokenEqual(frame.bearer || "", this.token)) {
      this.sendWs(client, createErrorAck("hello", "unauthorized"));
      this.closeWs(client, "unauthorized");
      return;
    }
    client.authenticated = true;
    if (client.helloTimer) {
      clearTimeout(client.helloTimer);
      client.helloTimer = null;
    }
    this.sendWs(client, {
      v: BRIDGE_PROTOCOL_VERSION,
      type: BRIDGE_FRAME_TYPES.HELLO,
      role: "bridge",
      instance_id: this.instanceId,
      label: this.label,
    });
    this.sendSnapshot(client);
  }

  sendSnapshot(client) {
    const headEventId = Number(this.getHeadEventId?.() || 0);
    const payload = collectStateSnapshot({ headEventId });
    const frame = createBridgeEventFrame(BRIDGE_EVENT_KINDS.SNAPSHOT, payload, {
      instanceId: this.instanceId,
      eventId: 0,
    });
    this.sendWs(client, frame);
  }

  sendWs(client, frame) {
    if (!client?.socket || client.socket.destroyed || client.closing) return false;
    client.socket.write(encodeWsFrame(frame));
    return true;
  }

  broadcast(frame) {
    for (const client of this.clients) {
      if (client.authenticated) this.sendWs(client, frame);
    }
  }

  removeClient(client) {
    if (client?.closeDestroyTimer) {
      clearTimeout(client.closeDestroyTimer);
      client.closeDestroyTimer = null;
    }
    if (client?.helloTimer) {
      clearTimeout(client.helloTimer);
      client.helloTimer = null;
    }
    this.clients.delete(client);
  }

  closeWs(client, reason = "") {
    if (client) client.closing = true;
    try { client.socket.end(encodeWsCloseFrame(reason)); } catch {}
    if (client?.closeDestroyTimer || !client?.socket || client.socket.destroyed) return;
    client.closeDestroyTimer = setTimeout(() => {
      client.closeDestroyTimer = null;
      try { client.socket.destroy(); } catch {}
    }, 2000);
    client.closeDestroyTimer.unref?.();
  }

  close() {
    for (const client of this.clients) {
      this.closeWs(client, "");
      try { client.socket.destroy(); } catch {}
    }
    this.clients.clear();
    if (!this.server) return Promise.resolve();
    const server = this.server;
    this.server = null;
    return new Promise((resolve) => {
      try {
        server.close(() => resolve());
      } catch {
        resolve();
      }
    });
  }
}

export const __testEncodeWsFrame = encodeWsFrame;
export const __testDecodeClientFrames = decodeClientFrames;
