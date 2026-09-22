import fs from "node:fs";
import { resolveDeterministicReadableFile } from "../../../../../shared/tools/functions/toolkit/path-policy.js";
import { redactSecrets } from "./redaction.js";

// Search hits are discovery snippets, not complete implementation evidence.
// Mask from the original source context so a hit inside a multiline credential
// cannot lose its declaration boundary, and code identifiers remain intact.
export async function redactSearchContentRows(rows, { cwd, scopePredicates }, redact = redactSecrets) {
  const groups = new Map();
  for (const [index, row] of rows.entries()) {
    if (!groups.has(row.sourcePath)) groups.set(row.sourcePath, []);
    groups.get(row.sourcePath).push({ index, row });
  }
  const output = new Array(rows.length);
  for (const [sourcePath, entries] of groups) {
    const readable = resolveDeterministicReadableFile(cwd, sourcePath, scopePredicates);
    if (!readable.ok) throw new Error("Search source is no longer readable");
    const source = fs.readFileSync(readable.path, "utf8");
    const original = source.split(/\r?\n/);
    const safe = (await redact(source, {
      repoRelPath: entries[0].row.file, source, startLine: 1,
    })).split(/\r?\n/);
    if (safe.length !== original.length) throw new Error("Search source line alignment changed");
    const mask = (line) => {
      if (!Number.isSafeInteger(line.line) || line.line < 1 || original[line.line - 1] !== line.text) {
        throw new Error("Search source changed since discovery");
      }
      return { ...line, text: safe[line.line - 1] };
    };
    for (const { index, row } of entries) {
      output[index] = { ...mask(row), before: row.before.map(mask), after: row.after.map(mask) };
    }
  }
  return output;
}
