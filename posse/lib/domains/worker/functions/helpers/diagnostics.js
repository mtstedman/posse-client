// lib/worker/helpers/diagnostics.js
//
// Small diagnostics and formatting helpers for failure artifacts, retry
// context, and execution-provider summaries.

export function buildPromptExcerpt(text = "", maxChars = 1200) {
  const value = String(text || "").trim();
  if (!value) return "(none)";
  return value.length > maxChars ? `${value.slice(0, maxChars)}\n...[truncated]` : value;
}

export function currentExecutionProvider(job = null) {
  return job?._executionProvider || job?.provider || null;
}

export function firstMeaningfulLine(text = "") {
  return String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .find(Boolean) || "";
}

export function getErrorText(errOrMsg) {
  if (typeof errOrMsg === "string") return errOrMsg;
  if (errOrMsg && typeof errOrMsg.message === "string") return errOrMsg.message;
  return "unknown error";
}

const TURN_BUDGET_EXHAUSTED_RE = /(?:exhausted turn budget|turn budget exhausted)/i;
const TOOL_BUDGET_EXHAUSTED_RE = /(?:(?:tool|tools|tool use|tool call|tool calls).{0,40}(?:exhausted|limit|max|budget)|(?:exhausted|hit|reached).{0,40}(?:tool|tools|tool use|tool call|tool calls))/i;

function findInvalidClientLine(text = "") {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => /\binvalid(?:[_\s-]+)client\b/i.test(line)) || "";
}

export function getErrorDetails(errOrMsg) {
  const fullText = getErrorText(errOrMsg);
  const prefix = firstMeaningfulLine(fullText) || "unknown error";
  const remainder = String(fullText || "").split("\n").slice(1).join("\n").trim();
  const embeddedPartial = remainder.startsWith("Partial output:")
    ? remainder.replace(/^Partial output:\s*/i, "").trim()
    : "";
  const embeddedStderr = remainder && !embeddedPartial ? remainder : "";
  const stderr = typeof errOrMsg === "string"
    ? embeddedStderr
    : String(errOrMsg?.stderr || embeddedStderr || "").trim();
  const partialOutput = typeof errOrMsg === "string"
    ? embeddedPartial
    : String(errOrMsg?.partialOutput || errOrMsg?.stdout || embeddedPartial || "").trim();
  const stderrLine = firstMeaningfulLine(stderr);
  const partialLine = firstMeaningfulLine(partialOutput);
  let summary = prefix;
  let repeatKey = prefix;
  let classification = null;
  const invalidClientLine = findInvalidClientLine([
    fullText,
    stderr,
    partialOutput,
  ].filter(Boolean).join("\n"));

  if (invalidClientLine) {
    classification = "invalid_client";
    summary = `${prefix} - invalid_client: ${invalidClientLine}`.slice(0, 240);
    repeatKey = `invalid_client | ${invalidClientLine}`;
  } else if (stderrLine && stderrLine !== prefix) {
    summary = `${prefix} — ${stderrLine}`.slice(0, 240);
    repeatKey = `${prefix} | stderr: ${stderrLine}`;
  } else if (partialLine && partialLine !== prefix) {
    summary = `${prefix} — partial output: ${partialLine}`.slice(0, 240);
    repeatKey = `${prefix} | partial: ${partialLine}`;
  }

  return {
    fullText,
    prefix,
    stderr,
    stderrLine,
    partialOutput,
    partialLine,
    classification,
    summary: summary.slice(0, 240),
    repeatKey: repeatKey.slice(0, 320),
    toolUses: Array.isArray(errOrMsg?.toolUses) ? errOrMsg.toolUses : [],
    stats: errOrMsg?.stats || null,
  };
}

