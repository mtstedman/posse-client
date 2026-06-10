// @ts-check
//
// Provider-backed ATLAS tree compression enrichment.
//
// The view/tree module owns deterministic seed construction. This integration
// layer is the explicit, admin-configured bridge to a one-time model pass.

import { View } from "../../../atlas/classes/v2/View.js";
import {
  TREE_COMPRESSION_ML_PROFILE,
  refreshTreeCompressionSnapshotWithModelPass,
} from "../../../atlas/functions/v2/tree-compression.js";
import { getAtlasIntegrationConfig } from "./config.js";

/**
 * @param {{
 *   viewDb?: import("better-sqlite3").Database | null,
 *   viewPath?: string | null,
 *   cwd?: string | null,
 *   config?: Record<string, any> | null,
 *   annotator?: ((args: { prompt: string, input: any, snapshot: any }) => any | Promise<any>) | null,
 * }} [opts]
 */
export async function runAtlasTreeCompressionModelPass(opts = {}) {
  const config = opts.config || getAtlasIntegrationConfig();
  const mode = String(config.treeCompressionMode || config.atlas_tree_compression_mode || "deterministic").trim().toLowerCase();
  if (mode !== "ml") {
    return {
      ok: true,
      skipped: true,
      reason: `tree_compression_mode_${mode || "deterministic"}`,
      profile: TREE_COMPRESSION_ML_PROFILE,
    };
  }

  const hasInjectedAnnotator = typeof opts.annotator === "function";
  const providerName = String(
    config.treeCompressionProvider
      || config.atlasTreeCompressionProvider
      || config.atlas_tree_compression_provider
      || (hasInjectedAnnotator ? "injected" : await defaultTreeCompressionProviderName())
      || "claude",
  ).trim().toLowerCase();
  const modelTier = String(
    config.treeCompressionModelTier
      || config.atlasTreeCompressionModelTier
      || config.atlas_tree_compression_model_tier
      || "cheap",
  ).trim().toLowerCase() || "cheap";
  const modelName = hasInjectedAnnotator ? null : await resolveTierModelName(providerName, modelTier);
  const maxSeeds = positiveInt(
    config.treeCompressionMaxSeeds
      ?? config.atlasTreeCompressionMaxSeeds
      ?? config.atlas_tree_compression_max_seeds,
    80,
  );
  const modelMaxSeeds = positiveInt(
    config.treeCompressionModelMaxSeeds
      ?? config.atlasTreeCompressionModelMaxSeeds
      ?? config.atlas_tree_compression_model_max_seeds,
    40,
  );

  /** @type {View | null} */
  let view = null;
  const db = opts.viewDb || (() => {
    if (!opts.viewPath) throw new TypeError("runAtlasTreeCompressionModelPass: viewDb or viewPath is required");
    view = View.mount({ dbPath: opts.viewPath, mode: "readwrite" });
    return view._unsafeDb();
  })();
  try {
    const annotator = hasInjectedAnnotator
      ? opts.annotator
      : buildProviderAnnotator({ providerName, modelTier, cwd: opts.cwd || null });
    return await refreshTreeCompressionSnapshotWithModelPass(db, {
      maxSeeds,
      modelMaxSeeds,
      annotator,
      modelMetadata: {
        provider: providerName,
        modelTier,
        modelName,
      },
    });
  } finally {
    try { if (view) view.close(); } catch { /* ignore */ }
  }
}

function buildProviderAnnotator({ providerName, modelTier, cwd }) {
  return async ({ prompt }) => {
    const { getProvider } = await import("../../../providers/functions/provider.js");
    const provider = getProvider("researcher", providerName);
    const result = await provider.callProvider(prompt, {
      role: "planner",
      roleMode: "synth",
      allowWrite: false,
      modelTier,
      reasoningEffort: "low",
      activity: "ATLAS tree compression ML pass",
      silent: true,
      autoApprove: true,
      maxTurns: 1,
      cwd: cwd || process.cwd(),
      disableAtlas: true,
      skipRolePrompt: true,
    });
    return result?.output ?? "";
  };
}

function positiveInt(value, fallback) {
  const num = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(num) && num > 0 ? num : fallback;
}

async function defaultTreeCompressionProviderName() {
  try {
    const { getProviderName } = await import("../../../providers/functions/provider.js");
    return getProviderName("researcher");
  } catch {
    return "claude";
  }
}

async function resolveTierModelName(providerName, modelTier) {
  try {
    const { tierModelName } = await import("../../../providers/functions/provider.js");
    return tierModelName(modelTier, { providerName });
  } catch {
    return null;
  }
}
