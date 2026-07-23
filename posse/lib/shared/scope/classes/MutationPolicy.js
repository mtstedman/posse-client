import { Scope } from "./Scope.js";
import { validateScopedPath } from "../functions/validation.js";
import path from "path";
import { agentHiddenReadablePathReason } from "../functions/agent-hidden-paths.js";

const BLOCKED_ALWAYS = /^\s*(rm\s+-rf\s+[\/~]|shutdown|reboot|mkfs|dd\s|format\s|del\s+\/[sq]|:(){ :|curl\s.*\|\s*sh|wget\s.*\|\s*sh)/i;
const BLOCKED_MUTATING_COMMAND = new RegExp(
  [
    /rm\b/, /mv\b/, /cp\b/, /mkdir\b/, /touch\b/, /chmod\b/, /chown\b/,
    /sed\s+-i/, /tee\b/,
    />[^&]/, />>/,
    /git\s+(push|commit|add|reset|checkout|clean|stash|merge|rebase|branch\s+-[dDmM]|tag\s+-[da])/,
    /npm\s+(install|uninstall|publish|link|pack)/, /yarn\s+(add|remove)/,
    /pip\s+install/, /pip\s+uninstall/,
  ].map((r) => r.source).join("|"),
  "i",
);
const BLOCKED_INLINE_SCRIPT_WRITE = /\b(?:node\s+-e|python3?\s+-c)\b[\s\S]*(?:writeFile|appendFile|createWriteStream|fs\.(?:rm|unlink|mkdir|rename|copyFile)|open\s*\(|Path\s*\([^)]*\)\.write|shutil\.|os\.(?:remove|unlink|mkdir|rmdir|rename))/i;
const READONLY_BASH_ALLOWLIST = /^\s*(npm\s+test|npm\s+run|node\s+--test\b|npx\s+(?:tsc|eslint|prettier|jest|vitest|mocha)\b|pnpm\s+(test|run|exec)|yarn\s+(test|run)|tsc\s|eslint\s|prettier\s|jest\s|vitest\s|mocha\s|pip\s+show|python3?\s+-m\s+(?:pytest|unittest|build)\b|pytest\s|ruff\s|mypy\s|flake8\s|black\s+--check|php\s|composer\s+(test|run)|phpunit\s|cargo\s+(test|check|build|clippy)|rustfmt\s+--check|go\s+(test|vet|build)|make\s|cmake\s|gradle\s|mvn\s|dotnet\s+(test|build)|cat\s|head\s|tail\s|ls\s|find\s|wc\s|file\s|du\s|diff\s|sort\s|uniq\s|grep\s|rg\s|git\s+diff|git\s+log|git\s+status|git\s+show|echo\s|pwd|whoami)/i;
const PHP_SYNTAX_LINT_FLAG_RE = /(?:^|\s)(?:-l|--syntax-check)(?:\s|$)/i;
const FIND_MUTATING_FLAGS = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);
const GO_OUTPUT_FLAGS = new Set(["-o", "-coverprofile", "-cpuprofile", "-memprofile", "-mutexprofile", "-blockprofile", "-trace", "-outputdir"]);
const CARGO_OUTPUT_FLAGS = new Set(["--target-dir", "--out-dir"]);
const DOTNET_OUTPUT_FLAGS = new Set(["-o", "--output"]);
const TSC_OUTPUT_FLAGS = new Set(["--outdir", "--outfile", "--tsbuildinfofile"]);
const TEST_OUTPUT_FLAGS = new Set(["--junitxml", "--html", "--self-contained-html", "--cov-report", "--basetemp", "--result-log", "--report-log"]);
const NODE_TEST_MUTATING_FLAGS = new Set(["--test-reporter-destination", "--test-update-snapshots"]);
const PYTHON_BUILD_OUTPUT_FLAGS = new Set(["--outdir"]);
const SORT_OUTPUT_FLAGS = new Set(["-o", "--output"]);
const FIXER_FLAGS = new Set(["--fix", "--write"]);
const SENSITIVE_ENV_BASENAME_RE = /^\.env(?:\.|$)/i;
const SHELL_VARIABLE_EXPANSION_RE = /(?:%[A-Za-z_][A-Za-z0-9_]*%|\$(?:\{[A-Za-z_][A-Za-z0-9_]*\}|[A-Za-z_][A-Za-z0-9_]*))/;
const INFERRED_DELETE_FILE_EXTENSIONS = new Set([
  "bmp", "c", "cc", "cfg", "conf", "cpp", "cs", "css", "csv", "cts",
  "cxx", "env", "gif", "go", "h", "hpp", "html", "ini", "java", "jpeg",
  "jpg", "js", "json", "jsx", "lock", "log", "mjs", "mts", "php", "png",
  "py", "pyc", "pyo", "rb", "rs", "scss", "sh", "sql", "svg", "toml",
  "ts", "tsx", "txt", "xml", "yaml", "yml",
]);

