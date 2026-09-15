// Diagnose the parsed fields without interpreting prose as executable input or
// granting evidence custody to content embedded in a string.
export function missingReportClaimsMessage(label, summary) {
  const misplacedParameter = typeof summary === "string"
    && /<parameter\s+name\s*=\s*["']claims["']\s*>/i.test(summary);
  return `${label}.report.claims requires at least one evidence-backed claim: the parsed claims array is empty. `
    + (misplacedParameter
      ? "A claims parameter is embedded inside the summary string, so it was received as summary text. "
      : "Supply claims as a separate array field alongside summary. ")
    + (misplacedParameter
      ? "Move that JSON array into the separate claims argument alongside summary. "
      : "")
    + "Preserve the existing claim text and evidence selectors; evidence lookup has not run for this empty array.";
}
