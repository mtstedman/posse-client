import {
  getArtifacts,
  getAttempts,
} from "../../../queue/functions/index.js";
import { parseAgentCompletionLog } from "../helpers/mutation-guards.js";

function artifactText(artifact) {
  return String(artifact?.content_long || "").trim();
}

function matchingResponse(attempt, responseArtifacts, legacyResponse = null) {
  return [...responseArtifacts].reverse().find((artifact) => (
    Number(artifact?.attempt_id) === Number(attempt?.id) && artifactText(artifact)
  )) || legacyResponse;
}

export function resolveAssessmentSource({
  attempts = [],
  responseArtifacts = [],
} = {}) {
  const implementationAttempts = attempts.filter((attempt) => attempt?.attempt_kind !== "assessment");
  const unscopedResponses = responseArtifacts.filter((artifact) => artifact?.attempt_id == null && artifactText(artifact));
  const legacyResponse = implementationAttempts.length === 1 && responseArtifacts.length === 1 && unscopedResponses.length === 1
    ? unscopedResponses[0]
    : null;

  for (const attempt of [...implementationAttempts].reverse()) {
    const response = matchingResponse(attempt, responseArtifacts, legacyResponse);
    const output = artifactText(response);
    if (!output) continue;

    const commitHash = String(attempt?.commit_hash || "").trim() || null;
    if (commitHash) {
      return {
        ok: true,
        kind: "commit",
        attempt,
        response,
        output,
        commitHash,
        commitBaseHash: String(attempt?.commit_base_hash || "").trim() || null,
      };
    }

    const completion = parseAgentCompletionLog(output);
    if (completion.found && completion.status === "VERIFIED_NO_CHANGE") {
      return {
        ok: true,
        kind: "verified_no_change",
        attempt,
        response,
        output,
        commitHash: null,
        commitBaseHash: null,
      };
    }
  }

  return {
    ok: false,
    kind: "evidence_missing",
    reason: "No implementation attempt has a matching response with either a commit or a VERIFIED_NO_CHANGE result.",
  };
}

export function loadAssessmentSource(jobId) {
  return resolveAssessmentSource({
    attempts: getAttempts(jobId),
    responseArtifacts: getArtifacts(jobId, "response"),
  });
}
