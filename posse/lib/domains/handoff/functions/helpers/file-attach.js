// lib/domains/handoff/functions/helpers/file-attach.js
//
// Deterministic file context attachment helpers for handoff packets.

import {
  HIGH_VALUE_SOURCE_EXTENSIONS,
  OBVIOUS_BINARY_EXTENSIONS,
  SUPPORTING_TEXT_EXTENSIONS,
} from "../../../../catalog/files.js";
import { isSensitiveEnvFileOrTargetPath } from "../../../runtime/functions/sensitive-paths.js";

function _normalizedPath(value) {
  return String(value || "").replace(/\\/g, "/");
}

function _extname(relPath) {
  const clean = _normalizedPath(relPath).split(/[?#]/)[0];
  const name = clean.split("/").pop() || "";
  const idx = name.lastIndexOf(".");
  return idx > 0 ? name.slice(idx).toLowerCase() : "";
}

function _basename(relPath) {
  return (_normalizedPath(relPath).split("/").pop() || "").toLowerCase();
}

function _dirname(relPath) {
  const normalized = _normalizedPath(relPath);
  const idx = normalized.lastIndexOf("/");
  return idx >= 0 ? normalized.slice(0, idx) : "";
}

function _textHaystack(packet) {
  const payload = packet?._raw_payload || {};
  const parts = [
    packet?.title,
    payload.task_spec,
    payload.instructions,
    payload.description,
    ...(Array.isArray(packet?.success_criteria) ? packet.success_criteria : []),
  ];
  return parts.filter(Boolean).join("\n").toLowerCase();
}

function _relatedFilePriority(relPath, packet, order) {
  const normalized = _normalizedPath(relPath);
  const lower = normalized.toLowerCase();
  const ext = _extname(normalized);
  const base = _basename(normalized);
  const haystack = _textHaystack(packet);
  const modifyDirs = new Set((packet?.files_to_modify || []).map(_dirname));
  let score = 0;

  if (haystack.includes(lower) || (base && haystack.includes(base))) score += 1000;
  if (modifyDirs.has(_dirname(normalized))) score += 300;
  if (HIGH_VALUE_SOURCE_EXTENSIONS.has(ext)) score += 250;
  else if (SUPPORTING_TEXT_EXTENSIONS.has(ext)) score += 120;
  if (ext === ".css") score -= 40;
  if (OBVIOUS_BINARY_EXTENSIONS.has(ext)) score -= 1000;

  return { relPath, score, order };
}

function _orderedRelatedFiles(packet) {
  return (packet?.related_files || [])
    .map((relPath, order) => _relatedFilePriority(relPath, packet, order))
    .sort((a, b) => (b.score - a.score) || (a.order - b.order))
    .map((entry) => entry.relPath);
}

export function readFile(relPath, cwd, deps = {}) {
  const {
    fs,
    resolvePathWithin,
    maxFileSize,
  } = deps;

  const fullPath = resolvePathWithin(cwd, relPath, { allowEqual: false });
  if (!fullPath) return { content: null, size: 0, exists: false };
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) return { content: null, size: 0, exists: false };
    if (isSensitiveEnvFileOrTargetPath(fullPath)) {
      return { content: null, size: stat.size, exists: true, sensitive: true };
    }
    if (stat.size === 0) return { content: "", size: 0, exists: true, empty: true };
    if (stat.size > maxFileSize) {
      return { content: null, size: stat.size, exists: true, truncated: true };
    }
    const buf = fs.readFileSync(fullPath);
    let raw = "";
    const hasNull = buf.includes(0);
    if (hasNull) {
      const bomLE = buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe;
      const bomBE = buf.length >= 2 && buf[0] === 0xfe && buf[1] === 0xff;
      if (bomLE || bomBE) {
        if (bomBE) {
          const swapped = Buffer.from(buf);
          for (let i = 0; i + 1 < swapped.length; i += 2) {
            const a = swapped[i];
            swapped[i] = swapped[i + 1];
            swapped[i + 1] = a;
          }
          raw = swapped.toString("utf16le");
        } else {
          raw = buf.toString("utf16le");
        }
      } else {
        return { content: null, size: stat.size, exists: true, binary: true };
      }
    } else {
      raw = buf.toString("utf-8");
    }
    const numbered = raw.split("\n")
      .map((ln, i) => `${String(i + 1).padStart(4)}\t${ln}`)
      .join("\n");
    return { content: numbered, size: stat.size, exists: true, lineCount: raw.split(/\r?\n/).length };
  } catch {
    return { content: null, size: 0, exists: false };
  }
}

function _describeEditableFile(relPath, cwd, deps = {}) {
  const {
    fs,
    resolvePathWithin,
  } = deps;
  const fullPath = resolvePathWithin(cwd, relPath, { allowEqual: false });
  if (!fullPath) {
    return { exists: false, size: 0, contentPreloaded: false, reason: "outside_project_scope" };
  }
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile()) {
      return { exists: false, size: 0, contentPreloaded: false, reason: "not_a_file" };
    }
    if (isSensitiveEnvFileOrTargetPath(fullPath)) {
      return { exists: true, size: stat.size, contentPreloaded: false, reason: "sensitive_env" };
    }
    return { exists: true, size: stat.size, contentPreloaded: false, reason: "preload_disabled" };
  } catch {
    return { exists: false, size: 0, contentPreloaded: false, reason: "missing" };
  }
}

