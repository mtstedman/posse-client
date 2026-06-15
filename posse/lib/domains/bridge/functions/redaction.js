const REDACTED = "[REDACTED]";

const SAFE_TOKEN_KEYS = new Set([
  "context_budget_chars",
  "max_tokens",
  "token_budget_input",
  "token_budget_output",
  "token_count",
  "tokens",
]);

const SENSITIVE_KEY_RE = /(^|[_-])(api[_-]?key|authorization|auth|auth[_-]?header|access[_-]?token|refresh[_-]?token|id[_-]?token|lease[_-]?token|session[_-]?token|token|secret|password|passwd|pwd|credential|credentials|private[_-]?key|client[_-]?secret|cookie)([_-]|$)/i;
const SENSITIVE_KEY_SEGMENTS = new Set([
  "authorization",
  "auth",
  "authentication",
  "secret",
  "password",
  "passwd",
  "pwd",
  "credential",
  "credentials",
  "cookie",
]);
const SENSITIVE_KEY_PAIRS = new Set([
  "api:key",
  "access:key",
  "access:token",
  "bearer:token",
  "client:secret",
  "id:token",
  "lease:token",
  "oauth:token",
  "private:key",
  "refresh:token",
  "session:token",
  "setup:token",
]);
const BEARER_RE = /\bBearer\s+[A-Za-z0-9._~+/=-]{6,}/gi;
const BASIC_RE = /\bBasic\s+[A-Za-z0-9+/=]{8,}/gi;
const OPENAI_KEY_RE = /\bsk-[A-Za-z0-9_-]{4,}\b/g;
const GITHUB_TOKEN_RE = /\b(?:gh[pousr]_[A-Za-z0-9_]{8,}|github_pat_[A-Za-z0-9_]{8,})\b/g;
const SLACK_TOKEN_RE = /\bxox[baprs]-[A-Za-z0-9-]{8,}\b/g;
const JWT_RE = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const AWS_ACCESS_KEY_RE = /\bA(?:KIA|SIA)[A-Z0-9]{12,}\b/g;
const GOOGLE_API_KEY_RE = /\bAIza[0-9A-Za-z_-]{12,}\b/g;
const URL_USERINFO_RE = /\b([A-Za-z][A-Za-z0-9+.-]*:\/\/)([^@\s/?#]+)@/g;

function isPlainObject(value) {
  return Object.prototype.toString.call(value) === "[object Object]";
}

function isBinaryLike(value) {
  if (typeof Buffer !== "undefined" && Buffer.isBuffer?.(value)) return true;
  return value instanceof ArrayBuffer || ArrayBuffer.isView(value);
}

function canonicalKey(key) {
  return String(key || "")
    .trim()
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .toLowerCase();
}

function keySegments(key) {
  const canonical = canonicalKey(key);
  if (!canonical) return [];
  return canonical.split("_").filter(Boolean);
}

function isSensitiveKey(key) {
  const normalized = String(key || "").trim().toLowerCase();
  const canonical = canonicalKey(key);
  if (!normalized || SAFE_TOKEN_KEYS.has(normalized) || SAFE_TOKEN_KEYS.has(canonical)) return false;
  if (SENSITIVE_KEY_RE.test(normalized)) return true;
  const segments = keySegments(key);
  if (segments.some((segment) => SENSITIVE_KEY_SEGMENTS.has(segment))) return true;
  for (let i = 0; i < segments.length - 1; i += 1) {
    if (SENSITIVE_KEY_PAIRS.has(`${segments[i]}:${segments[i + 1]}`)) return true;
  }
  return false;
}

// Exported for reuse by the telemetry log scrubber (secret-scrub.js) so file
// logs catch the same token shapes the bridge redacts (Bearer/JWT/cloud keys).
export function redactString(value) {
  return String(value)
    .replace(URL_USERINFO_RE, "$1[REDACTED]@")
    .replace(BEARER_RE, "Bearer [REDACTED]")
    .replace(BASIC_RE, "Basic [REDACTED]")
    .replace(OPENAI_KEY_RE, "sk-[REDACTED]")
    .replace(GITHUB_TOKEN_RE, "[REDACTED]")
    .replace(SLACK_TOKEN_RE, "[REDACTED]")
    .replace(JWT_RE, "[REDACTED]")
    .replace(AWS_ACCESS_KEY_RE, "[REDACTED]")
    .replace(GOOGLE_API_KEY_RE, "[REDACTED]");
}

export function redactBridgeValue(value) {
  if (value == null) return value;
  if (typeof value === "string") return redactString(value);
  if (Array.isArray(value)) return value.map((entry) => redactBridgeValue(entry));
  if (isBinaryLike(value)) return REDACTED;
  if (value instanceof Map) {
    const redacted = {};
    for (const [key, entry] of value.entries()) {
      const stringKey = String(key);
      redacted[stringKey] = isSensitiveKey(stringKey) ? REDACTED : redactBridgeValue(entry);
    }
    return redacted;
  }
  if (value instanceof Set) return [...value].map((entry) => redactBridgeValue(entry));
  if (!isPlainObject(value)) {
    const entries = Object.entries(value);
    if (entries.length === 0) return value;
    const redacted = {};
    for (const [key, entry] of entries) {
      redacted[key] = isSensitiveKey(key) ? REDACTED : redactBridgeValue(entry);
    }
    return redacted;
  }

  const redacted = {};
  for (const [key, entry] of Object.entries(value)) {
    redacted[key] = isSensitiveKey(key) ? REDACTED : redactBridgeValue(entry);
  }
  return redacted;
}
