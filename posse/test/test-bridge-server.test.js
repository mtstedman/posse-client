import { describe, it } from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import net from "node:net";

import { Bridge } from "../lib/domains/bridge/classes/Bridge.js";
import { LocalServer } from "../lib/domains/bridge/classes/LocalServer.js";
import { RelayClient } from "../lib/domains/bridge/classes/RelayClient.js";
import {
  createWorkItem,
  flushEventsNow,
  logEvent,
} from "../lib/domains/queue/functions/index.js";
import { withTempRuntimeDb } from "./helpers/regression-test-harness.js";

function wsUrl(httpUrl) {
  // Per protocol the bearer goes in the hello frame, not the URL or
  // headers. We keep the helper so tests stay readable.
  return `${httpUrl.replace(/^http:/, "ws:")}/v1/stream`;
}

async function openWebSocket(url) {
  const ws = new WebSocket(url);
  const messages = [];
  const waiters = [];
  ws.addEventListener("message", (event) => {
    const parsed = JSON.parse(String(event.data));
    const waiter = waiters.shift();
    if (waiter) waiter(parsed);
    else messages.push(parsed);
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("websocket open timed out")), 2000);
    ws.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
    ws.addEventListener("error", (event) => {
      clearTimeout(timer);
      reject(event.error || new Error("websocket error"));
    }, { once: true });
  });
  return {
    ws,
    nextMessage() {
      if (messages.length > 0) return Promise.resolve(messages.shift());
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error("websocket message timed out")), 2000);
        waiters.push((message) => {
          clearTimeout(timer);
          resolve(message);
        });
      });
    },
  };
}

function encodeMaskedClientFrame(text, { fin = true, opcode = 0x1 } = {}) {
  const payload = Buffer.from(String(text), "utf8");
  const mask = Buffer.from([0x11, 0x22, 0x33, 0x44]);
  let header;
  if (payload.length < 126) {
    header = Buffer.alloc(2);
    header[1] = 0x80 | payload.length;
  } else {
    header = Buffer.alloc(4);
    header[1] = 0x80 | 126;
    header.writeUInt16BE(payload.length, 2);
  }
  header[0] = (fin ? 0x80 : 0) | opcode;
  const masked = Buffer.alloc(payload.length);
  for (let i = 0; i < payload.length; i += 1) masked[i] = payload[i] ^ mask[i % 4];
  return Buffer.concat([header, mask, masked]);
}

function waitForSocketEvent(socket, event) {
  return new Promise((resolve, reject) => {
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onEvent = (...args) => {
      cleanup();
      resolve(args);
    };
    const cleanup = () => {
      socket.off("error", onError);
      socket.off(event, onEvent);
    };
    socket.once("error", onError);
    socket.once(event, onEvent);
  });
}

function readUpgradeResponse(socket) {
  return new Promise((resolve, reject) => {
    let buffer = Buffer.alloc(0);
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("websocket upgrade timed out"));
    }, 2000);
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      buffer = Buffer.concat([buffer, chunk]);
      const idx = buffer.indexOf("\r\n\r\n");
      if (idx < 0) return;
      cleanup();
      const head = buffer.subarray(0, idx).toString("utf8");
      if (!/^HTTP\/1\.1 101\b/.test(head)) {
        reject(new Error(`unexpected upgrade response: ${head.split("\r\n")[0]}`));
        return;
      }
      resolve(buffer.subarray(idx + 4));
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("data", onData);
    };
    socket.on("error", onError);
    socket.on("data", onData);
  });
}

async function openRawWebSocket(httpUrl) {
  const target = new URL(httpUrl);
  const socket = net.createConnection({ host: target.hostname, port: Number(target.port) });
  await waitForSocketEvent(socket, "connect");
  const key = crypto.randomBytes(16).toString("base64");
  socket.write([
    "GET /v1/stream HTTP/1.1",
    `Host: ${target.host}`,
    "Upgrade: websocket",
    "Connection: Upgrade",
    `Sec-WebSocket-Key: ${key}`,
    "Sec-WebSocket-Version: 13",
    "",
    "",
  ].join("\r\n"));
  const rest = await readUpgradeResponse(socket);
  return { socket, rest };
}

