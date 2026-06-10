// @ts-check
//
// Query planner. Turns a natural-language task string into a structured
// retrieval plan: identifiers, path/file hints, stack frames, language
// hints, a coarse symptom label, and a deduped keyword list.
//
// The plan is the v2 substitute for "throw the whole task at FTS and pray".
// Backends consume specific facets:
//   - FTS probes identifiers first (exact-name match), then file/path
//     terms, then keyword token combinations.
//   - Vector search can still use the raw text, but the plan gives it
//     better seed terms when the encoder degrades.
//   - Task-query ranking favors symbols whose names overlap identifiers
//     more than they overlap stop-word soup.
//
// Pure function. No DB or I/O. Trivially unit-testable.

import { runAtlasNativeOperation } from "../../native/invoke.js";
import { nativeBinaries } from "../../../../../../classes/tools/BinaryManager.js";

/** @typedef {import("./query-planner-types.js").StackFrame} StackFrame */
/** @typedef {import("./query-planner-types.js").QueryPlan} QueryPlan */

const STOPWORDS = new Set([
  "a", "an", "the", "and", "or", "but", "is", "are", "was", "were",
  "be", "been", "being", "to", "of", "in", "on", "for", "with", "at",
  "by", "from", "as", "this", "that", "it", "its", "we", "us", "our",
  "fix", "add", "remove", "make", "do", "use", "set", "get", "when",
  "code",
  "where", "why", "how", "what", "which", "who", "i", "you", "they",
  "if", "then", "else", "so", "not", "no", "yes", "have", "has", "had",
]);

// Languages we can recognize in a free-text hint. Mapped to the canonical
// lowercase language tag used by SymbolRow.lang.
const LANGUAGE_HINTS = /** @type {Record<string, string>} */ ({
  "typescript": "ts",
  "ts": "ts",
  "javascript": "js",
  "js": "js",
  "node": "js",
  "python": "py",
  "py": "py",
  "rust": "rs",
  "rs": "rs",
  "go": "go",
  "golang": "go",
  "java": "java",
  "kotlin": "kt",
  "kt": "kt",
  "csharp": "cs",
  "c#": "cs",
  "cs": "cs",
  "c++": "cpp",
  "cpp": "cpp",
  "c": "c",
  "php": "php",
  "shell": "sh",
  "bash": "sh",
  "sh": "sh",
});

// Common symptom keywords. Coarse on purpose — this is a "what kind of
// bug am I looking at" hint for downstream rankers, not a taxonomy.
const SYMPTOM_KEYWORDS = /** @type {Array<[string, RegExp]>} */ ([
  ["null_pointer",  /\b(null|undefined|nil|none)\s+(pointer|deref|dereference|reference|access|exception|error)\b|\bnullpointerexception\b|\bnpe\b/i],
  ["type_error",    /\btype\s*(error|mismatch|coercion)\b/i],
  ["deadlock",      /\bdead\s*lock(ed|s)?\b/i],
  ["race",          /\brace\s+condition\b|\bdata\s+race\b/i],
  ["timeout",       /\b(time\s*out|timed\s*out|deadline\s+exceeded)\b/i],
  ["oom",           /\bout\s+of\s+memory\b|\boom\b|\bheap\s+exhaust(ed|ion)\b/i],
  ["stack_overflow", /\bstack\s+overflow\b/i],
  ["regression",    /\bregression\b|\bregressed\b/i],
  ["leak",          /\b(memory|fd|file\s+descriptor)\s+leak\b/i],
  ["auth",          /\b(auth|authn|authz|login|logout|session|token|jwt|oauth|sso)\b/i],
  ["concurrency",   /\b(concurrenc(y|ies)|parallel|thread\s*safety|mutex|semaphore|lock\s+contention)\b/i],
  ["perf",          /\b(slow|latency|performance|p9[59]|throughput|hot\s*path)\b/i],
  ["network",       /\b(network|http|dns|tls|ssl|tcp|udp|socket|connection\s+reset)\b/i],
  ["serialization", /\b(serializ|deserializ|json\s+parse|protobuf|encod(e|ing)|decod(e|ing))\b/i],
]);