function normalizeList(values = []) {
  return [...new Set((Array.isArray(values) ? values : []).filter(Boolean).map((value) => String(value)))];
}

function normalizeRoots(values = [], cwd = process.cwd()) {
  const roots = [];
  for (const value of Array.isArray(values) ? values : []) {
    const raw = String(value || "").trim();
    if (!raw) continue;
    if (raw === "*") {
      roots.push("*");
      continue;
    }
    const relative = path.isAbsolute(raw) ? path.relative(cwd, raw) : raw;
    const normalized = normalizeRel(relative).replace(/\/+$/, "");
    if (normalized) roots.push(normalized);
  }
  return [...new Set(roots)];
}

function isPhpSyntaxLintCommand(command) {
  const text = String(command || "");
  return /^\s*php(?:\s|$)/i.test(text) && PHP_SYNTAX_LINT_FLAG_RE.test(text);
}

function shellWords(command) {
  const tokens = [];
  let current = "";
  let quote = null;
  for (let i = 0; i < command.length; i += 1) {
    const ch = command[i];
    if (ch === "\\" && quote !== "'") {
      const next = command[i + 1];
      if (next === "'" || next === '"' || next === "\\" || (next !== undefined && /\s/.test(next))) {
        current += next;
        i += 1;
      } else {
        current += ch;
      }
      continue;
    }
    if (quote) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current) {
        tokens.push(current);
        current = "";
      }
      continue;
    }
    current += ch;
  }
  if (current) tokens.push(current);
  return tokens;
}

function tokenFlagName(token) {
  const text = String(token || "").toLowerCase();
  if (!text.startsWith("-")) return "";
  const equalsIndex = text.indexOf("=");
  if (equalsIndex > 0) return text.slice(0, equalsIndex);
  if (/^-[A-Za-z][^A-Za-z]?/.test(text)) return text.length > 2 ? text.slice(0, 2) : text;
  return text;
}

function hasFlag(tokens, flags) {
  return tokens.some((token) => flags.has(tokenFlagName(token)) || flags.has(String(token || "").toLowerCase()));
}

