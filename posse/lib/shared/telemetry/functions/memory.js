import { appendRunTelemetry } from "./run-telemetry.js";

function nowIso() {
  return new Date().toISOString();
}

function safeError(err) {
  if (!err) return null;
  return {
    name: err.name || null,
    message: String(err.message || err).slice(0, 1000),
  };
}

export function collectMemorySnapshot(extra = {}) {
  let resourceUsage = null;
  try { resourceUsage = typeof process.resourceUsage === "function" ? process.resourceUsage() : null; } catch { /* ignore */ }
  return {
    t: nowIso(),
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    uptime_sec: Math.round(process.uptime()),
    memory: process.memoryUsage(),
    resource_usage: resourceUsage,
    ...extra,
  };
}

export function recordMemorySample(phase, data = {}) {
  try {
    return appendRunTelemetry("memory", collectMemorySnapshot({
      phase: String(phase || "unknown"),
      ...data,
    }));
  } catch {
    return false;
  }
}

export async function withMemorySample(phase, data, fn) {
  const sampleData = typeof data === "function" ? data() : data;
  recordMemorySample(`${phase}.before`, sampleData || {});
  try {
    const result = await fn();
    recordMemorySample(`${phase}.after_success`, sampleData || {});
    return result;
  } catch (err) {
    recordMemorySample(`${phase}.after_error`, {
      ...(sampleData || {}),
      error: safeError(err),
    });
    throw err;
  }
}