const FILE_EXTENSIONS = new Set([
  "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java",
  "kt", "kts", "cs", "cpp", "cc", "cxx", "c", "h", "hpp", "php",
  "sh", "bash", "rb", "swift", "scala", "lua", "sql", "md", "json",
  "yml", "yaml", "toml", "ini", "xml", "html", "css", "vue", "svelte",
]);

const MAX_IDENTIFIERS = 12;
const MAX_KEYWORDS = 12;
const MAX_PATHS = 8;

/**
 * Produce a QueryPlan for a raw task/query string.
 *
 * Always returns a plan, even for empty/garbage input — callers can treat
 * `plan.raw === ""` as the "nothing to plan" signal without null checks.
 *
 * @param {string | undefined | null} input
 * @returns {QueryPlan}
 */
export function planQuery(input) {
  if (nativeBinaries.shouldUse("atlas")) {
    return /** @type {QueryPlan} */ (runAtlasNativeOperation({ op: "plan_query", input }));
  }
  return planQueryNode(input);
}

/** @param {string} input @returns {QueryPlan} */
function planQueryNode(input) {
  const raw = typeof input === "string" ? input.trim() : "";
  /** @type {QueryPlan} */
  const plan = {
    raw,
    identifiers: [],
    paths: [],
    fileNames: [],
    stackFrames: [],
    languageHints: [],
    symptom: null,
    keywords: [],
    identifierLike: false,
  };
  if (!raw) return plan;

  plan.identifierLike = looksLikeBareIdentifier(raw);
  plan.stackFrames = extractStackFrames(raw);
  // Pull paths out of the raw text first so we can strip them before the
  // identifier pass — paths and identifiers share token characters but
  // belong to different facets.
  plan.paths = extractPaths(raw).slice(0, MAX_PATHS);
  plan.fileNames = uniqueOrdered(plan.paths.map(fileNameOf).filter(Boolean));
  plan.languageHints = extractLanguageHints(raw, plan.paths);
  plan.symptom = classifySymptom(raw);
  plan.identifiers = extractIdentifiers(raw, plan.paths).slice(0, MAX_IDENTIFIERS);
  plan.keywords = extractKeywords(raw, plan.identifiers, plan.paths).slice(0, MAX_KEYWORDS);
  return plan;
}

/**
 * Decide whether `text` is a single bare identifier (e.g. "Greeter",
 * "getUserById", "Foo.bar") and not a sentence. When true, FTS exact-name
 * boosts dominate; otherwise we treat the input as natural language.
 *
 * @param {string} text
 * @returns {boolean}
 */
