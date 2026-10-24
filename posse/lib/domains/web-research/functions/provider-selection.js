import { LIVE_WEB_PROVIDERS } from "../../../catalog/provider.js";

// Capability filtering can narrow configured policy, never widen it.
export function selectWebResearchProvider({ parentProvider, availableProviders = [], allowedProviders = null, webEnabled = true } = {}) {
  const permitted = availableProviders.filter((provider) => LIVE_WEB_PROVIDERS.includes(provider)
    && (!Array.isArray(allowedProviders) || allowedProviders.includes(provider)));
  if (!webEnabled || permitted.length === 0) {
    const error = Object.assign(new Error(webEnabled
      ? "Live web research is unavailable: no permitted provider supports web execution."
      : "Live web research is unavailable: web tools are disabled."),
    { code: "WEB_RESEARCH_UNAVAILABLE", stage: "admission" });
    throw error;
  }
  return permitted.includes(parentProvider) ? parentProvider : permitted[0];
}
