import fs from "fs";
import path from "path";

const VALID_INTENTS = new Set([
  "task",
  "bugfix",
  "design",
  "context",
  "question",
  "oneshot",
  "image",
  "report",
  "analysis",
]);

const VALID_DELIVERABLES = new Set([
  "code",
  "patch",
  "answer",
  "image",
  "markdown",
  "pdf",
  "json",
  "mixed",
]);

const VALID_OUTPUTS = new Set([
  "auto",
  "repo",
  "artifact",
  "question_only",
]);

const VALID_DESIRED_OUTPUTS = new Set([
  "repo",
  "artifact",
  "question_only",
]);

const VALID_HINT_SOURCES = new Set([
  "explicit",
  "inferred",
]);

const VALID_WORKFLOW_MODES = new Set([
  "bugfix",
  "ux",
  "refactor",
  "audit",
  "iterate",
]);

const ONESHOT_TOKEN_RE = /(?:^|\s)#one[-_]?shot\b/i;

function _normPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/^\/+/, "");
}

function _isWindowsDrivePath(value) {
  return /^[a-zA-Z]:/.test(String(value || ""));
}

function _hasParentTraversal(value) {
  return String(value || "")
    .split("/")
    .some((part) => part === "..");
}

function _isSafeHintPath(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");
  if (!raw) return false;
  if (path.posix.isAbsolute(raw)) return false;
  if (raw.startsWith("//")) return false;
  if (_isWindowsDrivePath(raw)) return false;
  const normalized = _normPath(raw);
  if (!normalized) return false;
  if (path.posix.isAbsolute(normalized)) return false;
  if (_isWindowsDrivePath(normalized)) return false;
  if (_hasParentTraversal(normalized)) return false;
  return true;
}

function _resolveWithinProject(projectDir, relPath) {
  const resolved = path.resolve(projectDir, relPath);
  const projectRoot = path.resolve(projectDir);
  const normalizedRoot = process.platform === "win32" ? projectRoot.toLowerCase() : projectRoot;
  const normalizedResolved = process.platform === "win32" ? resolved.toLowerCase() : resolved;
  if (normalizedResolved === normalizedRoot || normalizedResolved.startsWith(normalizedRoot + path.sep)) {
    return resolved;
  }
  return null;
}

