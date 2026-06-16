// @ts-check
//
// ATLAS v2 tree-compression policy helpers — pure decisions about the
// compression mode, seed bounds, and whether a given warm should run the
// one-time ML reseed. Lifted out of ParseEngine/ViewBuilder so both depend on
// a single source rather than each carrying its own copy.

/**
 * ML labeling runs ONCE, at boot. Re-warms must not wait ~2 minutes on a
 * provider pass — the compressed tree is an orientation layer and is allowed
 * to lag; carried-forward labels cover it until the next boot.
 *
 * @param {{ purpose?: string | null, mode?: string | null, triggerEvent?: string | null }} args
 * @returns {{ run: boolean, reason: string | null }}
 */
export function shouldRunMlTreeCompressionReseed({ purpose, mode, triggerEvent } = {}) {
  const isMainPurpose = purpose === "main-incremental"
    || purpose === "main-full"
    || purpose === "main-merge";
  if (!isMainPurpose) return { run: false, reason: "not_main_purpose" };
  if (mode !== "ml") return { run: false, reason: "mode_not_ml" };
  if (triggerEvent !== "boot") return { run: false, reason: "ml_reseed_boot_only" };
  return { run: true, reason: null };
}

export function normalizeTreeCompressionMode(value) {
  const raw = String(value || "deterministic").trim().toLowerCase();
  if (raw === "off" || raw === "deterministic" || raw === "ml") return raw;
  return "deterministic";
}

export function positiveIntOrDefault(value, fallback) {
  const parsed = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