async function readServerTextFrame(socket, initial = Buffer.alloc(0)) {
  let buffer = initial;
  const nextChunk = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("websocket frame timed out"));
    }, 2000);
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      cleanup();
      resolve(chunk);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("data", onData);
    };
    socket.once("error", onError);
    socket.once("data", onData);
  });

  while (true) {
    if (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let headerLength = 2;
      if (length === 126 && buffer.length >= 4) {
        length = buffer.readUInt16BE(2);
        headerLength = 4;
      }
      if (length < 126 || buffer.length >= headerLength) {
        const frameLength = headerLength + length;
        if (buffer.length >= frameLength) {
          assert.equal(opcode, 0x1);
          return buffer.subarray(headerLength, frameLength).toString("utf8");
        }
      }
    }
    buffer = Buffer.concat([buffer, await nextChunk()]);
  }
}

async function readServerFrameMatching(socket, matches, initial = Buffer.alloc(0)) {
  let buffer = initial;
  const nextChunk = () => new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("websocket frame timed out"));
    }, 2000);
    const onError = (err) => {
      cleanup();
      reject(err);
    };
    const onData = (chunk) => {
      cleanup();
      resolve(chunk);
    };
    const cleanup = () => {
      clearTimeout(timer);
      socket.off("error", onError);
      socket.off("data", onData);
    };
    socket.once("error", onError);
    socket.once("data", onData);
  });

  while (true) {
    while (buffer.length >= 2) {
      const opcode = buffer[0] & 0x0f;
      let length = buffer[1] & 0x7f;
      let headerLength = 2;
      if (length === 126) {
        if (buffer.length < 4) break;
        length = buffer.readUInt16BE(2);
        headerLength = 4;
      } else if (length === 127) {
        if (buffer.length < 10) break;
        const bigLength = buffer.readBigUInt64BE(2);
        assert.ok(bigLength <= BigInt(Number.MAX_SAFE_INTEGER));
        length = Number(bigLength);
        headerLength = 10;
      }
      const frameLength = headerLength + length;
      if (buffer.length < frameLength) break;
      const payload = buffer.subarray(headerLength, frameLength);
      const frame = { opcode, payload };
      if (opcode === 0x8 && payload.length >= 2) {
        frame.code = payload.readUInt16BE(0);
        frame.reason = payload.subarray(2).toString("utf8");
      }
      buffer = buffer.subarray(frameLength);
      if (matches(frame)) return frame;
    }
    buffer = Buffer.concat([buffer, await nextChunk()]);
  }
}

class FakeRelaySocket {
  static OPEN = 1;
  static instances = [];

  constructor(url) {
    this.url = url;
    this.readyState = 0;
    this.sent = [];
    this.listeners = new Map();
    FakeRelaySocket.instances.push(this);
  }

  addEventListener(type, handler) {
    const list = this.listeners.get(type) || [];
    list.push(handler);
    this.listeners.set(type, list);
  }

  dispatch(type, event = {}) {
    for (const handler of this.listeners.get(type) || []) handler(event);
  }

  send(payload) {
    this.sent.push(payload);
  }

  open() {
    this.readyState = FakeRelaySocket.OPEN;
    this.dispatch("open", {});
  }

  fail(error) {
    this.dispatch("error", { error });
  }

  close() {
    this.readyState = 3;
    this.dispatch("close", {});
  }
}

