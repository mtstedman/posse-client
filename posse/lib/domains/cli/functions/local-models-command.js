// @ts-check

import { C } from "../../../shared/format/functions/colors.js";

import { LOCAL_MODEL_IDS } from "../../../catalog/local-model.js";
import {
  fetchLocalModelArtifactCatalog,
  prepareLocalModelArtifactClient,
} from "../../remote/functions/local-model-artifacts.js";

export async function runLocalModelsCommand(argv = [], {
  colors = C,
  output = process.stdout,
  prepareClient = prepareLocalModelArtifactClient,
  fetchCatalog = fetchLocalModelArtifactCatalog,
} = {}) {
  const args = (Array.isArray(argv) ? argv : [])
    .map((value) => String(value || "").trim())
    .filter((value) => value && !value.startsWith("-"));
  const action = String(args[0] || "").toLowerCase();
  if (action === "download") {
    throw new Error("Download local models with: posse local install <slug>");
  }
  if (action && action !== "list") {
    throw new Error(`Unknown local-models action: ${args[0]}. Use list, or posse local install <slug> to download.`);
  }

  const client = await prepareClient();
  const signedCatalog = await fetchCatalog(client);
  const catalog = {
    ...signedCatalog,
    artifacts: signedCatalog.artifacts.filter(artifact => LOCAL_MODEL_IDS.includes(artifact.artifactId)),
  };
  if (argv.includes("--json")) writeLine(output, JSON.stringify(catalog, null, 2));
  else renderLocalModelCatalog(catalog, { output, colors });
  return { action: "list", catalog };
}

// Both install surfaces ask the same question, with the exact byte count.
export function downloadQuestion({ label, bytes }) {
  return `Download ${label}: ${formatArtifactBytes(bytes)} (${formatInteger(bytes)} bytes)?`;
}

export function renderLocalModelCatalog(catalog, { output = process.stdout, colors = C } = {}) {
  writeLine(output, "");
  writeLine(output, `${colors.bold}  Local models${colors.reset}  ${colors.dim}signed catalog ${terminalText(catalog.revision)}${colors.reset}`);
  writeLine(output, `  ${colors.dim}Sizes are download sizes; memory values are the publisher's signed recommendations.${colors.reset}`);
  writeLine(output, "");
  catalog.artifacts.forEach((artifact, index) => {
    renderLocalModelArtifact(artifact, { output, colors, index: index + 1 });
    if (index < catalog.artifacts.length - 1) writeLine(output, "");
  });
  writeLine(output, "");
  writeLine(output, `  ${colors.dim}Install: posse local install <slug>${colors.reset}`);
  writeLine(output, "");
}

export function renderLocalModelArtifact(artifact, {
  output = process.stdout,
  colors = C,
  index = null,
} = {}) {
  const prefix = index == null ? " " : `${String(index).padStart(2)}.`;
  const shorthand = terminalText(artifact.shorthand);
  const recommendation = artifact.recommendation || {};
  const profile = [artifact.family, artifact.quantization, artifact.runtimeVersion && `runtime ${artifact.runtimeVersion}`]
    .map(terminalText)
    .filter(Boolean)
    .join(" · ");
  writeLine(output, `  ${colors.cyan}${prefix}${colors.reset} ${colors.bold}${terminalText(artifact.displayName)}${colors.reset} ${colors.dim}[${shorthand}]${colors.reset}`);
  writeLine(output, `      ${colors.dim}Download${colors.reset}       ${formatArtifactBytes(artifact.bytes)} ${colors.dim}(${formatInteger(artifact.bytes)} bytes)${colors.reset}`);
  writeLine(output, `      ${colors.dim}Memory${colors.reset}         ${formatMemoryRecommendation(recommendation)}`);
  writeLine(output, `      ${colors.dim}Recommended${colors.reset}    ${terminalText(recommendation.summary)}`);
  if (profile) writeLine(output, `      ${colors.dim}Profile${colors.reset}        ${profile}`);
  if (Array.isArray(recommendation.useCases) && recommendation.useCases.length > 0) {
    writeLine(output, `      ${colors.dim}Best for${colors.reset}       ${recommendation.useCases.map(terminalText).filter(Boolean).join(", ")}`);
  }
  if (Array.isArray(recommendation.notes) && recommendation.notes.length > 0) {
    writeLine(output, `      ${colors.dim}Notes${colors.reset}          ${recommendation.notes.map(terminalText).filter(Boolean).join("; ")}`);
  }
  if (artifact.license) writeLine(output, `      ${colors.dim}License${colors.reset}        ${terminalText(artifact.license)}`);
}

export function formatArtifactBytes(value) {
  const bytes = Number(value);
  if (!Number.isFinite(bytes) || bytes < 0) return "unknown size";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(1)} KiB`;
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MiB`;
  return `${(bytes / 1024 ** 3).toFixed(2)} GiB`;
}

export function formatMemoryRecommendation(recommendation = {}) {
  const minimum = positiveSafeInteger(recommendation.minimumMemoryBytes);
  const recommended = positiveSafeInteger(recommendation.recommendedMemoryBytes);
  if (minimum && recommended) {
    return `${formatArtifactBytes(minimum)} minimum · ${formatArtifactBytes(recommended)} recommended`;
  }
  if (recommended) return `${formatArtifactBytes(recommended)} recommended`;
  if (minimum) return `${formatArtifactBytes(minimum)} minimum`;
  return "not specified";
}

export function formatLocalModelDownloadProgress(status, colors = C) {
  const state = terminalText(status?.state || "downloading");
  const downloaded = positiveSafeInteger(status?.downloadedBytes) || 0;
  const total = positiveSafeInteger(status?.totalBytes) || 0;
  const permille = Number(status?.progressPermille);
  const percent = Number.isFinite(permille)
    ? `${Math.max(0, Math.min(100, permille / 10)).toFixed(1)}%`
    : total > 0 ? `${Math.min(100, downloaded / total * 100).toFixed(1)}%` : "0.0%";
  const speed = positiveSafeInteger(status?.bytesPerSecond);
  const eta = positiveSafeInteger(status?.etaSeconds);
  const details = [
    percent,
    total > 0 ? `${formatArtifactBytes(downloaded)} / ${formatArtifactBytes(total)}` : null,
    speed ? `${formatArtifactBytes(speed)}/s` : null,
    eta ? `${eta}s left` : null,
  ].filter(Boolean).join(" · ");
  return `${colors.cyan}${state}${colors.reset} ${details}`;
}

function positiveSafeInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : null;
}

function formatInteger(value) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) ? new Intl.NumberFormat("en-US").format(parsed) : "unknown";
}

export function terminalText(value) {
  return String(value ?? "")
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function writeLine(output, text = "") {
  output.write(`${text}\n`);
}
