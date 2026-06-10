function normalizeText(value) {
  return String(value || "").trim();
}

function lower(value) {
  return normalizeText(value).toLowerCase();
}

function hasRepoLikePath(text) {
  return /`[^`]+[\\/][^`]+`/.test(text)
    || /\b[a-z0-9_.-]+[\\/][a-z0-9_./\\-]+\.[a-z0-9]+\b/i.test(text);
}

function hasCodeReference(text) {
  return /`[#.]?[a-z_$][\w$.-]*`/i.test(text)
    || /\b[a-z_$][\w$]*\s*(?:\(|handler|markup|initialization|selector|function)\b/i.test(text);
}

function asksForRepoFileAccess(text) {
  const source = lower(text);
  if (!source) return false;

  const commandDrivenRepoInspection =
    source.includes("run and paste the output of")
    || source.includes("paste the output of")
    || source.includes("git ls-files")
    || /\brg\b/.test(source)
    || source.includes("findstr");

  const directEvidenceAsk =
    /\bprovide\b/.test(source)
    || /\bshow\b/.test(source)
    || /\bpaste\b/.test(source)
    || /\bconfirm\b/.test(source)
    || /\bverify\b/.test(source)
    || /\bcheck\b/.test(source);

  const repoEvidenceTarget =
    /\bcontents?\b/.test(source)
    || /\bcontent\b/.test(source)
    || /\bdiffs?\b/.test(source)
    || /\bfragment\b/.test(source)
    || /\bsnippet\b/.test(source)
    || /\blines?\b/.test(source)
    || /\bline numbers?\b/.test(source)
    || /\bselectors?\b/.test(source)
    || /\brules?\b/.test(source)
    || /\bhandlers?\b/.test(source)
    || /\bmarkup\b/.test(source)
    || /\bimplementation\b/.test(source)
    || /\bcode\b/.test(source);

  const codePresenceCheck =
    /\b(?:contains?|includes?|defines?|implements?|uses?|calls?|sets?|adds?|added|exists?)\b/.test(source)
    || /\bwere added\b/.test(source)
    || /\bwas added\b/.test(source)
    || /\bexact lines? where\b/.test(source)
    || /\baround lines?\b/.test(source);

  const toolingFailureSignal =
    source.includes("could not inspect")
    || source.includes("could not verify")
    || source.includes("output was truncated")
    || source.includes("file-read operations are blocked")
    || source.includes("read was truncated")
    || source.includes("file-system access is blocked")
    || source.includes("filesystem access is blocked");

  const explicitPatterns =
    /provide .* from\s+`[^`]+`/i.test(text)
    || /confirm whether .* contains/i.test(text)
    || /can you confirm whether .* contains/i.test(text)
    || /does .* contain/i.test(text)
    || /confirm that .* (?:were|was) added to\s+`[^`]+`/i.test(text)
    || /show the diffs around/i.test(text)
    || /confirm the exact line numbers?/i.test(text);

  return explicitPatterns
    || toolingFailureSignal
    || commandDrivenRepoInspection
    || (directEvidenceAsk && repoEvidenceTarget)
    || (directEvidenceAsk && codePresenceCheck);
}

function looksLikeApprovalQuestion(text) {
  const source = lower(text);
  return source.includes("should this pass or fail")
    || source.includes("(pass / fail")
    || source.includes("approve or reject")
    || source.includes("pass or fail?");
}

function looksLikeExternalInfoQuestion(text) {
  const source = lower(text);
  return source.includes("what is the user's preference")
    || source.includes("which option should we choose")
    || source.includes("do you want")
    || source.includes("which provider")
    || source.includes("what should we do")
    || source.includes("should we retry");
}

export function classifyHumanQuestion(question, { context = "" } = {}) {
  const text = normalizeText(question);
  const surrounding = `${text}\n${normalizeText(context)}`.trim();
  if (!text) {
    return {
      category: "empty",
      allowHuman: false,
      reason: "empty question",
      text,
    };
  }

  if (looksLikeApprovalQuestion(text)) {
    return {
      category: "approval",
      allowHuman: true,
      reason: "explicit approval/review question",
      text,
    };
  }

  if (asksForRepoFileAccess(text) && (hasRepoLikePath(surrounding) || hasCodeReference(surrounding))) {
    return {
      category: "repo_file_access",
      allowHuman: false,
      reason: "asks the human for repository file contents, diffs, or line confirmation",
      text,
    };
  }

  if (looksLikeExternalInfoQuestion(text)) {
    return {
      category: "external_info",
      allowHuman: true,
      reason: "asks for a user/product decision",
      text,
    };
  }

  return {
    category: "other",
    allowHuman: true,
    reason: "not a repository file access request",
    text,
  };
}

export function sanitizeHumanQuestions(questions = [], { context = "" } = {}) {
  const source = Array.isArray(questions) ? questions : [];
  return source
    .map((q) => classifyHumanQuestion(q, { context }))
    .filter((entry) => entry.allowHuman && entry.text)
    .map((entry) => entry.text);
}

export function isRepoFileAccessQuestion(question, { context = "" } = {}) {
  return classifyHumanQuestion(question, { context }).category === "repo_file_access";
}
