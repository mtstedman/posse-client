import crypto from "node:crypto";
import path from "node:path";

import { parseLeadingJsonValue } from "./delegated-evidence.js";

const PATH_KEYS = new Set([
  "file",
  "path",
  "repo_rel_path",
  "repoRelPath",
]);
const PATH_COLLECTION_KEYS = new Set([
  "files",
  "paths",
  "candidateFiles",
]);
const NON_SELECTION_KEYS = new Set([
  "dryRun",
  "reason",
  "rationale",
  "trace",
]);

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function normalizedPath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw) return null;
  const normalized = path.posix.normalize(raw).replace(/^\.\//, "");
  if (!normalized || normalized === "." || normalized === ".." || normalized.startsWith("../")) return null;
  return normalized;
}

function collectPaths(value, found = new Set(), key = "", depth = 0) {
  if (depth > 8 || found.size >= 100) return found;
  if (Array.isArray(value)) {
    if (PATH_COLLECTION_KEYS.has(key)) {
      for (const entry of value) {
        if (typeof entry === "string") {
          const candidate = normalizedPath(entry);
          if (candidate) found.add(candidate);
        } else {
          collectPaths(entry, found, key, depth + 1);
        }
      }
      return found;
    }
    for (const entry of value) collectPaths(entry, found, key, depth + 1);
    return found;
  }
  if (!value || typeof value !== "object") {
    if (PATH_KEYS.has(key)) {
      const candidate = normalizedPath(value);
      if (candidate) found.add(candidate);
    }
    return found;
  }
  for (const [childKey, child] of Object.entries(value)) {
    collectPaths(child, found, childKey, depth + 1);
  }
  return found;
}

function selectionValue(value, key = "") {
  if (Array.isArray(value)) return value.map((entry) => selectionValue(entry, key));
  if (value && typeof value === "object") {
    const out = {};
    for (const [childKey, child] of Object.entries(value)) {
      if (NON_SELECTION_KEYS.has(childKey)) continue;
      out[childKey] = selectionValue(child, childKey);
    }
    return out;
  }
  if (PATH_KEYS.has(key)) return normalizedPath(value) || String(value || "");
  if (PATH_COLLECTION_KEYS.has(key) && typeof value === "string") return normalizedPath(value) || value;
  return value;
}

function canonicalTool(value) {
  const raw = String(value || "").trim();
  if (!raw) return "unknown";
  if (raw.startsWith("tools_") || raw.startsWith("atlas_")) {
    const [suite, ...rest] = raw.split("_");
    return `${suite}.${rest.join(suite === "atlas" ? "." : "_")}`;
  }
  return raw;
}

function resultPayload(result) {
  const envelope = result?.result && typeof result.result === "object" ? result.result : result;
  const text = Array.isArray(envelope?.content)
    ? envelope.content.map((entry) => entry?.text || "").filter(Boolean).join("\n")
    : typeof envelope === "string"
      ? envelope
      : "";
  return parseLeadingJsonValue(text);
}

function identityRecord(tool, args, paths) {
  const targetKeys = new Set([...paths].map((entry) => `path:${entry}`));
  const selectionKey = `selection:${sha256(stableJson({
    tool: canonicalTool(tool),
    arguments: selectionValue(args || {}),
  }))}`;
  return {
    targetKeys,
    selectionKeys: new Set([selectionKey]),
    selectionTargets: new Map([[selectionKey, new Set(targetKeys)]]),
  };
}

function mergeIdentities(target, source) {
  for (const key of source?.targetKeys || []) target.targetKeys.add(key);
  for (const key of source?.selectionKeys || []) target.selectionKeys.add(key);
  for (const [selection, targets] of source?.selectionTargets || []) {
    target.selectionTargets.set(selection, new Set(targets));
  }
  return target;
}

export function subAgentEvidenceCallIdentities(requested = {}, args = {}, result = null) {
  const paths = collectPaths(args);
  collectPaths(resultPayload(result), paths);
  return identityRecord(`${requested.suite || ""}.${requested.name || ""}`, args, paths);
}

export function subAgentDispatchIdentities(args = {}, { materializeRef = null } = {}) {
  const identities = { targetKeys: new Set(), selectionKeys: new Set(), selectionTargets: new Map() };
  const requests = Array.isArray(args.requests) ? args.requests : [{ inputs: args.inputs }];
  for (const request of requests) {
    for (const input of Array.isArray(request?.inputs) ? request.inputs : []) {
      if (input?.ref != null || input?.kind === "ref") {
        let evidence = null;
        try {
          evidence = typeof materializeRef === "function" ? materializeRef(input.ref) : null;
        } catch {
          // Routing is an economic guard. Invalid/unresolvable refs remain for
          // the authoritative sub-agent validator and fail open here.
        }
        const paths = collectPaths(evidence?.provenance || {});
        collectPaths(parseLeadingJsonValue(evidence?.excerpt), paths);
        const refIdentity = {
          ref: evidence?.ref || input.ref,
          lines: evidence?.lines || null,
          source_content_sha256: evidence?.source_content_sha256 || null,
          excerpt_sha256: evidence?.excerpt_sha256 || null,
        };
        const targetKeys = new Set([...paths].map((entry) => `path:${entry}`));
        const selectionKey = `selection:${sha256(stableJson({ kind: "ref", ...refIdentity }))}`;
        mergeIdentities(identities, {
          targetKeys,
          selectionKeys: new Set([selectionKey]),
          selectionTargets: new Map([[selectionKey, new Set(targetKeys)]]),
        });
        continue;
      }
      const tool = canonicalTool(input?.tool || "unknown");
      const inputArgs = input?.arguments && typeof input.arguments === "object"
        ? input.arguments
        : input;
      mergeIdentities(identities, identityRecord(tool, inputArgs, collectPaths(inputArgs)));
    }
  }
  return identities;
}

export function subAgentMutationTargetKeys(args = {}) {
  return new Set([...collectPaths(args)].map((entry) => `path:${entry}`));
}