function looksLikeBareIdentifier(text) {
  if (!text) return false;
  if (/\s/.test(text)) return false;
  if (!/^[A-Za-z_$][A-Za-z0-9_$.:#/-]*$/.test(text)) return false;
  return looksLikeCodeIdentifier(text);
}

/**
 * Stack-frame extraction. Recognizes the most common JS / Python / Rust /
 * Go / Java stack-trace shapes. Falls back to nothing rather than guess.
 *
 * @param {string} text
 * @returns {StackFrame[]}
 */
function extractStackFrames(text) {
  /** @type {StackFrame[]} */
  const out = [];

  // JS / TS: `at fnName (path/to/file.ts:12:34)`
  const jsRe = /\bat\s+([A-Za-z_$][A-Za-z0-9_$.<>-]*)\s+\(([^):]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?\)/g;
  for (const m of text.matchAll(jsRe)) {
    out.push({ fn: m[1], file: m[2], line: Number(m[3]) || undefined });
  }
  // JS anonymous: `at path/to/file.ts:12:34`
  const jsAnonRe = /\bat\s+([^):\s]+\.[A-Za-z0-9]+):(\d+)(?::(\d+))?/g;
  for (const m of text.matchAll(jsAnonRe)) {
    if (out.some((f) => f.file === m[1] && f.line === Number(m[2]))) continue;
    out.push({ fn: "<anonymous>", file: m[1], line: Number(m[2]) || undefined });
  }

  // Python: `File "path/file.py", line 12, in fnName`
  const pyRe = /File\s+"([^"]+\.[A-Za-z0-9]+)"\s*,\s*line\s+(\d+)(?:,\s*in\s+([A-Za-z_][A-Za-z0-9_]*))?/g;
  for (const m of text.matchAll(pyRe)) {
    out.push({ fn: m[3] || "<module>", file: m[1], line: Number(m[2]) || undefined });
  }

  // Rust / panic: `at path/to/file.rs:12:34`
  // already handled by jsAnonRe

  // Go: `path/to/file.go:12 +0x...` and `pkg.fn(args)`
  const goRe = /([\w./-]+\.go):(\d+)/g;
  for (const m of text.matchAll(goRe)) {
    if (out.some((f) => f.file === m[1] && f.line === Number(m[2]))) continue;
    out.push({ fn: "<go-frame>", file: m[1], line: Number(m[2]) || undefined });
  }

  // Java: `at pkg.Class.method(File.java:12)`
  const javaRe = /at\s+([A-Za-z_$][\w$.]*)\.([A-Za-z_$][\w$]*)\(([^):]+):(\d+)\)/g;
  for (const m of text.matchAll(javaRe)) {
    out.push({ fn: `${m[1]}.${m[2]}`, file: m[3], line: Number(m[4]) || undefined });
  }

  return out.slice(0, 16);
}

/**
 * Extract repo-relative-looking paths and file references.
 *
 * @param {string} text
 * @returns {string[]}
 */
