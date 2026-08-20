import crypto from "node:crypto";

import {
  SUB_AGENT_EVIDENCE_OUTCOMES,
  SUB_AGENT_LIMITS,
} from "../../../catalog/sub-agent.js";

function sha256(value) {
  return crypto.createHash("sha256").update(String(value ?? ""), "utf8").digest("hex");
}

function resultText(result) {
  if (!Array.isArray(result?.content)) {
    return typeof result === "string" ? result : JSON.stringify(result ?? null);
  }
  return result.content
    .map((entry) => entry?.text ?? entry?.data ?? "")
    .filter((entry) => entry !== "")
    .join("\n");
}

function withoutControlSuffixes(text, result) {
  let evidenceText = String(text ?? "");
  const stripped = [];
  const notices = Array.isArray(result?._meta?.posseControlNotices)
    ? result._meta.posseControlNotices
    : [];
  for (const notice of [...notices].reverse()) {
    const chars = Number(notice?.chars);
    if (!Number.isInteger(chars) || chars < 1 || chars > evidenceText.length) continue;
    const suffix = evidenceText.slice(-chars);
    const expectedHash = String(notice?.sha256 || "").trim().toLowerCase();
    if (expectedHash && sha256(suffix) !== expectedHash) continue;
    evidenceText = evidenceText.slice(0, -chars);
    stripped.unshift(String(notice?.kind || "runtime_control"));
  }
  return { text: evidenceText, stripped };
}

export function parseLeadingJsonValue(text) {
  const source = String(text ?? "");
  const start = source.search(/\S/);
  if (start < 0 || !["{", "["].includes(source[start])) return null;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (char === "\\") escaped = true;
      else if (char === '"') inString = false;
      continue;
    }
    if (char === '"') {
      inString = true;
      continue;
    }
    if (char === "{" || char === "[") depth += 1;
    else if (char === "}" || char === "]") depth -= 1;
    if (depth !== 0) continue;
    try {
      return JSON.parse(source.slice(start, index + 1));
    } catch {
      return null;
    }
  }
  return null;
}

function coveredRecovery(parsed) {
  const ref = String(parsed?.reaccess?.ref || parsed?.evidenceRef?.ref || "").trim();
  const authorization = String(parsed?.reaccess?.authorization || "").trim();
  if (!ref || !authorization) return null;
  return { ref, reaccessAuthorization: authorization };
}

export function classifyDelegatedToolResult(raw) {
  const isMcpResult = !!raw
    && typeof raw === "object"
    && !Array.isArray(raw)
    && Array.isArray(raw.content);
  if (!isMcpResult) {
    return {
      outcome: SUB_AGENT_EVIDENCE_OUTCOMES.DELIVERED,
      text: typeof raw === "string" ? raw : JSON.stringify(raw),
      parsed: null,
      controls: [],
    };
  }

  const rawText = resultText(raw);
  const stripped = withoutControlSuffixes(rawText, raw);
  const parsed = parseLeadingJsonValue(stripped.text);
  if (raw.isError === true) {
    return {
      outcome: SUB_AGENT_EVIDENCE_OUTCOMES.ERROR,
      text: stripped.text,
      parsed,
      controls: stripped.stripped,
      reason: "mcp_tool_error",
    };
  }

  const status = String(parsed?.status || "").trim().toLowerCase();
  if (status === "covered" || parsed?.covered === true) {
    return {
      outcome: SUB_AGENT_EVIDENCE_OUTCOMES.COVERED,
      text: stripped.text,
      parsed,
      controls: stripped.stripped,
      recovery: coveredRecovery(parsed),
      reason: parsed?.reason || "covered",
    };
  }
  if (parsed?.executed === false
    || ["blocked", "focus_correction", "redirected"].includes(status)) {
    return {
      outcome: SUB_AGENT_EVIDENCE_OUTCOMES.CONTROL,
      text: stripped.text,
      parsed,
      controls: stripped.stripped,
      reason: parsed?.reason || status || "not_executed",
    };
  }
  if (parsed?.ok === false || parsed?.found === false) {
    return {
      outcome: SUB_AGENT_EVIDENCE_OUTCOMES.ERROR,
      text: stripped.text,
      parsed,
      controls: stripped.stripped,
      reason: parsed?.code || parsed?.error || "tool_result_not_ok",
    };
  }
  if (!stripped.text.trim() && stripped.stripped.length > 0) {
    return {
      outcome: SUB_AGENT_EVIDENCE_OUTCOMES.CONTROL,
      text: "",
      parsed: null,
      controls: stripped.stripped,
      reason: stripped.stripped.at(-1) || "control_only_result",
    };
  }
  return {
    outcome: SUB_AGENT_EVIDENCE_OUTCOMES.DELIVERED,
    text: stripped.text,
    parsed,
    controls: stripped.stripped,
  };
}

export function delegatedEvidenceBounds(value) {
  const text = String(value ?? "");
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return {
    text,
    lines,
    empty: !text.trim(),
    withinLimits: text.length <= SUB_AGENT_LIMITS.maxEvidenceChars
      && lines.length <= SUB_AGENT_LIMITS.maxEvidenceLines,
  };
}
