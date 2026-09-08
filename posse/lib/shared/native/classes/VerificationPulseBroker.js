// A command-lifetime capability broker for repository verification. The
// verifier keeps POSSE_KEY; child processes receive only an unguessable local
// socket capability that can mint a small allowlist of native service routes.

import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

import {
  ATLAS_VECTOR_NATIVE_ROUTE,
  GIT_MUTATE_ROUTE,
  GIT_READ_ROUTE,
  ML_NATIVE_ROUTE,
  REMOTE_CATALOG_READ_ROUTE,
  REMOTE_PROMPTS_BUNDLE_ROUTE,
  REMOTE_PROMPTS_COMPILE_ROUTE,
} from "../../../catalog/binary.js";
import { VERIFICATION_PULSE_CAPABILITY_ENV } from "../../../catalog/process.js";
import { NativeAuthHandshake } from "./NativeAuthHandshake.js";
import { heartbeatAuthManager } from "./HeartbeatAuthManager.js";
import { pulseTokenManager } from "./PulseTokenManager.js";

export { VERIFICATION_PULSE_CAPABILITY_ENV } from "../../../catalog/process.js";
export const VERIFICATION_NATIVE_ROUTES = Object.freeze([
  "atlas:methods",
  ATLAS_VECTOR_NATIVE_ROUTE,
  GIT_READ_ROUTE,
  GIT_MUTATE_ROUTE,
  ML_NATIVE_ROUTE,
  REMOTE_PROMPTS_COMPILE_ROUTE,
  REMOTE_PROMPTS_BUNDLE_ROUTE,
  REMOTE_CATALOG_READ_ROUTE,
]);

const MAX_REQUEST_BYTES = 64 * 1024;

function defaultPipePath() {
  const id = crypto.randomUUID();
  return process.platform === "win32"
    ? `\\\\.\\pipe\\posse-verification-pulse-${process.pid}-${id}`
    : path.join(os.tmpdir(), `posse-vpulse-${process.pid}-${id}.sock`);
}

function tokenEqual(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
}

function bearer(req) {
  const match = String(req?.headers?.authorization || "").match(/^Bearer\s+(.+)$/i);
  return match?.[1] || "";
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json",
    "content-length": Buffer.byteLength(data),
  });
  res.end(data);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_REQUEST_BYTES) throw Object.assign(new Error("request too large"), { code: "REQUEST_TOO_LARGE" });
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

export class VerificationPulseBroker {
  constructor({
    pipePath = defaultPipePath(),
    token = crypto.randomBytes(32).toString("base64url"),
    allowedRoutes = VERIFICATION_NATIVE_ROUTES,
    pulseManager = pulseTokenManager,
    trustedOrigin = new URL(heartbeatAuthManager.getNativeAuthEnvelope().heartbeatUrl).origin,
  } = {}) {
    this.pipePath = pipePath;
    this.token = token;
    this.allowedRoutes = new Set(allowedRoutes);
    this.handshake = new NativeAuthHandshake({ pulseManager });
    this.trustedOrigin = trustedOrigin;
    this.server = null;
    this.sockets = new Set();
  }

  capability() {
    return Object.freeze({
      version: 1,
      pipePath: this.pipePath,
      token: this.token,
      timeoutMs: 15_000,
      trustedOrigin: this.trustedOrigin,
    });
  }

  async start() {
    if (this.server) return this.capability();
    if (process.platform !== "win32") {
      try { fs.rmSync(this.pipePath, { force: true }); } catch { /* best effort */ }
    }
    const server = http.createServer((req, res) => {
      this.#handle(req, res).catch((error) => {
        sendJson(res, error?.code === "REQUEST_TOO_LARGE" ? 413 : 400, { ok: false, error: "invalid_request" });
      });
    });
    server.on("connection", (socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
    });
    await new Promise((resolve, reject) => {
      const onError = (error) => reject(error);
      server.once("error", onError);
      server.listen(this.pipePath, () => {
        server.off("error", onError);
        resolve();
      });
    });
    server.unref?.();
    this.server = server;
    return this.capability();
  }

  async close() {
    const server = this.server;
    this.server = null;
    for (const socket of this.sockets) socket.destroy();
    this.sockets.clear();
    if (server) await new Promise((resolve) => server.close(() => resolve()));
    if (process.platform !== "win32") {
      try { fs.rmSync(this.pipePath, { force: true }); } catch { /* best effort */ }
    }
  }

  async #handle(req, res) {
    if (req.method !== "POST" || req.url !== "/v1/capabilities/handshake") {
      sendJson(res, 404, { ok: false, error: "not_found" });
      return;
    }
    if (!tokenEqual(bearer(req), this.token)) {
      sendJson(res, 401, { ok: false, error: "unauthorized" });
      return;
    }
    const body = await readBody(req);
    const requested = Array.isArray(body?.scopes) ? body.scopes.map(String) : [];
    if (requested.length === 0 || requested.some((route) => !this.allowedRoutes.has(route))) {
      sendJson(res, 403, { ok: false, error: "capability_denied" });
      return;
    }
    try {
      const grant = await this.handshake.issue(body);
      sendJson(res, 200, { ok: true, grant });
    } catch (error) {
      sendJson(res, 503, { ok: false, error: "heartbeat_unavailable", code: String(error?.code || "") });
    }
  }
}

export async function startVerificationPulseBrokerIfAvailable() {
  if (!heartbeatAuthManager.hasLaunchKey()) return null;
  const broker = new VerificationPulseBroker();
  await broker.start();
  return broker;
}
