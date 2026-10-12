// @ts-check

import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";

export const MAX_OWNER_BODY_BYTES = 16 * 1024 * 1024;

export function randomToken() {
  return crypto.randomBytes(32).toString("base64url");
}

export function safeIdPart(value) {
  return String(value || "").replace(/[^A-Za-z0-9_.-]/g, "_");
}

// Unix domain socket paths are capped at ~108 bytes (sockaddr_un.sun_path). A
// long TMPDIR (some systemd/CI/sandbox setups) can push the default path past
// that and make listen() fail with ENAMETOOLONG. Keep the bound path short.
export const UNIX_SOCKET_PATH_MAX = 100;

export function shortenUnixSocketPath(candidate, suffix) {
  if (Buffer.byteLength(candidate) <= UNIX_SOCKET_PATH_MAX) return candidate;
  const shortId = crypto.createHash("sha1").update(String(suffix)).digest("hex").slice(0, 16);
  // POSIX-only path (this branch never runs on win32); keep forward slashes
  // regardless of the host so the bound socket path is deterministic.
  for (const base of ["/tmp", "/var/tmp"]) {
    const short = path.posix.join(base, `posse-mcp-${shortId}.sock`);
    if (Buffer.byteLength(short) <= UNIX_SOCKET_PATH_MAX) return short;
  }
  return candidate; // best effort; listen() will surface any residual error
}

export function __testShortenUnixSocketPath(candidate, suffix) {
  return shortenUnixSocketPath(candidate, suffix);
}

export function defaultPipePath(bootId) {
  const suffix = `${process.pid}-${safeIdPart(bootId)}`;
  if (process.platform === "win32") return `\\\\.\\pipe\\posse-mcp-owner-${suffix}`;
  return shortenUnixSocketPath(path.join(os.tmpdir(), `posse-mcp-owner-${suffix}.sock`), suffix);
}

export function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(text),
  });
  res.end(text);
}

export async function readJsonBody(req) {
  const chunks = [];
  let total = 0;
  for await (const chunk of req) {
    total += chunk.length;
    if (total > MAX_OWNER_BODY_BYTES) throw new Error("request_body_too_large");
    chunks.push(chunk);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}

export function bearerFrom(req) {
  const raw = String(req?.headers?.authorization || "");
  const match = /^Bearer\s+(.+)$/i.exec(raw.trim());
  return match ? match[1].trim() : "";
}

export function tokenEqual(left, right) {
  const a = crypto.createHash("sha256").update(String(left || ""), "utf8").digest();
  const b = crypto.createHash("sha256").update(String(right || ""), "utf8").digest();
  return crypto.timingSafeEqual(a, b);
}

export function tokenHash(value) {
  return crypto.createHash("sha256").update(String(value || ""), "utf8").digest("base64url");
}
