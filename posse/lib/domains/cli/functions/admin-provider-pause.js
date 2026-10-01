// `posse admin provider-pause [list]` and `posse admin provider-pause clear
// <provider|all>`: view and clear the persisted provider pauses in the
// account DB. A dated weekly quota pauses a provider for up to 8 days, and a
// misread reset clock can pause one for hours; this is the operator's way out
// once the limit is lifted. A running `posse` process releases a cleared
// pause on its next provider check.

import { PROVIDER_OPTIONS } from "../../../catalog/provider.js";
import { formatDuration } from "../../../shared/format/functions/units.js";
import {
  clearPersistedProviderPause,
  listPersistedProviderPauses,
} from "../../providers/functions/provider-pause-state.js";

const NO_COLOR = Object.freeze({ bold: "", cyan: "", dim: "", green: "", red: "", reset: "", yellow: "" });

export function providerPauseAdminUsage() {
  return [
    "",
    "  Usage:",
    "    posse admin provider-pause [list]",
    "    posse admin provider-pause clear <provider|all>",
    "",
    `  Providers: ${PROVIDER_OPTIONS.join(", ")}`,
    "",
  ].join("\n");
}

/** One line describing an active provider pause. */
export function formatProviderPause(row, { nowMs = Date.now(), C = NO_COLOR } = {}) {
  const remaining = formatDuration(Math.max(0, row.untilMs - nowMs));
  return `${C.yellow}${row.provider}${C.reset} paused until ${new Date(row.untilMs).toISOString()} (${remaining} left; ${row.reason})`;
}

/**
 * Run `posse admin provider-pause ...`. Returns false on a usage error.
 * @param {string[]} args the arguments after `provider-pause`.
 */
export function runProviderPauseAdminCommand(args = [], {
  C = NO_COLOR,
  nowMs = Date.now(),
  log = console.log,
} = {}) {
  const [actionRaw, targetRaw, ...extra] = args;
  const action = String(actionRaw || "list").trim().toLowerCase();

  if (action === "list" && targetRaw == null) {
    const rows = listPersistedProviderPauses({ nowMs });
    if (rows.length === 0) {
      log("No provider pauses are active.");
      return true;
    }
    for (const row of rows) log(`  ${formatProviderPause(row, { nowMs, C })}`);
    log(`  ${C.dim}Clear one with: posse admin provider-pause clear <provider>${C.reset}`);
    return true;
  }

  if (action === "clear" && targetRaw != null && extra.length === 0) {
    const target = String(targetRaw).trim().toLowerCase();
    const providers = target === "all" ? PROVIDER_OPTIONS : (PROVIDER_OPTIONS.includes(target) ? [target] : null);
    if (!providers) {
      log(`  ${C.red}Unknown provider:${C.reset} ${targetRaw}`);
      log(providerPauseAdminUsage());
      return false;
    }
    const cleared = providers.map((provider) => clearPersistedProviderPause(provider, { nowMs })).filter(Boolean);
    if (cleared.length === 0) {
      log(`No active pause for ${target === "all" ? "any provider" : target}.`);
      return true;
    }
    for (const row of cleared) {
      log(`  ${C.green}Cleared${C.reset} ${formatProviderPause(row, { nowMs, C: NO_COLOR })}`);
    }
    log(`  ${C.dim}A running posse process releases the pause on its next provider check; jobs it already rescheduled keep their retry time.${C.reset}`);
    return true;
  }

  log(providerPauseAdminUsage());
  return false;
}
