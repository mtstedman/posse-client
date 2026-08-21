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

function visitSourceData(result, toolArgs, visit) {
  const parsed = parsedMcpTextResult(result);
  if (!parsed) return result;
  const envelope = parsed.value;
  const data = envelope?.data && typeof envelope.data === "object" ? envelope.data : envelope;
  if (data && typeof data === "object" && data.status !== "covered") {
    visit(data, toolArgs, "primary");
    for (const additional of Array.isArray(data.additionalWindows) ? data.additionalWindows : []) {
      visit({ ...additional, repo_rel_path: data.repo_rel_path }, toolArgs, "additional");
    }
  }
  return replaceMcpTextResult(result, parsed, envelope);
}

export function prepareSourceCoverage(result, coverageOwner, toolArgs = {}) {
  return visitSourceData(result, toolArgs, (data, args) => coverageOwner.prepareData(data, args));
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
// is the native transport and `continuationRef` is what survives after the
// hash-ref surfacing that normally consumes it.
export function liveCompleteSymbolSelector(data = {}, args = {}, origin = "primary") {
  if (origin !== "primary") return null;
  if (data.truncated === true || data.selectionBounded === true || data.outputTruncated === true) return null;
  if (Array.isArray(data.additionalWindows) && data.additionalWindows.length > 0) return null;
  if (Number(data.returnedFunctionAnchorsOmitted) > 0) return null;
  if (String(data.continuationRef || "").trim()) return null;
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

export function materializeSourceCoverage(result, coverageOwner, toolArgs = {}) {
  return visitSourceData(result, toolArgs, (data, args, origin) => (
    coverageOwner.materializeData(data, args, {
      origin,
      completeSymbolSelector: liveCompleteSymbolSelector(data, args, origin),
    })
  ));
}
