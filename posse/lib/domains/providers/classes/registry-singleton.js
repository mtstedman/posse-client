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
import { ProviderRegistry } from "./ProviderRegistry.js";

const PROVIDER_ALIASES = {};

export const providerRegistry = new ProviderRegistry({ aliases: PROVIDER_ALIASES });
providerRegistry.register("claude", claude);

// Optional providers are loaded best-effort. Missing dependencies (e.g. no
// openai SDK installed) become load errors on the registry, not boot failures.
try {
  providerRegistry.register("openai", await import("../functions/openai/index.js"));
} catch (err) {
  providerRegistry.setLoadError("openai", err);
}

try {
  providerRegistry.register("codex", await import("../functions/codex/index.js"));
} catch (err) {
  providerRegistry.setLoadError("codex", err);
}

try {
  providerRegistry.register("grok", await import("../functions/grok/index.js"));
} catch (err) {
  providerRegistry.setLoadError("grok", err);
}

try {
  providerRegistry.register("copilot", await import("../functions/copilot/index.js"));
} catch (err) {
  providerRegistry.setLoadError("copilot", err);
}
