// lib/domains/remote/functions/model-catalog-refresh.js
//
// Fetches the model/pricing catalog from posse-remote (/v1/catalog/models)
// and installs it into the local store (model-catalog-store.js), so model
// churn at providers lands without a client patch. Refresh is TTL-gated
// (model_catalog_cache_ms, default 24h) with a short failure backoff, in the
// same maybeRunX shape as runtime retention. A failed or malformed fetch
// never clobbers the persisted cache — readers keep the last good catalog,
// then the builtin lists.

import { RemotePromptClient } from "../classes/RemotePromptClient.js";
import { getPosseRemoteTimeoutMs, getPosseRemoteUrl } from "./mode.js";
import {
  MODEL_CATALOG_FETCHED_AT_SETTING_KEY,
  ensureRemoteCatalogLoaded,
  getRemoteCatalog,
  normalizeRemoteModelCatalog,
  setRemoteCatalog,
} from "../../providers/functions/model-catalog-store.js";
import { validateConfiguredModels } from "../../providers/functions/model-catalog-validate.js";
import { getAccountSetting } from "../../settings/functions/account-settings.js";
import { getCatalogRuntimeFallbackInt } from "../../settings/functions/catalog.js";

const DEFAULT_CACHE_MS = 24 * 60 * 60 * 1000;
const FAILURE_BACKOFF_MS = 15 * 60 * 1000;

let _inFlight = null;
let _lastAttemptAt = 0;
let _lastFailureAt = 0;

function readCacheMs() {
  try {
    const raw = Number(getAccountSetting("model_catalog_cache_ms"));
    if (Number.isFinite(raw) && raw >= 60_000) return raw;
  } catch {
    // settings unavailable — use catalog default below
  }
  return getCatalogRuntimeFallbackInt("model_catalog_cache_ms", DEFAULT_CACHE_MS) ?? DEFAULT_CACHE_MS;
}

function readFetchedAtMs() {
  try {
    const raw = getAccountSetting(MODEL_CATALOG_FETCHED_AT_SETTING_KEY);
    const parsed = Date.parse(String(raw || ""));
    return Number.isFinite(parsed) ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Fetch, normalize, install, and persist the remote model catalog, then
 * re-validate configured models against the merged result.
 * Never throws: returns { ok, catalogVersion, staleWarnings, error }.
 */
export async function refreshRemoteModelCatalog({
  client = null,
  baseUrl = null,
  timeoutMs = null,
} = {}) {
  await ensureRemoteCatalogLoaded();
  try {
    const promptClient = client || new RemotePromptClient({
      baseUrl: baseUrl || getPosseRemoteUrl(),
      timeoutMs: timeoutMs || getPosseRemoteTimeoutMs(),
    });
    const raw = await promptClient.getModelCatalog();
    const normalized = normalizeRemoteModelCatalog(raw);
    if (!normalized) {
      _lastFailureAt = Date.now();
      return {
        ok: false,
        catalogVersion: getRemoteCatalog()?.catalogVersion ?? null,
        staleWarnings: [],
        error: "remote model catalog payload was malformed or unsupported",
      };
    }
    const persistOutcome = setRemoteCatalog(normalized, { persist: true });
    if (persistOutcome?.persisted === false) {
      // Fetch succeeded but nothing durable recorded it — fetched_at was not
      // written, so the freshness TTL can never engage and the only remaining
      // throttle would be the 60s attempt guard. Treat it as a failure so the
      // backoff applies instead of degrading the 24h TTL into a permanent
      // ~60s network fetch loop. The in-memory catalog is still installed.
      _lastFailureAt = Date.now();
      return {
        ok: false,
        catalogVersion: normalized.catalogVersion,
        staleWarnings: [],
        error: "remote model catalog fetched but could not be persisted; backing off",
      };
    }
    _lastFailureAt = 0;
    const staleWarnings = validateConfiguredModels();
    return { ok: true, catalogVersion: normalized.catalogVersion, staleWarnings, error: null };
  } catch (err) {
    _lastFailureAt = Date.now();
    return {
      ok: false,
      catalogVersion: getRemoteCatalog()?.catalogVersion ?? null,
      staleWarnings: [],
      error: err?.message || String(err),
    };
  }
}

/**
 * TTL-gated refresh for the scheduler loop. Returns immediately (with
 * { attempted: false }) when the cached catalog is fresh, a refresh is
 * already in flight, or the last attempt failed within the backoff window.
 */
export async function maybeRefreshModelCatalog({ nowMs = Date.now(), force = false, client = null } = {}) {
  // Under node --test, never reach for the real network (or the native
  // client binary — its spawned process can keep the test runner alive).
  // Tests exercise the flow by injecting a fake client.
  if (!client && process.env.NODE_TEST_CONTEXT) {
    return { attempted: false, skipped: "test_context" };
  }
  if (_inFlight) return _inFlight;
  if (!force) {
    if (_lastFailureAt > 0 && nowMs - _lastFailureAt < FAILURE_BACKOFF_MS) {
      return { attempted: false, skipped: "backoff" };
    }
    const fetchedAt = readFetchedAtMs();
    if (fetchedAt > 0 && nowMs - fetchedAt < readCacheMs()) {
      return { attempted: false, skipped: "fresh" };
    }
    // Guard against tight re-entry while settings reads race the first fetch.
    if (_lastAttemptAt > 0 && nowMs - _lastAttemptAt < 60_000) {
      return { attempted: false, skipped: "recent_attempt" };
    }
  }
  _lastAttemptAt = nowMs;
  _inFlight = refreshRemoteModelCatalog({ client })
    .then((result) => ({ attempted: true, ...result }))
    .finally(() => {
      _inFlight = null;
    });
  return _inFlight;
}

export function __resetModelCatalogRefreshForTests() {
  _inFlight = null;
  _lastAttemptAt = 0;
  _lastFailureAt = 0;
}
