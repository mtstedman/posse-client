// Which local models are on this machine, and which one a request gets when it
// names none. Shared by the local provider, `posse local` and Admin.
import fs from "node:fs";
import path from "node:path";

import { LOCAL_BRIDGE_MODELS, LOCAL_DEFAULT_MODELS, LOCAL_MODEL_PROFILES } from "../../../catalog/local-model.js";

export function localModelSupportsPlatform(model, platform = `${process.platform}-${process.arch}`) {
  return model.platforms.includes(platform);
}

/** True when the model's files are present and it can run on this platform. */
export function localBridgeModelInstalled(modelRoot, model) {
  if (!localModelSupportsPlatform(model)) return false;
  const profile = LOCAL_MODEL_PROFILES[model.modelId];
  return fs.existsSync(profile
    ? path.join(path.resolve(modelRoot), profile.directory, profile.installedFile)
    : path.join(path.resolve(modelRoot), model.directory));
}

/**
 * The default local model for a kind of work ("text", "code", "image",
 * "video"), or null when none applies. A saved choice is returned even when
 * its files are missing, so the caller can name the install command; with no
 * saved choice the first installed candidate wins.
 */
export function resolveDefaultLocalModel(kind, { modelRoot, readSetting }) {
  const entry = LOCAL_DEFAULT_MODELS.find(candidate => candidate.kind === kind);
  if (!entry) return null;
  let saved = "";
  try { saved = String(readSetting(entry.key) ?? "").trim(); } catch { /* unreadable settings mean automatic */ }
  const bySlug = slug => LOCAL_BRIDGE_MODELS.find(model => model.slug === slug);
  if (entry.candidates.includes(saved)) return bySlug(saved);
  return entry.candidates.map(bySlug).find(model => localBridgeModelInstalled(modelRoot, model)) || null;
}