export function isTurnBudgetExhaustedDetails(errorDetails = null) {
  if (!errorDetails) return false;
  const text = [
    errorDetails.fullText || "",
    errorDetails.summary || "",
    errorDetails.stderr || "",
    errorDetails.partialOutput || "",
  ].join("\n");
  return TURN_BUDGET_EXHAUSTED_RE.test(text) || TOOL_BUDGET_EXHAUSTED_RE.test(text);
}

export function isPermanentProviderConfigError(errorDetailsOrErr = null) {
  const errorDetails = errorDetailsOrErr && typeof errorDetailsOrErr === "object"
    && ("fullText" in errorDetailsOrErr || "summary" in errorDetailsOrErr || "stderr" in errorDetailsOrErr || "partialOutput" in errorDetailsOrErr)
    ? errorDetailsOrErr
    : getErrorDetails(errorDetailsOrErr);
  const primaryTextParts = [
    errorDetails.fullText || "",
    errorDetails.stderr || "",
    errorDetails.partialOutput || "",
    errorDetails.classification || "",
  ].filter(Boolean);
  const text = (primaryTextParts.length > 0 ? primaryTextParts : [errorDetails.summary || ""]).join("\n");
  if (errorDetails.classification === "invalid_client") return true;
  return [
    /\b401\b[^\n]{0,160}\b(?:incorrect\s+(?:api\s+)?key|invalid\s+(?:api\s+)?key|unauthorized|authentication)\b/i,
    /\binvalid[_\s-]+api[_\s-]+key\b/i,
    /\b(?:incorrect|invalid|missing|no)\s+(?:api\s+)?key\b/i,
    /\b(?:api\s+key|auth(?:entication)?\s+token|credential|credentials)\b[^\n]{0,100}\b(?:not\s+set|missing|invalid|incorrect|not\s+found)\b/i,
    /\b(?:unauthorized|authentication\s+failed|invalid\s+auth|invalid[_\s-]+client)\b/i,
    /\b(?:model|deployment)\b[^\n]{0,160}\b(?:does\s+not\s+exist|unsupported|is\s+not\s+supported|not\s+supported|does\s+not\s+support)\b/i,
    /\b(?:unknown|unsupported|invalid)\s+model\b/i,
    /\bnot\s+supported\s+when\s+using\s+codex\b/i,
    /\b(?:do\s+not|don't|does\s+not)\s+have\s+access\b[^\n]{0,100}\bmodel\b/i,
  ].some((re) => re.test(text));
}

export function retryingAttemptWording(errorDetails = null) {
  if (!errorDetails) return null;
  const text = [
    errorDetails.fullText || "",
    errorDetails.summary || "",
    errorDetails.stderr || "",
    errorDetails.partialOutput || "",
  ].join("\n");
  if (TOOL_BUDGET_EXHAUSTED_RE.test(text)) {
    return {
      kind: "turn_budget",
      displayVerb: "hit tool budget",
      eventVerb: "hit tool budget",
      summaryVerb: "hit tool budget",
    };
  }
  if (TURN_BUDGET_EXHAUSTED_RE.test(text)) {
    return {
      kind: "turn_budget",
      displayVerb: "hit turn budget",
      eventVerb: "hit turn budget",
      summaryVerb: "hit turn budget",
    };
  }
  const fullText = String(errorDetails.fullText || "");
  const hasToolUse = (Array.isArray(errorDetails.toolUses) && errorDetails.toolUses.length > 0)
    || /\bTool calls \(\d+\):/i.test(fullText);
  if (hasToolUse) {
    return {
      kind: "tool_use",
      displayVerb: "stopped during tool use",
      eventVerb: "stopped during tool use",
      summaryVerb: "stopped during tool use",
    };
  }
  return null;
}

export function buildFailureDiagnosticsArtifact(errOrMsg, attemptCount) {
  const details = getErrorDetails(errOrMsg);
  const sections = [
    "## Provider Failure Diagnostics",
    `Attempt: ${attemptCount}`,
    `Summary: ${details.summary}`,
    `Repeat key: ${details.repeatKey}`,
    "",
    "### Full Error",
    buildPromptExcerpt(details.fullText, 4000),
  ];

  if (details.stderr) {
    sections.push("", "### Stderr", buildPromptExcerpt(details.stderr, 4000));
  }
  if (details.partialOutput) {
    sections.push("", "### Partial Output", buildPromptExcerpt(details.partialOutput, 4000));
  }
  if (details.toolUses.length > 0) {
    const toolLines = details.toolUses.map((t) => {
      const inp = t.input || {};
      if (t.tool === "Read") return `- Read: ${inp.file_path || "?"}`;
      if (t.tool === "Glob") return `- Glob: ${inp.pattern || "?"}`;
      if (t.tool === "Grep") return `- Grep: "${inp.pattern || "?"}" in ${inp.path || inp.glob || "."}`;
      if (t.tool === "Bash") return `- Bash: ${(inp.command || "?").slice(0, 120)}`;
      return `- ${t.tool}: ${JSON.stringify(inp).slice(0, 120)}`;
    });
    sections.push("", `### Tool Calls (${details.toolUses.length})`, ...toolLines);
  }
  if (details.stats) {
    sections.push("", "### Call Stats", JSON.stringify({
      exit_code: details.stats.exitCode ?? null,
      duration_ms: details.stats.durationMs ?? null,
      input_tokens: details.stats.inputTokens ?? null,
      output_tokens: details.stats.outputTokens ?? null,
      output_chars: details.stats.outputChars ?? null,
      model_name: details.stats.modelName ?? null,
      max_turns: details.stats.maxTurns ?? null,
      num_turns: details.stats.numTurns ?? null,
    }, null, 2));
  }

  return sections.join("\n");
}

export function extractResearchRetryContext(logArtifacts = []) {
  const snippets = [];
  for (const artifact of logArtifacts || []) {
    const text = String(artifact?.content_long || "");
    if (!text) continue;
    if (/PRIOR ATTEMPT CONTEXT/.test(text)) {
      snippets.push(text.trim());
      continue;
    }
    if (!/## Provider Failure Diagnostics/i.test(text)) continue;
    const summaryMatch = text.match(/^Summary:\s*(.+)$/mi);
    const toolSectionMatch = text.match(/### Tool Calls \(\d+\)\n([\s\S]*?)(?:\n### |\s*$)/);
    const statsMatch = text.match(/### Call Stats\n([\s\S]*?)$/);
    const statsText = statsMatch?.[1] || "";
    const turnBudgetExhausted = /"max_turns":\s*(\d+)/.test(statsText)
      && /"num_turns":\s*(\d+)/.test(statsText)
      && (() => {
        const maxTurns = Number((statsText.match(/"max_turns":\s*(\d+)/) || [])[1]);
        const numTurns = Number((statsText.match(/"num_turns":\s*(\d+)/) || [])[1]);
        const outputChars = Number((statsText.match(/"output_chars":\s*(\d+)/) || [])[1]);
        return Number.isFinite(maxTurns) && Number.isFinite(numTurns) && numTurns >= maxTurns && outputChars === 0;
      })();
    if (!turnBudgetExhausted && !toolSectionMatch) continue;

    const lines = [
      "PRIOR ATTEMPT CONTEXT:",
      summaryMatch ? `Previous failure: ${summaryMatch[1].trim()}` : "Previous failure: provider exited before returning a final answer.",
    ];
    if (turnBudgetExhausted) {
      lines.push("The previous attempt appears to have exhausted Claude's turn budget on tool calls before producing a final summary.");
      lines.push("Be much more selective: avoid broad exploratory reads, synthesize earlier, and stop once you can answer the task.");
    }
    if (toolSectionMatch) {
      lines.push("Tool calls already attempted:");
      for (const line of toolSectionMatch[1].trim().split("\n").slice(0, 20)) {
        lines.push(line);
      }
    }
    snippets.push(lines.join("\n"));
  }
  return snippets.join("\n\n");
}