describe("bridge local server", () => {
  it("requires bearer auth and exposes instance metadata on loopback", () => withTempRuntimeDb(async (projectDir) => {
    createWorkItem("Server item", "served over HTTP");
    const server = new LocalServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      instanceId: "posse-test",
      label: "Test bridge",
      projectDir,
    });
    const { url } = await server.start();
    try {
      const denied = await fetch(`${url}/v1/instance`);
      assert.equal(denied.status, 401);

      const allowed = await fetch(`${url}/v1/instance`, {
        headers: { authorization: "Bearer test-token" },
      });
      assert.equal(allowed.status, 200);
      const body = await allowed.json();
      assert.equal(body.instance_id, "posse-test");
      assert.equal(body.label, "Test bridge");
      assert.ok(body.commands.includes("queue.list"));
      assert.ok(body.commands.includes("ask"));

      const queue = await fetch(`${url}/v1/work-items`, {
        headers: { authorization: "Bearer test-token" },
      });
      assert.equal(queue.status, 200);
      const queueBody = await queue.json();
      assert.equal(queueBody.total, 1);
    } finally {
      await server.close();
    }
  }));

  it("returns an events tail envelope over HTTP without a ChangeStream context", () => withTempRuntimeDb(async (projectDir) => {
    logEvent({
      event_type: "system.bridge_tail.http_fallback",
      actor_type: "system",
      message: "HTTP fallback event",
    });
    flushEventsNow();
    const server = new LocalServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      instanceId: "posse-test",
      label: "Test bridge",
      projectDir,
    });
    const { url } = await server.start();
    try {
      const response = await fetch(`${url}/v1/events?since_event_id=0&limit=10`, {
        headers: { authorization: "Bearer test-token" },
      });
      assert.equal(response.status, 200);
      const body = await response.json();
      assert.equal(Array.isArray(body.events), true);
      assert.equal(body.events.length, 1);
      assert.equal(body.events[0].event_type, "system.bridge_tail.http_fallback");
      assert.equal(body.head_event_id, Number(body.events[0].id));
    } finally {
      await server.close();
    }
  }));

  it("requires hello on websocket, sends snapshot, and answers ping", () => withTempRuntimeDb(async (projectDir) => {
    createWorkItem("Socket item", "visible in snapshot");
    const server = new LocalServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      instanceId: "posse-test",
      label: "Test bridge",
      projectDir,
      getHeadEventId: () => 7,
    });
    const { url } = await server.start();
    const client = await openWebSocket(wsUrl(url));
    try {
      client.ws.send(JSON.stringify({ v: 1, type: "hello", role: "client", bearer: "test-token" }));
      const hello = await client.nextMessage();
      assert.equal(hello.v, 1);
      assert.equal(hello.type, "hello");
      assert.equal(hello.role, "bridge");

      const snapshot = await client.nextMessage();
      assert.equal(snapshot.v, 1);
      assert.equal(snapshot.type, "event");
      assert.equal(snapshot.kind, "snapshot");
      assert.equal(snapshot.event_id, 0);
      assert.equal(snapshot.payload.head_event_id, 7);
      assert.equal(snapshot.payload.work_items.length, 1);

      client.ws.send(JSON.stringify({ v: 1, type: "ping" }));
      const pong = await client.nextMessage();
      assert.deepEqual(pong, { v: 1, type: "pong" });
    } finally {
      try { client.ws.close(); } catch {}
      await server.close();
    }
  }));

  it("closes websocket clients that don't send hello before the timeout", () => withTempRuntimeDb(async (projectDir) => {
    const server = new LocalServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      instanceId: "posse-test",
      label: "Test bridge",
      projectDir,
      wsHelloTimeoutMs: 100,
    });
    const { url } = await server.start();
    const client = await openWebSocket(wsUrl(url));
    try {
      const closed = new Promise((resolve) => {
        client.ws.addEventListener("close", () => resolve(true), { once: true });
      });
      const timedOut = new Promise((resolve) => setTimeout(() => resolve(false), 1500));
      const winner = await Promise.race([closed, timedOut]);
      assert.equal(winner, true, "expected server to close the socket on hello timeout");
      // Give the server's TCP-close handler a few ticks to run removeClient.
      const deadline = Date.now() + 1000;
      while (server.clients.size > 0 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 20));
      }
      assert.equal(server.clients.size, 0);
    } finally {
      try { client.ws.close(); } catch {}
      await server.close();
    }
  }));

  it("closes websocket clients with the wrong hello bearer", () => withTempRuntimeDb(async (projectDir) => {
    const server = new LocalServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      instanceId: "posse-test",
      label: "Test bridge",
      projectDir,
    });
    const { url } = await server.start();
    const client = await openWebSocket(wsUrl(url));
    try {
      client.ws.send(JSON.stringify({ v: 1, type: "hello", role: "client", bearer: "wrong" }));
      const ack = await client.nextMessage();
      assert.equal(ack.type, "ack");
      assert.equal(ack.ok, false);
      assert.equal(ack.error.code, "unauthorized");
    } finally {
      try { client.ws.close(); } catch {}
      await server.close();
    }
  }));

  it("sends RFC-compliant websocket close codes with reason text", () => withTempRuntimeDb(async (projectDir) => {
    const server = new LocalServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      instanceId: "posse-test",
      label: "Test bridge",
      projectDir,
    });
    const { url } = await server.start();
    const { socket, rest } = await openRawWebSocket(url);
    try {
      socket.write(encodeMaskedClientFrame(JSON.stringify({
        v: 1,
        type: "hello",
        role: "client",
        bearer: "wrong",
      })));
      const close = await readServerFrameMatching(socket, (frame) => frame.opcode === 0x8, rest);
      assert.equal(close.code, 1008);
      assert.equal(close.reason, "unauthorized");
    } finally {
      try { socket.destroy(); } catch {}
      await server.close();
    }
  }));

  it("accepts fragmented websocket text frames", () => withTempRuntimeDb(async (projectDir) => {
    const server = new LocalServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      instanceId: "posse-test",
      label: "Test bridge",
      projectDir,
    });
    const { url } = await server.start();
    const { socket, rest } = await openRawWebSocket(url);
    try {
      const hello = JSON.stringify({ v: 1, type: "hello", role: "client", bearer: "test-token" });
      socket.write(Buffer.concat([
        encodeMaskedClientFrame(hello.slice(0, 12), { fin: false, opcode: 0x1 }),
        encodeMaskedClientFrame(hello.slice(12), { fin: true, opcode: 0x0 }),
      ]));

      const frame = JSON.parse(await readServerTextFrame(socket, rest));
      assert.equal(frame.type, "hello");
      assert.equal(frame.role, "bridge");
    } finally {
      try { socket.destroy(); } catch {}
      await server.close();
    }
  }));

  it("rejects unmasked websocket client frames", () => withTempRuntimeDb(async (projectDir) => {
    const server = new LocalServer({
      host: "127.0.0.1",
      port: 0,
      token: "test-token",
      instanceId: "posse-test",
      label: "Test bridge",
      projectDir,
    });
    const { url } = await server.start();
    const { socket, rest } = await openRawWebSocket(url);
    try {
      assert.equal(rest.length, 0);
      const hello = JSON.stringify({ v: 1, type: "hello", role: "client", bearer: "test-token" });
      socket.write(Buffer.concat([
        Buffer.from([0x81, Buffer.byteLength(hello)]),
        Buffer.from(hello),
      ]));
      const frame = JSON.parse(await readServerTextFrame(socket));
      assert.equal(frame.type, "ack");
      assert.equal(frame.ok, false);
      assert.equal(frame.error.code, "ws_protocol_error");
    } finally {
      try { socket.destroy(); } catch {}
      await server.close();
    }
  }));

  it("does not emit an unhandled EventEmitter error for relay socket errors", () => {
    FakeRelaySocket.instances.length = 0;
    const relay = new RelayClient({
      url: "wss://relay.example.test/v1/instance",
      token: "relay-token",
      instanceId: "posse-test",
      label: "Test bridge",
      WebSocketImpl: FakeRelaySocket,
    });
    try {
      assert.deepEqual(relay.start(), { ok: true });
      const socket = FakeRelaySocket.instances[0];
      assert.ok(socket);
      assert.doesNotThrow(() => socket.fail(new Error("relay failed")));
    } finally {
      relay.stop();
    }
  });

  it("cleans up the change stream if the bridge HTTP bind fails", () => withTempRuntimeDb(async (projectDir) => {
    createWorkItem("Bridge startup cleanup", "seed runtime db");
    const holder = net.createServer();
    await new Promise((resolve, reject) => {
      holder.once("error", reject);
      holder.listen(0, "127.0.0.1", resolve);
    });
    const port = holder.address().port;
    const bridge = new Bridge({
      projectDir,
      pollMs: 100,
      config: {
        bindHost: "127.0.0.1",
        port,
        token: "test-token",
        relayToken: "",
        relayUrl: "wss://relay.example.test/v1/instance",
        instanceId: "posse-test",
        label: "Test bridge",
      },
    });
    try {
      await assert.rejects(() => bridge.start(), /EADDRINUSE|address already in use/i);
      assert.equal(bridge.changeStream, null);
      assert.equal(bridge.localServer, null);
      assert.equal(bridge.relayClient, null);
    } finally {
      await bridge.stop();
      await new Promise((resolve) => holder.close(() => resolve()));
    }
  }));
});