function blockedBashArgumentReason(command) {
  const tokens = shellWords(command);
  if (tokens.length === 0) return null;
  const commandName = shellCommandName(tokens[0]);
  const lower = tokens.map((token) => String(token || "").toLowerCase());
  const delegatedTool = commandName === "npx"
    ? { name: lower[1], args: lower.slice(2) }
    : (commandName === "pnpm" && lower[1] === "exec")
      ? { name: lower[2], args: lower.slice(3) }
      : null;
  if (delegatedTool?.name && (delegatedTool.name === "eslint" || delegatedTool.name === "prettier" || delegatedTool.name === "ruff") && hasFlag(delegatedTool.args, FIXER_FLAGS)) {
    return `${delegatedTool.name} fixer flag`;
  }
  if (commandName === "find" && lower.some((token) => FIND_MUTATING_FLAGS.has(tokenFlagName(token)) || FIND_MUTATING_FLAGS.has(token))) {
    return "find mutating action";
  }
  if (commandName === "go" && (lower[1] === "build" || lower[1] === "test") && hasFlag(lower.slice(2), GO_OUTPUT_FLAGS)) {
    return "go explicit output path";
  }
  if (commandName === "cargo" && hasFlag(lower.slice(2), CARGO_OUTPUT_FLAGS)) {
    return "cargo explicit output directory";
  }
  if (commandName === "dotnet" && (lower[1] === "build" || lower[1] === "test") && hasFlag(lower.slice(2), DOTNET_OUTPUT_FLAGS)) {
    return "dotnet explicit output directory";
  }
  if ((commandName === "tsc" || commandName === "prettier") && hasFlag(lower.slice(1), TSC_OUTPUT_FLAGS)) {
    return `${commandName} explicit output path`;
  }
  if ((commandName === "eslint" || commandName === "prettier" || commandName === "ruff") && hasFlag(lower.slice(1), FIXER_FLAGS)) {
    return `${commandName} fixer flag`;
  }
  if ((commandName === "pytest" || commandName === "ruff" || commandName === "mypy" || commandName === "flake8") && hasFlag(lower.slice(1), TEST_OUTPUT_FLAGS)) {
    return `${commandName} explicit output path`;
  }
  if (commandName === "node" && lower[1] === "--test" && hasFlag(lower.slice(2), NODE_TEST_MUTATING_FLAGS)) {
    return "node test mutating output flag";
  }
  if ((commandName === "python" || commandName === "python3") && lower[1] === "-m") {
    if (lower[2] === "pytest" && hasFlag(lower.slice(3), TEST_OUTPUT_FLAGS)) {
      return "pytest explicit output path";
    }
    if (lower[2] === "build" && hasFlag(lower.slice(3), PYTHON_BUILD_OUTPUT_FLAGS)) {
      return "python build explicit output directory";
    }
  }
  if (commandName === "sort" && hasFlag(lower.slice(1), SORT_OUTPUT_FLAGS)) {
    return "sort explicit output path";
  }
  return null;
}

