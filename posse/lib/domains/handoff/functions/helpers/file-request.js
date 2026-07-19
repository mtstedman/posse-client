// lib/domains/handoff/functions/helpers/file-request.js
//
// FILE_REQUEST block parsing and risk classification helpers.

import path from "path";
import { SETTING_KEYS } from "../../../../catalog/settings.js";
import { isProtectedMutablePath } from "../../../runtime/functions/protected-paths.js";
import { getSetting } from "../../../queue/functions/settings.js";

/**
 * Risk tiers for file creation requests.
 *   low  - static assets: images, fonts, data files
 *   mid  - markup, config, styles
 *   high - scripts, executables, code, sensitive project/CI config
 */
const FILE_RISK_EXTENSIONS = {
  low: new Set([
    ".png", ".jpg", ".jpeg", ".gif", ".svg", ".ico", ".webp", ".bmp", ".avif",
    ".woff", ".woff2", ".ttf", ".eot", ".otf",
    ".csv", ".tsv",
    ".mp3", ".mp4", ".wav", ".ogg", ".webm",
    ".zip", ".tar", ".gz",
  ]),
  mid: new Set([
    ".html", ".htm", ".css", ".scss", ".less", ".sass",
    ".md", ".txt", ".rst", ".xml",
    ".yml", ".yaml", ".toml", ".ini", ".cfg",
    ".json", ".jsonc", ".json5",
    ".editorconfig", ".prettierrc", ".eslintrc",
    ".env.example",
  ]),
};

/**
 * Basenames that override extension-based classification.
 */
const FILE_RISK_BASENAMES = {
  low: new Set([]),
  mid: new Set([".gitignore", ".gitattributes", ".npmrc", ".nvmrc", ".editorconfig"]),
};

const HIGH_RISK_BASENAMES = new Set([
  ".gitlab-ci.yml",
  "appveyor.yml",
  "azure-pipelines.yml",
  "bitbucket-pipelines.yml",
  "bun.lock",
  "bun.lockb",
  "cargo.lock",
  "cloudbuild.yaml",
  "cloudbuild.yml",
  "composer.lock",
  "containerfile",
  "deno.json",
  "deno.lock",
  "dockerfile",
  "gemfile",
  "gemfile.lock",
  "jenkinsfile",
  "package-lock.json",
  "package.json",
  "pipfile",
  "pipfile.lock",
  "pnpm-lock.yaml",
  "poetry.lock",
  "procfile",
  "serverless.yml",
  "serverless.yaml",
  "vercel.json",
  "wrangler.toml",
  "yarn.lock",
]);

const KNOWN_EXTENSIONLESS_FILES = new Set([
  "buildfile",
  "containerfile",
  "dockerfile",
  "gemfile",
  "jenkinsfile",
  "justfile",
  "license",
  "licence",
  "makefile",
  "pipfile",
  "procfile",
  "rakefile",
  "readme",
  "taskfile",
  "vagrantfile",
]);

const ALLOWED_BARE_DOTFILES = new Set([
  ".env",
  ".env.example",
  ".env.local",
  ".env.development",
  ".env.production",
  ".env.test",
  ".gitignore",
  ".gitattributes",
  ".htaccess",
  ".npmrc",
  ".nvmrc",
  ".editorconfig",
  ".prettierrc",
  ".eslintrc",
  ".eslintignore",
  ".stylelintrc",
  ".prettierignore",
]);

function configuredLowRiskExtensions() {
  let raw = "";
  try { raw = getSetting(SETTING_KEYS.FILE_REQUEST_LOW_RISK_EXTENSIONS) || ""; } catch { raw = ""; }
  if (!raw) return new Set();
  return new Set(
    String(raw)
      .split(/[,\s]+/)
      .map((entry) => entry.trim().toLowerCase())
      .filter(Boolean)
      .map((entry) => entry.startsWith(".") ? entry : `.${entry}`)
      .filter((entry) => /^\.[a-z0-9][a-z0-9._+-]*$/.test(entry))
  );
}

function normalizeRequestedPath(filePath) {
  return String(filePath || "").trim().replace(/\\/g, "/");
}

export function isHighRiskPath(filePath) {
  const normalized = normalizeRequestedPath(filePath).toLowerCase();
  const basename = path.posix.basename(normalized);
  if (isProtectedMutablePath(normalized)) return true;
  if (normalized.startsWith(".github/") || normalized.startsWith(".gitlab/") || normalized.startsWith(".circleci/")) return true;
  if (HIGH_RISK_BASENAMES.has(basename)) return true;
  if (/^(?:tsconfig|jsconfig)(?:\.[^/]+)?\.json$/i.test(basename)) return true;
  if (/^(?:docker-compose|compose)(?:\.[^/]+)?\.ya?ml$/i.test(basename)) return true;
  return false;
}

