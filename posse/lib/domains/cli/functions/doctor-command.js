import path from "path";

import { C } from "../../../shared/format/functions/colors.js";
import { getAtlasIntegrationConfig } from "../../integrations/functions/atlas/config.js";
import {
  DEFAULT_DOCTOR_COMMAND_TIMEOUT_MS,
  doctorRepoDependencies,
  formatBootDependencySync,
} from "../../system/functions/dependency-sync.js";
import { DEFAULT_JINA_MODEL_OPERATION_TIMEOUT_MS } from "../../atlas/functions/v2/embeddings/jina-model.js";
import {
  formatClientProvenance,
  resolveClientProvenance,
} from "../../runtime/functions/client-provenance.js";

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

function progressText(value) {
  if (value && typeof value === "object") {
    return firstLine(value.message || value.text || value.step || value.kind || "");
  }
  return firstLine(value);
}

function stepOrdinal(event = {}) {
  const index = Number(event.stepIndex || 0);
  const total = Number(event.totalSteps || 0);
  return index > 0 && total > 0 ? `[${index}/${total}] ` : "";
}

function formatLanguageStep(event = {}, { includeOrdinal = true } = {}) {
  const language = String(event.language || "environment");
  const step = firstLine(event.step || event.message || "install");
  const ordinal = includeOrdinal ? stepOrdinal(event) : "";
  return `${language} ${ordinal}${step}`.trim();
}

function formatLanguageStepFailure(event = {}) {
  const label = formatLanguageStep(event, { includeOrdinal: false });
  const message = progressText(event);
  const language = String(event.language || "environment");
  const index = Number(event.stepIndex || 0);
  const total = Number(event.totalSteps || 0);
  const prefix = `${language} ${index}/${total} failed:`;
  const detail = message.startsWith(prefix)
    ? firstLine(message.slice(prefix.length))
    : message;
  const step = firstLine(event.step);
  return detail && detail !== step ? `${label} - ${detail}` : label;
}

function createDoctorProgressRenderer({ log, colors, json }) {
  let sawStructuredScipInstall = false;
  let scipSectionShown = false;

  const showScipSection = () => {
    if (json || scipSectionShown) return;
    scipSectionShown = true;
    log(`\n  ${colors.bold}SCIP language environments${colors.reset}`);
  };

  const renderInstallEvent = (event = {}) => {
    const kind = String(event.kind || "");
    if (!kind.startsWith("environment.install.")) return false;
    sawStructuredScipInstall = true;
    if (json) return true;
    showScipSection();

    if (kind === "environment.install.started") {
      log(`    ${colors.dim}-${colors.reset} ${progressText(event) || "checking managed language environments"}`);
      return true;
    }
    if (kind === "environment.install.step.started") {
      log(`    ${colors.dim}-${colors.reset} ${formatLanguageStep(event)}`);
      return true;
    }
    if (kind === "environment.install.step.completed") {
      // The started event already rendered this logical step and its ordinal.
      // Rendering the completion event as a second line makes a normal run
      // look like 1, 1, 2, 2 rather than a step counter.
      return true;
    }
    if (kind === "environment.install.step.failed") {
      log(`    ${colors.red}x${colors.reset} ${formatLanguageStepFailure(event)}`);
      return true;
    }
    if (kind === "environment.install.language.failed") {
      log(`    ${colors.red}x${colors.reset} ${progressText(event) || formatLanguageStep(event, { includeOrdinal: false })}`);
      return true;
    }
    if (kind === "environment.install.completed") {
      log(`    ${colors.green}+${colors.reset} SCIP language environments ready`);
      return true;
    }
    if (kind === "environment.install.failed") {
      log(`    ${colors.red}x${colors.reset} SCIP language environment install failed`);
      return true;
    }
    log(`    ${colors.dim}-${colors.reset} ${progressText(event) || kind}`);
    return true;
  };

  const renderProgress = (message) => {
    if (json) return;
    const text = progressText(message);
    if (!text) return;
    if (sawStructuredScipInstall && /^SCIP deps:/iu.test(text)) return;
    log(`  ${colors.dim}[doctor]${colors.reset} ${text}`);
  };

  return {
    onEvent: renderInstallEvent,
    onProgress: renderProgress,
  };
}