function normalizeRel(value) {
  const normalized = String(value || "").trim().replace(/\\/g, "/").replace(/^\.\//, "");
  return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function looksLikeInferredDeletePath(value) {
  const candidate = String(value || "").replace(/\\/g, "/").trim().replace(/^`|`$/g, "");
  if (!candidate || /[\s()[\]{}=;]/.test(candidate)) return false;
  if (candidate.includes("/")) return true;
  const basename = candidate.split("/").pop() || "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return false;
  const ext = basename.slice(dot + 1).toLowerCase();
  return INFERRED_DELETE_FILE_EXTENSIONS.has(ext);
}

function looksLikeUnquotedInferredDeletePath(value) {
  const candidate = String(value || "").replace(/\\/g, "/").trim();
  if (!looksLikeInferredDeletePath(candidate)) return false;
  if (!candidate.includes("/")) return true;
  // A slash alone is not enough to make ordinary prose a filesystem path.
  // For example, "remove leading/trailing hyphens" must not infer a deletion
  // target named "leading/trailing". Extensionless directory targets remain
  // supported when quoted or supplied explicitly through files_to_delete.
  const basename = candidate.split("/").filter(Boolean).at(-1) || "";
  const dot = basename.lastIndexOf(".");
  if (dot <= 0 || dot === basename.length - 1) return false;
  return INFERRED_DELETE_FILE_EXTENSIONS.has(basename.slice(dot + 1).toLowerCase());
}

function lineBoundsAt(text, index) {
  const start = Math.max(0, text.lastIndexOf("\n", Math.max(0, index - 1)) + 1);
  const endIndex = text.indexOf("\n", index);
  const end = endIndex === -1 ? text.length : endIndex;
  return { start, end, line: text.slice(start, end) };
}

function isDeleteContextForCandidate(text, index, matchText) {
  const { start, end, line } = lineBoundsAt(text, index);
  const before = text.slice(start, index).toLowerCase();
  const after = text.slice(index + String(matchText || "").length, end).toLowerCase();
  const strippedLine = line.trim().replace(/^[-*]\s*/, "").trim();

  if (/\b(?:delete|remove|drop|eliminate|prune|cleanup|clean up)\b/.test(before)) return true;
  if (/^(?:is|are|should be|must be|needs to be|need to be)\s+(?:deleted|removed|dropped|eliminated|pruned|absent)\b/.test(after.trim())) {
    return true;
  }
  return /^`?[^`\s]+`?$/.test(strippedLine) && isRemovalTask(null, { task_spec: text });
}

function relFromCandidate(cwd, filePath) {
  const raw = String(filePath || "");
  const relative = path.isAbsolute(raw) ? path.relative(cwd, raw) : raw;
  return normalizeRel(relative);
}

function isCwdOrDescendantRel(rel) {
  return rel === "" || rel === "." || (
    !rel.startsWith("../")
    && rel !== ".."
    && !path.isAbsolute(rel)
  );
}

function matchesCreateRoot(rel, roots = []) {
  if (!isCwdOrDescendantRel(rel)) return false;
  return roots.some((root) => {
    if (root === "*") return isCwdOrDescendantRel(rel);
    return rel === root || rel.startsWith(`${root}/`);
  });
}

function normalizeAbs(value) {
  const resolved = path.resolve(String(value || ""));
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
}

function isSystemOwnedExternalResourceRoot(absPath, allowedCategories = new Set(["artifacts", "workspace"])) {
  const parts = normalizeRel(absPath).split("/").filter(Boolean);
  const posseIndex = parts.lastIndexOf(".posse");
  if (posseIndex < 0) return false;
  if (parts[posseIndex + 1] !== "resources") return false;
  const category = parts[posseIndex + 2];
  if (!allowedCategories.has(category)) return false;
  const scopeId = parts[posseIndex + 3] || "";
  return /^(?:wi-|run-)[^/]+$/i.test(scopeId);
}

function normalizeExternalResourceRoots(values = [], cwd = process.cwd(), allowedCategories = new Set(["artifacts", "workspace"])) {
  const roots = [];
  for (const value of Array.isArray(values) ? values : []) {
    if (!value) continue;
    const raw = String(value).trim();
    if (!path.isAbsolute(raw)) continue;
    const rel = relFromCandidate(cwd, raw);
    if (isCwdOrDescendantRel(rel)) continue;
    const abs = normalizeAbs(raw);
    if (!isSystemOwnedExternalResourceRoot(abs, allowedCategories)) continue;
    roots.push(abs);
  }
  return [...new Set(roots)];
}

function matchesExternalRoot(filePath, roots = []) {
  if (!roots.length) return false;
  const abs = normalizeAbs(filePath);
  return roots.some((root) => {
    const rel = path.relative(root, abs);
    return rel === "" || (
      !rel.startsWith("..")
      && rel !== ".."
      && !path.isAbsolute(rel)
    );
  });
}

// Split a command line into the chained subcommands the allowlist must vet
// individually (each side of a `;`, `&&`, `||`, or `|`). This MUST be
// quote/escape aware: a naive `.split(/.../)` on the raw string also breaks on
// operators that live INSIDE a quoted argument — most importantly the `\|`
// alternation in a read-only `grep -n "a\|b\|c" file`, which a real shell treats
// as one command but the naive split shredded into bogus pieces ("b\", "c\")
// that fail the allowlist, so legitimate greps were blocked before they ran.
// Operators are separators only at the top level (outside single/double quotes
// and not backslash-escaped); a real pipe to a dangerous command stays outside
// quotes and is still split out for vetting.
export function splitShellSubcommands(command) {
  const text = String(command || "");
  const segments = [];
  let current = "";
  let quote = null; // "'" or '"' while inside a quoted span
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      current += ch;
      // Inside double quotes a backslash escapes the next char (so an escaped
      // closing quote does not end the span); single quotes take everything
      // literally, including backslashes.
      if (ch === "\\" && quote === "\"" && i + 1 < text.length) current += text[++i];
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === "'" || ch === "\"") { quote = ch; current += ch; continue; }
    if (ch === "\\" && i + 1 < text.length) { current += ch + text[++i]; continue; }
    if (ch === ";") { segments.push(current); current = ""; continue; }
    if (ch === "&" && text[i + 1] === "&") { segments.push(current); current = ""; i++; continue; }
    if (ch === "|" && text[i + 1] === "|") { segments.push(current); current = ""; i++; continue; }
    if (ch === "|") { segments.push(current); current = ""; continue; }
    current += ch;
  }
  segments.push(current);
  return segments.map((segment) => segment.trim()).filter(Boolean);
}

export function isSensitiveEnvCommand(command) {
  const text = String(command || "");
  const parts = text.split(/\s+/).filter(Boolean);
  if (parts.length === 0) return false;
  return parts.some((part) => {
    const cleaned = part.replace(/^['"]|['"]$/g, "").replace(/\\/g, "/");
    return cleaned.split("/").some((segment) => SENSITIVE_ENV_BASENAME_RE.test(segment));
  });
}

function shellCommandName(commandToken = "") {
  return String(commandToken || "").trim().replace(/\\/g, "/").split("/").pop().toLowerCase();
}

function cleanShellPathToken(value = "") {
  return String(value || "")
    .trim()
    .replace(/^['"]|['"]$/g, "")
    .replace(/\\/g, "/")
    .replace(/^[,]+|[,]+$/g, "");
}

function shellPathTokenCandidates(token = "") {
  const cleaned = cleanShellPathToken(token);
  const candidates = [cleaned];
  const colonIndex = cleaned.lastIndexOf(":");
  if (colonIndex >= 0 && colonIndex < cleaned.length - 1) {
    candidates.push(cleaned.slice(colonIndex + 1));
  }
  return candidates.filter(Boolean);
}

export function isAgentHiddenReadCommand(command) {
  const subcommands = splitShellSubcommands(command);
  for (const sub of subcommands) {
    const parts = sub.split(/\s+/).filter(Boolean);
    if (parts.length === 0) continue;
    const commandName = shellCommandName(parts[0]);
    let skippedSearchPattern = false;
    for (const part of parts.slice(1)) {
      const cleaned = cleanShellPathToken(part);
      if (!cleaned || cleaned.startsWith("-")) continue;
      const hidden = shellPathTokenCandidates(cleaned).some((candidate) => agentHiddenReadablePathReason(candidate));
      const canTreatAsSearchPattern = (commandName === "rg" || commandName === "grep" || commandName === "findstr")
        && !skippedSearchPattern
        && !/[/*?:]/.test(cleaned);
      if (canTreatAsSearchPattern) {
        skippedSearchPattern = true;
        continue;
      }
      if (hidden) {
        return true;
      }
      if (commandName === "rg" || commandName === "grep" || commandName === "findstr") skippedSearchPattern = true;
    }
  }
  return false;
}

export function agentHiddenReadCommandError() {
  return "Error: Access to .gitignore is blocked. Use documented ignore examples or explicit task context instead.";
}

export function isRemovalTask(job, payload) {
  const text = [
    job?.title,
    payload?.task_spec,
    payload?.fix_instructions,
    ...(Array.isArray(payload?.success_criteria) ? payload.success_criteria : []),
    ...(Array.isArray(payload?.assessor_feedback) ? payload.assessor_feedback : []),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return /\b(delete|remove|drop|eliminate|clean up|cleanup|prune)\b/.test(text);
}

export function isFilePlacementTask(job, payload) {
  const text = [
    job?.title,
    payload?.task_spec,
    payload?.fix_instructions,
    ...(Array.isArray(payload?.success_criteria) ? payload.success_criteria : []),
    ...(Array.isArray(payload?.assessor_feedback) ? payload.assessor_feedback : []),
  ]
    .filter(Boolean)
    .join("\n")
    .toLowerCase();
  return /\b(move|copy|place|install|promote|put|publish|relocate)\b/.test(text);
}

export function inferDeletionTargets(job, payload) {
  if (!isRemovalTask(job, payload)) return [];
  const sources = [
    job?.title || "",
    payload?.task_spec || "",
    payload?.fix_instructions || "",
    ...(Array.isArray(payload?.success_criteria) ? payload.success_criteria : []),
    ...(Array.isArray(payload?.assessor_feedback) ? payload.assessor_feedback : []),
  ];
  const found = new Set();
  const addCandidate = (value, source, index, matchText = value) => {
    const candidate = String(value || "").replace(/\\/g, "/").trim().replace(/^`|`$/g, "");
    if (!candidate) return;
    if (!looksLikeInferredDeletePath(candidate)) return;
    if (!isDeleteContextForCandidate(String(source || ""), index, matchText)) return;
    const err = validateScopedPath(candidate, "delete_target");
    if (!err) found.add(candidate);
  };

  for (const source of sources) {
    const text = String(source || "");
    for (const match of text.matchAll(/`([^`\r\n]+)`/g)) {
      addCandidate(match[1], text, match.index ?? 0, match[0]);
    }
    for (const match of text.matchAll(/\b([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+|[A-Za-z0-9_.-]+\.[A-Za-z0-9_.-]+)\b/g)) {
      const candidate = match[1];
      const following = text.slice(match.index + match[0].length).trimStart();
      if (/^(?:e\.g|i\.e)$/i.test(candidate)) continue;
      if (!looksLikeUnquotedInferredDeletePath(candidate)) continue;
      if (!candidate.includes("/") && /^(?:files?|apps?|projects?|backends?|frontends?|services?|stacks?|runtimes?|dependencies|packages?)\b/i.test(following)) {
        continue;
      }
      addCandidate(match[1], text, match.index ?? 0, match[0]);
    }
  }

  return [...found];
}

export function isGeneratedArtifactPath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/").trim().replace(/^\.\//, "");
  if (validateScopedPath(normalized, "generated_artifact") != null) return false;
  const parts = normalized.toLowerCase().split("/").filter(Boolean);
  if (parts.some((part) =>
    part === "__pycache__"
    || part === ".pytest_cache"
    || part === ".mypy_cache"
    || part === ".ruff_cache"
  )) {
    return true;
  }
  const base = parts.at(-1) || "";
  return base === ".coverage"
    || base.startsWith(".coverage.")
    || base.endsWith(".pyc")
    || base.endsWith(".pyo");
}

