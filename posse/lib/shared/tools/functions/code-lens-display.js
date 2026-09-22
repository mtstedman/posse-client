import { canonicalEvidenceSourcePath } from "./source-evidence.js";

function declarationSignature(scope) {
  const signature = typeof scope?.signature === "string" ? scope.signature.trim() : "";
  if (!signature || [scope.name, scope.qualifiedName].filter(Boolean)
    .some((name) => signature === name || signature === `${scope.kind} ${name}`)) return null;
  return signature.replace(/\s+/gu, " ");
}

/**
 * Present a lens as source hunks, after source custody has consumed its native
 * matches. Never fetch additional lines or manufacture text across gaps.
 * Retain the compact match anchors for workflow references and navigation.
 */
export function codeLensDisplay(parsed, blockOffset = 0) {
  const data = parsed?.data || parsed;
  if (parsed?.ok === false || parsed?.error || !Array.isArray(data?.matches)
    || data.matches.length === 0) return null;
  if (parsed.action !== "code.lens" && parsed.tool !== "code.lens"
    && !Array.isArray(data.identifiersFound)) return null;
  const files = new Map();
  const groups = new Map();
  for (const match of data.matches) {
    const path = canonicalEvidenceSourcePath(match?.repo_rel_path || match?.path || data.repo_rel_path || data.path);
    const before = match?.context?.before ?? [];
    const after = match?.context?.after ?? [];
    if (!path || !Number.isSafeInteger(match?.line) || match.line < 1
      || typeof match.identifier !== "string"
      || typeof match.text !== "string" || !Array.isArray(before) || !Array.isArray(after)
      || before.length >= match.line) return null;
    const texts = [...before, match.text, ...after];
    if (texts.some((text) => typeof text !== "string" || /[\r\n]/u.test(text))) return null;
    const rows = files.get(path) || new Map();
    files.set(path, rows);
    const matchKind = match.matchKind || match.match_kind || null;
    const key = JSON.stringify([path, match.identifier, matchKind]);
    const group = groups.get(key) || { path, identifier: match.identifier, matchKind, lines: new Set() };
    group.lines.add(match.line);
    groups.set(key, group);
    for (let index = 0; index < texts.length; index += 1) {
      const line = match.line - before.length + index;
      if (!Number.isSafeInteger(line)) return null;
      const prior = rows.get(line);
      // Conflicting snapshots or clipped lines cannot be silently collapsed.
      if (prior && prior.text !== texts[index]) return null;
      const signatures = new Set(prior?.signatures || []);
      const signature = line === match.line ? declarationSignature(match.scope) : null;
      if (signature) signatures.add(signature);
      rows.set(line, { text: texts[index], matched: prior?.matched || line === match.line, signatures });
    }
  }

  const sections = [];
  for (const [path, rows] of files) {
    const ordered = [...rows.entries()].sort(([a], [b]) => a - b);
    const hunks = [];
    for (const [line, row] of ordered) {
      let hunk = hunks.at(-1);
      if (!hunk || hunk.at(-1).line + 1 !== line) { hunk = []; hunks.push(hunk); }
      hunk.push({ line, ...row });
    }
    sections.push(`File: ${path}\n${hunks.map((hunk) => {
      const source = hunk.map((row) => row.text).join(" ").replace(/\s+/gu, " ");
      const signatures = [...new Set(hunk.flatMap((row) => [...row.signatures]))]
        .filter((signature) => !source.includes(signature));
      const label = signatures.length > 0 ? ` ${signatures.join("; ")}` : "";
      return `@@ ${hunk[0].line}-${hunk.at(-1).line} @@${label}\n`
        + hunk.map((row) => `${row.matched ? ">" : " "} ${row.line}\t${row.text}`).join("\n");
    }).join("\n\n")}`);
  }
  const header = {
    ...data,
    matches: [...groups.values()].map((group) => ({
      identifier: group.identifier,
      lines: [...group.lines].sort((a, b) => a - b),
      ...(files.size > 1 ? { path: group.path } : {}),
      ...(group.matchKind ? { matchKind: group.matchKind } : {}),
    })),
    content_block: blockOffset + 1,
  };
  return {
    header: data === parsed ? header : { ...parsed, data: header },
    blocks: [{ type: "text", text: `${sections.join("\n\n")}\n\n> marks a matching line.` }],
  };
}
