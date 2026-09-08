import { CODE_CONTENT_KINDS, SOURCE_DECISION_NAVIGATION as POLICY } from "../../../catalog/source-display.js";
import { canonicalEvidenceSourcePath } from "./source-evidence.js";
import { sourceRows } from "./source-continuation.js";

const lineText = (row) => row.replace(/(?:\r\n|\r|\n)$/, "");

/**
 * Syntax navigation may reference only complete expressions in visible source.
 * It never reads a file/ref or adds evidence coverage. The optional original
 * source lets retrieval reject points on native-redacted or mismatched lines.
 * @param {any} value
 * @param {string|null} [source]
 * @returns {{decisionPoints?: Array<{kind:string,lines:[number,number]}>,decisionPointsTruncated?:boolean}}
 */
export function sourceDecisionNavigation(value, source = null) {
  const file = canonicalEvidenceSourcePath(value?.repo_rel_path);
  if (!file || !Array.isArray(value?.decisionPoints)
    || value?.evidence_ref?.citable === false || value?.evidence_ref?.usage === "inspect_only"
    || value?.page?.mode === "search") return {};
  const original = typeof source === "string" ? sourceRows(source).map(lineText) : null;
  const windows = [value, ...(Array.isArray(value.additionalWindows) ? value.additionalWindows : [])]
    .filter(w => w && (w.contentKind == null || w.contentKind === CODE_CONTENT_KINDS.SOURCE)
      && canonicalEvidenceSourcePath(w.repo_rel_path || file) === file
      && typeof w.content === "string" && w.content
      && Number.isSafeInteger(w.startLine) && w.startLine >= 1
      && Number.isSafeInteger(w.endLine) && w.endLine >= w.startLine)
    .map(w => ({ ...w, rows: sourceRows(w.content).map(lineText) }))
    .filter(w => w.rows.length === w.endLine - w.startLine + 1);
  const points = [];
  const seen = new Set();
  let truncated = value.decisionPointsTruncated === true || value.decisionPoints.length > POLICY.maxCandidates;
  for (const point of value.decisionPoints.slice(0, POLICY.maxCandidates)) {
    if (!point || Object.keys(point).length !== 2 || !POLICY.kinds.includes(point.kind)
      || !Array.isArray(point.lines) || point.lines.length !== 2) continue;
    const [start, end] = point.lines;
    if (!Number.isSafeInteger(start) || start < 1 || !Number.isSafeInteger(end) || end < start) continue;
    if (!windows.some(w => start >= w.startLine && end <= w.endLine
      && (!original || w.rows.slice(start - w.startLine, end - w.startLine + 1)
        .every((row, i) => row === original[start - 1 + i])))) continue;
    const key = `${point.kind}:${start}:${end}`;
    if (seen.has(key)) continue;
    if (points.length === POLICY.maxPoints) { truncated = true; break; }
    seen.add(key);
    points.push({ kind: point.kind, lines: /** @type {[number,number]} */ ([start, end]) });
  }
  return points.length ? {
    decisionPoints: points,
    ...(truncated ? { decisionPointsTruncated: true } : {}),
  } : {};
}

// Called after paging/custody and before final display. Discard coordinates
// whose source was moved out of the inline response, including nested results.
export function refreshSourceDecisionNavigation(value) {
  if (!value || typeof value !== "object") return 0;
  let changed = 0;
  if (!Array.isArray(value) && (Object.hasOwn(value, "decisionPoints") || Object.hasOwn(value, "decisionPointsTruncated"))) {
    const navigation = sourceDecisionNavigation(value);
    delete value.decisionPoints;
    delete value.decisionPointsTruncated;
    Object.assign(value, navigation);
    changed += 1;
  }
  for (const child of Object.values(value)) changed += refreshSourceDecisionNavigation(child);
  return changed;
}
