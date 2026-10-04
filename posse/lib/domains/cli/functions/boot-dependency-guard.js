// Run gate. A failed probe is never evidence that the environment is ready:
// repair once through the doctor engine, then verify before dispatch.
//
// Only Posse's own packages are required to run. `posse run`/`go` repair and
// gate those before the CLI loads SQLite (guardRunNodeDependencies in
// maintenance-bootstrap.js), so the run gate passes includePosseNode: false
// and the "posse npm" check below fires only for callers that include it.
// Anything else still failing after the repair (a language indexer, the
// repo's Composer or Python packages) leaves boot degraded with a warning
// instead of stopping the run: the run starts without that piece, and the
// next boot's repair tries again.
export async function ensureBootDependencyGuard({ check, repair, onRepair = () => {}, signal = null }) {
  const healthy = (result) => result?.ok === true
    && !(result.counts?.failed > 0)
    && !(result.counts?.dry_run > 0)
    && !(result.doctor?.pending?.length > 0);
  let checked;
  try { checked = await check(); }
  catch { checked = null; }
  if (healthy(checked)) return checked;
  onRepair();
  let repaired;
  try { repaired = await repair(); }
  catch (err) {
    // A boot abort (Ctrl+C) stops boot; the worker re-throws the signal's own
    // reason, so the signal, not the error's name, says it was an abort.
    if (signal?.aborted || err?.name === "AbortError") throw err;
    return degradedBoot(null, `dependency repair failed: ${firstLine(err)}`);
  }
  assertRequiredReady(repaired, "after posse doctor repair");
  if (!healthy(repaired)) return degradedBoot(repaired);
  let verified;
  try { verified = await check(); }
  catch (err) {
    if (signal?.aborted) throw err;
    return degradedBoot(repaired, `dependency check failed after repair: ${firstLine(err)}`);
  }
  if (healthy(verified)) return verified;
  assertRequiredReady(verified, "after repair");
  return degradedBoot(verified);
}

/** Entries without which Posse cannot run at all: its own npm packages. */
export function requiredDependencyFailures(result) {
  return (Array.isArray(result?.node) ? result.node : [])
    .filter((entry) => entry?.label === "posse npm" && (entry.status === "failed" || entry.ok === false));
}

function assertRequiredReady(result, when) {
  const failed = requiredDependencyFailures(result);
  if (failed.length === 0) return;
  const detail = failed.map((entry) => entry.message || entry.status).join("; ");
  throw new Error(`Boot blocked ${when}: Posse's own packages are not installed (${detail}). Run posse doctor or re-run the installer.`);
}

// degraded_reason names what went wrong when the result itself cannot (a
// crashed repair has no per-dependency counts to summarize).
function degradedBoot(result, reason = null) {
  return { ...(result || {}), ok: false, degraded: true, degraded_reason: reason };
}

function firstLine(err) {
  return String(err?.message || err || "unknown error").split(/\r?\n/u)[0];
}
