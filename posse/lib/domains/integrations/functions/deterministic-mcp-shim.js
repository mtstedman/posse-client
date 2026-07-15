#!/usr/bin/env node
// @ts-check
//
// Tiny stdio MCP shim. This file intentionally imports only Node stdlib.
// It parses MCP stdio frames and forwards JSON-RPC messages to the persistent
// Posse MCP owner, carrying the signed session capability token with each call.

import http from "node:http";
import process from "node:process";
import { pathToFileURL } from "node:url";

const MAX_STDIN_CONTENT_LENGTH_BYTES = 16 * 1024 * 1024;
const MAX_STDIN_BUFFER_BYTES = MAX_STDIN_CONTENT_LENGTH_BYTES * 2;
const MAX_OWNER_RESPONSE_BYTES = 16 * 1024 * 1024;
const OWNER_RETRY_MS = 50;
const OWNER_RETRY_DEADLINE_MS = 5000;
// Handshake methods (initialize/tools/list/etc.) are idempotent and must attach
// reliably even when the shared owner child is briefly busy under concurrent
// load. Give them a longer retry window and allow retrying transient owner 5xx /
// request timeouts — the failure mode where an agent runs a whole session with
// no gateway tools is almost always a single transient miss at attach time.
const OWNER_HANDSHAKE_RETRY_DEADLINE_MS = 30000;
// Per-request timeouts so a wedged owner never hangs the shim forever. Keep the
// non-idempotent budget above the owner's own request timeout (120s) so the
// owner returns a proper error first instead of the shim cutting off a legit
// long-running tool call (e.g. a slow test run).
const OWNER_HANDSHAKE_REQUEST_TIMEOUT_MS = 30000;
const OWNER_DEFAULT_REQUEST_TIMEOUT_MS = 150000;
// Pre-connect errors are safe to retry for any method. Mid-stream connection
// errors may occur after the owner started executing the request, so replay
// them only for idempotent methods.
const PRE_CONNECT_RETRY_CODES = ["ENOENT", "ECONNREFUSED"];
const MAYBE_SIDE_EFFECT_RETRY_CODES = ["EPIPE", "ECONNRESET"];
const IDEMPOTENT_METHODS = new Set([
  "initialize",
  "tools/list",
  "prompts/list",
  "resources/list",
  "resources/templates/list",
  "ping",
]);

function isIdempotentMethod(message) {
  const method = String(message?.method || "");
  return IDEMPOTENT_METHODS.has(method) || method.startsWith("notifications/");
}

export function shouldRetryOwnerForwardError(err, { idempotent }) {
  const code = String(err?.code || "");
  if (PRE_CONNECT_RETRY_CODES.includes(code)) return true;
  if (idempotent && MAYBE_SIDE_EFFECT_RETRY_CODES.includes(code)) return true;
  return idempotent && (code === "ETIMEDOUT" || err?.transient === true);
}

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return "";
  return String(process.argv[index + 1]);
}

const IS_MAIN = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

const ownerPipe = argValue("--owner-pipe");
const ownerToken = argValue("--owner-token");
const mcpOAuthToken = argValue("--mcp-oauth-token");

if (IS_MAIN && (!ownerPipe || !ownerToken || !mcpOAuthToken)) {
  process.stderr.write("[posse-mcp-shim] missing --owner-pipe, --owner-token, or --mcp-oauth-token\n");
  process.exit(2);
}

let outboundFraming = "jsonl";
let inputBuffer = Buffer.alloc(0);
let requestQueue = Promise.resolve();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function jsonRpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function sendMessage(payload) {
  if (!payload) return;
  const body = JSON.stringify(payload);
  if (outboundFraming === "lsp") {
    const bytes = Buffer.from(body, "utf8");
    process.stdout.write(`Content-Length: ${bytes.byteLength}\r\n\r\n`, "utf8");
    process.stdout.write(bytes);
  } else {
    process.stdout.write(`${body}\n`, "utf8");
  }
}

