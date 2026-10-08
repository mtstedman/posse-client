// Protect subprocess evidence from credentials held by the parent process.
const SENSITIVE_PARENT_ENV_NAME_RE = /(?:^|_)(?:api_?key|access_?key|private_?key|token|secret|credential|password|passwd|pwd|auth|oauth|bearer|pat|cookie|session)(?:_|$)|^posse_key$/i;

export function parentSecretValues(baseEnv = process.env) {
  return [...new Set(Object.entries(baseEnv || {})
    .filter(([key, value]) => SENSITIVE_PARENT_ENV_NAME_RE.test(key) && String(value || "").length >= 6)
    .map(([, value]) => String(value)))]
    .sort((a, b) => b.length - a.length);
}

export function redactExactValues(value, secrets) {
  let output = String(value || "");
  for (const secret of secrets) output = output.split(secret).join("[REDACTED:parent-env]");
  return output;
}
