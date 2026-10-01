// lib/domains/providers/functions/provider-pause-state.js
//
// The persisted provider pause: the account-level `<provider>_rate_limit_state`
// setting that carries a quota or rate-limit pause across runs. A dated weekly
// limit can pause a provider for up to 8 days there, so the operator needs a
// way to see and clear it (`posse admin provider-pause`, `posse status`).
//
// The setting holds a pause, { untilMs, reason, updatedAt }, and after an
// operator clears one, the clear: { clearedAtMs, clearedUntilMs }. The clear
// stays until the cleared pause would have ended, and a later pause keeps it,
// so a running `posse` process that still holds the cleared pause in memory
// releases it on its next check (getProviderRateLimitState). This module
// reads and writes settings only, without the provider registry, so the CLI
// can use it cheaply.

import { PROVIDER_OPTIONS } from "../../../catalog/provider.js";
import { getSetting, setSetting } from "../../settings/functions/repository-settings.js";

export const PROVIDER_PAUSE_CLEAR_REASON = "operator_clear";

export function providerPauseSettingKey(providerName) {
  return `${String(providerName || "").trim().toLowerCase()}_rate_limit_state`;
}

function pruneProviderPauseRecord(key) {
  try { setSetting(key, null); } catch { /* account settings unavailable */ }
}

/**
 * A provider's persisted pause record as of `nowMs`: its active pause and
 * its active operator clear, either possibly null. A record with neither is
 * deleted. Takes a canonical provider name.
 * @returns {{ pause: { untilMs: number, reason: string, updatedAt: string|null } | null,
 *   clear: { clearedAtMs: number, clearedUntilMs: number, clearedReason: string } | null } | null}
 */
export function readProviderPauseRecord(providerName, { nowMs = Date.now() } = {}) {
  const key = providerPauseSettingKey(providerName);
  let parsed = null;
  try {
    const raw = getSetting(key);
    if (!raw) return null;
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const untilMs = Number(parsed?.untilMs);
  const pause = Number.isFinite(untilMs) && untilMs > nowMs
    ? { untilMs, reason: String(parsed?.reason || "persisted_rate_limit"), updatedAt: parsed?.updatedAt ? String(parsed.updatedAt) : null }
    : null;
  const clearedAtMs = Number(parsed?.clearedAtMs);
  const clearedUntilMs = Number(parsed?.clearedUntilMs);
  const clear = Number.isFinite(clearedAtMs) && clearedUntilMs > nowMs
    ? { clearedAtMs, clearedUntilMs, clearedReason: String(parsed?.clearedReason || "") }
    : null;
  if (!pause && !clear) {
    pruneProviderPauseRecord(key);
    return null;
  }
  return { pause, clear };
}

function clearFields(clear) {
  return clear
    ? { clearedAtMs: clear.clearedAtMs, clearedUntilMs: clear.clearedUntilMs, clearedReason: clear.clearedReason }
    : {};
}

/**
 * Persist a provider pause until `untilMs`, keeping an active operator clear
 * so processes that have not seen it yet still release the cleared pause.
 * Takes a canonical provider name.
 */
export function writeProviderPause(providerName, { untilMs, reason = "rate_limit", nowMs = Date.now() } = {}) {
  const current = readProviderPauseRecord(providerName, { nowMs });
  setSetting(providerPauseSettingKey(providerName), JSON.stringify({
    untilMs,
    reason: String(reason || "rate_limit"),
    updatedAt: new Date(nowMs).toISOString(),
    ...clearFields(current?.clear),
  }));
}

/**
 * The providers with an active persisted pause, soonest end first.
 * @returns {Array<{ provider: string, untilMs: number, retryInSec: number, reason: string, updatedAt: string|null }>}
 */
export function listPersistedProviderPauses({ providers = PROVIDER_OPTIONS, nowMs = Date.now() } = {}) {
  const rows = [];
  for (const provider of providers) {
    const pause = readProviderPauseRecord(provider, { nowMs })?.pause;
    if (!pause) continue;
    rows.push({
      provider,
      untilMs: pause.untilMs,
      retryInSec: Math.ceil((pause.untilMs - nowMs) / 1000),
      reason: pause.reason,
      updatedAt: pause.updatedAt,
    });
  }
  return rows.sort((a, b) => a.untilMs - b.untilMs);
}

/**
 * Clear a provider's persisted pause, leaving the clear record behind until
 * the pause would have ended so running processes release their copy too.
 * Takes a canonical provider name.
 * @returns {{ provider: string, untilMs: number, reason: string } | null} the
 *   cleared pause, or null when none was active.
 */
export function clearPersistedProviderPause(providerName, { nowMs = Date.now() } = {}) {
  const record = readProviderPauseRecord(providerName, { nowMs });
  const pause = record?.pause;
  if (!pause) return null;
  setSetting(providerPauseSettingKey(providerName), JSON.stringify({
    reason: PROVIDER_PAUSE_CLEAR_REASON,
    updatedAt: new Date(nowMs).toISOString(),
    clearedAtMs: nowMs,
    clearedUntilMs: Math.max(pause.untilMs, record.clear?.clearedUntilMs || 0),
    clearedReason: pause.reason,
  }));
  return { provider: String(providerName), untilMs: pause.untilMs, reason: pause.reason };
}
