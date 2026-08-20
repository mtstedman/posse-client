import { SourceCoverageOwner } from "../classes/SourceCoverageOwner.js";

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

export function materializeSourceCoverage(result, coverageOwner, toolArgs = {}) {
  return visitSourceData(result, toolArgs, (data, args, origin) => (
    coverageOwner.materializeData(data, args, { origin })
  ));
}
