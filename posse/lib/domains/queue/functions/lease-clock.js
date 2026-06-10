// Shared monotonic-augmented wall clock for job leases.
//
// If wall time jumps backward (system clock skew, sleep/wake), synthesize
// forward progress from performance.now() so leases never appear to
// expire-then-un-expire. Every job lease acquisition/renewal/requeue path
// should use this module.

import { performance } from "node:perf_hooks";
import { assertTestContext } from "../../runtime/functions/test-context.js";
import { log } from "../../../shared/telemetry/functions/logging/logger.js";
import { getSetting } from "./settings.js";

let _leaseClockForTests = null;
let _lastLeaseClock = null;
let _settingReadFallbacks = 0;

function readPositiveIntSetting(key, fallback) {
  try {
    const raw = getSetting(key);
    const parsed = Number.parseInt(String(raw || ""), 10);
    if (Number.isFinite(parsed) && parsed >= 0) return parsed;
  } catch (err) {
    _settingReadFallbacks++;
    log.warn("queue", "Lease clock setting read failed; using fallback", {
      key,
      fallback,
      fallbackCount: _settingReadFallbacks,
      error: String(err?.message || err || "unknown"),
      stack: err?.stack || null,
    });
  }
  return fallback;
}

export function leaseRequeueGraceSec() {
  return readPositiveIntSetting("lease_requeue_grace_sec", 60);
}

function leaseWallNowMs() {
  const value = typeof _leaseClockForTests?.wallNowMs === "function"
    ? _leaseClockForTests.wallNowMs()
    : Date.now();
  return Number.isFinite(Number(value)) ? Number(value) : Date.now();
}

function leaseMonotonicNowMs() {
  const value = typeof _leaseClockForTests?.monotonicNowMs === "function"
    ? _leaseClockForTests.monotonicNowMs()
    : performance.now();
  return Number.isFinite(Number(value)) ? Number(value) : performance.now();
}

export function leaseNowMs() {
  const wallMs = leaseWallNowMs();
  const monotonicMs = leaseMonotonicNowMs();
  if (!_lastLeaseClock || wallMs >= _lastLeaseClock.wallMs) {
    _lastLeaseClock = { wallMs, monotonicMs };
    return wallMs;
  }
  const elapsedMs = Math.max(0, monotonicMs - _lastLeaseClock.monotonicMs);
  const synthesizedWallMs = Math.max(_lastLeaseClock.wallMs, _lastLeaseClock.wallMs + elapsedMs);
  _lastLeaseClock = { wallMs: synthesizedWallMs, monotonicMs };
  return synthesizedWallMs;
}

export function graceCutoff() {
  return new Date(leaseNowMs() - leaseRequeueGraceSec() * 1000)
    .toISOString()
    .replace("Z", "")
    .slice(0, 23) + "Z";
}

export function __testSetLeaseClockForTests(clock = null) {
  assertTestContext("__testSetLeaseClockForTests");
  _leaseClockForTests = clock;
  _lastLeaseClock = null;
}

export function __testLeaseClockSettingReadFallbacks() {
  assertTestContext("__testLeaseClockSettingReadFallbacks");
  return _settingReadFallbacks;
}
