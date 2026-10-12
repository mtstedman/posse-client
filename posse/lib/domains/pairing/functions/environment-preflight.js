import { getAtlasIntegrationConfig } from "../../integrations/functions/atlas/config.js";
import { PAIRING_DEPENDENCY_CHECK_TIMEOUT_MS } from "../../../catalog/pairing-environment.js";
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
  signal = null,
} = {}) {
  const input = pairingDependencyInput(projectDir, getDependencyConfig);
  const probe = async (repairing) => {
    const phase = repairing ? "repair" : "check";
    let latest = "repository dependencies";
    onProgress?.({ phase, message: `${repairing ? "Repairing" : "Checking"} ${latest}...` });
    try {
      const result = await sync({ ...input, ...(repairing ? { doctor: true } : {}), dryRun: !repairing }, {
        timeoutMs: repairing ? REPAIR_TIMEOUT_MS : PAIRING_DEPENDENCY_CHECK_TIMEOUT_MS,
        signal,
        onProgress: (event = {}) => {
          if (event.message) latest = String(event.message).split(/\r?\n/u)[0].slice(0, 200);
          onProgress?.({ ...event, phase });
        },
      });
      onProgress?.({ phase, message: `${repairing ? "Repair" : "Check"} complete: ${formatBootDependencySync(result)}` });
      return result;
    } catch (error) {
      if (signal?.aborted || error?.name === "AbortError") throw error;
      const failure = new Error(`Dependency ${phase} failed while checking ${latest}: ${String(error?.message || error).split(/\r?\n/u)[0]}. Run \`posse doctor\` for a detailed repair report.`, { cause: error });
      onProgress?.({ phase, status: "failed", message: failure.message });
      throw failure;
    }
  };
  return ensureBootDependencyGuard({
    check: () => probe(false),
    repair: () => probe(true),
    onRepair,
    signal,
  });
}

/** The run boot's warning for a degraded result, or null when nothing is missing. */
export function pairingEnvironmentWarning(result) {
  if (!result?.degraded) return null;
  return `Running without: ${result.degraded_reason || formatBootDependencySync(result)}; the next boot retries the repair.`;
}
