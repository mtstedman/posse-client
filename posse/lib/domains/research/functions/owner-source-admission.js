import { SourceCoverageOwner, completeSymbolSelectorFingerprint } from "../classes/SourceCoverageOwner.js";
import { CODE_CONTENT_KINDS } from "../../../catalog/source-display.js";
import { splitEditableLines } from "../../../shared/tools/functions/toolkit/structured-read.js";

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
  if (Number(data.returnedFunctionAnchorsOmitted) > 0) return true;
  if (String(data.traversal_ref?.ref || data.traversal_ref || data.continuationRef || "").trim()) return true;
  if (Number(data.continuationWindows) > 0) return true;
  if (Array.isArray(data._continuationWindows) && data._continuationWindows.length > 0) return true;
  if (Array.isArray(data.continuationRanges) && data.continuationRanges.length > 0) return true;
  return false;
}

function exactSourceWindow(fresh, { startLine, endLine }) {
  const sourceLines = splitEditableLines(fresh.source).lines;
  let content = sourceLines.slice(startLine - 1, endLine).join("\n");
  if (endLine === sourceLines.length && fresh.source.endsWith("\n")) content += "\n";
  return { startLine, endLine, content };
}

async function suppressCoveredInlineWindows({
  result,
  parsed,
  envelope,
  data,
  coverageOwner,
  toolArgs,
}) {
  const windows = [
    data,
    ...data.additionalWindows.map((window) => ({ ...window, repo_rel_path: data.repo_rel_path })),
  ];
  const preparedWindows = windows.map((window) => {
    const candidate = { ...window };
    const prepared = coverageOwner.prepareData(candidate, toolArgs);
    return prepared ? { ...prepared, candidate } : null;
  });
  // Suppression is only safe when every inline body is an exact slice of the
  // same live file. A malformed or synthesized spill window keeps the native
  // response intact.
  if (preparedWindows.some((prepared) => !prepared)) {
    return { result, admission: null, resolvedChars: 0 };
  }

  let reservation = null;
  const locallyVisibleRanges = [];
  const retainedWindows = [];
  const reusedRanges = [];
  let suppressedLineCount = 0;
  let suppressedChars = 0;
  let resolvedChars = 0;

  for (const prepared of preparedWindows) {
    resolvedChars += prepared.content.length;
    if (!reservation) {
      const gate = await coverageOwner.admitResolvedIntervalOrReserve({
        repoRelativePath: prepared.fresh.relative,
        startLine: prepared.startLine,
        endLine: prepared.endLine,
      });
      if (String(gate?.reason || "").endsWith("_fail_open")) {
        return { result, admission: null, resolvedChars: 0, reservation: gate?.reservation || null };
      }
      reservation = gate?.reservation || null;
    }

    const plan = coverageOwner.resolvedIntervalPlan({
      repoRelativePath: prepared.fresh.relative,
      startLine: prepared.startLine,
      endLine: prepared.endLine,
      additionalCoveredRanges: locallyVisibleRanges,
    });
    // A partially new requested window stays coherent. Only suppress complete
    // windows; subtracting arbitrary visible lines splits guards from bodies.
    if (!plan?.covered) {
      retainedWindows.push(exactSourceWindow(prepared.fresh, prepared));
    } else {
      const uncovered = plan.uncoveredRanges || [];
      const retained = uncovered.map((range) => exactSourceWindow(prepared.fresh, range));
      retainedWindows.push(...retained);
      const retainedChars = retained.reduce((total, window) => total + window.content.length, 0);
      suppressedChars += Math.max(0, prepared.content.length - retainedChars);
      suppressedLineCount += Math.max(0, Number(plan.coveredLines) || 0);
      reusedRanges.push(...(plan.coveredRanges || []));
    }
    // A later inline window shares this same response boundary. Everything in
    // the resolved interval is now either retained here or backed by durable
    // current-attempt evidence, so it can participate in the local range union.
    locallyVisibleRanges.push({ startLine: prepared.startLine, endLine: prepared.endLine });
  }

  if (suppressedLineCount === 0) {
    return { result, admission: null, resolvedChars: 0, reservation };
  }

  const firstPrepared = preparedWindows[0];
  const admission = {
    covered: retainedWindows.length === 0,
    partial: retainedWindows.length > 0,
    reason: retainedWindows.length === 0 ? "covered_interval_union" : "overlapping_interval",
    repoRelativePath: firstPrepared.fresh.relative,
    requestedStartLine: Math.min(...preparedWindows.map((prepared) => prepared.startLine)),
    requestedEndLine: Math.max(...preparedWindows.map((prepared) => prepared.endLine)),
    coveredLines: suppressedLineCount,
    coveredRanges: reusedRanges,
    fresh: firstPrepared.fresh,
    reservation,
  };
  const requestedRanges = preparedWindows.map(({ startLine, endLine }) => ({ startLine, endLine }));
  const reuseNotice = `SOURCE_RANGE_REUSE: Omitted ${suppressedLineCount} already-visible lines from inline source windows in ${firstPrepared.fresh.relative}; this response contains only the uncovered ranges. Reuse cited evidence refs for omitted ranges and do not reread them.`;

  if (retainedWindows.length > 0) {
    const [primary, ...additionalWindows] = retainedWindows;
    const compactData = {
      ...data,
      ...primary,
      additionalWindows,
      source_deduplicated: true,
      requestedRanges,
      reusedLineCount: suppressedLineCount,
      reusedRanges,
    };
    delete compactData.contentSha256;
    delete compactData.sourceVersion;
    delete compactData.repositoryIdentity;
    const compactEnvelope = envelope?.data && typeof envelope.data === "object"
      ? { ...envelope, data: compactData }
      : compactData;
    return {
      result: replaceMcpTextResult(result, parsed, compactEnvelope),
      admission,
      payload: compactEnvelope,
      resolvedChars,
      suppressedChars,
      selectorAliased: false,
      reservation,
      reuseNotice,
    };
  }

  admission.result = {
    status: "covered",
    executed: false,
    coverage_scope: "current_attempt",
    repo_rel_path: firstPrepared.fresh.relative,
    startLine: admission.requestedStartLine,
    endLine: admission.requestedEndLine,
    requested_ranges: requestedRanges,
    coverage_ranges: reusedRanges,
  };
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
    resolvedChars,
    suppressedChars,
    selectorAliased: false,
    reservation,
    reuseNotice,
  };
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
// and suppresses covered lines only from a byte-verified, continuation-free
// source slice. Any uncovered subranges remain exact on-disk source windows.
export async function suppressCoveredSourceInterval(result, coverageOwner, toolArgs = {}, {
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

  if (Array.isArray(data.additionalWindows) && data.additionalWindows.length > 0) {
    return suppressCoveredInlineWindows({
      result,
      parsed,
      envelope,
      data,
      coverageOwner,
      toolArgs,
    });
  }

  // Besides resolving line bounds, prepareData proves that the returned body
  // is one byte-exact on-disk slice. Stitched and clipped/malformed payloads
  // therefore fail open and retain the native response.
  const prepared = coverageOwner.prepareData(data, toolArgs);
  if (!prepared) return { result, admission: null, resolvedChars: 0 };
  const admission = await coverageOwner.admitResolvedIntervalOrReserve({
    repoRelativePath: prepared.fresh.relative,
    startLine: prepared.startLine,
    endLine: prepared.endLine,
  });
  if (!admission?.covered) {
    return { result, admission: null, resolvedChars: 0, reservation: admission?.reservation || null };
  }
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
    suppressedChars: prepared.content.length,
    selectorAliased,
    reservation: admission.reservation || null,
    reuseNotice: admission.reason === "covered_interval_union"
      ? `EVIDENCE_REUSE: All lines in ${prepared.fresh.relative}:${prepared.startLine}-${prepared.endLine} were already visible across the cited source ranges. Use those refs directly and request only a different uncovered symbol, branch, or range.`
      : null,
  };
}

function visitSourceData(result, toolArgs, visit, { toolName = "code.window" } = {}) {
  const parsed = parsedMcpTextResult(result);
  if (!parsed) return result;
  const envelope = parsed.value;
  const data = envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope;
  if (data && typeof data === "object" && data.status !== "covered") {
    if (toolName === "code.skeleton") {
      // A skeleton can contain summaries or exact source. Only its explicitly
      // source-kind primary window is eligible; prepareData still verifies
      // the bytes against current source before custody is granted.
      if (result.isError !== true && envelope?.ok !== false
        && data.contentKind === CODE_CONTENT_KINDS.SOURCE) {
        visit(data, toolArgs, "primary", toolName);
      }
    } else if (toolName === "symbol.card") {
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
  return visitSourceData(result, toolArgs, (data, args, _origin, tool) => coverageOwner.prepareData(data, args, { tool }), options);
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
      completeSymbolSelector: tool === "code.skeleton" ? null : liveCompleteSymbolSelector(data, args, origin),
      tool,
    })
  ), options);
}
