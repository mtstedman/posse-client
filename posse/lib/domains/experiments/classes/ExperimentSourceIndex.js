import { sharedParserAdapter } from "../../atlas/classes/v2/ParserAdapter.js";
import { resolveLanguage } from "../../atlas/functions/v2/parser/languages/index.js";
import { EXPERIMENT_SOURCE_LIMITS as L, EXPERIMENT_SOURCE_FALLBACKS as F } from "../../../catalog/experiment-runner.js";
import { fileDigest } from "../functions/snapshots.js";

// Parse only owner-supplied snapshot buffers. Never open a repository view,
// follow imports, or resolve a payload path against the host filesystem.
export class ExperimentSourceIndex {
  constructor(parser = sharedParserAdapter) { this.parser = parser; this.cache = new Map(); }
  async symbols(path, source, digest) {
    const key = `${path}:${digest}`;
    if (this.cache.has(key)) return this.cache.get(key);
    let result;
    const language = resolveLanguage(path.slice(path.lastIndexOf(".")));
    if (!language?.supported) result = { symbols: [], fallback: F.UNSUPPORTED };
    else if (!this.parser.supports(language.tag)) result = { symbols: [], fallback: F.UNAVAILABLE };
    else {
      try {
        const parsed = await this.parser.parseBuffer({ bytes: source, repo_rel_path: path });
        if (parsed.content_hash !== digest || parsed.repo_rel_path !== path || !Array.isArray(parsed.symbols)) throw new Error("Snapshot parse mismatch.");
        result = { symbols: parsed.symbols, fallback: null };
      } catch { result = { symbols: [], fallback: F.FAILED }; }
    }
    this.cache.set(key, result);
    if (this.cache.size > L.cachedFiles) this.cache.delete(this.cache.keys().next().value);
    return result;
  }
  async search(plan, files, { query, version, path, offset = 0, limit = L.results }, signal) {
    const paths = plan.files.map(file => file.path);
    if (path !== undefined && !paths.includes(path)) throw new Error("File is outside the declared payload.");
    const needle = query.toLowerCase(), matches = [], parsing = { atlas_files: 0, lexical_files: {} };
    let total = 0;
    const add = row => { if (total >= offset && matches.length < limit) matches.push(row); total++; };
    for (const name of path === undefined ? paths : [path]) {
      signal?.throwIfAborted();
      if (!Object.hasOwn(files, name)) throw new Error("Declared snapshot file is missing.");
      const source = files[name], digest = fileDigest(source), lines = source.split("\n");
      const parsed = await this.symbols(name, source, digest);
      signal?.throwIfAborted();
      const symbols = parsed.symbols.filter(symbol => [symbol.name, symbol.qualified_name].some(value => typeof value === "string" && value.toLowerCase().includes(needle))
        && Number.isInteger(symbol.range_start_line) && symbol.range_start_line > 0 && symbol.range_start_line <= lines.length
        && Number.isInteger(symbol.range_end_line) && symbol.range_end_line >= symbol.range_start_line && symbol.range_end_line <= lines.length);
      if (!parsed.fallback) parsing.atlas_files++;
      if (symbols.length) for (const symbol of symbols) add([name, digest, String(symbol.qualified_name || symbol.name).slice(0, 160), String(symbol.kind).slice(0, 32), symbol.range_start_line, Math.min(200, symbol.range_end_line - symbol.range_start_line + 1), symbol.range_end_line]);
      else {
        const reason = parsed.fallback || F.NO_SYMBOL;
        parsing.lexical_files[reason] = (parsing.lexical_files[reason] || 0) + 1;
        for (const [index, line] of lines.entries()) if ((needle || line.trim()) && line.toLowerCase().includes(needle)) add([name, digest, line.trim().slice(0, 160), "text", index + 1, 1, index + 1]);
      }
    }
    const result = { version, columns: ["path", "sha256", "anchor", "kind", "start_line", "line_count", "end_line"], rows: matches, total, next_offset: null, omitted: 0, truncated: false, parsing };
    const update = () => { result.next_offset = offset + result.rows.length < total ? offset + result.rows.length : null; result.omitted = Math.max(0, total - offset - result.rows.length); result.truncated = result.omitted > 0; };
    update();
    while (Buffer.byteLength(JSON.stringify(result)) > L.searchBytes && result.rows.length) { result.rows.pop(); update(); }
    return result;
  }
  async overview(plan, files, signal) {
    const sorted = [...plan.files].sort((a, b) => Number(a.mode === "read") - Number(b.mode === "read"));
    const selected = sorted.slice(0, L.targets);
    const result = { columns: ["anchor", "kind", "start_line", "line_count", "end_line"], files: [], omitted_files: sorted.length - selected.length };
    for (const file of selected) {
      signal?.throwIfAborted();
      const source = files[file.path], digest = fileDigest(source), lines = source.split("\n");
      const parsed = await this.symbols(file.path, source, digest);
      signal?.throwIfAborted();
      const parents = new Map(parsed.symbols.map(symbol => [symbol.local_id, symbol]));
      const top = parsed.symbols.filter(symbol => !["module", "namespace"].includes(symbol.kind)
        && (symbol.parent_local_id == null || ["module", "namespace"].includes(parents.get(symbol.parent_local_id)?.kind))
        && Number.isInteger(symbol.range_start_line) && symbol.range_start_line > 0 && symbol.range_start_line <= lines.length
        && Number.isInteger(symbol.range_end_line) && symbol.range_end_line >= symbol.range_start_line && symbol.range_end_line <= lines.length);
      const priority = symbol => (/^\s*export\b/.test(lines[symbol.range_start_line - 1]) || symbol.visibility === "public" ? 0 : 2)
        + (["function", "class"].includes(symbol.kind) ? 0 : 1);
      top.sort((a, b) => priority(a) - priority(b) || a.range_start_line - b.range_start_line);
      const anchors = top.slice(0, 40).map(symbol => [String(symbol.qualified_name || symbol.name).slice(0, 120), String(symbol.kind).slice(0, 32), symbol.range_start_line, Math.min(200, symbol.range_end_line - symbol.range_start_line + 1), symbol.range_end_line]);
      if (!anchors.length) {
        const first = lines.findIndex(line => line.trim());
        if (first >= 0) anchors.push([lines[first].trim().slice(0, 120), "text", first + 1, Math.min(40, lines.length - first), Math.min(lines.length, first + 40)]);
      }
      result.files.push({ path: file.path, sha256: digest, mode: file.mode, anchors, omitted_anchors: Math.max(0, top.length - anchors.length),
        ...(parsed.fallback || !top.length ? { fallback: parsed.fallback || F.NO_SYMBOL } : {}) });
    }
    while (Buffer.byteLength(JSON.stringify(result)) > 4096 && result.files.length) {
      const largest = result.files.reduce((a, b) => a.anchors.length >= b.anchors.length ? a : b);
      if (largest.anchors.length > 1) { largest.anchors.pop(); largest.omitted_anchors++; }
      else { result.files.pop(); result.omitted_files++; }
    }
    return result;
  }
}
