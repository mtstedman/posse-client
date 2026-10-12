import fs from "node:fs";

import {
  AGENT_RELEASE_CONFIG_KEYS,
  AGENT_RELEASE_DEFAULTS,
  AGENT_RELEASE_LIMITS,
  AGENT_RELEASE_PATHS,
} from "../../../catalog/agent-release.js";
import { VALID_BINARY_PACKAGE_NAMES } from "../../../catalog/binary.js";
import { demand } from "./policy.js";
import { readTrustedConfigFile } from "./system-release-integrity.js";

// Paths land verbatim in unit files and argv, so they stay in a plain set.
const SAFE_PATH = /^\/[A-Za-z0-9_.\/-]+$/;
const REMOTE_REF = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._\/-]+$/;

function safePath(value, key) {
  demand(SAFE_PATH.test(value) && !value.split("/").includes(".."),
    `${key} must be an absolute path of plain characters`, "invalid_request");
  return value.replace(/\/+$/, "") || "/";
}

function boundedInteger(value, key, max) {
  demand(/^[0-9]{1,7}$/.test(value) && Number(value) <= max, `${key} must be a whole number from 0 to ${max}`, "invalid_request");
  return Number(value);
}

function unquote(raw) {
  const value = raw.trim();
  const quoted = value.match(/^"([^"]*)"$/) || value.match(/^'([^']*)'$/);
  return quoted ? quoted[1] : value;
}

/**
 * Parse release.env text into a validated reconciler configuration. Unknown
 * keys are refused so a misspelled setting fails loudly.
 *
 * @param {string} text
 */
export function parseReleaseEnv(text) {
  const config = { ...AGENT_RELEASE_DEFAULTS, products: [...AGENT_RELEASE_DEFAULTS.products] };
  const seen = new Set();
  for (const rawLine of String(text || "").split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/);
    demand(match, `release.env line is not KEY=VALUE: ${line.slice(0, 80)}`, "invalid_request");
    const [, key, raw] = match;
    const field = AGENT_RELEASE_CONFIG_KEYS[key];
    demand(field, `release.env does not accept ${key}`, "invalid_request");
    demand(!seen.has(key), `release.env sets ${key} twice`, "invalid_request");
    seen.add(key);
    const value = unquote(raw);
    if (field === "sourceRepo" || field === "artifactRoot") config[field] = safePath(value, key);
    else if (field === "npmCli") config.npmCli = value ? safePath(value, key) : "";
    else if (field === "ref") {
      demand(REMOTE_REF.test(value) && !value.includes("..") && !value.includes("//") && !value.endsWith("/")
        && !value.endsWith(".lock"), `${key} must name a remote-tracking branch such as origin/main`, "invalid_request");
      config.ref = value;
    } else if (field === "products") {
      const products = value.split(/[\s,]+/).filter(Boolean);
      for (const product of products) demand(VALID_BINARY_PACKAGE_NAMES.has(product), `${key} names an unknown native product: ${product}`, "invalid_request");
      demand(new Set(products).size === products.length, `${key} repeats a product`, "invalid_request");
      config.products = products;
    } else if (field === "drainTimeoutSeconds") config.drainTimeoutSeconds = boundedInteger(value, key, AGENT_RELEASE_LIMITS.maxDrainTimeoutSeconds);
    else if (field === "keep") config.keep = boundedInteger(value, key, AGENT_RELEASE_LIMITS.maxKeep);
  }
  return config;
}

/**
 * Load /etc/posse-agent/release.env with the trust checks owner.env gets. A
 * missing file yields the defaults, which name no source repository.
 *
 * @param {{ io?: typeof fs, filename?: string, trustedUid?: number }} [options]
 */
export function loadReleaseConfig({ io = fs, filename = AGENT_RELEASE_PATHS.releaseEnv, trustedUid = 0 } = {}) {
  const text = readTrustedConfigFile(filename, { io, label: "Release environment", trustedUid });
  return parseReleaseEnv(text || "");
}

/**
 * The files whose change means published posse moved: the remote-tracking
 * loose ref and packed-refs of the source repository's common git dir.
 *
 * @param {{ sourceRepo: string, ref: string }} config
 */
export function sourceRefWatchPaths({ sourceRepo, ref }) {
  if (!sourceRepo) return [];
  return [`${sourceRepo}/.git/refs/remotes/${ref}`, `${sourceRepo}/.git/packed-refs`];
}
