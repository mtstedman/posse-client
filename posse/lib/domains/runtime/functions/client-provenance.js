import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { adminGitExec } from "../../git/functions/admin-git.js";

const DEFAULT_CLIENT_ROOT = path.resolve(fileURLToPath(new URL("../../../../", import.meta.url)));
const CLEAN_CLIENT_SUBJECT_RE = /^Sync to posse main ([0-9a-f]{7,40})(?:\s|$)/;

function gitValue(clientRoot, args) {
  try {
    return String(adminGitExec(args, clientRoot, { timeoutMs: 5000 }) || "").trim() || null;
  } catch {
    return null;
  }
}

function packageVersion(clientRoot) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(clientRoot, "package.json"), "utf-8"));
    return typeof parsed?.version === "string" && parsed.version.trim()
      ? parsed.version.trim()
      : null;
  } catch {
    return null;
  }
}

function looksLikeSourceCheckout(clientRoot) {
  return fs.existsSync(path.join(clientRoot, "test"))
    && fs.existsSync(path.join(clientRoot, "scripts", "run-tests.mjs"));
}

export function resolveClientProvenance({ clientRoot = DEFAULT_CLIENT_ROOT } = {}) {
  const root = path.resolve(clientRoot);
  const clientCommit = gitValue(root, ["rev-parse", "HEAD"]);
  const subject = clientCommit ? gitValue(root, ["show", "-s", "--format=%s", "HEAD"]) : null;
  const cleanMatch = String(subject || "").match(CLEAN_CLIENT_SUBJECT_RE);
  let kind = "unknown";
  let sourceCommit = null;
  if (cleanMatch) {
    kind = "clean_client";
    sourceCommit = cleanMatch[1].toLowerCase();
  } else if (clientCommit && looksLikeSourceCheckout(root)) {
    kind = "source";
    sourceCommit = clientCommit;
  }

  return {
    schema_version: 1,
    kind,
    package_version: packageVersion(root),
    source_commit: sourceCommit,
    client_commit: clientCommit,
    commit_subject: subject,
  };
}

function shortCommit(value) {
  const text = String(value || "").trim();
  return text ? text.slice(0, 12) : "unknown";
}

export function formatClientProvenance(provenance = resolveClientProvenance()) {
  return [
    `kind=${provenance.kind || "unknown"}`,
    `version=${provenance.package_version || "unknown"}`,
    `source=${shortCommit(provenance.source_commit)}`,
    `client=${shortCommit(provenance.client_commit)}`,
  ].join("; ");
}

export function parseCleanClientSourceCommit(subject) {
  return String(subject || "").match(CLEAN_CLIENT_SUBJECT_RE)?.[1]?.toLowerCase() || null;
}
