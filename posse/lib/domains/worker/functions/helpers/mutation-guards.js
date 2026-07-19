// lib/domains/worker/functions/helpers/mutation-guards.js
//
// Mutation guard helpers for no-op detection, artifact reuse planning, and
// safe scoped delete / placement checks around worker mutations.

import fs from "fs";
import path from "path";
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

const COMPLETION_BLOCK_RE = /---\s*(DEV RESULT|DEV LOG|ARTIFICER RESULT|ARTIFICER LOG) START\s*---\s*([\s\S]*?)---\s*\1 END\s*---/i;

function matchAgentCompletionBlock(output) {
  return String(output || "").match(COMPLETION_BLOCK_RE);
}

export function extractCheckpointFromOutput(output) {
  if (!output || typeof output !== "string") return null;

  const parts = [];
  const logMatch = matchAgentCompletionBlock(output);
  if (logMatch) {
    parts.push(`PREVIOUS ATTEMPT ${logMatch[1].toUpperCase()}:\n${logMatch[2].trim()}`);
  }

  const fileOps = [];
  const writeMatches = output.matchAll(/(?:created|modified|edited|wrote|updated)\s+(?:file\s+)?['"`]?([^\s'"`]+\.[a-z]{1,10})['"`]?/gi);
  for (const match of writeMatches) {
    if (fileOps.length < 20) fileOps.push(match[1]);
  }
  if (fileOps.length > 0) {
    parts.push(`FILES TOUCHED IN PREVIOUS ATTEMPT:\n${[...new Set(fileOps)].map((file) => `  - ${file}`).join("\n")}`);
  }

  const fileRequestMatch = output.match(/FILE_REQUEST[\s\S]*?(?:FILE_REQUEST_END|---\s*DEV (?:RESULT|LOG)|$)/i);
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

const COMPLETION_LOG_FIELD_RE = /^\s*[A-Za-z0-9_-][A-Za-z0-9_ -]*\s*:/;
const MCP_INFRA_SIGNAL_RE = /(mcp__posse[-_]?gateway|posse[-_\s]?gateway|No such tool available|not connected to this session|MCP gateway)/i;

function escapeRegexText(value) {
  return String(value || "").replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function isUsefulCompletionLogValue(value) {
  const text = String(value || "").trim();
  return !!text && !/^[>|][+-]?$/.test(text);
}

function extractCompletionLogField(body, fieldName) {
  const lines = String(body || "").split(/\r?\n/);
  const keyRe = new RegExp(`^(\\s*)${escapeRegexText(fieldName)}\\s*:\\s*(.*)$`, "i");
  for (let i = 0; i < lines.length; i += 1) {
    const match = lines[i].match(keyRe);
    if (!match) continue;
    const baseIndent = match[1].length;
    const inlineValue = String(match[2] || "").trim();
    if (isUsefulCompletionLogValue(inlineValue)) return inlineValue;

    const collected = [];
    for (let j = i + 1; j < lines.length; j += 1) {
      const raw = lines[j];
      const trimmed = raw.trim();
      if (!trimmed) {
        if (collected.length > 0) collected.push("");
        continue;
      }
      const indent = raw.match(/^\s*/)?.[0]?.length || 0;
      if (indent <= baseIndent && COMPLETION_LOG_FIELD_RE.test(raw)) break;
      if (indent <= baseIndent && collected.length > 0) break;
      collected.push(raw.slice(Math.min(raw.length, baseIndent + 2)).trimEnd());
    }
    return collected.join("\n").trim() || null;
  }
  return null;
}

function hasMcpInfraSignal(value) {
  return MCP_INFRA_SIGNAL_RE.test(String(value || ""));
}

function firstMcpInfraSignalLine(value) {
  for (const raw of String(value || "").split(/\r?\n/)) {
    const line = raw.trim();
    if (line && hasMcpInfraSignal(line)) return line;
  }
  return null;
}

function chooseAgentBlockReason(body) {
  const notes = extractCompletionLogField(body, "notes");
  const summary = extractCompletionLogField(body, "summary");
  for (const candidate of [notes, summary]) {
    if (isUsefulCompletionLogValue(candidate) && hasMcpInfraSignal(candidate)) {
      return firstMcpInfraSignalLine(candidate) || String(candidate).trim();
    }
  }
  if (isUsefulCompletionLogValue(notes)) return notes;
  if (isUsefulCompletionLogValue(summary)) return summary;
  return firstMcpInfraSignalLine(body);
}

export function parseAgentCompletionLog(output = "") {
  const text = String(output || "");
  const match = matchAgentCompletionBlock(text);
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

  const label = String(match[1] || "").toUpperCase();
  const body = String(match[2] || "").trim();
  const statusMatch = body.match(/^\s*status:\s*([A-Z_ -]+)/im);
  const rawStatus = statusMatch?.[1]
    ? statusMatch[1].trim().toUpperCase().replace(/[\s-]+/g, "_")
    : null;
  const status = rawStatus === "NO_CHANGE" ? "VERIFIED_NO_CHANGE" : rawStatus;
  const blockReason = chooseAgentBlockReason(body);
  const verifiedNoChange = status === "VERIFIED_NO_CHANGE"
    || /^\s*verified_no_change:\s*(?:true|yes|1)\s*$/im.test(body)
    || /\bverified no(?: |-)?change\b/i.test(body);
  const verificationUnavailable = /^\s*verification_unavailable:\s*(?:true|yes|1)\s*$/im.test(body)
    || /\bVERIFICATION_UNAVAILABLE\b/i.test(body);

  return {
    found: true,
    kind: label.startsWith("ARTIFICER ") ? "artificer" : "dev",
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
