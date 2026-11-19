// @ts-check
//
// Where an edit landed, stated in the edit's own result.
//
// An edit result that only said "File edited" left the agent to read the file
// again to confirm the edit and learn the new line numbers. The result now
// says the edit is saved, which lines it occupies in the file as it is now,
// how far the lines after it moved, and how long the file is. It carries no
// file content: the agent sent the content, and repeating it costs context
// on every later request.

/** 1-based line holding `offset`. */
function lineAt(/** @type {string} */ text, /** @type {number} */ offset) {
  let line = 1;
  for (let index = text.indexOf("\n"); index !== -1 && index < offset; index = text.indexOf("\n", index + 1)) line++;
  return line;
}

const lineRange = (/** @type {number} */ first, /** @type {number} */ last) => (first === last ? `line ${first}` : `lines ${first}-${last}`);
const moved = (/** @type {number} */ shift) => (shift === 0 ? "" : `, later lines ${shift > 0 ? "+" : ""}${shift}`);
const total = (/** @type {number} */ lines) => `, ${lines} line${lines === 1 ? "" : "s"} total`;

/** Lines with their terminators, so equal lines compare equal byte for byte. */
function splitLines(/** @type {string} */ text) {
  return text.match(/[^\n]*\n|[^\n]+$/g) || [];
}

/**
 * Where a single edit was saved, from a line-level diff: the unchanged
 * leading and trailing lines bound the edited region on both sides, so
 * neighbouring lines that share a prefix cannot misplace it.
 *
 * @param {string} original
 * @param {string} updated
 * @returns {string} e.g. "inserted lines 41-42, later lines +2, 214 lines total"; empty when nothing changed.
 */
export function editSummary(original, updated) {
  if (String(original) === String(updated)) return "";
  const before = splitLines(String(original));
  const after = splitLines(String(updated));
  let prefix = 0;
  while (prefix < before.length && prefix < after.length && before[prefix] === after[prefix]) prefix++;
  let suffix = 0;
  while (suffix < before.length - prefix && suffix < after.length - prefix
    && before[before.length - 1 - suffix] === after[after.length - 1 - suffix]) suffix++;
  const oldCount = before.length - prefix - suffix;
  const newCount = after.length - prefix - suffix;
  const first = prefix + 1;
  // Only lines below the edit move; at the end of the file there are none.
  const tail = `${suffix > 0 ? moved(after.length - before.length) : ""}${total(after.length)}`;
  if (oldCount === 0) return `inserted ${lineRange(first, first + newCount - 1)}${tail}`;
  if (newCount === 0) return `removed ${lineRange(first, first + oldCount - 1)}${tail}`;
  if (oldCount === newCount) return `changed ${lineRange(first, first + newCount - 1)}${tail}`;
  return `${lineRange(first, first + oldCount - 1)} ${oldCount === 1 ? "is" : "are"} now ${lineRange(first, first + newCount - 1)}${tail}`;
}

/**
 * Where the edits of a batch were saved, numbered as the file is after all
 * of them.
 *
 * @param {string} original
 * @param {string} updated
 * @param {Array<{ start: number, end: number }>} spans Character spans in `updated`.
 * @returns {string} e.g. "lines 5-6, 31 (current numbering), 41 lines total (was 40)"; empty when nothing changed.
 */
export function batchEditSummary(original, updated, spans) {
  const after = String(updated);
  if (!Array.isArray(spans) || spans.length === 0 || String(original) === after) return "";
  const ranges = [...spans]
    .sort((left, right) => left.start - right.start)
    .map((span) => {
      const first = lineAt(after, span.start);
      const last = lineAt(after, Math.max(span.start, span.end - 1));
      return first === last ? `${first}` : `${first}-${last}`;
    });
  const listed = ranges.length <= 12 ? ranges : [...ranges.slice(0, 12), `+${ranges.length - 12} more`];
  const was = splitLines(String(original)).length;
  const now = splitLines(after).length;
  return `line${ranges.length === 1 && !ranges[0].includes("-") ? "" : "s"} ${listed.join(", ")} (current numbering)${total(now)}${now === was ? "" : ` (was ${was})`}`;
}
