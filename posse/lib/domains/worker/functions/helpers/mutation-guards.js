// lib/worker/helpers/mutation-guards.js
//
// Mutation guard helpers for no-op detection, artifact reuse planning, and
// safe scoped delete / placement checks around worker mutations.

import fs from "fs";
import path from "path";
import {
  buildManifest,
  getArtifactProtocol,
  isArtifactMode,
  validateManifestAgainstContract,
} from "../../../artifacts/functions/index.js";
import { isInsideRoot } from "../../../runtime/functions/fs-safety.js";
import { MutationPolicy } from "../../../../shared/scope/classes/MutationPolicy.js";

function mutationPolicyFor(job, payload) {
  return MutationPolicy.fromJob(job, payload);
}

function isRemovalTask(job, payload) {
  return mutationPolicyFor(job, payload).isRemovalTask(job, payload);
}

export function inferDeletionTargets(job, payload) {
  return mutationPolicyFor(job, payload).inferDeletionTargets(job, payload);
}

export function inferGeneratedArtifactDeletionTargets(job, payload) {
  return mutationPolicyFor(job, payload).inferGeneratedArtifactDeletionTargets(job, payload);
}

export function scopedDeleteTargets(job, payload) {
  return mutationPolicyFor(job, payload).scopedDeleteTargets(job, payload);
}

function isFilePlacementTask(job, payload) {
  return mutationPolicyFor(job, payload).isFilePlacementTask(job, payload);
}

function uniqueScopeFiles(...groups) {
  return [...new Set(groups.flat().filter(Boolean))];
}