export function isGeneratedArtifactDirectoryPath(filePath) {
  const normalized = String(filePath || "").replace(/\\/g, "/").trim().replace(/^\.\//, "").replace(/\/+$/, "");
  if (validateScopedPath(normalized, "generated_artifact_dir") != null) return false;
  const base = normalized.toLowerCase().split("/").filter(Boolean).at(-1) || "";
  return base === "__pycache__"
    || base === ".pytest_cache"
    || base === ".mypy_cache"
    || base === ".ruff_cache"
    || base === ".cache";
}

export function inferGeneratedArtifactDeletionTargets(job, payload) {
  return inferDeletionTargets(job, payload)
    .filter((target) => isGeneratedArtifactPath(target) && !isGeneratedArtifactDirectoryPath(target));
}

export function scopedDeleteTargets(job, payload) {
  const explicit = [
    ...(payload?.files_to_delete || []),
  ].map((file) => String(file || "").replace(/\\/g, "/")).filter(Boolean);
  const inferred = inferDeletionTargets(job, payload)
    .filter((target) => !isGeneratedArtifactDirectoryPath(target));
  return [...new Set([...explicit, ...inferred])];
}

export class MutationPolicy {
  constructor({ scope, cwd = process.cwd() } = {}) {
    const rawScope = scope instanceof Scope ? null : (scope || {});
    this.scope = scope instanceof Scope ? scope : new Scope(scope || {});
    this.cwd = path.resolve(cwd);
    const readRoots = rawScope?.readRoots || rawScope?.read_roots || rawScope?.inputRoots || rawScope?.input_roots || [];
    this.readRoots = Object.freeze(normalizeRoots(readRoots, this.cwd));
    this.externalCreateRoots = Object.freeze(normalizeExternalResourceRoots(
      rawScope?.createRoots || rawScope?.create_roots || [],
      this.cwd,
      new Set(["artifacts", "workspace"]),
    ));
    this.externalReadRoots = Object.freeze(normalizeExternalResourceRoots(
      readRoots,
      this.cwd,
      new Set(["artifacts", "workspace", "inputs"]),
    ));
  }

  static fromJob(job = {}, payload = null, { cwd = process.cwd() } = {}) {
    const resolvedPayload = payload ?? job?.payload_json ?? job ?? {};
    return new MutationPolicy({
      scope: Scope.fromPayload(resolvedPayload, { cwd }),
      cwd,
    });
  }

  static fromScopeSpec(scope = {}, { cwd = process.cwd() } = {}) {
    return new MutationPolicy({
      scope: {
        modifyFiles: scope?.modifyFiles || scope?.files_to_modify || [],
        createFiles: scope?.createFiles || scope?.files_to_create || [],
        createRoots: scope?.createRoots || scope?.create_roots || [],
        deleteFiles: scope?.deleteFiles || scope?.files_to_delete || [],
        readRoots: scope?.readRoots || scope?.read_roots || scope?.inputRoots || scope?.input_roots || [],
        cwd,
      },
      cwd,
    });
  }

  isRemovalTask(job, payload) {
    return isRemovalTask(job, payload);
  }

  isFilePlacementTask(job, payload) {
    return isFilePlacementTask(job, payload);
  }

  inferDeletionTargets(job, payload) {
    return inferDeletionTargets(job, payload);
  }

  inferGeneratedArtifactDeletionTargets(job, payload) {
    return inferGeneratedArtifactDeletionTargets(job, payload);
  }

  detectsOutOfScope(filesChanged = []) {
    const changed = normalizeList(filesChanged);
    return changed.filter((filePath) => !this.scope.contains(filePath));
  }

  // Note: canEdit and canCreate deliberately accept entries from BOTH
  // modifyFiles and createFiles — a file declared for creation may need a
  // follow-up edit in the same job, and vice versa. Do not assume the two
  // lists are enforced as semantically distinct permissions.
  canEdit(filePath) {
    const rel = relFromCandidate(this.cwd, filePath);
    return this.scope.modifyFiles.includes(rel)
      || this.scope.createFiles.includes(rel)
      || matchesCreateRoot(rel, this.scope.createRoots)
      || matchesExternalRoot(filePath, this.externalCreateRoots);
  }

  canCreate(filePath) {
    const rel = relFromCandidate(this.cwd, filePath);
    return this.scope.createFiles.includes(rel)
      || this.scope.modifyFiles.includes(rel)
      || matchesCreateRoot(rel, this.scope.createRoots)
      || matchesExternalRoot(filePath, this.externalCreateRoots);
  }

  canDelete(filePath) {
    const rel = relFromCandidate(this.cwd, filePath);
    return this.scope.deleteFiles.includes(rel);
  }

  isWithinScopeRoot(filePath) {
    const rel = relFromCandidate(this.cwd, filePath);
    return matchesCreateRoot(rel, this.scope.createRoots)
      || matchesCreateRoot(rel, this.readRoots)
      || matchesExternalRoot(filePath, this.externalCreateRoots)
      || matchesExternalRoot(filePath, this.externalReadRoots);
  }

  toToolkitPredicates() {
    return {
      canEdit: (absPath) => this.canEdit(absPath),
      canCreate: (absPath) => this.canCreate(absPath),
      canDelete: (absPath) => this.canDelete(absPath),
      isWithinScopeRoot: (absPath) => this.isWithinScopeRoot(absPath),
      hasScope: !this.scope.isEmpty() || this.readRoots.length > 0 || this.externalReadRoots.length > 0,
      policy: this,
    };
  }

  // Bash is read-only by design regardless of the caller's write grant: the
  // rejection messages steer mutations to write_file/edit_file, and a
  // regression test pins that writes stay blocked. No options are accepted so
  // callers can't be misled into expecting an allowWrite knob to work.
  authorizeBash(command) {
    const cmd = String(command || "");
    if (!cmd || typeof command !== "string") {
      return { ok: false, error: "Error: No command provided." };
    }
    if (isSensitiveEnvCommand(cmd)) {
      return { ok: false, error: "Error: Access to .env files is blocked. Use documented config examples or code paths instead." };
    }
    if (isAgentHiddenReadCommand(cmd)) {
      return { ok: false, error: agentHiddenReadCommandError() };
    }
    if (/\$\(|`/.test(cmd)) {
      return { ok: false, error: `Error: Subshell expressions ($() and backticks) are not allowed in sandboxed bash: ${cmd.slice(0, 100)}` };
    }
    if (SHELL_VARIABLE_EXPANSION_RE.test(cmd)) {
      return { ok: false, error: `Error: Shell variable expansion is not allowed in sandboxed bash: ${cmd.slice(0, 100)}` };
    }
    const subcommands = splitShellSubcommands(cmd);
    for (const sub of subcommands) {
      if (BLOCKED_ALWAYS.test(sub)) {
        return { ok: false, error: `Error: Command blocked by safety filter: ${sub.slice(0, 100)}` };
      }
    }
    if (BLOCKED_MUTATING_COMMAND.test(cmd) || BLOCKED_INLINE_SCRIPT_WRITE.test(cmd)) {
      return { ok: false, error: `Error: Mutating command blocked - bash is limited to read-only inspection and test/build runners. Use write_file/edit_file or scoped file tools for workspace changes: ${cmd.slice(0, 100)}` };
    }

    for (const sub of subcommands) {
      const blockedArgReason = blockedBashArgumentReason(sub);
      if (blockedArgReason) {
        return { ok: false, error: `Error: Mutating bash argument blocked (${blockedArgReason}) - bash is limited to read-only inspection and test/build runners. Use scoped file tools for workspace changes: ${sub.slice(0, 100)}` };
      }
      if (isPhpSyntaxLintCommand(sub)) {
        return { ok: false, error: "Error: PHP syntax lint must use run_scoped_checks with checks:[\"lint\"] for the declared scope instead of bash/php -l." };
      }
      if (!READONLY_BASH_ALLOWLIST.test(sub)) {
        return { ok: false, error: `Error: Command not in allowlist - bash is restricted to test/build/lint runners and read-only utilities. File writes must go through write_file/edit_file: ${sub.slice(0, 100)}` };
      }
    }
    return { ok: true, subcommands };
  }

  scopedDeleteTargets(jobOrPayload = {}, payloadMaybe = null) {
    if (payloadMaybe != null) {
      const explicit = normalizeList(payloadMaybe?.files_to_delete || []);
      const inferred = this.inferDeletionTargets(jobOrPayload, payloadMaybe)
        .filter((target) => !isGeneratedArtifactDirectoryPath(target));
      return [...new Set([...explicit, ...inferred])];
    }
    const payload = jobOrPayload?.payload_json || jobOrPayload;
    const inferred = this.inferDeletionTargets(jobOrPayload, payload)
      .filter((target) => !isGeneratedArtifactDirectoryPath(target));
    const explicit = normalizeList(payload?.files_to_delete || []);
    return [...new Set([...explicit, ...inferred])];
  }

  validateCommit({ filesCommitted = [], filesReverted = [] } = {}) {
    const committed = normalizeList(filesCommitted);
    const reverted = normalizeList(filesReverted);
    const outOfScopeCommitted = this.detectsOutOfScope(committed);
    const outOfScopeReverted = this.detectsOutOfScope(reverted);
    return {
      valid: outOfScopeCommitted.length === 0 && outOfScopeReverted.length === 0,
      outOfScopeCommitted,
      outOfScopeReverted,
    };
  }
}
