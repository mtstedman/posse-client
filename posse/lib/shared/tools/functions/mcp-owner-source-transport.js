import { capString } from "./mcp-owner-session-support.js";
import path from "node:path";
import { refreshSourceDecisionNavigation } from "./source-decision-points.js";
import { materializeHashRefEvidenceForContext } from "../../../domains/queue/functions/hash-refs.js";
import { sourceLineDisplay, compactSourceEvidenceSuffix } from "./source-line-display.js";
import { ownerControlNoticePublicMetadata, OWNER_MODEL_CONTROL_NOTICES } from "./planner-triage.js";
import { ATLAS_CANONICAL_SYMBOL_ID_PATTERN } from "./mcp-owner-symbol-handles.js";

export function firstStructuredJsonValue(text = "") {
  const source = String(text || "");
  const start = source.search(/[\[{]/u);
  if (start < 0) return { value: null, remainder: source.trim() };
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (quoted) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === "\"") quoted = false;
      continue;
    }
    if (char === "\"") {
      quoted = true;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") {
      depth -= 1;
      if (depth !== 0) continue;
      try {
        return {
          value: JSON.parse(source.slice(start, index + 1)),
          remainder: `${source.slice(0, start)}${source.slice(index + 1)}`.trim(),
        };
      } catch {
        return { value: null, remainder: source.trim() };
      }
    }
  }
  return { value: null, remainder: source.trim() };
}

// Final pre-transport model-visible size. The downstream Codex client clips
// oversized tool results to roughly this many characters (head/tail with the
// middle discarded) without telling Posse, so anything above the clip is
// recorded here as the closest observable proxy for what the model saw.
export const CLIENT_RESULT_CLIP_CHARS = 48000;

export function mcpResultTextChars(result) {
  const content = result?.content;
  if (!Array.isArray(content)) return 0;
  let total = 0;
  for (const part of content) {
    if (part?.type === "text" && typeof part.text === "string") total += part.text.length;
  }
  return total;
}

const OWNER_PARTIAL_IDENTIFIER_LIMIT = 20;

function ownerPartialIdentifierList(value) {
  if (!Array.isArray(value)) return [];
  const identifiers = [];
  const seen = new Set();
  for (const item of value) {
    const identifier = capString(item, 180).trim();
    if (!identifier || seen.has(identifier)) continue;
    seen.add(identifier);
    identifiers.push(identifier);
    if (identifiers.length >= OWNER_PARTIAL_IDENTIFIER_LIMIT) break;
  }
  return identifiers;
}

// A successful source call can still leave requested selectors unresolved.
// Preserve that distinction in the authoritative owner row so collectors do
// not flatten a partial result into a clean success merely because useful
// source was also returned.
function conventionalEntryFilenameAnchors(toolArgs = {}) {
  const file = String(toolArgs?.file || "").trim().replace(/\\/g, "/");
  const basename = path.posix.basename(file);
  const match = /^(?<stem>index|main|__init__|__main__)(?:\.[a-z0-9]+)+$/iu.exec(basename);
  return match?.groups?.stem
    ? new Set([match.groups.stem.toLowerCase(), basename.toLowerCase()])
    : new Set();
}

export function ownerAtlasPartialResultDiagnostic(result, toolArgs = {}) {
  const filenameAnchors = conventionalEntryFilenameAnchors(toolArgs);
  for (const part of result?.content || []) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    const payload = firstStructuredJsonValue(part.text).value;
    if (!payload || Array.isArray(payload) || typeof payload !== "object") continue;
    // A request such as file=index.ts + identifiersToFind=["index"] is file
    // orientation, not a claim that the module declares a symbol named index.
    // The source was delivered successfully, so do not record a bogus symbol
    // miss in the diagnostic. Limit this normalization to conventional
    // entry filenames; arbitrary stems can still be real declared symbols.
    const identifiersMissing = ownerPartialIdentifierList(payload.identifiersMissing)
      .filter((identifier) => !filenameAnchors.has(identifier.toLowerCase()));
    const identifiersOmitted = ownerPartialIdentifierList(payload.identifiersOmitted);
    if (identifiersMissing.length === 0 && identifiersOmitted.length === 0) continue;
    return {
      version: 1,
      status: "partial",
      identifier_miss_count: identifiersMissing.length,
      identifiers_missing: identifiersMissing,
      identifier_omission_count: identifiersOmitted.length,
      identifiers_omitted: identifiersOmitted,
    };
  }
  return null;
}

export const __testOwnerAtlasPartialResultDiagnostic = ownerAtlasPartialResultDiagnostic;

