import { SourceCoverageOwner, completeSymbolSelectorFingerprint } from "../classes/SourceCoverageOwner.js";

export function sourceCoverageOwnerForSession(session, bootConfig = session?.bootConfig || {}) {
  return new SourceCoverageOwner({
    cwd: bootConfig.cwd,
    workItemId: bootConfig.workItemId,
    jobId: bootConfig.jobId,
    attemptId: bootConfig.attemptId,
    agentCallId: bootConfig.agentCallId,
    repositoryIdentity: bootConfig?.atlas?.repoId || bootConfig?.atlas?.repoPath || bootConfig.cwd,
  });
}

function parsedMcpTextResult(result) {
  const first = result?.content?.[0];
  if (!first || first.type !== "text" || typeof first.text !== "string") return null;
  const suffixAt = first.text.indexOf("\n\n[");
  const jsonText = suffixAt >= 0 ? first.text.slice(0, suffixAt) : first.text;
  try {
    return {
      first,
      value: JSON.parse(jsonText),
      suffix: suffixAt >= 0 ? first.text.slice(suffixAt) : "",
    };
  } catch { return null; }
}

function replaceMcpTextResult(result, parsed, value) {
  return {
    ...result,
    content: [{ ...parsed.first, text: `${JSON.stringify(value)}${parsed.suffix || ""}` }, ...result.content.slice(1)],
  };
}

function hasUnseenSourceContinuation(data = {}) {
  if (Array.isArray(data.additionalWindows) && data.additionalWindows.length > 0) return true;
  if (Number(data.returnedFunctionAnchorsOmitted) > 0) return true;
  if (String(data.traversal_ref?.ref || data.traversal_ref || data.continuationRef || "").trim()) return true;
  if (Number(data.continuationWindows) > 0) return true;
  if (Array.isArray(data._continuationWindows) && data._continuationWindows.length > 0) return true;
  if (Array.isArray(data.continuationRanges) && data.continuationRanges.length > 0) return true;
  return false;
}

function resolvedSelectionMetadata(data = {}) {
  const metadata = {};
  for (const key of [
    "identifiersFound",
    "identifiersReturned",
    "identifiersMissing",
    "identifiersOmitted",
    "truncated",
    "selectionBounded",
    "outputTruncated",
  ]) {
    if (Object.hasOwn(data, key)) metadata[key] = data[key];
  }
  return metadata;
}

// A selector fingerprint can miss reuse when two different selectors resolve
// to the same already-delivered source interval. Native execution is still
// required to resolve that interval; this admission runs before model ingress
// and replaces only a single, exact, continuation-free source slice.
export function suppressCoveredSourceInterval(result, coverageOwner, toolArgs = {}, {
  toolName = "code.window",
} = {}) {
  if (toolName !== "code.window" || !coverageOwner) {
    return { result, admission: null, resolvedChars: 0 };
  }
  const parsed = parsedMcpTextResult(result);
  if (!parsed) return { result, admission: null, resolvedChars: 0 };
  const envelope = parsed.value;
  const data = envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope;
  if (
    !data
    || typeof data !== "object"
    || data.status === "covered"
    || typeof data.content !== "string"
    || !data.content
    || hasUnseenSourceContinuation(data)
  ) {
    return { result, admission: null, resolvedChars: 0 };
  }

  // Besides resolving line bounds, prepareData proves that the returned body
  // is one byte-exact on-disk slice. Stitched and clipped/malformed payloads
  // therefore fail open and retain the native response.
  const prepared = coverageOwner.prepareData(data, toolArgs);
  if (!prepared) return { result, admission: null, resolvedChars: 0 };
  const admission = coverageOwner.admitResolvedInterval({
    repoRelativePath: prepared.fresh.relative,
    startLine: prepared.startLine,
    endLine: prepared.endLine,
  });
  if (!admission?.covered) return { result, admission: null, resolvedChars: 0 };
  const selectorAliased = coverageOwner.recordResolvedIntervalReuse(toolArgs, admission);

  const compact = {
    ...admission.result,
    executed: true,
    source_suppressed: true,
    ...resolvedSelectionMetadata(data),
  };
  return {
    result: replaceMcpTextResult(result, parsed, compact),
    admission,
    payload: compact,
    resolvedChars: prepared.content.length,
    selectorAliased,
  };
}

