import { normalizeResearchBudget } from "../../../shared/policies/functions/role-utils.js";
import { slugify } from "../../../shared/format/functions/slug.js";

const SIMPLE_NO_RESEARCH_RE = /\b(?:typo|spelling|comment\s+fix|comment-only|rename|renaming|copy\s*edit|docs?\s+fix|formatting|whitespace)\b/i;
const ONESHOT_SIMPLE_RE = /\b(?:typo|spelling|comment\s+fix|comment-only|copy\s*edit|docs?\s+fix|whitespace)\b/i;
const LOW_NO_LOGIC_RE = /\b(?:typo|spelling|comments?\s+fix|comment-only|rename|copy\s*edit|docs?|readme|formatting|whitespace|no\s+(?:logic|behavior|behaviour)\s+change)\b/i;
const COMPLEX_RE = /\b(?:race|concurren\w*|security|auth|authorization|authentication|lock|locking|deadlock|transaction|migration|corruption|data\s+loss|permission|credential|secret|encryption|oauth|session)\b/i;
const AMBIGUOUS_RE = /\b(?:investigate|figure\s+out\s+why|diagnose|debug\s+why|root\s+cause|trace\s+why|why\s+(?:is|does|did)|flaky|intermittent)\b/i;
const FANOUT_TRIGGER_RE = /\b(?:audit|review\s+all|verify\s+each|find\s+all|scan\s+all|check\s+every|across)\b/i;
const BROAD_SCOPE_RE = /\b(?:all|every|each|across|whole|entire)\b/i;
const WEB_FANOUT_RE = /\b(?:compare|versus|vs\.?|between|across|audit|review|verify|investigate)\b/i;
const RENAME_RE = /\b(?:rename|renaming)\b/i;
const FORMAT_RE = /\bformatting\b/i;
const ONESHOT_TOKEN_RE = /(?:^|\s)#one[-_]?shot\b/i;
const LOW_BLAST_SCOPE_RE = /\b(?:keep|limit(?:ed)?|scop(?:e|ed)|single[-\s]?file|one[-\s]?file|only|do\s+not\s+change|don't\s+change|without\s+changing|no\s+(?:runtime\s+)?behaviou?r|smallest\s+change)\b/i;
const URL_RE = /\bhttps?:\/\/[^\s<>"')\]]+/gi;
const DOMAIN_RE = /\b(?:[a-z0-9-]+\.)+(?:ai|app|cloud|co|com|dev|edu|gov|io|net|org)\b/gi;

const WEB_VENDOR_HINTS = {
  anthropic: ["docs.anthropic.com", "anthropic.com"],
  aws: ["docs.aws.amazon.com", "aws.amazon.com"],
  azure: ["learn.microsoft.com", "azure.microsoft.com"],
  cloudflare: ["developers.cloudflare.com", "cloudflare.com"],
  datadog: ["docs.datadoghq.com", "datadoghq.com"],
  google: ["cloud.google.com", "developers.google.com"],
  grok: ["docs.x.ai", "x.ai"],
  openai: ["platform.openai.com", "openai.com"],
  opentelemetry: ["opentelemetry.io"],
  prometheus: ["prometheus.io"],
  redis: ["redis.io"],
  sendgrid: ["docs.sendgrid.com", "sendgrid.com"],
  shopify: ["shopify.dev", "shopify.com"],
  stripe: ["docs.stripe.com", "stripe.com"],
  taxjar: ["developers.taxjar.com", "taxjar.com"],
};

const FILE_EXTENSIONS = [
  "cjs",
  "css",
  "go",
  "html",
  "java",
  "js",
  "json",
  "jsx",
  "md",
  "mjs",
  "php",
  "py",
  "rb",
  "rs",
  "sh",
  "sql",
  "ts",
  "tsx",
  "toml",
  "yaml",
  "yml",
];

const FILE_MENTION_RE = new RegExp(
  `(?:^|[\\s\`"'(\\[])((?:\\.{1,2}[\\\\/])?(?:[A-Za-z0-9_.-]+[\\\\/])*[A-Za-z0-9_.-]+\\.(?:${FILE_EXTENSIONS.join("|")}))(?=$|[^A-Za-z0-9_.-])`,
  "gi",
);

function normalizeText(value) {
  return String(value || "").replace(/\r\n/g, "\n").trim();
}

function normalizePathLike(value) {
  return String(value || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^\.\//, "")
    .replace(/^\/+/, "");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function splitHintList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeExplicitBudget(value) {
  if (value == null || String(value).trim() === "") return null;
  return normalizeResearchBudget(value);
}

function normalizeDomainLike(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "";
  try {
    const parsed = raw.startsWith("http://") || raw.startsWith("https://")
      ? new URL(raw)
      : new URL(`https://${raw}`);
    return parsed.hostname.replace(/^www\./, "");
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .replace(/^www\./i, "")
      .split(/[/?#]/)[0]
      .replace(/[^a-z0-9.-]/gi, "")
      .toLowerCase();
  }
}

function vendorLabelFromDomain(domain) {
  const normalized = normalizeDomainLike(domain);
  if (!normalized) return "";
  const parts = normalized.split(".").filter(Boolean);
  if (parts.length <= 1) return normalized;
  const sld = parts[parts.length - 2];
  return sld === "google" && parts.includes("cloud") ? "google" : sld;
}

function webBranch(label, scopeHints) {
  return {
    label: normalizeWebBranchLabel(label),
    kind: "web",
    scope_hints: unique(scopeHints.map((hint) => String(hint || "").trim()).filter(Boolean)).slice(0, 5),
  };
}

function normalizeWebBranchLabel(label) {
  return slugify(label || "web", { fallback: "web", maxLength: 60 });
}

function extractWebBranches(text, intakeHints = {}) {
  const branches = [];
  const addBranch = (label, hints) => {
    const normalizedLabel = normalizeWebBranchLabel(label);
    if (!normalizedLabel) return;
    const existing = branches.find((branch) => branch.label === normalizedLabel);
    if (existing) {
      existing.scope_hints = unique([...existing.scope_hints, ...hints]).slice(0, 5);
      return;
    }
    branches.push(webBranch(normalizedLabel, hints));
  };

  for (const match of String(text || "").matchAll(URL_RE)) {
    const url = match[0];
    addBranch(vendorLabelFromDomain(url), [url]);
  }
  for (const match of String(text || "").matchAll(DOMAIN_RE)) {
    const domain = normalizeDomainLike(match[0]);
    addBranch(vendorLabelFromDomain(domain), [domain]);
  }
  for (const value of [
    ...splitHintList(intakeHints?.suspected_urls),
    ...splitHintList(intakeHints?.suspected_domains),
  ]) {
    const domain = normalizeDomainLike(value);
    addBranch(vendorLabelFromDomain(domain), [value]);
  }
  for (const vendor of splitHintList(intakeHints?.suspected_vendors)) {
    const key = String(vendor || "").trim().toLowerCase();
    addBranch(key, WEB_VENDOR_HINTS[key] || [key]);
  }
  for (const [vendor, hints] of Object.entries(WEB_VENDOR_HINTS)) {
    if (textContainsBareWord(text, vendor)) addBranch(vendor, hints);
  }
  return branches;
}

function extractFileMentions(text, intakeHints = {}) {
  const mentions = [];
  for (const match of text.matchAll(FILE_MENTION_RE)) {
    mentions.push(normalizePathLike(match[1]));
  }

  for (const hinted of splitHintList(intakeHints?.suspected_files)) {
    const normalized = normalizePathLike(hinted);
    if (normalized) mentions.push(normalized);
  }

  return unique(mentions);
}

function extractEditTargetFiles(text, intakeHints = {}, fileMentions = []) {
  const hinted = splitHintList(intakeHints?.candidate_files ?? intakeHints?.suspected_files)
    .map(normalizePathLike);
  if (hinted.length > 0) return unique(hinted);

  const leadingTargets = [];
  for (const match of text.matchAll(FILE_MENTION_RE)) {
    const file = normalizePathLike(match[1]);
    const start = match.index || 0;
    const end = start + match[0].length;
    const before = text.slice(0, start);
    const after = text.slice(end);
    const leadIn = /(?:^|[\n.!?]\s*)\s*(?:in|within|inside)\s*$/i.test(before);
    if (leadIn && /^\s*,/.test(after)) leadingTargets.push(file);
  }
  if (leadingTargets.length > 0) return unique(leadingTargets);

  return fileMentions.length === 1 ? fileMentions : [];
}

function extractDirMentions(intakeHints = {}) {
  return unique(splitHintList(intakeHints?.suspected_dirs).map(normalizePathLike));
}

function extractListItems(text) {
  return normalizeText(text)
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*]\s+|\d+[.)]\s+)/.test(line));
}

function textContainsBareWord(text, word) {
  if (!word) return false;
  const lowerText = String(text || "").toLowerCase();
  const target = String(word || "").toLowerCase();
  let start = lowerText.indexOf(target);
  while (start !== -1) {
    const before = lowerText[start - 1] || "";
    const after = lowerText[start + target.length] || "";
    const nextAfter = lowerText[start + target.length + 1] || "";
    const beforeOk = !before || !/[a-z0-9_.-]/i.test(before);
    const afterOk = !after
      || (after === "." ? (!nextAfter || /[\s),;:!?'"\]`]/.test(nextAfter)) : !/[a-z0-9_-]/i.test(after));
    if (beforeOk && afterOk) return true;
    start = lowerText.indexOf(target, start + 1);
  }
  return false;
}

function aliasMatchesText(text, alias) {
  const normalizedAlias = normalizePathLike(alias).toLowerCase();
  if (!normalizedAlias) return false;
  const lowerText = text.toLowerCase().replace(/\\/g, "/");
  if (normalizedAlias.includes("/") || normalizedAlias.includes(".")) {
    let start = lowerText.indexOf(normalizedAlias);
    while (start !== -1) {
      const before = lowerText[start - 1] || "";
      const after = lowerText[start + normalizedAlias.length] || "";
      const beforeOk = !before || before === "/" || !/[a-z0-9_.-]/i.test(before);
      const afterOk = !after || after === "/" || !/[a-z0-9_.-]/i.test(after);
      if (beforeOk && afterOk) return true;
      start = lowerText.indexOf(normalizedAlias, start + 1);
    }
    return false;
  }
  return textContainsBareWord(lowerText, normalizedAlias);
}

function moduleEntries(projectMap = {}) {
  const aliases = projectMap?.module_aliases && typeof projectMap.module_aliases === "object"
    ? projectMap.module_aliases
    : {};
  const modules = projectMap?.modules && typeof projectMap.modules === "object"
    ? projectMap.modules
    : {};
  const names = unique([...Object.keys(aliases), ...Object.keys(modules)]);
  return names.map((name) => ({
    name,
    aliases: unique([
      name,
      ...(Array.isArray(aliases[name]) ? aliases[name] : []),
      ...(Array.isArray(modules[name]) ? modules[name] : []),
    ]),
  }));
}

function moduleFromFileMention(file) {
  const normalized = normalizePathLike(file).toLowerCase();
  let match = /^lib\/([^/]+)\//.exec(normalized);
  if (match) return match[1];
  match = /^lib\/([^/.]+)\.[^.]+$/.exec(normalized);
  if (match) return match[1];
  return null;
}

function moduleFromScopeMention(scope) {
  const normalized = normalizePathLike(scope).toLowerCase().replace(/\/$/, "");
  const match = /^lib\/([^/]+)/.exec(normalized);
  if (!match) return null;
  return match[1].replace(/\.[^.]+$/, "") || null;
}

function extractMentionedModules(text, projectMap, fileMentions, dirMentions) {
  const modules = [];
  for (const entry of moduleEntries(projectMap)) {
    if (entry.aliases.some((alias) => aliasMatchesText(text, alias))) {
      modules.push(entry.name);
    }
  }
  for (const file of fileMentions) {
    modules.push(moduleFromFileMention(file));
  }
  for (const dir of dirMentions) {
    modules.push(moduleFromScopeMention(dir));
  }
  return unique(modules);
}

function branchScopeHints(moduleName, projectMap = {}) {
  const aliases = projectMap?.module_aliases?.[moduleName];
  if (Array.isArray(aliases) && aliases.length > 0) return aliases.slice(0, 5);
  const modules = projectMap?.modules?.[moduleName];
  if (Array.isArray(modules) && modules.length > 0) return modules.slice(0, 5);
  return [`lib/${moduleName}`];
}

function buildBranches(mentionedModules, projectMap) {
  return mentionedModules.slice(0, 4).map((moduleName) => ({
    label: moduleName,
    kind: "module",
    scope_hints: branchScopeHints(moduleName, projectMap),
  }));
}

function filesAllInSameModule(fileMentions) {
  const modules = unique(fileMentions.map(moduleFromFileMention));
  return fileMentions.length > 1 && modules.length === 1 && !!modules[0];
}

function branchesCoverMentionedScope(branches, mentionedModules, fileMentions) {
  if (branches.length === 0) return false;
  const scopedFiles = fileMentions.filter((file) => /^lib\//i.test(file));
  const totalScope = mentionedModules.length + scopedFiles.length;
  if (totalScope === 0) return true;

  // Treat each named module and each explicit lib/ file mention as a scope unit.
  // A fanout branch set is clear enough only when at least half of that scope
  // resolves back to one of the proposed module branches.
  const coveredFiles = scopedFiles.filter((file) => {
    const moduleName = moduleFromFileMention(file);
    return moduleName && mentionedModules.includes(moduleName);
  }).length;
  return (mentionedModules.length + coveredFiles) / totalScope >= 0.5;
}

function isMultiParagraph(description) {
  return normalizeText(description).split(/\n\s*\n/).filter((part) => part.trim()).length >= 2;
}

function hasUrgentPriority(intakeHints = {}) {
  return /^(urgent|critical|p0|high)$/i.test(String(intakeHints?.priority || intakeHints?.urgency || ""));
}

function determineBudget({ text, intakeHints, mentionedModules, fileMentions, noResearch }) {
  if (noResearch) return "low";

  const explicitBudget = normalizeExplicitBudget(
    intakeHints?.deepthink_budget
      ?? intakeHints?.research_budget
      ?? intakeHints?.reasoning_budget
      ?? intakeHints?.budget,
  );
  if (explicitBudget) return explicitBudget;

  if (hasUrgentPriority(intakeHints) && COMPLEX_RE.test(text)) return "xhigh";
  if (intakeHints?.deepthink === true || String(intakeHints?.deepthink || "").toLowerCase() === "true") return "high";
  if (mentionedModules.length >= 2 || COMPLEX_RE.test(text)) return "high";
  if (fileMentions.length <= 1 && LOW_NO_LOGIC_RE.test(text) && !COMPLEX_RE.test(text)) return "low";
  return "normal";
}

function hasProtectedFileMention(fileMentions) {
  return fileMentions.some((file) => normalizePathLike(file).toLowerCase().startsWith("prompts/"));
}

function isLowBlastRadiusSingleFileEdit({
  text,
  noResearchText,
  editTargetFiles,
  protectedFileMention,
  webBranches,
  listItems,
  lowerMode,
}) {
  if (protectedFileMention) return false;
  if (lowerMode === "question" || lowerMode === "promote") return false;
  if (editTargetFiles.length !== 1) return false;
  if (webBranches.length > 0) return false;
  if (listItems.length > 1) return false;
  if (noResearchText.length > 700) return false;
  if (COMPLEX_RE.test(text) || AMBIGUOUS_RE.test(text) || FANOUT_TRIGGER_RE.test(text)) return false;
  if (BROAD_SCOPE_RE.test(text) && !LOW_BLAST_SCOPE_RE.test(text)) return false;
  return LOW_BLAST_SCOPE_RE.test(text);
}

export function buildSyntheticResearchBrief(routingOrReason = null) {
  const reason = typeof routingOrReason === "string"
    ? routingOrReason
    : routingOrReason?.reason || "deterministic no_research route";
  const keyFiles = typeof routingOrReason === "object" && routingOrReason
    ? unique([...(routingOrReason.candidate_files || []), ...(routingOrReason.key_files || [])].map(normalizePathLike))
    : [];
  const structured = {
    research_skipped: true,
    reason,
    key_files: keyFiles,
    related_files: [],
    constraints: ["Researcher was skipped by deterministic routing; planner should rely on the original work item and intake hints."],
    questions_for_human: false,
    questions: [],
  };
  return [
    "# Research skipped",
    "",
    `Reason: ${structured.reason}`,
    "",
    "```json",
    JSON.stringify(structured, null, 2),
    "```",
  ].join("\n");
}

export function classifyResearchTask({
  title = "",
  description = "",
  intakeHints = {},
  projectMap = null,
  mode = null,
} = {}) {
  const taskTitle = normalizeText(title);
  const taskDescription = normalizeText(description);
  const text = normalizeText([taskTitle, taskDescription].filter(Boolean).join("\n\n"));
  const lowerMode = String(mode || intakeHints?.mode || "").toLowerCase().trim();
  const fileMentions = extractFileMentions(text, intakeHints);
  const editTargetFiles = extractEditTargetFiles(text, intakeHints, fileMentions);
  const dirMentions = extractDirMentions(intakeHints);
  const mentionedModules = extractMentionedModules(text, projectMap, fileMentions, dirMentions);
  const webBranches = extractWebBranches(text, intakeHints);
  const listItems = extractListItems(taskDescription || taskTitle);
  const noResearchText = taskDescription || taskTitle;
  const protectedFileMention = hasProtectedFileMention(fileMentions);
  const explicitOneshot = String(intakeHints?.intent_type || "").toLowerCase() === "oneshot" || ONESHOT_TOKEN_RE.test(text);
  const oneshotSimple = !protectedFileMention && ONESHOT_SIMPLE_RE.test(text) && noResearchText.length < 200 && !COMPLEX_RE.test(text) && !RENAME_RE.test(text) && !FORMAT_RE.test(text);
  const simpleNoResearch = !protectedFileMention && SIMPLE_NO_RESEARCH_RE.test(text) && fileMentions.length === 1 && noResearchText.length < 200 && !COMPLEX_RE.test(text);
  const renameMultiNoResearch = !protectedFileMention && RENAME_RE.test(text) && filesAllInSameModule(fileMentions) && noResearchText.length < 400 && !COMPLEX_RE.test(text);
  const webFanoutCandidate = webBranches.length >= 2 && WEB_FANOUT_RE.test(text) && mentionedModules.length === 0 && fileMentions.length === 0;
  const lowBlastSingleFileEdit = isLowBlastRadiusSingleFileEdit({
    text,
    noResearchText,
    editTargetFiles,
    protectedFileMention,
    webBranches,
    listItems,
    lowerMode,
  });

  let result = null;
  if (lowerMode === "question" && webFanoutCandidate && webBranches.length <= 3) {
    result = {
      bucket: "fanout_clear",
      reason: "question compares clear external web branches",
      branches: webBranches.slice(0, 3),
    };
  } else if (lowerMode === "question" && webBranches.length > 0 && mentionedModules.length === 0 && fileMentions.length === 0) {
    result = {
      bucket: "web_only_answer",
      reason: "question mode has external web signal and no repo scope",
      web_targets: webBranches,
    };
  } else if (lowerMode === "question") {
    result = { bucket: "solo", reason: "question mode always runs researcher" };
  } else if (!protectedFileMention && explicitOneshot && lowerMode !== "question" && lowerMode !== "promote" && fileMentions.length === 1) {
    result = {
      bucket: "oneshot",
      reason: "explicit one-shot intent with single file",
      candidate_files: fileMentions,
      oneshot_source: "explicit",
    };
  } else if (!protectedFileMention && explicitOneshot && lowerMode !== "question" && lowerMode !== "promote" && fileMentions.length === 0) {
    result = {
      bucket: "oneshot_candidate",
      reason: "explicit one-shot intent needs preflight scope resolution",
      oneshot_source: "explicit",
    };
  } else if (!protectedFileMention && String(intakeHints?.intent_type || "").toLowerCase() === "typo_fix") {
    result = { bucket: "no_research", reason: "intake intent is typo_fix" };
  } else if (!protectedFileMention && lowerMode === "promote") {
    result = { bucket: "no_research", reason: "promote mode is a branch handoff" };
  } else if (lowBlastSingleFileEdit) {
    result = {
      bucket: "oneshot",
      reason: "single-file low-blast-radius edit can skip planner",
      candidate_files: editTargetFiles,
      oneshot_source: "scope",
    };
  } else if (oneshotSimple && fileMentions.length === 1) {
    result = {
      bucket: "oneshot",
      reason: "single-file trivial edit can skip planner",
      candidate_files: fileMentions,
      oneshot_source: "heuristic",
    };
  } else if (oneshotSimple && fileMentions.length === 0 && lowerMode !== "question") {
    result = {
      bucket: "oneshot_candidate",
      reason: "trivial edit needs preflight scope resolution",
      oneshot_source: "heuristic",
    };
  } else if (simpleNoResearch) {
    result = { bucket: "no_research", reason: "single-file low-risk text edit" };
  } else if (renameMultiNoResearch) {
    result = { bucket: "no_research", reason: "same-module multi-file rename" };
  }

  if (!result) {
    const fanoutTriggered = FANOUT_TRIGGER_RE.test(text);
    const broadStructuredRequest = fanoutTriggered && (listItems.length >= 3 || BROAD_SCOPE_RE.test(text));
    if (fanoutTriggered && mentionedModules.length > 3) {
      result = { bucket: "ambiguous", reason: "fanout guard: more than 3 candidate branches" };
    } else if (webFanoutCandidate && webBranches.length > 3) {
      result = { bucket: "ambiguous", reason: "fanout guard: more than 3 candidate web branches" };
    } else if (webFanoutCandidate && webBranches.length >= 2) {
      result = {
        bucket: "fanout_clear",
        reason: "external request names clear web branches",
        branches: webBranches.slice(0, 3),
      };
    } else if (broadStructuredRequest && mentionedModules.length >= 3) {
      const branches = buildBranches(mentionedModules, projectMap);
      if (!branchesCoverMentionedScope(branches, mentionedModules, fileMentions)) {
        result = { bucket: "ambiguous", reason: "fanout guard: branch scope covers less than half of mentions" };
      } else {
        result = {
          bucket: "fanout_clear",
          reason: "broad request names 3 clear module branches",
          branches,
        };
      }
    } else if (fanoutTriggered && listItems.length >= 3 && mentionedModules.length < 3) {
      result = { bucket: "ambiguous", reason: "broad structured request lacks clear module branches" };
    }
  }

  if (!result) {
    if (isMultiParagraph(taskDescription) && mentionedModules.length === 0 && fileMentions.length === 0) {
      result = { bucket: "ambiguous", reason: "multi-paragraph task has no clear module or file signal" };
    } else if (taskDescription.length > 800 && mentionedModules.length === 0 && fileMentions.length === 0) {
      result = { bucket: "ambiguous", reason: "long task has no clear module or file signal" };
    } else if (AMBIGUOUS_RE.test(text) && mentionedModules.length === 0 && fileMentions.length === 0) {
      result = { bucket: "ambiguous", reason: "investigation request lacks specific scope" };
    }
  }

  if (!result) {
    result = { bucket: "solo", reason: "default single-researcher path" };
  }

  const noResearch = result.bucket === "no_research";
  const oneshotBucket = ["oneshot", "oneshot_candidate"].includes(result.bucket);
  const budget = oneshotBucket
    ? normalizeExplicitBudget(
      intakeHints?.deepthink_budget
        ?? intakeHints?.research_budget
        ?? intakeHints?.reasoning_budget
        ?? intakeHints?.budget,
    ) || "low"
    : determineBudget({ text, intakeHints, mentionedModules, fileMentions, noResearch });
  const finalResult = {
    ...result,
    web_targets: result.web_targets || (result.branches || []).filter((branch) => branch.kind === "web"),
    budget,
  };
  return finalResult;
}