export function directoryTree(dir, deps = {}) {
  const {
    fs,
    path,
    skipDirs,
    maxDepth = 2,
  } = deps;

  function walk(d, depth) {
    if (depth > maxDepth) return "";
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return ""; }
    const lines = [];
    const indent = "  ".repeat(depth);
    for (const entry of entries) {
      if (skipDirs.has(entry.name)) continue;
      if (entry.name.startsWith(".") && depth === 0 && entry.isDirectory()) continue;
      if (entry.isDirectory()) {
        lines.push(`${indent}${entry.name}/`);
        lines.push(walk(path.join(d, entry.name), depth + 1));
      } else {
        lines.push(`${indent}${entry.name}`);
      }
    }
    return lines.filter(Boolean).join("\n");
  }

  return walk(dir, 0);
}

export function collectSourceFiles(dir, deps = {}) {
  const {
    fs,
    path,
    skipDirs,
    sourceExtensions,
    maxPreloadTotal,
    maxFileSize,
  } = deps;

  const files = [];
  let totalSize = 0;

  function walk(d, depth) {
    if (depth > 3 || totalSize > maxPreloadTotal) return;
    let entries;
    try { entries = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      if (totalSize > maxPreloadTotal) return;
      if (skipDirs.has(entry.name)) continue;
      const full = path.join(d, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile()) {
        const ext = path.extname(entry.name).toLowerCase();
        if (!sourceExtensions.has(ext) && entry.name !== ".gitignore") continue;
        try {
          const stat = fs.statSync(full);
          if (stat.size > maxFileSize || stat.size === 0) continue;
          totalSize += stat.size;
          if (totalSize > maxPreloadTotal) return;
          files.push(path.relative(dir, full).replace(/\\/g, "/"));
        } catch { /* skip */ }
      }
    }
  }

  walk(dir, 0);
  return files;
}

export function attachEditableFiles(packet, deps = {}) {
  const {
    fs,
    path,
    resolvePathWithin,
    indexableExtensions,
    maxSmartPreloadSize,
    maxFileSize,
    buildSmartPreload,
    readFile: readFileFn,
    preloadMode = "off",
    forcePreload = false,
  } = deps;
  const { files_to_modify, cwd } = packet;
  const editable_files = {};
  const dropped_files = [];
  const smart_preloads = {};
  const editable_file_metadata = {};
  const normalizedPreloadMode = String(preloadMode || "off").trim().toLowerCase();
  const atlasPrefetchActive = !!packet?.atlas?.active && !packet?.atlas?.prefetchFailed && !forcePreload;
  const effectivePreloadMode = atlasPrefetchActive ? "off" : normalizedPreloadMode;
  const shouldPreloadBodies = !atlasPrefetchActive
    && (forcePreload || normalizedPreloadMode === "always" || normalizedPreloadMode === "small");
  const preloadAllowlist = Array.isArray(packet?.editable_file_preload_allowlist)
    ? new Set(packet.editable_file_preload_allowlist.map((entry) => String(entry || "").replace(/\\/g, "/")))
    : null;

  let taskSpec = "";
  try {
    const payload = packet._raw_payload || {};
    taskSpec = payload.task_spec || payload.instructions || "";
  } catch { /* ignore */ }

  for (const relPath of files_to_modify) {
    const ext = path.extname(relPath).toLowerCase();
    const fullPath = resolvePathWithin(cwd, relPath, { allowEqual: false });
    if (!fullPath) {
      dropped_files.push(`${relPath} (outside project scope)`);
      editable_files[relPath] = null;
      editable_file_metadata[relPath] = { exists: false, size: 0, contentPreloaded: false, reason: "outside_project_scope" };
      continue;
    }

    if (shouldPreloadBodies) {
      let stat = null;
      try { stat = fs.statSync(fullPath); } catch { /* fall through to normal read */ }
      if (stat?.isFile?.() && isSensitiveEnvFileOrTargetPath(fullPath)) {
        editable_files[relPath] = null;
        editable_file_metadata[relPath] = {
          exists: true,
          size: stat.size || 0,
          contentPreloaded: false,
          reason: "sensitive_env",
        };
        continue;
      }
    }

    const preloadAllowedForPath = !preloadAllowlist || preloadAllowlist.has(String(relPath || "").replace(/\\/g, "/"));
    if (!shouldPreloadBodies || !preloadAllowedForPath) {
      editable_files[relPath] = null;
      editable_file_metadata[relPath] = _describeEditableFile(relPath, cwd, { fs, resolvePathWithin });
      if (!preloadAllowedForPath) {
        editable_file_metadata[relPath] = {
          ...editable_file_metadata[relPath],
          contentPreloaded: false,
          reason: "preload_capped",
        };
      }
      continue;
    }

    if (indexableExtensions.has(ext) && taskSpec) {
      try {
        const stat = fs.statSync(fullPath);
        if (stat.isFile() && stat.size > 0 && stat.size <= maxSmartPreloadSize) {
          const raw = fs.readFileSync(fullPath, "utf-8");
          const smart = buildSmartPreload(raw, taskSpec);
          if (smart) {
            smart_preloads[relPath] = smart;
            editable_files[relPath] = null;
            editable_file_metadata[relPath] = {
              exists: true,
              size: stat.size,
              lineCount: smart.totalLines || raw.split(/\r?\n/).length,
              contentPreloaded: true,
              preloadKind: "smart",
            };
            continue;
          }
        }
      } catch { /* fall through to normal read */ }
    }

    const result = readFileFn(relPath, cwd);
    if (!result) continue;
    if (result.truncated) {
      dropped_files.push(`${relPath} (${(result.size / 1024).toFixed(0)}KB — exceeds ${maxFileSize / 1024}KB limit)`);
      editable_files[relPath] = null;
      editable_file_metadata[relPath] = {
        exists: true,
        size: result.size || 0,
        contentPreloaded: false,
        truncated: true,
        reason: "file_too_large",
      };
    } else {
      editable_files[relPath] = result.exists ? result.content : null;
      editable_file_metadata[relPath] = {
        exists: !!result.exists,
        size: result.size || 0,
        lineCount: result.lineCount || null,
        contentPreloaded: !!(result.exists && result.content),
        preloadKind: result.exists && result.content ? "full" : null,
        empty: !!result.empty,
        binary: !!result.binary,
        sensitive: !!result.sensitive,
        reason: result.sensitive ? "sensitive_env" : (result.exists ? null : "missing"),
      };
    }
  }

  packet.editable_files = editable_files;
  packet.editable_file_metadata = editable_file_metadata;
  packet.editable_file_preload_mode = forcePreload && !atlasPrefetchActive ? "forced" : effectivePreloadMode;
  packet.smart_preloads = smart_preloads;
  packet.dropped_files = dropped_files;
}

