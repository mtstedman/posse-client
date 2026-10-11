import fs from "fs";
import path from "path";
import { buildSmartPreload } from "../../handoff/functions/index.js";
import { mergeUniquePaths, normalizeAssessmentScopePath } from "./assessment-scope.js";

function _formatLineNumberedFile(raw = "", startLine = 1) {
  return String(raw || "")
    .split("\n")
    .map((ln, i) => `${String(startLine + i).padStart(4)}\t${ln}`)
    .join("\n");
}

function _extractTaskLineRanges(taskSpec = "") {
  const ranges = [];
  for (const match of String(taskSpec || "").matchAll(/lines?\s+~?(\d+)\s*(?:[-–]\s*~?(\d+))?/gi)) {
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) continue;
    ranges.push({
      start: Math.max(1, start - 20),
      end: Math.max(start, end + 20),
    });
  }
  return ranges.slice(0, 6);
}

function _mergeLineRanges(ranges = []) {
  if (!Array.isArray(ranges) || ranges.length === 0) return [];
  const sorted = ranges
    .map((r) => ({ start: Math.max(1, Number(r.start) || 1), end: Math.max(1, Number(r.end) || 1) }))
    .sort((a, b) => a.start - b.start);
  const merged = [sorted[0]];
  for (const range of sorted.slice(1)) {
    const last = merged[merged.length - 1];
    if (range.start <= last.end + 5) {
      last.end = Math.max(last.end, range.end);
    } else {
      merged.push(range);
    }
  }
  return merged;
}

export function buildAssessmentFileSnapshots({ cwd = null, assessmentContext = null, taskSpec = "" } = {}) {
  if (!cwd || !assessmentContext || typeof assessmentContext !== "object") return "";

  const committedPaths = mergeUniquePaths(
    ...(Array.isArray(assessmentContext.files_committed) ? [assessmentContext.files_committed] : []),
  );
  // Changed files are the authoritative snapshot set. Fall back to scoped task
  // targets only when commit discovery was unavailable or empty.
  const candidatePaths = (committedPaths.length > 0
    ? committedPaths
    : mergeUniquePaths(
        ...(Array.isArray(assessmentContext.allowed_files) ? [assessmentContext.allowed_files] : []),
      )).slice(0, 6);
  if (candidatePaths.length === 0) return "";

  const lineHints = _extractTaskLineRanges(taskSpec);
  const sections = [];
  const totalBudgetChars = 48_000;
  const perFileBudgetChars = 20_000;
  let usedChars = 0;
  const addSection = (section) => {
    const remaining = totalBudgetChars - usedChars;
    if (remaining <= 0) return false;
    const bounded = String(section || "").slice(0, Math.min(perFileBudgetChars, remaining));
    if (bounded) {
      sections.push(bounded);
      usedChars += bounded.length;
    }
    return usedChars < totalBudgetChars;
  };

  for (const relPath of candidatePaths) {
    const normalizedPath = normalizeAssessmentScopePath(relPath, cwd);
    if (!normalizedPath) continue;
    const absPath = path.isAbsolute(normalizedPath) ? normalizedPath : path.resolve(cwd, normalizedPath);
    let raw = "";
    try {
      raw = fs.readFileSync(absPath, "utf8");
    } catch {
      if (!addSection(`=== ${normalizedPath} === (file not found or unreadable during assessment preload)`)) break;
      continue;
    }

    const lines = raw.replace(/\r\n/g, "\n").split("\n");
    // Prefer focused excerpts even for small files; whole-file snapshots are
    // resent after every agentic tool round-trip.
    const smart = buildSmartPreload(raw, taskSpec);
    if (smart && Array.isArray(smart.matched) && smart.matched.length > 0) {
      const parts = [`=== ${normalizedPath} (${smart.totalLines} lines) ===`];
      if (smart.imports && smart.imports.trim()) parts.push(`\nIMPORTS:\n${smart.imports}`);
      for (const fn of smart.matched) {
        parts.push(`\nFUNCTION: ${fn.name} [lines ${fn.startLine}-${fn.endLine}]\n${fn.content}`);
      }
      if (smart.toc && smart.toc.length > 0) {
        parts.push(`\nOTHER FUNCTIONS (read-only reference):`);
        for (const fn of smart.toc.slice(0, 20)) {
          parts.push(`  ${fn.name} [lines ${fn.startLine}-${fn.endLine}]`);
        }
      }
      if (!addSection(parts.join("\n"))) break;
      continue;
    }

    const mergedHints = _mergeLineRanges(lineHints.map((range) => ({
      start: range.start,
      end: Math.min(lines.length, range.end),
    })));
    if (mergedHints.length > 0) {
      const parts = [`=== ${normalizedPath} (${lines.length} lines, targeted excerpts) ===`];
      for (const range of mergedHints) {
        const excerpt = lines.slice(range.start - 1, range.end).join("\n");
        parts.push(`\nLINES ${range.start}-${range.end}:\n${_formatLineNumberedFile(excerpt, range.start)}`);
      }
      if (!addSection(parts.join("\n"))) break;
      continue;
    }

    const head = lines.slice(0, 120).join("\n");
    if (!addSection(`=== ${normalizedPath} (${lines.length} lines, head excerpt) ===\n${_formatLineNumberedFile(head)}`)) break;
  }

  return sections.length > 0
    ? `\nSCOPED FILE SNAPSHOTS (ground truth — use these to verify without re-reading when possible):\n${sections.join("\n\n")}\n`
    : "";
}