function ownerRequest(message, {
  timeoutMs = OWNER_DEFAULT_REQUEST_TIMEOUT_MS,
  pipePath = ownerPipe,
  ownerBearer = ownerToken,
  sessionToken = mcpOAuthToken,
} = {}) {
  const body = JSON.stringify({ token: sessionToken, message });
  return new Promise((resolve, reject) => {
    let settled = false;
    let timer = null;
    const settle = (fn, value) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      fn(value);
    };
    const fail = (error) => settle(reject, error);
    const req = http.request({
      socketPath: pipePath,
      path: "/v1/mcp/rpc",
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerBearer}`,
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      let total = 0;
      res.on("data", (chunk) => {
        const bytes = Buffer.from(chunk);
        total += bytes.length;
        if (total > MAX_OWNER_RESPONSE_BYTES) {
          const err = new Error(`owner response exceeded ${MAX_OWNER_RESPONSE_BYTES} bytes`);
          err.code = "EOWNERRESPONSETOOLARGE";
          fail(err);
          res.destroy(err);
          req.destroy(err);
          return;
        }
        chunks.push(bytes);
      });
      res.on("error", fail);
      res.on("aborted", () => {
        const err = new Error("owner response was aborted before completion");
        err.code = "ECONNRESET";
        fail(err);
      });
      res.on("end", () => {
        if (settled) return;
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          fail(new Error(`owner returned invalid JSON (${res.statusCode})`));
          return;
        }
        if (res.statusCode !== 200 || parsed?.ok !== true) {
          const err = new Error(parsed?.error || `owner request failed (${res.statusCode})`);
          // 5xx means the owner accepted the request but failed transiently
          // (child busy/restarting); safe to replay for idempotent methods.
          if (Number(res.statusCode) >= 500) err.transient = true;
          fail(err);
          return;
        }
        settle(resolve, parsed.message || null);
      });
    });
    if (timeoutMs) {
      // ClientRequest#setTimeout is an inactivity timeout. A wedged owner that
      // trickles bytes can keep it alive forever, so use an absolute request
      // deadline covering connect, headers, and the complete response body.
      timer = setTimeout(() => {
        const err = new Error(`owner request timed out after ${timeoutMs}ms`);
        err.code = "ETIMEDOUT";
        fail(err);
        req.destroy(err);
      }, timeoutMs);
      timer.unref?.();
    }
    req.on("error", fail);
    req.write(body, "utf8");
    req.end();
  });
}

export function __testOwnerRequest(message, options = {}) {
  return ownerRequest(message, options);
}

async function forwardToOwner(message, {
  now = Date.now,
  deadlineMs = null,
  requestTimeoutMs = null,
  retryDelayMs = OWNER_RETRY_MS,
  requestImpl = ownerRequest,
  sleepImpl = sleep,
} = {}) {
  const idempotent = isIdempotentMethod(message);
  const deadline = Math.max(1, Number(deadlineMs)
    || (idempotent ? OWNER_HANDSHAKE_RETRY_DEADLINE_MS : OWNER_RETRY_DEADLINE_MS));
  const timeoutMs = Math.max(1, Number(requestTimeoutMs)
    || (idempotent ? OWNER_HANDSHAKE_REQUEST_TIMEOUT_MS : OWNER_DEFAULT_REQUEST_TIMEOUT_MS));
  const deadlineAt = now() + deadline;
  let lastErr = null;
  while (now() < deadlineAt) {
    const remainingMs = Math.max(1, deadlineAt - now());
    try {
      // A handshake retry window is also its total budget. Without bounding
      // each idempotent attempt to the time left, one timeout at the deadline
      // starts a second full request and doubles attach latency. Tool calls
      // retain their longer one-attempt timeout because they are not replayed
      // after ambiguous/maybe-side-effect failures.
      const attemptTimeoutMs = idempotent ? Math.min(timeoutMs, remainingMs) : timeoutMs;
      return await requestImpl(message, { timeoutMs: attemptTimeoutMs });
    } catch (err) {
      lastErr = err;
      // Timeouts and transient owner 5xx are only replayed for idempotent
      // handshake methods — never auto-replay a tools/call that may have
      // partially executed.
      if (!shouldRetryOwnerForwardError(err, { idempotent })) throw err;
      const retryRemainingMs = deadlineAt - now();
      if (retryRemainingMs <= 0) break;
      await sleepImpl(Math.min(Math.max(1, Number(retryDelayMs) || OWNER_RETRY_MS), retryRemainingMs));
    }
  }
  throw lastErr || new Error("owner unavailable");
}

export function __testForwardToOwner(message, options = {}) {
  return forwardToOwner(message, options);
}

function dispatchParsed(parsed) {
  requestQueue = requestQueue.then(async () => {
    const response = await forwardToOwner(parsed);
    if (response) sendMessage(response);
  }).catch((err) => {
    const id = parsed && Object.prototype.hasOwnProperty.call(parsed, "id") ? parsed.id : null;
    if (id == null) {
      try { process.stderr.write(`[posse-mcp-shim] ${err?.message || err}\n`); } catch {}
      return;
    }
    sendMessage(jsonRpcError(id, -32603, String(err?.message || err || "MCP owner error")));
  });
}

function reportParseError(framing, err, byteLength) {
  const message = String(err?.message || err || "Malformed JSON-RPC frame");
  try {
    process.stderr.write(`[posse-mcp-shim] JSON-RPC parse error (${framing}, ${byteLength} bytes): ${message}\n`);
  } catch {
    // diagnostics only
  }
  sendMessage(jsonRpcError(null, -32700, "Parse error"));
}

function processInputBuffer() {
  while (inputBuffer.length > 0) {
    let offset = 0;
    while (offset < inputBuffer.length) {
      const c = inputBuffer[offset];
      if (c === 0x0a || c === 0x0d || c === 0x20 || c === 0x09) offset += 1;
      else break;
    }
    if (offset > 0) inputBuffer = inputBuffer.subarray(offset);
    if (inputBuffer.length === 0) return;

    const headPreview = inputBuffer.subarray(0, Math.min(16, inputBuffer.length)).toString("utf8").toLowerCase();
    if (headPreview.startsWith("content-length:")) {
      outboundFraming = "lsp";
      const separatorIndex = inputBuffer.indexOf("\r\n\r\n");
      if (separatorIndex < 0) return;
      const headerBlock = inputBuffer.subarray(0, separatorIndex).toString("utf8");
      const match = headerBlock.match(/content-length:\s*(\d+)/i);
      if (!match) {
        inputBuffer = inputBuffer.subarray(separatorIndex + 4);
        reportParseError("lsp", new Error("Invalid Content-Length header"), Buffer.byteLength(headerBlock));
        continue;
      }
      const contentLength = Number.parseInt(match[1], 10);
      if (!Number.isFinite(contentLength) || contentLength < 0 || contentLength > MAX_STDIN_CONTENT_LENGTH_BYTES) {
        inputBuffer = inputBuffer.subarray(separatorIndex + 4);
        reportParseError("lsp", new Error(`Content-Length ${match[1]} exceeds maximum ${MAX_STDIN_CONTENT_LENGTH_BYTES}`), Buffer.byteLength(headerBlock));
        continue;
      }
      const messageStart = separatorIndex + 4;
      const messageEnd = messageStart + contentLength;
      if (inputBuffer.length < messageEnd) return;
      const jsonBody = inputBuffer.subarray(messageStart, messageEnd).toString("utf8");
      inputBuffer = inputBuffer.subarray(messageEnd);
      try {
        dispatchParsed(JSON.parse(jsonBody));
      } catch (err) {
        reportParseError("lsp", err, Buffer.byteLength(jsonBody));
      }
      continue;
    }

    const newlineIdx = inputBuffer.indexOf(0x0a);
    if (newlineIdx < 0) return;
    const lineBytes = inputBuffer.subarray(0, newlineIdx);
    inputBuffer = inputBuffer.subarray(newlineIdx + 1);
    let line = lineBytes.toString("utf8");
    if (line.endsWith("\r")) line = line.slice(0, -1);
    line = line.trim();
    if (!line) continue;
    try {
      dispatchParsed(JSON.parse(line));
    } catch (err) {
      reportParseError("jsonl", err, Buffer.byteLength(line));
    }
  }
}

if (IS_MAIN) {
  process.stdin.on("data", (chunk) => {
    inputBuffer = Buffer.concat([inputBuffer, Buffer.from(chunk)]);
    processInputBuffer();
    if (inputBuffer.length > MAX_STDIN_BUFFER_BYTES) {
      reportParseError(
        "stream",
        new Error(`stdin buffered ${inputBuffer.length} bytes without a complete frame (max ${MAX_STDIN_BUFFER_BYTES})`),
        inputBuffer.length,
      );
      inputBuffer = Buffer.alloc(0);
    }
  });

  process.stdin.on("end", () => {
    requestQueue.finally(() => process.exit(0));
  });
  process.stdin.on("error", () => process.exit(0));
}
