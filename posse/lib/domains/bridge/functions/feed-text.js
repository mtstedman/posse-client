// Bounded, redacted text helpers shared by the bridge's work-item projections.
import { redactBridgeValue } from "./redaction.js";

export function safeText(value, maxChars, { nullable = true } = {}) {
  if (value == null) return nullable ? null : "";
  const redacted = redactBridgeValue(String(value));
  const text = String(redacted)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .trim();
  if (!text) return nullable ? null : "";
  return Array.from(text).slice(0, maxChars).join("");
}

export function parseJsonObject(value) {
  if (value == null || value === "") return {};
  if (typeof value === "object" && !Array.isArray(value)) return value;
  try {
    const parsed = JSON.parse(String(value));
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

export function exactText(value, maxBytes, pattern = null) {
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value, "utf8") > maxBytes) return null;
  if (pattern && !pattern.test(value)) return null;
  return value;
}
