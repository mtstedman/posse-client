import { execFileSync } from "child_process";
import { createHash, createHmac, timingSafeEqual } from "crypto";

export { RemotePromptClient } from "../classes/RemotePromptClient.js";

export const POSSE_REMOTE_MAX_RESPONSE_BYTES = 1024 * 1024;

const REMOTE_RESPONSE_SIGNATURE_DOMAINS = new Map([
  ["/v1/prompts/compile", "compile"],
  ["/v1/prompts/bundle", "bundle"],
]);

export function verifyRemoteResponseIntegrity(responseBody, {
  path = "",
  operation = "remote request",
  signingSecret = "",
} = {}) {
  const domain = REMOTE_RESPONSE_SIGNATURE_DOMAINS.get(String(path || ""));
  if (!domain || !String(signingSecret || "").trim()) return responseBody;

  const metadata = responseBody && typeof responseBody === "object" && !Array.isArray(responseBody)
    ? responseBody.metadata
    : null;
  const contentDigest = typeof metadata?.content_sha256 === "string" ? metadata.content_sha256.trim() : "";
  const signature = typeof metadata?.response_signature === "string" ? metadata.response_signature.trim() : "";
  if (!contentDigest || !signature) {
    throwIntegrityError(
      "POSSE_REMOTE_SIGNATURE_MISSING",
      `${operation} response is missing required integrity metadata`,
    );
  }

  const unsigned = cloneJsonForIntegrity(responseBody);
  if (unsigned?.metadata && typeof unsigned.metadata === "object" && !Array.isArray(unsigned.metadata)) {
    delete unsigned.metadata.content_sha256;
    delete unsigned.metadata.response_signature;
  }
  const canonical = stableJsonStringify(unsigned);
  const actualDigest = createHash("sha256").update(canonical, "utf8").digest("hex");
  if (!timingSafeEqualHex(actualDigest, contentDigest)) {
    throwIntegrityError(
      "POSSE_REMOTE_DIGEST_MISMATCH",
      `${operation} response content digest mismatch`,
    );
  }

  const expectedSignature = createHmac("sha256", String(signingSecret || ""))
    .update("posse-remote-response-v1\n")
    .update(domain)
    .update("\n")
    .update(contentDigest)
    .digest("hex");
  if (!timingSafeEqualHex(expectedSignature, signature)) {
    throwIntegrityError(
      "POSSE_REMOTE_SIGNATURE_MISMATCH",
      `${operation} response signature mismatch`,
    );
  }
  return responseBody;
}

function throwIntegrityError(code, message) {
  const err = new Error(message);
  err.code = code;
  throw err;
}

function timingSafeEqualHex(actual, expected) {
  if (!/^[0-9a-f]+$/i.test(actual) || !/^[0-9a-f]+$/i.test(expected)) return false;
  const actualBuffer = Buffer.from(actual, "hex");
  const expectedBuffer = Buffer.from(expected, "hex");
  if (actualBuffer.length !== expectedBuffer.length) return false;
  return timingSafeEqual(actualBuffer, expectedBuffer);
}

function cloneJsonForIntegrity(value) {
  if (value == null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map(cloneJsonForIntegrity);
  const out = {};
  for (const [key, entry] of Object.entries(value)) {
    if (entry === undefined) continue;
    out[key] = cloneJsonForIntegrity(entry);
  }
  return out;
}

function stableJsonStringify(value) {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("remote response integrity cannot canonicalize non-finite number");
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((entry) => stableJsonStringify(entry === undefined ? null : entry)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const keys = Object.keys(value).filter((key) => value[key] !== undefined).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJsonStringify(value[key])}`).join(",")}}`;
  }
  return "null";
}

function responseTooLargeError({ operation, url, maxBytes }) {
  const err = new Error(`${operation} response exceeded ${maxBytes} byte limit for ${url}`);
  err.code = "POSSE_REMOTE_RESPONSE_TOO_LARGE";
  err.maxResponseBytes = maxBytes;
  return err;
}

export async function readResponseTextWithLimit(response, {
  maxBytes = POSSE_REMOTE_MAX_RESPONSE_BYTES,
  operation = "remote request",
  url = "remote endpoint",
} = {}) {
  const limit = Number.isFinite(Number(maxBytes)) && Number(maxBytes) > 0
    ? Math.floor(Number(maxBytes))
    : POSSE_REMOTE_MAX_RESPONSE_BYTES;

  if (response?.body && typeof response.body.getReader === "function") {
    const reader = response.body.getReader();
    const chunks = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        const chunk = value instanceof Uint8Array ? value : new TextEncoder().encode(String(value ?? ""));
        total += chunk.byteLength;
        if (total > limit) {
          try { await reader.cancel(); } catch { /* ignore */ }
          throw responseTooLargeError({ operation, url, maxBytes: limit });
        }
        chunks.push(chunk);
      }
    } finally {
      try { reader.releaseLock?.(); } catch { /* ignore */ }
    }
    const merged = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) {
      merged.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return new TextDecoder().decode(merged);
  }

  const text = await response.text();
  if (Buffer.byteLength(String(text || ""), "utf8") > limit) {
    throw responseTooLargeError({ operation, url, maxBytes: limit });
  }
  return text;
}

/**
 * Resolve the canonical Posse key (POSSE_KEY) used by remote prompt/catalog
 * calls and native method binaries. Reads the process env first, then the
 * Windows-persisted user/machine env.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {string}
 */
export function resolvePosseKey(env = process.env) {
  const processValue = String(env?.POSSE_KEY || "").trim();
  if (processValue) return processValue;
  if (env !== process.env) return "";
  return readWindowsPersistedEnv("POSSE_KEY");
}

export function assertSafeRemoteAuthUrl(baseUrl, apiKey, operation = "remote request") {
  if (!apiKey) return;
  let url;
  try {
    url = new URL(String(baseUrl || ""));
  } catch {
    const err = new Error(`${operation} requires an absolute HTTPS URL when authorization is configured`);
    err.code = "POSSE_REMOTE_INVALID_URL";
    throw err;
  }
  if (url.protocol === "https:") return;
  if (url.protocol === "http:" && isLoopbackRemoteHostname(url.hostname)) return;
  const err = new Error(`${operation} refuses to send authorization over ${url.protocol || "an insecure URL"} for ${url.origin}`);
  err.code = "POSSE_REMOTE_INSECURE_AUTH";
  throw err;
}

function isLoopbackRemoteHostname(hostname = "") {
  const host = String(hostname || "").trim().toLowerCase().replace(/^\[|\]$/g, "");
  if (host === "localhost" || host.endsWith(".localhost") || host === "::1") return true;
  const ipv4 = host.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/u);
  if (!ipv4) return false;
  const octets = ipv4.slice(1).map((part) => Number.parseInt(part, 10));
  return octets.every((octet) => Number.isInteger(octet) && octet >= 0 && octet <= 255) && octets[0] === 127;
}

function readWindowsPersistedEnv(name) {
  if (process.platform !== "win32") return "";
  try {
    const script = [
      `$name = ${JSON.stringify(name)}`,
      "$user = [Environment]::GetEnvironmentVariable($name, 'User')",
      "if ($user) { $user; exit 0 }",
      "$machine = [Environment]::GetEnvironmentVariable($name, 'Machine')",
      "if ($machine) { $machine; exit 0 }",
    ].join("; ");
    return execFileSync("powershell.exe", ["-NoProfile", "-Command", script], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2000,
      windowsHide: true,
    }).trim();
  } catch {
    return "";
  }
}
