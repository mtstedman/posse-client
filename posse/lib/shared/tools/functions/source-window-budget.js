import { sourceRows } from "./source-continuation.js";

// Partition a source envelope by its serialized size. Source rows are never
// clipped: a single oversized row moves wholly to the unseen continuation.
// Mutates the parsed, caller-owned envelope and returns the omitted windows.
export function boundSourceWindowEnvelope(envelope, capChars) {
  const data = envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope;
  if (!data || typeof data.content !== "string" || JSON.stringify(envelope).length <= capChars) return [];
  const primary = { content: data.content, startLine: data.startLine, endLine: data.endLine, identifiers: [] };
  const windows = [primary, ...(Array.isArray(data.additionalWindows) ? data.additionalWindows : [])];
  // Reserve the compact traversal/range summary and the eventual evidence ref.
  const budget = Math.max(0, capChars - 2048 - windows.length * 32);
  data.content = "";
  data.endLine = Number(data.startLine) - 1;
  delete data.additionalWindows;
  data.outputTruncated = true;
  data.truncated = true;
  // Optional navigation cannot displace the source transport's mandatory header.
  if (JSON.stringify(envelope).length > budget) {
    delete data.map;
    delete data.decisionPoints;
    delete data.returnedFunctionAnchors;
  }
  const omitted = [];
  let full = false;
  for (const [index, window] of windows.entries()) {
    if (full) { omitted.push(window); continue; }
    if (index === 0) {
      data.content = window.content;
      data.endLine = window.endLine;
      if (JSON.stringify(envelope).length <= budget) continue;
      const rows = sourceRows(window.content);
      let low = 0;
      let high = rows.length;
      while (low < high) {
        const count = Math.ceil((low + high) / 2);
        data.content = rows.slice(0, count).join("");
        data.endLine = Number(window.startLine) + count - 1;
        if (JSON.stringify(envelope).length <= budget) low = count;
        else high = count - 1;
      }
      data.content = rows.slice(0, low).join("");
      data.endLine = Number(window.startLine) + low - 1;
      omitted.push({ ...window, content: rows.slice(low).join(""), startLine: Number(window.startLine) + low });
      full = true;
    } else {
      data.additionalWindows = [...(data.additionalWindows || []), window];
      if (JSON.stringify(envelope).length <= budget) continue;
      data.additionalWindows.pop();
      omitted.push(window);
      full = true;
    }
  }
  if (data.additionalWindows?.length === 0) delete data.additionalWindows;
  const deferred = new Set(omitted.flatMap(window => window.identifiers || []));
  // A split primary has no per-anchor line locations; do not claim that its
  // identifiers were all delivered. The map's actual ranges remain authoritative.
  if (data.content !== primary.content) {
    for (const identifier of data.identifiersReturned || []) deferred.add(identifier);
  }
  data.identifiersReturned = (data.identifiersReturned || []).filter(identifier => !deferred.has(identifier));
  data.identifiersOmitted = [...new Set([...(data.identifiersOmitted || []), ...deferred])];
  return omitted.filter(window => window.content);
}