function visitSourceData(result, toolArgs, visit, { toolName = "code.window" } = {}) {
  const parsed = parsedMcpTextResult(result);
  if (!parsed) return result;
  const envelope = parsed.value;
  const data = envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope;
  if (data && typeof data === "object" && data.status !== "covered") {
    if (toolName === "symbol.card") {
      const cards = Array.isArray(data.cards) ? data.cards : [data];
      for (const card of cards) {
        const source = card?.sourceExcerpt || (typeof card?.source === "object" ? card.source : null);
        if (!source) continue;
        visit(source, { ...toolArgs, symbolId: card.symbolId || toolArgs.symbolId }, "primary", toolName);
      }
    } else {
      visit(data, toolArgs, "primary", toolName);
      for (const additional of Array.isArray(data.additionalWindows) ? data.additionalWindows : []) {
        visit({ ...additional, repo_rel_path: data.repo_rel_path }, toolArgs, "additional", toolName);
      }
    }
  }
  return replaceMcpTextResult(result, parsed, envelope);
}

export function prepareSourceCoverage(result, coverageOwner, toolArgs = {}, options = {}) {
  return visitSourceData(result, toolArgs, (data, args) => coverageOwner.prepareData(data, args), options);
}

function lowered(value) {
  return Array.isArray(value) ? value.map((entry) => String(entry || "").toLowerCase()) : [];
}

// D-8: live-delivered windows must be able to earn the verified complete-symbol
// fingerprint, or SC-1's `maxTokens` change would remove cross-window reuse
// from every live source read, including complete untruncated ones.
//
// A live result qualifies only when the request itself is complete-symbol
// eligible (single identifier, file mode, symbol granularity — enforced by
// completeSymbolSelectorFingerprint) AND the delivered payload proves the whole
// symbol arrived: not `truncated`, not `selectionBounded`, not `outputTruncated`,
// carrying no spilled-over regions, no unseen continuation, and actually
// returning the identifier that was asked for. Anything short of that stays
// partial-selector-only.
//
// F5: a continuation is a lossless partition of the selected result — the ref
// exists precisely because some selected lines were NOT delivered inline. A
// payload carrying one is therefore incomplete no matter what the truncation
// flags say, and promoting it would answer a wider retry `covered` from a
// fraction of the symbol. Both spellings are checked: `_continuationWindows`
// is the native transport and `traversal_ref` is what survives after the
// hash-ref surfacing that normally consumes it.
export function liveCompleteSymbolSelector(data = {}, args = {}, origin = "primary") {
  if (origin !== "primary") return null;
  if (data.truncated === true || data.selectionBounded === true || data.outputTruncated === true) return null;
  if (Array.isArray(data.additionalWindows) && data.additionalWindows.length > 0) return null;
  if (Number(data.returnedFunctionAnchorsOmitted) > 0) return null;
  if (String(data.traversal_ref?.ref || data.continuationRef || "").trim()) return null;
  if (Number(data.continuationWindows) > 0) return null;
  if (Array.isArray(data._continuationWindows) && data._continuationWindows.length > 0) return null;
  if (!completeSymbolSelectorFingerprint(args)) return null;
  const requested = String(args.identifiersToFind?.[0] || "").toLowerCase();
  if (!requested) return null;
  if (!lowered(data.identifiersReturned).includes(requested)) return null;
  if ([...lowered(data.identifiersMissing), ...lowered(data.identifiersOmitted)].includes(requested)) return null;
  return {
    file: args.file,
    identifiersToFind: [args.identifiersToFind[0]],
    granularity: "symbol",
  };
}

export function materializeSourceCoverage(result, coverageOwner, toolArgs = {}, options = {}) {
  return visitSourceData(result, toolArgs, (data, args, origin, tool) => (
    coverageOwner.materializeData(data, args, {
      origin,
      completeSymbolSelector: liveCompleteSymbolSelector(data, args, origin),
      tool,
    })
  ), options);
}
