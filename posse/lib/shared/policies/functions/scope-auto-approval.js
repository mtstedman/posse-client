// Deterministic auto-approval policy for mechanical scope-expansion requests.
//
// request_scope parks the requesting job behind a human gate. For path
// classes that carry no meaningful repo-intent decision the gate is pure
// friction: the human always approves, and each request costs a full
// pause → prompt → answer → re-run cycle. This table names the classes a
// scope request may be granted without a human:
//
//  - create_root_covered: the path sits inside a create_root the planner
//    already approved for this job. The mutation predicates accept such
//    paths anyway; agents still pre-ask via request_scope.
//  - test_path: additive test collateral for dev/fix jobs. Assessment
//    policy demands tests while plans chronically under-enumerate test
//    files; the diff still goes through assessment.
//  - generated_file: lockfiles and generated snapshots that follow
//    mechanically from an in-scope change.
//
// Everything else still routes to the human gate. The operator can disable
// the whole tier with the `scope_auto_approval` setting.

const GENERATED_BASENAMES = new Set([
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lockb",
  "bun.lock",
  "cargo.lock",
  "poetry.lock",
  "uv.lock",
  "pipfile.lock",
  "composer.lock",
  "gemfile.lock",
  "go.sum",
]);

const TEST_SEGMENT_RE = /(?:^|\/)(?:tests?|__tests__|__snapshots__|specs?|testdata|fixtures)\//i;
const TEST_FILENAME_RE = /(?:^|\/)(?:test_[^/]+|conftest\.py|[^/]+(?:\.test|\.spec|_test|_spec|-test|-spec)\.[a-z0-9]+)$/i;
const SNAPSHOT_RE = /\.snap$/i;

const TEST_ELIGIBLE_JOB_TYPES = new Set(["dev", "fix"]);

function normalizeScopePath(value) {
  return String(value || "").replace(/\\/g, "/").trim().replace(/^\.\//, "");
}

function isUnderRoot(relPath, root) {
  const normalizedRoot = normalizeScopePath(root).replace(/\/+$/, "");
  if (!normalizedRoot || normalizedRoot === "." || normalizedRoot === "/") return false;
  return relPath === normalizedRoot || relPath.startsWith(`${normalizedRoot}/`);
}

export function isTestCollateralPath(relPath) {
  const normalized = normalizeScopePath(relPath);
  if (!normalized) return false;
  return TEST_SEGMENT_RE.test(normalized)
    || TEST_FILENAME_RE.test(normalized)
    || SNAPSHOT_RE.test(normalized);
}

export function isGeneratedScopePath(relPath) {
  const normalized = normalizeScopePath(relPath);
  if (!normalized) return false;
  const base = normalized.split("/").filter(Boolean).at(-1) || "";
  return GENERATED_BASENAMES.has(base.toLowerCase());
}

/**
 * Classify a scope-expansion request against the auto-approval table.
 * Returns { reason } naming the matched class, or null when the request
 * needs a human decision.
 */
export function classifyAutoApprovableScopeRequest({
  path,
  jobType = "",
  createRoots = [],
} = {}) {
  const relPath = normalizeScopePath(path);
  if (!relPath) return null;

  const roots = Array.isArray(createRoots) ? createRoots : [];
  if (roots.some((root) => isUnderRoot(relPath, root))) {
    return { reason: "create_root_covered" };
  }

  if (!TEST_ELIGIBLE_JOB_TYPES.has(String(jobType || "").trim())) return null;

  if (isTestCollateralPath(relPath)) {
    return { reason: "test_path" };
  }
  if (isGeneratedScopePath(relPath)) {
    return { reason: "generated_file" };
  }
  return null;
}