function _splitList(value) {
  if (Array.isArray(value)) return value.map((item) => String(item || "").trim()).filter(Boolean);
  return String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function _dedupe(list, mapFn = (v) => v) {
  const seen = new Set();
  const out = [];
  for (const item of list || []) {
    const key = mapFn(item);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(item);
  }
  return out;
}

function _hasValue(input, key) {
  if (!input || !Object.prototype.hasOwnProperty.call(input, key)) return false;
  const value = input[key];
  if (value == null) return false;
  if (Array.isArray(value)) return value.length > 0;
  return String(value).trim() !== "";
}

function _normalizeHintSource(value, fallback = "inferred") {
  const source = String(value || "").trim().toLowerCase();
  return VALID_HINT_SOURCES.has(source) ? source : fallback;
}

export function inferIntakeHints(text = "", fallbackMode = "build") {
  const lower = String(text || "").toLowerCase();
  const hints = {};
  const imageNoun = String.raw`(?:image|images|photo|picture|illustration|logo|banner|png|jpg|jpeg|webp|hero image|icon set|icons?)`;
  const imageVerb = String.raw`(?:generate|create|render|draw|design|produce|make)`;
  const imageGenerationRe = new RegExp(
    String.raw`\b${imageVerb}\b[\s\S]{0,80}\b${imageNoun}\b|\b${imageNoun}\b[\s\S]{0,80}\b${imageVerb}\b`,
  );
  const reportNoun = String.raw`(?:report|summary|write[- ]?up|analysis|brief|export)`;
  const reportVerb = String.raw`(?:write|prepare|draft|produce|create|generate|compile|export|deliver)`;
  const reportGenerationRe = new RegExp(
    String.raw`\b${reportVerb}\b[\s\S]{0,80}\b${reportNoun}\b|\b${reportNoun}\b[\s\S]{0,80}\b${reportVerb}\b`,
  );

  if (/\b(why|what|where|how|explain|understand|investigate)\b/.test(lower)) {
    hints.intent_type = "question";
    hints.deliverable_type = "answer";
    hints.output_mode = "auto";
    hints.desired_outputs = ["question_only"];
  } else if (/\b(fix|bug|broken|regression|error|crash|failing)\b/.test(lower)) {
    hints.intent_type = "bugfix";
    hints.deliverable_type = "code";
    hints.output_mode = "auto";
    hints.desired_outputs = ["repo"];
  } else if (reportGenerationRe.test(lower)) {
    hints.intent_type = "report";
    hints.deliverable_type = /\bpdf\b/.test(lower) ? "pdf" : "markdown";
    hints.output_mode = "auto";
    hints.desired_outputs = ["artifact"];
  } else if (imageGenerationRe.test(lower) || /\b(dall-?e|midjourney|stable.?diffusion|image.?gen)\b/.test(lower)) {
    hints.intent_type = "image";
    hints.deliverable_type = "image";
    hints.output_mode = "auto";
    hints.desired_outputs = ["artifact"];
  } else {
    hints.intent_type = "task";
    hints.deliverable_type = fallbackMode === "report" ? "markdown" : (fallbackMode === "image" ? "image" : "code");
    hints.output_mode = "auto";
    hints.desired_outputs = [fallbackMode === "image" || fallbackMode === "report" ? "artifact" : "repo"];
  }

  return hints;
}

function _parseDesiredOutputs(inputValue, inferred = []) {
  const raw = _splitList(inputValue).map((item) => String(item || "").trim().toLowerCase());
  const filtered = _dedupe(raw.filter((item) => VALID_DESIRED_OUTPUTS.has(item)));
  if (filtered.length > 0) return filtered;
  return _dedupe((Array.isArray(inferred) ? inferred : [inferred]).filter((item) => VALID_DESIRED_OUTPUTS.has(item)));
}

export function normalizeIntakeHints(input = {}, { requestText = "", fallbackMode = "build" } = {}) {
  const inferred = inferIntakeHints(requestText, fallbackMode);
  const hasInputIntent = _hasValue(input, "intent_type");
  const tokenIntent = ONESHOT_TOKEN_RE.test(String(requestText || "")) ? "oneshot" : "";
  const intent = String((hasInputIntent ? input.intent_type : tokenIntent) || inferred.intent_type || "").toLowerCase();
  const deliverable = String(input.deliverable_type || inferred.deliverable_type || "").toLowerCase();
  const rawOutput = String(input.output_mode || inferred.output_mode || "").toLowerCase();
  const output = VALID_OUTPUTS.has(rawOutput) ? rawOutput : inferred.output_mode;
  const desiredOutputs = _parseDesiredOutputs(input.desired_outputs || input.output_mode, inferred.desired_outputs || []);
  const inferredOutputMode = String(inferred.output_mode || "auto").toLowerCase();
  const inputOutputMode = String(input.output_mode || "").trim().toLowerCase();
  const legacyExplicitOutputMode = _hasValue(input, "output_mode")
    && inputOutputMode
    && inputOutputMode !== "auto"
    && inputOutputMode !== inferredOutputMode;
  const outputModeSource = _normalizeHintSource(
    input.output_mode_source,
    legacyExplicitOutputMode ? "explicit" : "inferred",
  );
  const deliverableTypeSource = _normalizeHintSource(
    input.deliverable_type_source,
    _hasValue(input, "deliverable_type") ? "explicit" : "inferred",
  );
  const desiredOutputsSource = _normalizeHintSource(
    input.desired_outputs_source,
    (_hasValue(input, "desired_outputs") || legacyExplicitOutputMode) ? "explicit" : "inferred",
  );
  const intentTypeSource = tokenIntent && !hasInputIntent
    ? "explicit"
    : _normalizeHintSource(
      input.intent_type_source,
      (hasInputIntent || tokenIntent) ? "explicit" : "inferred",
    );
  const suspectedFiles = _dedupe(
    _splitList(input.suspected_files)
      .filter(_isSafeHintPath)
      .map(_normPath),
    (v) => v.toLowerCase(),
  );
  const suspectedDirs = _dedupe(
    _splitList(input.suspected_dirs)
      .filter(_isSafeHintPath)
      .map((item) => _normPath(item).replace(/\/+$/, "")),
    (v) => v.toLowerCase(),
  );
  const subtasks = _dedupe(_splitList(input.subtasks).map((item) => item.trim()), (v) => v.toLowerCase());
  const constraints = _dedupe(_splitList(input.constraints).map((item) => item.trim()), (v) => v.toLowerCase());

  return {
    intent_type: VALID_INTENTS.has(intent) ? intent : inferred.intent_type,
    intent_type_source: intentTypeSource,
    deliverable_type: VALID_DELIVERABLES.has(deliverable) ? deliverable : inferred.deliverable_type,
    deliverable_type_source: deliverableTypeSource,
    output_mode: output,
    output_mode_source: outputModeSource,
    desired_outputs: desiredOutputs,
    desired_outputs_source: desiredOutputsSource,
    suspected_files: suspectedFiles.slice(0, 12),
    suspected_dirs: suspectedDirs.slice(0, 8),
    subtasks: subtasks.slice(0, 12),
    constraints: constraints.slice(0, 12),
  };
}

export function getWorkItemIntakeHints(workItem, fallbackMode = "build") {
  let metadata = {};
  try {
    metadata = workItem?.metadata_json ? JSON.parse(workItem.metadata_json) : {};
  } catch {
    metadata = {};
  }
  return normalizeIntakeHints(metadata.intake_hints || {}, {
    requestText: workItem?.description || workItem?.title || "",
    fallbackMode: workItem?.mode || fallbackMode,
  });
}

export function getWorkItemWorkflowConfig(workItem) {
  let metadata = {};
  try {
    metadata = workItem?.metadata_json ? JSON.parse(workItem.metadata_json) : {};
  } catch {
    metadata = {};
  }
  const rawMode = String(metadata.workflow_mode || "").trim().toLowerCase();
  const mode = VALID_WORKFLOW_MODES.has(rawMode) ? rawMode : null;
  return {
    mode,
    iterate: !!metadata.iterate || !!mode,
  };
}

export function buildWorkflowModeBlock(workflowConfig, role = "planner") {
  const mode = String(workflowConfig?.mode || "").trim().toLowerCase();
  if (!mode) return "";

  const shared = {
    bugfix: [
      "Workflow mode is BUGFIX.",
      "Optimize for correctness, regression prevention, and broken-state repair before polish.",
      "Use bounded passes; stop when no meaningful bugfix work remains.",
    ],
    ux: [
      "Workflow mode is UX.",
      "Optimize for clarity, responsiveness, affordance, readability, and visual coherence before cosmetic extras.",
      "Use bounded refinement passes; stop when no meaningful UX improvement remains.",
    ],
    refactor: [
      "Workflow mode is REFACTOR.",
      "Preserve behavior while improving structure, maintainability, readability, and local simplicity.",
      "Use bounded passes; do not broaden into unrelated rewrites.",
    ],
    audit: [
      "Workflow mode is AUDIT.",
      "Optimize for findings, risks, regressions, and evidence before proposing mutation work.",
      "Use bounded passes; stop when additional review would likely be repetitive.",
    ],
    iterate: [
      "Workflow mode is ITERATE.",
      "Use bounded improvement passes instead of trying to perfect everything in one sweep.",
      "Each pass should narrow the next objective based on findings, not repeat the same broad search.",
    ],
  }[mode] || [];

  const roleSpecific = {
    researcher: {
      bugfix: ["Focus your brief on likely fault lines, regressions, failing surfaces, and verification targets."],
      ux: ["Focus your brief on user-visible friction, inconsistent surfaces, responsiveness, readability, and interaction issues."],
      refactor: ["Focus your brief on hotspots, code smells, coupling, duplication, and safe refactor seams."],
      audit: ["Focus your brief on concrete findings with evidence and likely severity, not implementation ideas."],
      iterate: ["Identify the highest-value first pass and the likely follow-up passes if the first pass succeeds."],
    },
    planner: {
      bugfix: ["Prefer smaller, correctness-first tasks and avoid splitting fixes in ways that hide regressions."],
      ux: ["Prefer a small number of coherent UX refinement tasks over many tiny cosmetic tasks."],
      refactor: ["Prefer scoped structural tasks with explicit safety boundaries and clear success criteria."],
      audit: ["Prefer analysis/review tasks and avoid inventing repo-edit tasks unless the request explicitly asks for fixes."],
      iterate: ["Plan work in bounded batches that can be reassessed between passes instead of one giant all-in plan."],
    },
    assessor: {
      bugfix: ["Be strict about correctness and regressions; passing requires the broken behavior to be resolved, not just improved."],
      ux: ["Assess usability and polish pragmatically; fail only for meaningful UX problems, not taste-only differences."],
      refactor: ["Be strict about behavioral preservation, scope discipline, and maintainability improvements actually landing."],
      audit: ["Prioritize findings quality and evidence; do not invent mutation requirements when the task is analysis-first."],
      iterate: ["When work is improved but not fully exhausted, prefer precise remaining findings that can guide the next bounded pass."],
    },
  }[role]?.[mode] || [];

  return [
    "WORKFLOW MODE (user-selected - treat as a strong execution preference):",
    `- mode: ${mode}`,
    ...shared.map((line) => `- ${line}`),
    ...roleSpecific.map((line) => `- ${line}`),
    "",
  ].join("\n");
}

export function buildIntakeHintsBlock(hints) {
  if (!hints) return "";
  const lines = [
    `INTAKE HINTS (treat as user-provided routing bias, not guaranteed truth):`,
    `- intent_type: ${hints.intent_type || "unknown"}`,
    `- deliverable_type: ${hints.deliverable_type || "unknown"}`,
    `- output_mode: ${hints.output_mode || "unknown"}`,
    `- desired_outputs: ${(Array.isArray(hints.desired_outputs) && hints.desired_outputs.length > 0) ? hints.desired_outputs.join(", ") : "unknown"}`,
  ];
  if (hints.suspected_files?.length) {
    lines.push(`- suspected_files:`);
    for (const file of hints.suspected_files) lines.push(`  - ${file}`);
  }
  if (hints.suspected_dirs?.length) {
    lines.push(`- suspected_dirs:`);
    for (const dir of hints.suspected_dirs) lines.push(`  - ${dir}`);
  }
  if (hints.subtasks?.length) {
    lines.push(`- subtasks / must-haves:`);
    for (const item of hints.subtasks) lines.push(`  - ${item}`);
  }
  if (hints.constraints?.length) {
    lines.push(`- constraints:`);
    for (const item of hints.constraints) lines.push(`  - ${item}`);
  }
  return lines.join("\n");
}

function _hasMaterialResearchPreloadHints(hints) {
  if (!hints) return false;
  const listFields = ["suspected_files", "suspected_dirs", "subtasks", "constraints"];
  if (listFields.some((field) => Array.isArray(hints[field]) && hints[field].length > 0)) return true;

  // "task" is the seeded default from inferIntakeHints/orchestrator intake; keep
  // this in sync if the default intent changes.
  const intent = String(hints.intent_type || "").trim().toLowerCase();
  if (intent && intent !== "task") return true;

  const outputMode = String(hints.output_mode || "").trim().toLowerCase();
  if (outputMode && outputMode !== "auto") return true;

  const deliverable = String(hints.deliverable_type || "").trim().toLowerCase();
  if (deliverable && !["code", "markdown", "image"].includes(deliverable)) return true;

  const desiredOutputs = Array.isArray(hints.desired_outputs)
    ? hints.desired_outputs.map((item) => String(item || "").trim().toLowerCase()).filter(Boolean)
    : [];
  return desiredOutputs.some((item) => !["repo", "artifact"].includes(item));
}

function _directoryTree(dir, maxDepth = 2) {
  function walk(current, depth) {
    if (depth > maxDepth) return [];
    let entries = [];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      return [];
    }
    const lines = [];
    for (const entry of entries.slice(0, 40)) {
      if (entry.name === ".git" || entry.name === "node_modules" || entry.name === ".posse-worktrees" || entry.name === ".posse-test-suites") continue;
      const prefix = "  ".repeat(depth);
      lines.push(`${prefix}${entry.isDirectory() ? "[D]" : "[F]"} ${entry.name}`);
      if (entry.isDirectory()) {
        lines.push(...walk(path.join(current, entry.name), depth + 1));
      }
    }
    return lines;
  }
  return walk(dir, 0).join("\n");
}