export function ownerExactSourceEvidence(result) {
  for (const part of result?.content || []) {
    if (part?.type !== "text" || typeof part.text !== "string") continue;
    const payload = firstStructuredJsonValue(part.text).value;
    if (!payload || typeof payload !== "object") continue;
    const primary = payload?.data && typeof payload.data === "object" ? payload.data : payload;
    const pending = [primary];
    while (pending.length > 0) {
      const value = pending.shift();
      if (!value || typeof value !== "object") continue;
      for (const [key, child] of Object.entries(value)) {
        if (["content", "sourceText", "source_text"].includes(key) && typeof child === "string") {
          const symbolId = String(value.symbolId || primary.symbolId || payload.symbolId || "").trim();
          return {
            source: child,
            symbolId: ATLAS_CANONICAL_SYMBOL_ID_PATTERN.test(symbolId) ? symbolId : null,
          };
        }
        if (child && typeof child === "object") pending.push(child);
      }
    }
  }
  return { source: "", symbolId: null };
}

const OWNER_THIN_DECLARATION_RE = /(?:\b(?:declare|abstract)\b[^{}]*;\s*$)|(?:\b(?:function|method)\b[^{}]*;\s*$)/isu;

const OWNER_THIN_TYPESCRIPT_OVERLOAD_RE = /^\s*(?:export\s+)?(?:declare\s+)?(?:async\s+)?function\b[^{}]*\)\s*(?::\s*[^{};]+)?;?\s*$/isu;

const OWNER_THIN_FORWARDING_BINDING_RE = /\b(?:const|let|var)\s+[A-Za-z_$][\w$]*(?:\s*:[^=;]+)?\s*=\s*(?:\/\*[\s\S]*?\*\/\s*)*[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)?\s*(?:\([^;{}]*\))?\s*;\s*$/isu;

const OWNER_THIN_REEXPORT_RE = /^\s*(?:export\s+(?:\*|\{[\s\S]*?\})\s+from|import\s+[\s\S]*?\s+from)\s+["'][^"']+["'];?\s*$/isu;

export function ownerThinImplementationGap(source = "") {
  const text = String(source || "").trim();
  if (!text) return false;
  const substantiveLines = text
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("//") && !line.startsWith("*") && !line.startsWith("/*"));
  if (substantiveLines.length === 0 || substantiveLines.length > 12) return false;
  const substantive = substantiveLines.join("\n");
  if (OWNER_THIN_REEXPORT_RE.test(substantive)) return true;
  if (/[{]/u.test(substantive) || /=>\s*[{]/u.test(substantive)) return false;
  return OWNER_THIN_DECLARATION_RE.test(substantive)
    || OWNER_THIN_TYPESCRIPT_OVERLOAD_RE.test(substantive)
    || OWNER_THIN_FORWARDING_BINDING_RE.test(substantive);
}

// Final source transport hygiene. Source coverage temporarily injects
// `sourceVersion` and `repositoryIdentity` into result data for owner-side
// custody. Hash-ref compaction can remove the content before the later
// materialization pass gets a chance to delete those internal fields, leaving
// them in the model-visible envelope. Strip them only after every custody and
// citation stage has completed.
//
// A source window also carries file text as a JSON string, so every newline,
// quote, and backslash is escaped and re-fed on every model turn. Lift the
// verbatim source into a second raw text block while retaining the compact
// header and any evidence-ref/control suffix. Hash-ref surfacing adds that
// suffix before this stage, so parse the first structured value rather than
// requiring the entire text block to be JSON.
const DEESCAPE_MIN_CONTENT_CHARS = 200;

function stripInternalSourceCoverageFields(value) {
  if (!value || typeof value !== "object") return 0;
  let removed = 0;
  if (!Array.isArray(value)) {
    for (const key of ["sourceVersion", "repositoryIdentity"]) {
      if (!Object.hasOwn(value, key)) continue;
      delete value[key];
      removed += 1;
    }
  }
  for (const child of Array.isArray(value) ? value : Object.values(value)) {
    removed += stripInternalSourceCoverageFields(child);
  }
  return removed;
}

export function finalizeSourceTransport(result, context = null) {
  const content = result?.content;
  if (!Array.isArray(content) || content.length === 0) return result;
  let mutated = false;
  const nextContent = [];
  for (const part of content) {
    if (part?.type !== "text" || typeof part.text !== "string") {
      nextContent.push(part);
      continue;
    }
    const structured = firstStructuredJsonValue(part.text);
    const parsed = structured.value;
    if (!parsed || typeof parsed !== "object") {
      nextContent.push(part);
      continue;
    }
    const removedFields = stripInternalSourceCoverageFields(parsed) + refreshSourceDecisionNavigation(parsed);
    const resolveEvidence = context ? (ref) => {
      const visible = materializeHashRefEvidenceForContext(context, ref);
      return visible?.ok ? visible.entry : null;
    } : null;
    const suffix = compactSourceEvidenceSuffix(parsed, structured.remainder, resolveEvidence);
    const numbered = sourceLineDisplay(parsed, 0, resolveEvidence);
    if (numbered) {
      nextContent.push({
        ...part,
        text: [JSON.stringify(numbered.header), suffix].filter(Boolean).join("\n\n"),
      }, ...numbered.blocks);
      mutated = true;
      continue;
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)
      || typeof parsed.content !== "string" || parsed.content.length < DEESCAPE_MIN_CONTENT_CHARS
      || typeof parsed.repo_rel_path !== "string") {
      nextContent.push(removedFields > 0
        ? { ...part, text: [JSON.stringify(parsed), suffix].filter(Boolean).join("\n\n") }
        : part);
      mutated ||= removedFields > 0;
      continue;
    }
    const source = parsed.content;
    const header = { ...parsed };
    delete header.content;
    // Minimal marker: the verbatim source is the next text block. Kept short so
    // the escaping saved on the source dominates the header cost even on small
    // windows.
    header.content_next_block = true;
    nextContent.push({
      ...part,
      text: [JSON.stringify(header), suffix].filter(Boolean).join("\n\n"),
    });
    nextContent.push({ type: "text", text: source });
    mutated = true;
  }
  if (!mutated) return result;
  const next = { ...result, content: nextContent };
  // Model-control details are intentionally non-enumerable so they never leak
  // into the MCP payload. Object spread therefore drops them unless this final
  // source transport stage explicitly carries them forward. Losing the symbol
  // here preserved the visible instruction but erased its response-control
  // observation, making real adoption unauditable.
  return preserveOwnerModelControlNotices(result, next);
}