function renderDoctorHelp({ log, colors }) {
  log(`
  ${colors.bold}posse doctor${colors.reset}

  Repair dependency/runtime requirements for the current repo.

  Usage:
    posse doctor
    posse doctor --dry-run
    posse doctor --json
    posse doctor --adopt-node-install

  Each package-manager command is capped at 30 minutes and Jina download/deploy
  at 2 hours, so an unhealthy child process cannot hang doctor indefinitely.
  --adopt-node-install reuses a complete existing Posse node_modules tree.
`);
}

export async function cmdDoctor({
  projectDir = process.cwd(),
  argv = process.argv.slice(3),
  runDoctor = doctorRepoDependencies,
  formatResult = formatBootDependencySync,
  getAtlasConfig = getAtlasIntegrationConfig,
  getClientProvenance = resolveClientProvenance,
  colors = C,
  log = console.log,
} = {}) {
  if (argv.includes("--help") || argv.includes("-h")) {
    renderDoctorHelp({ log, colors });
    return null;
  }

  const json = argv.includes("--json");
  const dryRun = argv.includes("--dry-run");
  const adoptNodeInstall = argv.includes("--adopt-node-install");
  const progress = createDoctorProgressRenderer({ log, colors, json });
  let result;
  try {
    const atlasConfig = getAtlasConfig?.() || {};
    result = await runDoctor({
      projectDir,
      dryRun,
      adoptNodeInstall,
      includeNativeBinaries: true,
      includeJinaModel: true,
      timeoutMs: DEFAULT_DOCTOR_COMMAND_TIMEOUT_MS,
      modelTimeoutMs: DEFAULT_JINA_MODEL_OPERATION_TIMEOUT_MS,
      scipMode: atlasConfig.enabled === false
        ? "off"
        : (atlasConfig.scipMode ?? atlasConfig.atlas_scip_mode ?? null),
      scipLanguages: atlasConfig.scipLanguages ?? atlasConfig.atlas_scip_languages ?? null,
      onProgress: progress.onProgress,
      onEvent: progress.onEvent,
    });
  } catch (err) {
    const message = firstLine(err?.message || err) || "dependency doctor failed";
    const failure = { label: "dependency doctor", ok: false, status: "failed", message };
    result = {
      ok: false,
      status: "failed",
      project_dir: projectDir,
      dry_run: dryRun,
      counts: { checked: 1, installed: 0, dry_run: 0, failed: 1, ready: 0 },
      doctor: {
        ok: false,
        mode: dryRun ? "plan" : "repair",
        summary: `1 failed: dependency doctor: ${message}`,
        checked: 1,
        repaired: [],
        pending: [],
        failed: [failure],
        ready: [],
      },
    };
  }

  result.client_provenance = getClientProvenance();

  if (json) {
    log(JSON.stringify(result, null, 2));
    if (!result.ok) process.exitCode = 1;
    return result;
  }

  const report = result.doctor || {};
  const mode = report.mode || (dryRun ? "plan" : "repair");
  const summary = report.summary || formatResult(result);
  const statusColor = result.ok ? colors.green : colors.red;
  log(`\n  ${statusColor}[doctor]${colors.reset} ${mode}: ${summary}`);
  log(`  ${colors.dim}project: ${projectDir}${colors.reset}`);
  log(`  ${colors.dim}client: ${formatClientProvenance(result.client_provenance)}${colors.reset}`);
  log(`  ${colors.dim}timeouts: package commands 30m; Jina download/deploy 2h${colors.reset}`);

  renderEntries({ log, colors, projectDir, title: "Repaired", entries: report.repaired, color: colors.green });
  renderEntries({ log, colors, projectDir, title: "Pending", entries: report.pending, color: colors.yellow });
  renderEntries({ log, colors, projectDir, title: "Failed", entries: report.failed, color: colors.red });
  renderEntries({
    log,
    colors,
    projectDir,
    title: "Verified native/model runtime",
    entries: (report.ready || []).filter((entry) => /^(?:native|model)\s/u.test(String(entry?.label || ""))),
    color: colors.green,
  });

  if (result.credentials?.posse_key === "missing") {
    log(`\n  ${colors.yellow}POSSE_KEY is not set${colors.reset} - ${result.credentials.remedy}`);
  }

  if (!report.repaired?.length && !report.pending?.length && !report.failed?.length) {
    if (result.credentials?.posse_key === "missing") {
      log(`\n  ${colors.green}Dependency/runtime requirements are ready${colors.reset} (except the missing POSSE_KEY above).`);
    } else {
      log(`\n  ${colors.green}All dependency/runtime requirements are ready.${colors.reset}`);
    }
  }
  log("");

  if (!result.ok) process.exitCode = 1;
  return result;
}