export function looksLikeConcreteRequestedFile(filePath) {
  if (!filePath) return false;
  const normalized = normalizeRequestedPath(filePath);
  if (!normalized) return false;
  if (/^[A-Za-z]:\//.test(normalized) || normalized.startsWith("/")) return false;
  if (/[?*\[\]{}]/.test(normalized)) return false;
  if (normalized === "." || normalized === ".." || normalized.includes("/./") || normalized.includes("/../")) return false;
  if (normalized.startsWith("../") || normalized.endsWith("/..")) return false;

  const basename = path.posix.basename(normalized).toLowerCase();
  if (/^\.[a-z0-9_-]+$/.test(basename) && !ALLOWED_BARE_DOTFILES.has(basename)) return false;
  if (KNOWN_EXTENSIONLESS_FILES.has(basename)) return true;

  return normalized.includes(".") || normalized.includes("/");
}

export function classifyFileRisk(filePath) {
  if (isHighRiskPath(filePath)) return "high";

  const normalized = normalizeRequestedPath(filePath);
  const basename = path.posix.basename(normalized).toLowerCase();
  if (FILE_RISK_BASENAMES.low.has(basename)) return "low";
  if (FILE_RISK_BASENAMES.mid.has(basename)) return "mid";

  const ext = path.posix.extname(normalized).toLowerCase();
  if (FILE_RISK_EXTENSIONS.low.has(ext)) return "low";
  if (configuredLowRiskExtensions().has(ext)) return "low";
  if (FILE_RISK_EXTENSIONS.mid.has(ext)) return "mid";
  return "high";
}

export function parseFileRequest(output) {
  const lines = String(output || "").split(/\r?\n/);
  let fenceState = { inFence: false, marker: "", length: 0 };
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (!fenceState.inFence && /^\s*FILE_REQUEST\s*:\s*$/i.test(lines[i])) {
      start = i;
      break;
    }
    fenceState = nextMarkdownFenceState(fenceState, lines[i]);
  }
  if (start === -1) return null;

  const blockLines = [];
  for (let i = start + 1; i < lines.length; i++) {
    const line = lines[i];
    const inFence = fenceState.inFence;
    const nextFenceState = nextMarkdownFenceState(fenceState, line);
    if (!inFence && /^\s*FILE_REQUEST_END\s*$/i.test(line)) break;
    if (!inFence && /^---\s*(?:DEV|ARTIFICER) (?:RESULT|LOG)/i.test(line)) break;
    if (!inFence) blockLines.push(line);
    fenceState = nextFenceState;
  }

  const requests = [];
  for (const line of blockLines) {
    const parsed = parseFileRequestLine(line);
    if (!parsed) continue;
    const { filePath, reason } = parsed;
    if (looksLikeConcreteRequestedFile(filePath)) {
      requests.push({
        path: filePath,
        reason,
        risk: classifyFileRisk(filePath),
      });
    }
  }

  return requests.length > 0 ? requests : null;
}

function nextMarkdownFenceState(state, line) {
  const match = String(line || "").match(/^\s*(`{3,}|~{3,})/);
  if (!match) return state;

  const fence = match[1];
  const marker = fence[0];
  if (!state.inFence) {
    return { inFence: true, marker, length: fence.length };
  }
  if (marker === state.marker && fence.length >= state.length) {
    return { inFence: false, marker: "", length: 0 };
  }
  return state;
}

function splitFileRequestReason(text) {
  const raw = String(text || "").trim();
  const delimiter = raw.match(/\s+(?:[—–]+|--|-)\s+/);
  if (!delimiter) return { filePath: raw, reason: "" };
  const index = delimiter.index;
  return {
    filePath: raw.slice(0, index).trim(),
    reason: raw.slice(index + delimiter[0].length).trim(),
  };
}

function parseFileRequestLine(line) {
  const bullet = String(line || "").match(/^\s*[-•*]\s+(.+?)\s*$/);
  if (!bullet) return null;
  const entry = bullet[1].trim();
  if (!entry) return null;

  const quote = entry[0];
  if (quote === "\"" || quote === "`") {
    const end = entry.indexOf(quote, 1);
    if (end > 0) {
      const filePath = entry.slice(1, end).trim();
      const rest = entry.slice(end + 1).trim();
      const reason = rest.replace(/^(?:[—–]+|--)\s*/, "").trim();
      return { filePath, reason };
    }
  }

  return splitFileRequestReason(entry);
}

export function splitFileRequestsByRisk(requests) {
  const autoApproved = [];
  const needsApproval = [];
  for (const r of requests) {
    if (r.risk === "high") needsApproval.push(r);
    else autoApproved.push(r);
  }
  return { autoApproved, needsApproval };
}
