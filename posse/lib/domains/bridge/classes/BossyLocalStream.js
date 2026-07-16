import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import { BRIDGE_FRAME_TYPES, BRIDGE_PROTOCOL_VERSION } from "../../../catalog/bridge.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import { ChangeStream } from "./ChangeStream.js";

export const BOSSY_LOCAL_STREAM_PROTOCOL = "posse.local_stream.v1";
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_CLIENT_BUFFER_BYTES = 2 * MAX_FRAME_BYTES;

export function normalizeBossyStreamRepoPath(projectDir = process.cwd(), platform = process.platform) {
  let normalized = path.resolve(projectDir).replaceAll("\\", "/");
  if (platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

export function getBossyLocalStreamPath(projectDir = process.cwd(), platform = process.platform) {
  const normalized = normalizeBossyStreamRepoPath(projectDir, platform);
  if (platform !== "win32") return path.join(normalized, ".posse", "run", "bossy.sock");
  const hash = crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
  return `\\\\.\\pipe\\posse-bossy-${hash}`;
}

function eventFrame(frame) {
  return {
    v: BRIDGE_PROTOCOL_VERSION,
    type: BRIDGE_FRAME_TYPES.EVENT,
    ...frame,
  };
}

// BossyLocalStream is a narrow, read-only same-device adapter. It deliberately
// shares ChangeStream's event envelopes without sharing the HTTP/WebSocket
// bridge, pairing state, settings, or command surface.
export class BossyLocalStream {
  constructor({
    projectDir = process.cwd(),
    socketPath = getBossyLocalStreamPath(projectDir),
    changeStream = null,
    pollMs = 500,
  } = {}) {
    this.projectDir = path.resolve(projectDir);
    this.socketPath = socketPath;
    this.changeStream = changeStream;
    this.pollMs = pollMs;
    this.server = null;
    this.clients = new Set();
    this.onFrame = (frame) => this.broadcast(frame);
  }

  async start() {
    if (this.server) return { path: this.socketPath };
    try {
      if (!this.changeStream) {
        this.changeStream = new ChangeStream({
          dbPath: getRuntimeDbPath(this.projectDir),
          pollMs: this.pollMs,
        });
      }
      this.changeStream.start();
      this.changeStream.on("frame", this.onFrame);
      this.prepareSocketPath();

      const server = net.createServer((socket) => this.accept(socket));
      this.server = server;
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.off("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.off("error", onError);
          resolve();
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(this.socketPath);
      });
      server.on("error", () => {}); // lifecycle errors degrade to SQLite in Bossy
      server.unref?.();
      if (process.platform !== "win32") {
        try { fs.chmodSync(this.socketPath, 0o600); } catch { /* best effort */ }
      }
      return { path: this.socketPath };
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  prepareSocketPath() {
    if (process.platform === "win32") return;
    fs.mkdirSync(path.dirname(this.socketPath), { recursive: true, mode: 0o700 });
    try { fs.rmSync(this.socketPath, { force: true }); } catch { /* listen reports residual failures */ }
  }

  accept(socket) {
    this.clients.add(socket);
    socket.on("close", () => this.clients.delete(socket));
    socket.on("error", () => this.clients.delete(socket));
    socket.once("data", () => socket.destroy()); // this transport is producer-only

    this.send(socket, {
      v: BRIDGE_PROTOCOL_VERSION,
      type: BRIDGE_FRAME_TYPES.HELLO,
      role: "posse",
      protocol: BOSSY_LOCAL_STREAM_PROTOCOL,
      repo_path: normalizeBossyStreamRepoPath(this.projectDir),
    });
    const headEventId = Number(this.changeStream?.headEventId?.() || 0);
    this.send(socket, eventFrame({
      event_id: 0,
      kind: "snapshot",
      payload: { head_event_id: headEventId },
      ts: new Date().toISOString(),
    }));
    const replay = this.changeStream?.tailFrames?.({ sinceEventId: 0, limit: 500 });
    for (const frame of replay?.events || []) this.send(socket, eventFrame(frame));
  }

  send(socket, frame) {
    if (!socket || socket.destroyed) return false;
    let line;
    try {
      line = `${JSON.stringify(frame)}\n`;
    } catch {
      socket.destroy();
      return false;
    }
    if (Buffer.byteLength(line) > MAX_FRAME_BYTES || socket.writableLength > MAX_CLIENT_BUFFER_BYTES) {
      socket.destroy();
      return false;
    }
    try {
      socket.write(line);
      return true;
    } catch {
      socket.destroy();
      return false;
    }
  }

  broadcast(frame) {
    for (const socket of this.clients) this.send(socket, frame);
  }

  async close() {
    this.changeStream?.off?.("frame", this.onFrame);
    for (const socket of this.clients) {
      try { socket.destroy(); } catch { /* best effort */ }
    }
    this.clients.clear();

    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise((resolve) => {
        try { server.close(() => resolve()); } catch { resolve(); }
      });
    }
    try { this.changeStream?.close?.(); } catch { /* best effort */ }
    this.changeStream = null;
    if (process.platform !== "win32") {
      try { fs.rmSync(this.socketPath, { force: true }); } catch { /* best effort */ }
    }
  }
}
