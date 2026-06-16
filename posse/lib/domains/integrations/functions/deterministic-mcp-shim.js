#!/usr/bin/env node
// @ts-check
//
// Tiny stdio MCP shim. This file intentionally imports only Node stdlib.
// It parses MCP stdio frames and forwards JSON-RPC messages to the persistent
// Posse MCP owner, carrying the signed session capability token with each call.

import http from "node:http";
import process from "node:process";

const MAX_STDIN_CONTENT_LENGTH_BYTES = 16 * 1024 * 1024;
const MAX_STDIN_BUFFER_BYTES = MAX_STDIN_CONTENT_LENGTH_BYTES * 2;
const OWNER_RETRY_MS = 50;
const OWNER_RETRY_DEADLINE_MS = 5000;

function argValue(name) {
  const index = process.argv.indexOf(name);
  if (index < 0 || !process.argv[index + 1]) return "";
  return String(process.argv[index + 1]);
}

const ownerPipe = argValue("--owner-pipe");
const ownerToken = argValue("--owner-token");
const mcpOAuthToken = argValue("--mcp-oauth-token");

if (!ownerPipe || !ownerToken || !mcpOAuthToken) {
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

function ownerRequest(message) {
  const body = JSON.stringify({ token: mcpOAuthToken, message });
  return new Promise((resolve, reject) => {
    const req = http.request({
      socketPath: ownerPipe,
      path: "/v1/mcp/rpc",
      method: "POST",
      headers: {
        authorization: `Bearer ${ownerToken}`,
        "content-type": "application/json; charset=utf-8",
        "content-length": Buffer.byteLength(body),
      },
    }, (res) => {
      const chunks = [];
      res.on("data", (chunk) => chunks.push(Buffer.from(chunk)));
      res.on("end", () => {
        const text = Buffer.concat(chunks).toString("utf8");
        let parsed;
        try {
          parsed = text ? JSON.parse(text) : {};
        } catch {
          reject(new Error(`owner returned invalid JSON (${res.statusCode})`));
          return;
        }
        if (res.statusCode !== 200 || parsed?.ok !== true) {
          reject(new Error(parsed?.error || `owner request failed (${res.statusCode})`));
          return;
        }
        resolve(parsed.message || null);
      });
    });
    req.on("error", reject);
    req.write(body, "utf8");
    req.end();
  });
}

async function forwardToOwner(message) {
  const started = Date.now();
  let lastErr = null;
  while (Date.now() - started <= OWNER_RETRY_DEADLINE_MS) {
    try {
      return await ownerRequest(message);
    } catch (err) {
      lastErr = err;
      const code = String(err?.code || "");
      if (!["ENOENT", "ECONNREFUSED", "EPIPE", "ECONNRESET"].includes(code)) throw err;
      await sleep(OWNER_RETRY_MS);
    }
  }
  throw lastErr || new Error("owner unavailable");
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
