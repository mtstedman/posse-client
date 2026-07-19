// lib/domains/providers/classes/registry-singleton.js
//
// Process-singleton ProviderRegistry instance. Stateful provider routing
// belongs in the class tree per the OOP boundary: registered provider
// instances, load errors, and provider/image selection cursors all live on
// `providerRegistry`.
//
// `lib/domains/providers/functions/provider.js` re-exports this binding so existing
// callers don't have to know where it's constructed.

import * as claude from "../functions/claude/index.js";
import * as posseLocal from "../functions/posse-local/index.js";
import { ProviderRegistry } from "./ProviderRegistry.js";

const PROVIDER_ALIASES = {};

export const providerRegistry = new ProviderRegistry({ aliases: PROVIDER_ALIASES });
providerRegistry.register("claude", claude);
providerRegistry.register("posse-local", posseLocal);

// Optional providers are loaded best-effort. Missing dependencies (e.g. no
// openai SDK installed, or its transitive `agentkeepalive` shim pruned from
// node_modules) become load errors on the registry, not boot failures. The
// loader table is the single source of truth for re-loading a provider after a
// missing dependency has been repaired (see reloadOptionalProvider).
const OPTIONAL_PROVIDER_LOADERS = Object.freeze({
  openai: () => import("../functions/openai/index.js"),
  codex: () => import("../functions/codex/index.js"),
  grok: () => import("../functions/grok/index.js"),
  copilot: () => import("../functions/copilot/index.js"),
});

for (const [name, load] of Object.entries(OPTIONAL_PROVIDER_LOADERS)) {
  try {
    providerRegistry.register(name, await load());
  } catch (err) {
    providerRegistry.setLoadError(name, err);
  }
}

/**
 * Canonical names of optional providers whose CURRENT load error is a
 * missing-module failure (ERR_MODULE_NOT_FOUND). This is the one provider-load
 * failure that a dependency install can recover — e.g. the openai SDK's
 * transitive `agentkeepalive` shim was dropped from node_modules by an npm
 * prune/partial install. Any other load error (syntax, runtime) is NOT
 * install-recoverable and is excluded.
 *
 * @returns {string[]}
 */
export function optionalProvidersMissingModule() {
  const out = [];
  for (const name of Object.keys(OPTIONAL_PROVIDER_LOADERS)) {
    const err = providerRegistry.getLoadError(name);
    if (err && err.code === "ERR_MODULE_NOT_FOUND") out.push(providerRegistry.canonicalName(name));
  }
  return out;
}

/**
 * Re-attempt loading an optional provider after its missing dependency has been
 * installed. A successful re-import registers the module and clears the load
 * error (in-process, no restart); a still-failing import refreshes the load
 * error. Returns true when the provider is loaded afterwards.
 *
 * @param {string} name
 * @returns {Promise<boolean>}
 */
export async function reloadOptionalProvider(name) {
  const canonical = providerRegistry.canonicalName(name);
  const load = OPTIONAL_PROVIDER_LOADERS[canonical];
  if (!load) return providerRegistry.has(canonical);
  try {
    providerRegistry.register(canonical, await load());
    return true;
  } catch (err) {
    providerRegistry.setLoadError(canonical, err);
    return false;
  }
}
