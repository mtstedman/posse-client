// `posse merge <wi>` pre-merge preview and confirmation.

import { getCommandPositionalArgs } from "./flags.js";
import { describePartialWorkJobs, partialWorkToMerge } from "../../queue/functions/partial-work.js";

export function parseMergeCommandArgs(argv = process.argv) {
  const rest = argv.slice(3);
  const assumeYes = rest.includes("--yes") || rest.includes("-y");
  const wiArg = getCommandPositionalArgs(rest).find((arg) => arg !== "-y");
  return { wiArg: String(wiArg || "").trim(), assumeYes };
}

/**
 * Print what the squash merge will apply and confirm it. The diffstat runs
 * from the branch's merge-base with the target (`target...branch`), not from
 * the WI's recorded creation base: once the target is merged or synced into
 * the branch, the old base also counts the target's own changes.
 *
 * `--yes` answers the merge prompt. It never confirms partial work (failed or
 * canceled implementation jobs): that needs the typed "partial" answer.
 */
export async function confirmManualMerge({
  wi,
  targetBranch,
  jobs = [],
  assumeYes = false,
  gitDiffStat,
  ask,
  C,
  print = console.log,
}) {
  const diffLines = typeof gitDiffStat === "function" ? gitDiffStat(targetBranch, wi.branch_name) : [];
  if (diffLines.length > 0) {
    print(`\n  ${C.bold}Changes ${wi.branch_name} will merge into ${targetBranch}:${C.reset}`);
    for (const line of diffLines) print(`    ${line}`);
  }
  const partialWork = partialWorkToMerge(wi, jobs);
  if (partialWork.length > 0) {
    print(`\n  ${C.yellow}Partial work: WI#${wi.id} ${describePartialWorkJobs(partialWork)}; this merges only what landed on ${wi.branch_name}.${C.reset}`);
  }

  if (!assumeYes) {
    const confirm = await ask(`\n  Merge ${C.cyan}${wi.branch_name}${C.reset} into ${C.cyan}${targetBranch}${C.reset}? (y/n): `);
    if (String(confirm || "").trim().toLowerCase() !== "y") {
      print(`  ${C.dim}Canceled.${C.reset}\n`);
      return { ok: false };
    }
  }
  if (partialWork.length === 0) return { ok: true };
  if (assumeYes) {
    print(`  ${C.red}merge refused:${C.reset} --yes does not confirm partial work; rerun without --yes and type "partial".\n`);
    return { ok: false, exitCode: 1 };
  }
  const answer = await ask(`  Merge partial work? Type "partial" to confirm: `);
  if (String(answer || "").trim().toLowerCase() !== "partial") {
    print(`  ${C.dim}Canceled.${C.reset}\n`);
    return { ok: false };
  }
  return { ok: true, partialWork: true };
}