function extractPaths(text) {
  /** @type {string[]} */
  const out = [];
  // Anything with a `/` segment, ending in a known extension. Allows
  // dotted segments (./, ../) and Windows-y backslashes (rewritten).
  const re = /[A-Za-z0-9_.\\/-]+\.[A-Za-z0-9]+/g;
  for (const m of text.matchAll(re)) {
    const raw = m[0].replace(/\\/g, "/").replace(/^\.\//, "");
    const dot = raw.lastIndexOf(".");
    const ext = dot >= 0 ? raw.slice(dot + 1).toLowerCase() : "";
    if (!FILE_EXTENSIONS.has(ext)) continue;
    if (raw.length < 3) continue;
    if (!out.includes(raw)) out.push(raw);
  }
  return out;
}

/**
 * @param {string} pathLike
 * @returns {string}
 */
function fileNameOf(pathLike) {
  const slash = pathLike.lastIndexOf("/");
  return slash >= 0 ? pathLike.slice(slash + 1) : pathLike;
}

/**
 * @param {string} text
 * @param {string[]} paths
 * @returns {string[]}
 */
function extractLanguageHints(text, paths) {
  /** @type {Set<string>} */
  const tags = new Set();
  const lower = text.toLowerCase();
  for (const [token, tag] of Object.entries(LANGUAGE_HINTS)) {
    const re = languageHintRegex(token);
    if (re.test(lower)) tags.add(tag);
  }
  // Extension-derived hints: a `.rs` path implies "rs".
  for (const p of paths) {
    const dot = p.lastIndexOf(".");
    if (dot < 0) continue;
    const ext = p.slice(dot + 1).toLowerCase();
    const tag = LANGUAGE_HINTS[ext];
    if (tag) tags.add(tag);
    else if (FILE_EXTENSIONS.has(ext)) tags.add(ext);
  }
  return [...tags];
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function classifySymptom(text) {
  for (const [label, re] of SYMPTOM_KEYWORDS) {
    if (re.test(text)) return label;
  }
  return null;
}

/**
 * Pull out identifier-shaped tokens. A token qualifies as an identifier
 * when it contains a capital letter mid-word, an underscore, a dot, or a
 * colon — anything that suggests "this is code, not English".
 *
 * @param {string} text
 * @param {string[]} paths
 * @returns {string[]}
 */
function extractIdentifiers(text, paths) {
  // Strip paths so their internal slashes don't confuse the identifier
  // scanner.
  let scrubbed = text;
  for (const p of paths) {
    scrubbed = scrubbed.split(p).join(" ");
  }
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  const re = /[A-Za-z_$][A-Za-z0-9_$.:]*/g;
  for (const m of scrubbed.matchAll(re)) {
    const tok = m[0];
    if (tok.length < 2) continue;
    if (!looksLikeCodeIdentifier(tok)) continue;
    const key = tok;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(tok);
  }
  return out;
}

/**
 * @param {string} tok
 * @returns {boolean}
 */
function looksLikeCodeIdentifier(tok) {
  if (STOPWORDS.has(tok.toLowerCase())) return false;
  // Has a structural marker that hints "code symbol":
  //   - uppercase letter mid-word (camelCase / PascalCase)
  //   - underscore (snake_case)
  //   - dot or colon (qualified name)
  if (/[A-Z][a-z]/.test(tok) && /[A-Z]/.test(tok.slice(1))) return true;
  if (/[a-z][A-Z]/.test(tok)) return true;          // camelCase
  if (/^[A-Z][a-z]/.test(tok)) return true;          // PascalCase
  if (/_/.test(tok) && /[A-Za-z]/.test(tok)) return true;
  if (/[.:]/.test(tok) && /[A-Za-z]{2,}/.test(tok)) return true;
  if (/^[A-Z]{2,}/.test(tok)) return true;           // SCREAMING_SNAKE / CONSTANTS
  return false;
}

/**
 * Tokenize for keyword search. Strips identifiers (those have their own
 * facet) and paths, then lowercases what's left, splits camelCase, drops
 * stopwords and short tokens.
 *
 * @param {string} text
 * @param {string[]} identifiers
 * @param {string[]} paths
 * @returns {string[]}
 */
function extractKeywords(text, identifiers, paths) {
  let scrubbed = text;
  for (const p of paths) scrubbed = scrubbed.split(p).join(" ");
  for (const id of identifiers) scrubbed = scrubbed.split(id).join(" ");
  const broken = scrubbed
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/([A-Z]+)([A-Z][a-z])/g, "$1 $2");
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const piece of broken.split(/[^A-Za-z0-9]+/)) {
    if (!piece) continue;
    const lower = piece.toLowerCase();
    if (lower.length < 3) continue;
    if (STOPWORDS.has(lower)) continue;
    if (seen.has(lower)) continue;
    seen.add(lower);
    out.push(lower);
  }
  return out;
}

/**
 * @template T
 * @param {T[]} arr
 * @returns {T[]}
 */
function uniqueOrdered(arr) {
  /** @type {T[]} */
  const out = [];
  const seen = new Set();
  for (const item of arr) {
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

/**
 * @param {string} s
 * @returns {string}
 */
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * @param {string} token
 * @returns {RegExp}
 */
function languageHintRegex(token) {
  const escaped = escapeRegExp(token);
  if (token === "c") {
    // Bare C is a real language hint only as a standalone token. Avoid
    // matching the letter inside prose like "account cache".
    return /(?:^|[^a-z0-9_+#])c(?:$|[^a-z0-9_+#])/;
  }
  if (/^[a-z]+$/.test(token)) {
    return new RegExp(`\\b${escaped}\\b`);
  }
  // Tokens like c# / c++ contain non-word characters, so `\b` does not
  // describe the right boundary. Use explicit non-identifier neighbors.
  return new RegExp(`(?:^|[^a-z0-9_])${escaped}(?=$|[^a-z0-9_])`);
}
