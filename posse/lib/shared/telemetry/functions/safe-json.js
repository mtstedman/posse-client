/** Serialize repeated references normally while marking true ancestor cycles. */
export function safeTelemetryStringify(value) {
  const ancestors = [];
  return JSON.stringify(value, function stringifyTelemetryValue(_key, current) {
    if (typeof current === "bigint") return current.toString();
    if (!current || typeof current !== "object") return current;
    while (ancestors.length > 0 && ancestors.at(-1) !== this) ancestors.pop();
    if (ancestors.includes(current)) return "[Circular]";
    ancestors.push(current);
    return current;
  });
}