export const __testFinalizeSourceTransport = finalizeSourceTransport;

export function isMemoryToolAction(action) {
  return String(action || "").startsWith("memory.");
}

export function preserveOwnerModelControlNotices(source, target) {
  if (source === target) return target;
  const controlNotices = source?.[OWNER_MODEL_CONTROL_NOTICES];
  if (Array.isArray(controlNotices) && controlNotices.length > 0) {
    Object.defineProperty(target, OWNER_MODEL_CONTROL_NOTICES, {
      value: [...controlNotices],
      enumerable: false,
    });
  }
  return target;
}

export const __testPreserveOwnerModelControlNotices = preserveOwnerModelControlNotices;

export function tagOwnerModelControlNotice(result, text, detail = {}) {
  if (!result || !text) return result;
  const notice = {
    kind: detail.kind || "runtime_control",
    text: String(text),
    trigger: detail.trigger || null,
    explorationStep: detail.explorationStep ?? null,
  };
  const priorPublic = Array.isArray(result?._meta?.posseControlNotices)
    ? result._meta.posseControlNotices
    : [];
  const next = {
    ...result,
    _meta: {
      ...(result?._meta && typeof result._meta === "object" ? result._meta : {}),
      posseControlNotices: [...priorPublic, ownerControlNoticePublicMetadata(notice)],
    },
  };
  Object.defineProperty(next, OWNER_MODEL_CONTROL_NOTICES, {
    value: [...(result?.[OWNER_MODEL_CONTROL_NOTICES] || []), notice],
    enumerable: false,
  });
  return next;
}

// The presentation projection applied to a result, if any (P0.1 item 4):
// read back from the owner transform log so telemetry reconciles to the same
// stage that produced the model-visible payload.
export function ownerResultProjection(result) {
  const transforms = Array.isArray(result?._meta?.posseResultTransforms)
    ? result._meta.posseResultTransforms
    : [];
  for (let index = transforms.length - 1; index >= 0; index -= 1) {
    const projection = transforms[index]?.projection;
    if (typeof projection === "string" && projection) return projection;
  }
  return null;
}

export function annotateOwnerResultTransform(result, detail = {}) {
  const prior = Array.isArray(result?._meta?.posseResultTransforms)
    ? result._meta.posseResultTransforms
    : [];
  const next = {
    ...result,
    _meta: {
      ...(result?._meta && typeof result._meta === "object" ? result._meta : {}),
      posseResultTransforms: [...prior, detail],
    },
  };
  return preserveOwnerModelControlNotices(result, next);
}
