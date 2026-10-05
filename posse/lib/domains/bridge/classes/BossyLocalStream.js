import crypto from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";

import {
  BOSSY_LOCAL_STREAM_PROTOCOL,
  BRIDGE_FRAME_TYPES,
  BRIDGE_PROTOCOL_VERSION,
} from "../../../catalog/bridge.js";
import { getRuntimeDbPath } from "../../runtime/functions/paths.js";
import { ChangeStream } from "./ChangeStream.js";

export { BOSSY_LOCAL_STREAM_PROTOCOL } from "../../../catalog/bridge.js";
const MAX_FRAME_BYTES = 1024 * 1024;
const MAX_CLIENT_BUFFER_BYTES = 2 * MAX_FRAME_BYTES;
const LOCAL_REPLAY_LIMIT = 256;

export function normalizeBossyStreamRepoPath(projectDir = process.cwd(), platform = process.platform) {
  let normalized = path.resolve(projectDir).replaceAll("\\", "/");
  if (platform === "win32") normalized = normalized.toLowerCase();
  return normalized;
}

export function getBossyLocalStreamPath(projectDir = process.cwd(), platform = process.platform) {
  const normalized = normalizeBossyStreamRepoPath(projectDir, platform);
  const hash = crypto.createHash("sha256").update(normalized, "utf8").digest("hex").slice(0, 16);
  if (platform !== "win32") {
    const repoSocket = path.join(normalized, ".posse", "run", "bossy.sock");
    const maxBytes = platform === "linux" ? 107 : 103;
    if (Buffer.byteLength(repoSocket) <= maxBytes) return repoSocket;
    return path.join("/tmp", `posse-bossy-${process.getuid()}`, `${hash}.sock`);
  }
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
    this.ownsChangeStream = changeStream == null;
    this.pollMs = pollMs;
    this.server = null;
    this.socketPathPrepared = false;
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
      await this.prepareSocketPath();

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
        // Mark the endpoint as ours only after listen succeeds. A competing
        // producer may win the race between the stale-path probe and bind;
        // failed startup must never unlink that producer's live socket.
        this.socketPathPrepared = true;
        try { fs.chmodSync(this.socketPath, 0o600); } catch { /* best effort */ }
      }
      return { path: this.socketPath };
    } catch (err) {
      await this.close();
      throw err;
    }
  }

  async prepareSocketPath() {
    if (process.platform === "win32") return;
    const socketDir = path.dirname(this.socketPath);
    fs.mkdirSync(socketDir, { recursive: true, mode: 0o700 });
    if (socketDir === path.join("/tmp", `posse-bossy-${process.getuid()}`)) {
      const stat = fs.lstatSync(socketDir);
      if (!stat.isDirectory() || stat.uid !== process.getuid() || (stat.mode & 0o077) !== 0) {
        throw new Error(`Bossy socket directory is not private to the current user: ${socketDir}`);
      }
    }
    let stat;
    try {
      stat = fs.lstatSync(this.socketPath);
    } catch (err) {
      if (err?.code === "ENOENT") return;
      throw err;
    }
    if (!stat.isSocket()) {
      const err = new Error(`Bossy local stream endpoint is occupied by a non-socket: ${this.socketPath}`);
      err.code = "EADDRINUSE";
      throw err;
    }

    // Runs and `posse serve` intentionally share this well-known endpoint.
    // Never unlink a live producer: doing so leaves its existing clients on
    // an unreachable inode and lets the second producer steal the path. Only
    // ECONNREFUSED proves the filesystem entry is stale enough to remove.
    const probe = await new Promise((resolve) => {
      const socket = net.createConnection(this.socketPath);
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.destroy();
        resolve(result);
      };
      const timer = setTimeout(() => finish({ live: true }), 250);
      socket.once("connect", () => finish({ live: true }));
      socket.once("error", (err) => finish({ live: false, err }));
    });
    if (probe.live || !["ECONNREFUSED", "ENOENT"].includes(probe.err?.code)) {
      const err = new Error(`Bossy local stream endpoint is already served: ${this.socketPath}`);
      err.code = "EADDRINUSE";
      throw err;
    }
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
      instance_id: String(this.changeStream?.instanceId || "local"),
    });
    const headEventId = Number(this.changeStream?.headEventId?.() || 0);
    const replay = this.changeStream?.tailFrames?.({ sinceEventId: 0, limit: LOCAL_REPLAY_LIMIT }) || {
      events: [],
      head_event_id: headEventId,
      replay_start_event_id: headEventId + 1,
      replay_complete: true,
    };
    this.send(socket, eventFrame({
      event_id: headEventId,
      kind: "snapshot",
      payload: {
        head_event_id: headEventId,
        replay_start_event_id: Number(replay.replay_start_event_id ?? headEventId + 1),
        replay_complete: replay.replay_complete !== false,
      },
      ts: new Date().toISOString(),
    }));
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
    if (this.ownsChangeStream) {
      try { this.changeStream?.close?.(); } catch { /* best effort */ }
    }
    this.changeStream = null;
    if (process.platform !== "win32" && this.socketPathPrepared) {
      try { fs.rmSync(this.socketPath, { force: true }); } catch { /* best effort */ }
      this.socketPathPrepared = false;
    }
  }
}