export function extractCheckpointFromOutput(output) {
  if (!output || typeof output !== "string") return null;

  const parts = [];
  const logMatch = output.match(/---\s*DEV LOG START\s*---\s*([\s\S]*?)---\s*DEV LOG END\s*---/i);
  if (logMatch) {
    parts.push(`PREVIOUS ATTEMPT DEV LOG:\n${logMatch[1].trim()}`);
  }

  const fileOps = [];
  const writeMatches = output.matchAll(/(?:created|modified|edited|wrote|updated)\s+(?:file\s+)?['"`]?([^\s'"`]+\.[a-z]{1,10})['"`]?/gi);
  for (const match of writeMatches) {
    if (fileOps.length < 20) fileOps.push(match[1]);
  }
  if (fileOps.length > 0) {
    parts.push(`FILES TOUCHED IN PREVIOUS ATTEMPT:\n${[...new Set(fileOps)].map((file) => `  - ${file}`).join("\n")}`);
  }

  const fileRequestMatch = output.match(/FILE_REQUEST[\s\S]*?(?:FILE_REQUEST_END|---\s*DEV LOG|$)/i);
  if (fileRequestMatch) {
    parts.push(`PENDING FILE REQUESTS:\n${fileRequestMatch[0].trim().slice(0, 500)}`);
  }

  const beforeLog = logMatch ? output.slice(0, logMatch.index) : output;
  if (beforeLog.length > 500) {
    const tail = beforeLog.slice(-2000).trim();
    parts.push(`APPROACH SUMMARY (end of previous attempt output):\n${tail}`);
  }

  return parts.length > 0 ? parts.join("\n\n") : null;
}

export function loadCheckpoint(jobId, getArtifacts) {
  const artifacts = getArtifacts(jobId, "log");
  const checkpoint = artifacts.find((artifact) => artifact.content_long?.startsWith("checkpoint:"));
  return checkpoint ? checkpoint.content_long.slice("checkpoint:".length).trim() : null;
}

export function parseAgentCompletionLog(output = "") {
  const text = String(output || "");
  const match = text.match(/---\s*(DEV|ARTIFICER) LOG START\s*---\s*([\s\S]*?)---\s*(?:DEV|ARTIFICER) LOG END\s*---/i);
  if (!match) {
    return {
      found: false,
      kind: null,
      body: "",
      status: null,
      blockReason: null,
      verifiedNoChange: false,
      verificationUnavailable: false,
    };
  }

  const body = String(match[2] || "").trim();
  const statusMatch = body.match(/^\s*status:\s*([A-Z_ -]+)/im);
  const rawStatus = statusMatch?.[1]
    ? statusMatch[1].trim().toUpperCase().replace(/[\s-]+/g, "_")
    : null;
  const status = rawStatus === "NO_CHANGE" ? "VERIFIED_NO_CHANGE" : rawStatus;
  const blockReason = body.match(/^\s*notes:\s*(.+)$/im)?.[1]?.trim()
    || body.match(/^\s*summary:\s*(.+)$/im)?.[1]?.trim()
    || null;
  const verifiedNoChange = status === "VERIFIED_NO_CHANGE"
    || /^\s*verified_no_change:\s*(?:true|yes|1)\s*$/im.test(body)
    || /\bverified no(?: |-)?change\b/i.test(body);
  const verificationUnavailable = /^\s*verification_unavailable:\s*(?:true|yes|1)\s*$/im.test(body)
    || /\bVERIFICATION_UNAVAILABLE\b/i.test(body);

  return {
    found: true,
    kind: String(match[1] || "").toLowerCase(),
    body,
    status,
    blockReason,
    verifiedNoChange,
    verificationUnavailable,
  };
}

export function isDeleteNoopSatisfied(job, payload, cwd) {
  if (!isRemovalTask(job, payload)) return false;
  const scopedFiles = scopedDeleteTargets(job, payload);
  if (scopedFiles.length === 0) return false;
  return scopedFiles.every((file) => !fs.existsSync(path.resolve(cwd, file)));
}

export function isFilePlacementNoopSatisfied(job, payload, cwd, output = "") {
  if (!isFilePlacementTask(job, payload)) return false;
  const createFiles = Array.isArray(payload?.files_to_create) ? payload.files_to_create : [];
  const scopedFiles = uniqueScopeFiles(createFiles, payload?.files_to_modify || []);
  if (scopedFiles.length === 0) return false;
  const outputText = String(output || "").toLowerCase();
  const reportedAlreadyDone = /\b(already exists|already there|already present|already in place|nothing to (?:move|copy|do)|no changes needed|up to date|up-to-date)\b/.test(outputText);
  if (!reportedAlreadyDone) return false;
  return scopedFiles.every((file) => fs.existsSync(path.resolve(cwd, file)));
}

export function planArtifactReuse(task = {}, projectDir = ".") {
  const taskMode = task.task_mode || "code";
  const outputRoot = task.output_root || null;
  const createFiles = Array.isArray(task.files_to_create) ? task.files_to_create.filter(Boolean) : [];
  if (!outputRoot || !isArtifactMode(taskMode) || createFiles.length === 0) return null;

  const absOutputRoot = path.resolve(projectDir, outputRoot);
  if (!fs.existsSync(absOutputRoot)) return null;

  const manifest = buildManifest(absOutputRoot, absOutputRoot);
  if (!manifest || manifest.count === 0) return null;

  const protocol = getArtifactProtocol(taskMode) || {};
  const validation = protocol.output_validation || {};
  const allowedFormats = Array.isArray(protocol.allowed_formats) ? new Set(protocol.allowed_formats) : null;
  const minBytes = Number(validation.min_bytes || 0);
  const manifestMap = new Map(manifest.files.map((file) => [file.path, file]));

  const expected = [];
  const seen = new Set();
  for (const createFile of createFiles) {
    const absCreateFile = path.resolve(projectDir, createFile);
    const relPath = path.relative(absOutputRoot, absCreateFile).replace(/\\/g, "/");
    if (!isInsideRoot(absCreateFile, absOutputRoot, { allowEqual: false })) continue;
    if (seen.has(relPath)) continue;
    seen.add(relPath);
    expected.push({ createFile, relPath });
  }
  if (expected.length === 0) return null;

  const reusableFiles = [];
  const missingCreateFiles = [];
  for (const expectedFile of expected) {
    const existing = manifestMap.get(expectedFile.relPath);
    if (!existing) {
      missingCreateFiles.push(expectedFile.createFile);
      continue;
    }
    const formatOk = !allowedFormats || allowedFormats.has(existing.ext);
    const sizeOk = existing.size >= minBytes;
    if (formatOk && sizeOk) {
      reusableFiles.push(existing);
    } else {
      missingCreateFiles.push(expectedFile.createFile);
    }
  }
  if (reusableFiles.length === 0) return null;

  const reusableManifest = {
    files: reusableFiles,
    totalSize: reusableFiles.reduce((sum, file) => sum + (file.size || 0), 0),
    count: reusableFiles.length,
  };
  const contractResult = validateManifestAgainstContract(reusableManifest, taskMode);

  return {
    manifest,
    reusableManifest,
    reusableFiles,
    missingCreateFiles,
    allExpectedReusable: missingCreateFiles.length === 0,
    validReusableOutputs: !!contractResult.valid,
    warnings: contractResult.warnings || [],
  };
}

export function looksLikePermissionRequest(output) {
  const text = (output || "").toLowerCase();
  return (
    /approve .*write permission/.test(text) ||
    /grant .*write permission/.test(text) ||
    /permission to write/.test(text) ||
    /could you approve/.test(text) ||
    /unable to write .*permission/.test(text) ||
    /write permission .*hasn'?t been granted/.test(text)
  );
}
