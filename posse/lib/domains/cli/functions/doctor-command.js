import path from "path";

import { C } from "../../../shared/format/functions/colors.js";
import {
  doctorRepoDependencies,
  formatBootDependencySync,
} from "../../system/functions/dependency-sync.js";

function firstLine(value) {
  return String(value || "")
    .replace(/\x1B\[[0-?]*[ -/]*[@-~]/gu, "")
    .replace(/\r(?!\n)/gu, "\n")
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find(Boolean) || "";
}

function relativePath(projectDir, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const rel = path.relative(projectDir, text).replace(/\\/g, "/");
  if (!rel || rel === "." || rel.startsWith("../") || path.isAbsolute(rel)) return text;
  return rel;
}

function renderEntries({ log, colors, projectDir, title, entries = [], color }) {
  if (!entries.length) return;
  log(`\n  ${color}${title}${colors.reset}`);
  for (const entry of entries) {
    const label = entry.label || entry.language || "dependency";
    const status = entry.status || (entry.ok ? "ok" : "failed");
    const message = firstLine(entry.message || entry.reason || "");
    const runtime = entry.runtime_dir ? ` ${colors.dim}(${relativePath(projectDir, entry.runtime_dir)})${colors.reset}` : "";
    log(`    ${label}: ${status}${message ? ` - ${message}` : ""}${runtime}`);
  }
}

function renderDoctorHelp({ log, colors }) {
  log(`
  ${colors.bold}posse doctor${colors.reset}

  Repair dependency/runtime requirements for the current repo.

  Usage:
    posse doctor
    posse doctor --dry-run
    posse doctor --json

  Doctor installs are not timed out by default. Boot dependency sync stays bounded.
`);
}

export async function cmdDoctor({
  projectDir = process.cwd(),
  argv = process.argv.slice(3),
  runDoctor = doctorRepoDependencies,
  formatResult = formatBootDependencySync,
  colors = C,
  log = console.log,
} = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    renderDoctorHelp({ log, colors });
    return null;
  }

  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run");
  const result = await runDoctor({
    projectDir,
    dryRun,
    onProgress: (message) => {
      if (!json) log(`  ${colors.dim}[doctor]${colors.reset} ${message}`);
    },
  });

  if (json) {
    log(JSON.stringify(result, null, 2));
    return result;
  }

  const report = result.doctor || {};
  const mode = report.mode || (dryRun ? "plan" : "repair");
  const summary = report.summary || formatResult(result);
  const statusColor = result.ok ? colors.green : colors.red;
  log(`\n  ${statusColor}[doctor]${colors.reset} ${mode}: ${summary}`);
  log(`  ${colors.dim}project: ${projectDir}${colors.reset}`);
  log(`  ${colors.dim}timeout: none for doctor installs${colors.reset}`);

  renderEntries({ log, colors, projectDir, title: "Repaired", entries: report.repaired, color: colors.green });
  renderEntries({ log, colors, projectDir, title: "Pending", entries: report.pending, color: colors.yellow });
  renderEntries({ log, colors, projectDir, title: "Failed", entries: report.failed, color: colors.red });

  if (!report.repaired?.length && !report.pending?.length && !report.failed?.length) {
    log(`\n  ${colors.green}All dependency/runtime requirements are ready.${colors.reset}`);
  }
  log("");

  if (!result.ok) process.exitCode = 1;
  return result;
}
