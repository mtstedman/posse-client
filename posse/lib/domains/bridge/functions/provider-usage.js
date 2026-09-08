import { PROVIDER_USAGE_STREAM_PROTOCOL } from "../../../catalog/bridge.js";
import { buildProviderUsageDocument } from "../../providers/functions/provider-usage-contract.js";
import { getConfiguredProviderUsageAsync } from "../../providers/functions/provider.js";

// Reuse Posse's usage normalization, then project only quota telemetry. The
// relay forbids a key named `source`; origin carries the bounded source ID.
export function projectBridgeProviderUsage(summaries, now = new Date()) {
  const document = buildProviderUsageDocument({ summaries, generatedAt: now });
  return {
    protocol: PROVIDER_USAGE_STREAM_PROTOCOL,
    updated_at: document.generated_at,
    providers: document.providers
      .filter((provider) => provider.id === "claude" || provider.id === "codex")
      .map((provider) => ({
        id: provider.id,
        label: provider.label,
        origin: provider.source,
        stale: provider.stale,
        windows: provider.windows.map((window) => ({
          kind: window.kind,
          label: window.label,
          utilization_pct: window.utilization_pct == null
            ? null
            : Math.round(window.utilization_pct * 10) / 10,
          reset_at: window.reset_at,
          unlimited: window.unlimited,
        })),
      })),
  };
}

export async function readBridgeProviderUsage({ cwd } = {}) {
  // Provider collectors already enforce their own cache TTL and backoff.
  // Never force a refresh or initiate interactive authentication here.
  const summaries = await getConfiguredProviderUsageAsync({ cwd, timeoutMs: 5_000 });
  return projectBridgeProviderUsage(summaries);
}
