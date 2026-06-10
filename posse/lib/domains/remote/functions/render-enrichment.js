import fs from "fs";
import { SETTING_KEYS } from "../../../catalog/settings.js";
import { getIntSetting } from "../../queue/functions/index.js";
import { resolvePathWithin } from "../../worker/functions/helpers/scope.js";
import { readFile } from "../../handoff/functions/helpers/file-attach.js";

const DEFAULT_MAX_FILE_SIZE = 150000;
const DEFAULT_MAX_PRELOAD_TOTAL = 80000;
const DEFAULT_MAX_RELATED_FILES_TOTAL = 400000;

function positiveIntSetting(key, fallback) {
  const value = getIntSetting(key, fallback);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function uniqueByPath(entries = []) {
  const out = [];
  const seen = new Set();
  for (const entry of entries || []) {
    const filePath = String(entry?.path || "").trim().replace(/\\/g, "/");
    if (!filePath || seen.has(filePath)) continue;
    seen.add(filePath);
    out.push({ ...entry, path: filePath });
  }
  return out;
}

function renderReadResult(file, result) {
  const kind = file.kind || "context";
  const required = file.required === false ? "optional" : "required";
  const header = `=== ${file.path} (${kind}, ${required}) ===`;
  if (result?.exists && result.content != null) {
    return `${header}\n${result.content || "(empty file)"}`;
  }
  if (result?.truncated) return `${header}\n(contents not inlined - file too large: ${result.size} bytes)`;
  if (result?.sensitive) return `${header}\n(contents not inlined - sensitive env file)`;
  if (result?.binary) return `${header}\n(contents not inlined - binary file)`;
  if (result?.empty) return `${header}\n(empty file)`;
  return `${header}\n(contents not inlined - missing or unreadable)`;
}

function renderFileGroup(label, files, {
  cwd,
  maxFileSize,
  totalBudget,
} = {}) {
  const sections = [];
  let used = 0;
  for (const file of files) {
    if (used >= totalBudget) {
      sections.push(`=== ${file.path} (${file.kind || "context"}) ===\n(contents not inlined - enrichment budget exhausted)`);
      continue;
    }
    const result = readFile(file.path, cwd, {
      fs,
      resolvePathWithin,
      maxFileSize,
    });
    if (result?.exists && Number.isFinite(Number(result.size))) {
      used += Number(result.size);
      if (used > totalBudget) {
        sections.push(`=== ${file.path} (${file.kind || "context"}) ===\n(contents not inlined - enrichment budget exhausted)`);
        continue;
      }
    }
    sections.push(renderReadResult(file, result));
  }
  if (sections.length === 0) return "";
  return [label, sections.join("\n\n")].join("\n");
}

export function renderLocalEnrichment(handoff, {
  cwd = process.cwd(),
  maxFileSize = positiveIntSetting("handoff_max_file_bytes", DEFAULT_MAX_FILE_SIZE),
  maxPreloadTotal = positiveIntSetting(SETTING_KEYS.HANDOFF_MAX_PRELOAD_TOTAL_BYTES, DEFAULT_MAX_PRELOAD_TOTAL),
  maxRelatedFilesTotal = positiveIntSetting("handoff_max_related_files_total_bytes", DEFAULT_MAX_RELATED_FILES_TOTAL),
} = {}) {
  const files = handoff?.files || {};
  const editable = uniqueByPath([
    ...(files.files_to_modify || []),
  ]);
  const readOnly = uniqueByPath(files.read_only_context || []);
  const createFiles = uniqueByPath(files.files_to_create || []);
  const deleteFiles = uniqueByPath(files.files_to_delete || []);
  const omitted = Array.isArray(handoff?.omitted_raw_source_files) ? handoff.omitted_raw_source_files : [];

  const parts = [
    "LOCAL ENRICHMENT BLOCK",
    "Exact local source context below was attached by the local client after remote prompt compilation.",
  ];

  const editableBlock = renderFileGroup("EDITABLE FILE CONTENT", editable, {
    cwd,
    maxFileSize,
    totalBudget: maxPreloadTotal,
  });
  if (editableBlock) parts.push(editableBlock);

  if (createFiles.length > 0) {
    parts.push([
      "CREATE TARGETS",
      ...createFiles.map((file) => `- ${file.path} (${file.kind || "creatable"})`),
    ].join("\n"));
  }

  if (deleteFiles.length > 0) {
    parts.push([
      "DELETE TARGETS",
      ...deleteFiles.map((file) => `- ${file.path} (${file.kind || "deletable"})`),
    ].join("\n"));
  }

  const readOnlyBlock = renderFileGroup("READ-ONLY CONTEXT FILE CONTENT", readOnly, {
    cwd,
    maxFileSize,
    totalBudget: maxRelatedFilesTotal,
  });
  if (readOnlyBlock) parts.push(readOnlyBlock);

  if (omitted.length > 0) {
    parts.push([
      "REMOTE RAW SOURCE OMISSION NOTICE",
      ...omitted.map((filePath) => `- ${filePath}`),
    ].join("\n"));
  }

  if (parts.length <= 2) return "";
  return parts.join("\n\n");
}