function _readFilePreview(projectDir, relPath) {
  const fullPath = _resolveWithinProject(projectDir, relPath);
  if (!fullPath) return null;
  try {
    const stat = fs.statSync(fullPath);
    if (!stat.isFile() || stat.size > 40000) return null;
    const raw = fs.readFileSync(fullPath, "utf-8");
    return raw.split("\n").slice(0, 160).map((line, idx) => `${String(idx + 1).padStart(4)}\t${line}`).join("\n");
  } catch {
    return null;
  }
}

function _normalizeHintPath(value) {
  return String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").toLowerCase();
}

// atlasCoveredFiles: lowercased repo-relative paths whose content the ATLAS
// prefetch already supplied (see collectAtlasCoveredFiles in atlas-context.js).
// Hinted files ATLAS already covers get a one-line pointer instead of a body
// preview so the same content is not paid for twice in one prompt.
export function buildResearchIntakePreload(projectDir, hints, { atlasCoveredFiles = null } = {}) {
  if (!hints) return "";
  const safeHints = normalizeIntakeHints(hints);
  if (!_hasMaterialResearchPreloadHints(safeHints)) return "";
  const sections = [];
  const hintBlock = buildIntakeHintsBlock(safeHints);
  if (hintBlock) sections.push(hintBlock);

  for (const dir of (safeHints.suspected_dirs || []).slice(0, 3)) {
    const fullDir = _resolveWithinProject(projectDir, dir);
    if (!fullDir) continue;
    if (!fs.existsSync(fullDir) || !fs.statSync(fullDir).isDirectory()) continue;
    const tree = _directoryTree(fullDir, 2);
    if (tree) {
      sections.push(`HINTED DIRECTORY TREE: ${dir}\n${tree}`);
    }
  }

  for (const file of (safeHints.suspected_files || []).slice(0, 3)) {
    if (atlasCoveredFiles?.has?.(_normalizeHintPath(file))) {
      sections.push(`HINTED FILE (already covered by ATLAS prefetch context): ${file}`);
      continue;
    }
    const preview = _readFilePreview(projectDir, file);
    if (preview) sections.push(`HINTED FILE PREVIEW: ${file}\n${preview}`);
  }

  return sections.join("\n\n");
}
