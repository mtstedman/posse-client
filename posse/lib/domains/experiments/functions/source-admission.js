import { fileDigest } from './snapshots.js';

// The regular Atlas coverage owner is tied to live files and work-item DB rows.
// Experiments instead admit reads against role-local, actually delivered snapshot
// bytes. Never treat a previous request, search hit, or clipped tail as evidence.
export async function admitSnapshotRead(history, files, args, read) {
  if (!history || !Object.hasOwn(files, args.path)) return read(args);
  const sha256 = fileDigest(files[args.path]);
  const total = files[args.path].split('\n').length;
  const first = args.start_line, last = Math.min(total, first + args.line_count - 1);
  const visible = new Map();
  for (const entry of history.entries) {
    if (entry.tool !== 'test.read' || entry.path !== args.path || entry.version !== args.version
      || entry.sha256 !== sha256 || typeof entry.content !== 'string'
      || !Number.isInteger(entry.end_line) || entry.end_line < entry.start_line) continue;
    const lines = entry.content.split('\n');
    if (entry.partial_line) lines.pop();
    for (let i = 0; i < lines.length; i++) {
      const line = entry.start_line + i;
      if (line >= first && line <= last && line <= entry.end_line) visible.set(line, lines[i]);
    }
  }
  if (!visible.size) return read(args);
  const reused = visible.size, ranges = [];
  for (let line = first; line <= last;) {
    if (visible.has(line)) { line++; continue; }
    const start = line;
    while (line <= last && !visible.has(line)) line++;
    ranges.push([start, line - 1]);
  }
  let partial = null;
  for (const [start, end] of ranges) {
    const result = await read({ ...args, start_line: start, line_count: end - start + 1 });
    const lines = result.content.split('\n');
    if (result.partial_line) partial = { line: result.end_line, text: lines.pop() };
    for (let i = 0; i < lines.length; i++) {
      if (result.end_line !== null && start + i <= result.end_line) visible.set(start + i, lines[i]);
    }
    if (result.truncated) break;
  }
  // A retained prefix must not consume the next result's byte allowance again.
  // Otherwise a large overlapping request can repeatedly clip before its newly
  // read tail, even though admission correctly avoided duplicate extraction.
  const deliveredFirst = ranges.length ? ranges[0][0] : first;
  const lines = []; let next = deliveredFirst;
  while (next <= last && visible.has(next)) lines.push(visible.get(next++));
  const partialLine = partial?.line === next;
  if (partialLine) lines.push(partial.text);
  const content = lines.join('\n'), end = lines.length ? deliveredFirst + lines.length - 1 : null;
  return { path: args.path, version: args.version, sha256, start_line: deliveredFirst, total_lines: total,
    content, content_bytes: Buffer.byteLength(files[args.path].split('\n').slice(deliveredFirst - 1, last).join('\n')), returned_bytes: Buffer.byteLength(content),
    end_line: end, partial_line: partialLine, truncated: next <= last,
    next_line: next <= total ? next : null,
    source_reuse: { blocked: ranges.length === 0, reused_lines: reused, read_ranges: ranges,
      notice: 'SOURCE_RANGE_REUSE: Reused retained snapshot lines; only uncovered ranges were read. Use requested_source without rereading it.' } };
}
