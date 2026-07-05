function positiveInteger(value) {
  const n = Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

function compactReason(value) {
  const text = String(value ?? "").trim();
  return text || null;
}

function outputItemReasons(response = {}) {
  const output = Array.isArray(response?.output) ? response.output : [];
  const reasons = [];
  for (const item of output) {
    for (const key of ["finish_reason", "finishReason", "status", "reason"]) {
      const value = compactReason(item?.[key]);
      if (value) reasons.push(value);
    }
  }
  return reasons;
}

export function normalizeMaxOutputTokens(value) {
  return positiveInteger(value);
}

export function withMaxOutputTokens(requestOpts = {}, maxOutputTokens = null) {
  const limit = normalizeMaxOutputTokens(maxOutputTokens);
  if (!limit) return requestOpts;
  return { ...requestOpts, max_output_tokens: limit };
}

export function responseOutputLimitReason(response = {}) {
  const reasons = [
    response?.incomplete_details?.reason,
    response?.incompleteDetails?.reason,
    response?.finish_reason,
    response?.finishReason,
    ...outputItemReasons(response),
  ].map(compactReason).filter(Boolean);

  for (const reason of reasons) {
    if (/max[_ -]?output|max[_ -]?tokens?|output[_ -]?limit|length|truncat|incomplete/i.test(reason)) {
      return reason;
    }
  }

  const status = compactReason(response?.status);
  if (status && /^incomplete$/i.test(status)) {
    return reasons[0] || status;
  }
  return null;
}

export function buildOutputLimitError(providerLabel, phase, reason, maxOutputTokens) {
  const cap = normalizeMaxOutputTokens(maxOutputTokens);
  const suffix = cap ? ` at ${cap} output tokens` : "";
  const err = new Error(`${providerLabel} response hit output limit during ${phase}${suffix}${reason ? ` (${reason})` : ""}`);
  err.code = "OUTPUT_TOKEN_LIMIT";
  err.outputTruncated = true;
  err.outputLimitReason = reason || "output_limit";
  return err;
}
