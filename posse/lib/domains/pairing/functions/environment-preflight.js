import { getAtlasIntegrationConfig } from "../../integrations/functions/atlas/config.js";
import { ensureBootDependencyGuard } from "../../cli/functions/boot-dependency-guard.js";
import {
  ensureBootDependenciesInWorker,
  formatBootDependencySync,
} from "../../system/functions/dependency-sync.js";

// The same bound the run gate uses: one repair can touch npm, Python, and SCIP
// environments, each with its own 30-minute command limit.
const REPAIR_TIMEOUT_MS = 3 * 60 * 60 * 1000;

// Mirrors the run gate's input (RunSession boot): Posse's own packages are
// gated before the CLI loads (guardRunNodeDependencies), native helpers by
// the boot DAG, and the model by `posse doctor`.
function pairingDependencyInput(projectDir, getDependencyConfig) {
  const config = getDependencyConfig() || {};
  return {
    projectDir,
    includePosseNode: false,
    includeNativeBinaries: false,
    includeJinaModel: false,
    scipMode: config.enabled === false ? "off" : (config.scipMode ?? config.atlas_scip_mode ?? null),
    scipLanguages: config.scipLanguages ?? config.atlas_scip_languages ?? null,
  };
}

/**
 * The run gate, before a session opens or a member goes active: check,
 * repair, and verify exactly as `posse run`/`posse go` boot does. If Posse can
 * run, it can pair. Anything still missing afterwards leaves the result
 * `degraded` and the session runs without it, as a run would; only what
 * stops boot (the guard throwing) stops pairing.
 */
export async function ensurePairingEnvironmentReady(projectDir, {
  sync = ensureBootDependenciesInWorker,
  getDependencyConfig = getAtlasIntegrationConfig,
  onRepair = () => {},
  onProgress = null,
} = {}) {
  const input = pairingDependencyInput(projectDir, getDependencyConfig);
  const workerOptions = { timeoutMs: REPAIR_TIMEOUT_MS, onProgress };
  return ensureBootDependencyGuard({
    check: () => sync({ ...input, dryRun: true }, workerOptions),
    repair: () => sync({ ...input, doctor: true, dryRun: false }, workerOptions),
    onRepair,
  });
}

/** The run boot's warning for a degraded result, or null when nothing is missing. */
export function pairingEnvironmentWarning(result) {
  if (!result?.degraded) return null;
  return `Running without: ${result.degraded_reason || formatBootDependencySync(result)}; the next boot retries the repair.`;
}
