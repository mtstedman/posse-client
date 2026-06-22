function _failureText(value) {
  if (!value) return "";
  if (typeof value === "string") return value;
  if (value instanceof Error) {
    return [
      value.message,
      value.stderr,
      value.stdout,
      value.partialOutput,
    ].filter(Boolean).join("\n");
  }
  if (typeof value === "object") {
    return [
      value.error,
      value.message,
      value.stderr,
      value.stdout,
      value.partialOutput,
    ].filter(Boolean).join("\n");
  }
  return String(value);
}

export function classifyClaudeCliFailure(value) {
  const lines = _failureText(value)
    .split(/\r?\n/)
    .map((line) => line.trim());
  const invalidClientLine = lines.find((line) => /\binvalid(?:[_\s-]+)client\b/i.test(line));
  if (invalidClientLine) {
    return {
      classification: "invalid_client",
      retryable: false,
      detail: invalidClientLine.slice(0, 240),
    };
  }
  const contentionLine = lines.find((line) =>
    /(?:another|existing|active).{0,40}\bclaude\b|\bclaude\b.{0,40}(?:already running|active|busy)|\b(?:lock(?:ed)?|busy|resource busy|ebusy|eperm|etxtbsy|database is locked|timed out|timeout)\b/i.test(line)
  );
  if (contentionLine) {
    return {
      classification: "local_contention",
      retryable: true,
      detail: contentionLine.slice(0, 240),
    };
  }
  return null;
}

export function __testClassifyClaudeCliFailure(value) {
  return classifyClaudeCliFailure(value);
}

