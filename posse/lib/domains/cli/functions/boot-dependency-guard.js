// Required run gate. A failed probe is never evidence that the environment is
// ready. Repair once through the doctor engine, then verify before dispatch.
export async function ensureBootDependencyGuard({ check, repair, onRepair = () => {} }) {
  const healthy = (result) => result?.ok === true
    && !(result.counts?.failed > 0)
    && !(result.counts?.dry_run > 0)
    && !(result.doctor?.pending?.length > 0);
  let checked;
  try { checked = await check(); }
  catch { checked = null; }
  if (healthy(checked)) return checked;
  onRepair();
  const repaired = await repair();
  if (!healthy(repaired)) {
    const detail = repaired?.doctor?.summary || "required dependencies remain unresolved";
    throw new Error(`Boot blocked after posse doctor repair: ${detail}. Run posse doctor for details, fix the reported requirements, and retry.`);
  }
  const verified = await check();
  if (!healthy(verified)) throw new Error("Boot blocked: dependency verification still fails after repair. Run posse doctor for details.");
  return verified;
}