export function attachCreatableFiles(packet, deps = {}) {
  const {
    readFile: readFileFn,
  } = deps;
  const { files_to_create, cwd } = packet;
  const creatable_files = {};

  for (const relPath of files_to_create) {
    const result = readFileFn(relPath, cwd);
    creatable_files[relPath] = result.exists ? { exists: true, content: result.content } : { exists: false, content: null };
  }

  packet.creatable_files = creatable_files;
}

export function attachRelatedFiles(packet, deps = {}) {
  const {
    readFile: readFileFn,
    maxRelatedFilesTotal,
  } = deps;
  const { files_to_modify, cwd } = packet;
  const relatedFilesCwd = packet.context_hints?.related_files_cwd || packet.context_hints?.related_files_base_cwd || cwd;
  const editableSet = new Set(files_to_modify);
  const related = {};
  const dropped = [];
  let totalBytes = 0;
  const orderedRelatedFiles = _orderedRelatedFiles(packet);

  for (const relPath of orderedRelatedFiles) {
    if (editableSet.has(relPath)) continue;
    if (OBVIOUS_BINARY_EXTENSIONS.has(_extname(relPath))) {
      dropped.push({ path: relPath, reason: "binary" });
      continue;
    }
    const result = readFileFn(relPath, relatedFilesCwd);
    if (result && result.exists && result.content) {
      const contentBytes = Buffer.byteLength(result.content, "utf8");
      if (totalBytes + contentBytes > maxRelatedFilesTotal) {
        dropped.push({ path: relPath, reason: "cumulative_size_limit" });
        continue;
      }
      related[relPath] = result.content;
      totalBytes += contentBytes;
      continue;
    }
    let reason = "unreadable";
    if (!result?.exists) reason = "missing_or_outside_scope";
    else if (result?.sensitive) reason = "sensitive_env";
    else if (result?.binary) reason = "binary";
    else if (result?.truncated) reason = "file_too_large";
    else if (result?.empty) reason = "empty";
    dropped.push({ path: relPath, reason });
  }

  packet.related_files_content = related;
  packet.related_files_dropped = dropped;
  packet.related_files_total_bytes = totalBytes;
  packet.related_files_attach_order = orderedRelatedFiles;
}

export function attachDirectoryTree(packet, deps = {}) {
  const {
    directoryTree: directoryTreeFn,
  } = deps;
  packet.directory_tree = directoryTreeFn(packet.cwd) || null;
}

export function attachSourcePreload(packet, deps = {}) {
  const {
    collectSourceFiles: collectSourceFilesFn,
    readFile: readFileFn,
  } = deps;
  const source_files = {};
  const filePaths = collectSourceFilesFn(packet.cwd);
  for (const relPath of filePaths) {
    const result = readFileFn(relPath, packet.cwd);
    if (result && result.exists && result.content) {
      source_files[relPath] = result.content;
    }
  }
  packet.source_files = source_files;
}
