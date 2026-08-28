import { C } from "../../../shared/format/functions/colors.js";
import { runSharedTrunkAccessPreflight } from "../../integrations/functions/shared-trunk-preflight.js";

function safeMessage(value) {
  return String(value || "unknown error")
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/@\s]+@/giu, "$1***@")
    .replace(/\b(token|password|authorization)=([^\s&]+)/giu, "$1=***")
    .slice(0, 1600);
}

export async function cmdPairingPreflight({ projectDir }) {
  const json = process.argv.slice(3).includes("--json");
  const raw = await runSharedTrunkAccessPreflight(projectDir);
  const report = raw.ok ? raw : { ...raw, message: safeMessage(raw.message) };

  if (json) {
    console.log(JSON.stringify(report));
  } else if (!report.ok) {
    console.error(`\n  ${C.bold}Pairing Access Preflight${C.reset}`);
    console.error(`  ${C.red}failed${C.reset} ${report.code}: ${report.message}\n`);
  } else {
    console.log(`\n  ${C.bold}Pairing Access Preflight${C.reset}`);
    console.log(`  Remote: ${report.remote}`);
    console.log(`  Shared branch: ${report.branch}`);
    console.log(`  ${C.green}passed${C.reset} read access`);
    console.log(`  ${C.green}passed${C.reset} noninteractive write transport (${report.writeCheck})`);
    if (report.checks.claimRefAccess === true) {
      console.log(`  ${C.green}passed${C.reset} claim-ref create/delete access`);
    } else {
      console.log(`  ${C.dim}skipped claim-ref probe (claims disabled)${C.reset}`);
    }
    console.log(`  ${C.yellow}note${C.reset} branch-protection policy is proven only by a real leased publication\n`);
  }

  if (!report.ok) process.exitCode = 1;
  return report;
}
